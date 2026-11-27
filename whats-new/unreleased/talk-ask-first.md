---
title: "Ask first: each change in Talk waits for your OK"
kind: feature
area: app
steps:
  - open: mode/talk
    target: talk-permission-mode
    caption: Choose what Talk may do here without asking. Plan only, Ask first or Edit freely; ⌘⌥P in the composer moves to the next.
  - open: palette
    target: palette-talk
    caption: ⌘K sets the mode too.
---
Talk has a new permission mode. In **Ask first**, each file change waits on an approval card that shows its diff, and so
does each command that may write; commands that only read run as before. The mode control sits in the composer bar, with
**⌘⌥P** to switch modes while the composer has the focus.
