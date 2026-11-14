---
title: Codex stages keep their writes in the worktree
kind: fix
area: app
---
A Codex CLI stage that changes files now runs in Codex's own workspace-write sandbox, so its
commands can't write outside the worktree. Inside a sandboxed mission, Octopush's sandbox
confines it as before. The stage journal's launch line names Codex's sandbox when it's in use.
