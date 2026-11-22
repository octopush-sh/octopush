---
title: The secret guard now checks Talk's commits and pushes
kind: improvement
area: app
steps:
  - open: mode/talk
    target: talk-secret-approval
    caption: When an agent's commit or push holds a possible secret, it waits here. This card has no "don't ask again".
  - target: secret-guard-dialog
    caption: A $ command you type gets the same check, and Run regardless covers that one run only.
---
A commit, push or `gh pr create` run in Talk is now checked for credentials first, whether the agent
runs it or you type it after `$`. You see the kind of secret and its file and line, never the value.
