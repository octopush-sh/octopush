---
title: Crews can no longer remove or leave their worktree
kind: fix
area: app
steps:
  - open: settings/general
    target: settings-readiness-claude-note
    caption: While a Run session runs Claude Code, Readiness recommends 2.1.330, which fixes ExitWorktree.
    action: none
---
Claude Code stages can't use EnterWorktree or ExitWorktree any more, so a crew can't move its work
out of the mission's worktree or remove one another session is using. Readiness recommends Claude
Code 2.1.330 while you run it in Run mode.
