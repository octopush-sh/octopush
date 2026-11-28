---
title: "Talk retries too-long prompts on LM Studio and Mistral"
kind: fix
area: app
---
When LM Studio, Mistral or an older llama.cpp server refuses a Talk prompt as too long for the model, Talk now shortens
earlier tool results and retries once, as it already did for other providers, instead of ending the turn.
