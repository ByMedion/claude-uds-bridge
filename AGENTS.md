# Working on Claude UDS Bridge

## Scope and entry points

- The package lives in `plugins/claude-uds-bridge`; developer scripts live in `scripts/`. Install dependencies with `bun install --frozen-lockfile` in the package directory.
- `src/server.ts` defines MCP tools; `src/bridge.ts` owns persisted state and delivery; `src/hook.ts`, `src/recovery.ts` and `src/receiver-upgrade.ts` handle receiver lifecycle.
- Read the relevant reference only: `DESKTOP-COMPATIBILITY.md` for Desktop IPC, `COMPACTION.md` for compact, `RECEIVER-RECOVERY.md` for lifecycle. These are inside the package.
- Keep a small agreed task distinct from a new runtime feature. Report added scope before investing in it; avoid rereading every reference for a narrow edit.

## Checks

- Start with `git status --short --branch`; preserve unrelated edits and stage only your paths.
- Run scripts from any cwd by passing their path; they locate the repository themselves. Do not assume the chat cwd is the package directory. Use git -C <repo> for ad-hoc Git commands from outside it.
- Docs/skills: `bun scripts/check.ts docs` checks whitespace, matching manifests and packaged skill metadata/links.
- Runtime change: `bun scripts/check.ts focused test/NAME.test.ts ...` runs type checks and explicitly selected existing tests.
- Release: `bun scripts/check.ts release` runs the full suite once, compares fresh temporary bundles with `dist`, then tests the compiled MCP. Add `--native` for the real Codex app-server/local-model-stub harness.
- Repeat broad checks only after changes or failures that justify them. For text-only changes, do not automatically run the runtime suite.
- A changed source file must ship with matching `dist/server.js` and `dist/hook.js`; stale committed bundles install successfully but execute old code.

## Mistakes to avoid

- Native cwd can be canonical `/private/tmp` while the fixture used `/tmp`: compare canonical paths, not their spelling.
- MCP text results often contain encoded JSON. Decode the text block before checking fields; searching JSON.stringify(result) can test escaping instead of behavior.
- Compiled MCP/hook test entrypoints must be absolute. The check script sets both UDS_MCP_TEST_ENTRYPOINT and UDS_HOOK_TEST_ENTRYPOINT.
- Desktop packet.version is per-method IPC, not the plugin or MCP version. Reject unknown stream versions; do not expand an allowlist without checking the actual protocol.
- A loaded MCP and its detached receiver can have different versions. App restart or successful installation is not proof of receiver upgrade; inspect status and use diagnose/recover_receiver in the affected chat.
- For several loaded local chats in one checkout, use `bun scripts/recover-receivers.ts --cwd ABSOLUTE_CHECKOUT THREAD_ID ...` after selecting their IDs with native Codex tools. A shared IPC preflight failure is enough to stop; do not repeat the batch until the transport changes.
- A saved compact grant and native RPC admission are not completed compaction. Use the readiness/progress/final-result contract in COMPACTION.md.
- Synthetic/local-model checks do not establish a real Claude round trip. Keep real busy chats out of test fixtures; use native Codex tools for Codex-to-Codex coordination.
- Diagnostic exports use an explicit metadata allowlist. Never dump message bodies, config credentials or SELECT * from state tables containing secrets.
- Do not revive version-specific PID/activation scripts: receiver recovery now lives in the plugin. Follow blockers and human hook review rather than editing trust, policy or budgets.

## Versioning and handoff

- This fork uses `develop`; create a PR only when requested. Keep each task in its own logical commit and the version bump in a separate commit.
- Use `bun scripts/bump-version.ts patch --dry-run`, then the same command without --dry-run when preparing a release. It updates both manifests and bundles; it does not commit, push or install.
- Before committing, inspect staged content and run `git diff --cached --check`. Do not include unrelated worktree changes.
- After normal plugin installation, run `bun scripts/verify-installed.ts` (or pass --installed-root from the installer). `--host` additionally reads hook metadata for this repository cwd; it grants no trust.
- Report exactly which checks ran/skipped, the committed and installed version, and any remaining receiver activation. Keep machine-specific IDE preferences in local guidance.
