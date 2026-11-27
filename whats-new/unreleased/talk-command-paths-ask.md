---
title: Talk asks before commands that reach outside the workspace
kind: fix
area: app
---
An agent command that reads a place that usually holds credentials, such as `~/.ssh/id_ed25519`,
now asks first and leads with Deny, however the path is spelled. Other paths outside the workspace
ask too, except reads of system folders, and the card can allow reading a folder for the rest of
the conversation. The check reads the paths a command is written with, so it is a net, not a sandbox.
