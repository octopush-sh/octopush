---
title: Review keeps its controls whole on a narrow window
kind: improvement
area: app
highlight: true
steps:
  - open: mode/review
    target: review-sidebar
    caption: On a narrow window the file list folds to an icon strip so the diff keeps its width. Expand it whenever you need it.
  - target: review-toolbar-more
    caption: When the toolbar runs out of room, diff layout, whitespace and tests move into this menu.
---
On a narrow window, Review now folds the Changes and Files list to its icon strip, and moves the diff
layout, whitespace and test controls into a **More** menu. The AI and Accept all buttons and every
hunk's Accept and Reject actions stay fully visible.
