---
title: A workspace that ships nothing guards its processes too
kind: improvement
area: app
steps:
  - target: context-ships-nothing
    caption: Scripts here meet the same check as the agent's commands, and ssh, tunnels and deploy CLIs are refused too.
---
In a Test a ticket workspace, a script that pushes or publishes through git, gh or a deploy tool on PATH is now
refused too, and gets no publish tokens or saved git credentials. ssh, rsync, tunnels and deploy CLIs are refused
as well. Git runs no hook, filter or other program its config names. A program that opens its own connection still
isn't caught.
