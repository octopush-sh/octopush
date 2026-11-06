---
title: The composer's cost estimate stays on one line
kind: fix
area: app
steps:
  - open: mode/talk
    target: talk-composer-estimate
    caption: The estimate stays on one line. When the bar narrows, it drops "tokens" first, then the count.
    action: none
---
In Talk, the estimate beside Send (`≈ $0.02 · 3k tokens`) no longer wraps over several lines
in a narrow composer. It keeps a fixed width, and as the bar narrows it drops the word "tokens"
first, then the count. The full figure stays in its tooltip.
