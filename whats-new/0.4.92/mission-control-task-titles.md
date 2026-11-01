---
title: Mission Control cards lead with the run's task
kind: improvement
area: app
scenario: default
steps:
  - open: mission-control
    target: mission-control-card-task
    caption: Each crew card is titled by its task. Hover for the full text.
    action: none
  - target: mission-control-card-workspace
    caption: The workspace name sits in the meta row, next to the time in state.
    action: none
---
Crew cards in Mission Control now use the run's task as their title, so several crews working in one workspace no longer look alike. The workspace name moves to the small meta row, and hovering the title shows the full task.
