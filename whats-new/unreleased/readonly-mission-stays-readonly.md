---
title: A read-only mission stays read-only
kind: fix
area: app
---
A review, probe or perf mission can no longer be turned into a writing mission afterwards. Starting a build or fix on the same branch, from the wizard or through the MCP `create_workspace` tool, now stops with a plain message and leaves the mission read-only and sandboxed. Start the writing work in its own workspace.
