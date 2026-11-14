---
title: Codex stages keep their writes in the worktree
kind: fix
area: app
---
A Codex CLI stage that changes files now runs in Codex's own workspace-write sandbox. Its
commands can write only the worktree and the temp dirs, with the network still on, so they
can't commit in a linked worktree. Inside a sandboxed mission, Octopush's sandbox confines it as before.
