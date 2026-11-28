# Maintenance routines

Octopush maintains itself in two places:

- **The nightly cycle runs in GitHub Actions** — builder, review and auto-merge, the beta release,
  the ideas digest and your answers, and the same builder → review → audit loop for the website
  (octopush-web), which you merge with one word. Nothing runs on your Mac and it can be off. Claude works with
  your Claude subscription (the `CLAUDE_CODE_OAUTH_TOKEN` secret).
- **A few optional, low-impact routines run as Octopush Routines on your Mac** (§1–§3 below) —
  they read, comment or open a PR for you to review, never merge; kept there to dogfood Octopush.

All of it follows [`VISION.md`](../VISION.md) §8: agents write code, reviews and ideas; fixed,
tested scripts in `scripts/routines/` do every merge, release and GitHub write the routines make,
after re-checking the rules; human-only areas stay `proposal` issues. Outside the routines, the PM
(Claude in your PM conversation) may also merge any PR once CI is green and an independent review
has approved its exact head (VISION.md §8), and you still can. Production deploys of the website
and API are separate routines in those repos (`scripts/deploy-if-ready.sh`, see their READMEs).

---

## The cycle (GitHub Actions)

You approve ideas; everything else runs continuously (VISION.md §8–§9): the builder and the reviewer alternate every hour, betas go out twice a day. GitHub's scheduler can delay crons by hours, so the cycle also chains itself: an agent branch's green CI starts a review at once (ci.yml `review-next`), and a review that leaves work for the builder starts it; the crons are the fallback. Times are Bogotá (UTC−5).

