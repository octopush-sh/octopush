---
title: Talk shows @ attachments as chips under your message
kind: improvement
area: app
steps:
  - open: mode/talk
    target: talk-turn-context
    caption: Your message reads as you typed it. Each chip opens what was attached, as the model got it.
    action: none
---
A message with `@` files, ranges, sessions or the diff now shows what you typed, with a chip per
attachment that opens it in place. From the next turn on, an attachment of 8,000 characters or more
is sent shortened, and the model can fetch it whole again when it needs it.
