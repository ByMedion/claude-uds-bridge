import { test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Bridge } from '../src/bridge';
import { compactFixture, eventually } from './compact-fixture';

test('profile mode is live across chats, persists, preserves individual grants and isolates profiles', async () => {
  const f = await compactFixture();
  const second = new Bridge(randomUUID(), f.configDir, f.stateDir, f.desktop.path);
  const isolated = new Bridge(randomUUID(), f.configDir, join(f.root, 'other-profile'), f.desktop.path);
  const policy = join(f.stateDir, 'compact-policy.json');
  try {
    expect(second.status().compactAccessMode).toBe('per-chat');
    f.bridge.setCompactAccess(f.peerId, true);
    expect(second.status().compactAccess).toEqual([]);
    second.setCompactAccessMode('all-claude');
    expect(f.bridge.status().compactAccessMode).toBe('all-claude');
    expect(f.bridge.status().compactAccess).toEqual([f.peerId]);
    expect(isolated.status().compactAccessMode).toBe('per-chat');
    expect(statSync(policy).mode & 0o777).toBe(0o600);
    const future = new Bridge(randomUUID(), f.configDir, f.stateDir, f.desktop.path);
    try {
      expect(future.status().compactAccessMode).toBe('all-claude');
      expect(future.status().compactAccess).toEqual([]);
      future.setCompactAccessMode('per-chat');
    } finally { await future.close(); }
    expect(f.bridge.status().compactAccessMode).toBe('per-chat');
    expect(f.bridge.status().compactAccess).toEqual([f.peerId]);
    await f.restart();
    expect(f.bridge.status().compactAccessMode).toBe('per-chat');
    expect(f.bridge.status().compactAccess).toEqual([f.peerId]);
    writeFileSync(policy, '{"mode":"unknown"}');
    expect(() => second.status()).toThrow();
    unlinkSync(policy);
    const external = join(f.root, 'external.json');
    writeFileSync(external, '{"mode":"all-claude"}');
    symlinkSync(external, policy);
    expect(() => second.status()).toThrow();
    unlinkSync(policy);
  } finally { await second.close(); await isolated.close(); await f.close(); }
});

test('full trust requires authenticated Claude, revocation stops waiting, and regrant completes without restart', async () => {
  const f = await compactFixture();
  const controller = new Bridge(randomUUID(), f.configDir, f.stateDir, f.desktop.path);
  try {
    f.bridge.setCompactAccessMode('all-claude');
    f.desktop.setState('active');
    const unauthenticated = await f.request('[bridge:compact]', false);
    await eventually(() => f.bridge.status().messages.find(row => row.id === unauthenticated)?.status === 'refused');
    const registry = join(f.configDir, 'sessions', `${process.ppid}.json`);
    const original = readFileSync(registry, 'utf8');
    writeFileSync(registry, JSON.stringify({ ...JSON.parse(original), entrypoint: 'codex-claude-uds-bridge' }));
    const codex = await f.request();
    await eventually(() => f.bridge.status().messages.find(row => row.id === codex)?.status === 'refused');
    // This sender passed socket and envelope authentication: the agent-kind check matters.
    expect(f.db.query<{ local_verified: number }, [string]>('SELECT local_verified FROM messages WHERE id=?').get(codex)?.local_verified).toBe(1);
    writeFileSync(registry, original);
    const waiting = await f.request();
    await eventually(() => f.bridge.status().compactions.find(row => row.id === waiting)?.status === 'waiting');
    controller.setCompactAccessMode('per-chat');
    await eventually(() => f.bridge.status().compactions.find(row => row.id === waiting)?.status === 'refused');
    expect(f.desktop.compactions).toHaveLength(0);
    controller.setCompactAccessMode('all-claude');
    f.db.run('DELETE FROM peer_guard');
    f.desktop.setState('idle');
    const allowed = await f.request();
    await eventually(() => f.bridge.status().compactions.find(row => row.id === allowed)?.status === 'submitted', 5500);
    expect(f.desktop.compactions).toHaveLength(1);
    f.desktop.completeCompaction();
    await eventually(() => f.bridge.status().compactions.find(row => row.id === allowed)?.status === 'completed');
    expect(f.bridge.status().compactAccess).toEqual([]);
  } finally { await controller.close(); await f.close(); }
}, 13000);

test('full trust leaves inbox refusal and native permission mismatch in force', async () => {
  const f = await compactFixture();
  try {
    f.bridge.setCompactAccessMode('all-claude');
    await f.bridge.setPolicy('refuse');
    const refused = await f.request();
    await eventually(() => f.bridge.status().messages.find(row => row.id === refused)?.status === 'refused');
    await f.bridge.setPolicy('default');
    const held = await f.request('[bridge:compact]', true, 'bypass');
    await eventually(() => f.bridge.status().messages.find(row => row.id === held)?.status === 'held');
    expect(f.bridge.status().compactions).toHaveLength(0);
    expect(f.desktop.compactions).toHaveLength(0);
  } finally { await f.close(); }
});
