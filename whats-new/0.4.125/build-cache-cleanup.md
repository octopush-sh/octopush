---
title: Sandbox build caches no longer pile up
kind: fix
area: app
highlight: false
---
Deleting a workspace now removes its sandbox build caches (npm, cargo and the like) from `~/Library/Caches/octopush`, and caches no stage has used for 30 days are cleared on launch.
