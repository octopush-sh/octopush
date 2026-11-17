---
title: Sandboxed stages write less of ~/.claude
kind: improvement
area: app
highlight: false
---
A sandboxed stage now writes only the parts of `~/.claude` (or your `CLAUDE_CONFIG_DIR`) that hold Claude Code's session state, not its skills, agents, plugins, hooks or settings. Auto memory is off in sandboxed Claude stages. The shared `~/.cache` isn't writable either: pre-commit, uv and similar caches use the stage's own build cache, so they start cold once per workspace.
