---
title: Add remote MCP servers by URL
kind: feature
area: app
highlight: true
steps:
  - open: settings/integrations
    target: settings-mcp-add
    caption: Add a server here.
    action: click
  - target: settings-mcp-type
    caption: Choose Remote URL, then sign in through the browser, with a token, or with your own headers.
---
Settings › Integrations › MCP Servers can now add a remote server by its URL. It signs in through your browser, with a token, or with headers you set, and Octopush builds the `mcp-remote` bridge for you. **Clear sign-in** forgets a browser sign-in.
