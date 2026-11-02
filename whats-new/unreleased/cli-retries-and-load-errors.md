---
title: The journal shows Claude Code retries and skipped tools
kind: improvement
area: app
highlight: false
---
When Claude Code retries an API call, the stage journal now shows why, which attempt it is and when the next one starts, so a stage that is retrying no longer looks stuck. The journal also lists any MCP server or plugin that failed to load at the start of a stage.
