import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { watchCodex } from '../src/codex';
import type { TurnFailure } from '../src/turn-failure';
import { compactFixture, eventually } from './compact-fixture';
import { appServer } from './app-server-fixture';
import type { Frame } from '../src/claude';

function notices(frames: Frame[]) {
  return frames.flatMap(frame => frame.type === 'user' && frame.message.content.includes('ended with status failed')
    ? [frame.message.content] : []);
}

test('Desktop v13 reports a canonical failed turn to its Claude participant while the chat stays active', async () => {
  const f = await compactFixture();
  let unwatch: (() => void) | undefined;
  const report = (failure: TurnFailure) => { void f.bridge.reportTurnFailure(failure); };
  try {
    const oldId = randomUUID();
    f.db.run(`INSERT INTO messages(id,peer_id,direction,text,status,turn_id,peer_address,peer_start,local_verified)
      VALUES (?,?,'in','historical','started',?,'uds:/tmp/old.sock','unused',1)`,
      [randomUUID(), f.peerId, oldId]);
    const old = { turnId: oldId, status: 'failed', turnStartedAtMs: Date.now() - 20000, durationMs: 1000 };
    const canonical = (turn: unknown) => ({ turnHistory: { kind: 'canonical', history: { entitiesByKey: { old, current: turn } } } });
    f.desktop.setHistory(canonical({ ...old, turnId: randomUUID(), status: 'completed' }));
    unwatch = await watchCodex(f.bridge.target(), f.desktop.threadId, () => {}, () => {}, report);
    expect(f.bridge.status().messages.filter(m => m.kind === 'turn-failed')).toHaveLength(0);

    // Link through a real authenticated inbound frame and a native admission receipt.
    f.desktop.setHistory({ turns: [{ items: [{ type: 'userMessage', id: f.humanId }] }] });
    const requestId = await f.request('Work from the orchestrator');
    await eventually(() => f.bridge.status().messages.some(m => m.id === requestId && m.status === 'started'));
    f.desktop.setState('active');
    // A newer row in another turn cannot become the recipient.
    f.db.run(`INSERT INTO messages(id,peer_id,direction,text,status,turn_id,peer_address,peer_start)
      VALUES (?,?,'out','unrelated','socket-written',?,'uds:/tmp/unrelated.sock','other')`,
      [randomUUID(), randomUUID(), randomUUID()]);
    const started = Date.now();
    const failed = { turnId: f.desktop.turnId, status: 'failed', turnStartedAtMs: started, durationMs: 0,
      error: { codexErrorInfo: 'cyberPolicy', message: 'private error transcript' } };
    const publish = () => f.desktop.setHistory(canonical(failed), ['turnHistory', 'history', 'entitiesByKey', 'current']);
    publish();
    await eventually(() => notices(f.frames).length === 1);
    expect(notices(f.frames)[0]).toContain(`${new Date(started).toISOString()} · turn ${failed.turnId} ended with status failed (cyberPolicy).`);
    expect(notices(f.frames)[0]).not.toContain('private error transcript');
    expect(notices(f.frames)[0]).not.toContain('Work from the orchestrator');
    expect(notices(f.frames)[0]).not.toContain('attention');
    expect(f.desktop.submissions).toHaveLength(1);
    await eventually(() => f.bridge.status().messages.some(m => m.kind === 'turn-failed' && m.status === 'socket-written'));
    expect(f.bridge.status().automaticMessageBudget.used).toBe(1);

    const connections = f.desktop.requests.filter(r => r.method === 'initialize').length;
    f.desktop.disconnectClients();
    await eventually(() => f.desktop.requests.filter(r => r.method === 'initialize').length > connections);
    publish();
    await f.restart();
    await f.bridge.reportTurnFailure({ id: failed.turnId, errorCode: 'cyberPolicy', finishedAt: started });
    expect(notices(f.frames)).toHaveLength(1);
    expect(f.bridge.status().messages.filter(m => m.kind === 'turn-failed')).toHaveLength(1);
  } finally { unwatch?.(); await f.close(); }
});

