---
title: GPT-6 through a gateway uses Chat Completions
kind: fix
area: app
---
A GPT-6 model reached through LiteLLM, OpenRouter or another OpenAI-compatible base URL goes back to Chat Completions, so a gateway that doesn't speak the Responses API no longer fails every request. GPT-6 on OpenAI itself keeps the Responses API. When GPT-6 refuses a request, Talk and API stages now show its explanation instead of an empty reply.
