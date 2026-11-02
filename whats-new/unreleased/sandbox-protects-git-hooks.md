---
title: Sandboxed agents can no longer change git hooks or config
kind: fix
area: app
---
A sandboxed mission can no longer write the repo's `.git/hooks`, `.git/info` or git config, so it can't plant a hook that runs outside the sandbox on your next commit. Sandboxed stages in a linked worktree can now `git add` and `git commit`.
