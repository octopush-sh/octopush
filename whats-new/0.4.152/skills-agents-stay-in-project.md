---
title: A project's skills and agents stay inside the project
kind: fix
area: app
---
A project's skills and agent definitions are read only when they resolve inside its own repository,
and every file is size-checked first. The `/` menu names a skill it left out as "skipped: outside the
project". Your own skills and agents in `~/.claude` load as before.
