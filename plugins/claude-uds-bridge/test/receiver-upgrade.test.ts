import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../src/bridge';
import { prepareRecovery } from '../src/recovery';
import { recoverCurrentReceiver } from '../src/receiver-upgrade';
import { version } from '../src/version';
import type { Peer } from '../src/claude';

function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/uds-receiver-upgrade-'));
  const bridge = new Bridge(randomUUID(), join(root, 'claude'), root, join(root, 'ipc.sock'));
  bridge.beginSession(); bridge.setTarget({ kind: 'desktop', path: bridge.ipcPath });
  const db = new Database(join(root, `${bridge.threadId}.sqlite`));
  let current: Peer | undefined = { pid: 12345, procStart: 'old-start', sessionId: bridge.threadId, messagingSocketPath: join(root, 'old.sock'),
    name: 'synthetic-old', cwd: root, status: 'idle', peerProtocol: 1, peerFeatures: ['compact_request'], entrypoint: 'codex-claude-uds-bridge', bridgeVersion: '0.2.9' };
  db.run('INSERT INTO receiver VALUES (1,?,?)', [current.pid, current.procStart!]);
  let owner = 'native-owner', identity = 'old-start', trust = 'trusted';
  let quiet: (() => void) | undefined;
  const stopped: number[] = [], started: string[] = [];
  const plugin = resolve(import.meta.dir, '..');
  const context = async () => ({ cwd: root, owner, runtime: { status: 'busy' as const, mode: 'prompting' as const }, hasExecutionEnvironments: false });
  const deps = {
    current: () => current,
    identity: async () => identity,
    stop: (pid: number) => { stopped.push(pid); current = undefined; db.run('DELETE FROM receiver'); },
    sleep: async (ms: number) => { if (ms === 250) quiet?.(); },
    refresh: async () => {},
    context,
    prepare: (b: Bridge, pluginRoot: string, home: string) => prepareRecovery(b, pluginRoot, home, {
      target: async () => bridge.target(), context,
      hooks: async () => ({ data: [{ cwd: root, errors: [], hooks: [{ eventName: 'sessionStart', enabled: true, trustStatus: trust,
        sourcePath: join(plugin, 'hooks/hooks.json'), pluginId: 'claude-uds-bridge@leonkohli', currentHash: 'fixture',
        handlerType: 'mcpTool', server: 'claude_uds_bridge', tool: 'session_start' }] }] }),
    }),
  };
  const start = async (id: string, cwd: string, generation: string, token?: string) => {
    expect(id).toBe(bridge.threadId); expect(cwd).toBe(root);
    bridge.recoveryGeneration(generation, cwd); bridge.checkReceiverUpgrade(token!);
    started.push(id);
    current = { ...current, pid: 23456, procStart: 'new-start', sessionId: id, name: 'synthetic-new', cwd, status: 'idle',
      messagingSocketPath: join(root, 'new.sock'), peerProtocol: 1, peerFeatures: ['compact_request', 'compact_profile_access'],
      entrypoint: 'codex-claude-uds-bridge', bridgeVersion: version };
    db.run('INSERT INTO receiver VALUES (1,?,?)', [current.pid, current.procStart!]);
  };
  const tables = ['lifecycle', 'inbound_policy', 'compact_access', 'dialogue_budget', 'peer_guard', 'messages', 'idle_requests', 'compaction_requests'];
  return { bridge, db, root, stopped, started, deps,
    run: () => recoverCurrentReceiver(bridge, plugin, root, start, deps),
    onQuiet(fn: () => void) { quiet = fn; }, setOwner(value: string) { owner = value; }, setIdentity(value: string) { identity = value; },
    setTrust(value: string) { trust = value; }, setVersion(value: string) { current!.bridgeVersion = value; },
    snapshot() { return tables.map(table => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]); },
    async close() { db.close(); await bridge.close(); rmSync(root, { recursive: true }); },
  };
}

