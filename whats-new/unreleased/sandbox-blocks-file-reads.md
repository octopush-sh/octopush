---
title: Sandboxed missions keep file reads in the worktree
kind: improvement
area: app
highlight: false
---
In a mission you set to sandbox, Claude Code stages can no longer use their file tools to read outside
the worktree, such as `~/.ssh` or a sibling repo. Shell commands can still read those files.
This needs Claude Code 2.1.257 or newer; the stage journal says when it is older.
