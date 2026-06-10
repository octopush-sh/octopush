# Pipeline Builder — Plan P1 (backend: save/fork/delete + validation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The write path for pipeline authoring: a validated, transactional `save_pipeline` (create / **fork-on-builtin** / update-in-place) and `delete_pipeline` (customs only), exposed over IPC — fully testable without UI (the builder UI is Plan P2).

**Architecture:** A `StageDraft` input type + a pure `validate_pipeline_stages` (the §3.7 loop contract + role/substrate rules) live in `db.rs` beside the pipeline CRUD. `Db::save_pipeline` runs inside a rusqlite `unchecked_transaction` (Db methods are `&self`); the fork rule (builtin → copy) is decided here, not in the UI. `delete_pipeline` deletes stages + row explicitly (no reliance on FK cascade). Two thin Tauri commands + `ipc.ts` wrappers.

**Tech Stack:** Rust (rusqlite, serde), Tauri commands, TypeScript IPC contract.

**Spec:** `docs/superpowers/specs/2026-06-09-direct-pipeline-builder-design.md` §2. Plan P2 (builder UI) is separate.

---

## File map
- **Modify** `src-tauri/src/db.rs` — `StageDraft`, `validate_pipeline_stages`, `Db::save_pipeline`, `Db::delete_pipeline`.
- **Modify** `src-tauri/src/commands.rs` — `save_pipeline` + `delete_pipeline` commands.
- **Modify** `src-tauri/src/lib.rs` — register both in the invoke handler.
- **Modify** `src/lib/ipc.ts` — `StageDraft`/`PipelineDraft` types + `savePipeline`/`deletePipeline` wrappers.
- **Modify** `src-tauri/src/tests.rs` — tests in `mod pipeline_crud_tests` (it already has a `test_db()` helper).

---

### Task 1: `StageDraft` + `validate_pipeline_stages` (pure)

**Files:** Modify `src-tauri/src/db.rs`; test in `src-tauri/src/tests.rs`.

