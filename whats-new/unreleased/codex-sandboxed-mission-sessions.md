---
title: Codex stages can start in a sandboxed mission
kind: fix
area: app
---
In a sandboxed or review mission, a Codex CLI stage can now write its session log in
`~/.codex/sessions`, which Codex needs to start. The rest of `~/.codex`, including its config,
`AGENTS.md`, prompts and sign-in, stays read-only to the stage.
