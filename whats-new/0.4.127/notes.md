## Octopush 0.4.127

### Improvements

- **Sandbox restricts hard links to its write roots** — In a sandboxed mission, a stage can now create hard links only to files already inside its writable folders. Hard links inside the workspace, the temp folders and the build cache still work, so git, npm and cargo behave as before, and symlinks are unaffected.
- **Sandbox write roots are harder to replace** — In a sandboxed mission, stages can still write inside the temp folders, `~/.claude` and `~/.cache`, but can no longer remove, rename or relink those folders themselves. Before each launch Octopush checks them and leaves out any that points somewhere it shouldn't, such as your home folder.
