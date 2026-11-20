---
title: Readiness shows your Codex version and its sandbox fix
kind: improvement
area: app
highlight: true
steps:
  - open: settings/general
    target: settings-readiness-codex
    caption: The Codex row shows your version and turns amber below 0.170.0, which fixes a sandbox gap.
    action: none
---
The Readiness card's Codex CLI row now shows the installed version. Codex 0.170.0 fixes
permission updates and child threads losing sandbox restrictions, so on an older version the row
turns amber and gives the update command. Each Codex stage's journal names the version it ran on.
