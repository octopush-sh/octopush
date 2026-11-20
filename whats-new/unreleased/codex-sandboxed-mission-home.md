---
title: Codex stages get their own home in a sandboxed mission
kind: fix
area: app
---
A Codex stage in a sandboxed mission now runs with its own `CODEX_HOME`, holding a read-only copy of your Codex config, and can't write `~/.codex`. A ChatGPT sign-in older than a week stops the stage with "Open Codex once to refresh sign-in". The Codex commit warning now suggests a Claude model only.
