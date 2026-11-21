---
title: Scan a branch's commits for secrets, on demand
kind: feature
area: app
scenario: default
steps:
  - open: mode/review
    target: review-companion-scan-branch
    caption: Check every commit since the base for keys. It changes nothing.
    action: click
  - target: review-companion-scan-result
    caption: Each finding shows its prefix and last four characters, never the key.
---
Review's Companion can now scan every commit on a branch since its base for possible secrets with **Scan this branch's commits**. The secret guard's dialog shows a masked preview such as `sk-ant-…9fQ2`, so you can tell two keys apart.
