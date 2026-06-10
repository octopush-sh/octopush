# Direct Mode — Pipeline Builder

**Date:** 2026-06-09
**Status:** Design proposal, pending implementation plan
**Scope:** First-class pipeline authoring for Direct mode: create pipelines, edit them in a dedicated canvas view, and **fork-on-edit** builtins so starting from a template never mutates it. Third and last of the Direct UX sub-projects (after the live orchestration view and run navigation). Honors the builder contract fixed in the review-loop spec (§3.7 of `2026-06-08-direct-mode-review-loop-design.md`).

---

## 1. Summary

Pipelines today are read-only: the DB has `list_pipelines`/`get_pipeline_stages`/`insert_pipeline`/`insert_pipeline_stage` + the idempotent seeder, the IPC surface exposes only `list_pipelines`/`get_pipeline`, and `pipelineStore` only loads. Users can pick a template and override per-run models, but cannot create a pipeline, reorder/add/remove stages, change substrates/checkpoints, or configure the review loop — and there is no way to start from a builtin and keep the changes.

This spec adds:
- **One write command, `save_pipeline`,** with the fork rule in the backend: saving a builtin **forks automatically** (your copy is created; the builtin stays intact); saving a custom pipeline updates it in place (transactional stage replacement).
- **`delete_pipeline`** for custom pipelines only.
- **A builder view** — the third state of the Direct canvas (launcher → builder → run view) — with per-stage role/model/substrate/checkpoint and the §3.7 loop controls, reorder via ↑/↓, add/remove stages.
- **Loop targets tracked by stage identity** in the builder (serialized to positions on save), so reordering cannot silently mis-aim a loop — the hazard the L1 code review flagged.

### Goals
- Create, edit, and delete custom pipelines; fork builtins on edit with zero friction.
- Full per-stage authoring: role, model, substrate, checkpoint, loop config (per §3.7).
- Validation enforced in the backend (shared pure function), not only the UI.
- No new top-level chrome: the builder is a canvas state, entered from the launcher.

### Non-goals
- **Drag-and-drop reorder** (↑/↓ buttons; drag is YAGNI for ≤8 stages).
- **DAG / branching pipelines** (linear only, per the original Direct spec).
- **Editing a run's stages** (runs keep their private copies; only templates are authored).
- **Import/export of pipelines** (follow-up if asked).

---

## 2. Backend

### 2.1 `save_pipeline` — create / fork / update in one command

```rust
// commands.rs
#[tauri::command]
pub async fn save_pipeline(
    state: State<'_, AppState>,
    pipeline_id: Option<String>,
    name: String,
    description: String,
    stages: Vec<StageDraft>,   // serde camelCase
) -> AppResult<String>          // the saved pipeline's id (new id when forked/created)
```

`StageDraft` (new, `orchestrator/types.rs` or `db.rs`): `{ role, agent_model, substrate, checkpoint, loop_target_position: Option<i64>, loop_max_iterations: i64, loop_mode: Option<String> }` — position is implied by array order (0..n).

Semantics (in `Db`, transactional via `rusqlite` transaction):
- **`pipeline_id = None`** → `validate` + insert pipeline (`is_builtin = 0`) + insert stages. Returns the new id.
- **`Some(id)` where the pipeline `is_builtin`** → **fork**: same as create, with the given `name`/`description` (the frontend pre-fills "{name} (custom)"). The builtin row and its stages are never touched. Returns the **new** id.
- **`Some(id)` custom** → update `name`/`description`, `DELETE FROM pipeline_stages WHERE pipeline_id = ?`, re-insert the drafts at positions 0..n. All inside one transaction (a failed validation or insert leaves the pipeline unchanged).
- **`Some(id)` not found** → `AppError` ("pipeline not found").

The fork rule living in the backend is defense-in-depth: no frontend path can mutate a builtin.

### 2.2 `delete_pipeline`

