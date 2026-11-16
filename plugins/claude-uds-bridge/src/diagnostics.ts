import { z } from 'zod';
import { discoverTarget, readCodexRuntime, type Target } from './codex';

export async function diagnoseConnection(ipcPath: string, threadId: string, selected?: Target) {
  let target = selected;
  try {
    target ??= await discoverTarget(ipcPath, threadId);
    return { reachable: true as const, target, runtime: await readCodexRuntime(target, threadId) };
  } catch (error) {
    const message = error instanceof z.ZodError ? 'Desktop/app-server payload did not match the supported schema'
      : error instanceof Error ? error.message : 'Unknown transport failure';
    const code = error instanceof Error && 'code' in error ? String(error.code) : null;
    const advice = message.includes('no-handler-for-request') ? 'The selected router lacks the required Desktop method. Inspect listener ownership and IPC-TROUBLESHOOTING.md; do not stop another app or unlink its socket automatically.'
      : message.includes('Unsupported Desktop stream version') ? 'Update the bridge for this Desktop stream version. Unknown versions remain rejected.'
      : message.includes('initialize') && message.includes('timed out') ? 'The socket accepted a connection but did not complete the Desktop handshake. Inspect whether an IDE owns the router and consult IPC-TROUBLESHOOTING.md; coordinate any app restart with the human.'
      : code === 'ENOENT' || code === 'ECONNREFUSED' || message.includes('No reachable Desktop IPC socket') ? 'Check socket listeners and the trusted SessionStart hook; a socket file alone does not prove a live router.'
      : 'Inspect the transport error and hook result. Permissions and inbox policy have not been changed.';
    return { reachable: false as const, target: target ?? null, error: { code, message }, advice };
  }
}