test('upgrade replaces only its verified receiver and preserves policy, grants, guard, budget and historical correlation', async () => {
  const f = fixture();
  try {
    f.db.run("UPDATE dialogue_budget SET used=99");
    f.db.run("INSERT INTO peer_guard VALUES ('peer',7,100,'digest',100)");
    f.db.run('INSERT INTO compact_access VALUES (?)', [randomUUID()]);
    f.bridge.setCompactAccessMode('all-claude');
    const id = randomUUID(), input = randomUUID();
    f.db.run("INSERT INTO messages(id,peer_id,direction,text,status,desktop_input_id,native_input_id,delivery_mode) VALUES (?,?,'in','historical','queued',?,?,'queue')", [id, randomUUID(), input, randomUUID()]);
    const before = f.snapshot();
    const result = await f.run();
    expect(result.phase).toBe('upgraded');
    expect(f.stopped).toEqual([12345]);
    expect(f.started).toEqual([f.bridge.threadId]);
    expect(f.snapshot()).toEqual(before);
    expect(f.bridge.status().compactAccessMode).toBe('all-claude');
    expect(f.bridge.receiverUpgradeActive()).toBe(false);
    expect(f.db.query('SELECT pid FROM receiver').get()).toEqual({ pid: 23456 });
  } finally { await f.close(); }
});

test('held, unread, pending, outbound-in-flight, idle subscriptions and compactions block replacement', async () => {
  const cases = [
    "INSERT INTO messages(id,peer_id,direction,text,status) VALUES ('m','p','in','held','held')",
    "INSERT INTO messages(id,peer_id,direction,text,status) VALUES ('m','p','in','pending','pending')",
    "INSERT INTO messages(id,peer_id,direction,text,status) VALUES ('m','p','out','in-flight','submitting')",
    "INSERT INTO messages(id,peer_id,direction,text,status,awaiting_input) VALUES ('m','p','in','unread','steered',1)",
    "INSERT INTO idle_requests(id,peer_id,peer_address,direction,status,expires_at) VALUES ('m','p','uds:/p','out','waiting',9999999999999)",
    "INSERT INTO compaction_requests(id,status,deadline,notice_id) VALUES ('m','submitted',9999999999999,'n')",
  ];
  for (const sql of cases) {
    const f = fixture();
    try {
      f.db.exec(sql); const before = f.snapshot();
      const result = await f.run();
      expect(result.phase).toBe('upgrade_blocked');
      expect(f.stopped).toEqual([]); expect(f.started).toEqual([]);
      expect(f.snapshot()).toEqual(before);
    } finally { await f.close(); }
  }
});

test('fresh owner/PID changes, SessionEnd and newly arrived input are rechecked before stopping', async () => {
  for (const kind of ['owner', 'pid', 'end', 'input'] as const) {
    const f = fixture();
    try {
      f.onQuiet(() => {
        if (kind === 'owner') f.setOwner('another-owner');
        if (kind === 'pid') f.setIdentity('reused-pid');
        if (kind === 'end') f.bridge.endSession();
        if (kind === 'input') f.db.run("INSERT INTO messages(id,peer_id,direction,text,status) VALUES ('m','p','in','new held','held')");
      });
      if (kind === 'input') expect((await f.run()).phase).toBe('upgrade_blocked');
      else await expect(f.run()).rejects.toThrow();
      expect(f.stopped).toEqual([]); expect(f.started).toEqual([]);
      expect(f.bridge.receiverUpgradeActive()).toBe(false);
    } finally { await f.close(); }
  }
});

test('hook review, another upgrade lease, newer and unknown versions never trigger a signal', async () => {
  for (const kind of ['trust', 'lease', 'newer', 'unknown'] as const) {
    const f = fixture();
    try {
      let token: string | undefined;
      if (kind === 'trust') f.setTrust('modified');
      if (kind === 'lease') token = f.bridge.claimReceiverUpgrade();
      if (kind === 'newer') f.setVersion('999.0.0');
      if (kind === 'unknown') f.setVersion('unrecognized');
      await expect(f.run()).rejects.toThrow();
      expect(f.stopped).toEqual([]); expect(f.started).toEqual([]);
      if (token) { f.bridge.checkReceiverUpgrade(token); f.bridge.releaseReceiverUpgrade(token); }
      expect(f.bridge.receiverUpgradeActive()).toBe(false);
    } finally { await f.close(); }
  }
});
