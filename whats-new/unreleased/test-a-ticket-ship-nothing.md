---
title: Test a ticket locally in a mission that ships nothing
kind: feature
area: app
steps:
  - target: mission-intent-test
    caption: Test a ticket builds and runs it in a throwaway workspace. Talk starts with the ticket's brief.
  - target: context-ships-nothing
    caption: This mission ships nothing. Octopush refuses any push, pull request or publish an agent asks for.
---
Pick **Test a ticket** in the new-mission wizard, or **Test this ticket** in the backlog menu. Talk's agents
can build, install, run and edit config in a throwaway workspace, while a push, pull request or publish they
ask for is refused by Octopush. Crews don't run in this mission yet.
