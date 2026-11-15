## Octopush 0.4.124

### Features

- **The Dock counts crews that need you, window closed or not** — The Dock icon now shows how many crews need you. Closing the window hides it, so Routines and running crews keep going. Click the Dock icon to bring it back, and press **⌘Q** to quit.

### Fixes

- **Codex stages can install and build again** — A Codex CLI stage that changes files now writes npm, cargo and other build caches to its own cache folder, so `npm install` and `cargo build` work inside Codex's sandbox. Codex keeps `.git` read-only there, so the launcher now warns when a commit-or-push stage runs on Codex.
