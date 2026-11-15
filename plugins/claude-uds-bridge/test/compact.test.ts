import { test, expect } from 'bun:test';
import { Bridge } from '../src/bridge';
import { compactMarker, desktopCompactions } from '../src/compact';
import { compactFixture, eventually } from './compact-fixture';

test('compact needs per-chat user permission and socket authentication; slash commands stay plain input', async () => {
  const f = await compactFixture();
  try {
    const disabled = await f.request();
    await eventually(() => f.bridge.status().messages.some(row => row.id === disabled && row.status === 'refused'));
    f.bridge.setCompactAccess(f.peerId, true);
    const spoof = await f.request('[bridge:compact]', false);
    await eventually(() => f.bridge.status().messages.some(row => row.id === spoof && row.status === 'refused'));
    expect(f.desktop.compactions).toHaveLength(0);
    const secondChat = new Bridge(crypto.randomUUID(), f.configDir, f.stateDir, f.desktop.path);
    try { expect(secondChat.status().compactAccess).toEqual([]); } finally { await secondChat.close(); }
    const literal = await f.request('/compact');
    await eventually(() => f.bridge.status().messages.some(row => row.id === literal && row.status === 'started'));
    expect(f.desktop.submissions).toHaveLength(1);
    expect(f.desktop.compactions).toHaveLength(0);
  } finally { await f.close(); }
});

test('compact waits for a quiet idle boundary, distinguishes admission from completion, and reserves its one result notice', async () => {
  const f = await compactFixture();
  try {
    f.bridge.setCompactAccess(f.peerId, true);
    await eventually(() => f.bridge.status().automaticMessageBudget.lastHumanInputId === f.humanId);
    f.db.run('UPDATE dialogue_budget SET used=99');
    f.desktop.setState('active');
    const id = await f.request();
    await eventually(() => f.bridge.status().compactions.some(row => row.id === id && row.status === 'waiting'));
    await Bun.sleep(1100);
    expect(f.desktop.compactions).toHaveLength(0);
    f.desktop.setState('idle');
    await eventually(() => f.desktop.compactions.length === 1, 4500);
    expect(f.bridge.status().compactions.find(row => row.id === id)?.status).toBe('submitted');
    expect(f.frames.filter(frame => frame.type === 'user')).toHaveLength(0);
    expect(f.bridge.status().automaticMessageBudget.used).toBe(100);
    f.desktop.completeCompaction();
    await eventually(() => f.bridge.status().compactions.find(row => row.id === id)?.status === 'completed');
    await eventually(() => f.frames.some(frame => frame.type === 'user' && frame.message.content.includes('compact_result')));
    expect(f.frames.filter(frame => frame.type === 'user')).toHaveLength(1);
    expect(f.desktop.submissions).toHaveLength(0);
    expect(f.bridge.status().automaticMessageBudget.used).toBe(100);
    // An exhausted message budget refuses execution; it is not reset by compact.
    f.db.run('DELETE FROM peer_guard');
    const next = await f.request();
    await eventually(() => f.bridge.status().compactions.find(row => row.id === next)?.status === 'refused', 4500);
    expect(f.desktop.compactions).toHaveLength(1);
  } finally { await f.close(); }
}, 15000);

test('loss of native compact acknowledgement never causes an automatic resubmission', async () => {
  const f = await compactFixture();
  try {
    f.bridge.setCompactAccess(f.peerId, true);
    f.desktop.loseCompactAcknowledgement();
    const id = await f.request();
    await eventually(() => f.bridge.status().compactions.find(row => row.id === id)?.status === 'unknown', 5000);
    await Bun.sleep(1100);
    expect(f.desktop.compactions).toHaveLength(1);
    expect(f.bridge.status().automaticMessageBudget.used).toBe(1);
  } finally { await f.close(); }
}, 10000);

