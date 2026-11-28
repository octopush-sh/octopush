---
title: Talk asks before a command follows links to credentials
kind: fix
area: app
---
An agent command that follows links while it walks a folder, such as `zip -r`, `tar -h` or `rg -L`, now asks first, with Deny leading, when a link in that folder leads to a place that holds credentials, such as your home folder. A folder too large to scan quickly asks too.
