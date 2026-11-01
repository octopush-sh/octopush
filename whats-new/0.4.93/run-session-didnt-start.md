---
title: A terminal that fails to start says why and retries
kind: fix
area: app
---
When a Run session can't start (no shell, a sandbox denial, the terminal service down), the canvas now says so in plain words, keeps the technical detail one click away and offers **Try the shell again**. The Companion reads *failed* instead of *shell idle*.
