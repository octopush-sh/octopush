---
title: Run sessions move into the mode band
kind: feature
area: app
highlight: true
scenario: run-four-sessions
steps:
  - open: mode/run
    target: run-session-line
    caption: Your sessions now sit beside the mode switcher, one icon each. Click one to show it; ⌥-click opens it beside.
    action: none
  - target: run-session-cell
    caption: Point at an icon for its name, what it is doing and its ⌘⌥ number. The brass underline is the session in focus.
    action: hover
  - target: run-layout
    caption: The layout button shows the layout on screen. Open it to pick one to four panes.
    action: click
  - target: run-layout-two
    caption: A larger layout brings in your next sessions. A smaller one takes panes off screen and closes nothing.
    action: click
  - target: run-pane-caption
    caption: Each pane names its session. Double-click the name to rename it; ⋯ holds Open beside and Close session.
    action: none
---
The session strip beside the terminal is gone: your sessions are icons in the mode band, with a layout button for one to four panes. Each pane's caption is its session's one home: name, what it is doing, rename, and a **⋯** menu with **Close session**. A pane's minus only takes it off screen; the session keeps running.