test('only exact compact markers and explicit native completion evidence are accepted', () => {
  expect(compactMarker('[bridge:compact]')).toBe(true);
  expect(compactMarker('[bridge:compact]\nrun arbitrary extra work')).toBe(false);
  expect(compactMarker('/compact')).toBe(false);
  const runtime = { status: 'idle' as const, mode: 'prompting' as const };
  const state = desktopCompactions({ turns: [{ items: [
    { id: 'pending', type: 'contextCompaction', completed: false, source: 'manual' },
    { id: 'done', type: 'contextCompaction', completed: true, source: 'manual' },
    { id: 'auto', type: 'contextCompaction', completed: true, source: 'automatic' },
  ] }] }, runtime, '/tmp');
  expect(state.completed).toEqual(['done']);
  expect(state.running).toEqual(['pending']);
});


test('revocation, fresh permission mismatch and expired wait prevent native compaction', async () => {
  for (const action of ['revoke', 'permissions', 'expire', 'end'] as const) {
    const f = await compactFixture();
    try {
      f.bridge.setCompactAccess(f.peerId, true);
      f.desktop.setState('active');
      const id = await f.request();
      await eventually(() => f.bridge.status().compactions.some(row => row.id === id && row.status === 'waiting'));
      if (action === 'revoke') f.bridge.setCompactAccess(f.peerId, false);
      if (action === 'permissions') f.desktop.setPermissions({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
      if (action === 'expire') f.db.run('UPDATE compaction_requests SET deadline=0 WHERE id=?', [id]);
      if (action === 'end') f.bridge.endSession();
      await eventually(() => f.bridge.status().compactions.find(row => row.id === id)?.status === (action === 'expire' || action === 'end' ? 'expired' : 'refused'));
      expect(f.desktop.compactions).toHaveLength(0);
    } finally { await f.close(); }
  }
}, 15000);

test('receiver restart after submission keeps access and budget, exposes unknown and never resubmits', async () => {
  const f = await compactFixture();
  try {
    f.bridge.setCompactAccess(f.peerId, true);
    const id = await f.request();
    await eventually(() => f.bridge.status().compactions.find(row => row.id === id)?.status === 'submitted', 5000);
    await f.restart();
    expect(f.bridge.status().compactAccess).toEqual([f.peerId]);
    expect(f.bridge.status().compactions.find(row => row.id === id)?.status).toBe('unknown');
    expect(f.bridge.status().automaticMessageBudget.used).toBe(1);
    await Bun.sleep(1100);
    expect(f.desktop.compactions).toHaveLength(1);
  } finally { await f.close(); }
}, 10000);


test('explicit human approval releases a held compact request without granting another chat or peer access', async () => {
  const f = await compactFixture();
  try {
    f.bridge.setCompactAccess(f.peerId, true);
    const id = await f.request('[bridge:compact]', true, 'bypass');
    await eventually(() => f.bridge.status().messages.find(row => row.id === id)?.status === 'held');
    expect(f.desktop.compactions).toHaveLength(0);
    await f.bridge.resolveHeld(id, 'approve');
    await eventually(() => f.bridge.status().compactions.find(row => row.id === id)?.status === 'submitted', 5000);
    expect(f.desktop.compactions).toHaveLength(1);
    expect(f.bridge.status().compactAccess).toEqual([f.peerId]);
  } finally { await f.close(); }
}, 10000);

test('bridge text arriving during submitted compact waits until explicit completion', async () => {
  const f = await compactFixture();
  try {
    f.bridge.setCompactAccess(f.peerId, true);
    const compact = await f.request();
    await eventually(() => f.bridge.status().compactions.find(row => row.id === compact)?.status === 'submitted', 5000);
    const next = await f.request('next work item');
    await eventually(() => f.bridge.status().messages.some(row => row.id === next && row.status === 'pending'));
    expect(f.desktop.submissions).toHaveLength(0);
    f.desktop.completeCompaction();
    await eventually(() => f.bridge.status().messages.find(row => row.id === next)?.status === 'started');
    expect(f.desktop.submissions).toHaveLength(1);
  } finally { await f.close(); }
}, 10000);
