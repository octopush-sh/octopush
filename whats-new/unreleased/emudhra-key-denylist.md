---
title: Compromised eMudhra CA keys are refused
kind: fix
area: app
---
Every request Octopush makes (AI providers, gateways, sign-in, Jira, GitHub) now refuses servers whose
certificate chain carries one of the eight eMudhra intermediate CA keys compromised in October 2026,
on top of your Mac's own trust store.
