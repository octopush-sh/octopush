---
title: Halted stages offer Re-run with feedback
kind: fix
area: app
steps:
  - open: mode/direct
    target: direct-halt-rerun-feedback
    caption: When Re-run is the way forward, tell the stage what to do differently first.
---
When a halted stage's main action is **Re-run**, the run bar now also offers **Re-run with feedback**. A stage paused by a hook on a tool no longer shows "awaiting retry" because the tool's name or the error output mentions DNS or a timeout.
