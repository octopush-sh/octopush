---
title: Push and PR workspaces check the branch name first
kind: fix
area: app
---
Pushing, and starting a workspace from a pull request, now refuse a branch name git wouldn't take as a branch (such as one starting with `-`) before any shell runs, and say so without repeating the name.
