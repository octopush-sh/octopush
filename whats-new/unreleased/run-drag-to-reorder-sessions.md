---
title: Drag sessions into the order you want
kind: feature
area: app
highlight: true
scenario: run-four-sessions
steps:
  - open: mode/run
    target: run-session-line
    caption: Drag a session's icon along the line and drop it where you want it.
    action: none
  - target: run-session-cell
    caption: The order sticks, and ⌘⌥1–9 follow it.
    action: hover
---
Drag a session's icon on Run's session line to reorder your sessions. The order is saved, and
⌘⌥1–9, ⌘⌥←/→ and the ⌘⌥K switcher follow it. Panes keep the sessions they show.
