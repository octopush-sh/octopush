---
title: Every waiting Claude Code session keeps its mark
kind: improvement
area: app
highlight: true
steps:
  - open: mode/run
    target: run-session-waiting
    caption: Each session waiting on permission or your input keeps its own dot on the rail.
  - open: run/open-beside
    target: run-switcher-waiting
    caption: The switcher lists waiting sessions first, the longest wait at the top.
---
When several Claude Code sessions wait on you at once, each one now keeps its brass dot on the
session rail until you answer it. The ⌘⌥K switcher lists waiting sessions first, oldest first,
so ⏎ takes you to the prompt that has waited longest.
