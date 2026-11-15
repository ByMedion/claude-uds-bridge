import { test, expect } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { deliveryHelp, DeliveryHelpLedger, withDeliveryHelp } from '../src/delivery-help';
import { findPeer, frameSchema, hopChain, maxLineLength, processStart, sendFrames, serializeFrame, userFrame, type Frame, type Peer } from '../src/claude';

async function fixture() {
  const root = mkdtempSync('/tmp/uds-help-');
  const configDir = join(root, 'claude'), stateDir = join(root, 'state'), directory = join(root, 's');
  mkdirSync(join(configDir, 'sessions'), { recursive: true, mode: 0o700 });
  mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 });
  const socketPath = join(directory, `${process.pid}.sock`);
  const frames: Frame[] = [];
  const connections = new Set<net.Socket>();
  const server = net.createServer(socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', data => {
      buffer += data;
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        frames.push(frameSchema.parse(JSON.parse(buffer.slice(0, end))));
        buffer = buffer.slice(end + 1);
      }
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  chmodSync(socketPath, 0o600);
  const sessionId = randomUUID();
  writeFileSync(join(configDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId,
    messagingSocketPath: socketPath, cwd: root, procStart: await processStart(process.pid), peerProtocol: 1, peerFeatures: [] }), { mode: 0o600 });
  const peer = findPeer(configDir, sessionId);
  const frame = (text: string, target = peer) => userFrame(target, 'uds:/tmp/synthetic-sender.sock', 'synthetic-codex', randomUUID(),
    randomUUID(), text, 'prompting', 'a'.repeat(24), ['b'.repeat(24)]);
  const send = (text: string, target = peer, guide = deliveryHelp, senderConfig = configDir) =>
    withDeliveryHelp(stateDir, senderConfig, target, [frame(text, target)], outgoing => sendFrames(configDir, target, outgoing), guide);
  return { root, configDir, stateDir, peer, frame, frames, send,
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true });
    } };
}

function content(frame: unknown) {
  const parsed = frameSchema.parse(frame);
  if (parsed.type !== 'user') throw new Error('Expected user message');
  return parsed.message.content;
}

test('first ordinary Claude message carries one guide without changing its identity or hop envelope', async () => {
  const f = await fixture();
  const frame = f.frame('ordinary request');
  const original = structuredClone(frame);
  try {
    expect(await withDeliveryHelp(f.stateDir, f.configDir, f.peer, [frame], outgoing => sendFrames(f.configDir, f.peer, outgoing))).toBe(true);
    const sent = f.frames[0]!;
    expect(sent).toMatchObject({ msg_id: frame.msg_id, from: frame.from, session_id: frame.session_id, priority: frame.priority });
    expect(content(sent)).toContain('ordinary request\n\n' + deliveryHelp.text);
    expect(content(sent)).toEndWith('\n</cross-session-message>');
    expect(hopChain(content(sent))).toEqual(hopChain(frame.message.content));
    expect(content(sent).split('\n')[0]).toBe(frame.message.content.split('\n')[0]);
    expect(frame).toEqual(original);
    await f.send('second request');
    expect(content(f.frames[1])).not.toContain(deliveryHelp.text);
    expect(statSync(join(f.stateDir, 'delivery-help.sqlite')).mode & 0o777).toBe(0o600);
  } finally { await f.close(); }
});

test('guide revisions persist across connections, repeat on an instruction change, and never downgrade', async () => {
  const f = await fixture();
  const guide2 = { revision: 2, text: 'Updated delivery instructions' };
  try {
    await f.send('first');
    await f.send('after reconnect');
    await f.send('new guide revision', f.peer, guide2);
    await f.send('same new revision', f.peer, guide2);
    await f.send('older plugin still running');
    expect(f.frames.map(frame => content(frame).includes(deliveryHelp.text))).toEqual([true, false, false, false, false]);
    expect(f.frames.map(frame => content(frame).includes(guide2.text))).toEqual([false, false, true, false, false]);
  } finally { await f.close(); }
});

test('new Claude session IDs and different profiles receive their own guide; profile aliases share tracking', async () => {
  const f = await fixture();
  const seen: unknown[][] = [];
  const capture = async (frames: unknown[]) => { seen.push(frames); return true; };
  try {
    await withDeliveryHelp(f.stateDir, f.configDir, f.peer, [f.frame('one')], capture);
    const alias = join(f.root, 'claude-alias');
    symlinkSync(f.configDir, alias);
    await withDeliveryHelp(f.stateDir, alias, f.peer, [f.frame('same profile alias')], capture);
    const other = { ...f.peer, sessionId: randomUUID() };
    await withDeliveryHelp(f.stateDir, f.configDir, other, [f.frame('new session', other)], capture);
    const profile = join(f.root, 'other-profile');
    mkdirSync(profile, { mode: 0o700 });
    await withDeliveryHelp(f.stateDir, profile, f.peer, [f.frame('other profile')], capture);
    expect(seen.map(frames => content(frames[0]).includes(deliveryHelp.text))).toEqual([true, false, true, true]);
  } finally { await f.close(); }
});

