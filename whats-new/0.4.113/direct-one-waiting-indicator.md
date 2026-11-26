---
title: A starting stage says it's waiting in one place
kind: fix
area: app
highlight: false
steps:
  - open: mode/direct
    target: direct-stage-waiting
    caption: Until its first tool call, a running stage's card says it is waiting.
---
In Direct, a stage that just started no longer shows two waiting lines in the focus pane. The
Thinking… octopus stays there on its own, and the stage's card in the run track reads "waiting
for first tool call" until the first tool call arrives.
