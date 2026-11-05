---
title: Claude Code hooks follow the setting in every workspace
kind: improvement
area: app
steps:
  - open: settings/general
    target: settings-claude-hooks
    caption: On, Octopush adds its hooks to every workspace it made; off, it removes them.
    action: none
---
With **Let Claude Code say what it's waiting on** on, workspaces created before the update now
get Claude Code's hooks at launch too (Claude Code 2.1.314 or later). Turning it off removes
Octopush's entries from those workspaces right away.
