---
title: The secret guard sees a key header added over a key body
kind: fix
area: app
steps:
  - open: settings/general
    target: settings-secret-guard
    caption: The guard now asks when a commit adds only a key's header line.
    action: none
---
A commit that added only the `BEGIN … PRIVATE KEY` line above key material already in the file
went through without a question. The guard now reads the unchanged line under the header, so it
asks.
