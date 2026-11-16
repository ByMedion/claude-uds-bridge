# Claude-requested context compaction

Compact is disabled by default. Choose `bridge-compact-access` from the `/` skill menu (or invoke `$bridge-compact-access`) to open the human settings form immediately. It is a short model-invoked skill, not a native command handler. You can also call `compact_access` directly to choose one setting in the human dialog; cancel changes nothing.

- **Allow / Revoke in this chat** changes an individual Claude session grant. Grants survive receiver restart and stay in this thread's database. Another chat or fork starts without individual grants. Inactive sessions can still be revoked.
- **Full trust** allows any authenticated local Claude session to request compact in every active Codex chat in this CODEX_HOME profile, including future chats with a receiver. It applies to receivers 0.2.10 or later; update older receivers before expecting them to use it.
- **Use individual chat grants** disables full trust across the profile and restores the individually stored grants. It does not erase them.

The shared setting is `plugin-state/claude-uds-bridge/compact-policy.json` under CODEX_HOME. The human dialog writes it atomically with mode 0600 in the private state directory. Receivers read it at admission and on every waiting poll, so enabling/revoking it takes effect without restarting updated receivers. Missing settings mean per-chat mode; malformed/untrusted settings fail closed. The setting does not start absent receivers or discover blank chats. Peer text and tool arguments cannot grant either kind of access.

Claude uses its existing native `SendMessage` with exactly this standalone text:

```text
[bridge:compact]
```

This is a dedicated bridge operation. Ordinary `/compact` text and messages with additional prose remain peer input. The request must arrive over an authenticated peer socket with a current registry/process identity and a native envelope bound to its address. `from-session` is an opaque native label; Claude Desktop can use `local_<id>` rather than its registry UUID. JSON trust flags grant nothing.

## Execution and completion

The bridge applies the existing inbox/permission policy, duplicate/hop/rate checks and the selected compact-access policy. Full trust changes only the compact grant check: it never grants ordinary-message or Codex execution permissions, includes no Codex peer, and still requires socket authentication. A permission mismatch can hold the request for the normal human review. Approval of that one held request does not grant another peer or chat compact access. Explicit hold/refuse or revocation before dispatch stops the operation.

One request can wait at a time, for at most ten minutes. `status.compactions[].reason` reports the current waiting reason, including recipient_busy, unread_input, compaction_running, permissions_unknown, quiet_period or native_state_unavailable. It waits for known native permissions, no in-progress compaction, consumed bridge input and an idle period of at least one second. A fresh snapshot on the same owner connection is checked again immediately before native dispatch. While native compaction is submitted, subsequent bridge text waits rather than steering into the compaction task.

The native Desktop operation is `thread-follower-compact-thread` version 1; app-server uses `thread/compact/start`. Their successful RPC response means **submitted**, not completed. The bridge reports completed only after one new manual `contextCompaction` item is explicitly complete and the native runtime is idle. Stream completion uses completed/completedItemIds, while canonical Desktop history uses a positive finite completedAtMs timestamp; a completed turn alone is insufficient. Several possible completions, a lost native acknowledgement, a restarted receiver after dispatch or an elapsed execution deadline produce unknown rather than an invented completion. The native operation is never automatically resubmitted.

`compact_status` reports `waiting` (accepted, with its initial blocker and deadline) and `submitted` (native admission, not completion), at most once each per request, including across receiver restarts. The current waiting reason remains available in status; intermediate changes do not generate additional messages. Ordinary Claude SendMessage transport success alone does not prove that the bridge accepted or executed compact.

A guard-admitted duplicate from an authenticated, granted sender receives a `compact_result/refused` reply explaining compact_already_pending. It includes `pendingRequestId` when the pending operation belongs to that same sender. Wait for that original request; no second native operation is scheduled. Immediate repeated bodies remain subject to the unchanged 30-second duplicate guard and receive only its control receipt. Ungranted or unauthenticated requests do not start an ordinary notification turn.

A final `compact_result` message includes the original request message ID and status (`completed`, `refused`, `expired`, or `unknown`). Claude must wait for completed before assigning the next job in that chat. For unknown, inspect status rather than sending another compact request. A refused unauthenticated/ungranted request receives a refusal receipt; it does not start an unsolicited model turn in Claude. Notifications themselves remain subject to transport failure and sender limits.

`status.compactions` retains recent operation states/reasons; `status.compactAccess` lists individual Claude session grants; `status.compactAccessMode` is per-chat or all-claude (profile-wide). `list_sessions.supportsCompactRequests` advertises protocol support, not permission. The automatically attached guide is revision 5, so an existing Claude session receives the new usage instructions on its next ordinary authorized bridge message.

## Budget and lifecycle

Compact does not create a human input or renew the 100-send allowance. The two optional progress messages and explanatory duplicate replies consume ordinary send allowance; they leave at least one free send for a final result and are skipped near the limit. They may be lost to transport errors. An ordinary send from another process can still consume remaining allowance before dispatch. State updates never prove notification delivery or reading. At native dispatch the bridge reserves one ordinary outgoing send for its result notification. If no allowance remains, native compaction is refused. An uncertain result/notification stays charged, and a definite pre-write refusal returns the reservation once. This includes generated result messages in the existing outgoing-message budget; waiting without dispatch does not reserve the final result slot; any progress already sent is still charged.

SessionEnd cancels a waiting request. Receiver restart can resume a waiting request with its original deadline, but a request already dispatched becomes unknown and is not resent. Held-input deadlines, permissions, the compaction grant, input mappings and message budget are not reset by context compaction or its idempotent SessionStart hook.

## Native API limitation

The native compact endpoint can replace an active turn and has **no atomic idle-only or expected-turn condition**. The bridge waits for idle, uses a quiet period and rechecks immediately before dispatch, but cannot make a guarantee against a human or another client starting a turn in the final native dispatch window. Coordinate compaction between tasks, and do not submit new work while waiting for its result. This is a native API limitation, not a reason to interrupt an active job on purpose.

Tests use private sockets, SQLite and synthetic peers for access isolation, human grant/cancel, authentication, hold/release, idle waiting, fresh permission changes, budget exhaustion, revocation, expiry, SessionEnd, lost acknowledgements and receiver restart. The native harness additionally compacts a real Codex app-server with a local model stub and checks completion evidence without resetting the send allowance. It does not compact a real user's conversation or contact a real Claude session.
