---
title: Connect to Claude Code handles a busy config
kind: fix
area: app
highlight: false
steps:
  - open: settings/integrations
    target: settings-claude-code-card
    caption: Connect now waits out a busy Claude Code config and checks the server really registered.
    action: none
---
**Connect** in Settings › Integrations retries once when Claude Code's config is locked by another job,
then says it's busy instead of showing a raw error. It reports Connected only once Claude Code lists
the server; if that check runs out of time, it says so instead of reporting the registration as missing.
The card's status check gives up after 3 s.
