---
title: Talk asks before MCP writes and files outside the workspace
kind: fix
area: app
---
Talk now asks before it calls an MCP tool that isn't marked read-only, and before it reads or
writes a file outside the workspace, links included. Places that usually hold credentials, such
as `~/.ssh`, say so and lead with Deny. A file outside the workspace asks every time.
