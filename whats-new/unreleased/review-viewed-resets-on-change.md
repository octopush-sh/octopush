---
title: Viewed files reopen when they change again
kind: fix
area: app
highlight: true
steps:
  - open: mode/review
    target: review-file-viewed
    caption: Mark a file viewed and it folds away. If it changes again, it reopens with a "changed since viewed" chip.
    action: click
---
In Review, a file you marked viewed now reopens when the file changes again (say, the agent's
next pass), with a quiet **changed since viewed** chip until you mark it again. Viewed marks no
longer carry over to another workspace.
