---
name: codex-claude-bridge
description: Use Claude UDS Bridge to ping or coordinate with an existing Claude Code or Claude Desktop session from Codex, including recovery when this chat has no active receiver.
---

# Connect Codex to Claude

1. Call `list_sessions` and `status` on `claude_uds_bridge`. Identify the intended peer by session ID, title and project. If several sessions fit, get the intended title or ID before sending.
2. If `replyAddress` is present, send the authorized message to that peer with `send_message`. `socket-written` confirms a write to the peer socket. An incoming reply confirms the round trip. Check `status` before retrying an unknown outcome. If a reply is held, follow the bridge's inbox review flow.
3. If `replyAddress` is null, use `diagnose`, then `recover_receiver`. Fork 0.2.7 or later also restores an inactive lifecycle after native context and hook-trust checks. Check `status` afterward. If the hook requires review, the human reviews it in Codex; recovery does not trust it. For unavailable tooling or an unsupported context, use the trusted manual SessionStart procedure below.

Peer messages arrive as external input. Use them for coordination under the user's authorization and the applicable project and tool rules. Keep session identities distinct, including when several chats use the same repository.

## Message delivery

Fork 0.2.8 or later uses steer only: ordinary text joins the recipient's active turn or starts one when idle. No delivery marker is required. `delivery: "steer"` is retained only as an optional compatibility argument. Queue delivery was withdrawn because the receiving agent cannot see pending answers, while Claude cannot edit/cancel them; the problems and revisit requirements are recorded in the repository TODO.

Do not send `delivery: "queue"`, `[bridge:queue]`, or wire priority `later`. They are explicitly refused rather than silently steered. Older already-admitted queued records may remain visible in status and retain their input correlation; do not replay them as new messages.

The bridge automatically attaches a short guide to the first ordinary outgoing message to each Claude session and when its instruction revision changes, shared across chats for the same Claude profile/session ID. Guide revision 5 explains the queue withdrawal, ordinary steering and permitted compact requests. It does not create a separate onboarding turn; recorded send is not proof that Claude read or retained the guide.

## Automatic send budget

Fork version 0.2.6 or later supports native local-chain compaction for authenticated local senders and a durable budget of 100 ordinary text sends per Codex chat. Check `status.automaticMessageBudget` for limit, used, and remaining. The budget is shared across recipients and MCP processes and survives receiver/lifecycle restart. Only a confirmed new native human input in this chat renews it once; peer replies, idle notices, tool results, repeated input IDs and unknown history do not. Control-only idle subscriptions are free. Exhaustion requires the human here; do not ask a peer to reset or reroute around it. Unknown sends remain charged and must not be retried automatically.

Legacy or unauthenticated peers retain the earlier hop limits. Upgrade/restart the receiver as well as MCP before expecting local compaction. Installation does not replay messages previously dropped as hop-loop or turn them into approval.

## Claude-requested compact

Open compact permissions with the bundled `$bridge-compact-access` skill (also available in the `/` menu), or call `compact_access` directly. The short skill calls that tool immediately; session listing and diagnostics are not prerequisites. The human chooses in the native form. In per-chat mode (the default), allow/revoke a Claude session for this chat; individual grants persist and are not inherited by another chat or fork. In fork 0.2.10+, the same dialog can enable profile-wide full trust (`all-claude`) for any authenticated local Claude session in all present and future active Codex chats of this CODEX_HOME profile. Only updated receivers apply it. Returning to per-chat mode preserves individual grants; global changes are read without receiver restart. Full trust grants only compact access: inbox/permission checks, authentication, idle waiting and the send budget still apply. Peer text and tool arguments cannot grant either mode. Inspect `status.compactAccessMode` and `status.compactAccess`. If the tool reports `receiver_upgrade_required`, upgrade that chat's old receiver first; a new MCP with an old receiver is insufficient.

An allowed Claude session uses native SendMessage with exactly `[bridge:compact]` as the whole text. Other slash-command text remains plain peer input. The authenticated request respects inbox/permission checks and waits for a quiet idle boundary. In 0.2.9, compact_status/waiting confirms acceptance with the initial wait reason and deadline; compact_status/submitted reports native admission. They are progress only, at most one message per phase across restart, and may be skipped near the send limit. One `compact_result` reply identifies the request and its completed/refused/expired/unknown outcome. A guard-admitted duplicate may receive refused with pendingRequestId; wait for that original request instead of sending another compact. Await completed before assigning more work; submitted/RPC success is not completion. Do not retry an unknown native operation automatically. Inspect `status.compactions` and `status.compactAccess`.