```rust
#[tauri::command]
pub async fn delete_pipeline(state: …, pipeline_id: String) -> AppResult<()>
```
Rejects builtins (`AppError`: "builtin pipelines cannot be deleted"). Deleting a custom pipeline cascades its stages (`pipeline_stages` has `FOREIGN KEY(pipeline_id) … ON DELETE CASCADE`). **Run history is safe:** `runs.pipeline_id` has no FK to `pipelines` and every run holds its own `run_stages` copy — past runs render unaffected.

### 2.3 `validate_pipeline_stages` — shared, pure, tested

`pub fn validate_pipeline_stages(stages: &[StageDraft]) -> AppResult<()>` (in `db.rs` next to the pipeline CRUD, or `orchestrator/types.rs`):
- ≥ 1 stage; `name` non-empty (checked in `save_pipeline`).
- `role` ∈ the 10 known roles: `plan, plan_review, implement, code_review, test, repro, fix, verify, critique, refine`.
- `substrate` ∈ `{api, cli}`; `agent_model` non-empty.
- Loop config (§3.7): only on review roles (`plan_review | code_review | critique | verify`); when `loop_target_position` is `Some`: it must be `<` that stage's index and `>= 0`, `loop_max_iterations >= 1`, and `loop_mode` ∈ `{gated, auto}`. When `None`: `loop_max_iterations == 0` and `loop_mode == None` (the builder normalizes; the validator enforces).

Called by `save_pipeline` before any write.

### 2.4 IPC registration

`save_pipeline` + `delete_pipeline` added to `lib.rs`'s invoke handler and `src/lib/ipc.ts` (`savePipeline(draft) -> Promise<string>`, `deletePipeline(id)`), with a `PipelineDraft`/`StageDraft` TS type mirroring the Rust camelCase shape.

---

## 3. Frontend

### 3.1 `pipelineStore`

Adds `save(draft: PipelineDraft) -> Promise<string>` and `remove(pipelineId) -> Promise<void>`; both re-run `load()` afterwards so the launcher list refreshes. Existing `load`/`pipelines`/`error` unchanged.

### 3.2 Canvas state — entering/leaving the builder

`DirectCanvas` gains a **local** state `builder: undefined | null | string` (`undefined` = closed; `null` = compose new; `pipelineId` = edit that one). Precedence: when `builder !== undefined`, render `<PipelineBuilder …>`; else the existing viewed-run/launcher logic. Closing (save or cancel) sets it back to `undefined` (and save re-loads pipelines via the store). Local state is acceptable: leaving Direct mode discards an unsaved draft — a known, simple tradeoff.

### 3.3 `PipelineSetup` (launcher) — entry points

- Each pipeline card gets a discreet **Edit** affordance (mono, mute, hover-brass) → `onEditPipeline(p.pipeline.id)`.
- Below the cards, the CTA **`⟶ Compose a new pipeline`** (serif phrase, brass `⟶`, upright) → `onEditPipeline(null)`.
- New prop: `onEditPipeline: (pipelineId: string | null) => void` (wired by `DirectCanvas` to set `builder`).

### 3.4 `PipelineBuilder` (new component)

Full-canvas editor, Atelier voice (roman numerals, `⟶`, tokens, English, no italics):
- **Header:** editable `name` (serif, large) + `description` (sans); eyebrow `I · Name the pipeline` / `II · Assemble the stages` mirroring the launcher's numbered sections.
- **Stage list (vertical cards):** each card shows its roman numeral and: role `<select>` (10 known roles via `labelForRole`); `ModelPicker` (reused; `allowedProviders={["anthropic"]}` when substrate is `cli`); substrate toggle `api | cli`; checkpoint toggle; **loop controls only for review roles**: *Return to →* (a `<select>` of EARLIER stages by label), *Max loop-backs* (number ≥1), *Mode* `gated | auto` (auto shows the §3.7 hint: "Auto relies on the reviewer emitting a parseable verdict; it gates to you otherwise."). Reorder ↑/↓; remove (✕); `+ Add a stage` appends a sensible default (`implement`, sonnet, api, checkpoint off).
- **Loop-target integrity:** the draft stores each loop target as the **target stage's draft id** (a local uuid), not a number. Reordering re-renders the *Return to* options; on save, ids serialize to positions. If a reorder/removal makes a target invalid (not strictly earlier, or deleted), the loop config is cleared and the card shows a one-line notice ("Loop target removed — review is linear again."). Save serializes + the backend re-validates.
- **Footer:** primary **`Save pipeline ⟶`** — when editing a builtin the label is **`Save as my copy ⟶`** and the name pre-fills `{name} (custom)`; **Cancel**; **Delete** (custom only, with an inline confirm). Save errors (backend validation) render in rouge above the footer.

