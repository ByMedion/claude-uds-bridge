import { test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { deliverToDesktop, removeDesktopQueuedMessage } from '../src/desktop';
import { deliverToCodex } from '../src/codex';
import { messageDelivery } from '../src/claude';
import { receiver } from './desktop-fixture';

test.each(['idle', 'active'] as const)('v13 queue delivery in %s preserves existing queue and never steers', async state => {
  const desktop = await receiver(state, false, false, undefined, 13);
  const existing = { id: randomUUID(), text: 'existing user draft' };
  desktop.queuedMessages.set(existing.id, existing);
  const id = randomUUID();
  try {
    expect(await deliverToDesktop(desktop.path, desktop.threadId, id, 'peer update', 'queue'))
      .toEqual({ status: 'queued', turnId: null, queueId: id });
    expect(desktop.submissions).toEqual([]);
    expect(desktop.queuedMessages.get(existing.id)).toEqual(existing);
    expect(desktop.queuedMessages.get(id)).toMatchObject({ id, text: 'peer update' });
    expect(desktop.queuedMessages.get(id)).not.toHaveProperty('preparation');
    const writes = desktop.requests.filter(request => request.method === 'thread-follower-set-queued-follow-ups-state');
    expect(writes).toHaveLength(2);
    expect(writes.every(request => request.version === 3)).toBe(true);
    expect(await removeDesktopQueuedMessage(desktop.path, desktop.threadId, id)).toBe(true);
    expect([...desktop.queuedMessages.keys()]).toEqual([existing.id]);
  } finally { await desktop.close(); }
});

test('failed queue finalization removes its reservation and keeps other messages', async () => {
  const desktop = await receiver('active', false, false, undefined, 13);
  const existing = { id: randomUUID(), text: 'keep this' };
  desktop.queuedMessages.set(existing.id, existing);
  desktop.failQueue('finalize');
  try {
    await expect(deliverToDesktop(desktop.path, desktop.threadId, randomUUID(), 'failed update', 'queue'))
      .rejects.toThrow('preparation was canceled');
    expect([...desktop.queuedMessages.values()]).toEqual([existing]);
    expect(desktop.submissions).toEqual([]);
  } finally { await desktop.close(); }
});

test('lost queue acknowledgement never resends or falls back to steering', async () => {
  const desktop = await receiver('active', false, false, undefined, 13);
  desktop.failQueue('ack');
  try {
    await expect(deliverToDesktop(desktop.path, desktop.threadId, randomUUID(), 'uncertain update', 'queue')).rejects.toThrow();
    expect(desktop.requests.filter(request => request.method === 'thread-follower-set-queued-follow-ups-state')).toHaveLength(2);
    expect(desktop.queuedMessages.size).toBe(0);
    expect(desktop.submissions).toEqual([]);
  } finally { await desktop.close(); }
});

test('unsupported transports reject queue before submitting input', async () => {
  const desktop = await receiver('active');
  try {
    await expect(deliverToDesktop(desktop.path, desktop.threadId, randomUUID(), 'must not steer', 'queue')).rejects.toThrow('requires Desktop stream v13');
    await expect(deliverToCodex({ kind: 'app-server', path: '/not-connected.sock' }, desktop.threadId, randomUUID(), 'must not become user input', 'queue'))
      .rejects.toThrow('tool-output authority');
    expect(desktop.submissions).toEqual([]);
    expect(desktop.queuedMessages.size).toBe(0);
  } finally { await desktop.close(); }
});

test('a Claude text marker selects delivery inside its existing provenance envelope', () => {
  expect(messageDelivery('<cross-session-message from-mode="prompting">\n[bridge:queue]\nupdate\n</cross-session-message>')).toBe('queue');
  expect(messageDelivery('[bridge:steer]\nurgent', 'later')).toBe('steer');
  expect(messageDelivery('ordinary message', 'later')).toBe('queue');
  expect(messageDelivery('ordinary message')).toBe('steer');
  expect(messageDelivery('quoted [bridge:queue] in a sentence')).toBe('steer');
});
