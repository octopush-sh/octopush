---
title: The Companion says a starting shell is starting
kind: fix
area: app
steps:
  - open: mode/run
    target: run-starting
    caption: Until the shell draws its prompt, the canvas says it's starting.
    action: none
  - target: companion-session-state
    caption: The Companion's State says the same, then shell idle once the prompt is up.
    action: none
---
While a Run session's shell is still starting, the Companion now reads **starting** instead of
*shell idle*, so the canvas and the inspector never disagree about one session.