### 3.5 Data flow

Launcher *Edit/Compose* → `DirectCanvas.builder` → `PipelineBuilder` loads the pipeline's stages from `pipelineStore` (already in memory via `load`) into a local draft → user edits → **Save** → `pipelineStore.save(draft)` → `save_pipeline` (validate → create/fork/update) → store `load()` → builder closes → launcher shows the updated list (the forked copy appears beside the intact builtin).

---

## 4. Edge cases

- **Forking with an unchanged name** → copy named "{name} (custom)" (pre-filled; user may rename before saving).
- **Deleting the pipeline you're editing** → confirm → delete → builder closes → launcher.
- **A pipeline with runs gets edited/deleted** → past runs unaffected (own `run_stages` copy; no FK).
- **Stage count bounds** → min 1 (validator); the run track renders ≤8 roman numerals (`ROMAN` array falls back to numbers) — no hard max, builder allows any count.
- **CLI substrate + non-Anthropic model** → the ModelPicker restriction prevents it at edit time (same rule as the launcher's per-run override).
- **Unsaved draft on mode switch** → discarded (local state; documented tradeoff).

---

## 5. Testing

- **Rust:** `validate_pipeline_stages` (each rule, valid/invalid); `save_pipeline` create / fork-leaves-builtin-intact (assert builtin stages unchanged + new id returned) / update-in-place (transactional: invalid draft leaves prior stages) / not-found; `delete_pipeline` rejects builtin, deletes custom + stages.
- **Vitest:** `pipelineStore.save/remove` call IPC + reload; `PipelineSetup` Edit/Compose affordances fire `onEditPipeline`; `PipelineBuilder` — renders a loaded pipeline, edits a field, add/remove/reorder updates numerals, **reorder remaps/clears loop targets correctly**, builtin shows "Save as my copy ⟶" + pre-filled name, save serializes ids→positions.

---

## 6. Decomposition (plans)

- **Plan P1 — backend:** `StageDraft` + `validate_pipeline_stages` + `Db::save_pipeline`/`delete_pipeline` (transactional) + the two commands + `ipc.ts` types/wrappers. Fully testable without UI.
- **Plan P2 — builder UI:** `pipelineStore.save/remove`; `DirectCanvas` builder state; `PipelineSetup` entry points; `PipelineBuilder` component + tests.

---

## 7. Open decisions

1. **Role list fixed vs free-text** — fixed to the 10 known roles (they map to system prompts/artifact kinds); a custom-role escape hatch is a follow-up. **Decided: fixed.**
2. **Where the fork name comes from** — pre-filled "{name} (custom)", user-editable before save. **Decided.**
3. **Unsaved-draft persistence** — not persisted across mode switches (local state). Acceptable; revisit only if it bites.

---

## 8. Consistency check (self-review)

- Fork rule in the backend (`save_pipeline` on a builtin → copy), UI only adjusts the label ✓. §3.7 builder contract honored (3 loop controls, validations, auto-mode hint) ✓. Loop-target-by-identity in the draft kills the reorder hazard; backend re-validates positions ✓. Transactional stage replacement keeps customs consistent on failure ✓. Run history decoupled (own copies, no FK) — verified against the schema ✓. No new chrome (canvas state) ✓; design-system voice (numerals, `⟶`, serif CTAs upright, tokens, English) ✓. Two shippable plans ✓.
