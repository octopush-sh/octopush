---
title: Codex stage effort follows each model's levels
kind: fix
area: app
---
A Codex CLI stage's effort now follows the levels each model offers in Codex: Max reaches GPT-5.6 models and codex-auto-review, and runs as XHi on GPT-5.5. On a model Codex doesn't list, such as gpt-5-codex or o3, the stage keeps Codex's default instead of failing on an unsupported level.
