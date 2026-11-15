# TODO

## Revisit queue delivery

**Status: withdrawn in 0.2.8.** Reverted the queue delivery introduced by bb25ffa after practical use. Ordinary bridge messages use steer.

Observed problems:

- A message can remain in Codex's native queue while the receiving model does not know it exists or what it contains. Codex can therefore ask Claude a question whose answer is already waiting in that queue. Admission into the queue does not make the answer available to the active agent, so the mode does not reliably avoid interruptions or redundant coordination.
- Claude cannot edit or cancel an already queued message through the bridge. A pending answer can become stale while waiting, and the sender has no way to correct or withdraw it.

Before reconsidering the feature:

- Define how the recipient becomes aware of pending answers, and how duplicate questions are avoided without secretly turning queue delivery into steering.
- Give the sender listing/inspection, edit and cancellation operations with stable message IDs and explicit outcomes.
- Specify races between consumption, editing and cancellation, including unknown outcomes, while preserving user drafts, origin, inbox/permission checks and message budgets.
- Validate the resulting workflow in real orchestrator/executor use, not only native queue admission tests.

The rollback refuses new legacy queue requests rather than silently steering them. Already admitted records retain their history and input correlation; existing native queue contents are not automatically removed or replayed.
