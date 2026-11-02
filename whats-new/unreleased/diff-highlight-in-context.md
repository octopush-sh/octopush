---
title: Review diffs colour every language, in context
kind: improvement
area: app
steps:
  - open: mode/review
    target: review-diff-hunk
    caption: Go, Kotlin, Shell, C and the rest are now coloured in the diff, like in the editor.
  - target: review-diff-hunk
    caption: A hunk inside a doc comment or a multi-line string reads as one, even when its opener is off-screen.
---
The Review diff now highlights every language the editor does, Go, Kotlin, Shell, C, C++, C#, Swift, Ruby, SQL, Lua, TOML and Dockerfile included. Lines are coloured in the context of the whole file, so doc comments and multi-line strings no longer read as code, and changed words keep their colours.
