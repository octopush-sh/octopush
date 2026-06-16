# DIRECT mode — data-driven roles & user-defined roles

**Date:** 2026-06-15
**Status:** Approved design, ready for implementation plan
**Area:** `src-tauri/src/orchestrator/`, `src-tauri/src/db.rs`, `src-tauri/src/commands.rs`, `src/components/builder/`, `src/components/` (Role Editor), `src/lib/`

## Problem

A DIRECT-mode stage's **role** (plan, implement, code_review, …) is an archetype that bundles a system-prompt body, an artifact kind, loop eligibility, default tools, and a token estimate. Today every role is **hardcoded and triplicated** across ~10 sites — `system_prompt_for` / `artifact_kind_for` (runner.rs), `KNOWN_ROLES` / `REVIEW_ROLES` and builtin loop-seeding (db.rs), `est_tokens` (commands.rs), the MCP schema (octopush-mcp/tools.rs), and `ARCHETYPES` (builder/graph.ts) + `labelForRole` (stageMeta.ts). Adding one role means editing all of them in sync, and **users cannot define their own roles at all** (an unknown role string is rejected by `validate_pipeline_stages`).

Two needs:
1. **New built-in roles** — including the `pull_request` / `merge` / `release` action roles deferred from the halt-recovery work. That work surfaced the root issue: those actions were stuffed into a `verify` (review) stage whose prompt says *"Do not modify files"* and whose preamble says *"Do not commit, push, or otherwise manage git."* There is no role whose contract permits git/external side-effects.
2. **User-defined roles** — a first-class, reusable role the user authors themselves.

## Goals

- Make a role **first-class data** (a `roles` table) so all role behavior derives from one source of truth, killing the Rust/TS triplication.
- Seed the 10 existing roles **with byte-identical prompts/behavior** (zero behavior change) plus 5 new built-ins: `architect`, `security_review`, `pull_request`, `merge`, `release`.
- Introduce an **environment contract** (`worktree` | `action`) per role; the runner selects the preamble by contract. `action` roles may commit/push/run releases and default to **checkpoint-gated + CLI substrate**.
- Let users **create/edit custom roles** as full archetypes (name, description, prompt, artifact kind, environment, tools, loop-eligible, default substrate, default checkpoint), stored in a **global role library**, reusable in any pipeline.
- Built-in roles are **read-only with fork-on-edit** (the existing pipeline pattern).
- Ship the **Role Editor** as the approved conversational "Design B" surface (prompt-as-hero; settings as an editable natural-language brief). It must follow Octopush's **design principles** — **theme-agnostic** (design tokens only, never a hardcoded theme/color/font; Octopush supports multiple themes), minimalist and visually clean, an "AI tool" feel, token-driven smooth enter/exit transitions, intuitive UI, **icons over text where possible with tooltips to resolve ambiguity**, no italics, professional and minimal. It deliberately drops the decorative brass *rule*, the `⟶` prompt glyph, and the `✦` flourish (see Design-system hygiene below).

## Non-goals (explicit follow-ups)

- AI **auto-suggest** of role settings from the prompt text (the chips inferring kind/tools/env as you type). The Role Editor ships with click-to-edit chips; inference is a later enhancement.
- A **Vellum** light theme. Previewed during design only; not part of this work.
- Reworking checkpoint **concurrency** (double-tap resolution) — pre-existing, out of scope.
- Sharing/exporting role libraries between machines/users.

---

## Design

### A. The role as data

New table `roles` (global, like `pipelines`):

