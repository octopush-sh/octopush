---
title: A stopped Codex stage no longer reads $0.00
kind: fix
area: app
steps:
  - open: mode/direct
    target: direct-ledger-strip
    caption: Open the ledger to see each stage's cost.
    action: click
  - target: direct-ledger-usage-unreported
    caption: A Codex stage stopped before it reported its tokens reads "usage not reported", not $0.00.
---
A Codex stage stopped before Codex reported its tokens (Stop, a stall or the 60-minute cap) now reads **usage not reported** in the run ledger instead of $0.00. It stays out of spend and savings, and with a budget the ledger says the budget can't see it.
