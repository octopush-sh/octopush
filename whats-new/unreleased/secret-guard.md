---
title: Octopush stops your keys at commit, push and PR time
kind: feature
area: app
highlight: true
steps:
  - open: settings/general
    target: settings-secret-guard
    caption: The secret guard is on by default. It checks the commits, pushes and pull requests you make in Octopush.
    action: none
---
When you commit, push or open a pull request in Octopush, it checks the change for API keys, tokens, private keys and the keys you saved here. A finding asks you first, and a crew stops before its pull request, merge or release stage until you decide. An agent's own shell commits aren't checked yet. Nothing leaves your Mac, and the value is never shown.
