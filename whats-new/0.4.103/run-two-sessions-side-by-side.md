---
title: Two sessions side by side in Run
kind: feature
area: app
highlight: true
scenario: run-two-sessions
steps:
  - open: mode/run
    target: run-session-cell
    caption: Each session is an icon in the mode band. ⌥-click one to open it beside the current pane.
    action: hover
  - target: run-open-beside
    caption: Or use a pane's ⋯ menu. Open beside… asks which session should sit next to this one.
    action: none
  - open: run/open-beside
    target: run-pair-pick
    caption: Pick one, and it opens in a pane of its own.
    action: click
  - target: run-pane-caption
    caption: Each pane names its session. Click a pane, or use ⌘[ and ⌘], to type there.
    action: none
  - target: run-pane-divider
    caption: Drag the divider to resize the panes; double-click evens them.
    action: none
---
Run can now show two sessions at once. **Open beside…** in a pane's **⋯** menu puts the session you
pick next to the current pane; the Companion folds to make room (⌘\ brings it back). A pane's minus
takes it off screen without closing the session.
