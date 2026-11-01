---
title: Review keeps its controls whole when space is tight
kind: improvement
area: app
highlight: true
steps:
  - open: mode/review
    target: review-sidebar
    caption: When the Review area is narrow, the file list folds to an icon strip so the diff keeps its width. Expand it whenever you need it.
---
When the Review area is under 760px wide, the Changes and Files list folds to its icon strip.
When the diff canvas itself is under 600px, the layout, whitespace and test controls move into a
**More** menu. AI, Accept all and each hunk's Accept and Reject always stay fully visible.
