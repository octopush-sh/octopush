## Octopush 0.4.129

### Improvements

- **Crews hear when another workspace changes their files** — When an implement or fix stage starts and its workspace changes the same files as another live workspace of the project, the crew now gets a one-line note naming that workspace and the files, so it avoids unrelated edits there. It costs a few dozen tokens and only appears when there is an overlap.
- **See a possible secret before you press Commit** — The Review Companion now says when your staged change holds a possible secret, before you commit. The guard also checks credentials in the `env` block of `.mcp.json` and `.cursor/mcp.json`, newly added `.pem` and `.claude/settings.local.json` files, and long hex keys assigned to names like `secret` or `api_key`.

### Fixes

- **A Claude stage that crashes keeps its estimated cost** — When Claude Code exited without finishing a Direct stage, the stage was recorded as free. It now keeps the cost estimated from what it streamed, priced per model, so the run ledger and your budget count it.
- **Collision marks clear when their peer is archived** — Archiving or deleting a workspace now clears the collision mark it left on the other workspace at once. The radar also catches an overlap inside a large untracked folder that only one side has.
- **Claude CLI stages are counted once in your spend** — A Claude CLI stage's spend was also read back from its Claude Code transcript, so the mission Logbook, Settings › Usage and budgets showed about twice the real cost. Each stage now counts once, and duplicates already recorded for recent stages are cleaned up on the next sync.
- **A calmer Logbook header** — In the Logbook, the selected project and period now show as a softly filled option instead of brass text, and the header's spent total is ivory, so the active filters stand out.
- **No stray space before a shortened name's ellipsis** — On macOS, a name shortened in the middle right after a space (a rail row, a branch) no longer shows that space before the `…`. Names holding a line or paragraph separator now read as one line.
- **Clearer genesis button, chat rows and amber halts** — "Set a crew on it" stays readable in every theme while it waits for a key. Clicking the end of a chat title opens that chat again, and a paused stage's Resume pulses amber, not brass.
