---
title: Claude Code says what it's waiting on
kind: feature
area: app
steps:
  - open: settings/general
    target: settings-claude-hooks
    caption: On by default. Octopush adds hook entries to the workspace's .claude/settings.local.json and keeps that file out of git.
    action: none
---
In a Run terminal, Claude Code now tells Octopush when it is **waiting on permission** or **waiting on your input**. Mission Control shows it on the card and a notification names the workspace. Turn it off in Settings › General.
