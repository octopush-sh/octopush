---
title: Secret guard catches keystores and more MCP configs
kind: improvement
area: app
highlight: false
---
The secret guard now asks before a newly added `.key`, `.p12`, `.pfx` or `.jks` file leaves your machine (Keynote documents stay quiet), and checks credentials in `.claude/mcp.json` and `.vscode/mcp.json` too.
