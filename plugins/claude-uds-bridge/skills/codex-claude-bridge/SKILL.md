---
name: codex-claude-bridge
description: Coordinate with an existing local Claude session from Codex, including diagnosis and recovery of this chat's bridge receiver. Use native Codex chat tools for Codex-to-Codex coordination.
---

# Connect Codex to Claude

1. Use `claude_uds_bridge.list_sessions` and `status` to identify the intended **Claude** session by ID, title and project and check this chat's receiver. Names and directories can repeat.
2. If the receiver is missing or its version differs from MCP, call `diagnose`, then `recover_receiver`. Follow any reported blocker or human hook-review requirement; recovery never grants trust or changes inbox permissions. See [receiver recovery](../../RECEIVER-RECOVERY.md) for exceptional cases.
3. Send the authorized message with `send_message`. Continue independent work while waiting for the separate reply. The tool description explains transport outcomes, idle subscription and send limits.

For another **Codex chat**, use native `list_threads`, `read_thread`, `wait_threads` and `send_message_to_thread`; discover them by name if deferred. Codex registry entries remain discoverable for Claude to reach them. If native tools cannot reach a Codex target, report the limitation rather than automatically switching to the bridge.

To configure Claude-requested context compaction, use the bundled `bridge-compact-access` skill or call `compact_access` directly to open its human form. See [compaction](../../COMPACTION.md) for protocol and native API details. Tool descriptions and status explain grants, progress and final results.

For an IPC router conflict involving JetBrains Air, see [the shared troubleshooting reference](../../IPC-TROUBLESHOOTING.md). Machine-specific preferences belong in local guidance and take precedence over generic troubleshooting options.
