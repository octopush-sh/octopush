## Octopush 0.4.97

### Fixes

- **Viewed files reopen when they change again** — In Review, a file you marked viewed now reopens when the file changes again (say, the agent's next pass), with a quiet **changed since viewed** chip until you mark it again. Viewed marks no longer carry over to another workspace.
- **Sandboxed agents can no longer change git hooks or config** — A sandboxed mission can no longer write git hooks (including a `core.hooksPath` like husky's), git config, worktree pointers or submodule git dirs, or replace its own `.git` entry, so it can't plant code that runs outside the sandbox this way. If the repo's git layout can't be read, the stage stops instead of running unprotected. Linked worktrees can now `git add` and `git commit`.
- **Clearer error for a certificate with the wrong usage** — On macOS, a connection refused because the server's certificate is not meant for TLS servers now says **certificate had invalid extended key usage** instead of the macOS error text and its numeric code.

### Maintenance

visual-audit: don't run the design review when the audit never ran (#431)
