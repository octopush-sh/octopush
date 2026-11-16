---
title: Crew stages keep the skills they started with
kind: improvement
area: app
highlight: false
---
On Claude Code 2.1.321 or newer, a Direct stage no longer reloads `.claude/skills` when a file there
changes mid-stage, so a stage can't rewrite its own instructions while it works. A skill edit takes
effect from the next stage. Claude Code in Run terminals still reloads skills as they change.
