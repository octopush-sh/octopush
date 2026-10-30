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

## The nightly cycle

The owner approves ideas; everything else happens overnight on the owner's Mac (VISION.md §8–§9).

| Time | Routine | What happens |
|---|---|---|
| 01:00, 01:40 | **Builders A and B** (§2) | each takes one job — a PR the reviewer sent back, else a `ready` issue — and opens or updates a PR |
| 03:00 | **Review & merge** (§5) | an independent reviewer approves or sends back each green agent PR; `automerge.sh` merges the approved ones that pass every rule |
| 05:00 | **Nightly beta release** (§8, `release-beta.sh`) | if `main` moved, cut a beta: notes, What's new tips, clips, tag → build → beta channel |
| 06:00 | **Ideas digest** (§6) | research → ≥ 5 ranked ideas across app, API and site → one digest issue to answer |
| every 15 min, 07:00–23:00 | **Digest answers** (§7) | applies your `yes` / `no` / `later` / `merge` / `promote` / `idea:` replies |
| 09:40 daily · weekdays · Fridays | release watch (§1) · dependency triage (§3) · weekly report (§4) | as before |

**Keep the Mac awake for it.** Routines fire only while Octopush is running and the Mac is
awake (a missed window catches up once on wake). Once:

```sh
sudo pmset repeat wakeorpoweron MTWRFSU 00:50:00   # wake every night before the builders
sudo pmset -c sleep 0 displaysleep 15              # on power: never sleep, screen off after 15 min
```

Leave the Mac on power with Octopush open (lid open, or closed with an external display).
Check `pmset -g sched` to confirm the wake schedule; `sudo pmset repeat cancel` removes it.

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

## 2. Nightly builders A and B — every night

Two identical routines, 40 minutes apart (fresh mode allows one fire per routine per day). Each
takes one job: first a PR the reviewer sent back, otherwise the oldest unclaimed `ready` issue.

| Field | Value |
|---|---|
| Project · workspace | `octopush` · **Fresh** (a new worktree and branch per fire) |
| Schedule | Builder A: Every day → Once at **01:00**. Builder B: Once at **01:40** |
| Fire only if… | `bash scripts/routines/backlog.sh check` |
| Pipeline | your full Direct pipeline (plan → plan review → implement → code review → tests) |
| Budget | $5 each |

Brief:

```text
Nightly builder. Read VISION.md (§8 above all), CLAUDE.md and docs/WHATS-NEW.md first.
1. Run `bash scripts/routines/backlog.sh next`. The first column says which job you have.

A) `pr <number> <branch> …` — the reviewer asked for changes on your earlier PR.
   `git fetch origin <branch> && git checkout <branch>` in this workspace, read the latest review
   comment (`gh pr view <number> --comments`), address every point, run the tests, push. Reply on
   the PR with what you changed. Done.

B) `issue <number> …` — claim it first: `gh issue edit <number> --add-label in-progress`, then read
   it fully (`gh issue view <number> --comments`).
   - If it touches a human-only area (VISION.md §8) without `agent-ok`, or it is too ambiguous to
     build safely: comment your plan and questions, run
     `gh issue edit <number> --remove-label ready --remove-label in-progress --add-label needs-owner`,
     and stop.
   - Otherwise implement it on this workspace's branch, with tests; update docs/FEATURES.md if
     user-facing; add the changeset `whats-new/unreleased/<slug>.md` (release note + tip + demo
     `steps`, adding `data-tour` ids where the steps point); run `npm run typecheck`, `npm test`,
     `node scripts/whats-new.mjs check`, and `cd src-tauri && cargo test` for Rust changes.
   - Push and open a PR whose body starts with "Closes #<number>", labelled `agent`
     (`gh pr create --label agent …`). Wait for CI (`gh pr checks <pr> --watch`) and fix until green.
     Remove `in-progress` from the issue and comment the PR link on it.
Never merge, never tag, never deploy, never work on a second job.
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

## 5. Review & merge — every night

An independent reviewer for every green agent PR. The agent only judges and writes the review;
`automerge.sh merge` is the only thing that merges, and it re-checks VISION.md §8's rules on the
PR's head commit (owner account, `agent` label, CI green, approving review on that commit, no
human-only paths, ≤ 800 changed lines, a changeset for user-visible changes, no conflicts).
Anything that fails a hard rule is labelled `needs-owner` and shows up in the digest.

| Field | Value |
|---|---|
| Project · workspace | `octopush` · **Fixed** → the main workspace (read-only: reviews via `gh`) |
| Schedule | Custom → Every day → Once at **03:00** |
| Fire only if… | `bash scripts/routines/automerge.sh check` |
| Pipeline | one stage, **Opus**, CLI substrate — a different model and role than the builders |
| Budget | $4 |

Brief:

```text
Independent code review. You did not write these PRs; your job is to stop bad code reaching the
owner's beta. Read VISION.md, CLAUDE.md and docs/WHATS-NEW.md first.
For each line of `bash scripts/routines/automerge.sh queue` (number, head sha, title, url):
1. Read the linked issue, the full diff (`gh pr diff <n>`), the changeset and the tests. Check:
   does it do what the issue asked and nothing else; correctness and edge cases; tests that would
   fail without the change; CLAUDE.md design and code rules; FEATURES.md updated; the changeset's
   note is true and its steps point at real data-tour ids; nothing in a human-only area.