test('Codex recipients and control-only sends do not attach or consume a guide', async () => {
  const f = await fixture();
  const seen: unknown[][] = [];
  const capture = async (frames: unknown[]) => { seen.push(frames); return true; };
  try {
    const codex: Peer = { ...f.peer, entrypoint: 'codex-claude-uds-bridge' };
    await withDeliveryHelp(f.stateDir, f.configDir, codex, [f.frame('Codex peer')], capture);
    await withDeliveryHelp(f.stateDir, f.configDir, f.peer,
      [{ msgV: 1, type: 'control', action: 'notify_when_idle', from: 'uds:/tmp/test.sock', msg_id: randomUUID() }], capture);
    expect(existsSync(join(f.stateDir, 'delivery-help.sqlite'))).toBe(false);
    expect(content(seen[0]![0])).not.toContain(deliveryHelp.text);
    await f.send('first real Claude message');
    expect(content(f.frames[0])).toContain(deliveryHelp.text);
  } finally { await f.close(); }
});

test('failed, cancelled, and uncertain sends do not resend the body or mark the guide as written', async () => {
  const f = await fixture();
  let attempts = 0;
  try {
    await expect(withDeliveryHelp(f.stateDir, f.configDir, f.peer, [f.frame('failed')], async () => {
      attempts++; throw new Error('unknown send outcome');
    })).rejects.toThrow('unknown send outcome');
    expect(attempts).toBe(1);
    expect(await withDeliveryHelp(f.stateDir, f.configDir, f.peer, [f.frame('cancelled')], outgoing =>
      sendFrames(f.configDir, f.peer, outgoing, { canWrite: () => false }))).toBe(false);
    expect(f.frames).toEqual([]);
    await f.send('next ordinary message');
    expect(content(f.frames[0])).toContain(deliveryHelp.text);
    await f.send('already written');
    expect(content(f.frames[1])).not.toContain(deliveryHelp.text);
  } finally { await f.close(); }
});

test('a maximum-size message keeps its original content and defers the guide to the next message', async () => {
  const f = await fixture();
  const empty = f.frame('');
  const frame = { ...empty, message: { ...empty.message,
    content: empty.message.content.replace('\n\n</cross-session-message>', '\n' + 'x'.repeat(maxLineLength - serializeFrame(empty).length) + '\n</cross-session-message>') } };
  const seen: unknown[][] = [];
  const capture = async (frames: unknown[]) => { frames.forEach(serializeFrame); seen.push(frames); return true; };
  try {
    expect(serializeFrame(frame).length).toBe(maxLineLength);
    expect(await withDeliveryHelp(f.stateDir, f.configDir, f.peer, [frame], capture)).toBe(true);
    expect(seen[0]![0]).toEqual(frame);
    await withDeliveryHelp(f.stateDir, f.configDir, f.peer, [f.frame('small next message')], capture);
    expect(content(seen[1]![0])).toContain(deliveryHelp.text);
  } finally { await f.close(); }
});

test('parallel Codex processes share one guide claim', async () => {
  const f = await fixture();
  try {
    const children = Array.from({ length: 4 }, (_, index) => Bun.spawn([process.execPath,
      join(import.meta.dir, 'delivery-help-worker.ts'), f.configDir, f.stateDir, f.peer.sessionId, `worker ${index}`],
      { stdout: 'pipe', stderr: 'pipe' }));
    const results = await Promise.all(children.map(async child => ({ code: await child.exited, error: await new Response(child.stderr).text() })));
    expect(results).toEqual(Array.from({ length: 4 }, () => ({ code: 0, error: '' })));
    expect(f.frames).toHaveLength(4);
    expect(f.frames.filter(frame => content(frame).includes(deliveryHelp.text))).toHaveLength(1);
    await f.send('later from another chat');
    expect(content(f.frames.at(-1))).not.toContain(deliveryHelp.text);
  } finally { await f.close(); }
});

test('expired claims recover after a crashed sender; a stale completion cannot overwrite a newer guide', async () => {
  const f = await fixture();
  let now = 1000;
  const first = new DeliveryHelpLedger(f.stateDir, () => now);
  const second = new DeliveryHelpLedger(f.stateDir, () => now);
  try {
    const old = first.claim('peer', 1)!;
    expect(old).toBeString();
    expect(second.claim('peer', 1)).toBeNull();
    now += 20001;
    const fresh = second.claim('peer', 2)!;
    expect(fresh).toBeString();
    second.complete('peer', fresh, 2);
    first.complete('peer', old, 1);
    expect(first.claim('peer', 1)).toBeNull();
    expect(first.claim('peer', 2)).toBeNull();
    expect(first.claim('peer', 3)).toBeString();
  } finally { first.close(); second.close(); await f.close(); }
});

test('unavailable guide bookkeeping preserves the primary send', async () => {
  const f = await fixture();
  const frame = f.frame('keep the authorized message');
  const seen: unknown[][] = [];
  try {
    writeFileSync(join(f.stateDir, 'delivery-help.sqlite'), 'not a database', { mode: 0o600 });
    expect(await withDeliveryHelp(f.stateDir, f.configDir, f.peer, [frame], async outgoing => { seen.push(outgoing); return true; })).toBe(true);
    expect(seen).toEqual([[frame]]);
  } finally { await f.close(); }
});
