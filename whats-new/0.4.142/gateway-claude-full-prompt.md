---
title: Gateway-named Claude stages keep the full prompt
kind: fix
area: app
---
Since Claude Code 2.1.330, a Claude model under a gateway's name (`anthropic/claude-sonnet-5.5`)
got the shorter system prompt. Direct stages on such names now keep the full one, and the
launch line says "full Claude Code prompt (gateway name)".
