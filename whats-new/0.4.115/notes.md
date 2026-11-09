## Octopush 0.4.115

### Features

- **Conductor repos bring their setup script along** — A new mission in a repo set up for Conductor now prefills its setup script from `.conductor/settings.toml`. It runs only when you begin the mission. Setup scripts also get `CONDUCTOR_ROOT_PATH`, `CONDUCTOR_WORKSPACE_PATH` and `CONDUCTOR_WORKSPACE_NAME`, unless you already set them.

### Fixes

- **A tool paused by your hook no longer reads as done** — When one of your Claude Code hooks defers a tool call, the stage now halts and names the tool, instead of finishing with no output. If a resumed stage was waiting on a tool that's gone (say, a removed MCP server), the halt says which one. Re-run comes first, and Resume is still there.

### Maintenance

Fix FEATURES.md: exit 127 for a missing command, no ping for workers that died while… (#622)