| column | type | notes |
|---|---|---|
| `key` | TEXT PK | stable identifier (e.g. `code_review`, `perf_audit`); snake_case |
| `label` | TEXT | display name ("Code review") |
| `description` | TEXT | one-line palette description |
| `prompt_body` | TEXT | the archetype prompt (no preamble; that's composed) |
| `artifact_kind` | TEXT | `plan` \| `review` \| `tests` \| `diff` \| `note` |
| `environment` | TEXT | `worktree` \| `action` |
| `can_loop` | INTEGER | 1 ⇒ may carry a review loop |
| `default_tools` | TEXT (JSON) | always populated, e.g. `["read_file","list_files"]` (the 4 keys: read_file, list_files, write_file, run_command) |
| `default_substrate` | TEXT | `api` \| `cli` |
| `default_checkpoint` | INTEGER | 1 ⇒ stages of this role default to a checkpoint |
| `token_est_in` / `token_est_out` | INTEGER | for the cost estimate |
| `is_builtin` | INTEGER | 1 ⇒ read-only (fork-on-edit) |
| `created_at` | TEXT | |

Seeded on first run (idempotent, like the builtin pipelines). Custom roles are simply rows with `is_builtin = 0`.

**Resolution timing:** roles resolve **by key at execution** (consistent with today — the runner looks up behavior when a stage runs). Built-ins are stable (read-only). Editing a custom role affects future stage runs (expected). Completed runs are unaffected (their artifact is already stored). Referential integrity: `delete_role` is rejected if any pipeline stage references the key (see §E).

### B. Environment contract & preamble

Two preambles replace the single `PIPELINE_PREAMBLE`:

- **`worktree`** (today's preamble, verbatim): non-interactive pipeline worker; *"leave any code changes uncommitted in the working tree… Do not commit, push, or otherwise manage git."*
- **`action`** (new): non-interactive pipeline worker that *"may commit, push, and run release/deploy commands (git, gh, the release script, etc.) as the role instructs. Complete the action, then summarize what you did."*

`compose_system_prompt` selects the preamble by the role's `environment`, then appends `prompt_body`, then the author's per-stage `instructions`, then (for auto-loop review stages) the `VERDICT_INSTRUCTION` (unchanged).

`action` roles seed `default_substrate = cli` (they need git/gh/shell) and `default_checkpoint = 1` (human approval before an irreversible side-effect). Both are overridable per stage in the builder.

### C. New built-in roles

| key | label | kind | env | can_loop | tools | substrate | checkpoint | prompt gist |
|---|---|---|---|---|---|---|---|---|
| `architect` | Architect | plan | worktree | no | read-only | api | no | "Senior architect. Propose the high-level approach, structure, and trade-offs before any detailed plan. Do not write code." |
| `security_review` | Security review | review | worktree | yes | read-only | api | no | "Security reviewer. Inspect the changes for vulnerabilities (injection, authz, secrets, unsafe deserialization, path traversal…). Report concrete issues with severity. Do not modify files." |
| `pull_request` | Pull request | note | action | no | full (run_command → git/gh) | cli | yes | "Release/PR engineer. Commit the accumulated worktree changes on a feature branch, push, and open a pull request with a clear title and body. Report the PR URL." |
| `merge` | Merge | note | action | no | full (run_command → git/gh) | cli | yes | "Merge the open pull request for this work once checks pass. Report the merge result." |
| `release` | Release | note | action | no | full (run_command → git/gh/npm) | cli | yes | "Run the project's release process (e.g. the release script) to publish the next version. Report the released version and any follow-up." |

(Exact prompt text is finalized in the plan; the 10 existing roles are seeded verbatim from today's `system_prompt_for`.)

### D. Backend refactor (single source of truth)

- **runner.rs** — `compose_system_prompt` takes the resolved role definition (prompt_body + environment) rather than matching on the role string. `artifact_kind_for` reads the role's `artifact_kind`. The hardcoded matches are deleted; a thin `RoleDef` struct carries the fields the runner needs. The orchestrator resolves the `RoleDef` by key (via `db.get_role`) when building the stage spec.
- **db.rs** — `validate_pipeline_stages` checks the role key exists in `roles` (replacing `KNOWN_ROLES`); loop eligibility checks the role's `can_loop` (replacing `REVIEW_ROLES`). Builtin loop-seeding keys off `can_loop` + the role's relation to code stages rather than hardcoded role strings. New: `list_roles`, `get_role`, `upsert_role`, `delete_role`.
- **commands.rs** — `est_tokens` reads the role's `token_est_*`. New Tauri commands: `list_roles`, `save_role` (create / **fork-on-builtin** / update), `delete_role` (referential-integrity guarded).
- **octopush-mcp/tools.rs** — the role enum/descriptions in the MCP schema are generated from `list_roles` (or documented as "see list_roles") instead of a hardcoded list.

### E. Frontend

- **Builder palette** (`builder/graph.ts` + `NodePalette.tsx`) — `ARCHETYPES` is replaced by roles loaded from `list_roles` (cached in a store). The palette groups roles (Plan & design / Build / Review / Action / Your roles), marks `action` roles, shows `is_builtin` 🔒 and `custom`. `archetypeFor`, `isReviewArchetype`, `newStageData` derive from the loaded roles.
- **`labelForRole`** (stageMeta.ts) — derives from loaded roles (fallback to the key).
- **Role Editor** (new component) — the approved **Design B**: the prompt is the hero (large serif composer, no rule/glyph/✦); below it, the settings render as an editable natural-language brief ("A **Review** role that works in the **worktree**, uses **read-only tools**, and **loops back**… Runs on **API**."), each bracketed token a click-to-edit chip backed by the same fields as the data model (kind, environment, tools, loop, substrate, checkpoint). Name is inline-editable; `key` is auto-derived (snake_case) and shown. `action` selection flips the brief to amber wording and auto-sets checkpoint + CLI (overridable). Save writes via `save_role`; editing a built-in **forks** a custom copy. Design tokens only (theme-agnostic), motion via the existing primitives (`<Reveal>`, `<FadeSwap>`, token-driven durations/easing for smooth enter/exit), icon controls with tooltips for ambiguous affordances, copy in English.
- The Role Editor is reachable from the palette's "＋ New role" and from a built-in's edit affordance (which forks).

**Design-system hygiene.** This work retires three decorative flourishes from new surfaces: the brass **rule** divider (`docs/design-system.md` §3), the `⟶` **prompt glyph** used as ornament (§5 signature details), and the `✦` flourish (never codify it). Update `docs/design-system.md` and the mirrored rules in `CLAUDE.md` to mark these as retired for new surfaces and to state the minimalism principles above as the canonical guidance. **Out of scope:** ripping existing *structural* glyph uses out app-wide — the Direct run-track flow connector (`⟶`), the checkpoint gate (`⟜`), and the `§` tool-call prefix stay until separately decided; this change governs the design docs and new surfaces, not a global removal.

### F. Migration & compatibility

- The `roles` table is seeded idempotently with the existing 10 keys + 5 new. Existing `pipeline_stages` / `run_stages` store role **keys** that resolve against the seeded rows → existing pipelines and in-flight runs keep working unchanged.
- The 10 seeded built-ins carry **identical** prompt bodies / artifact kinds / loop eligibility / tool defaults / token estimates to today's hardcoded values — verified by a test that compares seeded output to the (pre-refactor) `system_prompt_for` strings.
- Unknown role key at execution (e.g. a deleted custom role somehow still referenced) → the stage fails cleanly with a clear "unknown role '<key>'" message (no silent generic fallback), and `delete_role` prevents the common case by refusing deletion of an in-use role.

## Data model changes

- New table `roles` (§A). Additive; no changes to `pipeline_stages` / `run_stages` (they already store `role` as TEXT + `instructions` / `tools` / `custom_name`).
- Frontend `Role` type in `ipc.ts` mirroring the row (camelCase).

## IPC changes

- `listRoles() -> Role[]`
- `saveRole(role) -> Role` (create / fork-on-builtin / update)
- `deleteRole(key) -> void` (errors if in use)

## Error handling / edge cases

- **Fork-on-builtin:** editing a built-in creates a custom copy with a new key (e.g. `code_review_copy`), never mutates the built-in.
- **Delete in use:** `delete_role` enumerates `pipeline_stages` for the key; if any, returns an error naming the pipelines.
- **Action role without git/gh available:** the stage runs via CLI; if `gh`/`git` is missing it fails with the CLI's error surfaced through the existing halt diagnostics (already shipped).
- **Key collisions:** `save_role` rejects a key that already exists (for create); auto-derive de-dupes.
- **Behavior-parity:** the seed must reproduce today's prompts exactly (test-enforced) so no existing run changes behavior.

## Testing

- **Rust:** seed-parity test (seeded built-in prompts == legacy `system_prompt_for` for all 10 keys); `compose_system_prompt` picks the right preamble per environment; validation accepts seeded + custom keys and rejects unknown; loop eligibility from `can_loop`; `delete_role` refuses in-use; fork-on-builtin produces a new key.
- **Frontend:** palette renders roles from `listRoles` (built-in 🔒 + action + custom groups); Role Editor: key auto-derivation, action→checkpoint+CLI auto-set, fork-on-edit of a built-in, save round-trip; `labelForRole` from loaded roles.
- `npm run typecheck` + `cargo test` green.
- Adversarial review of the action-role prompts/contract (they perform irreversible ops) and the seed-parity.

## Phasing (for the plan)

1. **Foundation** — `roles` table + seed the existing 10 (parity) + the backend refactor to read from data (no behavior change, no new UI). Ship-able alone.
2. **New built-ins** — seed `architect`, `security_review`, `pull_request`, `merge`, `release` + the `action` preamble/contract.
3. **Custom roles** — `save_role`/`delete_role` + the Role Editor (Design B) + palette wired to `listRoles`.

## Rollout

Single feature branch off `main` (which now includes the halt-recovery work). Additive migration; back-compatible. The new `action` roles directly close the gap that caused the original verify-stage halt.
