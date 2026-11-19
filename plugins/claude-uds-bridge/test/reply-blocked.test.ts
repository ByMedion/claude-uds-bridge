import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { watchCodex } from '../src/codex';
import type { ReplyBlocked } from '../src/reply-blocked';
import { appServer } from './app-server-fixture';
import { compactFixture, eventually } from './compact-fixture';
import type { Frame } from '../src/claude';

const action = { type: 'mcpToolCall', server: 'claude_uds_bridge', toolName: 'send_message' };
function failedCall(recipientId: string, id = randomUUID()) {
  return { type: 'mcpToolCall', id, status: 'failed', server: action.server, tool: action.toolName,
    arguments: { sessionId: recipientId, text: 'private reply content' },
    error: { message: 'private diagnostic text' } };
}
function blockedNotices(frames: Frame[]) {
  return frames.flatMap(frame => frame.type === 'user' && frame.message.content.includes('approval review denied') ? [frame.message.content] : []);
}

test('Desktop canonical history links a denied reply to the consumed Claude input after turn completion', async () => {
  const f = await compactFixture();
  let unwatch: (() => void) | undefined;
  try {
    const historical = failedCall(f.peerId);
    const denial = (itemId: string, timestamp: number) => ({ type: 'automaticApprovalReview', id: 'automatic-approval-review:' + itemId, targetItemId: itemId,
      action, event: { status: 'denied', rationale: 'private review rationale' }, serverCompletedAtMs: timestamp });
    const history = { past: { turnId: randomUUID(), status: 'completed',
      items: [historical, denial(historical.id, Date.now() - 1000)] } };
    const observeCanonical = (current: object) => ({ turnHistory: {
      kind: 'canonical', history: { entitiesByKey: { ...history, current },
        islands: [{ entries: [{ value: 'past' }, { value: 'current' }],
          olderBoundary: { status: 'exhausted' }, newerBoundary: { status: 'exhausted' } }] } } });
    f.desktop.setHistory(observeCanonical({ turnId: randomUUID(), status: 'completed', items: [] }));
    const observed: ReplyBlocked[] = [];
    unwatch = await watchCodex(f.bridge.target(), f.desktop.threadId, () => {}, () => {}, undefined,
      event => { observed.push(event); void f.bridge.reportReplyBlocked(event); });
    expect(observed).toHaveLength(0);

    f.desktop.setHistory({ turns: [{ items: [{ type: 'userMessage', id: f.humanId }] }] });
    const sourceId = await f.request('Synthetic task request');
    await eventually(() => f.bridge.status().messages.some(m => m.id === sourceId && m.status === 'started'));
    const clientId = f.bridge.status().messages.find(m => m.id === sourceId)!.input_id;
    f.desktop.setState('active');
    const send = failedCall(f.peerId);
    const deniedAtMs = Date.now();
    const turn = { turnId: f.desktop.turnId, items: [{ type: 'userMessage', id: randomUUID(), clientId },
      send, denial(send.id, deniedAtMs)] };
    const path = ['turnHistory', 'history', 'entitiesByKey', 'current', 'status'];
    const snapshots = f.desktop.requests.length;
    f.desktop.setHistory(observeCanonical({ ...turn, status: 'inProgress' }), path);
    await eventually(() => f.desktop.requests.length > snapshots);
    expect(observed).toHaveLength(0);
    f.desktop.setHistory(observeCanonical({ ...turn, status: 'completed' }), path);
    await eventually(() => f.bridge.status().messages.some(m => m.kind === 'reply-blocked' && m.status === 'socket-written'));
    expect(observed).toEqual([{ turnId: f.desktop.turnId, recipientId: f.peerId, deniedAtMs }]);
    const notices = blockedNotices(f.frames);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(`accepted message ${sourceId}.`);
    for (const privateText of ['Synthetic task request', 'private reply content', 'private diagnostic text', 'private review rationale']) {
      expect(notices[0]).not.toContain(privateText);
    }
    expect(f.bridge.status().messages.find(m => m.kind === 'reply-blocked')).toMatchObject({
      parent_message_id: sourceId, turn_id: f.desktop.turnId, status_reason: 'approval_denied',
    });
    expect(f.bridge.status().automaticMessageBudget.used).toBe(1);

    await f.restart();
    await f.bridge.reportReplyBlocked(observed[0]!);
    expect(blockedNotices(f.frames)).toHaveLength(1);
    expect(f.bridge.status().messages.filter(m => m.kind === 'reply-blocked')).toHaveLength(1);
  } finally { unwatch?.(); await f.close(); }
});

