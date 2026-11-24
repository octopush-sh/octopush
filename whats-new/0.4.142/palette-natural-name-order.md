---
title: The palette lists numbered workspaces in number order
kind: fix
area: app
steps:
  - open: palette
    target: palette-workspaces
    caption: Workspaces active at the same moment now read rollout-3, rollout-10, rollout-17.
    action: none
---
When workspaces in the ⌘K palette were last active at the same moment, it sorted their names
as plain strings, so *rollout-10* came before *rollout-3*. Now the numbers inside names sort
by value.
