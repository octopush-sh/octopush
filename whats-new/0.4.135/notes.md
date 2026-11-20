## Octopush 0.4.135

### Features

- **Drag sessions into the order you want** — Drag a session's icon on Run's session line to reorder your sessions. The order is saved, and ⌘⌥1–9, ⌘⌥←/→ and the ⌘⌥K switcher follow it. Panes keep the sessions they show.

### Improvements

- **Readiness shows your Codex version and its sandbox fix** — The Readiness card's Codex CLI row now shows the installed version. Codex 0.170.0 fixes permission updates and child threads losing sandbox restrictions, so on an older version the row turns amber and gives the update command. Each Codex stage's journal names the version it ran on.
- **Talk's terminal seat leaves with a minus, not an ×** — The terminal seat in Talk now leaves the view with a minus, as a Run pane does. An × read as "close", but the session keeps running in Run.

### Fixes

- **Stages say which tool calls Claude Code refused** — Claude Code now refuses some tool calls when nobody can be asked. A stage that had a call such as `git push` refused now says **N tool calls refused**, lists each one in its journal. A code-writing stage that finishes tells the next stage which calls never ran, so a review can check them.
