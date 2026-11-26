---
title: Long Talk turns keep going as the context fills
kind: improvement
area: app
---
A long Talk turn no longer stops when the model's context window fills: older tool results are shortened
in the request, and the model can still read them whole. When a model refuses a prompt as too long, Talk
lowers the window it trusts for that model, shortens the request and retries once.
