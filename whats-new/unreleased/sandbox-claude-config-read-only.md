---
title: Sandboxed stages can't change your Claude Code setup
kind: fix
area: app
highlight: true
---
A sandboxed stage can now write only Claude Code's session state in `~/.claude`, such as transcripts and todos. Your skills, agents, commands, plugins, hooks, settings and `CLAUDE.md` stay read-only, so a stage can't plant something your next `claude` session runs. `~/.cache` isn't writable any more either: each stage's tools cache in its own build cache.
