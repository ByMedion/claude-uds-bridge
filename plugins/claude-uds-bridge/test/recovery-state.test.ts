import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../src/bridge';
import { prepareRecovery, requireTrustedHook } from '../src/recovery';

const pluginRoot = resolve(import.meta.dir, '..');
const metadata = (cwd: string, trustStatus = 'trusted', enabled = true) => ({ data: [{ cwd, errors: [], hooks: [{
  eventName: 'sessionStart', enabled, trustStatus, pluginId: 'claude-uds-bridge@leonkohli',
  currentHash: 'definition/content-fingerprint', sourcePath: join(pluginRoot, 'hooks/hooks.json'),
  handlerType: 'mcpTool', server: 'claude_uds_bridge', tool: 'session_start',
}] }] });

test('inactive recovery preserves held deadlines, policy, rate guard, provenance and the spent message budget', async () => {
  const root = mkdtempSync('/tmp/bridge-recovery-state-');
  const bridge = new Bridge(randomUUID(), root, root, join(root, 'ipc.sock'));
  const db = new Database(join(root, `${bridge.threadId}.sqlite`));
  try {
    bridge.beginSession();
    const held = randomUUID(), deadline = Date.now() + 300000;
    db.run("INSERT INTO messages(id,peer_id,direction,text,status,expires_at,local_chain,local_verified) VALUES (?,?,'in','private held payload','held',?,'aaaaaaaaaaaaaaaaaaaaaaaa',1)", [held, randomUUID(), deadline]);
    db.run("INSERT INTO peer_guard VALUES ('peer',7,100,'body-hash',100)");
    db.run('UPDATE dialogue_budget SET used=99');
    bridge.endSession();
    const previous = bridge.lifecycle();
    const deps = {
      target: async () => ({ kind: 'desktop' as const, path: bridge.ipcPath }),
      context: async () => ({ cwd: root, owner: 'native-owner', runtime: { status: 'busy' as const, mode: 'prompting' as const }, hasExecutionEnvironments: false }),
      hooks: async () => metadata(root),
    };
    const prepared = await prepareRecovery(bridge, pluginRoot, root, deps);
    expect(prepared.generation).not.toBe(previous?.generation);
    expect(bridge.lifecycle()?.active).toBe(1);
    expect(db.query('SELECT status,expires_at,local_chain,local_verified FROM messages WHERE id=?').get(held))
      .toEqual({ status: 'held', expires_at: deadline, local_chain: 'a'.repeat(24), local_verified: 1 });
    expect(db.query('SELECT tokens FROM peer_guard').get()).toEqual({ tokens: 7 });
    expect(bridge.status().automaticMessageBudget).toMatchObject({ used: 99, remaining: 1 });
    expect(bridge.policy()).toBe('default');
    expect(bridge.recoveryGeneration(prepared.generation, prepared.cwd)).toBe(prepared.generation);
    bridge.endSession();
    expect(() => bridge.recoveryGeneration(prepared.generation, prepared.cwd)).toThrow('session_ended');
  } finally { db.close(); await bridge.close(); rmSync(root, { recursive: true }); }
});

test('recovery never trusts a disabled, changed, untrusted or unrelated hook', () => {
  const root = mkdtempSync('/tmp/bridge-hook-verification-');
  try {
    expect(requireTrustedHook(metadata(root), root, pluginRoot).scope).toBe('cwd');
    for (const status of ['untrusted', 'modified', 'unknown']) {
      expect(() => requireTrustedHook(metadata(root, status), root, pluginRoot)).toThrow('hook_review_required');
    }
    expect(() => requireTrustedHook(metadata(root, 'trusted', false), root, pluginRoot)).toThrow('hook_review_required');
    const other = metadata(root);
    other.data[0]!.hooks[0]!.pluginId = 'unrelated-plugin';
    expect(() => requireTrustedHook(other, root, pluginRoot)).toThrow('hook_context_unavailable');
  } finally { rmSync(root, { recursive: true }); }
});

test('owner changes, unknown permissions and a concurrent SessionEnd stop recovery before lifecycle activation', async () => {
  const root = mkdtempSync('/tmp/bridge-recovery-race-');
  const bridge = new Bridge(randomUUID(), root, root, join(root, 'ipc.sock'));
  try {
    let calls = 0;
    const deps = {
      target: async () => ({ kind: 'desktop' as const, path: bridge.ipcPath }),
      context: async () => ({ cwd: root, owner: ++calls === 1 ? 'one' : 'two', runtime: { status: 'busy' as const, mode: 'prompting' as const }, hasExecutionEnvironments: false }),
      hooks: async () => metadata(root),
    };
    await expect(prepareRecovery(bridge, pluginRoot, root, deps)).rejects.toThrow('context_mismatch');
    expect(bridge.lifecycle()).toBeNull();
    deps.context = async () => ({ cwd: root, owner: 'one', runtime: { status: 'busy', mode: 'prompting' }, hasExecutionEnvironments: false });
    deps.hooks = async () => { bridge.endSession(); return metadata(root); };
    await expect(prepareRecovery(bridge, pluginRoot, root, deps)).rejects.toThrow('session_ended');
    expect(bridge.lifecycle()?.active).toBe(0);
    await expect(prepareRecovery(bridge, pluginRoot, root, { ...deps, context: async () => ({ cwd: root, owner: 'one',
      runtime: { status: 'unknown', mode: 'unknown' }, hasExecutionEnvironments: false }) })).rejects.toThrow('context_unavailable');
    await expect(prepareRecovery(bridge, pluginRoot, root, { ...deps, context: async () => ({ cwd: root, owner: 'one',
      runtime: { status: 'busy', mode: 'prompting' }, hasExecutionEnvironments: true }) })).rejects.toThrow('hook_context_unavailable');
  } finally { await bridge.close(); rmSync(root, { recursive: true }); }
});
