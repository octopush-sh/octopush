---
title: See what a repo's own hooks and MCP servers run
kind: improvement
area: app
highlight: true
steps:
  - open: mode/direct
    target: direct-launcher-repo-hooks
    caption: Each hook, status line and MCP server this repo's Claude Code config runs, read from its committed files.
    action: none
---
When a crew has a Claude Code stage, the Direct launcher now lists the hooks, status line and MCP servers the repo's committed `.claude/settings.json` and `.mcp.json` run, and says when they run inside the sandbox.
