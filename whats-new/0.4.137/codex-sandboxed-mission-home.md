---
title: Sandboxed missions keep Codex out of your ~/.codex
kind: fix
area: app
---
In a sandboxed mission a Codex writer stage now gets its own `CODEX_HOME` with a read-only copy of your config, and can't write `~/.codex`. A read-only Codex stage there is refused before the run, and a ChatGPT sign-in older than a week stops the stage with "Open Codex once to refresh sign-in". The launcher still suggests a Claude model for these missions.
