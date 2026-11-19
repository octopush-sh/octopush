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
In Run, the Companion now shows what the terminals can't: the focused Claude Code session's context
and cost, the files your sessions changed, and the mission's worked time and spend. Context needs
Claude Code's hooks: it shows in worktrees Octopush created, with the hooks setting on, and not for
Codex or other CLIs. It replaces the session inspector.