2. Post ONE review comment (`gh pr comment <n> --body-file …`) with concrete findings, ending with
   the marker printed by `bash scripts/routines/automerge.sh marker <n> approve` if you would ship
   it to the owner's beta tonight, or `… marker <n> changes` if not (list exactly what to fix —
   the builders address it the next night).
3. If you approved, run `bash scripts/routines/automerge.sh merge <n>` and report its output.
Never merge any other way, never push commits, never approve your own changes.
```

## 6. Ideas digest — every morning

| Field | Value |
|---|---|
| Project · workspace | `octopush` · **Fixed** → the main workspace |
| Schedule | Custom → Every day → Once at **06:00** |
| Fire only if… | `bash scripts/routines/ideas.sh check` (today's digest not posted yet) |
| Pipeline | one stage, **Opus**, CLI substrate with web search |
| Budget | $3 |

Brief:

```text
Daily ideas for Octopush (app), octopush-api and octopush-web. Read VISION.md (who it's for,
principles, non-goals, priorities) and skim docs/FEATURES.md.
1. Run `bash scripts/routines/ideas.sh context` — priorities, EVERY existing idea (never repeat
   one, open or closed), `later` items you may resurface, what shipped this week.
2. Research what moved since yesterday: Claude Code, Codex and Cursor releases and changelogs;
   Conductor, Warp, Zed and other agentic-dev tools; developer discussions about agent workflows,
   worktrees, cost, review and trust. Prefer primary sources and keep the URLs.
3. Write at least 5 (at most 8) ideas to /tmp/octopush-ideas.json — a JSON array of objects with:
   title (≤ 90 chars), area (app | api | web), kind (feature | improvement | fix), value (1–5: how
   much it helps the primary user or the business), difficulty (S | M | L for the nightly
   builders), estimate (e.g. "2–4 h", "1–2 d"), why (the problem or opportunity, with evidence),
   proposal (what to build, concretely enough to become a `ready` issue), evidence (URLs), and
   resurface (an issue number) only when bringing back a `later` item. Mix areas; at least one
   fix or quality improvement; respect the non-goals; no ideas that only add complexity.
4. Run `bash scripts/routines/ideas.sh post /tmp/octopush-ideas.json` and report the digest URL.
   If it rejects the file, fix the JSON and run it again.
```

## 7. Digest answers — through the day

Turns the owner's replies on the digest into labels, merges, promotions and new ideas. It's
deterministic; the agent only runs it.

| Field | Value |
|---|---|
| Project · workspace | `octopush` · **Fixed** → the main workspace |
| Schedule | Custom → Every day → Window **07:00–23:00, every 15 minutes** |
| Fire only if… | `bash scripts/routines/answers.sh check` |
| Pipeline | one stage, Haiku, CLI substrate |
| Budget | $0.20 |

Brief:

```text
Run `bash scripts/routines/answers.sh apply` and report its output. Change nothing else.
```

Answer grammar (one per line, Spanish or English, accents optional): `1 yes` / `2 no` /
`3 later` (`sí`, `aún no`, `luego` work; `1, 4 y 6 sí — note` too) → `ready` / closed / `later`;
`merge web#12`, `merge api#5` (CI must be green); `promote 0.4.91`; `idea: …`.
