---
title: The Direct ledger states its savings once
kind: fix
area: app
steps:
  - open: mode/direct
    target: direct-ledger-strip
    caption: The ledger prints how far under all-premium the run is, with no bar beneath to contradict it.
    action: none
---
The Direct run ledger no longer draws a brass bar under its line. The bar filled to the share
spent while the text printed the share saved, so the two read as opposite numbers.
