---
title: Reproduce, Verify and review stages stay read-only
kind: fix
area: app
---
Reproduce, Verify and review stages could apply the change themselves and commit it, so a Bugfix relay landed the fix three times. They are now told plainly not to edit files or commit; API stages also lose the file-write tools and Claude Code stages are denied git commits and pushes. They still run commands to reproduce, build and test.
