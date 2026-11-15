## Octopush 0.4.123

### Features

- **The PR chip shows your branch's CI checks** — The PR chip now shows the branch's CI checks, with the failing ones named in its tooltip. When a check fails, **Fix failing checks…** opens the Direct launcher with a brief naming the failures and the tail of their logs. You pick the crew and begin.

### Improvements

- **Drafting commits and PRs now uses current Claude models** — Commit and PR drafts, AI review and new builder stages default to Sonnet 5.5, and the project rename uses Haiku 5.5, so they cost less. Built-in crews on a fresh install use them too; crews you already have keep their models.
- **Readiness checks the Codex CLI when a crew uses it** — When a saved crew or Routine has a Codex CLI stage, the Readiness card adds a **Codex CLI** row: amber with `npm i -g @openai/codex` when it is missing, and on **Check again** whether it is signed in, with `codex login` to copy when it is not.

### Fixes

- **Long test runs no longer time out a Claude stage** — A Claude Code stage running a slow command that prints nothing, such as a 9-minute test suite, is no longer stopped after 5 silent minutes. While a Bash or PowerShell call is open, Octopush waits as long as Claude Code does (`BASH_MAX_TIMEOUT_MS`, 10 minutes by default) plus a minute.
- **Claude Code stages bring their questions to you** — Claude Code stages can no longer reach for its interactive question tool, which nobody can answer in a headless run. A stage that needs a decision now ends with the question, and the run pauses for you instead of guessing.
- **Codex effort reaches dated and namespaced model ids** — A Codex CLI stage on a dated or namespaced model id, such as gpt-5.5-2026-03-01 or openai/gpt-5.5, now gets that model's effort levels, matched the way Codex matches them. The Reasoning control now says correctly which level an unlisted one runs as, and why it is disabled.
- **A stopped Codex stage no longer reads $0.00** — A Codex stage stopped before Codex reported its tokens (Stop, a stall or the 60-minute cap) now reads **usage not reported** in the run ledger instead of $0.00, on the strip and in the breakdown. It stays out of spend and savings, and with a budget the ledger says the budget can't see it.
- **Long project names keep the end that tells them apart** — A long project name in the rail, the top bar and the Logbook scope switch now drops its middle instead of its end, so projects that share an org prefix stay apart. Hover for the full name. In the rail, the name also uses the whole line until you hover it.
- **Sandboxed stages can't undo each other's confinement** — A sandboxed stage now gets its profile inline instead of from a temp file another running stage could overwrite. Build caches now live outside the shared temp dir, in one folder per workspace and access mode, so a stage can't plant config in another workspace's cache or turn its own cache folder into a link that widens the next stage's sandbox.
- **The Shortcuts list shows the companion key correctly** — Settings › Shortcuts now lists Toggle companion as `⌘\`, with one backslash, so it matches the key that actually works.
- **Running stages no longer look like they need you** — Everywhere a run is shown in miniature (Mission Control, the Companion, run history and crew cards in Talk), the dot for a running stage is now verdigris with a faint halo instead of brass. Brass now only marks a crew that is waiting on you, so busy crews and crews that need you no longer look alike.
