---
title: Sandboxed stages can't undo each other's confinement
kind: fix
area: app
---
A sandboxed stage now gets its profile inline instead of from a temp file another running stage could overwrite. Build caches now live outside the shared temp dir, in one folder per workspace and access mode, so a stage can't plant config in another workspace's cache or turn its own cache folder into a link that widens the next stage's sandbox.
