---
title: Sandbox restricts hard links to its write roots
kind: improvement
area: app
highlight: false
---
In a sandboxed mission, a stage can now create hard links only to files already inside its writable folders. Hard links inside the workspace, the temp folders and the build cache still work, so git, npm and cargo behave as before, and symlinks are unaffected.
