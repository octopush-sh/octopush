---
title: Rewind a Talk turn's files, or fork from it
kind: feature
area: app
highlight: true
scenario: default
steps:
  - open: mode/talk
    target: talk-turn-actions
    caption: Hover a message you sent. Once a turn has run, Rewind files to here puts its files back as they were before it.
  - target: talk-turn-fork
    caption: Or fork a new conversation from that turn, with its text ready to send again.
---
Talk now takes a checkpoint of the worktree before each turn that can change files in a git
repository. Hover a message you sent and choose **Rewind files to here** to see exactly what will
change, including files changed outside the conversation; the notice that follows offers an undo
for a few seconds. **Fork from here** starts a new conversation from that turn.
