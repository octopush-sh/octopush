---
title: A failed Codex stage no longer reads $0.00 either
kind: fix
area: app
steps:
  - open: mode/direct
    target: direct-ledger-usage-unreported
    caption: A Codex stage that failed or crashed before reporting its last turn's tokens is counted here.
    action: none
  - target: direct-ledger-strip
    caption: Open the ledger to see each stage's cost.
    action: click
  - target: direct-ledger-usage-unreported-stage
    caption: That stage reads "usage not reported", or its known cost "+ usage not reported".
---
A Codex stage that fails or crashes before Codex reports its last turn's tokens now reads **usage not reported** in the run ledger, even on an expired login, since Codex doesn't say what a failed turn spent. Earlier turns' cost is kept, plus "+ usage not reported". A stage that fails before Codex starts a turn (say, a bad flag) still reads $0.00.
