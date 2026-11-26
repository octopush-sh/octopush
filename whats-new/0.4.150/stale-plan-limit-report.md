---
title: A plan limit that already reset no longer stalls a crew
kind: improvement
area: app
steps:
  - open: settings/general
    target: settings-readiness-claude-note
    caption: Claude Code 2.1.332 stops reporting a plan limit after it has reset.
    action: none
---
When Claude Code reports a plan limit that has already reset, the crew resumes once without using one of its three automatic resumes. If it happens again, the crew waits for you and says to update to Claude Code 2.1.332, which fixes it. Readiness now recommends that release.
