---
name: bridge-compact-access
description: Open Claude UDS Bridge compact permissions to manage individual Claude grants in this chat or profile-wide full trust for compaction.
---

Call `claude_uds_bridge.compact_access` with `{}` immediately so the human can choose in its native form. If the tool is deferred, discover that exact tool by name, then call it. No preliminary status, session listing, diagnosis or repository inspection is needed: the tool supplies the settings and session choices.

After the form returns, briefly report the resulting profile mode and this chat's individual grants. Cancellation leaves permissions unchanged. If the tool is unavailable or reports that the receiver needs an upgrade, report that result. This skill opens settings; it does not start compaction or change permission files itself.
