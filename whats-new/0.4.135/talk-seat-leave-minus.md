---
title: Talk's terminal seat leaves with a minus, not an ×
kind: improvement
area: app
highlight: false
steps:
  - open: mode/talk
    target: talk-seat-toggle
    caption: Open a terminal beside the conversation.
    action: click
  - target: talk-seat-leave
    caption: The minus takes it off screen. The session keeps running.
    action: hover
---
The terminal seat in Talk now leaves the view with a minus, as a Run pane does. An × read as
"close", but the session keeps running in Run.
