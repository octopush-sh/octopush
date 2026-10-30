# Octopush · Vision & Direction

> **Status: adopted 2026-10-29** by the owner. This file is the *why* and the *what next*.
> [`docs/FEATURES.md`](docs/FEATURES.md) is the *what exists*; [`CLAUDE.md`](CLAUDE.md) is the
> *how to work in the code*.

Every agent — human-launched or scheduled — reads this file before proposing, planning or
implementing anything. If a proposal contradicts this file, the proposal is wrong or this file
needs a deliberate edit by the owner; **agents never resolve that conflict on their own** — they
say so in the issue or PR and stop.

---

## 1. What Octopush is

**The native macOS IDE for directing crews of AI coding agents.** One brief becomes a reviewed
pull request: a pipeline of agents (plan → implement → review → test), each on the right model,
working in isolated git-worktree workspaces, with the cost — and the savings against an
all-premium baseline — visible on every run.

The agent workflow is the product. The editor, terminal, diff and git tooling exist to serve it.

## 2. Who it is for

- **Primary:** professional developers who already run Claude Code daily and have outgrown a
  single chat or terminal — they want several tasks in flight, review discipline, and control
  over spend.
- **Secondary:** cost-sensitive builders using their own keys or local models (Ollama) who want
  agentic workflows without a premium-only bill.
- **Not the target:** people who want autocomplete inside a traditional editor, or a no-code app
  builder.

## 3. Principles (tie-breakers when choices conflict)

1. **The human directs, agents execute.** Checkpoints, the escape valve (`ask_director`) and
   review loops beat autonomy for its own sake. Never remove a human gate to look faster.
