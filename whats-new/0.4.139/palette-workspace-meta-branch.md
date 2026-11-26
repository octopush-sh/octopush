---
title: Palette workspace rows lead with the branch
kind: fix
area: app
steps:
  - open: palette
    target: palette-workspaces
    caption: With one project open, each row's meta line is its branch, so similar branches stay apart.
---
With a single project open, the ⌘K palette's workspace rows no longer repeat the project name on
every meta line; the branch gets the full width. Hover a line to see the project.