| Time | Workflow | What happens |
|---|---|---|
| 00:29 | [`visual-audit.yml`](../.github/workflows/visual-audit.yml) | renders every surface in **WebKit** (the macOS engine) with real-world data at three window sizes and runs layout checks (text escaping its box, text over text, sideways scroll, unlabeled controls); new defects become `visual` issues, the first two `ready` for the builder; then a Claude design reviewer reads the screenshots against the design system and files at most 3 findings as `proposal` ([scripts/visual-audit/](../scripts/visual-audit/README.md)) |
| 00:49 | [`web-audit.yml`](../.github/workflows/web-audit.yml) | builds octopush-web's `main`, renders every page in **Chromium** at 1440×900, 1024×700 and 390×844 and runs the layout checks plus website ones (content past the window edge on mobile, placeholder copy, retired glyphs, italics, missing title/description/social tags, broken internal links and anchors); new defects become `visual` issues **in octopush-web**, the first two `ready` for the web builder, never on legal/pricing pages ([scripts/web-audit/](../scripts/web-audit/README.md)) |
| every 2 h (odd hours, :07) | [`nightly-build.yml`](../.github/workflows/nightly-build.yml) | each run takes one job — the cycle's "main is red" issue while main's CI fails, else a PR the review sent back, whose CI is red or that conflicts with main, else the oldest `ready` issue — and a Claude agent builds it (first, CI runs whose jobs never got a macOS runner are re-run — `rerun-starved.sh`, also before each review — so they don't read as red, and so is the newest `release.yml` build, so a starved beta still ships; a PR job first gets main merged in, with any conflicts left for the agent to resolve, and the failed CI jobs' log excerpt — see [Fix rounds](#fix-rounds)); the workflow opens or updates the PR (label `agent`) and starts CI |
| every 2 h (odd hours, :37) | [`web-build.yml`](../.github/workflows/web-build.yml) | the website's builder: one job per run — a web PR the web review sent back or whose CI is red, else the oldest `ready` octopush-web issue, else the oldest app-repo issue labelled `area:web` + `ready` (not `area:app`: that is app work) — built by a Claude agent in a checkout of octopush-web (its CLAUDE.md, checks via `octo-check build\|check\|consistency`, the app's stable `FEATURES.md` as the truth reference); the workflow opens or updates the PR in octopush-web (label `agent`) and, for an app-repo issue, comments the link there |
| every 2 h (even hours, :47) | [`nightly-review.yml`](../.github/workflows/nightly-review.yml) | an independent Claude reviewer judges each green agent PR (up to 3) and says whether users will notice it (`user_visible`); `automerge.mjs` re-checks every rule on that exact commit and merges the approved ones (retrying earlier approvals whose merge was skipped for a transient reason or a pause — main red, a release PR open), or parks them as `needs-owner` |
| every 2 h (even hours, :07) | [`web-review.yml`](../.github/workflows/web-review.yml) | an independent Claude reviewer judges each green web PR (up to 3) against octopush-web's CLAUDE.md, the truth rule (the app's `FEATURES.md` at its latest **stable** release), the design rules and the human-only areas, and posts the verdict. It never merges: approved web PRs are listed in the digest, for the PM to merge or for your `merge web#N` |
| 05:13, 17:13 | [`nightly-release.yml`](../.github/workflows/nightly-release.yml) | if `main` moved and CI is green: notes, What's new tips, clips, version bump, release PR, CI, merge, tag → `release.yml` publishes a **beta** |
| 06:37 | [`ideas.yml`](../.github/workflows/ideas.yml) | a Claude agent researches; at least 5 ranked ideas across app, API and site are filed — app and API ones here (label `area:app\|api`), website ones in octopush-web — and one digest issue here lists them all |
| 06:47 | [`social.yml`](../.github/workflows/social.yml) | the community routines for octopush-web's `marketing/` work, two jobs (see [Community routines](#community-routines)): `intel` — a Claude agent researches the market and competitors → issue **Market report YYYY-MM-DD**; then `drafts` (also when `intel` failed) — a Claude agent reads that report and the Reddit threads → issue **Social drafts YYYY-MM-DD** with comment drafts. Both issues land in **octopush-web**, label `social`, filed by the App's bot. Nothing is posted anywhere: you approve each draft in your PM chat |
| any time | [`answers.yml`](../.github/workflows/answers.yml) | the moment you comment on the digest, your answers are applied and confirmed in a reply |
| odd hours, :22 | [`epiku-build.yml`](../.github/workflows/epiku-build.yml) | the builder for **Epiku** (`octopush-sh/epiku`, private): one job per run — an Epiku PR its review sent back or whose CI is red, else the oldest Epiku issue labelled `ready` — built by a Claude agent in a checkout of Epiku (its CLAUDE.md, checks via `octo-check typecheck\|test\|test-py\|agents`, run without network; Epiku's CI builds the PR); the workflow opens or updates the PR there (branch `agent/issue-<n>`, label `agent`). See [The Epiku lane](#the-epiku-lane) |
| even hours, :22 | [`epiku-review.yml`](../.github/workflows/epiku-review.yml) | an independent, **adversarial** Claude reviewer judges each green Epiku PR (up to 3) against Epiku's data-safety and tenant-isolation rules and classifies it `none` / `additive` / `breaking`; then, in a separate job on a fresh runner, `automerge.mjs --repo octopush-sh/epiku merge` re-checks every rule on that exact commit and merges it, or parks it as `needs-owner`. A dry run unless the repository variable `EPIKU_AUTOMERGE` is `true` |

Every workflow also has **Run workflow** (Actions tab) for a manual run. Schedules sit off the hour on purpose: GitHub delays (and sometimes drops) scheduled runs at :00 under load.

### Fix rounds

The cycle parks a PR (`needs-owner`) only for what it can't fix itself. These send a builder PR
back to the builder instead (`jobs.mjs`), and together they get `MAX_FIX_ROUNDS` (3) rounds
before the PR is parked:

- **The review asked for changes.**
- **CI is red.** A run whose jobs never got a runner (every job that didn't pass cancelled before
  any step ran, as `lib.sh` `ci_starved_run_for` tests it) is not red: `ciStatus` skips it and
  `rerun-starved.sh` re-runs it. A fixed step of `nightly-build.yml`, holding the workflow's token,
  reads the failed jobs' logs through the Actions API (`ci-failures.mjs`; the agent never fetches
  anything) and puts an excerpt in the prompt: the failing step, the first error lines of the
  tools (rustc's whole diagnostic, tsc, Vitest, node:test, panics, `##[error]`), the failing test
  names, and, when none of those matched, the last lines before the step failed. Every line is
  cleaned of control and invisible characters, cut to 4,000 characters, redacted (every pattern
  is bounded, so a megabyte of hex redacts in milliseconds), then capped to 300. Redacted: known
  secret values (plain and base64), the credential shapes of `social.mjs`, `sk_live_`/`sk_test_`/
  `whsec_` keys, an `Authorization:` value, basic/bearer credentials, `token <hex>`, a URL's
  user:password, the value after `=` of any name that says secret/token/password/credential or
  ends in key (`STRIPE_KEY=`, `?api_key=`), a quoted value of such a name (`secretKey: '…'`), an
  opaque value after such a name, and runs of 40+ mixed-case characters with digits. The excerpt
  is bounded to 12,000 characters and fenced as untrusted data.
- **The PR conflicts with main** (app PRs; GitHub reports it not mergeable). The workflow merges
  main into the branch (`merge-main.sh`). If every conflicted file got Git's markers (zdiff3), the
  merge is committed with them and resolving them is the round's work; `publish-build.mjs` pushes
  nothing while a conflicted file still has a marker (it parks the PR instead), and a conflict in
  a path agents may not touch is refused as any such change is. A conflict Git can't mark — a
  binary file, a file deleted on one side, a symlink — would be settled silently, so the merge is
  aborted and the PR is parked whatever the agent writes. The new head is reviewed again. A
  conflicted PR is not reviewed until then; `automerge.mjs` treats conflicts as "not yet", never
  as a park.
- **Main moved past the fix for a red main.** See below.

A missing changeset parks a PR only when the reviewer says users will notice the change: its
verdict file carries `user_visible: true|false` and a one-line `user_visible_reason`, which the
posting step shows in the comment and signs next to the verdict, for that commit
(`<!-- octopush-visible:<sha>:<bool> -->`; agent text can't carry it). Without a usable answer
(missing, not a boolean, no reason) the old path heuristic decides — non-test code under `src/` or
`src-tauri/src/` — so a malformed verdict can only make the rule stricter.

### When main is red

When CI fails on `main` (a merge of two PRs that were each green, say), every PR that merges main
goes red too, and no beta goes out (the release waits for a green main). So:

- **"Red"** is the newest verdict on main's first-parent line within 5 commits: a head whose CI is
  still running or never ran (a release merge) inherits its parent's, so red lasts until a newer
  commit is green; a running CI whose job already failed counts as red at once. That inherited red
  is used only to pause merges; the issue and the queue below react only when CI failed on main's
  **head** itself, so a fix whose CI is still running doesn't open a second issue.
- **One issue, at the top of the queue.** While main's head is red, `jobs.mjs next`
  (main-health.mjs) opens a `ready` issue titled "main is red: <failing job>", by the workflow's
  bot, ending in `<!-- octopush-main-red -->`, with the red commit and the same redacted, fenced
  log excerpt; it updates that one issue (title and body, never its labels) while the head stays
  red, and offers it before every other job. If you park it (`needs-owner`), it stays parked. Once
  main is green again the cycle comments and closes it (the fix PR's `Closes #n` usually does
  first).
- **Red-CI fix rounds wait** while main's head is red (main is the likelier cause), except on the
  PR that closes the main-red issue. Review and conflict rounds go on.
- **Auto-merge pauses** while main is red, except for a PR whose head already contains main's head
  — its green CI then proves the fix, and merging it is how main turns green. A lookup that fails
  (main's CI, the compare) counts as paused.
- **No deadlock.** If something lands on main meanwhile, the fix PR no longer contains main's head
  and would wait forever: while main is red, the PR that closes the main-red issue gets a
  "behind-main" round when it is behind main (the workflow merges main in; a round that is only
  that merge is pushed as is), under the same round limit.
- **Right away, not at the next cron:** `ci.yml`'s `main-red` job starts the builder when a job of
  main's CI fails (push or dispatch on `main`, never a PR run).

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

### Community routines

[`social.yml`](../.github/workflows/social.yml) runs two jobs a day around [`scripts/routines/social.mjs`](../scripts/routines/social.mjs):
`intel`, then `drafts`. **Run workflow** takes `kind` (`both`, `intel` or `drafts`); a manual run
on a day whose issue exists adds a comment to it instead of a second issue. The rulebook is
octopush-web's `marketing/` folder (`README.md`, `strategy.md`, `competitors.md`,
`drafts/TEMPLATE.md`), read **from `main` only**: while any of it is missing there, `check` exits 3
and the job files nothing, with a warning. `check` exits 0 to go, 1 when today's issue is filed;
anything else fails the job.

- **The agents** (role `social` in `agent.mjs`, briefs `briefs/social-intel.md` and
  `briefs/social-drafts.md`) have web search, the checkout read-only and one output file —
  `.agent-out/social-intel.json` or `.agent-out/social-drafts.json`. No GitHub access, no shell.
  Their context (`social.mjs context`) is the rulebook, `free-vs-pro.md`, the app's stable
  release (tag and notes), VISION §2, §3 and §5 and, for drafts, today's market report (the
  bot's) and a **structured** list of the last 7 days' drafts — issue, D-number, kind, subreddit,
  thread id, mention yes/no and whether your `Posted Dn (fingerprint …)` comment records it. No
  free text from issues or comments reaches the agent. All of it is fenced as untrusted data, and
  read with a read-only App token that is revoked before the agent starts.
- **`social.mjs post`** validates the file and files it with a fresh issues-write App token, so
  the issue is the App's bot's, never your account's. It refuses the whole file if it carries a
  secret value or a credential shape, and leaves out (listing the reason in the issue) any draft
  that:
  - breaks the strict schema or the length caps, isn't English, or carries HTML or an `@`;
  - has a thread link other than a bare `reddit.com/r/<sub>/comments/<id>/<slug>/` permalink;
  - records the subreddit's AI-content rule as anything but exactly `no rule` or
    `allowed: "<quoted rule>"` whose quote restricts nothing (fail closed: any ban, removal,
    disclosure or flair requirement drops the draft);
  - mentions Octopush, or "my app/tool/product/IDE", "I'm building", "we built", "DM me" or
    "PM me", without "I build Octopush";
  - links a shortener, the raw GitHub releases page, or any octopush.sh URL other than
    `https://octopush.sh/`, `https://octopush.sh/docs/…` and
    `https://octopush.sh/download?src=reddit` (every link, masked or bare, is extracted and listed
    in the draft's metadata; hostnames are compared with trailing dots stripped, and
    `octopush.sh.` itself is never allowed; a bare `octopush.sh?…` or `octopush.sh#…` is checked
    with its query), shows a URL or domain as a masked link's text that differs from its target
    (the text is read as a reader sees it: NFKC, without emphasis marks, brackets or zero-width
    characters), or uses a reference-style link (`[text][1]` with `[1]: url`);
  - carries an encoding that could hide a link (fail closed): an HTML entity, a backslash escape
    outside code, a bidi control or any invisible formatting character (soft hyphen, zero-width…);
    or mentions `octopush.sh` in any form (checked on a canonical copy: entities decoded, NFKC,
    invisible characters dropped, look-alike dots and slashes as ASCII, `%2e`/`%2f` decoded,
    backslashes dropped, lowercased) that isn't one of the three allowed links, byte for byte, or a
    bare `octopush.sh` with no `/`, `?` or `#` after it;
  - presents Direct or pipeline runs in parallel or in the background without
    "one run at a time";
  - repeats an earlier draft's text, or its thread (subreddit + post id);
  - breaks the cadence: at most 4 comments a day; in every phase at most 1 in 10 drafts of the
    last 7 days (today and the 6 days before) mentions Octopush; phase 1 (from `strategy.md`,
    unknown counts as 1) has no posts; later phases at most 1 post a day and 3 in 7 days.

  Drafts with plan, price, sign-in or privacy wording next to a mention are flagged
  `plan-boundary`. The issue body is capped at 60,000 characters. The public Actions log shows
  only fixed messages, counts and each filed draft's `D<n> <fp>`, an anchor the PM checks the
  issue against; nothing the agent wrote is printed (`agent.mjs` reports denied tools by name and
  count only).
- **The fingerprint.** `fp` is computed by the script, never taken from the agent: sha256 of the
  draft's UTF-8 text (CRLF made LF, the end of the whole text trimmed; nothing else changed),
  first 8 hex characters. To check one from the rendered issue, take the draft's quote block, strip
  the leading `> ` from each line (a bare `>` is an empty line), and hash the result:
  `printf '%s' "$text" | sha256sum | cut -c1-8`.
- **Approvals happen only in your PM chat** (`marketing/README.md`). Every drafts issue says so
  in its footer: a GitHub comment, `ok` included, is never an approval, and no routine posts to
  Reddit.
- **Accepted residual risk** (the same as the ideas routine): the agents read arbitrary web pages
  with WebFetch, and a hostile page could steer what they write. They hold no credentials, can only
  write their output file, and every draft passes the deterministic rules above and your approval
  before anything is posted, so the worst case is a bad draft or a misleading report in a private
  issue.

### What keeps it safe

The repos are public: anyone can write an issue, a comment or a PR, and an agent reading that text
could be steered by it. So no agent ever holds a GitHub credential, and nothing an agent writes is
trusted:

- **Agents run with nothing but the Claude token** (`scripts/routines/agent.mjs`): their environment
  is rebuilt from scratch and every tool call that isn't explicitly allowed is denied
  (`--permission-mode dontAsk`). File tools are allowed only inside the working directory (so not
  the runner's action code or tool cache, which run later with a token), and the process table,
  system and credential paths, the runner's temp dir and git config are denied on top. The
  reviewer, the design reviewer (`visual-audit.yml`), the ideas agent and the social agents can only write their output file; only the ideas and social agents can use the
  web. Transcripts stay on the runner — public Actions logs show only the exit code.
- **The builder runs code only through `octo-check`** (typecheck, tests, changeset check) — a
  root-owned copy of `scripts/routines/agent-check.sh` that runs the checks as a separate user with
  an empty environment, so code the agent writes can't reach the token.
- **Nothing the sandbox can write runs as the runner.** In the three builders (`nightly-build`,
  `web-build`, `epiku-build`), Node and the Claude Code CLI are a root-owned, read-only copy made
  by `scripts/routines/frozen-node.sh freeze` before the agent's branch or repo arrives (the
  CLI is installed into it there, with no token in the step), and everything on `PATH`, the
  runner, the actions' code and `~/.config` is closed to other users. After the agent, the sandbox
  is stopped with system tools only, and every later step, and the last one before the actions'
  post steps, starts with `frozen-node.sh guard`: the sandbox user's processes and crontab are gone, the frozen
  copy is unchanged, nothing the runner executes is writable by or belongs to that user, the moved
  `.git` has no hook or command-running config, and the step's environment sets no `GIT_*`,
  `NODE_OPTIONS`, `BASH_ENV` or loader variable; otherwise the step fails and nothing is
  published. Those steps run on `/usr/bin/bash`, not a shell found through `PATH`. A `.git` the
  sandbox made in the checkout (whose own `.git` was moved out) is removed before
  `actions/checkout`'s post step could run git in it, and the build is not published.
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
  frontend next to the token). **It tags only a tree its CI tested:** the release PR merges only
  while its head contains the current `main` (else it is cut again from the new `main` and
  re-tested, once, then it stops), and the merge commit must have that head's exact tree — or CI
  runs on the merge itself (branch `release-check/v<version>`), and a red one is abandoned
  (`abandoned/v<version>`, never a `v*` tag). A version whose build failed, or that was abandoned,
  is carried into the next release's notes (docs/RELEASING.md).
- **Agents read GitHub only through `read.mjs`**, which shows text by you and the routines and
  never anyone else's — an outsider can edit their issue after you approve it, so when you mark an
  outsider's issue `ready`, restate the work in a comment of yours.
- **Merges re-check every rule** on the PR's head commit (`automerge.mjs`): opened by the
  workflow from a branch of this repo into `main`, labelled `agent`, CI green, an approving review
  on that exact commit, no human-only paths (renames too), ≤ 800 changed lines, a changeset for
  user-visible changes (as the review judges it, else by path — [Fix rounds](#fix-rounds)), no
  conflicts, and the beta channel live. They also **pause**, without parking anything, while
  main's CI is red ([When main is red](#when-main-is-red)) and while a release PR is open (so the
  release merges the main its CI tested, docs/RELEASING.md; one untouched for 4 hours was left by
  a killed run and pauses nothing). Merges reach the **beta** channel
  only; stable needs your approval.
- **Identities:** your account (`OCTOPUSH_OWNER_LOGIN`) is the only one whose answers count; the
  workflows act as `github-actions[bot]` (this repo) and the "Octopush Cycle" App's bot
  (octopush-web) and can never act as you.
- **The website lane uses a GitHub App, not a stored token.** octopush-web is private, so a
  workflow's own token can't reach it. The "Octopush Cycle" App (secrets `OCTOPUSH_APP_ID`,
  `OCTOPUSH_APP_PRIVATE_KEY`) is used only by `actions/create-github-app-token` to mint an
  installation token **scoped to octopush-web alone**, with the fewest permissions the step needs,
  valid for an hour at most and revoked at the end of the job. It goes only to fixed steps of
  `web-build`, `web-review`, `web-audit`, `ideas`, `answers` and `social` (as `OCTOPUSH_WEB_TOKEN`), never to
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
  nothing is dispatched there. Website PRs never auto-merge: the PM merges them (VISION.md §8), or
  you do with `merge web#N`; after the merge the app-repo `area:web` issue it was built for is
  closed with a link (the App can't close another repo's issue through a closing keyword). This
  repo is public: website PR titles, file names in refusals, and the web audit's findings and
  screenshots (kept 3 days, never of the legal pages) show up here.

### The Epiku lane

Epiku (`octopush-sh/epiku`) is a separate product in a **private** repo, with one production
instance that holds real projects. Its lane lives here for the same reason the website's does
(free runner minutes, one set of hardened scripts), and it follows **Epiku's** rules — its
`VISION.md` §2, `CLAUDE.md` and `docs/DATA-SAFETY.md` — not this repo's.

**Before the first `epiku-build` run** (not only before auto-merge): the builder pushes a branch
`agent/issue-<n>` of unreviewed, agent-written code. If Epiku's Vercel project builds previews
from Git, that push would build and run that code with whatever variables the Preview environment
has. So first either turn preview deployments off for `agent/*` branches (an *Ignored Build Step*,
or Git → preview branch settings), or remove `KV_REST_API_URL`, `KV_REST_API_TOKEN` and
`API_TOKEN` from the Preview environment (Production only, or a separate store for Preview).

- **Same machinery as the website lane.** The "Octopush Cycle" App mints installation tokens
  **scoped to `epiku` alone** (`OCTOPUSH_EPIKU_TOKEN`, its own variable: a step never holds the
  website's token and Epiku's together, and the scripts refuse to fall back to another token).
  The token that picks the job or reads the PRs is revoked before any agent starts; a fresh one
  publishes afterwards. The App's key is used only before the sandbox exists and after it is
  proved gone. The workflows' own `GITHUB_TOKEN` is read-only and is given to no step. The three
  actions the two workflows use are pinned by commit, and the Claude CLI (an exact version; its
  postinstall script has to run, it puts the binary in place) is installed in a step that holds
  no token.
- **Epiku's code runs with no network.** The checks (type check, Vitest, the Python tests, the
  `AGENTS.md` mirror) run only through `octo-check` (profile `epiku`) as `octo-sandbox`, with an
  empty environment — no store, no token — and `agent-sandbox-setup.sh`
  (`OCTO_SANDBOX_NETWORK=none`) removes that user's network before the agent starts: packet rules
  by uid for IPv4 and IPv6, loopback kept except DNS, the resolver's and the system bus's sockets
  closed to it, and a proof (a TCP connection and a name lookup must fail) that stops the job if
  anything is still open. Code an agent wrote can read the checkout but has nowhere to send it.
  The price: no `next build` in the sandbox (it downloads fonts); Epiku's own CI builds the PR,
  and a red build comes back to the builder as a fix round. `octo-check test` accepts only
  existing files or folders of the checkout as arguments, so the agent's shell can't hand a value
  from its own environment (the Claude token) to the code under test.
- **The real plans (`data/`).** Epiku's code imports them, so they can't be removed from the
  builder's checkout without breaking its own checks. Instead the agent's file tools are denied
  the folder (`OCTOPUSH_AGENT_DENY=data`), the sandbox that can read it has no network, publishing
  refuses any change under `data/`, and the reviewer's copy has the folder removed. What remains:
  the checks do read those files, and their output goes back to the model as tool results. The
  clean fix is in Epiku (move the real plans out of the repo, a synthetic bundled default) — an
  owner decision there.
- **Nothing private is printed here.** This repo's logs, comments and digests are public. The
  Epiku steps print issue/PR numbers, commit ids and fixed reason codes only:
  - Epiku is fetched **by hand**, one named ref at a time (`main`, the job's `agent/issue-<n>`,
    `pull/<n>/head`), with git's output discarded. `actions/checkout` is not used for it: it prints
    the refs it fetches, and with history it lists every branch and tag name.
  - The job picker and the review queue emit no title or URL; the builder's branch is
    `agent/issue-<n>`; publishing prints `epiku#<n>`; a refused merge prints codes (`human-only`,
    `breaking`, …) while the reasons, with file names, go into a comment **on the Epiku PR**.
  - No command's own words reach the log. Publishing runs git with its output captured (its
    warnings name files) and reports only the step that failed (`failed at push (exit 128)`);
    with `OCTOPUSH_QUIET_ERRORS` every script reports a failure as an HTTP or exit status, never
    a command line, a stderr or the snippet a JSON error quotes; the dependency install and the
    sandbox setup log stay on the runner.
  - From the agents: the exit code, and denied tool calls by tool name — only names from a fixed
    list, since the model chooses the name. Prompts, diffs, reviews and transcripts stay in the
    runner's temp dir; nothing is uploaded as an artifact or written to the run summary.
  - Epiku is not in `ALL_REPOS`: the digest, the answers, the weekly report and the audits never
    read it. Parked Epiku PRs reach you through GitHub's notifications for that repo
    (`needs-owner`), not through the digest.
