---
title: Claude Code stages finish when their result arrives
kind: improvement
area: app
highlight: false
---
A Claude Code stage that starts a dev server or a watch build in the background no longer holds the run for five minutes or more after it finishes. Octopush waits 30 seconds after the stage's result, then stops the CLI and moves on, and the journal says so.
