---
title: Three and four sessions side by side in Run
kind: feature
area: app
highlight: true
scenario: run-two-sessions
steps:
  - open: mode/run
    target: run-session-cell
    caption: Hover a session on the rail; Open beside now adds up to four panes.
    action: hover
  - target: run-open-beside
    caption: Open beside asks which session sits beside this one.
    action: click
  - target: run-pair-pick
    caption: The pick opens in a pane of its own. ⌘D again adds a third, then a fourth in a 2×2 grid.
    action: click
  - target: run-pane-menu
    caption: Each pane's menu can stack the panes or put them side by side.
    action: click
  - target: run-pane-orientation
    caption: Automatic stacks them when a pane would get fewer than 72 columns.
    action: none
---
Run now shows up to **four** sessions at once: three put a large pane beside two smaller ones, four
make a 2×2 grid. Panes stack on their own when side by side would leave one under 72 columns; with
two or three panes, each pane's menu sets **Stack**, **Side by side** or **Automatic** for the workspace.
