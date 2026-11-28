---
title: Broken tool arguments are sent back, not run
kind: fix
area: app
---
When an OpenAI-compatible or local model sends tool arguments that aren't valid JSON, Talk, Direct and sub-agents no longer run the tool with empty input. The model gets the parse error and the start of what it sent, and can call again.
