# Token / Cost / Budget Accounting — Correctness Rebuild

**Date:** 2026-07-17
**Status:** Proposed
**Scope:** `src-tauri/src/{token_engine,db,chat_engine,commands,provider_router,session_recap}.rs`, `src-tauri/src/orchestrator/*`, `src-tauri/src/providers/*`, `src/stores/{tokenStore,budgetsStore,chatStore,aiReviewStore}.ts`, `src/components/settings/UsagePane.tsx`, `src/lib/{cost,ipc}.ts`, `docs/FEATURES.md`.

> Verdict from the audit + independent Fable 5 review: **rebuild the accounting core, keep the surfaces.**
> The ledger's key is overloaded across four id namespaces, there are two disagreeing pricing
> authorities joined by a `cost == 0.0` sentinel, one of four spend surfaces (DIRECT) writes no
> ledger at all, and enforcement trusts a stale client cache. Incremental patches on the current
> schema cannot converge — but the core is small (one table, one pricing module, one gate, ~6 write
> sites). This is a 2–3 phase rebuild of the subsystem, not the app.

---

## 1. Problem statement

Octopush lets a user spend AI tokens in four modes — **TALK** (in-app chat), **RUN** (CLI agents in a
PTY terminal), **DIRECT** (orchestrated pipelines), **REVIEW** (AI diff review + commit-draft +
conflict resolution) — and promises to surface all of it in **Settings→Usage** and constrain it with
**USD budgets**. Today none of that is reliably true. Root causes:

- **Four disconnected ledgers.** `token_events` (TALK/REVIEW/RUN), `runs`/`run_stages` (DIRECT, never
  reaches `token_events`), `sessions.tokens_*` (RUN aggregates, mostly dead), and `chat_messages.cost_usd`
  (a *second* TALK cost figure). Usage and budgets read only `token_events`.
- **`token_events.session_id` is overloaded** across three id namespaces (`workspaces.id`, `sessions.id`,
  `terminals.id`, plus the literal `"ai-adhoc"`), with the FK deliberately dropped (Phase-9 migration,
  `db.rs:345-379`). Every reader assumes a *different* namespace, so no single write satisfies them all.
- **Two divergent pricing tables** — a hardcoded 5-model table (`token_engine.rs:90-134`) and the router
  catalog (`provider_router.rs`) — reconciled only by a `cost == 0.0` sentinel in `record()`.
- **Enforcement is advisory** — only TALK checks budgets, client-side, against stale spend, pre-turn.

The concrete consequences (severities in §2): DIRECT spend is $0 everywhere it matters; three of four
current models price to $0; the Usage "projected/day" headline is inflated ~24–48×; a checkpoint
**Reject** silently erases real spend; RUN duplicates spend on every app restart.

---

## 2. Findings register (traceability)

Every corrective action in §4 references these IDs. `Sev` = user-facing money-accuracy impact.

