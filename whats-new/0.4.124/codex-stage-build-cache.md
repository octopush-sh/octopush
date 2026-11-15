---
title: Codex stages can install and build again
kind: fix
area: app
highlight: true
steps:
  - open: mode/direct
    target: direct-launcher-codex-commit
    caption: A Codex stage that should commit or push gets this warning before the run.
---
A Codex CLI stage that changes files now writes npm, cargo and other build caches to its own
cache folder, so `npm install` and `cargo build` work inside Codex's sandbox. Codex keeps `.git`
read-only there, so the launcher now warns when a commit-or-push stage runs on Codex.
