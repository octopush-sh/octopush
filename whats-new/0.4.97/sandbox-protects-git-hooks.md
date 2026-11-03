---
title: Sandboxed agents can no longer change git hooks or config
kind: fix
area: app
---
A sandboxed mission can no longer write git hooks (including a `core.hooksPath` like husky's), git config, worktree pointers or submodule git dirs, or replace its own `.git` entry, so it can't plant code that runs outside the sandbox this way. If the repo's git layout can't be read, the stage stops instead of running unprotected. Linked worktrees can now `git add` and `git commit`.
