---
title: Choose which MCP servers each crew stage can use
kind: feature
area: app
highlight: true
steps:
  - target: builder-stage-mcp
    caption: Turn on the MCP servers this stage may use. Every server starts off, since crews run unattended.
  - target: builder-stage-mcp
    caption: A read-only stage, like a reviewer, gets only the tools a server marks read-only.
---
A Direct stage on the API substrate can now use the MCP servers you choose for it in the stage
inspector, from Settings › Integrations only. Each one is off until you turn it on, and a run
keeps each server's settings from when it was created. Claude Code and Codex stages keep their
own servers for now, and detached runs and Routines run without MCP for now.
