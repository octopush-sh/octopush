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
A Codex stage that fails or crashes before Codex reports its last turn's tokens now reads **usage not reported** in the run ledger, like a stopped one. A stage stopped partway through a later turn keeps its earlier turns' cost and adds "+ usage not reported". A stage that fails before any turn starts, such as on an expired login or an unknown model, still reads $0.00, because nothing was spent.
