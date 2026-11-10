---
title: Review shows its change counts once
kind: improvement
area: app
highlight: false
steps:
  - open: mode/review
    target: review-mode-tail
    caption: The file count and +/− lines live here, in the mode band.
  - target: review-companion-verdict
    caption: The Companion's verdict now counts files, like the diff beside it.
---
In Review, the Companion no longer repeats the file count and +/− lines the mode band already shows, and its verdict now reads "2 files to review." instead of "2 changes", so every count on screen names its unit.
