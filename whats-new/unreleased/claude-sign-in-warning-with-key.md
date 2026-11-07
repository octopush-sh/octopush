---
title: The Claude sign-in warning shows even with an API key
kind: fix
area: app
highlight: false
steps:
  - open: settings/general
    target: settings-readiness-card
    caption: Claude auth shows when your Claude sign-in ends, even if an Anthropic key is set.
  - open: settings/routines
    target: routines-login-expiry
    caption: Routines warns before the sign-in ends, so overnight runs don't stop without notice.
---
An Anthropic key in Settings › Models doesn't sign Claude Code in, so Readiness, Mission Control and Routines now show when your Claude sign-in ends even when that key is set.
