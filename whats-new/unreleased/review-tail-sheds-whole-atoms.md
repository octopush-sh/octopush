---
title: The Review status line no longer ends in an ellipsis
kind: fix
area: app
highlight: false
steps:
  - open: mode/review
    target: review-mode-tail
    caption: On a narrow window the line drops "changed", then the line counts — never half a value.
---
The mode band's Review status ("2 files changed · +2 −1") no longer gets cut to "2 files changed · …" when the canvas is narrow. It drops whole parts instead, "changed" first and then the line counts, so it always ends on a complete value, and the full reading stays in its tooltip.
