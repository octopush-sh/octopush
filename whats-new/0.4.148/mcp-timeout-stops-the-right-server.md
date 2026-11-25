---
title: A timed-out MCP call stops only its own server process
kind: fix
area: app
---
When a Talk MCP call times out, Octopush now stops the process that call was on, not a newer one started since. A server's output in an error is shorter, with tokens and auth codes redacted. A login shell whose background job keeps running no longer costs you its PATH.
