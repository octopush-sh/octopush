---
title: Read-only stages can list stashes and say what they drop
kind: improvement
area: app
highlight: false
---
Read-only stages (Reproduce, Verify and the reviewers) may now run `git stash list` and
`git stash show`, and refuse file edits on every substrate. When a custom read-only role's
saved tools include file edits, the stage journal says they were removed.
