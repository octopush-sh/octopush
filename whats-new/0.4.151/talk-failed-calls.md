---
title: A failed command in Talk reads as failed
kind: improvement
area: app
scenario: talk-outcomes
steps:
  - target: talk-tool-verdict
    caption: A call that failed keeps its rouge mark and its exit code. A denied one is marked in mute.
    action: hover
  - target: talk-work-fold
    caption: A folded round counts its failures.
    action: none
---
In Talk, a tool call that failed now says so after it ends: a rouge mark and its exit code or the
reason, such as `exit 1` or `timed out`. A command you denied is marked in mute, and a folded round
counts its failures.
