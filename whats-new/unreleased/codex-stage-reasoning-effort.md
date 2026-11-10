---
title: Effort and effort escalation now reach Codex CLI stages
kind: feature
area: app
highlight: true
steps:
  - target: builder-stage-reasoning
    caption: Codex stages now take a reasoning effort, passed to Codex as model_reasoning_effort.
  - target: builder-stage-reasoning
    caption: Auto keeps Codex's own default. Below GPT-6, Max runs as XHi, the model's top level.
---
CLI stages that run Codex now honour the stage's **Reasoning** and **Escalate on failure** effort, and the pre-run estimate counts it. Octopush passes it as a one-off `model_reasoning_effort` override, which wins over your Codex config file.
