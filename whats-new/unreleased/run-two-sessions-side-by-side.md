---
title: Two sessions side by side in Run
kind: feature
area: app
highlight: true
scenario: run-two-sessions
steps:
  - open: mode/run
    target: run-session-cell
    caption: Hover a session on the rail to open its menu.
    action: hover
  - target: run-open-beside
    caption: Open beside shows the last session you used that isn't on screen, next to the current pane.
    action: click
  - target: run-pane-caption
    caption: Each pane names its session. Click a pane, or use ⌘[ and ⌘], to type there.
    action: none
  - target: run-pane-divider
    caption: Drag the divider to resize the panes; double-click evens them.
    action: none
---
Run can now show two sessions at once. **Open beside** in a rail cell's menu shows the last session
you used that isn't on screen next to the current pane; the Companion folds to make room (⌘\ brings
it back). Each pane's **×** leaves the view without closing the session.
