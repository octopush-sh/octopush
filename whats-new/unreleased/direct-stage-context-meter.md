---
title: A running Claude stage shows how full its context is
kind: improvement
area: app
highlight: true
steps:
  - open: mode/direct
    target: direct-stage-context
    caption: A running Claude Code stage reads its context, like ctx 142k / 200k. Amber past 80%, red past 95%.
    action: none
  - target: direct-focus-context
    caption: The stage's header keeps the reading, and a finished stage's final value.
    action: none
---
A Claude Code stage in Direct now shows how full its context window is, so you can see when a long stage is about to compact. It works for detached runs too, and stays hidden when the model's window isn't known.
