---
title: See each settled crew's diff size in Mission Control
kind: feature
area: app
highlight: true
scenario: stress
steps:
  - open: mission-control
    target: mission-control-card-size
    caption: How much code each settled or waiting crew left for you to review, against its base branch.
    action: none
  - target: mission-control-settled-order
    caption: Switch the Settled band to smallest diff first to clear the quick reviews.
    action: none
---
Settled and needs-you cards in Mission Control now show the size of the crew's diff against its base branch, like `+120 −40 · 6 files`. The Settled band can be ordered **Smallest first** as well as oldest first.
