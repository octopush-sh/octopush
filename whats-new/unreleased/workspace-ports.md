---
title: Each workspace gets its own block of ports
kind: feature
area: app
steps:
  - target: header-ports
    caption: This workspace's ports. Its terminals and Talk shell read the first one from OCTOPUSH_PORT.
---
Every workspace now has its own 10 local ports, shown at the end of the header. Its Run terminals
and Talk shell get `OCTOPUSH_PORT` and `OCTOPUSH_PORT_COUNT`, so each workspace's dev server
can use its own port instead of colliding. Setup scripts written for Conductor get `CONDUCTOR_PORT` too.
