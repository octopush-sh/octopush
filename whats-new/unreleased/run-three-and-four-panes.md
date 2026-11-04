---
title: Three and four sessions side by side in Run
kind: feature
area: app
highlight: true
scenario: run-four-sessions
steps:
  - open: mode/run
    target: run-session-cell
    caption: Hover a session on the rail to reach Open beside.
    action: hover
  - target: run-open-beside
    caption: Open beside asks which session sits beside this one.
    action: click
  - target: run-pair-pick
    caption: The pick gets its own pane. Too narrow for 72 columns each, the two stack.
    action: click
  - open: run/open-beside
    target: run-pair-pick
    caption: Open beside again (⌘D) adds a third, one large pane above two.
    action: click
  - open: run/open-beside
    target: run-pair-pick
    caption: A fourth makes a 2×2 grid around one shared cross.
    action: click
  - target: run-pane-divider
    caption: Drag a divider to resize; double-click to even it.
    action: none
---
Run now shows up to **four** sessions at once: three put a large pane beside two smaller ones, four
make a 2×2 grid. Panes stack on their own when side by side would leave one under 72 columns; with
two or three panes, each pane's menu sets **Stack**, **Side by side** or **Automatic** for the workspace.
