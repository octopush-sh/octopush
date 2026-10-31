---
title: Agents can no longer write outside their workspace
kind: improvement
area: app
steps:
  - open: mode/direct
    target: direct-launcher-begin
    caption: Every Claude Code stage in a run now writes only inside its own workspace.
    action: none
---
Claude Code stages now run with writes blocked outside their working directories, even with
permissions bypassed. They can't touch your main checkout, another workspace or your home
folder, and a refused write shows as a failed tool call in the stage journal.
