---
title: Sandboxed missions keep file reads in the worktree
kind: improvement
area: app
highlight: false
---
In a mission you set to sandbox, Claude Code stages can't use their file tools to read outside the worktree (`~/.ssh`, a sibling repo), and shell commands that read there are refused. Sandboxed Claude stages get a private temp folder per workspace, which no sandboxed launch of another kind can write. A program that opens a file on its own can still read it. Needs Claude Code 2.1.257 or newer.
