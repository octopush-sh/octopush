---
title: Choose which MCP servers a Talk conversation can use
kind: feature
area: app
scenario: talk-mcp
steps:
  - open: mode/talk
    target: companion-can-use
    caption: Servers from Settings › Integrations and this project's .claude/mcp.json are all on. Click one to turn it off here only.
---
The Companion's **can use** row now lists every configured MCP server with its live status: connected with its tool
count, not started yet, or failed and why. Click a server to turn it off for one conversation, and its sub-agents,
and click again to turn it back on.
