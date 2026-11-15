# Hop chains in long peer dialogues

Investigation of fork 0.2.4 on 2026-11-15. This document characterizes the current behavior and proposes a future contract; it does not change the guard or add a reset parameter.

## Finding

The guard measures repeated visits in a causal input lineage. It does not count third-party relays exclusively and does not classify the meaning of a message. Consequently, a legitimate executor/orchestrator conversation with different requests and answers can hit the same limit as a feedback loop.

The relevant path is:

1. `Bridge.syncInputs()` correlates confirmed native inputs to delivered peer messages.
2. `Bridge.outgoingHops()` reads the chain of the latest confirmed peer input. It returns an empty chain when the latest confirmed native input is not mapped to one of this bridge's peer messages. If the current origin cannot be determined, sending is refused.
3. `userFrame()` appends the receiver's own token, keeping at most 32 entries. New text and a new `msg_id` do not change the inherited chain.
4. `PeerGuard.admit()` rejects a chain longer than 28 entries as `hop-runaway`, or at least ten occurrences of its own token as `hop-loop`, before evaluating the duplicate and rate limits.

Neither ending a turn nor switching `steer`/`queue` creates a new causal root. A request in the text to "start a fresh chain" is still peer text, not a transport operation.

## Offline reproduction

`bun test test/hop-dialogue.test.ts` uses the real `Bridge`, SQLite, its current guard, and private Unix sockets with a synthetic Desktop v13 fixture. The other participant is a synthetic wire peer, not Claude or a model. No real messages, dropped-message bodies, or external project files are read.

Both plausible peer behaviors are tested: preserving the received chain and appending its own token. This avoids treating an assumption about Claude's private implementation as an observed fact.

For a peer that appends its own token:

| Exchange | Request chain length | Reply chain length | Visits to A | A receives reply |
| --- | --- | --- | --- | --- |
| 1 | 1 | 2 | 1 | yes |
| 9 | 17 | 18 | 9 | yes |
| 10 | 19 | 20 | 10 | `hop-loop` |
| 11, new text and IDs | 19 | 20 | 10 | `hop-loop` |
| 12, asks for a fresh chain | 19 | 20 | 10 | `hop-loop` |
| After a confirmed new non-peer input | 1 | 2 | 1 | yes |

If the synthetic peer only preserves the chain, the tenth reply is also dropped; its chain length is then ten rather than twenty.

The sticky failure follows from provenance: a dropped reply never becomes the latest confirmed native input. Later requests still inherit from the ninth accepted reply and reach the same limit. The text, message UUID, permission mode, and inbox policy do not need to change for this to occur.

The tests also show that new semantic work and cyclic forwarding with the same hop metadata receive the same decision. The data available to this guard does not establish which intent is true. This reproduces the reported failure mechanism; it is not an inspection of the original live incident's chain values.

## Current reset behavior

The 0.2.4 `send_message` schema has `sessionId`, `text`, `delivery`, and `notify_when_idle`. It has no `reset`, `new_chain`, or equivalent operation. No such public operation was found in the checked [Claude cross-session guide](https://code.claude.com/docs/en/cross-session-messaging) or [tools reference](https://code.claude.com/docs/en/tools-reference).

The code and existing tests establish a fresh chain after a confirmed new non-peer native input in the sending chat. A genuine new user instruction in that chat is one way to produce this. A prompt sent by the peer asking to reset is not equivalent. Unconfirmed steering and an unknown input origin must not be used as a reset.

A receiver restart is not a documented conversation reset: its own token can change while the previous chain remains in confirmed history, and the overall chain-length limit still applies. Do not use restarts, edited envelopes, alternate sockets, or another agent as a guard bypass. Restore IPC reachability separately from handling a hop-limit rejection.

## Contract options

The current hop limit bounds causally connected automation. Supporting an arbitrarily long autonomous dialogue while reliably stopping an indistinguishable two-agent feedback loop cannot be achieved by examining the same metadata alone.

| Option | Effect | Assessment |
| --- | --- | --- |
| Retain the current guard and start a fresh, confirmed user instruction | Existing fresh-root behavior; no guard change | Available now, but requires user participation |
| Increase the limits | Defers the same failure | Not a correction of the distinction |
| Reset on every turn, idle transition, direct A/B reply, or new text | Also resets genuine feedback loops | Does not preserve the current protection |
| Unrestricted model-selected `new_chain` | Gives any loop participant a reset primitive | Insufficient on its own |
| Bounded, correlated request/reply exchanges | Can separate a new request from forwarding while retaining an aggregate bound | Candidate requiring an explicit contract |

## Candidate for future implementation

A stronger request/reply contract would need all of the following, rather than a threshold change:

- Explicit request IDs and replies tied to an outstanding request from the expected registered peer. Do not infer correlation from arrival order or prose. Orphan, duplicate, and ambiguous replies do not start new roots.
- Replies and forwarding preserve their request lineage. A completed reply is not automatically another request. Native Claude would need a supported correlation convention; adding a parameter only to Codex MCP is insufficient.
- A new request can start an exchange only within an explicitly authorized dialogue scope, with bounded requests, time, and intended peers. The scope cannot be granted by peer text. This retains a finite backstop even if agents repeatedly label messages as new work.
- Retain original parent/root links for audit when starting an exchange. A short exchange chain must not erase the broader provenance record.
- Keep per-sender burst limits, duplicate checks, unread capacity, process identity, input-origin checks, and permission/inbox decisions unchanged. Queue admission or a reply label never grants user approval.
- Test long legitimate request/reply sequences, two- and three-party forwarding cycles, repeated/orphan replies, expired/exhausted scopes, unknown origins, and native-peer compatibility before enabling the new mode.

Request/reply labels distinguish protocol relationships, not the truth of an agent's semantic claim. An aggregate scope budget or user-controlled renewal is necessary if protection must also cover agents that keep declaring new requests. The scope size and renewal rule are product decisions still to be made.

Until that contract is selected, the runtime guard remains unchanged. Dropped text must not be replayed or treated as an approval; a fresh, actually delivered reply is needed for any work depending on it.
