---
title: A stage waiting out an API retry is no longer stopped
kind: fix
area: app
---
A crew stage waiting out an API retry is no longer stopped as stalled. When Claude Code says it
will wait before retrying an overloaded API, the stage gets that wait on top of its usual five
minutes, and a stall after a retry now says so.
