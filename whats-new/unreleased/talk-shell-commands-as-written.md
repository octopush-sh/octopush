---
title: Talk's shell runs commands with ! and tabs as written
kind: fix
area: app
---
A command with `!` in it, such as `node -e "if (!x) …"` or `git commit -m "Fix it!"`, no longer fails
with "event not found" in Talk's shell, and a heredoc keeps its tabs, so a Makefile written that way
works.
