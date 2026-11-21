---
title: A stage that never reached the API says so
kind: fix
area: app
---
A Claude Code stage that stalls at start-up, before its first request, now stops with "Claude Code
sent no request in 5 minutes" instead of a plain silence. On Claude Code older than 2.1.327, which
can hang there when a proxy holds a model's settings fetch, the halt card suggests updating.
