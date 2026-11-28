---
title: A .env that is a named pipe no longer hangs a read
kind: fix
area: app
---
Opening or `@`-mentioning a file that is a named pipe, socket or device, such as a `.env` served by a secrets manager, now fails at once with a plain message instead of hanging the editor or Talk.
