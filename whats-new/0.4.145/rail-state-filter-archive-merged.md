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
    caption: Archive a merged, clean mission from here. Undo rebuilds its worktree from the branch; ignored local files don't come back.
---
The rail filters by state: **Needs you**, **Working** or **Idle**, counted like the fleet chip. A mission whose PR is merged and whose worktree is clean offers **merged · archive?**; the project menu archives them all, after listing them. Each is checked again when you confirm, and skipped with a reason if it changed. Local files git ignores are named first: Undo can't bring them back.
