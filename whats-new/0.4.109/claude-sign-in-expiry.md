---
title: A warning before your Claude sign-in ends
kind: feature
area: app
highlight: true
steps:
  - open: settings/general
    target: settings-readiness-card
    caption: Claude auth now shows when your claude.ai sign-in ends, and turns amber 10 days before.
    action: none
  - open: settings/routines
    target: routines-login-expiry
    caption: Near the end, Routines and Mission Control show a note with the command to sign in again.
    action: none
---
On Claude Code 2.1.318 or newer, Octopush reads when your claude.ai sign-in ends from each CLI
stage. Readiness shows the date, and Routines and Mission Control warn you 10 days ahead, so a
crew that runs at night doesn't fail on an ended sign-in.
