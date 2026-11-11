---
title: GPT-6 keeps its reasoning across tool calls
kind: improvement
area: app
steps:
  - target: builder-stage-reasoning
    caption: Hover Off to see what it does on this model. GPT-6 Astra and GPT-6.1 Sol stay at their default, medium.
---
API stages on GPT-6 now pass the model's reasoning back after each tool call, as OpenAI asks. **Off** now turns reasoning off on GPT-6 Sol, Luna and 6.1 Terra. A refusal from any OpenAI-compatible provider now shows its explanation instead of an empty reply.
