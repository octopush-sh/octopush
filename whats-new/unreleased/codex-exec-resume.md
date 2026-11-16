---
title: Codex stages pick up their session on a loop-back
kind: improvement
area: app
highlight: false
---
When a review sends work back to a Codex stage, the stage now continues its own session with `codex exec resume` instead of re-reading the repo and the whole dossier, and Resume does the same. If the session can't be resumed, the stage runs fresh once and the journal says why.
