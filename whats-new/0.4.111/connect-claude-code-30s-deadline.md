---
title: Connect to Claude Code answers within 30 seconds
kind: fix
area: app
---
**Connect to Claude Code** in Settings › Integrations now gives up after 30 seconds in all,
instead of up to about a minute when Claude Code's config stayed busy. A stuck call is stopped
along with anything it started, and a long reply from the CLI no longer reads as busy.
