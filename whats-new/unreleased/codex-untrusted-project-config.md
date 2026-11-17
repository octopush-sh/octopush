---
title: Know when Codex will skip your repo's .codex/ settings
kind: improvement
area: app
highlight: true
steps:
  - open: mode/direct
    target: direct-launcher-codex-trust
    caption: Codex skips this repo's .codex/ settings and MCP servers until you trust the project in Codex. Octopush never trusts it for you.
    action: none
---
When a crew has a Codex stage and the repo has a `.codex/` folder that Codex won't load because the project isn't trusted in Codex, the Direct launcher and the stage journal now say so and how to trust it yourself.
