---
title: The Readiness card always shows an answer
kind: fix
area: app
highlight: true
steps:
  - open: settings/general
    target: settings-readiness-card
    caption: Every check shows a verdict here, or says it hasn't run yet.
    action: none
  - target: settings-readiness-checked
    caption: The time of the last check sits under the results.
    action: none
---
The Readiness card in Settings › General no longer looks empty. It shows "Not checked yet" before
the first run, keeps the last results on screen while it checks again, and says when it last checked.
