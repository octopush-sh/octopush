---
title: Stop during a crew keeps the reports already in
kind: fix
area: app
steps:
  - open: mode/talk
    target: talk-crew-ending
    caption: A sub-agent you stopped reads as stopped. The ones that finished keep their reports.
    action: none
---
Stopping a Talk turn while sub-agents run no longer drops their work. Every report that came in stays in the thread and in what the next turn reads. A sub-agent cut off reads as stopped, and you can let it finish from its journal.
