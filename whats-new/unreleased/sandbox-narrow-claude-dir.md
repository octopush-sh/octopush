---
title: Sandboxed stages write less of ~/.claude
kind: improvement
area: app
highlight: false
---
A sandboxed stage now writes only the parts of `~/.claude` Claude Code keeps its session state in (transcripts, task lists, snapshots), not its skills, agents, commands, plugins, hooks or settings. It no longer writes the shared `~/.cache` either: tools that cache there use the stage's own build cache.
