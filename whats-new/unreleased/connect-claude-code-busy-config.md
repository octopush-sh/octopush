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
**Connect** in Settings › Integrations retries once on a busy Claude Code config and stops any CLI call stuck past 20 s, then says it's busy instead of hanging. It reports Connected only once Claude Code lists the server, and leaves an identical registration alone. If the old registration was removed but re-adding failed, it says so: press Connect again to restore it.
