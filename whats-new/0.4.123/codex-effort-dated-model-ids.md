---
title: Codex effort reaches dated and namespaced model ids
kind: fix
area: app
highlight: false
steps:
  - target: builder-stage-reasoning
    caption: Hover a level to see what Codex runs it as on this model.
    action: none
---
A Codex CLI stage on a dated or namespaced model id, such as gpt-5.5-2026-03-01 or openai/gpt-5.5, now gets that model's effort levels, matched the way Codex matches them. The Reasoning control now says correctly which level an unlisted one runs as, and why it is disabled.
