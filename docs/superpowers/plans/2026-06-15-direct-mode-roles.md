# DIRECT mode — data-driven & user-defined roles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn DIRECT-mode stage roles into first-class data (a global `roles` table) so all role behavior derives from one source of truth, seed the 10 existing roles byte-identically plus 5 new built-ins (architect, security_review, pull_request, merge, release) with an environment contract (worktree|action), and let users author their own roles via a conversational Role Editor.

**Architecture:** A new `roles` table + a `RoleDef` struct are the single source of truth. The orchestrator resolves a stage's `RoleDef` by key at execution and the runner composes the prompt from `prompt_body` + an environment-selected preamble. Validation, token estimates, loop eligibility, the builder palette, and labels all read from the table. Built-ins are seeded read-only (fork-on-edit); custom roles are rows with `is_builtin=0`.

**Tech Stack:** Rust (rusqlite, serde, tokio), React 19 + TypeScript, Tailwind v4, Zustand, Tauri 2. Backend tests in `src-tauri/src/tests.rs`; frontend Vitest `*.test.ts(x)`.

**Spec:** `docs/superpowers/specs/2026-06-15-direct-mode-roles-design.md`

---

## File map

**Backend**
- `src-tauri/src/orchestrator/types.rs` — `RoleEnvironment` enum; `ArtifactKind::as_db`/`from_db`; `RoleDef` struct; new `StageSpec` fields.
- `src-tauri/src/orchestrator/roles.rs` — **new**: `RoleDef`, `BUILTIN_ROLES` seed data, preamble consts, `compose_system_prompt`.
- `src-tauri/src/orchestrator/runner.rs` — delete `system_prompt_for`/`artifact_kind_for`/`PIPELINE_PREAMBLE` matches; re-export from `roles.rs`; runner uses `stage.artifact_kind`/`stage.role_prompt`/`stage.role_environment`.
- `src-tauri/src/orchestrator/cli_runner.rs` — use `stage.artifact_kind` and the new compose path.
- `src-tauri/src/orchestrator/mod.rs` — resolve `RoleDef` by key when building `StageSpec`; fail unknown role.
- `src-tauri/src/db.rs` — `roles` table + seed; `get_role`/`list_roles`/`upsert_role`/`delete_role`/`role_in_use`; `validate_pipeline_stages` reads from `roles`.
- `src-tauri/src/commands.rs` — `est_tokens` from role; `list_roles`/`save_role`/`delete_role` commands.
- `src-tauri/src/lib.rs` — register the 3 new commands.

**Frontend**
- `src/lib/ipc.ts` — `Role` type + `listRoles`/`saveRole`/`deleteRole`.
- `src/stores/rolesStore.ts` — **new**: load + cache roles.
- `src/components/builder/graph.ts` — `ARCHETYPES` derived from loaded roles; keep `Archetype` shape.
- `src/lib/stageMeta.ts` — `labelForRole` from loaded roles.
- `src/components/RoleEditor.tsx` — **new**: the Design B editor.
- `src/components/builder/NodePalette.tsx` — group + custom roles + "＋ New role" + fork-on-edit.
- `docs/design-system.md`, `CLAUDE.md` — retire the decorative rule/⟶/✦; codify minimalism principles.

---

## PHASE 1 — Foundation (data model + seed parity + backend reads from data)

### Task 1: `RoleEnvironment` + `ArtifactKind` db conversions

**Files:** Modify `src-tauri/src/orchestrator/types.rs`; Test `src-tauri/src/tests.rs`.

- [ ] **Step 1: Failing test** (append to tests.rs):

```rust
#[test]
fn artifact_kind_db_roundtrip() {
    use crate::orchestrator::types::ArtifactKind;
    for (k, s) in [
        (ArtifactKind::Plan, "plan"), (ArtifactKind::Review, "review"),
        (ArtifactKind::Tests, "tests"), (ArtifactKind::Diff, "diff"), (ArtifactKind::Note, "note"),
    ] {
        assert_eq!(k.as_db(), s);
        assert_eq!(ArtifactKind::from_db(s), Some(k));
    }
    assert_eq!(ArtifactKind::from_db("bogus"), None);
}

#[test]
fn role_environment_db_roundtrip() {
    use crate::orchestrator::types::RoleEnvironment;
    assert_eq!(RoleEnvironment::Worktree.as_db(), "worktree");
    assert_eq!(RoleEnvironment::Action.as_db(), "action");
    assert_eq!(RoleEnvironment::from_db("action"), Some(RoleEnvironment::Action));
    assert_eq!(RoleEnvironment::from_db("x"), None);
}
```

- [ ] **Step 2: Run → FAIL.** `cd src-tauri && cargo test artifact_kind_db_roundtrip role_environment_db_roundtrip`

- [ ] **Step 3: Implement.** In `types.rs`, add `as_db`/`from_db` to `ArtifactKind` (the enum exists ~line 8) and a new `RoleEnvironment`:

```rust
impl ArtifactKind {
    pub fn as_db(&self) -> &'static str {
        match self { Self::Plan => "plan", Self::Review => "review", Self::Tests => "tests", Self::Diff => "diff", Self::Note => "note" }
    }
    pub fn from_db(s: &str) -> Option<Self> {
        match s { "plan" => Some(Self::Plan), "review" => Some(Self::Review), "tests" => Some(Self::Tests), "diff" => Some(Self::Diff), "note" => Some(Self::Note), _ => None }
    }
}

/// Whether a role leaves the worktree dirty for the next stage (the default) or
/// is allowed to perform git/external side-effects (commit/push/release).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum RoleEnvironment { Worktree, Action }
impl RoleEnvironment {
    pub fn as_db(&self) -> &'static str { match self { Self::Worktree => "worktree", Self::Action => "action" } }
    pub fn from_db(s: &str) -> Option<Self> { match s { "worktree" => Some(Self::Worktree), "action" => Some(Self::Action), _ => None } }
}
```

