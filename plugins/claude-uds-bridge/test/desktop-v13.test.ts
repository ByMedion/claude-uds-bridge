import { test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { receiver } from './desktop-fixture';
import { readDesktopRuntime, deliverToDesktop, watchDesktop, type Runtime } from '../src/desktop';

test.each(['idle', 'active'] as const)('v13 reads %s with prompting permissions', async state => {
  const desktop = await receiver(state, false, false, undefined, 13);
  try {
    expect(await readDesktopRuntime(desktop.path, desktop.threadId)).toEqual({
      status: state === 'idle' ? 'idle' : 'busy', mode: 'prompting',
    });
    expect(desktop.submissions).toHaveLength(0);
  } finally { await desktop.close(); }
});

test.each(['idle', 'active'] as const)('v13 mock %s delivery retains message identity', async state => {
  const desktop = await receiver(state, false, false, undefined, 13);
  const messageId = randomUUID();
  try {
    expect(await deliverToDesktop(desktop.path, desktop.threadId, messageId, 'v13 test')).toEqual({
      status: state === 'idle' ? 'started' : 'steered', turnId: desktop.turnId,
    });
    expect(desktop.submissions).toHaveLength(1);
    expect(JSON.stringify(desktop.submissions[0]?.params)).toContain(messageId);
    expect(JSON.stringify(desktop.submissions[0]?.params)).toContain('v13 test');
  } finally { await desktop.close(); }
});

test.each([10, 12, 14, 999])('unsupported version %s fails before delivery', async version => {
  const desktop = await receiver('idle', false, false, undefined, version);
  try {
    await expect(deliverToDesktop(desktop.path, desktop.threadId, randomUUID(), 'must not send'))
      .rejects.toThrow(`Unsupported Desktop stream version: ${version}`);
    expect(desktop.submissions).toHaveLength(0);
  } finally { await desktop.close(); }
});

test('v13 keeps unknown permissions unknown', async () => {
  const desktop = await receiver('idle', false, false, undefined, 13);
  try {
    desktop.setPermissions({ approvalPolicy: 'never', sandboxPolicy: { type: 'future-privilege' } });
    expect((await readDesktopRuntime(desktop.path, desktop.threadId)).mode).toBe('unknown');
  } finally { await desktop.close(); }
});

test('v13 rejects malformed permission snapshots', async () => {
  const desktop = await receiver('idle', false, false, undefined, 13);
  try {
    desktop.setHistory({ currentPermissions: { approvalPolicy: 17 } });
    await expect(readDesktopRuntime(desktop.path, desktop.threadId)).rejects.toThrow();
  } finally { await desktop.close(); }
});

test('v13 observes patches without submitting', async () => {
  const desktop = await receiver('idle', false, false, undefined, 13);
  const states: Runtime[] = [];
  const close = await watchDesktop(desktop.path, desktop.threadId, value => states.push(value), () => {});
  try {
    desktop.setState('active');
    const deadline = Date.now() + 1000;
    while (states.at(-1)?.status !== 'busy' && Date.now() < deadline) await Bun.sleep(5);
    expect(states.at(-1)).toEqual({ status: 'busy', mode: 'prompting' });
    expect(desktop.submissions).toHaveLength(0);
  } finally { close(); await desktop.close(); }
});
