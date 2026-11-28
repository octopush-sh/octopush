---
title: Talk keeps the end of a long command's output
kind: fix
area: app
steps:
  - open: mode/talk
    target: talk-tool-verdict
    caption: When a long command fails, the agent now sees how its output ended, not just how it began.
    action: none
---
When a command in Talk prints a lot, the agent now sees its first and last lines, and more of the end when the command fails, so the failing test and the summary are no longer lost. It can read the whole output, up to 4 MB, without running the command again. Error lines now appear in the order the command printed them.
