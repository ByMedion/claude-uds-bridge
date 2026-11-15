import { test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import net from 'node:net';
import { Database } from 'bun:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Bridge } from '../src/bridge';
import { discoverDesktopTarget, desktopSocketPaths, watchCodex } from '../src/codex';
import { diagnoseConnection } from '../src/diagnostics';
import { receiver } from './desktop-fixture';

test('Desktop socket discovery falls back only after a missing or refused endpoint', async () => {
  const desktop = await receiver('idle', false, false, undefined, 13);
  try {
    expect(desktopSocketPaths('/home/test/ipc/ipc.sock', '/tmp/test', 501))
      .toEqual(['/home/test/ipc/ipc.sock', '/tmp/test/codex-ipc/ipc-501.sock']);
    expect(await discoverDesktopTarget([join(desktop.path, '../missing.sock'), desktop.path], desktop.threadId))
      .toEqual({ kind: 'desktop', path: desktop.path });
    expect(desktop.submissions).toEqual([]);
  } finally { await desktop.close(); }
});

test('an incompatible primary stream fails closed before trying another router', async () => {
  const primary = await receiver('idle', false, false, undefined, 14);
  const alternate = await receiver('idle');
  try {
    await expect(discoverDesktopTarget([primary.path, alternate.path], primary.threadId)).rejects.toThrow('Unsupported Desktop stream version: 14');
    expect(alternate.requests).toEqual([]);
    const result = await diagnoseConnection(primary.path, primary.threadId, { kind: 'desktop', path: primary.path });
    expect(result).toMatchObject({ reachable: false, advice: expect.stringContaining('Unknown versions remain rejected') });
    expect(primary.submissions).toEqual([]);
  } finally { await primary.close(); await alternate.close(); }
});

test('Desktop reconnect suspends reception until fresh permissions arrive', async () => {
  const desktop = await receiver('idle', false, false, undefined, 13);
  const states: { status: string; mode: string }[] = [];
  let disconnected = false;
  const stop = await watchCodex({ kind: 'desktop', path: desktop.path }, desktop.threadId,
    state => states.push(state), () => { disconnected = true; });
  try {
    desktop.disconnectClients();
    desktop.setPermissions({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
    const deadline = Date.now() + 2000;
    while (states.at(-1)?.mode !== 'bypass' && !disconnected && Date.now() < deadline) await Bun.sleep(5);
    expect(disconnected).toBe(false);
    expect(states).toContainEqual({ status: 'unknown', mode: 'unknown' });
    expect(states.at(-1)).toEqual({ status: 'idle', mode: 'bypass' });
    expect(desktop.submissions).toEqual([]);
  } finally { stop(); await desktop.close(); }
});

test('receiver recovery preserves held input and requires an active recorded lifecycle', async () => {
  const root = mkdtempSync('/tmp/uds-recovery-');
  const bridge = new Bridge(randomUUID(), root, root, join(root, 'missing.sock'));
  const db = new Database(join(root, `${bridge.threadId}.sqlite`));
  try {
    expect(() => bridge.recoveryContext()).toThrow('trusted SessionStart');
    const generation = bridge.beginSession();
    bridge.recordReceiverStart(root, 'Desktop initialize timed out');
    const id = randomUUID();
    db.run("INSERT INTO messages (id,peer_id,direction,text,status) VALUES (?,?,'in','held input','held')", [id, randomUUID()]);
    expect(bridge.resumeSession()).toBe(generation);
    expect(bridge.recoveryContext()).toEqual({ cwd: root });
    expect(bridge.status().messages.find(message => message.id === id)?.status).toBe('held');
    expect(bridge.status().receiverStart?.error).toContain('initialize');
    bridge.endSession();
    expect(() => bridge.recoveryContext()).toThrow('trusted SessionStart');
    expect(bridge.resumeSession()).not.toBe(generation);
    expect(bridge.status().messages.find(message => message.id === id)?.status).toBe('expired');
  } finally { db.close(); await bridge.close(); rmSync(root, { recursive: true }); }
});

test('MCP exposes diagnostics and requires a reachable live owner for inactive recovery', async () => {
  const root = mkdtempSync('/tmp/uds-diag-mcp-');
  const client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [process.env.UDS_MCP_TEST_ENTRYPOINT ?? join(import.meta.dir, '../src/server.ts')],
      env: { CODEX_HOME: root, CLAUDE_CONFIG_DIR: root, TMPDIR: root } }));
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toContain('diagnose');
    expect(names).toContain('recover_receiver');
    const result = await client.callTool({ name: 'recover_receiver', arguments: {}, _meta: { threadId: randomUUID() } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('No reachable Desktop IPC socket');
  } finally { await client.close(); rmSync(root, { recursive: true }); }
});
