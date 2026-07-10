# Pro-real Part B — Cross-machine run-history sync

> Detailed plan for the second Pro pillar (after parallel/background runs, A1–A3).
> Companion to [`pro-real-implementation-plan.md`](pro-real-implementation-plan.md).
> The `history.sync` entitlement already exists (Pro-granted, **unenforced**).

## What this delivers
A signed-in **Pro** user sees their **Direct-run history across every machine** — the runs they kicked off on their laptop show up on their desktop, with task, status, cost, when, and which machine. This is the "continue your work across devices" goal, scoped sanely.

## What the audit found (this shapes everything)
- **Terminal runs are immutable.** Once a run is `completed`/`aborted`, every row (`runs`, `run_stages`, `stage_log`, `stage_iterations`, `run_events`) is frozen — nothing reopens it. ⇒ **Sync = append-only replication keyed by run `id`. No conflict resolution.** (Only in-flight runs mutate; we sync on terminal.)
- **Cheap vs expensive split is clean.** `runs` + `run_stages` *metadata* (task/status/cost/tokens/role/model/timestamps) = **KB per run**. The heavy data — `stage_log` journals (dominant volume), `diff_snapshot` columns (full worktree diffs), `artifact`/`stage_iterations` — is separable and fetchable lazily.
- **Greenfield.** No export/backup/cloud/sync code exists. `octopush-api` is billing-only.
- **Auth surface:** the desktop holds an opaque Clerk **access token**; a backend resolves the user via Clerk `/oauth/userinfo` → `sub` (exactly as the app does). No `id_token`/JWKS yet (planned). **No DB row carries an owner** — sync must add the owner dimension server-side.
- **Workspace-FK snag:** `runs` FK → `workspaces` (machine-local git worktrees). A pulled run from another machine has **no local workspace**. ⇒ v1 must NOT merge into the FK-constrained `runs` table.

## Architecture decision

**Recommended: a serverless sync API (extend `octopush-api`) + a hosted SQLite-native DB (Turso/libSQL), keyed by Clerk `sub`.**
- **Why Turso (libSQL):** the run/stage schema maps 1:1 to the app's SQLite (trivial parity); generous free tier; per-user rows by `owner_sub`. (Neon Postgres is the fallback if a relational standard is preferred.)
- **Auth:** desktop sends `Authorization: Bearer <access token>`; the function resolves `sub` via Clerk and **re-checks `public_metadata.plan == pro` server-side** (the gate isn't client-only). Later: swap to JWKS/JWT verification (the planned hardening) to avoid a userinfo round-trip per call.
- **Owner dimension:** synced tables get `owner_sub` (set from the authenticated principal — never trusted from the client) + `machine_id` (a stable per-install id, for "from MacBook Pro" attribution).
- **Alternatives considered:** *(B) blob-snapshot sync* — cheapest infra (no DB, just per-user blobs) but coarse + no server query; viable if we want the absolute-minimum backend. *(C) managed local-first sync* (Turso embedded replicas / PowerSync / ElectricSQL) — overkill for append-only history + deep integration into the app's core SQLite. **A wins** for clean per-user isolation + queryability + reuse of the existing serverless+Clerk pattern.

## Phasing

### B1 — Cloud-backed run history + a global "History" view *(the v1)*
- **Backend (`octopush-api`):** `POST /api/sync/runs` (upsert run + stage **metadata** by id, owner from the principal) and `GET /api/sync/runs?since=<cursor>` (the user's runs across machines). Pro-gated server-side.
- **Push (desktop):** at the terminal-state chokepoint (`set_run_status`→`emit_run_update`, `orchestrator/mod.rs:713/831/1022`), if Pro + `history.sync`, push that run's metadata. Idempotent.
- **Pull + store (desktop):** `sync_pull_history()` (on launch + manual refresh) writes pulled runs into a **new local `synced_runs` table** — separate from the FK-constrained `runs` (sidesteps the workspace-FK snag). Read-only mirror.
- **View:** a new **"History"** surface (global, e.g. a Companion panel or a dedicated view) listing synced runs across machines: task · status · cost · when · machine. Read-only in B1.
- **Gate:** `history.sync` on the sync commands → `AppError::UpgradeRequired` (reuses the upgrade sheet); enforced server-side too.
- **Effort:** medium — a real backend + DB, but the schema is small + append-only. The biggest new surface is the backend + the History view.

### B2 — Lazy journals & artifacts
Opening a synced run fetches its full `stage_log` journal + `diff_snapshot`s from the cloud (pushed to a blob/heavy table on terminal, fetched on open). Turns "see the run" into "read what the agent actually did, from any machine."

### B3 — Continue-from-another-machine *(hard; likely deferred)*
True continuation needs the **git repo + worktree** on machine B — not just the run data. Realistically this becomes "re-run this pipeline here" (recreate a workspace from the repo + the synced pipeline) rather than resuming the exact paused run. Big; defer or reshape.

### Adjacent (separate, smaller) — Pipeline/role **library** sync
Custom pipelines + roles are install-global (no owner today). A Pro user expects their library to follow them. Small, mostly-immutable templates — a clean, separate sync (not `history.sync`). Can land before or after B1.

## ⚠️ Honest strategic note (timing)
Unlike A1–A3 (all in the app), **B1 needs a new backend + DB** — a standing piece of infra (free tiers cover early usage; cost grows with use) and ongoing maintenance, for a feature that benefits **multi-machine Pro users** — a slice of a customer base that's ~zero today. Per the [[octopush-gtm-backlog]], pre-customers, **Apple signing, GitHub/Google sign-in, custom-domain email, and Direct-as-the-hook deliver more value per effort.** B1 is a legit Pro pillar and a real "multi-machine" selling point — but it's an investment *ahead* of demand. Reasonable to **build it now** (if multi-machine is a headline Pro promise) **or defer** until there's a paying user who'd use it.

## Decisions needed before building B1
1. **Backend/DB:** Turso (libSQL, recommended) vs Neon (Postgres) vs blob-snapshot (cheapest).
2. **Scope/timing:** build B1 now, or defer in favor of the higher-ROI GTM items?
