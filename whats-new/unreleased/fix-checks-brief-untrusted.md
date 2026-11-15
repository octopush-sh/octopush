---
title: Fix failing checks keeps your brief and fences its logs
kind: fix
area: app
---
**Fix failing checks…** now adds its brief below anything you already typed in the launcher instead of replacing it. The CI log, PR title and check names are marked as untrusted data, and a log can no longer break out of its block. A PR with more than 100 checks now counts all of them, so a failing check past the first 100 shows on the PR chip.
