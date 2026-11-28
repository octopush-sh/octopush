---
title: See and revoke the project MCP servers you approved
kind: improvement
area: app
steps:
  - target: companion-project-servers
    caption: The servers this project's .claude/mcp.json defines, and whether each is approved. Revoke one here.
  - target: settings-mcp-project-approvals
    caption: Every project server you approved, with a revoke button.
---
The Companion lists the servers a project's `.claude/mcp.json` defines, with whether each is
approved, waiting, changed since you approved it, or replaced by one of yours. Settings ›
Integrations lists every approved one. Revoking stops the server, and it asks again before it
starts.
