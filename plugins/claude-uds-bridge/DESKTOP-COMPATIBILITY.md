# Desktop IPC compatibility

Checked on 2026-11-15 against the installed official macOS app, version 26.1111.21308, build 27194. These checks establish behavior for this build, not a public compatibility promise.

## What the stream version means

`packet.version` is the compatibility version of one Desktop IPC method, separate from MCP's protocol version. Static reading of the installed app's `app.asar` found this method table:

| Method | Version |
| --- | --- |
| `thread-stream-state-changed` | 13 |
| `thread-owner-discovery` | 1 |
| `thread-follower-start-turn` | 2 |
| `thread-follower-steer-turn` | 1 |
| `thread-follower-set-queued-follow-ups-state` | 3 |
| `thread-follower-remove-queued-message` | 1 |

The adapter accepts stream versions 11 and 13 and retains the existing owner, conversation ID, payload, socket, and permission checks. Passing a version guard alone does not establish semantic compatibility. Runtime/permission observation and receiver startup were verified on the real app; tests exercise supported and rejected versions, malformed permissions, input attribution, and uncertain acknowledgements.

The public [openai/codex source](https://github.com/openai/codex/tree/b7056f3408522716b6643c8b3e23ce7c9b53b041) was searched at that SHA. Its IDE-context IPC client mentions the stream in a test, but the Desktop stream implementation and 11-to-13 schema history were not present. The checked public changelog and latest 40 GitHub releases did not explain the version bump. The exact upstream schema delta remains unknown.

## Recovery boundaries

Discovery probes only the primary Desktop endpoint and the known per-user legacy endpoint. It tries the legacy endpoint only after a missing/refused primary socket. Incompatible protocols and unsafe ownership fail closed. This can recover a compatible alternate router, but cannot repair an incompatible IDE/Desktop router or a missing Desktop owner.

`recover_receiver` reuses an active lifecycle recorded by `SessionStart`; it never grants hook trust, changes inbox policy, resumes another chat, or replays an uncertain delivery. Held-message deadlines remain in force. A transient Desktop disconnect suspends permission-based acceptance until a fresh snapshot arrives.
