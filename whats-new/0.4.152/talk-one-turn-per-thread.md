---
title: Each conversation runs its own turn, with its own Stop
kind: fix
area: app
---
Switching back to a conversation whose turn is still running shows it running, and Stop reaches
that turn. A conversation never runs two turns at once, and switching quickly between
conversations can no longer show one's messages under another or let Edit & resend cut the wrong history.
