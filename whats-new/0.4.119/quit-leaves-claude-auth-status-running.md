---
title: Quitting no longer cuts a Claude sign-in refresh short
kind: fix
area: app
highlight: false
---
If you quit Octopush while Readiness's **Check again** is still asking `claude auth status`, that command now finishes on its own instead of being stopped after 2 s, so a slow token refresh can't sign you out.