- [ ] **Step 1 — Write the failing tests.** Add inside the existing `mod pipeline_crud_tests` in `src-tauri/src/tests.rs` (it has `fn test_db() -> Db`):
```rust
    fn draft(role: &str) -> crate::db::StageDraft {
        crate::db::StageDraft {
            role: role.into(), agent_model: "claude-haiku-4-5".into(), substrate: "api".into(),
            checkpoint: false, loop_target_position: None, loop_max_iterations: 0, loop_mode: None,
        }
    }

    #[test]
    fn validate_pipeline_stages_enforces_roles_substrates_and_loop_contract() {
        use crate::db::{validate_pipeline_stages, StageDraft};
        // valid linear pipeline
        assert!(validate_pipeline_stages(&[draft("plan"), draft("implement")]).is_ok());
        // empty pipeline / unknown role / bad substrate / empty model
        assert!(validate_pipeline_stages(&[]).is_err());
        assert!(validate_pipeline_stages(&[draft("dance")]).is_err());
        let mut bad_sub = draft("plan"); bad_sub.substrate = "ftp".into();
        assert!(validate_pipeline_stages(&[bad_sub]).is_err());
        let mut no_model = draft("plan"); no_model.agent_model = "".into();
        assert!(validate_pipeline_stages(&[no_model]).is_err());

        // valid gated loop: code_review at index 1 loops back to 0
        let mut review = draft("code_review");
        review.loop_target_position = Some(0); review.loop_max_iterations = 2; review.loop_mode = Some("gated".into());
        assert!(validate_pipeline_stages(&[draft("implement"), review.clone()]).is_ok());

        // loop on a non-review role
        let mut looped_impl = draft("implement");
        looped_impl.loop_target_position = Some(0); looped_impl.loop_max_iterations = 2; looped_impl.loop_mode = Some("gated".into());
        assert!(validate_pipeline_stages(&[draft("plan"), looped_impl]).is_err());
        // target not strictly earlier (self)
        let mut self_loop = review.clone(); self_loop.loop_target_position = Some(1);
        assert!(validate_pipeline_stages(&[draft("implement"), self_loop]).is_err());
        // target out of range
        let mut far = review.clone(); far.loop_target_position = Some(5);
        assert!(validate_pipeline_stages(&[draft("implement"), far]).is_err());
        // max 0 with a target / bad mode
        let mut zero = review.clone(); zero.loop_max_iterations = 0;
        assert!(validate_pipeline_stages(&[draft("implement"), zero]).is_err());
        let mut mode = review.clone(); mode.loop_mode = Some("magic".into());
        assert!(validate_pipeline_stages(&[draft("implement"), mode]).is_err());
        // no target but leftover loop fields → invalid (builder must normalize)
        let mut leftover = draft("code_review"); leftover.loop_max_iterations = 2;
        assert!(validate_pipeline_stages(&[draft("implement"), leftover]).is_err());
    }
```
- [ ] **Step 2 — Run, confirm FAIL to compile:** `cd src-tauri && cargo test --lib validate_pipeline_stages 2>&1 | tail -15`
- [ ] **Step 3 — Implement in `db.rs`** (place right before `pub struct PipelineRow` near the other pipeline types, or after `seed_builtin_pipelines`):
```rust
/// A builder-authored stage. Position is the array index; the loop contract
/// (review-loop spec §3.7) is enforced by [`validate_pipeline_stages`].
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StageDraft {
    pub role: String,
    pub agent_model: String,
    pub substrate: String,
    pub checkpoint: bool,
    pub loop_target_position: Option<i64>,
    pub loop_max_iterations: i64,
    pub loop_mode: Option<String>,
}

const KNOWN_ROLES: &[&str] = &[
    "plan", "plan_review", "implement", "code_review", "test",
    "repro", "fix", "verify", "critique", "refine",
];
const REVIEW_ROLES: &[&str] = &["plan_review", "code_review", "critique", "verify"];

/// Validate a pipeline's stage drafts (the §3.7 builder contract). Pure.
pub fn validate_pipeline_stages(stages: &[StageDraft]) -> crate::error::AppResult<()> {
    use crate::error::AppError;
    if stages.is_empty() {
        return Err(AppError::Other("a pipeline needs at least one stage".into()));
    }
    for (i, s) in stages.iter().enumerate() {
        if !KNOWN_ROLES.contains(&s.role.as_str()) {
            return Err(AppError::Other(format!("unknown stage role '{}'", s.role)));
        }
        if !matches!(s.substrate.as_str(), "api" | "cli") {
            return Err(AppError::Other(format!("unknown substrate '{}'", s.substrate)));
        }
        if s.agent_model.trim().is_empty() {
            return Err(AppError::Other(format!("stage {} has no model", i + 1)));
        }
        match s.loop_target_position {
            Some(target) => {
                if !REVIEW_ROLES.contains(&s.role.as_str()) {
                    return Err(AppError::Other(format!("stage '{}' cannot carry a loop (not a review role)", s.role)));
                }
                if target < 0 || target >= i as i64 {
                    return Err(AppError::Other("loop target must be an earlier stage".into()));
                }
                if s.loop_max_iterations < 1 {
                    return Err(AppError::Other("loop max iterations must be at least 1".into()));
                }
                if !matches!(s.loop_mode.as_deref(), Some("gated") | Some("auto")) {
                    return Err(AppError::Other("loop mode must be 'gated' or 'auto'".into()));
                }
            }
            None => {
                if s.loop_max_iterations != 0 || s.loop_mode.is_some() {
                    return Err(AppError::Other("loop fields set without a loop target".into()));
                }
            }
        }
    }
    Ok(())
}
```
- [ ] **Step 4 — Run, confirm PASS:** `cd src-tauri && cargo test --lib validate_pipeline_stages 2>&1 | tail -8`. Then full: `cargo test --lib 2>&1 | tail -5` (ignore the ~5 `pty_*` `PermissionDenied` sandbox failures if present).
- [ ] **Step 5 — Commit:**
```bash
git add src-tauri/src/db.rs src-tauri/src/tests.rs
git commit -m "feat(direct/builder-p1): StageDraft + validate_pipeline_stages (§3.7 contract)"
```

---

### Task 2: `Db::save_pipeline` (create / fork / update) + `Db::delete_pipeline`

