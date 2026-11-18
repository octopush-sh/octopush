---
title: Stopped Claude stages price subagents at their own model
kind: fix
area: app
highlight: false
---
When a Claude Code stage is stopped before it finishes, its estimated cost now prices each message at the model that answered it, so a subagent on Haiku or Sonnet is no longer billed at the stage's Opus rate. Usage with no price now reads "+ usage not reported" instead of $0.
