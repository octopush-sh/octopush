---
title: Rewind a Talk turn's files, or fork from it
kind: feature
area: app
highlight: true
scenario: default
steps:
  - open: mode/talk
    target: talk-turn-rewind
    caption: Hover a message you sent to put the files back as they were before it.
  - target: talk-turn-fork
    caption: Or fork a new conversation from that turn, with its text ready to send again.
---
Talk now takes a checkpoint of the worktree before each turn. Hover a message you sent and
choose **Rewind files to here** to see exactly what will change, including files changed outside
the conversation, then undo it if you change your mind. **Fork from here** starts a new
conversation from that turn.
