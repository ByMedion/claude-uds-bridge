import { test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { findPeer, messageDelivery, peerAddress, sendFrames, userFrame } from '../src/claude';
import { deliverToDesktop } from '../src/desktop';
import { deliverToCodex } from '../src/codex';
import { compactFixture, eventually } from './compact-fixture';

test('retired queue markers and later priority are refused without steering or touching native queued work', async () => {
  const f = await compactFixture();
  const existing = { id: randomUUID(), text: 'existing native user draft' };
  f.desktop.queuedMessages.set(existing.id, existing);
  try {
    const marker = await f.request('[bridge:queue]\nold instructions must not enqueue or steer');
    await eventually(() => f.bridge.status().messages.some(row => row.id === marker && row.status === 'refused'));
    const receiver = findPeer(f.configDir, f.desktop.threadId), sender = findPeer(f.configDir, f.peerId);
    const later = { ...userFrame(receiver, peerAddress(sender.messagingSocketPath), sender.name,
      f.peerId, randomUUID(), 'legacy later input', 'prompting', null), priority: 'later' };
    await sendFrames(f.configDir, receiver, [later]);
    await eventually(() => f.bridge.status().messages.some(row => row.id === later.msg_id && row.status === 'refused'));
    expect(f.bridge.status().messages.find(row => row.id === later.msg_id)?.status_reason).toContain('withdrawn');
    expect(f.desktop.submissions).toHaveLength(0);
    expect([...f.desktop.queuedMessages.values()]).toEqual([existing]);
    expect(f.desktop.requests.filter(row => /queued-follow-ups|remove-queued/.test(row.method))).toHaveLength(0);
    expect(receiver.peerFeatures).not.toContain('delivery_queue');
    expect(f.bridge.status().unreadCount).toBe(0);
  } finally { await f.close(); }
});

test('a legacy held queue request stays refused when released instead of being converted to steer', async () => {
  const f = await compactFixture();
  try {
    const peer = findPeer(f.configDir, f.peerId), id = randomUUID();
    f.db.run("INSERT INTO messages(id,peer_id,direction,text,status,delivery_mode,peer_address,peer_start,from_mode) VALUES (?,?,'in','legacy held queue input','held','queue',?,?,'prompting')",
      [id, f.peerId, peerAddress(peer.messagingSocketPath), peer.procStart!]);
    await f.bridge.setPolicy('accept');
    expect(f.bridge.status().messages.find(row => row.id === id)?.status).toBe('refused');
    expect(f.bridge.status().messages.find(row => row.id === id)?.status_reason).toContain('withdrawn');
    expect(f.desktop.submissions).toHaveLength(0);
    expect(f.desktop.queuedMessages.size).toBe(0);
    expect(f.bridge.status().unreadCount).toBe(0);
  } finally { await f.close(); }
});

test('MCP and direct sender refuse retired queue even when an older peer still advertises it', async () => {
  const f = await compactFixture();
  const client = new Client({ name: 'queue-withdrawal', version: '1' });
  try {
    const file = join(f.configDir, 'sessions', `${process.ppid}.json`);
    const peer = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...peer, peerFeatures: ['notify_idle', 'delivery_queue'] }));
    await expect(f.bridge.sendMessage(f.peerId, 'legacy queue', true, 'queue')).rejects.toThrow('withdrawn');
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [process.env.UDS_MCP_TEST_ENTRYPOINT ?? join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: f.root, CLAUDE_CONFIG_DIR: f.configDir } }));
    const result = await client.callTool({ name: 'send_message', arguments: { sessionId: f.peerId, text: 'old caller', delivery: 'queue', notify_when_idle: true }, _meta: { threadId: f.desktop.threadId } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('withdrawn');
    const tools = await client.listTools();
    const schema = tools.tools.find(row => row.name === 'send_message')?.inputSchema;
    expect(JSON.stringify(schema)).not.toContain('"queue"');
    const listed = await client.callTool({ name: 'list_sessions', arguments: {}, _meta: { threadId: f.desktop.threadId } });
    const rows = JSON.parse((listed.content as { text: string }[])[0]!.text);
    expect(rows.find((row: { sessionId: string }) => row.sessionId === f.peerId).deliveryModes).toEqual(['steer']);
    expect(f.frames.filter(frame => frame.type === 'user')).toHaveLength(0);
    expect(f.bridge.status().idleRequests).toHaveLength(0);
    expect(f.bridge.status().automaticMessageBudget.used).toBe(0);
  } finally { await client.close(); await f.close(); }
});

test('delivery adapters reject legacy queue before connecting to any native socket', async () => {
  for (const kind of ['desktop', 'app-server'] as const) {
    await expect(deliverToCodex({ kind, path: '/not-opened.sock' }, randomUUID(), randomUUID(), 'old queue', 'queue')).rejects.toThrow('withdrawn');
  }
  await expect(deliverToDesktop('/not-opened.sock', randomUUID(), randomUUID(), 'old queue', 'queue')).rejects.toThrow('withdrawn');
  expect(messageDelivery('[bridge:queue]\nreply')).toBe('queue'); // Recognition is for refusal only.
  expect(messageDelivery('plain reply', 'later')).toBe('queue');
  expect(messageDelivery('[bridge:steer]\nreply')).toBe('steer');
});

test('already admitted legacy queue records keep their identity and can be correlated on consumption', async () => {
  const f = await compactFixture();
  const id = randomUUID(), clientId = randomUUID(), nativeId = randomUUID();
  try {
    f.db.run("INSERT INTO messages(id,peer_id,direction,text,status,delivery_mode,awaiting_input,desktop_input_id) VALUES (?,?,'in','already admitted input','queued','queue',1,?)", [id, f.peerId, clientId]);
    f.desktop.setHistory({ turns: [{ items: [{ type: 'userMessage', id: nativeId, clientId }] }] });
    await f.bridge.sendMessage(f.peerId, 'ordinary response');
    expect(f.db.query('SELECT status,native_input_id,awaiting_input FROM messages WHERE id=?').get(id))
      .toEqual({ status: 'queued', native_input_id: nativeId, awaiting_input: 0 });
    expect(f.desktop.submissions).toHaveLength(0);
    expect(f.desktop.requests.filter(row => /queued-follow-ups|remove-queued/.test(row.method))).toHaveLength(0);
  } finally { await f.close(); }
});
