---
title: The Run canvas says when a shell is still starting
kind: fix
area: app
steps:
  - open: mode/run
    target: run-starting
    caption: Until the shell draws its prompt, the canvas says it's starting, and where.
    action: none
---
A new session no longer shows a blank pane while its shell starts. The Run canvas reads
**Starting shell in ‹workspace›…** until the prompt appears.
