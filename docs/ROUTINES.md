# Maintenance routines

Octopush maintains itself in two places:

- **The nightly cycle runs in GitHub Actions** — builder, review and auto-merge, the beta release,
  the ideas digest and your answers, and the same builder → review → audit loop for the website
  (octopush-web), which you merge with one word. Nothing runs on your Mac and it can be off. Claude works with
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
| 00:49 | [`web-audit.yml`](../.github/workflows/web-audit.yml) | builds octopush-web's `main`, renders every page in **Chromium** at 1440×900, 1024×700 and 390×844 and runs the layout checks plus website ones (content past the window edge on mobile, placeholder copy, retired glyphs, italics, missing title/description/social tags, broken internal links and anchors); new defects become `visual` issues **in octopush-web**, the first two `ready` for the web builder, never on legal/pricing pages ([scripts/web-audit/](../scripts/web-audit/README.md)) |
| every 2 h (odd hours, :07) | [`nightly-build.yml`](../.github/workflows/nightly-build.yml) | each run takes one job — a PR the review sent back or whose CI is red, else the oldest `ready` issue — and a Claude agent builds it; the workflow opens or updates the PR (label `agent`) and starts CI |
| every 2 h (odd hours, :37) | [`web-build.yml`](../.github/workflows/web-build.yml) | the website's builder: one job per run — a web PR the web review sent back or whose CI is red, else the oldest `ready` octopush-web issue, else the oldest app-repo issue labelled `area:web` + `ready` — built by a Claude agent in a checkout of octopush-web (its CLAUDE.md, checks via `octo-check build\|check\|consistency`, the app's stable `FEATURES.md` as the truth reference); the workflow opens or updates the PR in octopush-web (label `agent`) and, for an app-repo issue, comments the link there |
| every 2 h (even hours, :47) | [`nightly-review.yml`](../.github/workflows/nightly-review.yml) | an independent Claude reviewer judges each green agent PR (up to 3); `automerge.mjs` re-checks every rule on that exact commit and merges the approved ones (retrying earlier approvals whose merge was skipped for a transient reason), or parks them as `needs-owner` |
| every 2 h (even hours, :07) | [`web-review.yml`](../.github/workflows/web-review.yml) | an independent Claude reviewer judges each green web PR (up to 3) against octopush-web's CLAUDE.md, the truth rule (the app's `FEATURES.md` at its latest **stable** release), the design rules and the human-only areas, and posts the verdict. It never merges: approved web PRs are listed in the digest for your `merge web#N` |
| 05:13, 17:13 | [`nightly-release.yml`](../.github/workflows/nightly-release.yml) | if `main` moved and CI is green: notes, What's new tips, clips, version bump, release PR, CI, merge, tag → `release.yml` publishes a **beta** |
| 06:37 | [`ideas.yml`](../.github/workflows/ideas.yml) | a Claude agent researches; at least 5 ranked ideas across app, API and site are filed — app and API ones here (label `area:app\|api`), website ones in octopush-web — and one digest issue here lists them all |
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
- `merge web#12` → merges a website PR the web review approved (merging publishes it at the next
  deploy window). Approved ones are listed under **Needs you**. The script first re-checks, on the
  PR's current head: opened by the web builder from a branch of octopush-web into `main`, labelled
  `agent`, CI green, the web review's approval on that exact commit, no human-only path, no
  conflicts — otherwise it replies with the reasons and merges nothing. API PRs: merge them yourself
  on GitHub; `merge api#5` replies with the link and the checks.

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
  workflows act as `github-actions[bot]` (this repo) and the "Octopush Cycle" App's bot
  (octopush-web) and can never act as you.