| ID | Sev | Finding | Root cause / evidence |
|----|-----|---------|-----------------------|
| **F1** | Critical | DIRECT spend never written to the ledger → invisible to Usage + all USD budgets | orchestrator writes only `run_stages`/`runs` (`mod.rs:566-606,744-782`); readers use `token_events` (`db.rs:882,1723`) |
| **F2** | Critical | 3 of 4 current models (`claude-opus-4-8`, `claude-sonnet-5`, `claude-fable-5`) price to $0 in both systems; unknowns silently $0; MCP recommends opus-4-8; default still opus-4-6 | `token_engine.rs:118`; `provider_router.rs:333-520`; `tools.rs:603`; `session.rs:83` |
| **F3** | Critical | RUN scanner unreliable: model `"unknown"`→$0; per-chunk regex misses/duplicates/fabricates; **reattach scrollback replay re-records with fresh timestamps** | `token_engine.rs:261-342`; replay hook `pty_manager.rs:161,184-185,285-287` → `commands.rs:1850` |
| **F4** | Critical | Budgets advisory & TALK-only, client-side, stale, pre-turn; RUN/DIRECT/REVIEW ungated; no backend gate | `chatStore.ts:746-748,162-164`; no check in `commands.rs:852-859` / `ai_complete` / orchestrator vs `budgets` table |
| **F5** | High | Checkpoint **Reject** doesn't `retire_stage_cost` → rejected-attempt spend erased from `runs.cost_usd` + baseline | `mod.rs:1070-1091` vs Resume `mod.rs:1107-1112` |
| **F6** | High | `projected_daily_cost` inflated ~24–48× and 24h trend spans 24–48h — RFC3339 `T` vs SQLite space string-compare | `db.rs:960,1002` (cutoffs), timestamps `token_engine.rs:211` |
| **F7** | High | TALK prompt caching disabled (no `cache_control`) → real overspend on multi-iteration turns | `providers/anthropic.rs:107-126` |
| **F8** | High | Error paths lose real billed usage: API hard-error mid-loop→0/0/0; CLI interrupt/timeout/parse-fail→0/0/0; TALK parse error records nothing | `agentic.rs:166`,`runner.rs:279-294`; `cli_runner.rs:427-519`; `chat_engine.rs:1317-1330` |
| **F9** | High | `cost_by_session` INNER JOIN `sessions` drops TALK/REVIEW rows → breakdown never sums to total | `db.rs:911` |
| **F10** | Medium | Dual pricing authorities; nonzero-cost bypasses router; `ai_complete` UI/DB cost divergence; user-edited router prices ignored on hardcoded paths | `token_engine.rs:176-209`; `commands.rs:4090,4108` |
| **F11** | Medium | Cache dropped from DIRECT persistence + baseline; `total_cached` omits `cache_create`; OpenAI/DeepSeek `cached_tokens` ignored (cached input at 100%) | `run_stages` schema `db.rs:247-249`; `db.rs:892`; `openai_compat.rs:226-228` |
| **F12** | Medium | Workspace deletion orphans `token_events` (FK dropped) → project-scope spend retroactively shrinks | `db.rs:345-379`; project join `db.rs:1750` |
| **F13** | Medium | Budget periods are UTC-day, not local → resets at wrong local time | `db.rs:1729-1732` |
| **F14** | Medium | `session_id` namespace overload (structural root of F1/F9/F12); `increment_session_tokens` no-op for workspace ids; `budget_status(workspace_id)`→`SessionNotFound` | `db.rs:816-836,911,1750`; `token_engine.rs:229-246` |
| **F15** | Medium | CLI cost trusts Claude's `total_cost_usd` (may be $0 under subscription/proxy) with no basis label; token/cost internal inconsistency (cache in cost, not in stored tokens) | `cli_runner.rs:196,216` |
| **F16** | Medium | DIRECT baseline: reference re-priced by hardcoded table → unpriced ref ⇒ savings clamped to $0 misleadingly | `cost.rs:19-21`; `mod.rs:776-778` |
| **F17** | Low | Dead surfaces: `sessions.token_budget`/`budget_status`/`set_budget`/`parse_token_usage`(incl Aider)/`record_token_event` | `token_engine.rs:229-251`; `agent_adapter.rs:48-102`; no frontend callers |
| **F18** | Low | `parse_k_value` overflow → `u64::MAX` → `as i64` wrap → negative rows; no CHECK constraints | `token_engine.rs:390-403` |
| **F19** | Low | `f64` SQL sums, no rounding/currency policy; `$0.21/M` hardcoded local-savings constant | `db.rs:1737,1789` |
| **F20** | Low | No model-id normalization (dated ids, `us.anthropic.*` prefixes) → exact-match $0 | both pricing tables |
| **F21** | Low | `record()` not transactional (insert + increment); `token_events` has no idempotency key | `token_engine.rs:213-219` |
| **F22** | Low | Budget `scope_type`/`period` free-text → malformed row silently becomes global-daily; `consumeOverride` race across concurrent workspaces | `db.rs:1729-1769`; `budgetsStore.ts:132-138` |
| **F23** | Low | CLI `--resume` cost semantics unverified (`total_cost_usd` cumulative vs per-invocation) → potential Resume double-count | `mod.rs:1107-1118` — needs empirical check |
| **F24** | Low | Composer cost-preview heuristic (`OUTPUT_RATIO=0.3`) diverges from actuals; ignores tool-iteration multiplication | `cost.ts:8-72` |
| **F25** | Low | Latent streaming trap: usage read only from a single top-level `usage` block; switching to SSE without `message_start`/`message_delta` / `include_usage` would zero usage | `anthropic.rs:209-225`; `openai_compat.rs:211-218` |