**Files:** Modify `src-tauri/src/db.rs`; test in `src-tauri/src/tests.rs`.

- [ ] **Step 1 — Write the failing tests** (in `mod pipeline_crud_tests`, reusing `draft()` from Task 1):
```rust
    #[test]
    fn save_pipeline_creates_forks_builtins_and_updates_customs() {
        let db = test_db();
        db.seed_builtin_pipelines().unwrap();
        let ff = db.list_pipelines().unwrap().into_iter().find(|p| p.name == "Feature Factory").unwrap();
        let ff_stages_before = db.get_pipeline_stages(&ff.id).unwrap();

        // CREATE: no id → new custom pipeline.
        let created = db.save_pipeline(None, "Mine", "d", &[draft("plan"), draft("implement")]).unwrap();
        let mine = db.list_pipelines().unwrap().into_iter().find(|p| p.id == created).unwrap();
        assert!(!mine.is_builtin);
        assert_eq!(db.get_pipeline_stages(&created).unwrap().len(), 2);

        // FORK: saving a builtin returns a NEW id; the builtin is untouched.
        let forked = db.save_pipeline(Some(ff.id.clone()), "Feature Factory (custom)", "my copy", &[draft("plan")]).unwrap();
        assert_ne!(forked, ff.id);
        let ff_stages_after = db.get_pipeline_stages(&ff.id).unwrap();
        assert_eq!(ff_stages_before.len(), ff_stages_after.len()); // builtin intact
        assert_eq!(db.get_pipeline_stages(&forked).unwrap().len(), 1);
        assert!(!db.list_pipelines().unwrap().iter().find(|p| p.id == forked).unwrap().is_builtin);

        // UPDATE: saving a custom updates in place (same id, replaced stages + meta).
        let updated = db.save_pipeline(Some(created.clone()), "Mine v2", "d2", &[draft("plan"), draft("implement"), draft("test")]).unwrap();
        assert_eq!(updated, created);
        let row = db.list_pipelines().unwrap().into_iter().find(|p| p.id == created).unwrap();
        assert_eq!(row.name, "Mine v2");
        assert_eq!(db.get_pipeline_stages(&created).unwrap().len(), 3);

        // INVALID draft → error AND the custom's prior stages survive (transactional).
        let err = db.save_pipeline(Some(created.clone()), "Mine v3", "d3", &[draft("dance")]);
        assert!(err.is_err());
        assert_eq!(db.get_pipeline_stages(&created).unwrap().len(), 3); // unchanged
        assert_eq!(db.list_pipelines().unwrap().into_iter().find(|p| p.id == created).unwrap().name, "Mine v2");

        // Unknown id → error.
        assert!(db.save_pipeline(Some("nope".into()), "x", "d", &[draft("plan")]).is_err());
        // Empty name → error.
        assert!(db.save_pipeline(None, "   ", "d", &[draft("plan")]).is_err());
    }

    #[test]
    fn delete_pipeline_rejects_builtins_and_removes_customs_with_stages() {
        let db = test_db();
        db.seed_builtin_pipelines().unwrap();
        let ff = db.list_pipelines().unwrap().into_iter().find(|p| p.name == "Feature Factory").unwrap();
        assert!(db.delete_pipeline(&ff.id).is_err()); // builtin protected

        let id = db.save_pipeline(None, "Mine", "d", &[draft("plan")]).unwrap();
        db.delete_pipeline(&id).unwrap();
        assert!(db.list_pipelines().unwrap().iter().all(|p| p.id != id));
        assert!(db.get_pipeline_stages(&id).unwrap().is_empty()); // stages gone too
    }
```
- [ ] **Step 2 — Run, confirm FAIL to compile:** `cd src-tauri && cargo test --lib save_pipeline_creates 2>&1 | tail -15`
- [ ] **Step 3 — Implement in `db.rs`** (after `seed_builtin_pipelines`). `Db` methods are `&self`, so use `unchecked_transaction` (rolls back on drop if not committed):
```rust
    /// Create, fork, or update a pipeline from builder drafts (validated).
    /// - `None` → create a new custom pipeline.
    /// - `Some(builtin)` → FORK: a new custom copy is created; the builtin is never touched.
    /// - `Some(custom)` → update meta + replace the stage set, transactionally.
    /// Returns the saved pipeline's id (the new id when created/forked).
    pub fn save_pipeline(
        &self,
        pipeline_id: Option<&str>,
        name: &str,
        description: &str,
        stages: &[StageDraft],
    ) -> AppResult<String> {
        use crate::error::AppError;
        if name.trim().is_empty() {
            return Err(AppError::Other("the pipeline needs a name".into()));
        }
        validate_pipeline_stages(stages)?;

        // Resolve the edit target: does it exist, and is it a builtin?
        let target: Option<(String, bool)> = match pipeline_id {
            Some(id) => Some(
                self.conn
                    .query_row(
                        "SELECT id, is_builtin FROM pipelines WHERE id = ?1",
                        params![id],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0)),
                    )
                    .optional()?
                    .ok_or_else(|| AppError::Other("pipeline not found".into()))?,
            ),
            None => None,
        };

        let tx = self.conn.unchecked_transaction()?;
        let saved_id = match target {
            // Update a custom pipeline in place.
            Some((id, false)) => {
                tx.execute(
                    "UPDATE pipelines SET name = ?2, description = ?3 WHERE id = ?1",
                    params![id, name, description],
                )?;
                tx.execute("DELETE FROM pipeline_stages WHERE pipeline_id = ?1", params![id])?;
                id
            }
            // Create (no target) or fork (builtin target): a fresh custom pipeline.
            _ => {
                let id = Uuid::new_v4().to_string();
                let now = Utc::now().to_rfc3339();
                tx.execute(
                    "INSERT INTO pipelines (id, name, description, is_builtin, created_at)
                     VALUES (?1,?2,?3,0,?4)",
                    params![id, name, description, now],
                )?;
                id
            }
        };
        for (i, s) in stages.iter().enumerate() {
            tx.execute(
                "INSERT INTO pipeline_stages
                    (id, pipeline_id, position, role, agent_model, substrate, checkpoint,
                     loop_target_position, loop_max_iterations, loop_mode)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![Uuid::new_v4().to_string(), saved_id, i as i64, s.role, s.agent_model,
                        s.substrate, s.checkpoint as i64,
                        s.loop_target_position, s.loop_max_iterations, s.loop_mode],
            )?;
        }
        tx.commit()?;
        Ok(saved_id)
    }

    /// Delete a custom pipeline and its stages. Builtins are protected.
    pub fn delete_pipeline(&self, pipeline_id: &str) -> AppResult<()> {
        use crate::error::AppError;
        let is_builtin: bool = self
            .conn
            .query_row(
                "SELECT is_builtin FROM pipelines WHERE id = ?1",
                params![pipeline_id],
                |r| Ok(r.get::<_, i64>(0)? != 0),
            )
            .optional()?
            .ok_or_else(|| AppError::Other("pipeline not found".into()))?;
        if is_builtin {
            return Err(AppError::Other("builtin pipelines cannot be deleted".into()));
        }
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM pipeline_stages WHERE pipeline_id = ?1", params![pipeline_id])?;
        tx.execute("DELETE FROM pipelines WHERE id = ?1", params![pipeline_id])?;
        tx.commit()?;
        Ok(())
    }
```
  Notes: `params!`, `Uuid`, `Utc`, and `.optional()` (`rusqlite::OptionalExtension`) are already imported/used in `db.rs` — verify `OptionalExtension` is in scope (it's used by `get_run`); add the `use` if not.
- [ ] **Step 4 — Run, confirm PASS:** `cd src-tauri && cargo test --lib pipeline 2>&1 | tail -10`, then `cargo test --lib 2>&1 | tail -5`.
- [ ] **Step 5 — Commit:**
```bash
git add src-tauri/src/db.rs src-tauri/src/tests.rs
git commit -m "feat(direct/builder-p1): Db::save_pipeline (create/fork/update, transactional) + delete_pipeline"
```

---

### Task 3: IPC — commands + frontend contract

**Files:** Modify `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/lib/ipc.ts`.

- [ ] **Step 1 — Add the commands** in `commands.rs` (next to `get_pipeline`, in the Direct-mode section):
```rust
#[tauri::command]
pub async fn save_pipeline(
    state: State<'_, AppState>,
    pipeline_id: Option<String>,
    name: String,
    description: String,
    stages: Vec<crate::db::StageDraft>,
) -> AppResult<String> {
    state.db.lock().save_pipeline(pipeline_id.as_deref(), &name, &description, &stages)
}

#[tauri::command]
pub async fn delete_pipeline(
    state: State<'_, AppState>,
    pipeline_id: String,
) -> AppResult<()> {
    state.db.lock().delete_pipeline(&pipeline_id)
}
```
- [ ] **Step 2 — Register them** in `lib.rs`'s invoke handler, next to `commands::get_pipeline,`:
```rust
            commands::save_pipeline,
            commands::delete_pipeline,
```
- [ ] **Step 3 — Frontend contract** in `src/lib/ipc.ts`. Next to the `PipelineWithStages` types (~line 30), add:
```ts
/** A builder-authored stage (position = array index). */
export interface StageDraft {
  role: string;
  agentModel: string;
  substrate: AgentSubstrate;
  checkpoint: boolean;
  loopTargetPosition: number | null;
  loopMaxIterations: number;
  loopMode: "gated" | "auto" | null;
}
export interface PipelineDraft {
  pipelineId: string | null; // null = create; a builtin id = fork; a custom id = update
  name: string;
  description: string;
  stages: StageDraft[];
}
```
  And next to `listPipelines` (~line 468), the wrappers:
```ts
  savePipeline: (draft: PipelineDraft) =>
    invoke<string>("save_pipeline", {
      pipelineId: draft.pipelineId,
      name: draft.name,
      description: draft.description,
      stages: draft.stages,
    }),

  deletePipeline: (pipelineId: string) =>
    invoke<void>("delete_pipeline", { pipelineId }),
```
- [ ] **Step 4 — Verify:** `cd src-tauri && cargo build 2>&1 | grep -iE "warning|error" | grep -v "never used.*\bids\b" | head` (no NEW warnings — note the commands are `pub` + registered, so no dead-code), `cargo test --lib 2>&1 | tail -4`; from the worktree root `npm run typecheck` (clean — additive types).
- [ ] **Step 5 — Commit:**
```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/lib/ipc.ts
git commit -m "feat(direct/builder-p1): save_pipeline + delete_pipeline over IPC"
```

---

## Self-review (against spec §2)

- **`save_pipeline` create / fork-on-builtin / update-in-place, transactional, fork rule in the backend** → Task 2 (tests assert the builtin's stages are untouched and a failed update leaves prior stages). ✓
- **`delete_pipeline` rejects builtins, removes stages explicitly** (no CASCADE reliance) → Task 2. ✓
- **`validate_pipeline_stages`** — every §2.3 rule has a test case (roles, substrate, model, loop-on-review-only, target strictly earlier, max ≥1, mode set, leftover-fields normalization) → Task 1. ✓
- **IPC: 2 commands + TS types/wrappers** → Task 3. ✓
- **Run history safety** — no change to runs; nothing to do in P1 (verified in the spec). ✓
- **Out of scope (P2):** pipelineStore.save/remove, DirectCanvas builder state, PipelineSetup entry points, PipelineBuilder component. ✓

**Type consistency:** `StageDraft` (Rust, camelCase serde) ↔ `StageDraft` (TS) field-for-field (`loopTargetPosition: number|null` ↔ `Option<i64>`). `Db::save_pipeline(Option<&str>, &str, &str, &[StageDraft]) -> AppResult<String>`; command takes `Option<String>`/`Vec<StageDraft>` and forwards. `delete_pipeline(&str)`. `validate_pipeline_stages(&[StageDraft])`. Test helper `draft(role)` used by both Task 1 and Task 2 tests (defined once in `pipeline_crud_tests`).

**Harness note:** tests live in the existing `mod pipeline_crud_tests` (has `fn test_db() -> Db`); `seed_builtin_pipelines` is callable on a fresh test DB. If `OptionalExtension` isn't already imported at the top of `db.rs`, add `use rusqlite::OptionalExtension;` (grep first — `get_run` uses `.optional()`).
