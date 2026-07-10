# Octopush — "Pro Real" Implementation Plan
### Making Pro worth paying for — starting with Parallel & Background Runs

> Companion to [`premium-features-plan.md`](premium-features-plan.md) (the Free/Pro strategy) and
> [`accounts-and-subscriptions-implementation-plan.md`](accounts-and-subscriptions-implementation-plan.md)
> (accounts + billing, now shipped in production).

## Why this plan

The accounts + payment gateway are **done and live** (Dodo Payments + Clerk prod, real payment validated). But today the **only enforced Pro gate is the 25-run/month Direct cap** — so "Pro" effectively means "uncapped Direct runs" and nothing else. The strategy (`premium-features-plan.md` §4) promises Pro = **"unlimited multi-agent orchestration, run it many-at-once, and remember it all."** This plan builds the missing value, starting with the #1 differentiator: **parallel & background runs.**

## The big finding (engine audit, 2026-06-27)

**The execution engine is already parallel- and background-capable.**
- `start_run` hands off to a **detached `tokio::spawn`** that drives the pipeline to completion on its own (`orchestrator/mod.rs:1048`). Runs are **not** stepped from the UI.
- All run state is keyed by `run_id`: the DB `runs` table is one row per run; the orchestrator's in-memory maps (`active`, `cancels`, `pause_requests`) are all `run_id`-keyed. `AppState` holds **no** single "current run" slot.
- Every event carries `runId` (`emit_run_update`, `emit_cost`, `run://log`, …), so concurrent runs are fully distinguishable on the frontend.
- **Cross-workspace parallel runs already execute today — for everyone, ungated.** A run already keeps running in the background when you switch workspace/mode (within a session).

**The only concurrency limit today is *per-workspace*** (`has_concurrent_run`, `orchestrator/mod.rs:1035` + `commands.rs:1210`) — and it exists for git-worktree safety, not as a tier.

➡️ **This is gate + surface + harden, not an engine rewrite.**

## Key design decisions

1. **"Parallel" = across workspaces (separate git worktrees) only.** Same-workspace concurrency stays **serialized for everyone** — two agents in one worktree corrupt each other's diffs/baselines (`git_baseline.rs`). This is a safety invariant, independent of plan.
2. **The gate:** **Free = 1 active run at a time** (globally); **Pro = N concurrent runs** across workspaces (sane cap, e.g. **5**, to bound resources). A run **paused at a checkpoint** still occupies the slot.
3. **Background scope:** Phases A1–A2 ship "survives navigation within a session" (already true). **Restart durability** (auto-resume on relaunch) is A3/optional — today an interrupted run parks for manual **Resume** (`db.rs:2267`).
4. **Reuse the existing upgrade path:** `start_run` already returns `AppError::UpgradeRequired`, which already drives the upgrade sheet + auto-detect-Pro. The concurrency gate plugs into the same machinery.

---

## Part A — Parallel & Background Runs

### Phase A1 — Gate concurrency *(small; ships the differentiator)*
**Backend**
- Add a global active-run count: a workspace-agnostic variant of `has_concurrent_run` → `SELECT COUNT(*) FROM runs WHERE status IN ('running','paused')`.
- In `start_run` (`commands.rs:1210-1227`), beside the Direct-cap check: if `active_count >= 1 && !ent.has_feature(RUNS_PARALLEL)` → `AppError::UpgradeRequired { feature: "runs.parallel", used: active_count, limit: 1 }`. Pro (holds `RUNS_PARALLEL`) bypasses.
- Keep the same-workspace `has_concurrent_run` block for **everyone** (worktree safety).
- Tests: Free blocked on a 2nd concurrent run; Pro allowed up to the cap; same-workspace blocked regardless of plan.

**Frontend**
- Generalize the upgrade sheet copy to the feature type: `direct.unlimited` → "monthly limit"; `runs.parallel` → *"You can run one at a time on Free — upgrade for concurrent runs across workspaces."*

**Effort:** ~1 PR. **Risk:** low. Immediately makes Pro meaningfully better.
**Migration note:** this *restricts* Free (today Free can run multiple workspaces). With ~no users yet there's no grandfather concern; frame it as the Pro feature it always was in the plan.

### Phase A2 — Multi-run & background UI *(medium; the premium "wow")*
- Generalize the store from one-active-run-per-workspace (`runsStore.ts:37` `activeRunIdByWs: string|null`, `loadRuns` picks a single non-terminal run at `:158`) to represent **multiple active runs**.
- Add a global **"Runs in progress" tray** spanning workspaces: each row = workspace · current stage · live cost · status (running / paused / checkpoint), with **jump-to** and quick **stop**. This is what makes background runs tangible — see + control runs on workspaces you're not viewing.
- Broaden the rail signal (`runningWorkspaces.ts:9`, today only `"running"`) to also light up **backgrounded paused/checkpoint** runs.

**Effort:** medium. The plumbing (run-scoped events; `runsByWs` kept fresh by always-on listeners) already exists.

### Phase A3 — Resource & durability hardening *("operable business")*
- **DB contention:** enable SQLite **WAL** (+ consider a small read pool). The single `Arc<Mutex<Db>>` (`state.rs:14`) serializes every status flip / journal append; N concurrent drive loops contend. **Measure first.**
- **Spend safety:** budgets are **per-run** today — N concurrent runs can rack up N×cost. At minimum surface **combined live spend**; consider a Pro **account-level concurrency/spend ceiling**.
- **Provider rate limits:** per-run throttle (`agentic.rs:114`) doesn't coordinate across runs; N runs multiply 429s on one account. Add concurrency-aware backoff / a shared limiter.
- **Concurrency-gate atomicity:** the A1 gate is check-then-act (a run is `draft` at gate time and flips to `running` asynchronously inside the spawned drive), so two near-simultaneous `start_run`s on *different* workspaces can both pass the Free one-run gate. Bounded + soft (the engine tolerates it; it mirrors the pre-existing `has_concurrent_run` race). Harden by **reserving the slot transactionally** — flip/insert a counted status under a single DB lock before spawning.
- **Restart durability (optional):** auto-resume background runs on relaunch instead of parking for manual Resume.

**Effort:** medium, incremental. A1+A2 ship value; A3 makes concurrency robust at scale.

---

## Part B — The rest of "Pro real" (roadmap, after parallel/background)

- **Unlimited history + cross-machine sync** (`history.sync`) — the other big Pro pillar; also delivers the "continue work across devices" goal. Needs a sync backend → design separately (bigger).
- **Advanced / unlimited pipelines + auto-loops** — gate Free to built-ins + simple custom; Pro = unlimited custom + roles library + auto-mode loops. Mostly gating once scoped.
- **Priority routing / larger context caps** — soft value-adds, never a quality nerf to Free.

## Top risks (and how the plan handles them)

| Risk | Mitigation |
|---|---|
| Same-workspace parallelism corrupts the worktree | "Parallel" = across workspaces only; same-ws stays serialized for **everyone** (Decision #1) |
| Single DB mutex contention under N runs | A3: WAL + measure; not a structural blocker |
| N×cost from concurrent runs (billing surprise) | A3: combined-spend surface + optional account ceiling |
| Shared provider rate limits → 429 storms | A3: concurrency-aware backoff / shared limiter |
| Users expect background runs to survive restart | A3 (optional) auto-resume; until then communicate manual Resume |

## Recommended sequence
1. **A1 — gate** (1 PR, immediate Pro value, low risk).
2. **A2 — multi-run UI** (the premium feel; the "wow").
3. **A3 — hardening** (before pushing concurrency hard / scaling users).
Then **Part B** (history/sync) as the next Pro pillar.
