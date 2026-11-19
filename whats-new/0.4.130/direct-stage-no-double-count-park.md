---
title: Budgets no longer park a run on a stage counted twice
kind: fix
area: app
---
Right after a Claude Code Direct stage finished, its spend could briefly count twice, so a run near a USD budget was parked for no reason. The duplicate is now removed the moment the stage reports its session.
