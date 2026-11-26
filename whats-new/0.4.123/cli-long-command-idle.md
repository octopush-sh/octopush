---
title: Long test runs no longer time out a Claude stage
kind: fix
area: app
highlight: false
steps:
  - open: mode/direct
    target: direct-halt-cause
    caption: If a command really hangs, the halt names it.
    action: none
---
A Claude Code stage running a slow command that prints nothing, such as a 9-minute test suite, is no longer stopped after 5 silent minutes. While a Bash or PowerShell call is open, Octopush waits as long as Claude Code does (`BASH_MAX_TIMEOUT_MS`, 10 minutes by default) plus a minute.
