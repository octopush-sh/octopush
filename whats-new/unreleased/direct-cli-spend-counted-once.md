---
title: Claude CLI stages are counted once in your spend
kind: fix
area: app
---
A Claude CLI stage's spend was also read back from its Claude Code transcript, so the mission Logbook, Settings › Usage and budgets showed about twice the real cost. Each stage now counts once, and the duplicate rows already recorded are removed.
