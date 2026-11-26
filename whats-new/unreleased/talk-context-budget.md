---
title: Long Talk turns keep going as tool results pile up
kind: improvement
area: app
---
A long Talk turn no longer stops when its own tool results fill the model's context window: older ones
are shortened in the request, and the model can still read them whole. When a model refuses a prompt as
too long, Talk shortens it and retries once. A conversation whose earlier turns alone fill the window can still end the turn.
