---
title: Run's Companion shows context, changes and the mission
kind: feature
area: app
scenario: run-two-sessions
steps:
  - open: mode/run
    target: companion-run-changes
    caption: Changes lists the files your sessions have touched, with the lines each gained and lost.
    action: none
  - target: companion-run-read-diff
    caption: Read the diff opens Review. A click on a file opens it there.
    action: none
---
In Run, the Companion now shows what the terminals can't: how full the focused Claude Code session's
context is and what it has cost, the files your sessions changed with a way into Review, and the
mission's worked time and spend. Context appears for sessions in worktrees Octopush created, once
their first turn ends. It replaces the session inspector.
