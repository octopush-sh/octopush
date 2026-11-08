---
title: A tool paused by your hook no longer reads as done
kind: fix
area: app
---
When one of your Claude Code hooks defers a tool call, the stage now halts and names the tool, instead of finishing with no output. If a resumed stage was waiting on a tool that's gone (say, a removed MCP server), the halt says which one. Re-run comes first, and Resume is still there.
