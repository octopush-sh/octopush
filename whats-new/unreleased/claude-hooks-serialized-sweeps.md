---
title: Claude Code hooks survive a quick off-and-on toggle
kind: fix
area: app
---
Turning **Let Claude Code say what it's waiting on** off and straight back on no longer leaves
some worktrees without their hooks until the next launch.
