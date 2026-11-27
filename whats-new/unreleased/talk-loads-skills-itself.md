---
title: Talk picks the skill a task needs
kind: feature
area: app
scenario: talk-work
steps:
  - open: mode/talk
    target: talk-work
    caption: When the model loads one of your skills on its own, its work shows a "used skill" row here.
    action: none
---
Talk now sees your skills' names and descriptions and loads the one a task matches by itself, so it works
without remembering `/name`. Sub-agents can load skills too. A skill's `allowed-tools` hold for the rest of the turn,
and `/name` works as before.
