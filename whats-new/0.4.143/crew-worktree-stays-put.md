---
title: Crews can't use Claude Code's worktree tools
kind: fix
area: app
steps:
  - open: settings/general
    target: settings-readiness-claude-note
    caption: Claude Code 2.1.330 fixes ExitWorktree removing a worktree another session uses. Readiness recommends it while Claude Code runs in Run mode.
    action: none
---
Claude Code stages can't call EnterWorktree or ExitWorktree, so Claude Code's worktree tools can't
move a crew's work out of the mission's worktree or remove one another session is using. Shell
commands aren't covered: a stage can still run `git worktree` through Bash unless the mission is
sandboxed. Readiness recommends Claude Code 2.1.330 while you run it in Run mode.
