## Octopush 0.4.125

### Improvements

- **A warning before a crew's model retires** — When a crew uses a model with a published retirement date (today Sonnet 4.5, on Nov 30), the Direct launcher, Readiness and Settings › Routines warn you in its last 30 days and after it. **Switch to Sonnet 5.5** moves only that crew, and only after you confirm. A Routine on a built-in crew, or one that picks the model in its own stage overrides, says what fixes it instead.
- **Sandboxed missions keep file reads in the worktree** — In a mission you set to sandbox, Claude Code stages can't use their file tools to read outside the worktree (`~/.ssh`, a sibling repo), and shell commands that read there are refused. Sandboxed Claude stages get a private temp folder per workspace, which no sandboxed launch of another kind can write. A program that opens a file on its own can still read it. Needs Claude Code 2.1.257 or newer.
- **Crew stages keep the skills they started with** — On Claude Code 2.1.321 or newer, a Direct stage no longer reloads `.claude/skills` when a file there changes mid-stage, so a stage can't rewrite its own instructions while it works. A skill edit takes effect from the next stage. Claude Code in Run terminals still reloads skills as they change.

### Fixes

- **Sandbox build caches no longer pile up** — Deleting a workspace now removes its sandbox build caches (npm, cargo and the like) from `~/Library/Caches/octopush`, and caches no stage has used for 30 days are cleared on launch.
- **A failed Codex stage no longer reads $0.00 either** — A Codex stage that fails or crashes before Codex reports its last turn's tokens now reads **usage not reported** in the run ledger, even on an expired login, since Codex doesn't say what a failed turn spent. Earlier turns' cost is kept, plus "+ usage not reported". A stage that fails before Codex starts a turn (say, a bad flag) still reads $0.00.
- **Fix failing checks keeps your brief and fences its logs** — **Fix failing checks…** now adds its brief below anything you already typed in the launcher instead of replacing it. The CI log, PR title and check names are marked as untrusted data, and a log can no longer break out of its block. A PR with more than 100 checks now counts all of them, so a failing check past the first 100 shows on the PR chip.
- **Run history marks stages it can't price** — Run history marks stages Octopush can't price instead of showing $0.00. A run from another Mac that used an unknown or gateway model now reads "+ unpriced" beside its total.
