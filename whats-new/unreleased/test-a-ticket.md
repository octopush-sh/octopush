---
title: Test a ticket in a workspace that ships nothing
kind: feature
area: app
steps:
  - target: mission-intent-test
    caption: Test a ticket works in a throwaway workspace. From a backlog ticket, it starts from the ticket's branch, with a brief in Talk.
  - target: context-ships-nothing
    caption: Talk's agents can build, run and edit config here. Octopush refuses the git pushes, pull requests and publishes their commands ask for.
---
Choose **Test a ticket** in the new-mission wizard, or **Test this ticket** in a backlog ticket's menu. Talk's
agents build and run the ticket's branch locally, and Octopush refuses the git pushes, pull requests and publishes
their commands ask for. Talk runs plain commands only there, and ssh, scp, rsync and deploy CLIs aren't checked yet.
