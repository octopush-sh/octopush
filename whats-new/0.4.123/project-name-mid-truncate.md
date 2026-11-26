---
title: Long project names keep the end that tells them apart
kind: fix
area: app
steps:
  - target: rail
    caption: A long project name now drops its middle, not its end, so projects that share a prefix stay apart.
    action: none
---
A long project name in the rail, the top bar and the Logbook scope switch now drops its middle
instead of its end, so projects that share an org prefix stay apart. Hover for the full name.
In the rail, the name also uses the whole line until you hover it.
