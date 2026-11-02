---
title: Viewed files reopen when the agent changes them
kind: fix
area: app
highlight: true
steps:
  - open: mode/review
    target: review-file-viewed
    caption: Mark a file viewed and it folds away, as before.
    action: none
  - target: review-file-changed
    caption: If the agent edits it again, it reopens with a "changed since viewed" chip.
    action: none
---
In Review, a file you marked viewed now reopens when the agent changes it again, with a quiet
**changed since viewed** chip until you mark it again. Viewed marks no longer carry over to
another workspace.
