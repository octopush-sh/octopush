---
title: Run now shows a Routine's setup as it runs
kind: improvement
area: app
steps:
  - open: settings/routines
    target: settings-nav-routines
    caption: While Run now is going, the routine's row says what it is waiting on, such as the setup script.
  - target: routines-run-now-phase
    caption: A failed setup gets its own toast, with the exit code.
---
**Run now** on a fresh-workspace Routine shows what it is waiting on, and a failed setup gets its own toast. A failed setup never deletes a checkout Octopush didn't create. The new-mission wizard says when its script becomes the project's setup script.