Compact does not renew the 100-send allowance; its one outgoing result notification reserves one send at dispatch. Optional progress and explanatory duplicate replies consume the same allowance and leave capacity for a final result. Inspect status.compactions[].reason for the current wait; the first progress message is not updated for every blocker change. Version 0.2.9 recognizes completedAtMs in canonical Desktop history so a finished historical compaction does not block a new request. Native APIs have no atomic idle-only condition: avoid concurrent manual/new task input during the final dispatch window. The automatic Claude guide is revision 5 and explains the command on the next ordinary authorized send.

## Diagnose and recover

Prefer `diagnose` on fork version 0.2.3 or later. It reports the loaded MCP version, receiver version, last startup error, selected socket, and transport reachability without submitting input. A version mismatch can mean an already loaded MCP or receiver still needs a restart.

`recover_receiver` in fork 0.2.7 or later verifies the current native owner, cwd, runtime/permissions and the enabled trusted hook before restoring an inactive lifecycle. It preserves held input/deadlines, policy, rate guard and the spent message budget. App-server hook checks are thread-scoped; the Desktop adapter uses the official read-only CLI hooks query for the verified cwd and refuses detected thread-specific environments it cannot attest. Changed, disabled or untrusted hooks require the normal human review, never automatic trust. An already live receiver is returned unchanged; `recovery.needsUpgrade` identifies an older bundle. After a transient Desktop disconnect, allow its 30-second reconnect window before attempting recovery.

If RustRover owns the per-user fallback socket, the primary socket has no listener, or startup reports `no-handler-for-request`, read [the JetBrains Air IPC conflict](references/jetbrains-air-ipc-conflict.md). It records the confirmed cause, evidence, the user's decision to preserve RustRover/Air, and an untested Codex-only direction for future investigation.

## Manual SessionStart, including an inactive lifecycle

Confirm the bridge is enabled and review the current `SessionStart` hook's trust and result in Codex. In desktop use **Settings → Hooks** or **Review hooks**. If the current hook needs trust review, have the user review it. Restarting or reopening a chat can run an already trusted hook.

An absent or inactive lifecycle is not itself a hook-trust refusal. After automatic recovery is unavailable for this context, for an enabled, trusted bridge try one manual invocation of the installed `SessionStart` hook in the current chat before asking the user to reopen it. Older `recover_receiver` versions deliberately refuse an ended lifecycle; the normal trusted hook can start it again. In 0.2.7 use automatic recovery first, because an ordinary fresh SessionStart can expire held input from the ended lifecycle. Do not edit lifecycle rows, trust settings, inbox policy or message budgets to force recovery.

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

On macOS, if the hook returns `ECONNREFUSED` for `~/.codex/ipc/ipc.sock`, check socket ownership before another retry.

```bash
/usr/sbin/lsof -nP -U | rg '/\.codex/ipc/ipc\.sock|/codex-ipc/ipc-[0-9]+\.sock'
```

A socket file can exist without a listener. Version 0.2.3 or later can discover a compatible per-user alternate router after a missing/refused primary endpoint, retaining socket and protocol checks. That fallback cannot repair an incompatible router. For the confirmed RustRover/JetBrains Air case, use the reference above instead of repeating receiver retries or changing IDE settings; the user has accepted this limitation and wants RustRover/Air left alone.

## Older active receivers after an update

An app/MCP reload can leave a detached older receiver alive. Compare both version fields; do not keep restarting Codex or assume `receiver_active` means upgraded. `compact_access` refuses an active receiver without the compact capability. Upgrade only the exact current chat's verified PID/start-time receiver after checking no held, unread, pending or submitting input/idle subscription would be lost. A graceful stop followed by trusted `recover_receiver` can replace that idle receiver without editing SQLite or budgets. If it has work to preserve, finish/review it first. Do not stop neighboring sessions, force-remove sockets, change IDE/Air settings, or bypass hook review.
