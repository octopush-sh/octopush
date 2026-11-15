---
title: Sandboxed missions keep file reads in the worktree
kind: improvement
area: app
highlight: false
---
In a mission you set to sandbox, Claude Code stages can no longer use their file tools to read outside
the worktree, such as `~/.ssh` or a sibling repo. Shell commands that read there directly are refused too; the sandbox itself still blocks only writes, so a program that opens a file on its own can still read it.
This needs Claude Code 2.1.257 or newer; the stage journal says when it is older.
