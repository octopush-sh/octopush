# Maintenance routines

Octopush maintains itself in two places:

- **The nightly cycle runs in GitHub Actions** — builder, review and auto-merge, the beta release,
  the ideas digest and your answers. Nothing runs on your Mac and it can be off. Claude works with
  your Claude subscription (the `CLAUDE_CODE_OAUTH_TOKEN` secret).
- **A few optional, low-impact routines run as Octopush Routines on your Mac** (§1–§3 below) —
  they read, comment or open a PR for you to review, never merge; kept there to dogfood Octopush.

All of it follows [`VISION.md`](../VISION.md) §8: agents write code, reviews and ideas; fixed,
tested scripts in `scripts/routines/` do every merge, release and GitHub write after re-checking
the rules; human-only areas stay `proposal` issues. Production deploys of the website and API are
separate routines in those repos (`scripts/deploy-if-ready.sh`, see their READMEs).

---

## The cycle (GitHub Actions)

You approve ideas; everything else runs continuously (VISION.md §8–§9): the builder and the reviewer alternate every hour, betas go out twice a day. Times are Bogotá (UTC−5).

| Time | Workflow | What happens |
|---|---|---|
| 00:29 | [`visual-audit.yml`](../.github/workflows/visual-audit.yml) | renders every surface in **WebKit** (the macOS engine) with real-world data at three window sizes and runs layout checks (text escaping its box, text over text, sideways scroll, unlabeled controls); new defects become `visual` issues, the first two `ready` for the builder; then a Claude design reviewer reads the screenshots against the design system and files at most 3 findings as `proposal` ([scripts/visual-audit/](../scripts/visual-audit/README.md)) |
| every 2 h (odd hours, :07) | [`nightly-build.yml`](../.github/workflows/nightly-build.yml) | each run takes one job — a PR the review sent back or whose CI is red, else the oldest `ready` issue — and a Claude agent builds it; the workflow opens or updates the PR (label `agent`) and starts CI |
| every 2 h (even hours, :47) | [`nightly-review.yml`](../.github/workflows/nightly-review.yml) | an independent Claude reviewer judges each green agent PR (up to 3); `automerge.mjs` re-checks every rule on that exact commit and merges the approved ones (retrying earlier approvals whose merge was skipped for a transient reason), or parks them as `needs-owner` |
| 05:13, 17:13 | [`nightly-release.yml`](../.github/workflows/nightly-release.yml) | if `main` moved and CI is green: notes, What's new tips, clips, version bump, release PR, CI, merge, tag → `release.yml` publishes a **beta** |
| 06:37 | [`ideas.yml`](../.github/workflows/ideas.yml) | a Claude agent researches; at least 5 ranked ideas across app, API and site are filed (label `area:app\|api\|web`) and one digest issue lists them |
| any time | [`answers.yml`](../.github/workflows/answers.yml) | the moment you comment on the digest, your answers are applied and confirmed in a reply |

Every workflow also has **Run workflow** (Actions tab) for a manual run. Schedules sit off the hour on purpose: GitHub delays (and sometimes drops) scheduled runs at :00 under load.

### Answering the digest

One instruction per line (or several on one line), Spanish or English, accents optional:

- `1 sí` · `2 no` · `3 aún no` (`yes`, `later`, `luego`…; `1, 4 y 6 sí — a note` too) → the idea
  becomes `ready` (the builders take it), is closed, or is parked as `later` (it may come back in a
  month).
- `promote 0.4.91` → starts `promote.yml` for that beta; GitHub asks you to approve it (the
  `stable` environment), then it ships to every user.
- `idea: …` → files your own idea; the next digest estimates it.
- Website and API PRs are listed under **Needs you** with a link: merge them yourself on GitHub
  (merging deploys). `merge web#12` replies with the link and the checks.

Only your comments count, and the reply echoes what was applied — including your notes — so a
misread shows at once.

### What keeps it safe

The repos are public: anyone can write an issue, a comment or a PR, and an agent reading that text
could be steered by it. So no agent ever holds a GitHub credential, and nothing an agent writes is
trusted:

