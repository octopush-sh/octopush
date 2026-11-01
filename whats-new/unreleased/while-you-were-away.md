---
title: See what your crews finished while you were away
kind: feature
area: app
scenario: default
steps:
  - open: mission-control
    target: mission-control-away
    caption: Crews that settled while Octopush was closed wait on the Settled band.
    action: none
---
Runs that finished while Octopush was closed now show up in Mission Control's **Settled** band
when you reopen it, with a quiet **While you were away** line in the header. Dismiss a card when
you've seen it.
