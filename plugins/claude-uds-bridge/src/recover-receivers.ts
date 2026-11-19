import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Bridge } from './bridge';
import { uuid } from './claude';
import { discoverTarget, readCodexContext } from './codex';
import { recoverCurrentReceiver } from './receiver-upgrade';
import { version } from './version';

const usage = 'Usage: bun PATH_TO_PLUGIN/dist/recover-receivers.js --cwd ABSOLUTE_CHECKOUT LOADED_THREAD_ID [LOADED_THREAD_ID ...]';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
  const [flag, directory, ...ids] = args;
  if (flag !== '--cwd' || !directory || !isAbsolute(directory) || !ids.length
    || ids.some(id => !uuid.safeParse(id).success) || new Set(ids).size !== ids.length) throw new Error(usage);
  const cwd = realpathSync(directory);
  if (!statSync(cwd).isDirectory()) throw new Error('Expected a checkout directory');

  const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const ipcPath = join(codexHome, 'ipc', 'ipc.sock');
  const stateDir = join(codexHome, 'plugin-state', 'claude-uds-bridge');
  const installed = realpathSync(join(import.meta.dir, '..'));
  const hook = join(installed, 'dist', 'hook.js');
  if (!statSync(hook).isFile()) throw new Error('Installed SessionStart bundle not found');

  const preflight = async (threadId: string) => {
    const target = await discoverTarget(ipcPath, threadId);
    const native = await readCodexContext(target, threadId);
    if (realpathSync(native.cwd) !== cwd) throw new Error('Native chat directory does not match --cwd');
    if (native.runtime.mode === 'unknown' || native.runtime.status === 'unknown') {
      throw new Error('Native chat state or permissions are unknown');
    }
    return target;
  };

  const first = ids[0]!;
  let firstTarget;
  try { firstTarget = await preflight(first); }
  catch (error) {
    console.log(JSON.stringify({ version,
      preflight: { threadId: first, error: message(error) }, notAttempted: ids }));
    process.exitCode = 1;
    return;
  }

  const start = async (threadId: string, verifiedCwd: string, generation: string, upgradeToken?: string) => {
    if (realpathSync(verifiedCwd) !== cwd) throw new Error('Native chat moved to another directory during recovery');
    const child = Bun.spawn([process.execPath, hook], {
      cwd, stdin: 'pipe', stdout: 'ignore', stderr: 'pipe',
      env: { ...process.env, CODEX_THREAD_ID: undefined, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: configDir },
    });
    child.stdin.write(JSON.stringify({ session_id: threadId, cwd: verifiedCwd, hook_event_name: 'ReceiverRecover',
      generation, upgrade_token: upgradeToken }));
    child.stdin.end();
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(error.trim() || 'Installed recovery hook failed');
  };

  const results = [];
  for (const threadId of ids) {
    let bridge: Bridge | undefined;
    try {
      const target = threadId === first ? firstTarget : await preflight(threadId);
      bridge = new Bridge(threadId, configDir, stateDir, ipcPath);
      const before = bridge.status();
      const saved = bridge.target();
      if (before.replyAddress && (saved.kind !== target.kind || saved.path !== target.path)) {
        throw new Error('The live receiver uses a different native transport; inspect its status');
      }
      const outcome = await recoverCurrentReceiver(bridge, installed, codexHome, start);
      const after = bridge.status();
      const ready = !!after.replyAddress && after.receiverVersion === version && !after.receiverStart?.error;
      results.push({ threadId, phase: outcome.phase, before: before.receiverVersion,
        receiverVersion: after.receiverVersion, ready, blockers: 'blockers' in outcome ? outcome.blockers : [] });
      if (!ready) process.exitCode = 1;
    } catch (error) {
      process.exitCode = 1;
      results.push({ threadId, ready: false, error: message(error) });
    } finally { await bridge?.close(); }
  }
  console.log(JSON.stringify({ version, results }));
}

if (import.meta.main) main().catch(error => {
  console.error(message(error));
  process.exitCode = 1;
});
