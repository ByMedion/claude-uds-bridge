import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Bridge } from './bridge';
import { withAppServer } from './app-server';
import type { Target } from './codex';
import { discoverTarget, readCodexContext, type CodexContext } from './codex';

const hookSchema = z.object({ eventName: z.string(), enabled: z.boolean(), trustStatus: z.string(),
  sourcePath: z.string(), pluginId: z.string().nullable(), currentHash: z.string().min(1),
  handlerType: z.string(), server: z.string().optional(), tool: z.string().optional() });
const hooksSchema = z.object({ data: z.array(z.object({ cwd: z.string(), hooks: z.array(hookSchema),
  errors: z.array(z.unknown()).default([]) })) });

export class RecoveryRefused extends Error {
  constructor(readonly reason: string, message: string) { super(`${reason}: ${message}`); }
}

// This subprocess performs initialize and hooks/list only. In Desktop there is no
// hooks reader on the exposed follower IPC; the official CLI resolves fresh cwd
// configuration, including plugin content fingerprints, without loading a thread.
export async function configuredHooks(cwd: string, codexHome: string, binary = Bun.which('codex')) {
  if (!binary) throw new RecoveryRefused('hook_context_unavailable', 'Codex executable is unavailable');
  const child = spawn(binary, ['app-server'], { cwd, env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let next = 0, received = 0;
  const fail = (error: Error) => { for (const p of pending.values()) p.reject(error); pending.clear(); };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  child.on('exit', () => fail(new Error('Read-only hook reader exited')));
  child.stderr.resume(); // Never forward profile paths, credentials, or unrelated diagnostics.
  lines.on('line', line => {
    received += Buffer.byteLength(line);
    if (received > 8 * 1024 * 1024) { fail(new Error('Hook reader response too large')); child.kill(); return; }
    try {
      const packet = JSON.parse(line);
      const p = pending.get(packet.id);
      if (!p) return;
      pending.delete(packet.id);
      if (packet.error) p.reject(new Error('Codex refused the read-only hooks query'));
      else p.resolve(packet.result);
    } catch { fail(new Error('Invalid hook reader response')); }
  });
  const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const timeout = setTimeout(() => { fail(new Error('Read-only hook query timed out')); child.kill(); }, 10000);
  try {
    await request('initialize', { clientInfo: { name: 'claude_uds_bridge_recovery', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    return hooksSchema.parse(await request('hooks/list', { cwds: [cwd] }));
  } finally { clearTimeout(timeout); child.stdin.end(); child.kill(); lines.close(); }
}

export function requireTrustedHook(result: unknown, cwd: string, pluginRoot: string, scope: 'cwd' | 'thread' = 'cwd') {
  const parsed = hooksSchema.parse(result);
  const expected = realpathSync(join(pluginRoot, 'hooks/hooks.json'));
  const entries = parsed.data.filter(entry => realpathSync(entry.cwd) === realpathSync(cwd));
  if (entries.length !== 1 || entries[0]!.errors.length) throw new RecoveryRefused('hook_context_unavailable', 'Hook discovery did not resolve this directory');
  const matches = entries[0]!.hooks.filter(hook => hook.eventName === 'sessionStart'
    && hook.pluginId === 'claude-uds-bridge@leonkohli' && hook.handlerType === 'mcpTool'
    && hook.server === 'claude_uds_bridge' && hook.tool === 'session_start'
    && realpathSync(hook.sourcePath) === expected);
  if (matches.length !== 1) throw new RecoveryRefused('hook_context_unavailable', 'The current plugin SessionStart hook was not found');
  const hook = matches[0]!;
  if (!hook.enabled || !['trusted', 'managed'].includes(hook.trustStatus)) {
    throw new RecoveryRefused('hook_review_required', 'Review/enable the current plugin hook in Codex; recovery does not change trust');
  }
  return { currentHash: hook.currentHash, scope };
}

type RecoveryDependencies = {
  context: typeof readCodexContext;
  hooks: (cwd: string, codexHome: string, target: Target, threadId: string) => Promise<unknown>;
  target: typeof discoverTarget;
};

export async function prepareRecovery(bridge: Bridge, pluginRoot: string, codexHome: string,
  deps: RecoveryDependencies = { context: readCodexContext, hooks: (cwd, home, target, id) => target.kind === 'app-server'
    ? withAppServer(target.path, id, server => server.hooks()) : configuredHooks(cwd, home), target: discoverTarget }) {
  const before = bridge.lifecycle();
  const target = await deps.target(bridge.ipcPath, bridge.threadId);
  const context = await deps.context(target, bridge.threadId);
  const validate = (value: CodexContext) => {
    if (value.runtime.mode === 'unknown' || value.runtime.status === 'unknown') {
      throw new RecoveryRefused('context_unavailable', 'Current Codex runtime/permissions are not known');
    }
    // A cwd-only hook query cannot attest thread-specific execution environments.
    if (target.kind === 'desktop' && value.hasExecutionEnvironments) throw new RecoveryRefused('hook_context_unavailable', 'Thread-specific environments require a host hook reader');
    return realpathSync(value.cwd);
  };
  const cwd = validate(context);
  const trust = requireTrustedHook(await deps.hooks(cwd, codexHome, target, bridge.threadId), cwd, pluginRoot, target.kind === 'app-server' ? 'thread' : 'cwd');
  const fresh = await deps.context(target, bridge.threadId);
  if (validate(fresh) !== cwd || fresh.owner !== context.owner) throw new RecoveryRefused('context_mismatch', 'Thread owner or directory changed during recovery');
  const generation = bridge.activateRecovery(before, cwd);
  bridge.setTarget(target);
  return { cwd, generation, trust, owner: context.owner };
}
