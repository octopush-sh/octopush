---
title: Stages say which tool calls Claude Code refused
kind: fix
area: app
highlight: true
steps:
  - open: mode/direct
    target: direct-stage-refused
    caption: A stage whose calls Claude Code refused says how many, in amber.
    action: none
  - target: direct-focus-refused
    caption: The stage's journal lists each refused call.
    action: none
---
Claude Code now refuses some tool calls when nobody can be asked. A stage that had a call such
as `git push` refused now says **N tool calls refused**, lists each one in its journal. A
code-writing stage that finishes tells the next stage which calls never ran, so a review can
check them.
