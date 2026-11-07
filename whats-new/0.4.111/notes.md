## Octopush 0.4.111

### Improvements

- **Every waiting Claude Code session keeps its mark** — When several Claude Code sessions wait on you at once, each one now keeps its brass dot on the session rail until you answer it. The ⌘⌥K switcher lists waiting sessions first, oldest first, so ⏎ takes you to the prompt that has waited longest.

### Fixes

- **A warning when Claude Code lacks a sandbox fix** — Claude Code 2.1.319 fixes a sandbox escape when creating a worktree. On an older version, Readiness, the Direct launcher and each Claude Code stage's journal now say so and give the update command. Runs are never blocked.
- **Connect to Claude Code answers within 30 seconds** — **Connect to Claude Code** in Settings › Integrations now gives up after 30 seconds in all, instead of up to about a minute when Claude Code's config stayed busy. A stuck call is stopped along with anything it started, and a long reply from the CLI no longer reads as busy.
