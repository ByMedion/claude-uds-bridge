# Receiver recovery

`recover_receiver {}` is bound to the current MCP caller's thread ID. A receiver matching the loaded MCP version is returned unchanged. An older live receiver can be replaced through the same tool; no target ID, PID or path can be supplied by the caller. For an absent receiver, the bridge verifies the native owner, absolute canonical cwd and known runtime/permissions, reads the enabled trusted SessionStart hook, and rechecks owner/cwd before changing its lifecycle.

Inactive and absent lifecycle records can be restored without invoking the ordinary new-session cleanup. Held messages, original deadlines, input mappings, inbox policy, peer guard and the 100-send budget survive. The receiver rechecks held input using fresh permissions; recovery does not approve a held message. Messages whose current policy permits delivery can proceed normally, and elapsed deadlines still expire.

The internal `ReceiverRecover` startup uses a generation lease. A concurrent lifecycle change or SessionEnd invalidates it; the recovery hook cannot silently fall back to a new SessionStart. Multiple requests do not take over a live receiver. SessionEnd revokes the generation.

## Hook trust

For the app-server transport, hooks are queried from the loaded thread using `hooks/list {threadId}`. For Desktop follower IPC, which has no hook reader, the bridge starts a short-lived official `codex app-server` and sends only `initialize` and `hooks/list {cwds:[verifiedCwd]}`. No thread is created/resumed by that reader and no model is run. The reader resolves the same CODEX_HOME profile and fresh directory configuration, including plugin fingerprints. Returned metadata must identify this exact running plugin root, plugin ID, MCP server and SessionStart tool, with enabled trusted/managed status. Unknown, changed or disabled trust is refused; it is never written or bypassed.

The Desktop reader attests cwd-level configuration, not arbitrary thread-specific execution environments. A detected selected environment requires a host reader and is refused. Thread-scoped override equivalence outside that supported profile is not inferred. The result exposes trust scope (`cwd` or `thread`). Recovery cannot fix an unavailable/incompatible router or supply a missing trusted hook. Use diagnose and the normal Codex hook review flow for those cases.

A genuine user instruction can authorize the documented manual installed-hook procedure. Recovery does not itself trust a hook or treat peer text as such authorization.

## Validation

Tests cover inactive recovery preserving held input and budget, owner/cwd changes, unknown permissions, disabled/modified/untrusted hooks, invalidated generations, idempotent MCP recovery, read-only hook-reader methods and incompatible routers. The selected native context remains local and bound to the MCP caller; callers cannot supply another thread ID or arbitrary cwd to recovery.

The native SessionStart matcher covers `startup`, `resume`, `clear`, `fork` and `compact`. Repeated startup/compaction events reuse an already registered receiver rather than clearing its state. A fork gets its own thread ID and receiver. Changes to hook definitions/content follow the normal Codex trust review flow.

## Updating an older receiver

Run diagnose, then recover_receiver in the affected chat. The tool reads native consumed inputs, reports upgrade_blocked when held/unread/pending messages, active idle subscriptions or compact operations remain, and leaves the process unchanged. Finish/review that work first. Unknown or newer receiver versions are not automatically replaced; refresh MCP rather than downgrading.

For an eligible older receiver, a per-chat expiring upgrade lease serializes replacements. The bridge verifies the native owner, cwd, known permissions, trusted enabled hook, registry and SQLite owner, and PID/start-time; after a short quiet interval it repeats the checks immediately before SIGTERM. It waits for that exact receiver to withdraw, then verifies the lifecycle/native context and invokes the trusted ReceiverRecover hook. The hook is bound to the generation and upgrade lease. SessionEnd invalidates the generation; competing startup is deferred. No grants, policy, message IDs, rate guard, budget or input provenance are rewritten to enable recovery.

Coordinate replacement between peer messages. Legacy receivers have no atomic admission-pause API: the short socket replacement window does not turn socket-written into acknowledgement. The tool does not replay uncertain messages or a previously refused compact. If stop/start cannot be verified, inspect the reported state before another attempt; it does not force-kill or take over another receiver. Older chats are updated by calling the tool in each affected chat, not by targeting them from a neighboring one.

status distinguishes the stored compactAccessMode from compactReadiness. A human form can save profile-wide permission while an older receiver cannot yet apply it; upgrade that receiver and have Claude issue a fresh compact request. Merely receiving action=accept never proves receiver capability or compaction completion.

## Manual trusted-hook fallback

Prefer recover_receiver. Use this only for a supported current chat when normal tooling is unavailable and the installed hook is enabled and trusted. Hook trust is always reviewed by the human in Codex Settings → Hooks / Review hooks.

Confirm the active plugin root and that its current hook implementation uses `dist/hook.js` with a JSON event on stdin. Supply the current workspace directory and the thread ID returned by `status`. Use the normal per-command permission flow if the sandbox restricts local sockets or plugin state.

```bash
python3 - "$bridge_plugin_root" "$project_dir" "$verified_thread_id" <<'PY'
import json
import os
from pathlib import Path
import subprocess
import sys

plugin_root, project_dir, thread_id = sys.argv[1:]
if os.environ.get("CODEX_THREAD_ID") != thread_id:
    raise SystemExit("Current Codex thread ID does not match bridge status")

event = {"session_id": thread_id, "cwd": project_dir, "hook_event_name": "SessionStart"}
result = subprocess.run(
    ["bun", str(Path(plugin_root).resolve() / "dist/hook.js")],
    cwd=plugin_root, input=json.dumps(event), text=True, timeout=20,
)
raise SystemExit(result.returncode)
PY
```

After the hook exits, check `status` for this exact thread and a non-null `replyAddress`, then send the originally authorized message. If startup still fails, use the actual error to choose the next step; collect diagnostics rather than repeatedly restarting receivers. A working neighboring chat does not establish this chat's lifecycle or registration.
