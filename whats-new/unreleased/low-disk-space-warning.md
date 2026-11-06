---
title: Readiness and the launcher warn when the disk is nearly full
kind: improvement
area: app
steps:
  - open: settings/general
    target: settings-readiness-disk
    caption: Disk space shows how much room crews have. Under 10 GB it turns amber.
    action: none
  - open: mode/direct
    target: direct-launcher-low-disk
    caption: Under 2 GB free, the launcher warns above Begin. The run can still begin.
    action: none
---
The Readiness card has a **Disk space** row, amber under 10 GB free and red under 2 GB, with a link
to the workspace caches. Under 2 GB the Direct launcher shows one line above Begin; it never blocks the run.