---

## 3. Target architecture

### 3.1 One canonical ledger — `spend_events`

```sql
CREATE TABLE spend_events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_utc                TEXT NOT NULL,             -- RFC3339 UTC 'Z', written by Rust only
  surface               TEXT NOT NULL CHECK (surface IN ('talk','run','direct','review','adhoc')),
  project_id            TEXT,                      -- denormalized at write time (survives workspace delete → fixes F12)
  workspace_id          TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  source_id             TEXT,                      -- thread_id | terminal_id | run_stage_id | call-site tag
  attempt               INTEGER NOT NULL DEFAULT 1,-- DIRECT attempt #; rejected attempts KEEP their rows (fixes F5)
  model_raw             TEXT NOT NULL,             -- exactly what the provider said
  model                 TEXT NOT NULL,             -- normalized id used for pricing (fixes F20)
  input_tokens          INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens         INTEGER NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_creation_tokens >= 0),
  provider_cost_usd     REAL,                      -- provider-reported (claude total_cost_usd); NULL = none
  computed_cost_usd     REAL,                      -- our catalog price; NULL = model unpriced
  cost_usd              REAL NOT NULL,             -- canonical (see §3.4)
  cost_basis            TEXT NOT NULL CHECK (cost_basis IN ('provider','computed','subscription','unpriced','estimated')),
  idempotency_key       TEXT UNIQUE                -- dedupe scanner/replay/retry (fixes F3/F21)
);
CREATE INDEX idx_spend_ts      ON spend_events(ts_utc);
CREATE INDEX idx_spend_project ON spend_events(project_id, ts_utc);
CREATE INDEX idx_spend_ws      ON spend_events(workspace_id, ts_utc);
CREATE INDEX idx_spend_source  ON spend_events(source_id);
```

All writers go through **one** `SpendLedger::record(SpendEvent) -> AppResult<()>` (transactional; fixes F21).
`surface` + `project_id`/`workspace_id`/`source_id` replace the overloaded `session_id` (fixes F14/F9),
so reporting joins are unambiguous and every mode is attributable to a workspace **and** project.

### 3.2 One pricing authority — `pricing`

Delete `cost_per_token`/`compute_cost` as public API. Single entry point
`pricing::price(model_norm) -> Option<ModelPrices>` backed by the **router catalog only**;
`compute_cost_with_prices` stays as the arithmetic. Rules:

- **Normalize first** (fixes F20): strip date suffixes and provider prefixes
  (`claude-sonnet-5-20260203` → `claude-sonnet-5`; `us.anthropic.claude-…` → base id) before lookup.
- **Current catalog** (fixes F2): add `claude-opus-4-8`, `claude-sonnet-5`, `claude-fable-5`,
  `claude-haiku-4-5` with correct prices via the existing builtin-merge migration in
  `ProviderRouter::load()` (`provider_router.rs:187-191`); add a versioned `catalog_version` so upgrades
  merge deterministically; retire stale defaults from pickers without deleting user rows;
  update session default (`session.rs:83`) and MCP recommendation (`tools.rs:603`).
- **Missing model = fail-loud, never silent $0** (fixes F2 tail): record with `cost_basis='unpriced'`,
  `cost_usd=0`, and surface an "unpriced spend: N events / M tokens" banner in Usage + one-time toast.
