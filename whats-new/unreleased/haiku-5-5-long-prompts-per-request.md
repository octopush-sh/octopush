---
title: Long-prompt requests on the API pay the long-prompt rate
kind: fix
area: app
---
Direct stages on the API and Talk sub-agents now price each request on its own, so a Haiku 5.5 request over 100K prompt tokens, or a GPT-6 request over 272K, costs the long-prompt rate in spend and savings. A stopped, stalled or crashed Claude Code stage's estimate does the same for Haiku 5.5. A finished Claude Code stage still shows Claude Code's own figure.
