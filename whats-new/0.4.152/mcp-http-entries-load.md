---
title: A remote MCP entry no longer hides your other servers
kind: fix
area: app
---
An entry in `~/.claude/mcp.json` written as `"type": "http"` or `"type": "sse"` with a `url` (and
optional `headers`) now loads as a remote server in Settings and Talk, through the same mcp-remote
bridge as the Remote form. An entry Octopush can't run is skipped on its own, and a save from
Settings keeps it in the file as it was. Before, either one made every server in the file disappear.
