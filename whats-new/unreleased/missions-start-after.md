---
title: A mission can start after another one
kind: feature
area: app
steps:
  - target: rail
    caption: Right-click a mission in the rail to open its menu.
  - target: rail-menu-start-after
    caption: Start after… makes this mission wait for another one.
    action: click
  - target: starts-after-dialog
    caption: Pick the mission to wait on, and whether its run passes the last gate or its pull request merges.
  - target: starts-after-auto-start
    caption: Off by default, the brief and crew wait in Direct for Begin the run. On, the run begins by itself.
---
Choose **Start after…** in a mission's menu to make it wait for another mission's run to pass its
last gate, or for its pull request to merge. Then its brief, and the crew of the other mission's
last run, wait in Direct for **Begin the run**, unless you turned on **Start the run on its own**.