2. **Cost is a first-class signal, and it must be true.** Every execution path reports tokens,
   cost and savings. A model the app can't price must show as *unpriced*, never as free, and
   stay out of savings (rolling out with #250; Usage already flags unpriced calls).
3. **Local-first and honest about traffic.** Code, keys and history stay on the Mac. Anything
   that leaves it must be opt-in or a service the user explicitly configured, and every such
   flow is described exactly in the app's Privacy pane and on the site. No analytics, no
   telemetry. (Cloud sync becomes opt-in, off by default, with #248; until that release ships it
   still runs for every Pro user.)
4. **Security is never paywalled.** Sandboxing and read-only review stay on Free.
5. **Native and calm.** macOS-only, the *Atelier in Onyx & Brass* identity, calm motion. No new
   top-level layout without an owner-approved spec.
6. **Honest marketing.** No fake social proof, no invented ratings, only providers that really
   work (see `octopush-web/PLAN.md`). Every claim on the site must be true of the shipped app.
7. **Ride the upstream, don't fight it.** Claude Code moves fast. Prefer its official surfaces
   (stream-json, flags, documented files) and keep every dependency on its internals behind one
   adapter with fixture-backed tests (§6).

## 4. Non-goals (for now)

- Windows or Linux builds.
- A hosted/cloud agent runner — runs execute on the user's Mac.
- Team/enterprise features (SSO, shared seats) before Pro has paying individual users.
- Becoming a general-purpose editor competing with VS Code/Cursor on editing features.

## 5. Positioning

| vs | Our angle |
|---|---|
| Conductor | Directed, staged crews with review loops and per-stage model routing — not just parallel agents |
| Claude Code (CLI/desktop) | Octopush runs *on top of* Claude Code: worktrees, pipelines, review, cost ledger around it |
| Cursor / Codex | Agent-workflow-first and bring-your-own-key/local, not editor-first or single-vendor |
| Vibe Kanban, Crystal (deprecated) | A maintained, native successor |

## 6. Fragile surfaces — upstream contracts

These break when Claude Code (or a provider) changes. Any change to them needs tests, and the
Claude Code release-watch routine checks each new release against this list:

- `src-tauri/src/transcripts.rs` — `~/.claude/projects/**/*.jsonl` format
- `src-tauri/src/orchestrator/cli_runner.rs`, `orchestrator/live.rs` — `claude -p --output-format stream-json`, `--resume`
- `src-tauri/src/agent_adapter.rs` — command building, token parsing
- `src-tauri/src/token_engine.rs` — `Total cost:` PTY scrape (most fragile) and the model price table
- `src-tauri/src/mcp_setup.rs` — `claude mcp add`
- `src-tauri/src/skills/` — `.claude/skills` and `.claude/agents` frontmatter
- `src-tauri/src/gateway/litellm.rs` — LiteLLM `/key/info`, `/spend/logs`, `/user/daily/activity`
- `octopush-api` ↔ Clerk (`publicMetadata.plan`) ↔ Dodo Payments webhooks

## 7. Current priorities — Q4 2026 (in order)

1. **A safety net for autonomous work.** PR CI on all three repos, Dependabot, Claude Code
   contract tests (§6). Nothing else is safe to delegate until it exists.
2. **Trust correctness.** Cloud sync opt-in with exact privacy copy in app and site; correct model
   prices with unknown models shown as unpriced; billing entitlement correctness (done:
   per-subscription ledger, octopush-api #3).
3. **Discoverability.** Search-intent copy, comparison pages (Cursor, Claude Code GUI, Codex),
   docs for shipped-but-undocumented features (sandbox, Routines, detached runs, Mission Control,
   Logbook), a current changelog, the Homebrew tap.
4. **Product depth** — chosen by the owner each week from user feedback, not by agents.

## 8. Rules for autonomous agents

- **Output is a PR, an issue or a comment. Never merge, never tag, never release, never deploy
  by hand.** Production deploys of the website and the API happen only through the
  `scripts/deploy-if-ready.sh` routine in `octopush-web` and `octopush-api`, which deploys
  CI-green `main`. The app itself ships only through the owner's release process.
- **Human-only areas** — open an issue with a proposal (label `proposal`), never a PR, unless the
  issue carries the `agent-ok` label: billing (`billing.rs`, `entitlement.rs`,
  `octopush-api/api/dodo-webhook.ts`, `api/_lib/billing.ts`), auth (`auth.rs`, Clerk), release and
  signing (`release.yml`, `scripts/release.mjs`), deploy scripts, pricing and the Free/Pro
  boundaries, privacy copy and data flows, legal pages, and §1–§5 of this file.
- **Implementation work** only on issues labelled `ready`. One issue → one branch → one PR.
  The only exception: the Claude Code release-watch routine may open a small fix PR for the
  `claude-code-update` issue it filed itself. Maintenance routines (docs/ROUTINES.md) are
  otherwise comment-only — in particular, never push to Dependabot branches.
- If you stop on a `ready` issue (ambiguous, or a human-only area without `agent-ok`), comment
  why and move it from `ready` to `needs-owner`, so no routine picks it up again.
- Every PR: CI green, tests for the change, `docs/FEATURES.md` updated if user-facing,
  `CLAUDE.md` rules followed, the cross-repo `octopush-web/scripts/consistency-check.mjs` passing
  when versions, pricing or model names change.
- Keep `AGENTS.md` identical to `CLAUDE.md` (CI enforces it).
- **Ideas are welcome, as issues.** Label new feature ideas `proposal`; the owner promotes them
  to `ready` or closes them.
- When unsure, stop and write the question in the PR or issue instead of guessing.

## 9. Owner's weekly loop

About two hours, once a week: read the Friday report issue (label `report`) → merge or reject
open PRs → answer `needs-owner` issues → label 2–3 issues `ready` → adjust §7 here if
priorities changed.

## 10. Decision log

| Date | Decision |
|---|---|
| 2026-10-28 | Draft created from the state of `octopush`, `octopush-api`, `octopush-web` |
| 2026-10-29 | Adopted. Confirmed: primary audience (§2), macOS only, no cloud runner, no team features before paid Pro (§4); priorities kept in the proposed order (§7) |
| 2026-10-29 | Cloud sync (run history incl. journals/artifacts/diffs, and the pipeline/role library) becomes opt-in, off by default, with exact privacy copy in app and site |
| 2026-10-29 | Dependency updates via Dependabot on all three repos. Agent P stays off until the repos are authorized in Sonatype Guide (its gate returns HTTP 401) |
| 2026-10-29 | Production deploys of web and API run from the owner's Mac via Octopush Routines (`scripts/deploy-if-ready.sh`); Vercel has no Git integration (Hobby plan) |
