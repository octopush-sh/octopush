---
title: Quiet Claude Code in crews and Routines
kind: feature
area: app
highlight: true
steps:
  - open: settings/privacy
    target: settings-quiet-claude-code
    caption: Turn this on to start Claude Code in crew stages and Routines without its nonessential traffic. It's off until you do.
    action: none
---
A new Settings › Privacy toggle, off by default, starts Claude Code for crew stages and Routines with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, so it skips its auto-updates, telemetry, error reporting, release notes and availability checks. Features that need feature-flag fetching, such as Remote Control, don't work in those sessions. Run terminals are not affected.