test('a recent outbound message can be the only turn correlation; an unrecognized category is redacted', async () => {
  const f = await compactFixture();
  let unwatch: (() => void) | undefined;
  try {
    const turnId = randomUUID();
    f.desktop.setHistory({ turns: [{ turnId, status: 'inProgress', items: [{ type: 'userMessage', id: f.humanId }] }] });
    f.desktop.setState('active');
    const sent = await f.bridge.sendMessage(f.peerId, 'Codex initiated the conversation');
    expect(f.bridge.status().messages.find(m => m.id === sent.messageId)?.turn_id).toBe(turnId);
    unwatch = await watchCodex(f.bridge.target(), f.desktop.threadId, () => {}, () => {},
      failure => { void f.bridge.reportTurnFailure(failure); });
    f.desktop.setHistory({ turns: [{ turnId, status: 'failed',
      error: { codexErrorInfo: 'privateErrorCategory', message: 'private raw details' } }] }, ['turns', 0, 'status']);
    await eventually(() => notices(f.frames).length === 1);
    expect(notices(f.frames)[0]).toContain(`turn ${turnId} ended with status failed (other).`);
    expect(notices(f.frames)[0]).not.toContain('private');
    expect(f.desktop.submissions).toHaveLength(0);
  } finally { unwatch?.(); await f.close(); }
});

test('the last correlated peer is never replaced, and failed notices obey the automatic send budget', async () => {
  const f = await compactFixture();
  try {
    const id = await f.request('Initial Claude request');
    await eventually(() => f.bridge.status().messages.some(m => m.id === id && m.status === 'started'));
    const other = randomUUID(), changed = randomUUID();
    f.db.run(`INSERT INTO messages(id,peer_id,direction,text,status,turn_id,peer_address,peer_start)
      SELECT ?,?,'out','more recent','socket-written',turn_id,peer_address,peer_start FROM messages WHERE id=?`,
      [other, changed, id]);
    const failure = { id: f.desktop.turnId, errorCode: 'serverOverloaded', finishedAt: Date.now() };
    await f.bridge.reportTurnFailure(failure);
    expect(f.bridge.status().messages.find(m => m.kind === 'turn-failed')).toMatchObject({
      peer_id: changed, status: 'not-sent', status_reason: 'peer_identity_changed_or_not_claude',
    });

    const nextTurn = randomUUID();
    f.db.run('UPDATE messages SET turn_id=? WHERE id=?', [nextTurn, id]);
    f.db.run('UPDATE dialogue_budget SET used=100');
    await f.bridge.reportTurnFailure({ ...failure, id: nextTurn });
    expect(f.bridge.status().messages.find(m => m.kind === 'turn-failed' && m.turn_id === nextTurn))
      .toMatchObject({ status: 'not-sent', status_reason: 'automatic_budget_exhausted' });

    await f.bridge.reportTurnFailure({ ...failure, id: randomUUID() });
    expect(f.bridge.status().messages.filter(m => m.kind === 'turn-failed')).toHaveLength(2);
    expect(notices(f.frames)).toHaveLength(0);
    expect(f.bridge.status().automaticMessageBudget.used).toBe(100);
  } finally { await f.close(); }
});

test('the app-server observer accepts only failed completion events for the bound chat', async () => {
  const server = await appServer();
  let unwatch: (() => void) | undefined;
  const failures: TurnFailure[] = [];
  try {
    unwatch = await watchCodex({ kind: 'app-server', path: server.path }, server.threadId, () => {}, () => {},
      failure => failures.push(failure));
    for (const status of ['completed', 'interrupted', 'inProgress']) server.completeTurn({ id: randomUUID(), status });
    server.completeTurn({ id: randomUUID(), status: 'failed' }, randomUUID());
    server.completeTurn({ id: server.turnId, status: 'failed', completedAt: 1700000000,
      error: { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } }, additionalDetails: 'private' } });
    await eventually(() => failures.length > 0);
    expect(failures).toEqual([{ id: server.turnId, errorCode: 'responseStreamDisconnected', finishedAt: 1700000000000 }]);
  } finally { unwatch?.(); await server.close(); }
});
