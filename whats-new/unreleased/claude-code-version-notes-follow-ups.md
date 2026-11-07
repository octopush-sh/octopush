---
title: Claude Code update notes clear without a restart
kind: fix
area: app
highlight: true
steps:
  - open: settings/integrations
    target: settings-claude-cli-update
    caption: Integrations now shows the same Claude Code update note as Readiness and the launcher.
  - open: settings/general
    target: settings-readiness-again
    caption: After you update Claude Code, check again here. The launcher stops warning on its next open.
---
After you update Claude Code, run the Readiness check again and the launcher and stage journals
stop warning, with no restart. Settings › Integrations now shows the sandbox-fix note too, and
an old CLI is told to update to 2.1.319, not to a version that still lacks the fix.