test('a later submitted or uncertain reply suppresses notice, as does missing or ambiguous input consumption', async () => {
  const f = await compactFixture();
  try {
    const sourceId = await f.request('Synthetic task with uncertain response');
    await eventually(() => f.bridge.status().messages.some(m => m.id === sourceId && m.status === 'started'));
    const event = { turnId: f.desktop.turnId, recipientId: f.peerId, deniedAtMs: Date.now() - 10 };
    await f.bridge.reportReplyBlocked(event); // The original input is not yet known to have been consumed.
    expect(blockedNotices(f.frames)).toHaveLength(0);
    f.db.run('UPDATE messages SET native_input_id=? WHERE id=?', [randomUUID(), sourceId]);
    const replyId = randomUUID();
    f.db.run(`INSERT INTO messages(id,peer_id,direction,text,status,turn_id)
      VALUES (?,?,'out','later private response','unknown',?)`, [replyId, f.peerId, event.turnId]);
    await f.bridge.reportReplyBlocked(event);
    f.db.run("UPDATE messages SET status='socket-written' WHERE id=?", [replyId]);
    await f.bridge.reportReplyBlocked(event);
    f.db.run("UPDATE messages SET status='not-sent' WHERE id=?", [replyId]);
    const secondSource = randomUUID();
    f.db.run(`INSERT INTO messages(id,peer_id,peer_address,peer_start,direction,text,status,turn_id,native_input_id,local_verified)
      SELECT ?,peer_id,peer_address,peer_start,'in','second source','steered',turn_id,?,1 FROM messages WHERE id=?`,
      [secondSource, randomUUID(), sourceId]);
    await f.bridge.reportReplyBlocked(event);
    await f.bridge.reportReplyBlocked({ ...event, recipientId: randomUUID() });
    expect(f.bridge.status().messages.filter(m => m.kind === 'reply-blocked')).toHaveLength(0);
    expect(blockedNotices(f.frames)).toHaveLength(0);
  } finally { await f.close(); }
});

test('app-server reports only matching terminal auto-review denials, including turns with omitted items', async () => {
  const s = await appServer();
  let unwatch: (() => void) | undefined;
  try {
    const observed: ReplyBlocked[] = [];
    unwatch = await watchCodex({kind: 'app-server', path: s.path}, s.threadId, () => {}, () => {}, undefined,
      event => observed.push(event));
    const recipientId = randomUUID(), wrongCall = failedCall(randomUUID()), matched = failedCall(recipientId);
    const t = Date.now();
    const review = { turnId: s.turnId, targetItemId: matched.id, completedAtMs: t,
      review: { status: 'denied', rationale: 'private approval details' }, action };
    s.completeItem(wrongCall);
    s.completeReview({ ...review, targetItemId: wrongCall.id, review: { status: 'approved' } });
    s.completeReview({ ...review, targetItemId: wrongCall.id }, randomUUID());
    s.completeReview({ ...review, targetItemId: wrongCall.id, action: { ...action, toolName: 'other_tool' } });
    s.completeReview(review);
    s.completeItem(matched);
    s.completeTurn({ id: s.turnId, status: 'completed' });
    await eventually(() => observed.length >= 1);
    expect(observed).toEqual([{ turnId: s.turnId, recipientId, deniedAtMs: t }]);
  } finally { unwatch?.(); await s.close(); }
});
