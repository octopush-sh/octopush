---
title: Budgets now stop Claude Code stages mid-flight
kind: improvement
area: app
highlight: true
---
A run budget now caps each Claude Code stage at the budget it has left, the same way API stages already stop. A stage that reaches it pauses the run with the work and session kept, so you can resume, accept the partial work or re-run. It never escalates to a stronger model.
