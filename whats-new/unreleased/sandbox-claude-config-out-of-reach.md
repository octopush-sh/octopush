---
title: Sandboxed stages can't change your Claude Code setup
kind: fix
area: app
highlight: false
---
A sandboxed stage can no longer add skills, agents, commands, plugins, hooks, settings or `CLAUDE.md` to your `~/.claude`, which every later Claude Code session loads. It still writes its own transcripts and session state there. Build tools now cache in the stage's own dir instead of the shared `~/.cache`.
