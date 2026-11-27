---
title: Talk stays read-only in a read-only mission
kind: fix
area: app
---
In a workspace whose mission is read-only, Talk and its sub-agents now refuse MCP tools whose
server doesn't mark them read-only, agent types that write, and commands that change something
elsewhere, such as `git push`. A command the read-only sandbox stops now says why.
