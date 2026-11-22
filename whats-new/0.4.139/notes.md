## Octopush 0.4.139

### Fixes

- **Older GPT-6 models need adding before Talk can use them** — A correction to the 0.4.130 note: GPT-6 Astra, Sol and Luna and GPT-6.1 Sol are priced for Codex stages and Claude Code sessions, but they aren't in the built-in model list. To use one in Talk or an API stage, add it in Settings › Models first.
- **Palette workspace rows lead with the branch** — With a single project open, the ⌘K palette's workspace rows no longer repeat the project name on every meta line; the branch gets the full width. Hover a line to see the project.
- **Review no longer shows the last workspace's changes** — After a commit, switching straight to another workspace no longer leaves the previous one's git status in Review. Holding Enter on "Show all models" in ⌘K no longer switches to the first model it reveals.
- **Spend figures read as data, not as accents** — Spend in the Logbook, the Mission Control header and Direct's ledger, current run and Logbook card is now ivory (totals) or sage (table rows) instead of brass, so they no longer compete with the marks that need you.
- **A stage that never reached the API says so** — A Claude Code stage that stalls at start-up, before its first request, now stops with "Claude Code sent no request in 5 minutes" instead of a plain silence. On Claude Code older than 2.1.327, which can hang there when a proxy holds a model's settings fetch, the halt card suggests updating.
