---
title: Sandbox catches protected names written with ligatures
kind: fix
area: app
---
A sandboxed Codex stage can no longer write a protected file in a Codex home by spelling its name with a ligature such as `ﬁ` or `ﬆ`. The volume treats those as the plain letters, and now the sandbox does too.
