---
title: Set reasoning effort on Claude Code stages
kind: feature
area: app
highlight: true
steps:
  - target: builder-stage-reasoning
    caption: Claude Code stages now take a reasoning effort, passed to the CLI as --effort.
  - target: builder-stage-reasoning
    caption: Auto keeps Claude Code's own default for the model. Codex stages still manage their own.
---
CLI stages that run Claude Code now honour the stage's **Reasoning** and **Escalate on failure**
effort, passed as `claude -p --effort`. A `CLAUDE_CODE_EFFORT_LEVEL` exported in your shell no
longer overrides it, and the cost estimate learns each effort separately.
