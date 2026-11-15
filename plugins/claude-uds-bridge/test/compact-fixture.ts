import { mkdirSync, mkdtempSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { once } from 'node:events';
import net from 'node:net';
import { Bridge } from '../src/bridge';
import { findPeer, frameSchema, peerAddress, processStart, sendFrames, socketPath, userFrame, type Frame } from '../src/claude';
import { receiver } from './desktop-fixture';

export async function compactFixture() {
  const root = mkdtempSync('/tmp/uds-compact-');
  const desktop = await receiver('idle', false, false, root, 13);
  const configDir = join(root, 'claude'), stateDir = join(root, 'plugin-state', 'claude-uds-bridge'), sockets = join(root, 's');
  mkdirSync(join(configDir, 'sessions'), { recursive: true, mode: 0o700 });
  mkdirSync(sockets, { mode: 0o700 });
  const peerId = randomUUID(), peerPath = join(sockets, `${process.ppid}.sock`);
  const frames: Frame[] = [];
  const server = net.createServer(socket => {
    socket.setEncoding('utf8'); let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (value.type !== 'auth') frames.push(frameSchema.parse(value));
      }
    });
  });
  server.listen(peerPath); await once(server, 'listening'); chmodSync(peerPath, 0o600);
  writeFileSync(join(configDir, 'sessions', `${process.ppid}.json`), JSON.stringify({ pid: process.ppid,
    procStart: await processStart(process.ppid), sessionId: peerId, messagingSocketPath: peerPath,
    cwd: root, peerProtocol: 1, peerFeatures: [] }), { mode: 0o600 });
  let bridge = new Bridge(desktop.threadId, configDir, stateDir, desktop.path);
  const humanId = randomUUID();
  desktop.setHistory({ turns: [{ items: [{ type: 'userMessage', id: humanId }] }] });
  await bridge.start(sockets, root, bridge.beginSession());
  bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
  const db = new Database(join(stateDir, `${desktop.threadId}.sqlite`));
  return { get bridge() { return bridge; }, desktop, configDir, stateDir, peerId, frames, root, db, humanId,
    async request(text = '[bridge:compact]', authenticated = true, mode = 'prompting') {
      const peer = findPeer(configDir, desktop.threadId), id = randomUUID();
      const frame = userFrame(peer, peerAddress(peerPath), 'synthetic-Claude', `local_${peerId}`, id, text, mode, 'b'.repeat(24));
      if (authenticated) await sendFrames(configDir, peer, [frame]);
      else {
        const socket = net.createConnection(socketPath(bridge.status().replyAddress!));
        await once(socket, 'connect'); socket.end(JSON.stringify({ ...frame, verifiedLocal: true }) + '\n'); await once(socket, 'close');
      }
      return id;
    },
    async restart() {
      await bridge.close();
      bridge = new Bridge(desktop.threadId, configDir, stateDir, desktop.path);
      await bridge.start(sockets, root, bridge.resumeSession());
      bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
    },
    async close() { await bridge.close(); db.close(); await new Promise<void>(resolve => server.close(() => resolve())); await desktop.close(); },
  };
}

export async function eventually(test: () => boolean, timeout = 4000) {
  const until = Date.now() + timeout;
  while (!test() && Date.now() < until) await Bun.sleep(10);
  if (!test()) throw new Error('Expected fixture state did not arrive');
}
