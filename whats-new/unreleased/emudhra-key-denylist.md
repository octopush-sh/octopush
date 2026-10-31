---
title: Compromised eMudhra CA keys are refused
kind: fix
area: app
---
Requests to AI providers, gateways, sign-in, Jira and GitHub now refuse certificates from the eight eMudhra intermediate CAs compromised in October 2026, on top of your Mac's trust store. These connections now need TLS 1.2 or newer with modern cipher suites; a self-hosted gateway or proxy that offers only older ones will fail with a clear error.
