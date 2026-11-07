---
title: A warning when Claude Code lacks a sandbox fix
kind: fix
area: app
highlight: true
steps:
  - open: settings/general
    target: settings-readiness-card
    caption: Readiness turns the Claude Code row amber when your version misses a sandbox fix.
---
Claude Code 2.1.319 fixes a sandbox escape when creating a worktree. On an older version,
Readiness, the Direct launcher and each Claude Code stage's journal now say so and give the
update command. Runs are never blocked.
