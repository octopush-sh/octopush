---
title: MCP server tokens stay in your Keychain
kind: improvement
area: app
highlight: true
---
Tokens, secret headers and other secret env values of your MCP servers now live in your login Keychain instead of `~/.claude/mcp.json`. Values that look like secrets move there the next time you save. A saved secret shows as **•••• saved**. Nothing new leaves your Mac.
