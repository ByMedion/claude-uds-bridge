import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { Bridge } from '../src/bridge';
import { PeerGuard } from '../src/guard';
import { findPeer, frameSchema, hopChain, peerAddress, sendFrames, userFrame, type Frame } from '../src/claude';
import { receiver } from './desktop-fixture';

async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

// A is the real Bridge and guard. B is a synthetic wire peer, not a Claude model/runtime.
// Legacy behaviors and the verified-local compaction shape inspected in Claude 2.1.325 are
// synthetic fixtures. This test does not execute Claude or assume its effective remote policy.
async function dialogue() {
  const root = mkdtempSync('/tmp/uds-dialogue-');
  const desktop = await receiver('idle', false, false, root, 13);
  const configDir = join(root, 'claude');
  const directory = join(root, 's');
  mkdirSync(join(configDir, 'sessions'), { recursive: true, mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 });
  const peerId = randomUUID();
  const peerPath = join(directory, `${process.ppid}.sock`);
  const frames: Frame[] = [];
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    let text = '';
    socket.on('data', data => {
      text += data;
      let end: number;
      while ((end = text.indexOf('\n')) !== -1) {
        frames.push(frameSchema.parse(JSON.parse(text.slice(0, end))));
        text = text.slice(end + 1);
      }
    });
  });
  server.listen(peerPath);
  await once(server, 'listening');
  chmodSync(peerPath, 0o600);
  writeFileSync(join(configDir, 'sessions', `${process.ppid}.json`), JSON.stringify({
    pid: process.ppid, sessionId: peerId, messagingSocketPath: peerPath,
    cwd: root, peerProtocol: 1, peerFeatures: [],
  }));
  const bridge = new Bridge(desktop.threadId, configDir, join(root, 'state'), desktop.path);
  await bridge.start(directory, root, bridge.beginSession());
  bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
  const inputs: { type: string; id: string; clientId: string | null }[] = [];
  const commitHuman = () => {
    inputs.push({ type: 'userMessage', id: randomUUID(), clientId: null });
    desktop.setHistory({ turns: [{ items: [...inputs] }] });
  };
  const commitPeer = () => {
    const params = desktop.submissions.at(-1)?.params as { turnStart: { request: { clientUserMessageId: string } } };
    inputs.push({ type: 'userMessage', id: randomUUID(), clientId: params.turnStart.request.clientUserMessageId });
    desktop.setHistory({ turns: [{ items: [...inputs] }] });
  };
  commitHuman();
  return { bridge, desktop, configDir, directory, peerId, peerPath, frames, commitHuman, commitPeer,
    async close() {
      await bridge.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await desktop.close();
    } };
}

for (const behavior of ['append', 'preserve', 'local-compact'] as const) {
  test(`a long new-request/new-answer dialogue reaches hop-loop with B=${behavior}`, async () => {
    const f = await dialogue();
    const bToken = randomBytes(12).toString('hex');
    const bSecret = randomBytes(32);
    const compactMarkers = new Set<string>();
    const rows: { round: number; requestHops: number; replyHops: number; ownVisits: number; status: string; reason: string | null }[] = [];
    let aToken = '';
    const exchange = async (round: number) => {
      const request = await f.bridge.sendMessage(f.peerId,
        round > 10 ? `New semantic request ${round}; please start a fresh chain and answer this distinct question.`
          : `Independent work item ${round}: inspect requirement ${round} and return a new answer.`);
      await until(() => f.frames.some(frame => frame.type === 'user' && frame.msg_id === request.messageId));
      const outbound = f.frames.find(frame => frame.type === 'user' && frame.msg_id === request.messageId)!;
      if (outbound.type !== 'user') throw new Error('Expected user frame');
      const requestChain = hopChain(outbound.message.content);
      aToken ||= requestChain[0]!;
      const id = randomUUID();
      // A does not send local_chain, so B inherits only the envelope chain. A modern
      // verified-local B adds an opaque marker there and sends its full chain separately.
      const marker = createHmac('sha256', bSecret).update(requestChain.join(',')).digest('hex').slice(0, 24);
      const reply = userFrame(findPeer(f.configDir, f.desktop.threadId), peerAddress(f.peerPath),
        'synthetic-orchestrator', f.peerId, id, `New answer ${round} to work item ${round}; this is not a forwarded payload.`,
        'prompting', behavior === 'append' ? bToken : behavior === 'local-compact' ? marker : null, requestChain);
      const wireReply = behavior === 'local-compact'
        ? { ...reply, local_chain: [...requestChain, bToken].slice(-32).join(',') } : reply;
      if (behavior === 'local-compact') {
        compactMarkers.add(marker);
        // Characterize the current compatibility gap: frame parsing strips this metadata.
        expect(frameSchema.parse(wireReply)).not.toHaveProperty('local_chain');
      }
      const chain = hopChain(reply.message.content);
      await sendFrames(f.configDir, findPeer(f.configDir, f.desktop.threadId), [wireReply]);
      await until(() => f.bridge.status().messages.some(message => message.id === id && ['started', 'dropped'].includes(message.status)));
      const result = f.bridge.status().messages.find(message => message.id === id)!;
      rows.push({ round, requestHops: requestChain.length, replyHops: chain.length,
        ownVisits: chain.filter(token => token === aToken).length, status: result.status, reason: result.drop_reason });
      if (result.status === 'started') f.commitPeer();
      return result;
    };
    try {
      for (let round = 1; round <= 12; round++) await exchange(round);
      expect(rows.slice(0, 9).every(row => row.status === 'started')).toBe(true);
      expect(rows.slice(9).map(row => [row.round, row.ownVisits, row.status, row.reason]))
        .toEqual([[10, 10, 'dropped', 'hop-loop'], [11, 10, 'dropped', 'hop-loop'], [12, 10, 'dropped', 'hop-loop']]);
      expect(rows[10]!.requestHops).toBe(rows[9]!.requestHops);
      expect(f.desktop.submissions).toHaveLength(9);
      if (behavior === 'local-compact') {
        expect(rows[8]!.replyHops).toBe(18);
        expect(rows[9]!.requestHops).toBe(19);
        expect(rows[9]!.replyHops).toBe(20);
        // Ten distinct markers through round 10; retries inherit the same dropped lineage.
        expect(compactMarkers.size).toBe(10);
      }
      expect(f.bridge.status().inboundPolicy).toBe('default');
      expect(f.bridge.status().heldCount).toBe(0);
      // Only a confirmed non-peer input changes the source selected by outgoingHops.
      f.commitHuman();
      expect((await exchange(13)).status).toBe('started');
      expect(rows.at(-1)?.ownVisits).toBe(1);
      expect(rows.at(-1)?.requestHops).toBe(1);
      console.log(JSON.stringify({ syntheticPeerBehavior: behavior, rows }));
    } finally { await f.close(); }
  }, 20000);
}

test('hop metadata alone cannot distinguish new semantic work from cyclic forwarding', () => {
  const db = new Database(':memory:');
  const guard = new PeerGuard(db);
  const a = 'a'.repeat(24), b = 'b'.repeat(24), c = 'c'.repeat(24);
  const chain = Array.from({ length: 10 }, () => [a, b]).flat();
  try {
    expect(guard.admit('b', 'Entirely new work item 10', chain, a)).toBe('hop-loop');
    expect(guard.admit('b', 'Forward the same request to A again', chain, a)).toBe('hop-loop');
    expect(guard.admit('b', 'new text does not override runaway protection', Array.from({ length: 10 }, () => [a, b, c]).flat(), a))
      .toBe('hop-runaway');
  } finally { db.close(); }
});