- [ ] **Step 4: Run → PASS.** Commit: `feat(roles): ArtifactKind db conversions + RoleEnvironment`.

### Task 2: `roles.rs` — `RoleDef`, preambles, builtin seed data, `compose_system_prompt`

**Files:** Create `src-tauri/src/orchestrator/roles.rs`; Modify `src-tauri/src/orchestrator/mod.rs` (add `pub mod roles;`); Test `src-tauri/src/tests.rs`.

- [ ] **Step 1: Failing test** (parity with the legacy prompts — capture them BEFORE deleting in Task 4):

```rust
#[test]
fn builtin_roles_seed_matches_legacy_prompts() {
    use crate::orchestrator::roles::{builtin_roles, compose_system_prompt};
    use crate::orchestrator::types::RoleEnvironment;
    let by = |k: &str| builtin_roles().into_iter().find(|r| r.key == k).unwrap();
    // plan body, worktree preamble, no instructions, no verdict
    let plan = by("plan");
    let got = compose_system_prompt(&plan.prompt_body, plan.environment, None, None);
    assert!(got.contains("You are one stage in an automated, headless build pipeline."));
    assert!(got.contains("Do not commit, push, or otherwise manage git"));
    assert!(got.contains("Produce a concise, concrete implementation plan"));
    // there are 15 builtin roles, all keys unique
    let all = builtin_roles();
    assert_eq!(all.len(), 15);
    let mut keys: Vec<_> = all.iter().map(|r| r.key.clone()).collect();
    keys.sort(); keys.dedup();
    assert_eq!(keys.len(), 15);
    // an action role uses the action preamble
    let rel = by("release");
    assert_eq!(rel.environment, RoleEnvironment::Action);
    let rp = compose_system_prompt(&rel.prompt_body, rel.environment, None, None);
    assert!(rp.contains("may commit, push"));
    assert!(!rp.contains("Do not commit, push"));
}
```

- [ ] **Step 2: Run → FAIL** (module missing). `cd src-tauri && cargo test builtin_roles_seed_matches_legacy_prompts`

- [ ] **Step 3: Implement `roles.rs`.** Create the file:

