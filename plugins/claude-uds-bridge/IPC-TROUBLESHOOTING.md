# RustRover / JetBrains Air IPC conflict

## Confirmed context, 2026-11-15

Observed on macOS with Codex Desktop 26.1111.21308, build 27194, RustRover 2026.3, and Claude UDS Bridge 0.2.4. Recheck the actual endpoints and current application code after updates; these observations are not a permanent assertion about newer builds.

This is a collision of Unix domain socket endpoints, not a TCP port collision or an MCP protocol-version failure.

## Cause

The installed Codex app's `IpcRouterManager.getOrStartRouterEndpoint()` first tries the primary `$CODEX_HOME/ipc/ipc.sock` (normally `~/.codex/ipc/ipc.sock`). If that is unavailable, it can adopt an existing, same-user legacy endpoint at `os.tmpdir()/codex-ipc/ipc-<uid>.sock`. Its `canConnectToEndpoint()` check tests connection availability rather than a Desktop capability handshake before choosing that endpoint.

RustRover's bundled JetBrains Air component also opens that legacy endpoint. Its `CodexIdeContextIpcService` serves IDE-context requests; its `CodexIdeContextIpcProtocol` handles `ide-context` and rejects unsupported methods with `no-handler-for-request`. It is not the full Desktop router needed for the bridge's initialization and thread-owner discovery.

Consequently, a Codex-only restart while RustRover retains the legacy listener can make Codex choose the IDE-context endpoint instead of creating its own primary router. The bridge then reaches the same incompatible endpoint. A successful socket connection alone does not establish protocol compatibility.

## Evidence and inspection pointers

- `lsof -nP -U` showed the RustRover process holding the legacy socket under `/var/folders/.../T/codex-ipc/ipc-501.sock`; the primary `~/.codex/ipc/ipc.sock` had no listener.
- The normal bridge `status` and `diagnose` tools showed `pluginVersion: "0.2.4"`, `replyAddress: null`, unknown runtime/permissions, and startup/connection error `no-handler-for-request`. Earlier attempts had also produced `Receiver startup timed out`. Do not reduce this case to a generic timeout.
- After the user restarted Codex without the IDE, `lsof` showed the Codex app owning the primary socket; both MCP and receiver reported version 0.2.4, the receiver address was non-null, and `diagnose` reported a reachable Desktop transport with fresh prompting permissions. This confirms recovery for that startup sequence, not a permanent fix for a later Codex-only restart while Air holds the legacy endpoint.
- Static reading of `/Applications/ChatGPT.app/Contents/Resources/app.asar` established the router selection logic. Search for `getOrStartRouterEndpoint`, `canConnectToEndpoint`, and the primary/legacy path helpers. The checked bundle was `.vite/build/early-bootstrap-631-c364c4eef36b8fb5.js`; its filename can change after app updates.
- The corresponding JetBrains implementation was found in `/Applications/Jetbrains/RustRover.app/Contents/plugins/air-plugin/lib/modules/intellij.air.backend.codex.ide.jar`, especially `com.intellij.air.backend.codex.ide.CodexIdeContextIpcService`, `CodexIdeContextIpcProtocol`, `CodexIdeContextIpcTransportKt`, and `CodexIdeContextIpcStartupActivity`. This identifies JetBrains Air specifically; do not assume that disabling AI Assistant's unrelated context options will stop the service.
- No narrow switch for only this IPC service was found in the inspected module. That is a search result, not proof that no setting can exist elsewhere or in later versions.

## Recovery boundary

Bridge discovery and receiver recovery require a compatible native router. They cannot make an IDE-context endpoint handle Desktop requests or force the app to select another router. Preserve hook trust and permission checks; a successful socket connection alone is insufficient.

Inspect listener ownership with `lsof -nP -U`. Do not stop another application, unlink its live socket or disable its integrations as an automatic repair. Coordinate any restart with the human and follow machine-specific instructions. Repeated receiver restarts do not fix an incompatible router.

## Future direction, not implemented or verified

A Codex-only launch with a separate private `TMPDIR` could isolate its legacy endpoint lookup from RustRover's while preserving the normal Codex home and primary IPC path. This was identified as a candidate from the path-selection code; no launcher was installed and no live restart test established that it works.

If returning to it, first verify temporary-directory/environment propagation and single-instance launch behavior. Then test a Codex-only restart with RustRover left running, confirming the actual listener owner, a non-null bridge address, fresh runtime/permissions, and an authorized messaging round trip. Do not report the workaround as working from static reasoning alone.

An upstream Codex fix could validate Desktop capabilities before adopting the legacy endpoint or separate IDE-context connectivity from the Desktop router. No upstream fix was established in this investigation.
