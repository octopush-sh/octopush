# Maintenance routines

Octopush maintains itself with **Octopush Routines** (Settings → Routines) running on the owner's
Mac. Each routine has a **fire condition** — a deterministic script in `scripts/routines/` that
decides whether there is work (exit 0 ⇒ fire; non-zero ⇒ skip the window with no run and zero
tokens) — and a **brief** for the crew. The brief's agent only does what needs judgement.

All routines follow [`VISION.md`](../VISION.md) §8: output is a PR, an issue or a comment; never
merge, release or deploy; human-only areas stay `proposal` issues.

**Requirements on the Mac:** this repo cloned and up to date (`git pull` after merging changes
to `scripts/routines/`), `gh` authenticated, Node via nvm or Homebrew. The scripts add
`~/.local/bin`, Homebrew and nvm to `PATH` themselves, because Octopush runs fire conditions
with the minimal GUI `PATH` (see #247). State lives in `~/.local/state/octopush-routines/`.

**Exit codes:** a condition exits 0 to fire and 1 when there is nothing to do; 2 means the
check itself failed (e.g. `gh` not authenticated). Octopush currently shows both 1 and 2 as
"condition not met" (#247), so if a routine never fires, run its condition by hand.

**Testing a routine:** use *Run now* in Settings → Routines — it goes through the same fire
condition and reports whether it dispatched or skipped, and why. To run a condition by hand:
`env -i HOME="$HOME" PATH=/usr/bin:/bin bash scripts/routines/<script>.sh check; echo $?`.

Production deploys of the website and API are separate routines in those repos
(`scripts/deploy-if-ready.sh`, see their READMEs).

---

## 1. Claude Code release watch — daily

Claude Code changes fast and Octopush parses its formats (VISION.md §6). This routine reads each
new release before it reaches users' machines.

| Field | Value |
|---|---|
| Project · workspace | `octopush` · **Fresh** (its own worktree, so a fix PR never touches your checkout) |
| Schedule | Custom → Every day → Once at **09:40** |
| Fire only if… | `bash scripts/routines/claude-code-release.sh check` |
| Pipeline | one stage, Sonnet, CLI substrate (needs shell + `gh`) |
| Budget | $1 |

Brief:

```text
Claude Code release watch. Read VISION.md §6 and §8 first.
1. Run `bash scripts/routines/claude-code-release.sh show`. VERSION = its "latest on npm" value.
   If it prints "NO CHANGELOG SECTION", stop now without acking (it retries tomorrow).
2. For every changelog entry, decide whether it can affect a fragile surface in VISION.md §6
   (stream-json events, transcript JSONL, --resume, `claude mcp add`, skills/agents frontmatter,
   the `Total cost:` line, CLI flags Octopush passes). Open the source files to check — don't guess.
3. If scripts/record-claude-fixtures.sh exists, OCTOPUSH_FIXTURE_ANTHROPIC_KEY is set and
   `claude --version` is VERSION, run `bash scripts/record-claude-fixtures.sh`, then
   `cd src-tauri && cargo test claude_code_contract`, and record the results. Otherwise say in the
   issue that fixtures were not re-recorded. Never read or write ~/.claude yourself.
4. Open ONE issue labelled `claude-code-update`, titled
   "Claude Code VERSION: impact none | review | breaking", with the relevant changelog lines, a
   verdict per surface (with file paths), the test results and a proposed fix. If a fix is needed
   and small, commit it on this workspace's branch and open a PR whose body starts with
   "Closes #<issue>". Never merge.
5. Only after the issue exists, run `bash scripts/routines/claude-code-release.sh ack VERSION`.
```

## 2. Backlog → PR — daily

Turns one owner-approved issue (label `ready`) into a pull request per day.

| Field | Value |
|---|---|
| Project · workspace | `octopush` · **Fresh** (a new worktree and branch per fire) |
| Schedule | Custom → Every day → Once at **13:10** (fresh mode allows at most one fire a day) |
| Fire only if… | `bash scripts/routines/backlog.sh check` |
| Pipeline | your full Direct pipeline (plan → plan review → implement → code review → tests) |
| Budget | $5 |

Brief:

```text
Backlog → PR. Read VISION.md (especially §8) and CLAUDE.md first.
1. Run `bash scripts/routines/backlog.sh next` to get the issue (number, title, url), then read it
   fully with `gh issue view <number> --comments`.
2. If it touches a human-only area in VISION.md §8 and has no `agent-ok` label, or it is too
   ambiguous to implement safely: comment your plan and questions on the issue, then park it with
   `gh issue edit <number> --remove-label ready --add-label needs-owner`, and stop. (Parking is
   what keeps the routine from picking the same issue again tomorrow.)
3. Otherwise implement it on this workspace's branch with tests; update docs/FEATURES.md if it is
   user-facing; run `npm run typecheck`, `npm test`, and `cd src-tauri && cargo test` for Rust.
4. Push and open a PR whose body starts with "Closes #<number>" (exactly — the routine uses it to
   know the issue is taken) and explains the change and its tests. Wait for CI (`gh pr checks <pr> --watch`) and fix until it is green.
5. Comment the PR link on the issue. Never merge, never deploy, never work on another issue.
```

## 3. Dependency triage — weekly

Dependabot opens update PRs every Monday in all three repos. This routine tells the owner which
ones are safe and fixes the small breakages.

| Field | Value |
|---|---|
| Project · workspace | `octopush` · **Fixed** → the main workspace (comment-only: it never switches branches) |
| Schedule | Custom → Weekdays → Once at **15:20** (fires only when a PR has finished CI and isn't triaged yet) |
| Fire only if… | `bash scripts/routines/deps.sh check` |
| Pipeline | one stage, Sonnet, CLI substrate |
| Budget | $2 |

Brief:

```text
Dependency triage. Read VISION.md §8 first. You only comment: never check out, switch or push
branches, never merge or close PRs (a push to a Dependabot branch would stop Dependabot from
rebasing it).
1. Run `bash scripts/routines/deps.sh list`: the Dependabot PRs in octopush, octopush-api and
   octopush-web whose CI has finished and that haven't been triaged on their current commit.
2. For each, comment once on the PR, ending the comment with `<!-- octopush-triage:<head-sha> -->`
   (the sha is the third column; the marker is how the routine knows it's done):
   - CI success: read the release notes for the bumped range (linked in the PR body) and say
     "Safe to merge: <one line why>" or "Needs owner review: <why>" (majors, breaking changes,
     anything touching Tauri, the updater, signing, auth or payments).
   - CI failure: read the failing check's annotations
     (`gh api repos/<owner>/<repo>/check-runs/<id>/annotations`) and explain the cause and the
     smallest code change that would fix it.
3. Finish with a one-line summary per PR.
```

## 4. Weekly report — Fridays

The owner's weekly loop (VISION.md §9) starts from this issue.

| Field | Value |
|---|---|
| Project · workspace | `octopush` · **Fixed** → the main workspace |
| Schedule | Custom → Days of week: Fri → Once at **16:40** |
| Fire only if… | *(empty — always runs)* |
| Pipeline | one stage, Haiku, CLI substrate |
| Budget | $0.50 |

Brief:

```text
Weekly report.
1. Run `bash scripts/routines/weekly-report.sh collect`: the facts for the last 7 days in all
   three repos.
2. Open one issue in octopush-sh/octopush labelled `report`, titled
   "Weekly report — <ISO year-week, e.g. 2026-W44>", with:
   - **Needs you** first: PRs with green CI waiting for review (link each), red CI on main or on a
     PR, production behind main, waiting `proposal` issues, open `claude-code-update` issues.
   - **Shipped**: merged PRs per repo, one line each.
   - **Risks**: anything stuck (draft PRs older than a week, failing CI, deploy record missing or
     behind).
   Use only the facts from step 1 (confirm with `gh` if needed). Never invent; keep it scannable.
3. Change nothing else.
```
