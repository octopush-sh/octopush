---
title: Choose the session beside with ⌘D
kind: improvement
area: app
highlight: true
scenario: run-two-sessions
steps:
  - open: mode/run
    target: run-session-cell
    caption: Hover a session on the rail; its menu has Open beside, or press ⌘D.
    action: hover
  - target: run-open-beside
    caption: Open beside asks which session sits beside this one.
    action: click
  - target: run-pair-input
    caption: Only sessions that aren't on screen are listed. ⌥⏎ in ⌘⌥K does the same from the switcher.
    action: none
---
**⌘D** in Run asks which session sits beside the current one, and **⌥⏎** in the ⌘⌥K switcher opens
the selected session beside instead of switching. With every session already on screen you get an
empty seat to open a new one in; closing a session on screen just closes its pane.
