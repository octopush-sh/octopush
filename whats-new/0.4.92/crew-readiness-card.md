---
title: See if this Mac is ready for a crew
kind: feature
area: app
scenario: default
steps:
  - open: settings/general
    target: settings-readiness-card
    caption: Claude Code, its version, auth, git, gh and Ollama, checked on this Mac.
    action: none
  - target: settings-readiness-again
    caption: Fixed something? Check again. Each check gets 3 seconds.
    action: none
---
Settings › General now opens with a **Readiness** card that checks what a crew needs in its first
minute: Claude Code and its version, auth, git, the GitHub CLI and Ollama. A failing check shows how
to fix it and a command you can copy, and the first-run crew invite links to it.
