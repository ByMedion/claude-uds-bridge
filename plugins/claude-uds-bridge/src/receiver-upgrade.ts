import { realpathSync } from 'node:fs';
import { Bridge } from './bridge';
import { peers, processStart } from './claude';
import { prepareRecovery } from './recovery';
import { readCodexContext } from './codex';
import { version } from './version';

function currentReceiver(bridge: Bridge) {
  const matches = peers(bridge.configDir).filter(p => p.sessionId === bridge.threadId && p.entrypoint === 'codex-claude-uds-bridge');
  if (matches.length > 1) throw new Error('receiver_ambiguous: multiple current-chat receivers');
  return matches[0];
}

const defaults = {
  current: currentReceiver,
  identity: processStart,
  stop: (pid: number) => { process.kill(pid, 'SIGTERM'); },
  sleep: (ms: number) => Bun.sleep(ms),
  prepare: prepareRecovery,
  context: readCodexContext,
  refresh: async (bridge: Bridge) => { await bridge.syncInputs(); },
};

type Start = (threadId: string, cwd: string, generation: string, upgradeToken?: string) => Promise<void>;

// The MCP caller supplies no target/PID/path. All process identity and lifecycle
// checks are bound to the current chat. A legacy receiver has no cooperative
// pause API: replace only when it has no work to lose, and coordinate the gap
// between peer messages. A socket write during replacement is not an ACK.
export async function recoverCurrentReceiver(bridge: Bridge, pluginRoot: string, codexHome: string, start: Start, deps = defaults) {
  const before = deps.current(bridge);
  if (before && bridge.lifecycle()?.active !== 1) throw new Error('session_ending: wait for the old receiver to stop');
  if (before?.bridgeVersion === version) return { phase: 'receiver_active', needsUpgrade: false };
  if (!before) {
    if (bridge.receiverUpgradeActive()) throw new Error('receiver_upgrade_in_progress: wait for the current replacement');
    const prepared = await deps.prepare(bridge, pluginRoot, codexHome);
    await start(bridge.threadId, prepared.cwd, prepared.generation);
    return { phase: 'restored', trust: prepared.trust };
  }
  const installed = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
  const running = /^(\d+)\.(\d+)\.(\d+)$/.exec(before.bridgeVersion ?? '')?.slice(1).map(Number);
  if (!installed || !running) throw new Error('receiver_version_unknown: no automatic replacement of an unrecognized version');
  const firstDifference = installed.findIndex((n, i) => n !== running[i]);
  if (firstDifference < 0 || installed[firstDifference]! < running[firstDifference]!) {
    throw new Error('receiver_newer_than_mcp: refresh MCP instead of downgrading the receiver');
  }
  await deps.refresh(bridge);
  let blockers = bridge.receiverUpgradeBlockers();
  if (blockers.length) return { phase: 'upgrade_blocked', needsUpgrade: true, blockers,
    instruction: 'Finish or review this chat receiver work, then call recover_receiver again. No process was stopped.' };
  const token = bridge.claimReceiverUpgrade();
  try {
    const prepared = await deps.prepare(bridge, pluginRoot, codexHome);
    const verify = async () => {
      bridge.recoveryGeneration(prepared.generation, prepared.cwd);
      bridge.checkReceiverUpgrade(token);
      const fresh = await deps.context(bridge.target(), bridge.threadId);
      if (fresh.owner !== prepared.owner || realpathSync(fresh.cwd) !== prepared.cwd
        || fresh.runtime.mode === 'unknown' || fresh.runtime.status === 'unknown' || fresh.hasExecutionEnvironments && bridge.target().kind === 'desktop') {
        throw new Error('context_mismatch: owner, cwd or permissions changed during receiver upgrade');
      }
      const peer = deps.current(bridge), owner = bridge.receiverOwner();
      if (!peer || peer.pid !== before.pid || peer.procStart !== before.procStart || peer.sessionId !== bridge.threadId
        || !before.procStart || owner?.pid !== before.pid || owner.proc_start !== before.procStart) {
        throw new Error('receiver_changed: no receiver was stopped');
      }
      if (await deps.identity(before.pid) !== before.procStart) throw new Error('receiver_identity_changed: no receiver was stopped');
    };
    await verify();
    await deps.sleep(250);
    await deps.refresh(bridge);
    await verify();
    blockers = bridge.receiverUpgradeBlockers();
    if (blockers.length) return { phase: 'upgrade_blocked', needsUpgrade: true, blockers,
      instruction: 'Receiver work arrived during the upgrade preflight. Nothing stopped; finish it first.' };
    bridge.recoveryGeneration(prepared.generation, prepared.cwd);
    bridge.checkReceiverUpgrade(token);
    const owner = bridge.receiverOwner();
    if (owner?.pid !== before.pid || owner.proc_start !== before.procStart) throw new Error('receiver_changed: no process stopped');
    deps.stop(before.pid);
    const deadline = Date.now() + 5000;
    while (deps.current(bridge)?.pid === before.pid || bridge.receiverOwner()?.pid === before.pid) {
      if (Date.now() >= deadline) throw new Error('receiver_stop_unknown: old receiver did not withdraw; no takeover attempted');
      await deps.sleep(25);
    }
    bridge.recoveryGeneration(prepared.generation, prepared.cwd);
    bridge.checkReceiverUpgrade(token);
    const fresh = await deps.context(bridge.target(), bridge.threadId);
    if (fresh.owner !== prepared.owner || realpathSync(fresh.cwd) !== prepared.cwd
      || fresh.runtime.mode === 'unknown' || fresh.runtime.status === 'unknown' || fresh.hasExecutionEnvironments && bridge.target().kind === 'desktop') {
      throw new Error('context_mismatch: old receiver stopped; inspect native context before recovery');
    }
    await start(bridge.threadId, prepared.cwd, prepared.generation, token);
    const current = deps.current(bridge);
    if (!current || current.bridgeVersion !== version) throw new Error('receiver_upgrade_unverified: inspect status before retrying');
    return { phase: 'upgraded', fromVersion: before.bridgeVersion ?? null, needsUpgrade: false, trust: prepared.trust };
  } finally { bridge.releaseReceiverUpgrade(token); }
}
