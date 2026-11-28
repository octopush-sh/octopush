---
title: Talk at the keyboard, with Esc to stop a turn
kind: feature
area: app
steps:
  - open: talk/switcher
    target: talk-switcher-input
    caption: ⌘⌥K in Talk lists this workspace's conversations. Type to filter by title, ⏎ to switch, ⌘⏎ for a new one.
  - target: talk-switcher-row
    caption: In Run, the same keys list your sessions instead.
  - open: palette
    target: palette-talk
    caption: ⌘K has the same commands, copies the open conversation as Markdown and, while an approval card waits, focuses it (⌘⌥A).
---
**Esc** stops the running Talk turn, unless a popover, dialog, approval card, editor or terminal has the focus. **⌘⌥N**
starts a new conversation and **⌘⌥K** in Talk switches between them. **⌘⌥A** focuses the oldest approval card waiting
in the conversation, so ⌘↵ or Esc answers it; a card never takes the focus by itself, so a stray keystroke can't answer
a command you haven't read.
