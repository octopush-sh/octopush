---
title: Commits and clones are safe with any text under fish
kind: fix
area: app
---
Commit, amend and clone now pass the message, URL and target folder to git through the environment instead of quoting them into a shell command, so a backslash next to a quote can no longer break out of the quotes when your login shell is fish.
