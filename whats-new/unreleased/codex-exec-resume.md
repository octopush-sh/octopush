---
title: Codex stages pick up their session on a loop-back
kind: improvement
area: app
highlight: false
---
When a review sends work back and the loop target, if it is a Codex CLI writer, has a session to continue, it now picks that session up with `codex exec resume` instead of re-reading the repo and the whole dossier; the other stages in the loop run fresh. Resume and an answered question do the same. If the session can't be resumed, the stage runs fresh once and the journal says why.
