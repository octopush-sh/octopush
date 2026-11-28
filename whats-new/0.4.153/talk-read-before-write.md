---
title: Talk reads a file before it overwrites it
kind: improvement
area: app
---
The agent now sees line numbers when it reads a file, so it can cite `path:line` and aim its edits. It can no longer overwrite an existing file it hasn't read, or one you changed after it last read it: your edits made while a turn runs stay. Sub-agents and API crew stages follow the same rule.
