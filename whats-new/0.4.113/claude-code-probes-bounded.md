---
title: Readiness and Connect checks stay small and clean up
kind: fix
area: app
highlight: false
---
A CLI that prints without end during a Readiness or Connect check no longer grows Octopush's memory, and anything a checked command leaves running in its process group is stopped when it exits.