- **The review is adversarial** ([`briefs/epiku-reviewer.md`](../scripts/routines/briefs/epiku-reviewer.md)):
  the reviewer is told its approval merges with no human reading, and to look for the way the PR
  damages stored data, leaks across projects or breaks an API client. It reads `main`'s
  `CLAUDE.md`, `AGENTS.md` and `VISION.md`, never the PR's. The diff is handed to it between two
  lines carrying a random value generated for that run, not in a code fence a line of the diff
  could close. Besides the verdict it must classify the change — `data_change`: `none`,
  `additive` or `breaking`; a verdict file without it is not posted. The posting step signs the
  class next to the verdict, for that commit (`<!-- octopush-data:<sha>:<class> -->`; agent text
  can't carry it), and parks an approved-but-`breaking` PR at once.
- **The merge is a different job on a fresh runner**, where no agent ran and Epiku's code is
  never fetched. It is handed nothing by the review job: it lists the PRs approved on their
  current head and re-reads everything from GitHub, and every lookup that fails counts as "no".
  `epikuRefusals` (`automerge.mjs`) refuses unless **all** hold on the head commit:
  - *the PR*: opened by the App's bot from a branch `agent/issue-<n>` of Epiku into `main`,
    labelled `agent`, not a draft, not `needs-owner`; ≤ 800 changed lines; the complete file list;
    no conflicts; `CI` green;
  - *nobody forged it*: the approval is a comment by the App's bot **account id** (not just its
    login) that was **never edited** (`updated_at` = `created_at`), on that exact commit; every
    commit on the branch is authored and committed by the bot (GitHub's own signed merge of
    `main` into the branch excepted); the head is the latest push to the branch and the bot made
    it; the PR's first line closes an open issue whose `ready` label was last applied **by you**
    (`OCTOPUSH_OWNER_LOGIN`, from the issue's events);
  - *the paths*: no human-only path (`EPIKU_HUMAN_ONLY`: `lib/identidad.ts`, `lib/auth.ts`,
    `lib/api.ts`, `scripts/tokens.py`, `data/`, `.github/`, `next.config.*`, `vercel.json`,
    `.vercel/`, `.npmrc`, `.env*`, `package.json` and lockfiles, `tsconfig*.json`,
    `vitest.config.*`, `postcss.config.*`, a root `proxy.ts` / `middleware.ts` /
    `instrumentation*.ts`, `.gitmodules`, `.gitattributes`, `CLAUDE.md`, `AGENTS.md`, `VISION.md`,
    `.claude/`, `.agents/`; renames count); neither guard test (`tests/rutas.test.ts`,
    `tests/backup-roundtrip.test.ts`); no removed or moved route file under `app/api/`;
  - *the content a script can test*: no added line that could read an environment variable
    (`process.` in any spelling, an alias of `process` or `globalThis`, `import.meta.env`, a quoted
    `"env"` key, Python's `environ`); no non-doc file GitHub returned **without a diff** (binary,
    a NUL byte, a pure rename, too large — whatever its line counts say); no hunk of `lib/store.ts`
    that mentions the token, `localStorage`, `sessionStorage` or cookies;
  - *the data class*: not `breaking`; an `additive` one also changes a test,
    `docs/DATA-SAFETY.md` and `docs/FEATURES.md`;
  - *up to date*: the head already contains `main`. If that is the only thing missing, the script
    merges `main` into the branch instead — a new commit, so CI and the review run again on it —
    so two PRs that are each green can't break `main` together.
  
  A hard refusal labels the PR `needs-owner` and comments the reasons there; "not yet" (CI
  running, mergeability not computed, behind `main`) is retried next run. Dependabot's PRs never
  qualify (wrong author).
- **Open decision — `lib/almacen.ts` and `app/api/**`** stay auto-mergeable (under the review, the
  data class and the rules above). To have every PR that touches them parked instead, list them in
  the one-line constant `EPIKU_PARK_PATHS` in `automerge.mjs`.
- **Two switches, both off when this lane was merged.** The workflows have no schedule (manual
  runs only), and the merge job mints a **read-only** token and does a dry run — it prints what it
  would merge or refuse and writes nothing — unless the repository variable `EPIKU_AUTOMERGE` is
  exactly the string `true` (decided by a shell comparison, and checked twice; `TRUE` or `true `
  is a dry run). The schedule was turned on on 2026-11-26; auto-merge is still off.
- **Accepted risks.**
  - *The publish token on the builder's runner* (as in the website lane). The agent runs as the
    runner's user, confined by Claude Code's permission rules rather than by the operating
    system, and the publish token (epiku: contents, issues, pull requests) is minted on that
    runner after it exits. Publishing from a fresh runner would mean passing the work tree
    between jobs, and artifacts of a public repo are downloadable. The merge token is never on
    such a runner.
  - *The network cut is unproved on a real runner* until the first dry run; it fails closed. A
    name lookup through a local service the proof doesn't know would be a slow way out.
  - *The model reads the private repo*, and what it writes (a PR, a review) is posted to the
    private repo only.
  - *What a script can't see* stays with the reviewer: whether a change that looks additive
    really keeps old records readable; an environment read hidden behind a string built at run
    time. `package.json` and the build configuration are refused whole, which is stricter than
    Epiku's `VISION.md`: a job that needs them stops for you.
  - *Not automated at all*: PRs for `agent-ok` issues (human-only areas), UX design PRs without
    an issue, an ideas routine or a visual audit for Epiku, and deploying it.

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
6. **The Epiku lane.** In this order:
   1. *Vercel, before the first build*: previews off for `agent/*` branches, or no store/token
      variables in the Preview environment (see [The Epiku lane](#the-epiku-lane)).
   2. The App installed on `epiku` (and only where intended), with Contents, Issues and Pull
      requests read & write and Actions read — nothing wider. No new secret: the lane uses
      `OCTOPUSH_APP_ID`, `OCTOPUSH_APP_PRIVATE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` and
      `OCTOPUSH_OWNER_LOGIN` from this repo; Epiku itself needs none.
   3. In Epiku, the labels `agent`, `in-progress`, `needs-owner` and `later`, next to `ready` /
      `proposal` / `agent-ok` / `idea`. Label issues `ready` **yourself**: the merge checks who did.
   4. Dry runs: label one small issue `ready`, run `epiku-build` by hand, read the whole public
      log and the PR it opens, then run `epiku-review` by hand — its merge job prints
      `dry run: epiku#N at <sha> would be merged` or the refusal codes and changes nothing.
      Repeat a few times.
   5. To go live: the repository variable `EPIKU_AUTOMERGE` = `true` — only once you know what a
      merge to Epiku's `main` deploys and how to roll it back, Epiku's `main` has a ruleset
      (required up-to-date CI, few people with write access) and there is a recent, tested backup
      (Epiku `docs/DATA-SAFETY.md`). The `schedule` lines in both workflows were turned on on 2026-11-26, with auto-merge still off; the PM merges approved Epiku PRs (VISION §8).

Scheduled workflows in a public repo pause after 60 days without repository activity; the nightly
cycle itself keeps the repo active.

### Costs

Claude usage comes from your subscription's limits (no API billing). Runner minutes are free on
public repositories — the website lane runs here for that reason, even though it works on the
private octopush-web. Per run: one build, up to three reviews per lane; one ideas run and one social run (two agents) a day.

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
   If an entry fixes a sandbox or permission escape, add a (VERSION, one-line reason) row to
   `CLAUDE_SECURITY_FIXES` in src-tauri/src/agent_adapter.rs in the fix PR.
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
