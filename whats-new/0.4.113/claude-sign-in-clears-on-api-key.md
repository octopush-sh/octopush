---
title: An old Claude sign-in end clears once stages use a key
kind: fix
area: app
highlight: false
steps:
  - open: settings/general
    target: settings-readiness-card
    caption: Claude auth stops showing an old sign-in end once Claude Code runs on an API key.
---
When Claude Code stages run on an API key (for example `ANTHROPIC_API_KEY` in your login shell), the next stage now clears the stored Claude sign-in end, so Readiness, Mission Control and Routines no longer show "Sign-in ended" for a sign-in your stages don't use.
