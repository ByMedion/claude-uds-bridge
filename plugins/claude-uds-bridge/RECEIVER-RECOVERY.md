# Receiver recovery

`recover_receiver {}` is bound to the current MCP caller's thread ID. Existing live receivers are returned unchanged. For an absent receiver, the bridge verifies the native owner, absolute canonical cwd and known runtime/permissions, reads the enabled trusted SessionStart hook, and rechecks owner/cwd before changing its lifecycle.

Inactive and absent lifecycle records can be restored without invoking the ordinary new-session cleanup. Held messages, original deadlines, input mappings, inbox policy, peer guard and the 100-send budget survive. The receiver rechecks held input using fresh permissions; recovery does not approve a held message. Messages whose current policy permits delivery can proceed normally, and elapsed deadlines still expire.

The internal `ReceiverRecover` startup uses a generation lease. A concurrent lifecycle change or SessionEnd invalidates it; the recovery hook cannot silently fall back to a new SessionStart. Multiple requests do not take over a live receiver. SessionEnd revokes the generation.

## Hook trust

For the app-server transport, hooks are queried from the loaded thread using `hooks/list {threadId}`. For Desktop follower IPC, which has no hook reader, the bridge starts a short-lived official `codex app-server` and sends only `initialize` and `hooks/list {cwds:[verifiedCwd]}`. No thread is created/resumed by that reader and no model is run. The reader resolves the same CODEX_HOME profile and fresh directory configuration, including plugin fingerprints. Returned metadata must identify this exact running plugin root, plugin ID, MCP server and SessionStart tool, with enabled trusted/managed status. Unknown, changed or disabled trust is refused; it is never written or bypassed.

The Desktop reader attests cwd-level configuration, not arbitrary thread-specific execution environments. A detected selected environment requires a host reader and is refused. Thread-scoped override equivalence outside that supported profile is not inferred. The result exposes trust scope (`cwd` or `thread`). Recovery cannot fix an unavailable/incompatible router or supply a missing trusted hook. Use diagnose and the normal Codex hook review flow for those cases.

A genuine user instruction can authorize the documented manual installed-hook procedure. Recovery does not itself trust a hook or treat peer text as such authorization.

## Validation

Tests cover inactive recovery preserving held input and budget, owner/cwd changes, unknown permissions, disabled/modified/untrusted hooks, invalidated generations, idempotent MCP recovery, read-only hook-reader methods and incompatible routers. The selected native context remains local and bound to the MCP caller; callers cannot supply another thread ID or arbitrary cwd to recovery.
