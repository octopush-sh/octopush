---
title: Talk rides out a busy provider, and Stop is instant
kind: improvement
area: app
---
When the provider is overloaded, rate-limited or drops the connection, Talk now retries on its
own, and the Octo says so ("Model overloaded — retrying in 8s"). Stop ends the request in flight
at once instead of waiting for the whole answer.
