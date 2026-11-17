---
title: Octopush won't commit or push your keys by accident
kind: feature
area: app
highlight: true
steps:
  - open: settings/general
    target: settings-secret-guard
    caption: The secret guard is on by default. It checks every commit, push and pull request on this Mac.
    action: none
---
Before a commit, a push or a pull request, Octopush checks the change for API keys, tokens, private keys, credentials in `.env` files and the keys you saved in Octopush. A finding asks you first, and a crew stops before its pull request, merge or release stage until you decide. Nothing leaves your Mac, and the value is never shown.
