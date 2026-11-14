---
title: Readiness checks the Codex CLI when a crew uses it
kind: improvement
area: app
steps:
  - open: settings/general
    target: settings-readiness-codex
    caption: With a Codex stage in a crew, Readiness checks codex is installed.
    action: none
  - open: settings/general
    target: settings-readiness-again
    caption: Check again also asks codex whether it is signed in.
    action: none
---
When a saved crew or Routine has a Codex CLI stage, the Readiness card adds a **Codex CLI** row:
amber with `npm i -g @openai/codex` when it is missing, and on **Check again** whether it is signed in,
with `codex login` to copy when it is not.