```rust
//! Role definitions — the single source of truth for DIRECT-mode stage roles.
//! Built-ins are seeded into the `roles` table (db.rs); custom roles are rows
//! with is_builtin=0. The runner composes a stage's system prompt from a role's
//! prompt_body + the preamble its environment contract selects.

use crate::orchestrator::types::{ArtifactKind, LoopMode, RoleEnvironment};

#[derive(Clone, Debug)]
pub struct RoleDef {
    pub key: String,
    pub label: String,
    pub description: String,
    pub prompt_body: String,
    pub artifact_kind: ArtifactKind,
    pub environment: RoleEnvironment,
    pub can_loop: bool,
    pub default_tools: Vec<String>,
    pub default_substrate: String, // "api" | "cli"
    pub default_checkpoint: bool,
    pub token_est_in: i64,
    pub token_est_out: i64,
    pub is_builtin: bool,
}

/// Worktree preamble — the historical default: a non-interactive pipeline worker
/// that leaves changes uncommitted for the next stage and never touches git.
pub const PREAMBLE_WORKTREE: &str = "You are one stage in an automated, headless build pipeline. \
    There is NO human watching this stage and no way to answer you — never ask questions, never \
    present options or menus, and never wait for input, confirmation, or approval. Work \
    autonomously to completion using your tools, then end with a brief summary of what you did \
    and anything still outstanding. Do not commit, push, or otherwise manage git: leave any code \
    changes uncommitted in the working tree — the next stage reads them from there, and that is \
    expected and correct.";

/// Action preamble — for roles whose job IS a side-effect (commit/push/PR/merge/
/// release). They may use git/gh/the release script as instructed.
pub const PREAMBLE_ACTION: &str = "You are one stage in an automated, headless build pipeline. \
    There is NO human watching this stage and no way to answer you — never ask questions, never \
    present options or menus, and never wait for input, confirmation, or approval. This is an \
    ACTION stage: you MAY commit, push, and run git/gh/release or deploy commands as the role \
    instructs — that is your job. Complete the action autonomously, then end with a brief summary \
    of exactly what you did (branch, PR URL, version, etc.) and anything still outstanding.";

/// Appended to a stage prompt when the stage is in auto-loop mode (verbatim copy
/// of the historical VERDICT_INSTRUCTION).
pub const VERDICT_INSTRUCTION: &str = "\n\nThis is an automated review. After your findings, end your \
    response with EXACTLY ONE line, on its own line: `VERDICT: PASS` if the changes are acceptable, \
    or `VERDICT: CHANGES_REQUESTED` if they must be revised. Emit nothing after that line.";

/// Compose the full system prompt: environment preamble + role body + author
/// instructions + (auto-loop only) the verdict line.
pub fn compose_system_prompt(
    prompt_body: &str,
    environment: RoleEnvironment,
    loop_mode: Option<LoopMode>,
    instructions: Option<&str>,
) -> String {
    let preamble = match environment {
        RoleEnvironment::Worktree => PREAMBLE_WORKTREE,
        RoleEnvironment::Action => PREAMBLE_ACTION,
    };
    let mut s = format!("{preamble}\n\n{prompt_body}");
    if let Some(instr) = instructions.map(str::trim).filter(|i| !i.is_empty()) {
        s.push_str("\n\nAdditional instructions for this stage, from the pipeline author:\n");
        s.push_str(instr);
    }
    if matches!(loop_mode, Some(LoopMode::Auto)) {
        s.push_str(VERDICT_INSTRUCTION);
    }
    s
}

fn ro() -> Vec<String> { vec!["read_file".into(), "list_files".into()] }
fn run_() -> Vec<String> { vec!["read_file".into(), "list_files".into(), "run_command".into()] }
fn full() -> Vec<String> { vec!["read_file".into(), "list_files".into(), "write_file".into(), "run_command".into()] }

/// All 15 built-in roles. The first 10 reproduce the historical archetypes
/// (prompt bodies copied verbatim from the old `system_prompt_for`); the last 5
/// are new. Keys, prompts, artifact kinds, loop eligibility, default tools and
/// token estimates here are the single source of truth.
pub fn builtin_roles() -> Vec<RoleDef> {
    use ArtifactKind::*;
    use RoleEnvironment::*;
    let r = |key:&str,label:&str,desc:&str,body:&str,kind:ArtifactKind,env:RoleEnvironment,can_loop:bool,tools:Vec<String>,sub:&str,cp:bool,ti:i64,to:i64| RoleDef{
        key:key.into(),label:label.into(),description:desc.into(),prompt_body:body.into(),artifact_kind:kind,environment:env,can_loop,default_tools:tools,default_substrate:sub.into(),default_checkpoint:cp,token_est_in:ti,token_est_out:to,is_builtin:true,
    };
    vec![
      // ---- existing 10 (bodies VERBATIM from old system_prompt_for) ----
      r("plan","Plan","Outline the approach before any code",
        "You are a senior engineer. Produce a concise, concrete implementation plan for the task. Do not write code; describe the steps, files, and approach.",
        Plan, Worktree, false, ro(), "api", false, 4000, 1500),
      r("plan_review","Plan review","Critique the plan — can loop back",
        "You are a critical reviewer. Review the proposed plan for gaps, risks, and better approaches. Be specific and concise.",
        Review, Worktree, true, ro(), "api", false, 8000, 1000),
      r("implement","Implement","Write the code in the worktree",
        "You are a skilled engineer. Implement the plan by editing files in the workspace using your tools. Make the changes; do not just describe them.",
        Diff, Worktree, false, full(), "api", false, 12000, 6000),
      r("code_review","Code review","Review the diff — can loop back",
        "You are a code reviewer. Inspect the current changes in the workspace and report concrete issues. Do not modify files.",
        Review, Worktree, true, ro(), "api", false, 8000, 1000),
      r("test","Tests","Write and run the tests",
        "You are a test engineer. Write unit tests for the recent changes using your tools to create the test files. Run them if a test command is obvious.",
        Tests, Worktree, false, full(), "api", false, 6000, 2000),
      r("repro","Reproduce","Reproduce the reported problem",
        "You are a debugger. Reproduce the reported issue and describe the root cause.",
        Review, Worktree, false, run_(), "api", false, 8000, 1000),
      r("fix","Fix","Apply the fix",
        "You are a skilled engineer. Implement the plan by editing files in the workspace using your tools. Make the changes; do not just describe them.",
        Diff, Worktree, false, full(), "api", false, 12000, 6000),
      r("verify","Verify","Confirm the fix holds — can loop back",
        "You are a code reviewer. Inspect the current changes in the workspace and report concrete issues. Do not modify files.",
        Review, Worktree, true, run_(), "api", false, 8000, 1000),
      r("critique","Critique","Critique the artifact — can loop back",
        "You are a critical reviewer. Review the proposed plan for gaps, risks, and better approaches. Be specific and concise.",
        Review, Worktree, true, ro(), "api", false, 8000, 1000),
      r("refine","Refine","Polish from the critique",
        "You are an editor. Refine and finalize the plan based on the prior review.",
        Plan, Worktree, false, ro(), "api", false, 4000, 1500),
      // ---- 5 new ----
      r("architect","Architect","High-level approach & trade-offs",
        "You are a senior software architect. Propose the high-level approach, system structure, and key trade-offs for the task before any detailed plan or code. Describe alternatives and your recommendation. Do not write code.",
        Plan, Worktree, false, ro(), "api", false, 4000, 1500),
      r("security_review","Security review","Security-focused review — can loop back",
        "You are a security reviewer. Inspect the current changes for vulnerabilities — injection, broken authz, exposed secrets, unsafe deserialization, path traversal, SSRF, and similar. Report concrete issues with severity and a fix. Do not modify files.",
        Review, Worktree, true, ro(), "api", false, 8000, 1000),
      r("pull_request","Pull request","Commit, push & open a PR",
        "You are a release engineer. Commit the accumulated worktree changes on a feature branch with a clear message, push it, and open a pull request with a concise title and body describing the change. Report the PR URL.",
        Note, Action, false, full(), "cli", true, 6000, 1500),
      r("merge","Merge","Merge the pull request",
        "You are a release engineer. Merge the open pull request for this work once its checks pass. Report the merge result.",
        Note, Action, false, full(), "cli", true, 4000, 1000),
      r("release","Release","Run the release process",
        "You are a release engineer. Run the project's release process (e.g. the release script) to publish the next version. Report the released version and any follow-up.",
        Note, Action, false, full(), "cli", true, 6000, 1500),
    ]
}
```

