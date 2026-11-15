import { test, expect, setSystemTime } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { Bridge } from '../src/bridge';
import { PeerGuard } from '../src/guard';
import { findPeer, frameSchema, hopChain, peerAddress, sendFrames, userFrame, processStart, type Frame } from '../src/claude';
import { receiver } from './desktop-fixture';

async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

// A is the real Bridge and guard. B is a synthetic wire peer, not a Claude model/runtime.
// Legacy behaviors and the verified-local compaction shape inspected in Claude 2.1.325 are
// synthetic fixtures. This test does not execute Claude or assume its effective remote policy.
async function dialogue(modern = false) {
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
    cwd: root, peerProtocol: 1, peerFeatures: modern ? ['local_chain', 'notify_idle'] : [],
    ...(modern && { procStart: await processStart(process.ppid) }),
  }));
  let bridge = new Bridge(desktop.threadId, configDir, join(root, 'state'), desktop.path);
  await bridge.start(directory, root, bridge.beginSession());
  bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
  const inputs: { type: string; id: string; clientId: string | null }[] = [];
  const commitHuman = () => {
    inputs.push({ type: 'userMessage', id: randomUUID(), clientId: null });
    desktop.setHistory({ turns: [{ items: [...inputs] }] });
  };
  const commitPeer = (clientId?: string) => {
    const params = desktop.submissions.at(-1)?.params as { turnStart: { request: { clientUserMessageId: string } } };
    inputs.push({ type: 'userMessage', id: randomUUID(), clientId: clientId ?? params.turnStart.request.clientUserMessageId });
    desktop.setHistory({ turns: [{ items: [...inputs] }] });
  };
  commitHuman();
  return { get bridge() { return bridge; }, desktop, configDir, directory, peerId, peerPath, frames, commitHuman, commitPeer,
    root, stateDir: join(root, 'state'),
    async restart() {
      await bridge.close();
      bridge = new Bridge(desktop.threadId, configDir, join(root, 'state'), desktop.path);
      await bridge.start(directory, root, bridge.resumeSession());
      bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
    },
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
        // The field now survives parsing; unauthenticated legacy ingress still cannot enable compaction.
        expect(frameSchema.parse(wireReply)).toHaveProperty('local_chain');
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

test('authenticated local lineage survives a permission hold and native queue consumption', async () => {
  const f = await dialogue(true);
  const audit = new Database(join(f.stateDir, `${f.desktop.threadId}.sqlite`));
  try {
    await f.bridge.sendMessage(f.peerId, 'initial request');
    const own = hopChain((f.frames.find(frame => frame.type === 'user') as Extract<Frame, { type: 'user' }>).message.content)[0]!;
    const id = randomUUID();
    const full = [own, 'b'.repeat(24)].join(',');
    const reply = { ...userFrame(findPeer(f.configDir, f.desktop.threadId), peerAddress(f.peerPath),
      'synthetic-native', f.peerId, id, 'queued reply', 'prompting', null, [own, 'c'.repeat(24)], 'queue'), local_chain: full };
    await f.bridge.setPolicy('hold');
    await sendFrames(f.configDir, findPeer(f.configDir, f.desktop.threadId), [reply]);
    await until(() => f.bridge.status().heldCount === 1);
    expect(audit.query('SELECT local_verified,local_chain FROM messages WHERE id=?').get(id))
      .toEqual({ local_verified: 1, local_chain: full });
    expect(f.desktop.queuedMessages.size).toBe(0);
    await f.bridge.setPolicy('accept');
    const queued = f.bridge.status().messages.find(message => message.id === id)!;
    expect(queued.status).toBe('queued');
    f.commitPeer(queued.input_id!);
    await f.bridge.sendMessage(f.peerId, 'after consuming queued reply');
    const outgoing = f.frames.filter(frame => frame.type === 'user').at(-1)!;
    if (outgoing.type !== 'user') throw new Error('Missing user frame');
    expect(outgoing.local_chain?.split(',')).toEqual([own, 'b'.repeat(24), own]);
    expect(hopChain(outgoing.message.content)).toHaveLength(2);
    expect(f.bridge.status().automaticMessageBudget.used).toBe(2);
  } finally { audit.close(); await f.close(); }
});

test('authenticated two/three-party cycles share 100 sends across MCP and receiver restarts, then wait for a human', async () => {
  const f = await dialogue(true);
  const third = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' });
  const thirdId = randomUUID();
  const thirdPath = join(f.directory, `${third.pid}.sock`);
  const thirdServer = net.createServer(socket => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        f.frames.push(frameSchema.parse(JSON.parse(buffer.slice(0, end))));
        buffer = buffer.slice(end + 1);
      }
    });
  });
  thirdServer.listen(thirdPath);
  await once(thirdServer, 'listening');
  chmodSync(thirdPath, 0o600);
  writeFileSync(join(f.configDir, 'sessions', `${third.pid}.json`), JSON.stringify({
    pid: third.pid, procStart: await processStart(third.pid), sessionId: thirdId,
    messagingSocketPath: thirdPath, cwd: f.root, peerProtocol: 1, peerFeatures: ['local_chain'],
  }));
  const secret = randomBytes(32);
  const cToken = randomBytes(12).toString('hex');
  const bToken = randomBytes(12).toString('hex');
  const start = Date.now();
  const audit = new Database(join(f.stateDir, `${f.desktop.threadId}.sqlite`));
  let sender = new Bridge(f.desktop.threadId, f.configDir, f.stateDir, f.desktop.path);
  let aToken = '';
  const exchange = async (round: number) => {
    // Advance the existing 0.5/s burst refill; no production rate limit is changed.
    setSystemTime(start + round * 2100);
    const targetId = round > 60 && round % 2 === 0 ? thirdId : f.peerId;
    const targetPath = targetId === thirdId ? thirdPath : f.peerPath;
    const targetToken = targetId === thirdId ? cToken : bToken;
    const sent = await sender.sendMessage(targetId, round > 60 ? `Forward the work again ${round}` : `Work item ${round}`);
    await until(() => f.frames.some(frame => frame.type === 'user' && frame.msg_id === sent.messageId));
    const outgoing = f.frames.find(frame => frame.type === 'user' && frame.msg_id === sent.messageId)!;
    if (outgoing.type !== 'user') throw new Error('Missing outgoing user frame');
    const short = hopChain(outgoing.message.content);
    aToken ||= short[0]!;
    // A synthetic native peer in local-hop-compaction mode. Full metadata is
    // transported out of band from the short envelope; no model is called.
    const inherited = outgoing.local_chain?.split(',') ?? short;
    const full = [...inherited, targetToken].slice(-32);
    const marker = createHmac('sha256', secret).update(short.join(',')).digest('hex').slice(0, 24);
    const compact = [...(outgoing.local_chain ? short.slice(0, -1) : short), marker];
    const id = randomUUID();
    const reply = { ...userFrame(findPeer(f.configDir, f.desktop.threadId), peerAddress(targetPath),
      'synthetic-native', targetId, id, `Answer ${round}`, 'prompting', null, compact), local_chain: full.join(',') };
    await sendFrames(f.configDir, findPeer(f.configDir, f.desktop.threadId), [reply]);
    await until(() => f.bridge.status().messages.some(message => message.id === id && ['started', 'dropped'].includes(message.status)));
    expect(f.bridge.status().messages.find(message => message.id === id)?.status).toBe('started');
    f.commitPeer();
    expect(short.length).toBeLessThanOrEqual(2);
    if (round > 1 && round <= 100) expect(outgoing.local_chain).toBeDefined();
    if (round > 20 && round <= 100) expect(full.filter(token => token === aToken).length).toBeGreaterThanOrEqual(10);
  };
  try {
    for (let round = 1; round <= 100; round++) {
      await exchange(round);
      if (round === 50) {
        await sender.close();
        await f.restart();
        sender = new Bridge(f.desktop.threadId, f.configDir, f.stateDir, f.desktop.path);
        expect(sender.status().automaticMessageBudget.used).toBe(50);
      }
    }
    expect(sender.status().automaticMessageBudget).toMatchObject({ limit: 100, used: 100, remaining: 0 });
    const total = f.frames.filter(frame => frame.type === 'user').length;
    await expect(sender.sendMessage(f.peerId, 'One too many', true)).rejects.toThrow('budget exhausted');
    expect(f.frames.filter(frame => frame.type === 'user')).toHaveLength(total);
    expect(sender.status().idleRequests).toHaveLength(0);
    // A new session ID on the same registered peer process cannot renew this chat's budget.
    const recordPath = join(f.configDir, 'sessions', `${process.ppid}.json`);
    const { readFileSync } = await import('node:fs');
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    const otherId = randomUUID();
    writeFileSync(recordPath, JSON.stringify({ ...record, sessionId: otherId }));
    await expect(sender.sendMessage(otherId, 'Switching recipient identity')).rejects.toThrow('budget exhausted');
    writeFileSync(recordPath, JSON.stringify(record));
    await sender.close();
    await f.restart();
    sender = new Bridge(f.desktop.threadId, f.configDir, f.stateDir, f.desktop.path);
    await expect(sender.sendMessage(f.peerId, 'Restart is not renewal')).rejects.toThrow('budget exhausted');
    expect(audit.query<{ n: number }, []>('SELECT count(*) AS n FROM messages WHERE direction=\'in\' AND local_verified=1 AND local_chain IS NOT NULL').get()?.n).toBe(100);
    expect(audit.query<{ n: number }, []>('SELECT count(*) AS n FROM messages WHERE direction=\'out\' AND parent_input_id IS NOT NULL').get()?.n).toBe(100);
    f.commitHuman();
    await exchange(101);
    expect(sender.status().automaticMessageBudget).toMatchObject({ used: 1, remaining: 99 });
  } finally {
    setSystemTime(); await sender.close(); audit.close(); await f.close();
    await new Promise<void>(resolve => thirdServer.close(() => resolve()));
    third.kill(); await third.exited;
  }
}, 60000);
