---
title: Sandboxed stages can't undo each other's confinement
kind: fix
area: app
---
A sandboxed stage now gets its profile inline instead of from a temp file another running stage could overwrite. Each mission's build cache now lives in its own folder outside the shared temp dir, so one mission can't plant config in another's.
