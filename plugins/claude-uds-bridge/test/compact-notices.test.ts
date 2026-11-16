import { expect, test } from 'bun:test';
import { compactFixture, eventually } from './compact-fixture';
import type { Frame } from '../src/claude';

function notices(frames: Frame[]) {
  return frames.flatMap(frame => {
    if (frame.type !== 'user') return [];
    const body = /\n(\{"event":"compact_(?:status|result)"[^\n]+\})/.exec(frame.message.content)?.[1];
    return body ? [JSON.parse(body) as { event: string; requestId: string; status: string; detail: string; deadline?: number; pendingRequestId?: string }] : [];
  });
}

test('waiting explains its initial blocker once across restart; submitted is progress and completed is one final callback', async () => {
  const f = await compactFixture();
  try {
    f.bridge.setCompactAccess(f.peerId, true);
    f.desktop.setState('active');
    const id = await f.request();
    await eventually(() => notices(f.frames).some(n => n.requestId === id && n.status === 'waiting'));
    const first = notices(f.frames)[0]!;
    expect(first.event).toBe('compact_status');
    expect(first.detail).toContain('recipient_busy');
    expect(first.deadline).toBeGreaterThan(Date.now());
    expect(f.desktop.compactions).toHaveLength(0);
    await f.restart();
    await Bun.sleep(1200);
    expect(notices(f.frames)).toHaveLength(1);
    f.desktop.setState('idle');
    await eventually(() => notices(f.frames).some(n => n.requestId === id && n.status === 'submitted'), 5000);
    expect(notices(f.frames).some(n => n.event === 'compact_result')).toBe(false);
    f.desktop.completeCompaction();
    await eventually(() => notices(f.frames).some(n => n.requestId === id && n.status === 'completed'));
    expect(notices(f.frames).map(n => [n.event, n.status])).toEqual([
      ['compact_status', 'waiting'], ['compact_status', 'submitted'], ['compact_result', 'completed'],
    ]);
    expect(f.bridge.status().automaticMessageBudget.used).toBe(3);
    expect(f.desktop.compactions).toHaveLength(1);
  } finally { await f.close(); }
}, 12000);

test('a guard-admitted duplicate gets its own refused result naming the existing request without scheduling another compact', async () => {
  const f = await compactFixture();
  try {
    f.bridge.setCompactAccess(f.peerId, true);
    f.desktop.setState('active');
    const first = await f.request();
    await eventually(() => notices(f.frames).some(n => n.requestId === first));
    const tooSoon = await f.request();
    await eventually(() => f.bridge.status().messages.some(m => m.id === tooSoon && m.drop_reason === 'duplicate'));
    expect(notices(f.frames).some(n => n.requestId === tooSoon)).toBe(false);
    // Advance only the synthetic dedup timestamp beyond its normal 30-second window.
    f.db.run('UPDATE peer_guard SET body_at=?', [Date.now() - 31000]);
    const duplicate = await f.request();
    await eventually(() => notices(f.frames).some(n => n.requestId === duplicate));
    const reply = notices(f.frames).find(n => n.requestId === duplicate)!;
    expect(reply.event).toBe('compact_result');
    expect(reply.status).toBe('refused');
    expect(reply.detail).toContain('compact_already_pending');
    expect(reply.pendingRequestId).toBe(first);
    expect(f.bridge.status().compactions).toHaveLength(1);
    expect(f.desktop.compactions).toHaveLength(0);
  } finally { await f.close(); }
});

test('untrusted and ungranted requests never start ordinary notification turns', async () => {
  const f = await compactFixture();
  try {
    const denied = await f.request();
    await eventually(() => f.bridge.status().messages.some(m => m.id === denied && m.status === 'refused'));
    f.bridge.setCompactAccess(f.peerId, true);
    const untrusted = await f.request('[bridge:compact]', false);
    await eventually(() => f.bridge.status().messages.some(m => m.id === untrusted && m.status === 'refused'));
    expect(f.frames.filter(frame => frame.type === 'user')).toHaveLength(0);
    expect(f.bridge.status().automaticMessageBudget.used).toBe(0);
  } finally { await f.close(); }
});

test('expiry sends one final result after waiting and never claims completion', async () => {
  const f = await compactFixture();
  try {
    f.bridge.setCompactAccess(f.peerId, true);
    f.desktop.setState('active');
    const id = await f.request();
    await eventually(() => notices(f.frames).some(n => n.status === 'waiting'));
    f.db.run('UPDATE compaction_requests SET deadline=0 WHERE id=?', [id]);
    await eventually(() => notices(f.frames).some(n => n.status === 'expired'));
    expect(notices(f.frames).filter(n => n.event === 'compact_result').map(n => n.status)).toEqual(['expired']);
    expect(f.desktop.compactions).toHaveLength(0);
  } finally { await f.close(); }
});

test('waiting refreshes consumed input mappings even without another runtime transition', async () => {
  const f = await compactFixture();
  try {
    f.bridge.setCompactAccess(f.peerId, true);
    const inputId = crypto.randomUUID(), clientId = crypto.randomUUID();
    f.db.run(`INSERT INTO messages(id,peer_id,direction,text,status,kind,awaiting_input,desktop_input_id)
      VALUES (?,?,'in','synthetic prior input','steered','message',1,?)`, [crypto.randomUUID(), f.peerId, clientId]);
    const id = await f.request();
    await eventually(() => f.bridge.status().compactions.find(r => r.id === id)?.reason?.includes('unread_input') ?? false);
    expect(f.desktop.compactions).toHaveLength(0);
    f.desktop.setHistory({ turns: [{ items: [{ type: 'userMessage', id: inputId, clientId }] }] });
    await eventually(() => f.desktop.compactions.length === 1, 5000);
    expect(f.bridge.status().unreadCount).toBe(0);
    expect(f.bridge.status().automaticMessageBudget.lastHumanInputId).not.toBe(inputId);
  } finally { await f.close(); }
}, 10000);

test('failed optional progress bookkeeping cannot turn native admission into an unknown operation', async () => {
  const f = await compactFixture();
  try {
    f.bridge.setCompactAccess(f.peerId, true);
    f.db.run('DROP TABLE compact_notices');
    const id = await f.request();
    await eventually(() => f.bridge.status().compactions.find(r => r.id === id)?.status === 'submitted', 5000);
    f.desktop.completeCompaction();
    await eventually(() => notices(f.frames).some(n => n.requestId === id && n.status === 'completed'));
    expect(notices(f.frames).map(n => n.event)).toEqual(['compact_result']);
    expect(f.desktop.compactions).toHaveLength(1);
  } finally { await f.close(); }
}, 10000);
