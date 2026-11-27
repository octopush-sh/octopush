---
title: Talk asks before commands that reach outside the workspace
kind: fix
area: app
---
An agent command that names a place that usually holds credentials, such as `~/.ssh/id_ed25519`,
now asks first and leads with Deny, through braces, globs, links and `cd` too. Other outside paths
ask, except system folders, and a folder can be allowed for the conversation. A path built while
the command runs isn't seen: it is a net, not a sandbox.
