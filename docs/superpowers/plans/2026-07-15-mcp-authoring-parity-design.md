# MCP authoring parity — roles & routines

**Date:** 2026-07-15 · **Surface:** `octopush-mcp` (the MCP server, `src-tauri/src/bin/octopush-mcp/`) · **Goal:** an AI agent driving Octopush over MCP can author **everything a user authors by hand** — not just pipelines and workspaces, but **custom roles** and **routines** too.

## Why

The MCP is the substrate that lets any CLI/agent design Octopush work (`[[direct-reusable-pipelines]]`, `[[octopush-mcp-server]]`). Today it authors pipelines (with per-stage effort + escalation, v0.4.14), workspaces, and run drafts. But two authoring surfaces the app exposes have **zero** MCP coverage:

- **Custom roles** — an agent can reference roles in a pipeline stage (`role: "..."`), but cannot **create** the custom roles a good pipeline depends on. So "design me the best pipeline" is capped at the built-in role vocabulary.
- **Routines** — the scheduled-crew surface (v0.4.9 + fire-condition v0.4.16) is entirely un-authorable over MCP.

The user's ask: *"un agente debe ser capaz de hacer todo lo que yo puedo hacer manualmente — crear pipelines, crear roles con todas sus configuraciones, crear routines."*

## Boundary (unchanged invariant): author, don't execute

The MCP stays **read + author, never execute / never spend tokens** (`[[octopush-mcp-server]]`). This shapes two decisions:

- **No `run_routine_now` over MCP.** Firing a crew *now* is direct execution/token spend — it stays in the app (the "Run now" button), exactly as launching a run stays in the app (`create_run` only stages a `draft`).
- **A routine authored over MCP is created DISABLED by default.** Consistent with `create_run` staging a draft: the agent authors it, the user reviews it in Settings → Routines and enables it (or the agent enables it on an explicit `enabled: true`, when the user directed that). An enabled routine's scheduler *will* fire crews and spend tokens on schedule — so enabling is opt-in, never the silent default of an authoring call. `set_routine_enabled` is provided for the explicit case. (Note: `db.insert_routine` hardcodes `enabled=1`; the MCP inserts then disables unless `enabled:true` was passed — one shared insert path, no schema change.)

