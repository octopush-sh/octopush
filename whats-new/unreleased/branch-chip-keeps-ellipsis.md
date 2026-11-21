---
title: Long branch names always show their ellipsis
kind: fix
area: app
steps:
  - target: header-branch
    caption: A long branch keeps its start and its end, with a … between them.
---
A long branch name in the workspace header, or a long name in the rail, could be cut off with no
`…` on macOS. Now it always keeps the ellipsis between the start and the end of the name.
