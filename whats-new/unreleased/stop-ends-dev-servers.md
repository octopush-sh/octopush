---
title: Stopping a run also stops the servers it started
kind: fix
area: app
---
Stopping a stage, aborting a run, or a stage hitting its time limit now ends the Claude CLI gracefully, together with everything it started. Dev servers and watch builds no longer keep running in the worktree or holding onto their ports.
