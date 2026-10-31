---
title: Agents can no longer write outside their workspace
kind: improvement
area: app
steps:
  - open: mode/direct
    target: direct-launcher-begin
    caption: Claude Code stages now edit files only inside their own workspace.
    action: none
---
With Claude Code 2.1.314 or later, Claude Code's file-editing tools refuse writes outside the
stage's workspace, even with permissions bypassed. Shell commands aren't covered unless the
mission runs sandboxed. A refused edit shows as a failed tool call in the stage journal.