- **OpenAI cache** (fixes F11): parse `usage.prompt_tokens_details.cached_tokens` in `openai_compat`,
  subtract from billable input, populate real cache prices in the catalog.
- **Enable Anthropic prompt caching** in `build_request` (fixes F7): `cache_control` on system + tools +
  conversation-prefix — the single biggest real-dollar saving, and it makes cache columns meaningful.

### 3.3 Unified budget enforcement — backend `check_budget`

One backend gate `check_budget(project_id, workspace_id) -> BudgetVerdict` (allow / warn(pct) /
block(scope, spent, limit)), reading `spend_events` for global + project + workspace × daily/monthly in
one query. Fixes F4/F13/F22:

- **Cutoffs computed in Rust with `chrono::Local`** (local-midnight / local-month-start → UTC → RFC3339
  parameter). Fixes F6 (string degeneracy), F13 (UTC-day) for budgets *and* reports in one move.
- **TALK:** gate inside `send_agentic` before *each* iteration; blocked mid-turn parks with a persisted
  budget notice (mirror DIRECT `pause_for_budget`). Client gate stays as fast-path UX only.
- **REVIEW:** gate at `ai_complete` entry.
- **DIRECT:** keep per-run `budget_usd` between-stage gate **and** consult global/project/workspace verdict
  at the same point + per-iteration inside the agentic loop.
- **RUN:** cannot be pre-gated (user owns the PTY) — spend *counts toward* budgets and raises warnings,
  never blocks. Say so explicitly in the Budgets UI (honesty over fake control).
- **Override** becomes a backend, scope-keyed, single-use grant (fixes F22 race).
- Constrain `budgets.scope_type`/`period` with CHECK + typed enums (fixes F22 free-text).

### 3.4 Provider-reported vs recomputed cost — decide once at write (fixes F10/F15)

Store both, set `cost_usd` + `cost_basis`:
1. `provider_cost_usd > 0` → `cost_usd = provider`, basis `provider` (keep `computed` for drift).
2. Provider reported **exactly 0** with nonzero tokens on a CLI substrate → basis `subscription`,
   `cost_usd = 0`, but display "included in plan (≈ $X API-equivalent)" from `computed` — never "free".
3. No provider figure → `cost_usd = computed`, basis `computed`.
4. Neither → `unpriced` (surfaced per §3.2).
5. If both exist and `|provider − computed| / provider > 25%` → log price-staleness warning (auto-detects
   an outdated catalog).

All UI money reads `cost_usd` + `cost_basis`. `chat_messages.cost_usd` is retired in favor of joining the
ledger by `source_id` (thread) — the two-costs-per-turn fault (§F10) disappears.

---

## 4. Implementation phases

Each phase is independently shippable, testable, and (where it changes a user-facing surface) updates
`docs/FEATURES.md` §8 per repo policy. Per the implementation-workflow: fresh-subagent code review
before + after each PR, address all findings, then a patch release.

### Phase 0 — Stop the bleeding (independent, ship first)

Small, high-value, low-risk fixes that don't depend on the rebuild. Ordered:

0.1 **F5** — Reject retires spend: call `retire_stage_cost(run, stage.cost_usd, stage.input_tokens,
    stage.output_tokens)` before `reset_run_stage` in the Reject arm (`mod.rs:1070-1091`), mirroring
    Resume (`mod.rs:1107-1112`). Add a regression test.
0.2 **F6** — Fix projection/trend cutoffs: compute cutoffs in Rust as RFC3339 UTC (`Z`) and bind as a
    parameter instead of SQLite `datetime('now', …)`; or normalize stored timestamps to space-separated.
    Add tests asserting `projected_daily_cost` uses a true 1h window and the trend a true 24h window.
0.3 **F2 (interim)** — Add current-model prices to *both* existing tables + a normalizer, so nothing
    prices to $0 before Phase 1 deletes the hardcoded table. Update `session.rs:83` and `tools.rs:603`.
