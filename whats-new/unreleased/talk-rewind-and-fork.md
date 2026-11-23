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
Talk takes a checkpoint before each turn that can change files in a git repository. Hover a
message you sent: **Rewind files to here** shows what will change and what it leaves untouched
(git-ignored files always are), then offers an undo for a few seconds. **Fork from here** starts a
new conversation. Checkpoints are git objects under `refs/octopush/talk/`, untracked files included.
