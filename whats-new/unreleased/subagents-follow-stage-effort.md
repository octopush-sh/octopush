---
title: Subagents run at their stage's effort
kind: fix
area: app
---
Claude Code no longer passes a stage's effort on to subagents that use another model, so a stage
set to `low` could start Explore or Task subagents at a higher, costlier default. Octopush now
gives them the stage's effort too. A subagent that sets its own effort keeps it, and a stage on
Auto keeps Claude Code's defaults.
