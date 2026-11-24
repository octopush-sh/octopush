---
title: Talk reconnects MCP servers after their config changes
kind: fix
area: app
highlight: true
steps:
  - open: settings/integrations
    target: settings-mcp-reconnect
    caption: Reconnect restarts Talk's connection to this server, then tests it. Saving a changed server restarts it too.
---
Saving an MCP server's config now restarts Talk's connection to it, a server whose process died starts fresh on the next call, and **Reconnect** in Settings › Integrations restarts one by hand. A bare command such as `npx` is now found on your login shell's PATH.