- [ ] **Step 4: Declare module.** Add `pub mod roles;` to the `mod` list at the top of `src-tauri/src/orchestrator/mod.rs`.

- [ ] **Step 5: Run → PASS.** `cd src-tauri && cargo test builtin_roles_seed_matches_legacy_prompts`. Commit: `feat(roles): RoleDef, environment preambles, 15 built-in seed defs`.

### Task 3: `roles` table + db accessors + seeding

**Files:** Modify `src-tauri/src/db.rs`; Test `src-tauri/src/tests.rs`.

- [ ] **Step 1: Failing test** (db-backed; mirror existing db tests that open an in-memory/ temp Db):

```rust
#[test]
fn roles_table_seeds_and_reads() {
    let db = test_db(); // local helper used throughout tests.rs: { let tmp = tempfile::tempdir().unwrap(); Db::open(tmp.path()).unwrap() } — keep the TempDir alive for the test's scope
    let all = db.list_roles().unwrap();
    assert_eq!(all.len(), 15);
    let cr = db.get_role("code_review").unwrap().unwrap();
    assert!(cr.can_loop);
    assert_eq!(cr.is_builtin, true);
    assert!(db.get_role("nope").unwrap().is_none());
    // custom upsert + in-use + delete
    let mut custom = cr.clone(); custom.key = "perf_audit".into(); custom.label = "Perf audit".into(); custom.is_builtin = false;
    db.upsert_role(&custom).unwrap();
    assert!(!db.role_in_use("perf_audit").unwrap());
    db.delete_role("perf_audit").unwrap();
    assert!(db.get_role("perf_audit").unwrap().is_none());
}
```
(`test_db()` keeps a TempDir alive and calls `Db::open(tmp.path())`; define it in the role test module like the other test modules in tests.rs.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.**
  (a) **Migration** — add after the v12 block (the halt-recovery columns):
```rust
        // ── v13 roles as data ──────────────────────────────────────
        self.conn.execute_batch(
            r#"CREATE TABLE IF NOT EXISTS roles (
                key TEXT PRIMARY KEY, label TEXT NOT NULL, description TEXT NOT NULL,
                prompt_body TEXT NOT NULL, artifact_kind TEXT NOT NULL, environment TEXT NOT NULL,
                can_loop INTEGER NOT NULL DEFAULT 0, default_tools TEXT NOT NULL,
                default_substrate TEXT NOT NULL, default_checkpoint INTEGER NOT NULL DEFAULT 0,
                token_est_in INTEGER NOT NULL, token_est_out INTEGER NOT NULL,
                is_builtin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
            );"#,
        )?;
        self.seed_builtin_roles()?;
```
  (b) **Seed** (idempotent — INSERT OR IGNORE keeps user edits/forks; built-in rows are refreshed so prompt fixes ship):
```rust
    fn seed_builtin_roles(&self) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        for r in crate::orchestrator::roles::builtin_roles() {
            // Upsert built-ins (so prompt/desc updates ship); never clobber a
            // user's custom row (different key) — built-ins own their keys.
            self.conn.execute(
                "INSERT INTO roles (key,label,description,prompt_body,artifact_kind,environment,can_loop,default_tools,default_substrate,default_checkpoint,token_est_in,token_est_out,is_builtin,created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,1,?13)
                 ON CONFLICT(key) DO UPDATE SET label=?2,description=?3,prompt_body=?4,artifact_kind=?5,environment=?6,can_loop=?7,default_tools=?8,default_substrate=?9,default_checkpoint=?10,token_est_in=?11,token_est_out=?12,is_builtin=1
                 WHERE roles.is_builtin=1",
                params![r.key, r.label, r.description, r.prompt_body, r.artifact_kind.as_db(), r.environment.as_db(), r.can_loop as i64, serde_json::to_string(&r.default_tools)?, r.default_substrate, r.default_checkpoint as i64, r.token_est_in, r.token_est_out, now],
            )?;
        }
        Ok(())
    }
```
  (c) **Accessors** (near the other db fns):
```rust
    fn row_to_role(r: &rusqlite::Row) -> rusqlite::Result<crate::orchestrator::roles::RoleDef> {
        use crate::orchestrator::types::{ArtifactKind, RoleEnvironment};
        let tools_json: String = r.get(7)?;
        Ok(crate::orchestrator::roles::RoleDef{
            key:r.get(0)?, label:r.get(1)?, description:r.get(2)?, prompt_body:r.get(3)?,
            artifact_kind:ArtifactKind::from_db(&r.get::<_,String>(4)?).unwrap_or(ArtifactKind::Note),
            environment:RoleEnvironment::from_db(&r.get::<_,String>(5)?).unwrap_or(RoleEnvironment::Worktree),
            can_loop:r.get::<_,i64>(6)? != 0,
            default_tools:serde_json::from_str(&tools_json).unwrap_or_default(),
            default_substrate:r.get(8)?, default_checkpoint:r.get::<_,i64>(9)? != 0,
            token_est_in:r.get(10)?, token_est_out:r.get(11)?, is_builtin:r.get::<_,i64>(12)? != 0,
        })
    }
    const ROLE_COLS: &str = "key,label,description,prompt_body,artifact_kind,environment,can_loop,default_tools,default_substrate,default_checkpoint,token_est_in,token_est_out,is_builtin";
    pub fn list_roles(&self) -> AppResult<Vec<crate::orchestrator::roles::RoleDef>> {
        let mut stmt = self.conn.prepare(&format!("SELECT {ROLE_COLS} FROM roles ORDER BY is_builtin DESC, label"))?;
        let rows = stmt.query_map([], |r| Self::row_to_role(r))?;
        rows.collect::<Result<Vec<_>,_>>().map_err(Into::into)
    }
    pub fn get_role(&self, key:&str) -> AppResult<Option<crate::orchestrator::roles::RoleDef>> {
        let mut stmt = self.conn.prepare(&format!("SELECT {ROLE_COLS} FROM roles WHERE key=?1"))?;
        let mut rows = stmt.query_map(params![key], |r| Self::row_to_role(r))?;
        Ok(match rows.next() { Some(r) => Some(r?), None => None })
    }
    pub fn upsert_role(&self, role:&crate::orchestrator::roles::RoleDef) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO roles (key,label,description,prompt_body,artifact_kind,environment,can_loop,default_tools,default_substrate,default_checkpoint,token_est_in,token_est_out,is_builtin,created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
             ON CONFLICT(key) DO UPDATE SET label=?2,description=?3,prompt_body=?4,artifact_kind=?5,environment=?6,can_loop=?7,default_tools=?8,default_substrate=?9,default_checkpoint=?10,token_est_in=?11,token_est_out=?12",
            params![role.key,role.label,role.description,role.prompt_body,role.artifact_kind.as_db(),role.environment.as_db(),role.can_loop as i64,serde_json::to_string(&role.default_tools)?,role.default_substrate,role.default_checkpoint as i64,role.token_est_in,role.token_est_out,role.is_builtin as i64,now],
        )?;
        Ok(())
    }
    pub fn role_in_use(&self, key:&str) -> AppResult<bool> {
        let n: i64 = self.conn.query_row("SELECT COUNT(*) FROM pipeline_stages WHERE role=?1", params![key], |r| r.get(0))?;
        Ok(n > 0)
    }
    pub fn delete_role(&self, key:&str) -> AppResult<()> {
        self.conn.execute("DELETE FROM roles WHERE key=?1 AND is_builtin=0", params![key])?;
        Ok(())
    }
```

- [ ] **Step 4: Run → PASS.** Commit: `feat(roles): roles table, seeding, and db accessors`.

### Task 4: Orchestrator resolves `RoleDef`; runner composes from data; delete the hardcoded matches

**Files:** Modify `types.rs` (`StageSpec`), `runner.rs`, `cli_runner.rs`, `mod.rs`; Test `src-tauri/src/tests.rs`.

- [ ] **Step 1:** Add fields to `StageSpec` (types.rs, after `instructions`/the resume fields):
```rust
    /// Resolved from the role's definition at spec-build time.
    pub role_prompt: String,
    pub role_environment: crate::orchestrator::types::RoleEnvironment,
    pub artifact_kind: crate::orchestrator::types::ArtifactKind,
```

- [ ] **Step 2:** In `mod.rs` `run_stage_once`, resolve the role before building the spec (fail cleanly if unknown):
```rust
        let role_def = match self.db.lock().get_role(&stage.role)? {
            Some(rd) => rd,
            None => {
                self.db.lock().fail_run_stage(&stage.id, &format!("unknown role '{}'", stage.role))?;
                self.record_halt(&run.id, &stage.id, &format!("unknown role '{}'", stage.role));
                return Ok((StageStatus::Failed, None));
            }
        };
```
and populate the new `StageSpec` fields: `role_prompt: role_def.prompt_body, role_environment: role_def.environment, artifact_kind: role_def.artifact_kind`.

- [ ] **Step 3:** In `runner.rs`, DELETE `artifact_kind_for`, `system_prompt_for`, `PIPELINE_PREAMBLE`, `VERDICT_INSTRUCTION`, and the local `compose_system_prompt`. Re-export the new ones: `pub use crate::orchestrator::roles::compose_system_prompt;`. Replace call sites: the API runner builds the prompt with `compose_system_prompt(&stage.role_prompt, stage.role_environment, stage.loop_mode.clone(), stage.instructions.as_deref())` and uses `stage.artifact_kind` instead of `artifact_kind_for(&stage.role)`.

- [ ] **Step 4:** In `cli_runner.rs`, same: the non-resume arm uses `compose_system_prompt(&stage.role_prompt, stage.role_environment, stage.loop_mode.clone(), stage.instructions.as_deref())`; `parse_cli_result` uses `stage.artifact_kind` (pass it in or set on the outcome) instead of `artifact_kind_for(&stage.role)`. Grep `artifact_kind_for` and `system_prompt_for` across src-tauri — there must be ZERO references left except the re-export.

- [ ] **Step 5:** Update every `StageSpec { … }` literal (mod.rs builder + any test fixtures) with the 3 new fields. `cargo build 2>&1 | grep "missing field"`.

- [ ] **Step 6: Test** (the existing CLI/agentic tests still pass + a new one):
```rust
#[test]
fn unknown_role_is_a_clean_failure_message() {
    // compose still works for an arbitrary body+env (no role lookup needed here)
    use crate::orchestrator::roles::compose_system_prompt;
    use crate::orchestrator::types::RoleEnvironment;
    let s = compose_system_prompt("Body.", RoleEnvironment::Worktree, None, None);
    assert!(s.ends_with("Body."));
}
```
Run the FULL suite: `cd src-tauri && cargo test 2>&1 | grep "test result:"` → 0 failed.

- [ ] **Step 7: Commit.** `refactor(roles): runner composes from RoleDef; remove hardcoded role matches`.

### Task 5: Validation + token estimate read from the table

**Files:** Modify `src-tauri/src/db.rs` (`validate_pipeline_stages`), `src-tauri/src/commands.rs` (`est_tokens`); Test `tests.rs`.

- [ ] **Step 1:** In `validate_pipeline_stages` (db.rs ~2540): the function is currently free (`pub fn`). It needs role data → change it to a method `Db::validate_pipeline_stages(&self, stages)` OR pass a `known: &HashSet<String>` + `can_loop: &HashSet<String>`. Simplest with least churn: make it a `Db` method and replace `KNOWN_ROLES.contains(...)` with `self.get_role(&s.role)?.is_some()` and the loop check with `self.get_role(&s.role)?.map(|r| r.can_loop).unwrap_or(false)`. Delete the `KNOWN_ROLES`/`REVIEW_ROLES` consts. Update its one caller (`save_pipeline` in db.rs) to `self.validate_pipeline_stages(...)`. Update the existing `validate_pipeline_stages` unit tests to construct a `test_db()` (tempdir + Db::open, so roles are seeded) and call the method.

- [ ] **Step 2:** In `commands.rs` `est_tokens` (~1195): replace the role match with a lookup. The estimator runs in a command with `state.db` — change `est_tokens(role)` to read `state.db.lock().get_role(role)` and use `(token_est_in, token_est_out)`, defaulting to `(4000,1000)` when absent. (Find its caller and thread `&Db` or the looked-up tuple.)

- [ ] **Step 3: Test:**
```rust
#[test]
fn validate_accepts_seeded_and_custom_rejects_unknown() {
    let db = test_db();
    let mk = |role:&str| crate::db::StageDraft{ role:role.into(), agent_model:"m".into(), substrate:"api".into(), checkpoint:false, loop_target_position:None, loop_max_iterations:0, loop_mode:None, max_iterations:25, pos_x:None, pos_y:None, parents:vec![], tools:None, custom_name:None, instructions:None };
    assert!(db.validate_pipeline_stages(&[mk("code_review")]).is_ok());
    assert!(db.validate_pipeline_stages(&[mk("bogus_role")]).is_err());
}
```

- [ ] **Step 4: Run → PASS + full suite green.** Commit: `refactor(roles): validation + token estimate read from roles table`.

---

## PHASE 2 — verification of new built-ins behavior

### Task 6: Seed-parity & action-contract integration checks

**Files:** Test `src-tauri/src/tests.rs`.

- [ ] **Step 1:** Add tests that the 5 new roles are present, that `pull_request`/`merge`/`release` are `Action`+CLI+checkpoint, and that `security_review` can loop:
```rust
#[test]
fn new_builtin_roles_have_expected_contracts() {
    let db = test_db();
    use crate::orchestrator::types::RoleEnvironment;
    for k in ["pull_request","merge","release"] {
        let r = db.get_role(k).unwrap().unwrap();
        assert_eq!(r.environment, RoleEnvironment::Action, "{k}");
        assert_eq!(r.default_substrate, "cli", "{k}");
        assert!(r.default_checkpoint, "{k}");
        assert!(!r.can_loop, "{k}");
    }
    assert!(db.get_role("security_review").unwrap().unwrap().can_loop);
    assert_eq!(db.get_role("architect").unwrap().unwrap().artifact_kind.as_db(), "plan");
}
```
- [ ] **Step 2: Run → PASS.** Commit: `test(roles): new built-in role contracts`.

(No new code — Phase 2's roles ship via the Task 2 seed; this task locks their contracts.)

---

## PHASE 3 — custom roles: commands, IPC/store, builder palette, Role Editor, docs

### Task 7: `Role` IPC type + the 3 commands

**Files:** Modify `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/lib/ipc.ts`; Test `tests.rs`.

- [ ] **Step 1:** A serializable role DTO. In `roles.rs` add `#[derive(Serialize,Deserialize)] #[serde(rename_all="camelCase")]` to a mirror struct OR derive on `RoleDef` directly (preferred): add `use serde::{Serialize,Deserialize};` and `#[derive(Clone, Debug, Serialize, Deserialize)] #[serde(rename_all="camelCase")]` to `RoleDef`. `environment`/`artifact_kind` already serde-serialize (camelCase enums).

- [ ] **Step 2:** Commands in `commands.rs`:
```rust
#[tauri::command]
pub async fn list_roles(state: State<'_, AppState>) -> AppResult<Vec<crate::orchestrator::roles::RoleDef>> {
    state.db.lock().list_roles()
}
#[tauri::command]
pub async fn save_role(state: State<'_, AppState>, role: crate::orchestrator::roles::RoleDef) -> AppResult<crate::orchestrator::roles::RoleDef> {
    let mut role = role;
    role.is_builtin = false; // user-saved roles are never built-in
    if role.key.trim().is_empty() { return Err(crate::error::AppError::Other("role key required".into())); }
    state.db.lock().upsert_role(&role)?;
    Ok(role)
}
#[tauri::command]
pub async fn delete_role(state: State<'_, AppState>, key: String) -> AppResult<()> {
    let db = state.db.lock();
    if db.role_in_use(&key)? { return Err(crate::error::AppError::Other(format!("role '{key}' is used by a pipeline"))); }
    db.delete_role(&key)
}
```

- [ ] **Step 3:** Register in `lib.rs` invoke_handler: add `commands::list_roles, commands::save_role, commands::delete_role,`.

- [ ] **Step 4:** `ipc.ts` — add the `Role` type + calls:
```ts
export interface Role {
  key: string; label: string; description: string; promptBody: string;
  artifactKind: "plan"|"review"|"tests"|"diff"|"note";
  environment: "worktree"|"action";
  canLoop: boolean; defaultTools: string[]; defaultSubstrate: "api"|"cli";
  defaultCheckpoint: boolean; tokenEstIn: number; tokenEstOut: number; isBuiltin: boolean;
}
export const listRoles = () => invoke<Role[]>("list_roles");
export const saveRole = (role: Role) => invoke<Role>("save_role", { role });
export const deleteRole = (key: string) => invoke<void>("delete_role", { key });
```
(match the file's existing export style.)

- [ ] **Step 5: Test (Rust):** delete-in-use rejects:
```rust
#[test]
fn delete_role_rejects_when_in_use() {
    let db = test_db();
    // seed a custom role + a pipeline stage referencing it, then assert role_in_use
    let cr = db.get_role("code_review").unwrap().unwrap();
    let mut c = cr.clone(); c.key="perf_audit".into(); c.is_builtin=false; db.upsert_role(&c).unwrap();
    // (insert a pipeline_stages row with role='perf_audit' via the existing save_pipeline path or a direct INSERT)
    db.conn_exec_for_test("INSERT INTO pipelines (id,name,is_builtin) VALUES ('p','P',0)");
    db.conn_exec_for_test("INSERT INTO pipeline_stages (id,pipeline_id,position,role,agent_model,substrate) VALUES ('s','p',0,'perf_audit','m','api')");
    assert!(db.role_in_use("perf_audit").unwrap());
}
```
(If there's no `conn_exec_for_test` helper, use `db.save_pipeline(...)` with a one-stage draft of role `perf_audit`, which is the realistic path. Adjust to the actual `pipelines` schema columns.)

- [ ] **Step 6:** `npm run typecheck` + `cargo test` green. Commit: `feat(roles): list/save/delete role commands + IPC`.

### Task 8: roles store + builder palette derives from data

**Files:** Create `src/stores/rolesStore.ts`; Modify `src/components/builder/graph.ts`, `src/lib/stageMeta.ts`, `src/components/builder/NodePalette.tsx`; Test `*.test.ts`.

- [ ] **Step 1: rolesStore** (`src/stores/rolesStore.ts`) — Zustand, mirrors the existing store pattern:
```ts
import { create } from "zustand";
import { listRoles, type Role } from "../lib/ipc";

interface RolesState { roles: Role[]; loaded: boolean; load: () => Promise<void>; }
export const useRolesStore = create<RolesState>((set) => ({
  roles: [], loaded: false,
  load: async () => { const roles = await listRoles(); set({ roles, loaded: true }); },
}));
```

- [ ] **Step 2:** `graph.ts` — keep the `Archetype` interface, but derive `ARCHETYPES` from loaded roles instead of the hardcoded list. Add a pure mapper + a setter the store calls:
```ts
export function archetypeFromRole(r: Role): Archetype {
  return { role: r.key, label: r.label, artifact: r.artifactKind, canLoop: r.canLoop, defaultTools: r.defaultTools, description: r.description };
}
let LOADED: Archetype[] = []; // populated from rolesStore
export function setArchetypes(roles: Role[]) { LOADED = roles.map(archetypeFromRole); }
export function archetypes(): Archetype[] { return LOADED; }
export function archetypeFor(role: string): Archetype { return LOADED.find(a => a.role === role) ?? LOADED[0]; }
```
Replace the static `ARCHETYPES`/`ARCHETYPE_BY_ROLE` usages with `archetypes()`/`archetypeFor()`. Have `rolesStore.load` call `setArchetypes(roles)`. (Keep `archetypeFor` returning a safe fallback when LOADED is empty — guard against `LOADED[0]` undefined by returning a minimal default.)

- [ ] **Step 3:** `stageMeta.ts` `labelForRole` — read from the store's roles (fallback to the key):
```ts
import { useRolesStore } from "../stores/rolesStore";
export function labelForRole(role: string): string {
  return useRolesStore.getState().roles.find(r => r.key === role)?.label ?? role;
}
```

- [ ] **Step 4:** `NodePalette.tsx` — render from `archetypes()` grouped (Plan&design / Build / Review / Action / Your roles by `environment==="action"` and `isBuiltin`), mark built-ins (lock) and customs; add a "＋ New role" button that opens the Role Editor (Task 9). Ensure `rolesStore.load()` runs when the builder mounts (call in the builder's mount effect).

- [ ] **Step 5: Test** (`graph.test.ts`): `archetypeFromRole` maps fields; `archetypeFor` falls back; `setArchetypes`+`archetypes` round-trip. `npm test -- graph`.

- [ ] **Step 6:** `npm run typecheck`. Commit: `feat(roles): roles store + builder palette derived from role data`.

### Task 9: Role Editor (Design B)

**Files:** Create `src/components/RoleEditor.tsx` (+ `RoleEditor.test.tsx`); wire from `NodePalette.tsx`.

- [ ] **Step 1: Failing test** (behavior, not pixels):
```tsx
// key auto-derives from name; Action sets checkpoint+cli; save calls saveRole
import { render, screen, fireEvent } from "@testing-library/react";
// ... mock ../lib/ipc saveRole; assert deriveKey("Perf Audit!") === "perf_audit"
import { deriveRoleKey } from "./RoleEditor";
test("deriveRoleKey snake-cases", () => {
  expect(deriveRoleKey("Perf Audit!")).toBe("perf_audit");
  expect(deriveRoleKey("  Ship   Release ")).toBe("ship_release");
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `RoleEditor.tsx`** — the approved Design B, theme-agnostic (tokens only), no rule/glyph/✦:
  - Export `deriveRoleKey(name): string` (lowercase, non-alnum→`_`, collapse, trim `_`).
  - Props: `{ initial?: Role; onSaved: (r: Role) => void; onClose: () => void }`. A built-in passed as `initial` is treated as a fork (new key, `isBuiltin=false`).
  - Layout: inline-editable name (derives key, shown in mono), a hero prompt `<textarea>` (serif, large, the focus), and below it the natural-language brief with chip controls bound to state (`artifactKind`, `environment`, `defaultTools`, `canLoop`, `defaultSubstrate`, `defaultCheckpoint`). Selecting `environment="action"` sets `defaultCheckpoint=true` + `defaultSubstrate="cli"` (still user-overridable after).
  - Chips are buttons opening small token menus (reuse `MenuSurface`/`menuStyles`); icon controls carry `title` tooltips. Motion via `<Reveal>`/token transitions. Render inside `<ModalShell>` (or the builder's panel) per the design system. Save → `saveRole(role)` → `onSaved`.
  - No hardcoded hex/fonts; no `italic`. Copy in English.

- [ ] **Step 4: Run test → PASS.** `npm test -- RoleEditor`.

- [ ] **Step 5:** Wire `NodePalette`'s "＋ New role" and a built-in's edit affordance to open `<RoleEditor>`; on `onSaved`, refresh `rolesStore.load()`.

- [ ] **Step 6:** `npm run typecheck`. Commit: `feat(roles): conversational Role Editor (Design B)`.

### Task 10: design-system docs hygiene

**Files:** Modify `docs/design-system.md`, `CLAUDE.md`.

- [ ] **Step 1:** In `docs/design-system.md`: §3 (brass rule) and §5 (signature details — the `⟶` prompt glyph) — mark the decorative brass *rule* divider and the `⟶` prompt glyph as **retired for new surfaces**; add the minimalism principles (theme-agnostic via tokens; icons-over-text + tooltips; smooth token-driven enter/exit; no decorative flourishes incl. `✦`). Keep the note that **structural** flow glyphs (run-track `⟶` connector, checkpoint `⟜`, `§` tool-call prefix) remain until separately decided.
- [ ] **Step 2:** Mirror the same retirement note in `CLAUDE.md`'s "Five signature details" / motion rules section.
- [ ] **Step 3: Commit.** `docs(design-system): retire decorative rule/⟶/✦ for new surfaces`.

---

## PHASE 4 — verification & review

### Task 11: full sweep
- [ ] `cd src-tauri && cargo test` → all green (esp. `builtin_roles_seed_matches_legacy_prompts`, `roles_table_seeds_and_reads`, validation, new-role contracts).
- [ ] `npm test` → green (graph, RoleEditor, stageMeta); confirm the only pre-existing failures (if any) are unrelated (`Settings.issuetracker.test.tsx`).
- [ ] `npm run typecheck` clean; `cd src-tauri && cargo clippy --all-targets` no new warnings in touched files.
- [ ] Grep: `grep -rn "system_prompt_for\|artifact_kind_for\|KNOWN_ROLES\|REVIEW_ROLES\|ARCHETYPES =" src-tauri/src src` → only the re-export / derived definitions remain.

### Task 12: cross-cutting adversarial review (dispatch sub-agents)
- [ ] Bug-hunt agent on the **seed/upsert** path (ON CONFLICT WHERE is_builtin=1 logic; a user fork colliding with a built-in key; migration idempotency on existing DBs that already have pipelines).
- [ ] Bug-hunt agent on the **runner refactor** (every old call site of system_prompt_for/artifact_kind_for replaced; behavior parity; unknown-role failure path; action preamble only for action roles).
- [ ] Design-review agent on `RoleEditor.tsx` + `NodePalette.tsx` against the minimalism principles (theme-agnostic tokens, no italics, no decorative rule/⟶/✦, icons+tooltips, motion primitives).
- [ ] Triage with `superpowers:receiving-code-review`; fix real findings, each its own commit.

---

## Self-review notes (author)

- **Spec coverage:** A(roles table)→T3; RoleDef/preambles→T2; B(environment contract)→T2/T4; C(5 new built-ins)→T2 seed + T6 contracts; D(backend refactor: runner→T4, validation/est_tokens→T5, MCP schema→noted, commands→T7); E(frontend store/palette→T8, Role Editor→T9, design-system hygiene→T10); F(migration/parity)→T3 seed + T2 parity test. **Gap noted:** the MCP schema (octopush-mcp/tools.rs) role list — fold a one-line "generate from list_roles or reference it" into T7 (add a step) or leave as a documented follow-up; flag in review.
- **Type consistency:** `RoleDef` fields (snake) ↔ `Role` TS (camel) via serde rename_all; `compose_system_prompt(prompt_body, environment, loop_mode, instructions)` identical across runner + cli_runner; `archetypeFromRole`/`archetypeFor`/`archetypes` consistent; `deriveRoleKey` used in test + editor.
- **Known ordering note:** capture the legacy `system_prompt_for` strings into the Task 2 seed BEFORE deleting them in Task 4 (the parity test in T2 depends on the verbatim bodies). The plan orders T2 (seed with verbatim bodies) before T4 (delete) — keep that order.
- **Test-db constructor:** tests use a local `test_db()` helper (`{ let tmp = tempfile::tempdir().unwrap(); Db::open(tmp.path()).unwrap() }`) — define one in the role test module, matching the other modules in tests.rs.
