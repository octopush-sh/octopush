---
title: Talk asks before commands that reach outside the workspace
kind: fix
area: app
---
An agent command that names a path outside the workspace now asks first, like the file tools do,
and one that names a place that usually holds credentials, such as `~/.ssh/id_ed25519`, leads with
Deny. The check reads the paths a command is written with, so it is a net, not a sandbox.
