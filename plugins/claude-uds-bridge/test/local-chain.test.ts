import { test, expect } from 'bun:test';
import { once } from 'node:events';
import net from 'node:net';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { frameSchema, inbox, localChain, peerAddress, processStart, publishPeerKey, socketPath, userFrame, type Frame, type Peer } from '../src/claude';

test('only socket authentication and a bound native envelope qualify a registered local sender', () => {
  const peer: Peer = { pid: process.pid, sessionId: randomUUID(), messagingSocketPath: '/tmp/test.sock',
    name: 'test', cwd: '/tmp', status: 'idle', peerProtocol: 1, procStart: 'start', peerFeatures: [] };
  const raw = { ...userFrame(peer, peerAddress(peer.messagingSocketPath), peer.name, peer.sessionId,
    randomUUID(), 'work', 'prompting', 'a'.repeat(24)), local_chain: 'a'.repeat(24) };
  const parsed = frameSchema.parse(raw);
  if (parsed.type !== 'user') throw new Error('Expected user frame');
  expect(localChain(parsed, peer, true)).toBe(true);
  expect(localChain(parsed, peer, false)).toBe(false);
  expect(localChain(parsed, { ...peer, procStart: undefined }, true)).toBe(false);
  expect(localChain({ ...parsed, from: 'uds:/tmp/other.sock' }, peer, true)).toBe(false);
  expect(localChain({ ...parsed, message: { ...parsed.message,
    content: parsed.message.content.replace(peer.sessionId, `local_${randomUUID()}`) } }, peer, true)).toBe(true);
  for (const value of ['', 'bad', 'A'.repeat(24), Array(33).fill('a'.repeat(24)).join(','), true]) {
    expect(frameSchema.safeParse({ ...raw, local_chain: value }).success).toBe(false);
  }
  const spoof = frameSchema.parse({ ...raw, authenticated: true, verifiedLocal: true });
  expect(spoof).not.toHaveProperty('authenticated');
  expect(spoof).not.toHaveProperty('verifiedLocal');
});

test('native key publication is private, valid first-line auth works, late and invalid auth cannot grant trust', async () => {
  const root = mkdtempSync('/tmp/local-chain-auth-');
  const token = '1'.repeat(32);
  const delivered: { frame: Frame; authenticated: boolean }[] = [];
  const server = await inbox(root, (frame, authenticated) => delivered.push({ frame, authenticated }), token);
  const configDir = join(root, 'claude');
  const removeKey = publishPeerKey(configDir, server.address, await processStart(process.pid), token);
  const keyPath = join(configDir, 'sessions', `${process.pid}.${createHash('sha256').update(socketPath(server.address)).digest('hex')}.key`);
  const frame = { msgV: 1, type: 'user', msg_id: randomUUID(), from: 'uds:/tmp/synthetic.sock', message: { role: 'user', content: 'hello' } };
  const transmit = async (lines: unknown[]) => {
    const socket = net.createConnection(socketPath(server.address));
    socket.on('error', () => {});
    await once(socket, 'connect');
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
    socket.end(lines.map(line => JSON.stringify(line) + '\n').join(''));
    await closed;
  };
  try {
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(keyPath, 'utf8')).peerToken).toBe(token);
    await transmit([{ type: 'auth', token }, frame]);
    expect(delivered.map(item => item.authenticated)).toEqual([true]);
    await transmit([frame]); // Legacy ingress remains available, with the legacy guard.
    expect(delivered.at(-1)?.authenticated).toBe(false);
    await transmit([frame, { type: 'auth', token }, frame]);
    expect(delivered.slice(-2).map(item => item.authenticated)).toEqual([false, false]);
    const count = delivered.length;
    await transmit([{ type: 'auth', token: '2'.repeat(32) }, frame]);
    expect(delivered).toHaveLength(count);
    removeKey();
    expect(existsSync(keyPath)).toBe(false);
    writeFileSync(keyPath, JSON.stringify({ peerToken: '3'.repeat(32), procStart: 'obsolete-process-incarnation' }), { mode: 0o600 });
    const start = await processStart(process.pid);
    const removeRotated = publishPeerKey(configDir, server.address, start, token);
    expect(JSON.parse(readFileSync(keyPath, 'utf8')).peerToken).toBe(token);
    expect(() => publishPeerKey(configDir, server.address, start, '4'.repeat(32))).toThrow('already belongs');
    expect(JSON.parse(readFileSync(keyPath, 'utf8')).peerToken).toBe(token);
    removeRotated();
  } finally { await server.close(); rmSync(root, { recursive: true }); }
});