**Entitlement:** authoring is NOT gated at the MCP layer (it can't reliably read the signed entitlement with the app closed, and pipeline authoring is already ungated). The runtime gate is the real enforcement — the scheduler **re-checks `routines.scheduled` per fire**, so a routine authored (even enabled) for a non-Pro user simply never fires. Documented in the tool text so an agent isn't surprised.

## Slice A — Roles (ships first, its own PR + release)

Three tools, mirroring the app's `list_roles` / `save_role` / `delete_role` and routing through the SAME `Db` methods (`list_roles`, `get_role`, `upsert_role`, `role_in_use`, `delete_role`) — no logic fork.

- **`list_roles`** — every role (built-in + custom), each with its full config. An agent calls this to learn the role vocabulary before authoring a pipeline (the pipeline schema already points here).
- **`save_role`** — create or update a **custom** role. Input mirrors `RoleDef` with the app's new-role defaults so the agent supplies only `label` + `promptBody` for a basic role:
  - `label` (required), `promptBody` (required, non-empty).
  - `key` (optional) — the stable identity a pipeline stage references (`role: "<key>"`). Omit → derived from `label` with the **exact** app algorithm (`deriveRoleKey`: lowercase, non-alphanumeric runs → `_`, collapse repeats, trim `_`). Returned so the agent can wire it into stages.
  - `description` "" · `artifactKind` `note` (enum plan|review|tests|diff|note) · `environment` `worktree` (enum worktree|action) · `canLoop` false · `defaultTools` `["read_file","list_files"]` (subset of the 4 workspace tools) · `defaultSubstrate` `api` (api|cli) · `defaultCheckpoint` false · `tokenEstIn` 4000 · `tokenEstOut` 1000.
  - Guards (mirror `save_role` + `upsert_role`): `is_builtin` forced false; empty key/prompt rejected; a key that maps to a **built-in** is rejected with a clear message (never overwrite a built-in); invalid enum → clean tool error (serde through the typed `RoleDef`, wrapped, never a panic). Returns the saved role.
- **`delete_role`** — delete a **custom** role by key. Guards: refuse built-ins; refuse a role **in use** by any pipeline/run stage (`role_in_use`) with a clear message. Returns `{deleted: key}`.

**Discovery:** extend `describe_pipeline_schema` with a `customRoles` section — the `RoleDef` field contract, the enum values, the defaults, the key rules, and that `save_role` authors them. It's the natural home (the guide already lists roles and says "custom roles are valid"). No separate describe tool.

Best-effort library sync (the app's Pro cloud-library push) is **skipped** in the MCP (async HTTP, app-closed context, already best-effort) — the app re-syncs the role on its next in-app edit/focus. Noted as a known, benign gap.

## Slice B — Routines (ships second, its own PR + release)

Five tools, mirroring `list_routines` / `create_routine` / `update_routine` / `delete_routine` / `set_routine_enabled`, routing through `Db` (`insert_routine`, `update_routine`, `delete_routine`, `set_routine_enabled`, `get_routine`, `list_routines`) and the **shared** `octopush_lib::routines::{validate_routine, validate_schedule, next_due}` (all already `pub`) so validation + `next_due` never drift from the app.

- **`create_routine`** — deserialize the routine into the typed `RoutineInput` (camelCase serde, same as the Tauri command), validate, compute `next_due`, insert **disabled** (unless `enabled:true`), return the id. Fields: `name`, `projectId`, `pipelineId`, `task`, `scheduleKind` (interval|daily), `scheduleSpec` (**interval**: whole seconds ≥ 60, e.g. `"3600"` = hourly; **daily**: `"HH:MM"` 24h), `workspaceMode` (fixed|fresh, default fixed), `fixedWorkspaceId` (required for fixed), `baseBranch`/`branchPrefix` (fresh), `referenceModel`, `stageOverrides`, `budgetUsd`, `fireCondition` (the exit-0 pre-fire gate), `enabled` (default false).
- **`update_routine`** — same shape, by id; recompute `next_due`; leaves `enabled` untouched (matches the app).
- **`delete_routine`** — by id (ungated, like the app).
- **`set_routine_enabled`** — `{routineId, enabled}`; enabling re-seats `next_due` from now (via shared `next_due`), disabling preserves it. Tool text: enabling means the scheduler fires crews / spends tokens on schedule (Pro-gated at fire time; only fires while the app runs — phase-1).
- **`list_routines`** — all routines with schedule, mode, enabled, `next_due`, `last_outcome`/`last_checked_at`.

**Referential integrity (the agent passes raw strings — validate, don't store danglers):** `create_routine`/`update_routine` verify `projectId` exists, `pipelineId` exists, and for `fixed` mode that `fixedWorkspaceId` is present, exists, and belongs to the project. `fresh` requires daily (shared `validate_routine`). Clear tool errors, not a silent routine that fails at fire time — the MCP-contract lesson from v0.4.14.

**Discovery:** the routine tools carry rich per-field `inputSchema` descriptions (kind/spec formats, the fixed/fresh rule, the fire-condition semantics, the disabled-default + fire-time gate). Routines aren't a pipeline concept, so no `describe_pipeline_schema` entry; a short `note` field on `create_routine` covers the cross-field rules.

## Tests (Rust, in `tools.rs` `#[cfg(test)]`, same harness as pipelines)

Roles: save with only label+prompt applies defaults + derives key; explicit key preserved; overwriting a built-in key rejected; invalid `artifactKind` → clean error naming the field; `delete_role` refuses built-in + in-use; round-trips through `db.get_role`. Routines: create defaults disabled; `enabled:true` inserts enabled; unknown project/pipeline/fixed-workspace rejected; fresh+interval rejected; interval < 60s rejected; daily bad `HH:MM` rejected; `next_due` computed; `set_routine_enabled` toggles + re-seats; `update_routine` recomputes and leaves enabled alone; camelCase round-trip.

## Docs / FEATURES.md / memory

- `docs/octopush-mcp.md`: move roles + routines from Roadmap to shipped; document the tools, the author-not-execute boundary for routines (disabled default, no run-now, fire-time gate).
- `docs/FEATURES.md`: the MCP tool catalogue gains roles (3) + routines (5); note parity with the in-app surfaces.
- `[[octopush-mcp-server]]` memory: record the parity + the two boundary decisions + the "validate referential integrity so the contract holds" reinforcement.

## Out of scope (this initiative)

`run_routine_now` (execution); `create_project` / `archive_workspace` / `delete_workspace` (a separate, smaller parity gap — note for later); non-shell fire conditions; any run-launching from MCP (already the standing boundary).