0.4 **F3 (partial)** — Suppress scanner recording during PTY reattach replay: pass the daemon `seq` to
    the scanner hook and only scan chunks with `seq > last_scanned_seq` per terminal (`pty_manager.rs`
    → `commands.rs:1850`). Kills reattach duplicates + most redraw dupes.
0.5 **F11 (partial)** — Parse `prompt_tokens_details.cached_tokens` in `openai_compat.rs:211-228`.
0.6 **F18** — Clamp `parse_k_value`/`parse_dollar_amount` to sane maxima; reject negatives.

### Phase 1 — Pricing authority (one source of truth)

- Introduce `pricing` module: `price(model)`, `normalize_model_id(raw)` (F20), `compute_cost_with_prices`.
- Delete hardcoded `cost_per_token`/`compute_cost` usage everywhere: `chat_engine.rs:746,1416`,
  `ai_complete` (`commands.rs:4090`), `orchestrator/cost.rs:13,20`, scanner (`token_engine.rs:316`).
  All routes now price via the catalog (fixes F10 dual-authority; F16 baseline uses catalog for the
  reference too — and when the reference is unpriced, the savings row says "reference model unpriced"
  instead of clamping to $0).
- Catalog: add current models + `catalog_version` merge (F2); enable Anthropic `cache_control` (F7);
  wire real OpenAI/DeepSeek cache prices (F11).
- Unpriced-model surfacing scaffold (banner data via `token_report`) (F2 tail).
- Tests: pricing table parity, normalization, unpriced fail-loud, cache-aware cost, Anthropic caching
  request shape.

### Phase 2 — `spend_events` ledger (single ledger, all four writers)

