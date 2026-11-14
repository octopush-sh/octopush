---
title: Codex stages keep their writes in the worktree
kind: fix
area: app
---
A Codex CLI stage that changes files now runs in Codex's own workspace-write sandbox. Its
commands can write only the worktree, the temp dirs and the git data a commit needs, with the
network still on. Inside a sandboxed mission, Octopush's sandbox confines it as before.
