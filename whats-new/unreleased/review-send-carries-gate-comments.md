---
title: Review's send-back carries the gate's comments
kind: improvement
area: app
steps:
  - open: mode/review
    target: review-hunk-comment
    caption: Ask for a change on a hunk.
    action: click
  - target: review-comment-pick-keys
    caption: In the field, ⌥↓ and ⌥↑ pick a line; add ⇧ to extend the range.
  - target: review-companion-send-comments
    caption: A send-back now takes the comments on the gate's plan along, in one message.
---
**Send to the agent** now sends back a waiting gate with the comments you wrote on its plan, in the same message. In Review, ⌥↑ ⌥↓ pick lines from the keyboard, and a half-typed note waits in its workspace when you switch away.
