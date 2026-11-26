---
title: Claude Code update notes clear without a restart
kind: fix
area: app
highlight: true
scenario: default
steps:
  - open: settings/integrations
    target: settings-claude-code-card
    caption: On an old Claude Code, this card now shows the same update note as Readiness and the launcher.
  - open: settings/general
    target: settings-readiness-again
    caption: After you update Claude Code, check again here. The launcher stops warning on its next open.
---
After you update Claude Code, run the Readiness check again and the launcher and stage journals
stop warning, with no restart. Settings › Integrations now shows the sandbox-fix note too, and
an old CLI is told to update to 2.1.319, not to a version that still lacks the fix.
