---
title: Haiku 5.5 crew stages pay the long-prompt rate per request
kind: fix
area: app
---
Direct stages on the API and Talk sub-agents now price each Haiku 5.5 request on its own, so a request over 100K prompt tokens costs the long-prompt rate instead of the cheaper one. The same goes for the estimate of a stopped, stalled or crashed Claude Code stage. A finished Claude Code stage still shows Claude Code's own figure.
