---
title: Routine conditions find your tools and report errors
kind: fix
area: app
highlight: true
steps:
  - open: settings/routines
    target: settings-nav-routines
    caption: A routine's "Fire only if…" check now runs with your login shell's PATH, so gh, node and claude are found.
---
A routine's fire condition now runs with your login shell's PATH (Homebrew, nvm, `~/.local/bin`).
Exit 1 still means "condition not met"; any other exit shows as **condition error** with the last
lines of its stderr, so a broken check no longer looks like nothing to do.
