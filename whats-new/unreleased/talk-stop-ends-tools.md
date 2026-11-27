---
title: Stop ends a running tool in Talk
kind: fix
area: app
steps:
  - open: mode/talk
    target: talk-tool-verdict
    caption: A command or search you stopped ends at once, and its row reads as stopped.
    action: none
---
Stop in Talk now ends a command running in a sandboxed mission, or in the isolated shell used while the shared one is busy, within a second, and ends a long grep or glob. A long search in one workspace no longer slows the conversations of another, and reading part of a large file no longer loads all of it.
