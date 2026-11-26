---
title: Talk shows @ attachments as chips and sends them once
kind: improvement
area: app
steps:
  - open: mode/talk
    target: talk-turn-context
    caption: Your message reads as you typed it. Each chip opens what was attached, as the model got it.
    action: none
---
A message with `@` files, ranges, sessions or the diff now shows what you typed, with a chip per
attachment that opens it in place. Later turns send the attachments abridged instead of whole, so a
long thread stays within the model's limit.
