---
title: Sandboxed missions keep file reads in the worktree
kind: improvement
area: app
highlight: false
---
In a mission you set to sandbox, Claude Code stages can no longer use their file tools to read outside the worktree, such as `~/.ssh` or a sibling repo, and shell commands that read there directly are refused. Each stage gets its own temp folder. A program that opens a file on its own can still read it. Needs Claude Code 2.1.257 or newer.
