---
title: A settings file from a newer build still loads
kind: fix
area: app
---
If settings.json holds an update channel this version doesn't know, for example after going back from a newer beta, Octopush now reads it as Stable and keeps your keys, git credentials and Jira setup. When the file can't be read at all, a notice at launch names the file.
