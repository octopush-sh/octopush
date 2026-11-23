---
title: Filter the rail by state, and archive merged missions
kind: feature
area: app
scenario: default
steps:
  - target: rail-state-filter
    caption: Show only the missions that need you, are working, or sit idle.
    action: click
  - target: rail-merged-archive
    caption: Once a mission's PR is merged and its worktree is clean, archive it from here. Undo brings it back.
---
The rail's search line has a state filter: **Needs you**, **Working** or **Idle**, counted the way the fleet chip counts. A mission whose PR is merged and whose worktree is clean offers **merged · archive?**, and the project menu can archive them all at once, after listing them. Nothing is archived without a click.
