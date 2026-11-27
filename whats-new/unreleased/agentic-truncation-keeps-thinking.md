---
title: Cut-off rounds retry cleanly on thinking models
kind: fix
area: app
---
When a Direct stage or a Talk sub-agent hits its output limit in the middle of a tool call, the retry now keeps the round's thinking. On models that think with a budget, such as Haiku 4.5 and Opus 4.5, that retry no longer fails with an API error.