- **The website lane uses a GitHub App, not a stored token.** octopush-web is private, so a
  workflow's own token can't reach it. The "Octopush Cycle" App (secrets `OCTOPUSH_APP_ID`,
  `OCTOPUSH_APP_PRIVATE_KEY`) is used only by `actions/create-github-app-token` to mint an
  installation token **scoped to octopush-web alone**, with the fewest permissions the step needs,
  valid for an hour at most and revoked at the end of the job. It goes only to fixed steps of
  `web-build`, `web-review`, `web-audit`, `ideas` and `answers` (as `OCTOPUSH_WEB_TOKEN`), never to
  an agent step or an environment an agent inherits: a token used before an agent runs (to pick a
  job, read PRs, build context, check out) is **revoked before the agent starts**, and a fresh one
  is minted afterwards to publish. **No job that runs the website's own code ever holds the App's
  private key** where that code could reach it (a job's secrets are on its runner, and the runner
  user has sudo). In both `web-build` and `web-audit` the website's code (`npm ci`, the build,
  `astro check`, the consistency gate) runs only through `octo-check` as `octo-sandbox` — another
  user, without sudo, with an empty environment, that can't read the runner's processes — and the
  key is used only before the sandbox exists and after a step has killed every sandbox process and
  checked that none survived. The web audit's read token is revoked (`if: always()`) and proved dead
  before the build; the audit itself — whose Chromium runs the built site's JavaScript — also runs
  as `octo-sandbox`, from scripts and a browser installed root-owned in `/opt/pw` before the
  checkout, and only regular, size-capped `findings.json` and screenshots come back out of the
  sandbox; a separate job on a fresh runner mints an issues-only token and files the findings. Publishing to
  octopush-web refuses its human-only paths (legal pages in any format, `src/legal-config.ts`,
  `src/data/release.ts`, `free-vs-pro`, analytics and `astro.config.mjs`, `src/content.config.ts`,
  `scripts/`, `vercel.json`, `.vercel/`, `api/`, `.github/`, agent docs, manifests, any page or
  static file at `/download`, `/api` or `/update`, which Vercel would serve before the rewrites, and
  root dynamic routes (`src/pages/[…].astro`), which could generate one — `WEB_HUMAN_ONLY` in
  `automerge.mjs`; `octo-check build` also fails if the built `dist/` has `download*`, `api` or
  `update`, and the web audit files that as an issue for you) and scans for the push token as well as the Claude token;
  the push token reaches git through the environment, never its command line. Pushes made with an
  installation token start octopush-web's CI on their own (only `GITHUB_TOKEN` pushes don't), so
  nothing is dispatched there. Website PRs never merge without your `merge web#N`; after the merge
  the app-repo `area:web` issue it was built for is closed with a link (the App can't close
  another repo's issue through a closing keyword). This repo is public: website PR titles, file
  names in refusals, and the web audit's findings and screenshots (kept 3 days, never of the legal
  pages) show up here.

**Residual risk:** an agent steered by a hostile issue or web page could still write bad code into
its PR or a misleading review — which is why merges need the independent review *and* every
deterministic rule, and reach only your beta. A website PR goes live when you merge it, so read
what the web review flags; the path guard can't see a pricing sentence edited inside
`src/pages/index.astro` (the reviewer and the web builder's brief treat it as human-only). The Claude token is a repository secret: GitHub
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
4. **The website lane** (done): the GitHub App "Octopush Cycle" installed on the org's repos with
   Contents, Issues, Pull requests and Actions read & write; secrets `OCTOPUSH_APP_ID` and
   `OCTOPUSH_APP_PRIVATE_KEY` in this repo (the workflows live here) and in octopush-web, plus
   `CLAUDE_CODE_OAUTH_TOKEN` in octopush-web. Rotate the key in the App's settings → *Private keys*
   and update both secrets; uninstalling the App stops the website lane and nothing else.
5. **First runs:** Actions → `ideas` → *Run workflow* to get the first digest; answer it; then run
   `nightly-build` by hand to watch one build end to end (`web-build` for the website).

Scheduled workflows in a public repo pause after 60 days without repository activity; the nightly
cycle itself keeps the repo active.

### Costs

Claude usage comes from your subscription's limits (no API billing). Runner minutes are free on
public repositories — the website lane runs here for that reason, even though it works on the
private octopush-web. Per run: one build, up to three reviews per lane; one ideas run a day.

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
