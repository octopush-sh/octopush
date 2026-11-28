---
title: A project's MCP servers start only after you approve them
kind: improvement
area: app
steps:
  - target: talk-approval
    caption: A server this project's .claude/mcp.json defines asks before it starts, showing its exact command.
---
A server in a project's `.claude/mcp.json` now waits for your approval in Talk, which shows its
exact command, arguments and env names. Any change to its entry asks again, and a project server
never replaces one of yours with the same name. A change to `.claude/mcp.json` or Claude Code's
`.claude/settings*.json` by an agent always asks.
