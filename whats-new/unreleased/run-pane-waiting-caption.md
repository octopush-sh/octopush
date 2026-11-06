---
title: A pane on screen says when Claude Code waits on you
kind: feature
area: app
highlight: true
scenario: run-four-sessions
steps:
  - open: mode/run
    target: run-session-cell
    caption: Run several Claude Code sessions side by side.
    action: none
  - open: run/open-beside
    target: run-pair-pick
    caption: Open beside (⌘D) puts another session next to this one.
    action: click
  - target: run-pane-caption
    caption: When Claude Code asks for permission or input in a pane, its caption ends in "· waiting on permission".
    action: none
---
With sessions side by side, the pane Claude Code is blocked in now says so in its caption:
**· waiting on permission** or **· waiting on your input**. It clears as soon as you type in that
pane, focus it, or Claude Code finishes its turn. Talk's terminal seat shows it too.
