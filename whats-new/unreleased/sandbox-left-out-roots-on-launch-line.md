---
title: A sandboxed stage says which write dirs it left out
kind: improvement
area: app
highlight: false
---
When the sandbox leaves out a dir such as `~/.cache` because it points somewhere unsafe, the stage's launch line now says which one and why. The sandbox also refuses more unsafe places, such as a `~/.cache` that points into `~/.config` or `~/.ssh`.