- **Agents run with nothing but the Claude token** (`scripts/routines/agent.mjs`): their environment
  is rebuilt from scratch and every tool call that isn't explicitly allowed is denied
  (`--permission-mode dontAsk`). File tools are allowed only inside the working directory (so not
  the runner's action code or tool cache, which run later with a token), and the process table,
  system and credential paths, the runner's temp dir and git config are denied on top. The
  reviewer, the design reviewer (`visual-audit.yml`) and the ideas agent can only write their output file; only the ideas agent can use the
  web. Transcripts stay on the runner — public Actions logs show only the exit code.
- **The builder runs code only through `octo-check`** (typecheck, tests, changeset check) — a
  root-owned copy of `scripts/routines/agent-check.sh` that runs the checks as a separate user with
  an empty environment, so code the agent writes can't reach the token.
- **Agents only write files.** Fixed steps then validate them, scan everything for the token, and
  do the GitHub writes with the workflow's token — from a copy of `scripts/routines` taken from
  `main` before any agent branch is checked out, with the checkout's `.git` moved out of the
  agent's reach (no planted hooks), dependencies installed without lifecycle scripts, and the
  sandbox's processes killed and the checkout frozen before publishing. A change may not touch any
  human-only path or add a symlink. Agent text is sanitized so it can't carry a routine marker (a
  forged review verdict), closing keywords in it are defused, and a verdict counts only as the
  last thing in a reviewer comment.
- **The reviewer sees the PR without its tricks:** no symlinks, no `CLAUDE.md`/`AGENTS.md`/`.claude`
  from the PR anywhere in the tree (main's are used), and a diff with no textconv or external
  diff drivers.
- **The nightly release runs no agent code:** no credentials persisted in the checkout,
  dependencies installed without scripts, and no clip recording in Actions (it would run the
  frontend next to the token).
- **Agents read GitHub only through `read.mjs`**, which shows text by you and the routines and
  never anyone else's — an outsider can edit their issue after you approve it, so when you mark an
  outsider's issue `ready`, restate the work in a comment of yours.
- **Merges re-check every rule** on the PR's head commit (`automerge.mjs`): opened by the
  workflow from a branch of this repo into `main`, labelled `agent`, CI green, an approving review
  on that exact commit, no human-only paths (renames too), ≤ 800 changed lines, a changeset for
  user-visible changes, no conflicts, and the beta channel live. Merges reach the **beta** channel
  only; stable needs your approval.
- **Identities:** your account (`OCTOPUSH_OWNER_LOGIN`) is the only one whose answers count; the
  workflows act as `github-actions[bot]` and can never act as you.

**Residual risk:** an agent steered by a hostile issue or web page could still write bad code into
its PR or a misleading review — which is why merges need the independent review *and* every
deterministic rule, and reach only your beta. The Claude token is a repository secret: GitHub
withholds secrets from fork PRs, and the scan above stops it appearing in anything published.
Revoke it any time with `claude setup-token` → new token, or by deleting the secret.

### Setup (once)

1. **Claude token.** In a terminal on your Mac: `claude setup-token`, then in the repo
   Settings → Secrets and variables → Actions → *New repository secret* `CLAUDE_CODE_OAUTH_TOKEN`
   with the value. (Never paste it in a chat.)
2. **Let workflows open PRs.** Settings → Actions → General → *Workflow permissions*: check
   **Allow GitHub Actions to create and approve pull requests**.
3. **Owner and stable approval** (done): repository variable `OCTOPUSH_OWNER_LOGIN`, environment
   `stable` with you as required reviewer (docs/RELEASING.md).
4. **First runs:** Actions → `ideas` → *Run workflow* to get the first digest; answer it; then run
   `nightly-build` by hand to watch one build end to end.

Scheduled workflows in a public repo pause after 60 days without repository activity; the nightly
cycle itself keeps the repo active.

### Costs

Claude usage comes from your subscription's limits (no API billing). Runner minutes are free on
public repositories. Each night: up to two builds, up to three reviews, one ideas run.

---

## Routines on your Mac (optional, low-impact)

Octopush Routines (Settings → Routines) run on your Mac while Octopush is open. Each has a **fire
condition** — a deterministic script in `scripts/routines/` that decides whether there is work
(exit 0 ⇒ fire; non-zero ⇒ skip the window with no run and zero tokens) — and a **brief** for the
crew. They only read, comment or open a PR for you to review — never merge — so they run as you.

**Requirements:** this repo cloned and up to date, `gh` authenticated, Node via nvm or Homebrew.
The scripts add `~/.local/bin`, Homebrew and nvm to `PATH` themselves, because Octopush runs fire
conditions with the minimal GUI `PATH` (#247). State lives in `~/.local/state/octopush-routines/`.

**Exit codes:** 0 fires, 1 means nothing to do, 2 means the check itself failed. Octopush currently
shows 1 and 2 alike as "condition not met" (#247): if a routine never fires, run its condition by
hand: `env -i HOME="$HOME" PATH=/usr/bin:/bin bash scripts/routines/<script>.sh check; echo $?`.

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

## 2. Dependency triage — weekly

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

## 3. Weekly report — Fridays

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
