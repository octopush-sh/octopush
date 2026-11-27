---
title: Sub-agents count a failed run's spend and stop at budget
kind: fix
area: app
---
A sub-agent that fails after real work now bills it: the ledger, the thread and your budgets show
what it spent, and you can continue it from its journal. With a budget set, each sub-agent stops at
its share of what is left, retries and extra turns included, and an agent file's `max-cost: 0.50` caps that type's runs.
