import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { peers } from '../src/claude';
import { version } from '../src/version';
import { appServer } from './app-server-fixture';

const packageRoot = join(import.meta.dir, '..');

async function fixture() {
  const server = await appServer();
  const workspace = realpathSync(server.root);
  const installed = join(workspace, 'installed');
  const config = join(workspace, 'claude');
  const state = join(workspace, 'plugin-state', 'claude-uds-bridge');
  const verificationCwd = join(workspace, 'unrelated');
  mkdirSync(verificationCwd);
  for (const directory of ['dist', 'hooks']) mkdirSync(join(installed, directory), { recursive: true });
  for (const name of ['dist/hook.js', 'dist/recover-receivers.js', 'hooks/hooks.json']) {
    copyFileSync(join(packageRoot, name), join(installed, name));
  }
  const env = { ...process.env, CODEX_HOME: workspace, CLAUDE_CONFIG_DIR: config, TMPDIR: workspace, CODEX_THREAD_ID: undefined };
  const call = async (bundle: string, args: string[] = [], input?: string) => {
    const child = Bun.spawn([process.execPath, join(installed, 'dist', bundle), ...args],
      { cwd: verificationCwd, env, stdin: input ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe' });
    if (input && child.stdin) { child.stdin.write(input); child.stdin.end(); }
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  return { server, config, state, workspace, verificationCwd, installed,
    recover: (cwd: string, ...ids: string[]) => call('recover-receivers.js', ['--cwd', cwd, ...ids]),
    async close() {
      try {
        if (peers(config).some(peer => peer.sessionId === server.threadId)) {
          await call('hook.js', [], JSON.stringify({ session_id: server.threadId, cwd: workspace, hook_event_name: 'SessionEnd' }));
        }
      } finally { await server.close(); }
    },
  };
}

test('the packaged recovery command restores a receiver from another directory without source or dependencies', async () => {
  const f = await fixture();
  try {
    f.server.setHooks({ data: [{ cwd: f.workspace, hooks: [{
      eventName: 'sessionStart', enabled: true, trustStatus: 'trusted', sourcePath: join(f.installed, 'hooks/hooks.json'),
      pluginId: 'claude-uds-bridge@leonkohli', currentHash: 'synthetic-hook-fingerprint',
      handlerType: 'mcpTool', server: 'claude_uds_bridge', tool: 'session_start',
    }] }] });
    const restored = await f.recover(f.workspace, f.server.threadId);
    expect(restored.stderr).toBe('');
    expect(restored.code).toBe(0);
    expect(JSON.parse(restored.stdout)).toMatchObject({ version, results: [{
      threadId: f.server.threadId, phase: 'restored', receiverVersion: version, ready: true, blockers: [],
    }] });
    expect(peers(f.config).find(peer => peer.sessionId === f.server.threadId)?.bridgeVersion).toBe(version);
    expect(f.server.submissions).toHaveLength(0);
  } finally { await f.close(); }
}, 10000);

test('the packaged command stops before creating receiver state when the first chat is outside the checkout', async () => {
  const f = await fixture();
  try {
    const ids = [f.server.threadId, randomUUID()];
    const blocked = await f.recover(f.verificationCwd, ...ids);
    expect(blocked.stderr).toBe('');
    expect(blocked.code).toBe(1);
    expect(JSON.parse(blocked.stdout)).toEqual({ version,
      preflight: { threadId: f.server.threadId, error: 'Native chat directory does not match --cwd' }, notAttempted: ids });
    expect(existsSync(f.state)).toBe(false);
    expect(f.server.submissions).toHaveLength(0);
  } finally { await f.close(); }
});
