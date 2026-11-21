## Octopush 0.4.137

### Improvements

- **A running Claude stage shows how full its context is** — A Claude Code stage in Direct now shows how full its context window is, so you can see when a long stage is about to compact. It works for detached runs and `[1m]` models, and stays hidden when the model's window isn't known.
- **Sync names library items it couldn't store** — Library sync now names any pipeline or role the sync service refused, and why (for example, over the 64,000-byte limit), and keeps it unsent. Run history pulls every page, so all your synced runs show up, and later library pulls ask only for what changed.

### Fixes

- **Sandboxed missions keep Codex out of your ~/.codex** — In a sandboxed mission a Codex writer stage now gets its own `CODEX_HOME` with a read-only copy of your config, and can't write `~/.codex`. A read-only Codex stage there is refused before the run, and a ChatGPT sign-in older than a week stops the stage with "Open Codex once to refresh sign-in". The launcher still suggests a Claude model for these missions.