- Schema + `SpendLedger::record` (transactional, idempotency key) (§3.1; F14/F21).
- **Writers** (uniform):
  - TALK: per iteration, `surface='talk'`, workspace + `thread_id` source, project denormalized;
    record billed usage even on parse error where the API returned a body (F8 TALK).
  - REVIEW: `ai_complete` → `surface='review'`; resolve `project_id` from the bare project path for
    commit-draft instead of `"ai-adhoc"` (F attribution hole); return the *stored* cost to the UI (F10).
  - DIRECT: on every stage completion/failure **and on retire** — event written when tokens burn,
    **never deleted or zeroed**; `runs.cost_usd` becomes a derived cache (`SUM` over the run's events).
    Retiring/Reject/rerun become display-rollup concerns only → F5 becomes structurally impossible; F1
    resolved (DIRECT now in Usage + budgets). Add `cache_read/cache_creation` to `run_stages` or query
    the ledger by `source_id` (F11 DIRECT cache). Preserve accumulated usage on API hard-error and CLI
    interrupt by flushing partial `out` before propagating (F8 DIRECT); label CLI `subscription` basis
    (F15).
  - RUN: scanner survives only as an **estimator** — `cost_basis='estimated'`,
    `idempotency_key = terminal_id ∥ seq ∥ content_hash`, seq-gated (F3); attribute to the terminal's
    workspace via the `terminals` table so RUN finally participates in workspace/project budgets.
- **Reporting rewrite** on the new table: `token_report` (totals + by-surface + by-model + trend;
  `cost_by_session` replaced by `cost_by_surface`/`cost_by_workspace` — fixes F9), `usage_breakdown`,
  CSV export, `session_recap`. `total_cached = cache_read + cache_creation` (F11). Keep a rounding/
  currency policy helper (F19).
- **Migration:** copy `token_events` classifying `session_id` against `workspaces`/`sessions`/`terminals`
  to set `surface` + attribution; unmatched → `adhoc`. Backfill DIRECT history from `run_stages` +
  archived attempts. Keep `token_events` read-only one release, then drop. Denormalize `project_id` on
  every migrated row (F12).
- **Delete dead code** (F17): `increment_session_tokens`, `budget_status`, `set_budget`,
  `AgentAdapter::parse_token_usage` (+ Aider parser), `record_token_event` command, `sessions.token_budget`
  UI. Update `docs/FEATURES.md` §8.

### Phase 3 — Unified budget enforcement

- Backend `check_budget` + `BudgetVerdict` reading `spend_events`; local-time period cutoffs (F13/F6);
  CHECK-constrained scopes/periods (F22).
- Wire into TALK per-iteration (`send_agentic`), REVIEW (`ai_complete`), DIRECT between-stage +
  per-iteration; RUN warn-only (F4).
- Backend single-use override grant (F22 race).
- Frontend: `budgetsStore`/`chatStore` call the backend verdict (client gate = fast-path only); Budgets
  UI states which modes block vs warn-only; per-message cost preview reconciled/annotated as estimate
  (F24). Update `docs/FEATURES.md` §8 + composer/budget copy.

### Phase 4 — RUN structured telemetry (follow-up, optional)

Replace regex PTY scanning with structured telemetry (Claude Code OTEL env hooks / `--output-format json`
wrappers) so RUN spend is exact rather than estimated (retires the remaining F3 fragility). Verify CLI
`--resume` `total_cost_usd` semantics empirically and add an assertion/test (F23).

---

## 5. Findings → phase coverage matrix

| Phase | Findings resolved |
|-------|-------------------|
| **0** | F5, F6, F2(interim), F3(partial), F11(partial), F18 |
| **1** | F2, F7, F10, F16, F20, F11(pricing side), F25(guard/comment) |
| **2** | F1, F8, F9, F12, F14, F15, F17, F19, F21, F3(estimator/attribution), F11(cache persistence) |
| **3** | F4, F13, F22, F24 |
| **4** | F3(final), F23 |

Every F-ID is addressed. F25 (streaming trap) is a guard/assertion + comment added in Phase 1 (no live
bug today), and revisited if the providers ever move to SSE.

---

## 6. Risks & mitigations

- **Migration correctness.** The `token_events` → `spend_events` reclassification is the riskiest step:
  a `session_id` could theoretically collide across namespaces. Mitigate: classify deterministically
  (workspace → session → terminal precedence), tag ambiguous/unmatched as `adhoc`, keep `token_events`
  read-only for one release, and expose a one-time "reconciliation report" (rows migrated per surface).
- **Historical numbers will change.** DIRECT spend appearing in Usage for the first time, and $0 models
  getting real prices, will make past totals jump. Communicate as a correctness fix; do **not** back-price
  historical `unknown`/`$0` rows silently — mark them `estimated`/`unpriced`.
- **Enabling Anthropic caching** changes request shape and could interact with tool-use turns — gate
  behind tests and verify cache hit-rate in the app (WebKit-vs-jsdom: verify natively, not only vitest).
- **Provider `total_cost_usd = 0` under subscription** must render as "included in plan", never "free" —
  a UX decision baked into `cost_basis`.

## 7. Test plan

- Rust unit: pricing parity + normalization + unpriced fail-loud; cache-aware cost; local-time period
  cutoffs; `SpendLedger::record` idempotency + transactionality; DIRECT retire/Reject/rerun rollup
  invariance (sum of events == derived `runs.cost_usd`); migration classification.
- Rust integration (`tests.rs`): each surface writes exactly one ledger shape; budget verdict across
  scopes/periods; RUN reattach replay records **zero** new events (seq-gated).
- Frontend (vitest + native verify): Usage totals == sum of breakdown; budget block vs warn per mode;
  cost preview labeled estimate. Run `npm run typecheck`.
- Empirical: CLI `--resume` cost semantics (F23); Anthropic cache hit-rate before/after (F7).

## 8. Deliverables checklist (per repo policy)

- [ ] `docs/FEATURES.md` §8 updated at Phase 2 (ledger/reporting) and Phase 3 (enforcement).
- [ ] Fresh-subagent code review before + after each PR; address all findings.
- [ ] Patch release per shipped phase.
- [ ] No hardcoded hexes/fonts in any UI touched (design-system checklist).
