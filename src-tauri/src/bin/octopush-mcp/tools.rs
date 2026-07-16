//! The Octopush MCP tool surface: definitions (name + JSON Schema) and the
//! dispatch into `octopush_lib::db`.
//!
//! Scope is **read + author**, never execute: list/inspect pipelines,
//! projects, workspaces, and runs; create/update/delete pipeline templates;
//! stage runs in `draft`; link a workspace to an issue; create a workspace.
//! Nothing here spends tokens or launches a run — execution stays in the app.
//! The one place we touch git is `create_workspace`, which materialises a
//! worktree on disk (the same thing the app's workspace creator does).

use octopush_lib::db::{Db, StageDraft};
use parking_lot::Mutex;
use serde_json::{json, Value};

use crate::protocol::{tool_error_result, tool_text_result};

/// The catalogue advertised by `tools/list`. Order is the order the client
/// shows them in; we lead with the authoring guide.
pub fn tool_definitions() -> Value {
    json!({ "tools": [
        def(
            "describe_pipeline_schema",
            "Authoring guide for DIRECT-mode pipelines: the valid stage roles, \
             the workspace tools a stage may use, the api/cli substrates, the \
             loop & checkpoint rules the validator enforces, per-stage reasoning \
             effort and model-escalation policy, the runtime escape valve, \
             recommended model ids, and a fully annotated example. CALL THIS \
             FIRST before create_pipeline or update_pipeline.",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        def(
            "list_pipelines",
            "List every pipeline (built-in and custom), each with its ordered \
             stages. Pipelines are reusable DIRECT-mode templates.",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        def(
            "get_pipeline",
            "Fetch one pipeline by id, with its ordered stages.",
            json!({
                "type": "object",
                "properties": { "pipelineId": { "type": "string", "description": "Pipeline id." } },
                "required": ["pipelineId"],
                "additionalProperties": false
            }),
        ),
        def(
            "create_pipeline",
            "Create a NEW custom pipeline template from a name, description, and \
             an ordered list of stages. Each stage may set per-stage reasoning \
             `effort` and a model-escalation policy (`escalateModel` / \
             `escalateEffort`) — see describe_pipeline_schema. Stages are \
             validated (roles, substrates, tool allowlists, loop/checkpoint \
             rules) before saving; invalid drafts are rejected with a reason. \
             Returns the new pipeline id. Does not run anything.",
            json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Display name." },
                    "description": { "type": "string", "description": "What this pipeline is for." },
                    "stages": STAGE_ARRAY_SCHEMA(),
                },
                "required": ["name", "description", "stages"],
                "additionalProperties": false
            }),
        ),
        def(
            "update_pipeline",
            "Update an existing pipeline's name, description, and full stage set. \
             If pipelineId refers to a BUILT-IN pipeline, this forks it into a new \
             custom copy (built-ins are never mutated) and returns the new id; for \
             a custom pipeline it updates in place and returns the same id.",
            json!({
                "type": "object",
                "properties": {
                    "pipelineId": { "type": "string", "description": "Pipeline id to update or fork." },
                    "name": { "type": "string" },
                    "description": { "type": "string" },
                    "stages": STAGE_ARRAY_SCHEMA(),
                },
                "required": ["pipelineId", "name", "description", "stages"],
                "additionalProperties": false
            }),
        ),
        def(
            "delete_pipeline",
            "Delete a CUSTOM pipeline by id. Built-in pipelines are protected and \
             cannot be deleted.",
            json!({
                "type": "object",
                "properties": { "pipelineId": { "type": "string" } },
                "required": ["pipelineId"],
                "additionalProperties": false
            }),
        ),
        def(
            "list_roles",
            "List every DIRECT-mode role (built-in and custom), each with its full \
             config: prompt body, artifact kind, environment (worktree/action), \
             default tools & substrate, loop capability, and token estimates. A \
             pipeline stage's `role` is a role's `key` — call this to learn the \
             vocabulary before authoring a pipeline or a new role.",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        def(
            "save_role",
            "Create or update a CUSTOM role — the reusable, role-specialized agent \
             persona a pipeline stage runs as. Supply just `label` + `promptBody` \
             for a basic role; every other field takes a sensible default. The \
             `key` (the stable id a stage references via `role`) is derived from \
             the label when omitted, and is always returned so you can wire it \
             into stages. Built-in roles are protected: a key that maps to a \
             built-in is rejected (never overwritten). See \
             describe_pipeline_schema → customRoles for the full field contract. \
             Does not run anything.",
            json!({
                "type": "object",
                "properties": {
                    "label": { "type": "string", "description": "Display name, e.g. \"Security Auditor\"." },
                    "promptBody": { "type": "string", "description": "The role's system-prompt body — the instructions that define what this agent does. Composed with the environment preamble at run time. Required, non-empty." },
                    "key": { "type": ["string", "null"], "description": "Optional stable id a pipeline stage references (role: \"<key>\"). Omit to derive it from the label (lowercased, each run of non-alphanumerics → '_', trimmed). An existing CUSTOM key updates that role in place; a built-in key is rejected." },
                    "description": { "type": ["string", "null"], "description": "Short human description. Default empty." },
                    "artifactKind": { "type": ["string", "null"], "enum": ["plan", "review", "tests", "diff", "note", null], "description": "What this role produces. Default 'note'." },
                    "environment": { "type": ["string", "null"], "enum": ["worktree", "action", null], "description": "'worktree' (default) never touches git and leaves changes uncommitted for the next stage; 'action' may commit/push/PR/merge/release (its job IS a side effect)." },
                    "canLoop": { "type": ["boolean", "null"], "description": "Whether a stage with this role can act as a review gate that loops back on rejection. Default false." },
                    "defaultTools": { "type": ["array", "null"], "items": { "type": "string", "enum": ["read_file", "list_files", "write_file", "run_command"] }, "description": "Default workspace-tool allowlist for stages using this role. Default [\"read_file\", \"list_files\"]." },
                    "defaultSubstrate": { "type": ["string", "null"], "enum": ["api", "cli", null], "description": "'api' (default, in-process LLM) or 'cli' (external agent CLI)." },
                    "defaultCheckpoint": { "type": ["boolean", "null"], "description": "Whether stages using this role default to pausing for human approval. Default false." },
                    "tokenEstIn": { "type": ["integer", "null"], "description": "Rough input-token estimate for the cost preview. Default 4000." },
                    "tokenEstOut": { "type": ["integer", "null"], "description": "Rough output-token estimate for the cost preview. Default 1000." }
                },
                "required": ["label", "promptBody"],
                "additionalProperties": false
            }),
        ),
        def(
            "delete_role",
            "Delete a CUSTOM role by key. Built-in roles cannot be deleted, and a \
             role currently used by any pipeline or run stage is protected \
             (re-point or remove those stages first).",
            json!({
                "type": "object",
                "properties": { "key": { "type": "string", "description": "The role key to delete (see list_roles)." } },
                "required": ["key"],
                "additionalProperties": false
            }),
        ),
        def(
            "list_projects",
            "List the user's open Octopush projects (each is a git repository).",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        def(
            "list_workspaces",
            "List the workspaces (git worktrees) of a project.",
            json!({
                "type": "object",
                "properties": { "projectId": { "type": "string" } },
                "required": ["projectId"],
                "additionalProperties": false
            }),
        ),
        def(
            "get_workspace",
            "Fetch one workspace (worktree) by id: branch, path, status, linked \
             issue, test command, and more.",
            json!({
                "type": "object",
                "properties": { "workspaceId": { "type": "string" } },
                "required": ["workspaceId"],
                "additionalProperties": false
            }),
        ),
        def(
            "create_workspace",
            "Ensure there's an Octopush workspace for a branch, and return it — \
             so you can always start working on the branch from Octopush. The \
             branch is created if it doesn't exist and REUSED verbatim if it does \
             (mixed case, slashes, and dots are preserved — e.g. JIRA-123, \
             feat/Foo). Always succeeds: if a workspace already tracks the branch \
             it's returned (un-archived if needed); if the branch is already \
             checked out somewhere (the main worktree, or one made outside \
             Octopush) that checkout is ADOPTED as a workspace instead of failing \
             (git allows a branch in only one worktree); otherwise a fresh \
             worktree is created. Never duplicates a workspace. The response's \
             `status` is one of created | adopted | existed | restored. This is \
             the one tool that touches git (it may materialise a worktree). The \
             workspace shows up in Octopush's left rail (refresh the project, or \
             it appears when the window regains focus).",
            json!({
                "type": "object",
                "properties": {
                    "projectId": { "type": "string", "description": "Project to create the workspace in (see list_projects)." },
                    "task": { "type": "string", "description": "What this workspace is for. When `branch` is omitted, a branch name is slugified from this; it's also the default display name." },
                    "branch": { "type": ["string", "null"], "description": "Optional explicit branch name, used VERBATIM (validated as a git ref; case/slashes/dots preserved). An existing branch is reused. Omit to derive a slug from `task`." },
                    "name": { "type": ["string", "null"], "description": "Optional display name for the rail. Defaults to the branch." },
                    "fromBranch": { "type": ["string", "null"], "description": "Optional base to branch from (local like 'dev' or remote-tracking like 'origin/dev'). Defaults to the repo's default branch. Ignored when the branch already exists." },
                    "setupScript": { "type": ["string", "null"], "description": "Optional shell script to seed the workspace's setup. Default empty." }
                },
                "required": ["projectId", "task"],
                "additionalProperties": false
            }),
        ),
        def(
            "link_workspace_issue",
            "Link a workspace to an issue tracker key (e.g. a Jira key like \
             'ENG-1234'), or pass null/omit to clear the link. Metadata only — \
             does not touch git.",
            json!({
                "type": "object",
                "properties": {
                    "workspaceId": { "type": "string" },
                    "issueKey": { "type": ["string", "null"], "description": "Issue key, or null to unlink." }
                },
                "required": ["workspaceId"],
                "additionalProperties": false
            }),
        ),
        def(
            "create_run",
            "Stage a DIRECT-mode run in 'draft' status from a pipeline + a task, \
             in a given workspace. The run is NOT started — the user launches it \
             from the Octopush app's DIRECT mode. Optionally override per-stage \
             models. Returns the new run id.",
            json!({
                "type": "object",
                "properties": {
                    "workspaceId": { "type": "string" },
                    "pipelineId": { "type": "string" },
                    "task": { "type": "string", "description": "The task the run should accomplish." },
                    "referenceModel": { "type": ["string", "null"], "description": "Optional model for comparative cost baseline." },
                    "linkedIssueKey": { "type": ["string", "null"], "description": "Optional issue key to associate." },
                    "stageModelOverrides": {
                        "type": "array",
                        "description": "Optional [position, modelId] pairs to override the model of specific stages.",
                        "items": {
                            "type": "array",
                            "prefixItems": [ { "type": "integer" }, { "type": "string" } ],
                            "minItems": 2, "maxItems": 2
                        }
                    }
                },
                "required": ["workspaceId", "pipelineId", "task"],
                "additionalProperties": false
            }),
        ),
        def(
            "list_runs",
            "List the runs of a workspace (newest first), with status and cost.",
            json!({
                "type": "object",
                "properties": { "workspaceId": { "type": "string" } },
                "required": ["workspaceId"],
                "additionalProperties": false
            }),
        ),
        def(
            "get_run",
            "Fetch one run by id, with its per-stage execution detail (status, \
             tokens, cost, artifacts, errors).",
            json!({
                "type": "object",
                "properties": { "runId": { "type": "string" } },
                "required": ["runId"],
                "additionalProperties": false
            }),
        ),
    ]})
}

/// Build a single tool definition object.
fn def(name: &str, description: &str, input_schema: Value) -> Value {
    json!({ "name": name, "description": description, "inputSchema": input_schema })
}

/// JSON Schema for the `stages` array, shared by create/update. Only `role` and
/// `agentModel` are strictly required per stage; everything else is normalized
/// to a sensible default before validation (see `normalize_stage`).
#[allow(non_snake_case)]
fn STAGE_ARRAY_SCHEMA() -> Value {
    json!({
        "type": "array",
        "minItems": 1,
        "description": "Ordered stages. Position is the array index. Author the \
                        flow with `parents` (upstream positions); leave parents \
                        empty for a simple linear chain.",
        "items": {
            "type": "object",
            "properties": {
                "role": { "type": "string", "description": "One of: plan, plan_review, implement, code_review, test, repro, fix, verify, critique, refine, architect, security_review, pull_request, merge, release. Custom roles defined in the app are also valid — call list_roles for the current set." },
                "agentModel": { "type": "string", "description": "Model id, e.g. claude-sonnet-4-6 or claude-haiku-4-5." },
                "substrate": { "type": "string", "enum": ["api", "cli"], "description": "api = in-process LLM; cli = external agent CLI. Default api." },
                "checkpoint": { "type": "boolean", "description": "Pause for human review before this stage. Default false." },
                "maxIterations": { "type": "integer", "minimum": 1, "maximum": 100, "description": "Per-stage tool-turn budget. Default 25." },
                "parents": { "type": "array", "items": { "type": "integer" }, "description": "Upstream stage positions (must be earlier). Empty = linear chain." },
                "tools": { "type": "array", "items": { "type": "string", "enum": ["read_file", "list_files", "write_file", "run_command"] }, "description": "Tool allowlist; omit to use the role's default set." },
                "customName": { "type": ["string", "null"], "description": "Optional display label override." },
                "instructions": { "type": ["string", "null"], "description": "Optional free-form additions to the role's prompt (max 8000 chars)." },
                "loopTargetPosition": { "type": ["integer", "null"], "description": "Review roles only: earlier stage to loop back to on rejection. Null = no loop." },
                "loopMaxIterations": { "type": "integer", "description": "Max loop-backs (>=1 when looping, else 0). Default 0." },
                "loopMode": { "type": ["string", "null"], "enum": ["gated", "auto", null], "description": "'gated' (human-approved) or 'auto'. Required when looping." },
                "effort": { "type": ["string", "null"], "enum": ["low", "medium", "high", "xhigh", "max", null], "description": "Per-stage reasoning effort. API substrate only (ignored on cli). Takes effect only on models that support reasoning: the current Claude families (Opus 4.5–4.8, Sonnet 4.6/5, Fable/Mythos 5) and the budget-path models (Haiku 4.5, Sonnet 4.5) — on those, higher levels auto-clamp to the model's max (e.g. Sonnet 4.6 caps xhigh→high). On any OTHER model id (legacy claude-3-5-*, unknown/non-Claude) effort is silently IGNORED — no thinking at all, not clamped. Use a current Claude model to get effect. Omit/null = off (no extended thinking)." },
                "escalateModel": { "type": ["string", "null"], "description": "On this stage FAILING (loop exhausts its tool-turn budget unfinished, or errors), retry it ONCE with this stronger model before halting. Applies to api and cli. The retry fires ONLY if it raises the tier — set a genuinely different, stronger model than agentModel; if escalateModel equals agentModel the escalation no-ops and the stage just halts on failure. Omit = no escalation." },
                "escalateEffort": { "type": ["string", "null"], "enum": ["low", "medium", "high", "xhigh", "max", null], "description": "Optionally also raise reasoning effort on the escalated retry (api only). On its own (no escalateModel) it triggers a retry only if it is higher than the stage's base effort; an equal effort no-ops and the stage halts." }
            },
            "required": ["role", "agentModel"],
            "additionalProperties": false
        }
    })
}

/// Dispatch a `tools/call`. Returns the MCP result object (success or in-band
/// tool error). A `None` return is impossible — unknown tools are reported as
/// tool errors so the model can recover.
pub fn call_tool(db: &Mutex<Db>, name: &str, args: &Value) -> Value {
    // `create_workspace` manages its own locking (it must not hold the lock
    // across the git worktree checkout); every other tool is a quick DB
    // read/author, so we take the lock once for the call.
    let outcome = if name == "create_workspace" {
        create_workspace(db, args)
    } else {
        let db = db.lock();
        match name {
            "describe_pipeline_schema" => Ok(describe_pipeline_schema()),
            "list_pipelines" => list_pipelines(&db),
            "get_pipeline" => get_pipeline(&db, args),
            "create_pipeline" => save_pipeline(&db, args, None),
            "update_pipeline" => save_pipeline(&db, args, Some(())),
            "delete_pipeline" => delete_pipeline(&db, args),
            "list_roles" => list_roles(&db),
            "save_role" => save_role(&db, args),
            "delete_role" => delete_role(&db, args),
            "list_projects" => list_projects(&db),
            "list_workspaces" => list_workspaces(&db, args),
            "get_workspace" => get_workspace(&db, args),
            "link_workspace_issue" => link_workspace_issue(&db, args),
            "create_run" => create_run(&db, args),
            "list_runs" => list_runs(&db, args),
            "get_run" => get_run(&db, args),
            other => Err(format!("unknown tool '{other}'")),
        }
    };
    match outcome {
        Ok(payload) => tool_text_result(&payload),
        Err(msg) => tool_error_result(msg),
    }
}

// ── argument helpers ──────────────────────────────────────────────────────

fn req_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("missing required string argument '{key}'"))
}

fn opt_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_owned)
}

// ── pipeline handlers ─────────────────────────────────────────────────────

fn pipeline_with_stages(db: &Db, p: &octopush_lib::db::PipelineRow) -> Result<Value, String> {
    let stages = db.get_pipeline_stages(&p.id).map_err(|e| e.to_string())?;
    Ok(json!({ "pipeline": p, "stages": stages }))
}

fn list_pipelines(db: &Db) -> Result<Value, String> {
    let pipelines = db.list_pipelines().map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(pipelines.len());
    for p in &pipelines {
        out.push(pipeline_with_stages(db, p)?);
    }
    Ok(json!({ "pipelines": out }))
}

fn get_pipeline(db: &Db, args: &Value) -> Result<Value, String> {
    let id = req_str(args, "pipelineId")?;
    let pipelines = db.list_pipelines().map_err(|e| e.to_string())?;
    let p = pipelines
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("no pipeline with id '{id}'"))?;
    pipeline_with_stages(db, &p)
}

/// Shared body for create (`edit = None`) and update (`edit = Some(())`).
fn save_pipeline(db: &Db, args: &Value, edit: Option<()>) -> Result<Value, String> {
    let name = req_str(args, "name")?;
    let description = req_str(args, "description")?;
    let pipeline_id = match edit {
        Some(()) => Some(req_str(args, "pipelineId")?),
        None => None,
    };
    let raw_stages = args
        .get("stages")
        .and_then(Value::as_array)
        .ok_or("missing required array argument 'stages'")?;
    if raw_stages.is_empty() {
        return Err("a pipeline needs at least one stage".into());
    }
    let mut stages: Vec<StageDraft> = Vec::with_capacity(raw_stages.len());
    for (i, raw) in raw_stages.iter().enumerate() {
        let normalized = normalize_stage(raw);
        // An invalid `effort`/`escalateEffort` (a string outside the enum, or an
        // empty "") surfaces here as a clean serde error — never a panic — because
        // both deserialize through `Option<Effort>`; we wrap it with the stage
        // number so the author knows which stage to fix. A whitespace-only
        // `escalateModel` is trimmed to "no escalation" downstream by
        // `db.save_pipeline` (the single source of truth), which the re-read
        // before returning reflects.
        let stage: StageDraft = serde_json::from_value(normalized)
            .map_err(|e| format!("stage {} is malformed: {e}", i + 1))?;
        stages.push(stage);
    }
    // `save_pipeline` runs the full §3.7 validator and rejects invalid drafts.
    let id = db
        .save_pipeline(pipeline_id, &name, &description, &stages)
        .map_err(|e| e.to_string())?;
    let saved = db.list_pipelines().map_err(|e| e.to_string())?;
    let p = saved
        .into_iter()
        .find(|p| p.id == id)
        .ok_or("pipeline saved but could not be reloaded")?;
    let mut payload = pipeline_with_stages(db, &p)?;
    payload["pipelineId"] = json!(id);
    Ok(payload)
}

/// Fill the StageDraft fields that lack a serde default so the model only has
/// to supply `role` + `agentModel` for a basic stage.
fn normalize_stage(raw: &Value) -> Value {
    let mut obj = raw.as_object().cloned().unwrap_or_default();
    obj.entry("substrate").or_insert(json!("api"));
    obj.entry("checkpoint").or_insert(json!(false));
    obj.entry("loopTargetPosition").or_insert(Value::Null);
    obj.entry("loopMaxIterations").or_insert(json!(0));
    obj.entry("loopMode").or_insert(Value::Null);
    Value::Object(obj)
}

fn delete_pipeline(db: &Db, args: &Value) -> Result<Value, String> {
    let id = req_str(args, "pipelineId")?;
    db.delete_pipeline(&id).map_err(|e| e.to_string())?;
    Ok(json!({ "deleted": id }))
}

// ── role handlers ─────────────────────────────────────────────────────────

/// The four workspace tools a role's `defaultTools` may name — the same
/// allowlist the pipeline stage validator enforces.
const ROLE_TOOLS: [&str; 4] = ["read_file", "list_files", "write_file", "run_command"];

fn list_roles(db: &Db) -> Result<Value, String> {
    let roles = db.list_roles().map_err(|e| e.to_string())?;
    Ok(json!({ "roles": roles }))
}

/// Derive a stable role key from a display name — byte-for-byte the app's
/// `deriveRoleKey` (RoleEditor.tsx): lowercase, every run of non-alphanumerics
/// collapses to a single '_', then trim leading/trailing '_'. Non-ASCII chars
/// are non-alphanumeric here (matching the JS `[^a-z0-9]` after `toLowerCase`),
/// so they too become '_'.
fn derive_role_key(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut prev_underscore = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_underscore = false;
        } else if !prev_underscore {
            out.push('_');
            prev_underscore = true;
        }
    }
    out.trim_matches('_').to_string()
}

/// Create or update a CUSTOM role. Routes through the SAME `db.upsert_role` the
/// app's `save_role` command uses (built-in protection, in-place update), with
/// the app's new-role defaults filled for omitted fields so the caller supplies
/// only `label` + `promptBody` for a basic role.
fn save_role(db: &Db, args: &Value) -> Result<Value, String> {
    let label = req_str(args, "label")?;
    let prompt_body = req_str(args, "promptBody")?;
    if label.trim().is_empty() {
        return Err("role label cannot be empty".into());
    }
    if prompt_body.trim().is_empty() {
        return Err("role promptBody cannot be empty".into());
    }
    // Key: an explicit (trimmed) key, else derived from the label with the exact
    // app algorithm. A label of only punctuation derives to "" — ask for a key.
    let key = opt_str(args, "key")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| derive_role_key(&label));
    if key.is_empty() {
        return Err(
            "could not derive a role key from the label — pass an explicit 'key' (letters/digits)"
                .into(),
        );
    }

    // Build a RoleDef JSON with the app's defaults for omitted fields, then
    // deserialize through the typed struct so an out-of-enum artifactKind /
    // environment / substrate surfaces as a clean tool error, never a panic.
    let obj = args.as_object().cloned().unwrap_or_default();
    let field = |k: &str| obj.get(k).filter(|v| !v.is_null()).cloned();
    let role_json = json!({
        "key": key,
        "label": label,
        "description": field("description").unwrap_or_else(|| json!("")),
        "promptBody": prompt_body,
        "artifactKind": field("artifactKind").unwrap_or_else(|| json!("note")),
        "environment": field("environment").unwrap_or_else(|| json!("worktree")),
        "canLoop": field("canLoop").unwrap_or_else(|| json!(false)),
        "defaultTools": field("defaultTools").unwrap_or_else(|| json!(["read_file", "list_files"])),
        "defaultSubstrate": field("defaultSubstrate").unwrap_or_else(|| json!("api")),
        "defaultCheckpoint": field("defaultCheckpoint").unwrap_or_else(|| json!(false)),
        "tokenEstIn": field("tokenEstIn").unwrap_or_else(|| json!(4000)),
        "tokenEstOut": field("tokenEstOut").unwrap_or_else(|| json!(1000)),
        "isBuiltin": false,
    });
    let mut role: octopush_lib::orchestrator::roles::RoleDef =
        serde_json::from_value(role_json).map_err(|e| format!("role is malformed: {e}"))?;
    role.is_builtin = false; // user-saved roles are never built-in (matches save_role)

    // Validate the tool allowlist here (RoleDef itself doesn't) so an unknown
    // tool is a clear authoring error, not a stage failure later.
    for t in &role.default_tools {
        if !ROLE_TOOLS.contains(&t.as_str()) {
            return Err(format!(
                "unknown tool '{t}' in defaultTools; valid tools are {}",
                ROLE_TOOLS.join(", ")
            ));
        }
    }

    // Never overwrite a built-in role key — mirror the command guard so the MCP
    // caller gets the same clear error, not a silent no-op from upsert_role.
    if let Some(existing) = db.get_role(&role.key).map_err(|e| e.to_string())? {
        if existing.is_builtin {
            return Err(format!(
                "'{}' maps to the built-in role key '{}' — choose a different label or key",
                role.label, role.key
            ));
        }
    }
    db.upsert_role(&role).map_err(|e| e.to_string())?;
    let saved = db
        .get_role(&role.key)
        .map_err(|e| e.to_string())?
        .ok_or("role saved but could not be reloaded")?;
    Ok(json!({ "role": saved, "key": saved.key }))
}

fn delete_role(db: &Db, args: &Value) -> Result<Value, String> {
    let key = req_str(args, "key")?;
    match db.get_role(&key).map_err(|e| e.to_string())? {
        None => return Err(format!("no role with key '{key}'")),
        Some(existing) if existing.is_builtin => {
            return Err(format!("cannot delete the built-in role '{key}'"));
        }
        Some(_) => {}
    }
    if db.role_in_use(&key).map_err(|e| e.to_string())? {
        return Err(format!(
            "role '{key}' is used by a pipeline or run stage — re-point or remove those stages first"
        ));
    }
    db.delete_role(&key).map_err(|e| e.to_string())?;
    Ok(json!({ "deleted": key }))
}

// ── project / workspace handlers ──────────────────────────────────────────

fn list_projects(db: &Db) -> Result<Value, String> {
    let rows = db.list_projects().map_err(|e| e.to_string())?;
    let projects: Vec<Value> = rows
        .into_iter()
        .map(|(id, name, path, last_opened, jira_project_key, pinned, tint)| {
            json!({
                "id": id, "name": name, "path": path,
                "lastOpened": last_opened, "jiraProjectKey": jira_project_key,
                "pinned": pinned, "tint": tint
            })
        })
        .collect();
    Ok(json!({ "projects": projects }))
}

fn list_workspaces(db: &Db, args: &Value) -> Result<Value, String> {
    let project_id = req_str(args, "projectId")?;
    let workspaces = db.list_workspaces(&project_id).map_err(|e| e.to_string())?;
    Ok(json!({ "workspaces": workspaces }))
}

fn get_workspace(db: &Db, args: &Value) -> Result<Value, String> {
    let id = req_str(args, "workspaceId")?;
    let ws = db
        .get_workspace(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no workspace with id '{id}'"))?;
    Ok(json!({ "workspace": ws }))
}

fn create_workspace(db: &Mutex<Db>, args: &Value) -> Result<Value, String> {
    let project_id = req_str(args, "projectId")?;
    let task = req_str(args, "task")?;

    // Resolve the project's on-disk path (brief lock). The DB stores absolute
    // paths, so we hand it straight to the shared creator (no tilde expansion).
    let project_path = db
        .lock()
        .get_project_by_id(&project_id)
        .map_err(|e| e.to_string())?
        .map(|(_, _, path)| path)
        .ok_or_else(|| format!("no project with id '{project_id}'"))?;

    // An EXPLICIT branch is used verbatim (validated as a real git ref) — never
    // lowercased or slugified, so `JIRA-123`, `feat/Foo`, `release/2.0` work and
    // an existing branch is matched exactly. Only a branch DERIVED from free-text
    // task is slugified.
    let branch = match opt_str(args, "branch").map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    {
        Some(b) => {
            if !octopush_lib::git_ops::is_valid_branch_name(&b) {
                return Err(format!(
                    "'{b}' is not a valid git branch name (it must be a legal git ref)"
                ));
            }
            b
        }
        None => {
            let s = octopush_lib::workspace::slugify(&task);
            if s.is_empty() { "new-workspace".to_string() } else { s }
        }
    };
    let name = opt_str(args, "name")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| branch.clone());
    let from_branch = opt_str(args, "fromBranch").unwrap_or_default();
    let setup_script = opt_str(args, "setupScript").unwrap_or_default();

    let (ws, outcome) = octopush_lib::workspace::create(
        db,
        &project_id,
        std::path::Path::new(&project_path),
        &name,
        &task,
        &branch,
        &from_branch,
        &setup_script,
    )
    .map_err(|e| e.to_string())?;

    use octopush_lib::workspace::CreateOutcome;
    let (status, note) = match outcome {
        CreateOutcome::Created => (
            "created",
            "Workspace created. It appears in Octopush's left rail when you refresh the project or the window regains focus.",
        ),
        CreateOutcome::Adopted => (
            "adopted",
            "The branch was already checked out in an existing worktree, so that checkout was adopted as a workspace (no second checkout was made). It appears in the rail on refresh/focus.",
        ),
        CreateOutcome::Existed => (
            "existed",
            "A workspace for this branch already exists in Octopush — returning it rather than creating a duplicate.",
        ),
        CreateOutcome::Restored => (
            "restored",
            "An archived workspace for this branch was restored (its worktree rebuilt). It appears in the rail on refresh/focus.",
        ),
    };

    Ok(json!({ "workspace": ws, "status": status, "note": note }))
}

fn link_workspace_issue(db: &Db, args: &Value) -> Result<Value, String> {
    let id = req_str(args, "workspaceId")?;
    // Confirm the workspace exists — otherwise the UPDATE touches zero rows and
    // we'd report a success the model would trust.
    if db.get_workspace(&id).map_err(|e| e.to_string())?.is_none() {
        return Err(format!("no workspace with id '{id}'"));
    }
    // null, absent, or an empty/whitespace key all mean "clear the link".
    let issue = opt_str(args, "issueKey").filter(|s| !s.trim().is_empty());
    db.update_workspace_link(&id, issue.clone())
        .map_err(|e| e.to_string())?;
    Ok(json!({ "workspaceId": id, "linkedIssueKey": issue }))
}

// ── run handlers ──────────────────────────────────────────────────────────

fn create_run(db: &Db, args: &Value) -> Result<Value, String> {
    let workspace_id = req_str(args, "workspaceId")?;
    let pipeline_id = req_str(args, "pipelineId")?;
    let task = req_str(args, "task")?;
    let reference_model = opt_str(args, "referenceModel");
    let linked_issue = opt_str(args, "linkedIssueKey");
    let overrides: Vec<(i64, String)> = match args.get("stageModelOverrides") {
        Some(v) if !v.is_null() => serde_json::from_value(v.clone())
            .map_err(|e| format!("stageModelOverrides is malformed: {e}"))?,
        _ => Vec::new(),
    };
    let id = db
        .create_run(
            &workspace_id,
            &pipeline_id,
            &task,
            reference_model.as_deref(),
            linked_issue.as_deref(),
            &overrides,
        )
        .map_err(|e| e.to_string())?;
    Ok(json!({
        "runId": id,
        "status": "draft",
        "note": "Run staged in 'draft'. Launch it from Octopush DIRECT mode to execute."
    }))
}

fn list_runs(db: &Db, args: &Value) -> Result<Value, String> {
    let workspace_id = req_str(args, "workspaceId")?;
    let runs = db.list_runs(&workspace_id).map_err(|e| e.to_string())?;
    Ok(json!({ "runs": runs }))
}

fn get_run(db: &Db, args: &Value) -> Result<Value, String> {
    let id = req_str(args, "runId")?;
    let run = db
        .get_run(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no run with id '{id}'"))?;
    let stages = db.list_run_stages(&id).map_err(|e| e.to_string())?;
    Ok(json!({ "run": run, "stages": stages }))
}

// ── the authoring guide ───────────────────────────────────────────────────

fn describe_pipeline_schema() -> Value {
    json!({
        "concept": "A pipeline is a DAG of agent stages run by Octopush DIRECT mode. \
                    Each stage is a role-specialized agent that transforms the workspace \
                    and hands its artifact to downstream stages.",
        "roles": {
            "plan":            "Produce an implementation plan.",
            "plan_review":     "Review a plan (review role; can loop).",
            "implement":       "Write the code for the task.",
            "code_review":     "Review code changes (review role; can loop).",
            "test":            "Run/author tests and report.",
            "repro":           "Reproduce a reported bug.",
            "fix":             "Fix the bug.",
            "verify":          "Verify the fix (review role; can loop).",
            "critique":        "Critique a plan/artifact (review role; can loop).",
            "refine":          "Refine an artifact after critique.",
            "architect":       "Produce a high-level architecture plan.",
            "security_review": "Security review of code or architecture (review role; can loop).",
            "pull_request":    "Open a pull request for the changes (action role).",
            "merge":           "Merge the pull request (action role).",
            "release":         "Cut a release (action role).",
            "__note__":        "Custom roles defined in the app are also valid — call list_roles for the current set."
        },
        "reviewRoles": ["plan_review", "code_review", "critique", "verify"],
        "substrates": {
            "api": "In-process LLM call through Octopush's provider router (default).",
            "cli": "Delegate the stage to an external agent CLI (e.g. Claude Code, Aider)."
        },
        "tools": {
            "available": ["read_file", "list_files", "write_file", "run_command"],
            "note": "Omit a stage's `tools` to use the role's default set. If set, it must be a non-empty subset of the available tools."
        },
        "stageFields": {
            "role": "required — one of the roles above.",
            "agentModel": "required — model id (see recommendedModels).",
            "substrate": "'api' (default) or 'cli'.",
            "checkpoint": "true to pause for human approval before this stage. Default false.",
            "maxIterations": "per-stage tool-turn budget, 1..100. Default 25.",
            "parents": "array of earlier stage positions this stage depends on. Empty = linear chain to the previous stage.",
            "tools": "optional allowlist subset of the available tools.",
            "customName": "optional display label.",
            "instructions": "optional free-form prompt additions (<= 8000 chars).",
            "loopTargetPosition": "review roles only — an EARLIER stage to loop back to on rejection; null = no loop.",
            "loopMaxIterations": ">= 1 when looping, otherwise 0.",
            "loopMode": "'gated' (human approves each loop) or 'auto'; required when looping.",
            "effort": "optional per-stage reasoning effort: low | medium | high | xhigh | max. API substrate only (ignored on cli). Takes effect only on models that support reasoning — the current Claude families (Opus 4.5–4.8, Sonnet 4.6/5, Fable/Mythos 5) and budget-path models (Haiku 4.5, Sonnet 4.5), where higher levels auto-clamp to the model's max; on any other id (legacy claude-3-5-*, unknown/non-Claude) it is silently ignored (no thinking at all, not clamped). Use a current Claude model to get effect. Omit/null = off (no extended thinking).",
            "escalateModel": "optional — a stronger model to retry this stage with ONCE if it fails (loop exhausts its tool-turn budget unfinished, or errors) before halting. Applies to api and cli. Only fires if it raises the tier: pick a genuinely different/stronger model than agentModel; if it equals agentModel the retry no-ops and the stage halts. Omit = no escalation.",
            "escalateEffort": "optional — also raise the reasoning effort on the escalated retry (api only): low | medium | high | xhigh | max. On its own (no escalateModel) it triggers a retry only when higher than the base effort; equal effort no-ops."
        },
        "rules": [
            "At least one stage.",
            "Each `parents` entry must reference a strictly-earlier position; no duplicates; the graph must be acyclic.",
            "Only review roles (plan_review, code_review, critique, verify) may carry a loop.",
            "A loop's target must be an earlier stage; in an authored graph it must lie on the review's own ancestry path.",
            "When loopTargetPosition is null, loopMaxIterations must be 0 and loopMode must be null.",
            "substrate must be 'api' or 'cli'; agentModel must be non-empty; maxIterations in 1..100.",
            "effort is API-substrate only (ignored on cli) and takes effect only on reasoning-capable models — the current Claude families and budget-path models auto-clamp higher levels to the model's max (e.g. Sonnet 4.6 caps xhigh→high); on legacy claude-3-5-* or unknown/non-Claude models it is silently ignored (no thinking), not clamped. omit/null = off.",
            "A stage with an escalateModel (and/or escalateEffort) retries ONCE at the stronger tier when it fails before halting — but ONLY if that raises the tier: if escalateModel equals agentModel (or escalateEffort equals the base effort with no model change) the escalation no-ops and the stage just halts. escalateModel applies to api and cli, escalateEffort is api-only."
        ],
        "recommendedModels": {
            "claude-opus-4-8": "Most capable — heavy implement/plan stages, and a good escalateModel target.",
            "claude-sonnet-4-6": "Balanced — implement, fix, refine, plan.",
            "claude-haiku-4-5": "Fast & cheap — plan, reviews, tests.",
            "note": "Any model id your configured providers support is accepted; these are the defaults the built-in pipelines use."
        },
        "customRoles": {
            "__note__": "Beyond the built-in roles above you can AUTHOR your own with save_role, then reference one from a stage's `role` (by the role's key). list_roles returns the full current set (built-in + custom).",
            "requiredFields": {
                "label": "Display name (required).",
                "promptBody": "The role's system-prompt body — what this agent does (required, non-empty). Composed with the environment preamble at run time."
            },
            "optionalFields": {
                "key": "Stable id a stage references (role: \"<key>\"). Derived from the label when omitted (lowercase, each run of non-alphanumerics → '_', trimmed); always returned by save_role.",
                "description": "short human description — default \"\".",
                "artifactKind": "plan | review | tests | diff | note — default note.",
                "environment": "worktree (default; never touches git, leaves changes uncommitted for the next stage) | action (may commit/push/PR/merge/release).",
                "canLoop": "default false — set true for a review-style role that can loop back on rejection.",
                "defaultTools": "subset of [read_file, list_files, write_file, run_command] — default [read_file, list_files].",
                "defaultSubstrate": "api (default) | cli.",
                "defaultCheckpoint": "default false.",
                "tokenEstIn": "cost-preview input estimate — default 4000.",
                "tokenEstOut": "cost-preview output estimate — default 1000."
            },
            "rules": [
                "Built-in role keys are protected: save_role rejects a key that maps to a built-in; delete_role refuses built-ins.",
                "A role in use by any pipeline or run stage cannot be deleted — re-point or remove those stages first."
            ]
        },
        "runtimeBehaviors": {
            "__note__": "Two mechanics run at execution time (in the app), not things you enumerate in the stage list — design your pipeline around them.",
            "escapeValve": "An API-substrate stage may PAUSE and ask the director a question (with a recommended default) when it is genuinely blocked — the run parks like a checkpoint until you answer, then resumes. Nothing to author or configure. IMPORTANT: this is API-only — a `cli` stage keeps a strict never-ask contract and has NO ask-director tool, so it never self-blocks. For a cli stage that might need a human, use a `checkpoint` (pause before it) or an `escalateModel` (retry stronger on failure) instead.",
            "autoEscalation": "Set `escalateModel` (optionally `escalateEffort`) on your expensive or critical stages so that a FAILURE retries ONCE at a stronger tier instead of halting the whole run. It fires ONLY when it actually raises the tier — set escalateModel to a genuinely stronger model than the stage's agentModel (and/or escalateEffort higher than the base effort); if the escalated tier equals the base, no retry happens and the stage halts. Reach for it on the stages you most want to finish unattended."
        },
        "annotatedExample": {
            "name": "Feature Factory (custom)",
            "description": "Plan (medium effort) → review the plan → implement (high effort, escalates to Opus on failure) → review code (loops back to implement) → test.",
            "stages": [
                { "role": "plan",        "agentModel": "claude-haiku-4-5",  "substrate": "api", "effort": "medium" },
                { "role": "plan_review", "agentModel": "claude-haiku-4-5",  "substrate": "api" },
                { "role": "implement",   "agentModel": "claude-sonnet-4-6", "substrate": "api", "checkpoint": true,
                  "effort": "high", "escalateModel": "claude-opus-4-8" },
                { "role": "code_review", "agentModel": "claude-haiku-4-5",  "substrate": "api", "checkpoint": true,
                  "loopTargetPosition": 2, "loopMaxIterations": 2, "loopMode": "gated" },
                { "role": "test",        "agentModel": "claude-haiku-4-5",  "substrate": "api", "checkpoint": true }
            ]
        }
    })
}

// ── tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use octopush_lib::db::Db;
    use tempfile::NamedTempFile;

    fn test_db() -> Db {
        // `Db::open` runs migrations, which seed the built-in roles the pipeline
        // validator needs. No pipeline seeding required for authoring a fresh one.
        let tmp = NamedTempFile::new().unwrap();
        Db::open(tmp.path()).unwrap()
    }

    /// The per-stage input schema advertises effort + escalation so a client
    /// won't reject them (it carries `additionalProperties: false`).
    #[test]
    fn stage_schema_advertises_effort_and_escalation() {
        let schema = STAGE_ARRAY_SCHEMA();
        let props = &schema["items"]["properties"];
        for key in ["effort", "escalateModel", "escalateEffort"] {
            assert!(props.get(key).is_some(), "stage schema is missing '{key}'");
        }
        // effort/escalateEffort constrain to the five levels (plus null).
        let enum_vals = props["effort"]["enum"].as_array().unwrap();
        for level in ["low", "medium", "high", "xhigh", "max"] {
            assert!(enum_vals.iter().any(|v| v == level), "effort enum missing '{level}'");
        }
    }

    /// The authoring guide documents the three fields, the runtime mechanics,
    /// and the escalation/effort rules.
    #[test]
    fn describe_schema_documents_effort_and_escalation() {
        let schema = describe_pipeline_schema();
        let fields = &schema["stageFields"];
        for key in ["effort", "escalateModel", "escalateEffort"] {
            assert!(fields.get(key).is_some(), "stageFields missing '{key}'");
        }
        // Runtime behaviors an author designs around.
        assert!(schema["runtimeBehaviors"]["escapeValve"].is_string());
        assert!(schema["runtimeBehaviors"]["autoEscalation"].is_string());
        // The annotated example demonstrates both knobs.
        let stages = schema["annotatedExample"]["stages"].as_array().unwrap();
        assert_eq!(stages[0]["effort"], "medium");
        assert_eq!(stages[2]["effort"], "high");
        assert_eq!(stages[2]["escalateModel"], "claude-opus-4-8");
    }

    /// A stage carrying effort + escalateModel + escalateEffort is accepted by
    /// create_pipeline and round-trips through the same persistence the app uses.
    #[test]
    fn create_pipeline_round_trips_effort_and_escalation() {
        let db = test_db();
        let args = json!({
            "name": "Effort Pipe",
            "description": "one heavy stage",
            "stages": [
                {
                    "role": "implement",
                    "agentModel": "claude-sonnet-4-6",
                    "effort": "high",
                    "escalateModel": "claude-opus-4-8",
                    "escalateEffort": "max"
                }
            ]
        });
        let payload = save_pipeline(&db, &args, None).expect("create_pipeline should accept the stage");
        let stage = &payload["stages"][0];
        assert_eq!(stage["effort"], "high");
        assert_eq!(stage["escalateModel"], "claude-opus-4-8");
        assert_eq!(stage["escalateEffort"], "max");

        // And it truly persisted: re-read straight from the store.
        let pid = payload["pipelineId"].as_str().unwrap();
        let stages = db.get_pipeline_stages(pid).unwrap();
        assert_eq!(stages[0].effort, Some(octopush_lib::providers::Effort::High));
        assert_eq!(stages[0].escalate_model.as_deref(), Some("claude-opus-4-8"));
        assert_eq!(stages[0].escalate_effort, Some(octopush_lib::providers::Effort::Max));
    }

    /// A whitespace-only escalateModel means "no escalation" (matches
    /// save_pipeline's persistence), not a stored phantom empty model id.
    #[test]
    fn empty_escalate_model_normalizes_to_none() {
        let db = test_db();
        let args = json!({
            "name": "No Escalation",
            "description": "blank escalateModel",
            "stages": [ { "role": "implement", "agentModel": "claude-sonnet-4-6", "escalateModel": "   " } ]
        });
        let payload = save_pipeline(&db, &args, None).expect("blank escalateModel is dropped, not an error");
        assert!(payload["stages"][0]["escalateModel"].is_null());
    }

    /// An effort value outside the enum surfaces as a clean tool error naming
    /// the stage — never a serde panic.
    #[test]
    fn invalid_effort_is_a_clean_tool_error() {
        let db = test_db();
        let args = json!({
            "name": "Bad Effort",
            "description": "unknown effort level",
            "stages": [ { "role": "implement", "agentModel": "claude-sonnet-4-6", "effort": "ultra" } ]
        });
        let err = save_pipeline(&db, &args, None).expect_err("an invalid effort must be rejected");
        assert!(err.contains("stage 1"), "error should name the stage: {err}");
    }

    // ── role authoring ────────────────────────────────────────────────────

    /// The key derivation is byte-for-byte the app's `deriveRoleKey`.
    #[test]
    fn derive_role_key_matches_app_algorithm() {
        assert_eq!(derive_role_key("Security Auditor"), "security_auditor");
        assert_eq!(derive_role_key("  Plan!!  "), "plan");
        assert_eq!(derive_role_key("API/CLI reviewer"), "api_cli_reviewer");
        assert_eq!(derive_role_key("multi   space"), "multi_space");
        assert_eq!(derive_role_key("!!!"), ""); // pure punctuation → empty
    }

    /// save_role with only label + promptBody derives the key and applies the
    /// app's new-role defaults, and truly persists (re-read from the store).
    #[test]
    fn save_role_applies_defaults_and_derives_key() {
        let db = test_db();
        let payload = save_role(
            &db,
            &json!({ "label": "Security Auditor", "promptBody": "Audit the diff for vulnerabilities." }),
        )
        .expect("a minimal role should save");
        assert_eq!(payload["key"], "security_auditor");
        let role = &payload["role"];
        assert_eq!(role["artifactKind"], "note");
        assert_eq!(role["environment"], "worktree");
        assert_eq!(role["canLoop"], false);
        assert_eq!(role["defaultSubstrate"], "api");
        assert_eq!(role["defaultTools"], json!(["read_file", "list_files"]));
        assert_eq!(role["tokenEstIn"], 4000);
        assert_eq!(role["isBuiltin"], false);

        // Persisted and re-readable by key.
        let stored = db.get_role("security_auditor").unwrap().expect("role in store");
        assert_eq!(stored.label, "Security Auditor");
        assert!(!stored.is_builtin);
    }

    /// An explicit key is preserved (not re-derived), and updating it edits in place.
    #[test]
    fn save_role_preserves_explicit_key_and_updates_in_place() {
        let db = test_db();
        save_role(
            &db,
            &json!({ "key": "my_reviewer", "label": "Reviewer", "promptBody": "v1" }),
        )
        .unwrap();
        save_role(
            &db,
            &json!({ "key": "my_reviewer", "label": "Reviewer", "promptBody": "v2 updated" }),
        )
        .unwrap();
        let stored = db.get_role("my_reviewer").unwrap().unwrap();
        assert_eq!(stored.prompt_body, "v2 updated");
        // Exactly one custom role — the update didn't create a second row.
        let customs = db.list_roles().unwrap().into_iter().filter(|r| !r.is_builtin).count();
        assert_eq!(customs, 1);
    }

    /// A key that maps to a BUILT-IN role is rejected — never silently overwritten.
    #[test]
    fn save_role_rejects_builtin_key() {
        let db = test_db();
        let err = save_role(
            &db,
            &json!({ "key": "code_review", "label": "Hijack", "promptBody": "nope" }),
        )
        .expect_err("a built-in key must be rejected");
        assert!(err.contains("built-in"), "error should mention built-in: {err}");
    }

    /// An out-of-enum artifactKind is a clean tool error, never a panic.
    #[test]
    fn save_role_rejects_invalid_artifact_kind() {
        let db = test_db();
        let err = save_role(
            &db,
            &json!({ "label": "Bad", "promptBody": "x", "artifactKind": "blueprint" }),
        )
        .expect_err("an unknown artifactKind must be rejected");
        assert!(err.contains("malformed"), "error should be a clean parse error: {err}");
    }

    /// An unknown tool in defaultTools is rejected at authoring time.
    #[test]
    fn save_role_rejects_unknown_tool() {
        let db = test_db();
        let err = save_role(
            &db,
            &json!({ "label": "Bad Tools", "promptBody": "x", "defaultTools": ["read_file", "deploy_prod"] }),
        )
        .expect_err("an unknown tool must be rejected");
        assert!(err.contains("deploy_prod"), "error should name the bad tool: {err}");
    }

    /// An empty/whitespace promptBody is rejected.
    #[test]
    fn save_role_rejects_empty_prompt() {
        let db = test_db();
        assert!(save_role(&db, &json!({ "label": "L", "promptBody": "   " })).is_err());
    }

    /// delete_role refuses a built-in role.
    #[test]
    fn delete_role_refuses_builtin() {
        let db = test_db();
        let err = delete_role(&db, &json!({ "key": "code_review" }))
            .expect_err("built-in roles are protected");
        assert!(err.contains("built-in"), "error should mention built-in: {err}");
    }

    /// delete_role refuses a custom role that a pipeline stage still uses.
    #[test]
    fn delete_role_refuses_in_use() {
        let db = test_db();
        save_role(&db, &json!({ "key": "my_reviewer", "label": "Reviewer", "promptBody": "review" }))
            .unwrap();
        save_pipeline(
            &db,
            &json!({
                "name": "Uses Custom",
                "description": "a pipeline referencing the custom role",
                "stages": [ { "role": "my_reviewer", "agentModel": "claude-haiku-4-5" } ]
            }),
            None,
        )
        .expect("pipeline with a valid custom role should save");
        let err = delete_role(&db, &json!({ "key": "my_reviewer" }))
            .expect_err("an in-use role must be protected");
        assert!(err.contains("used by"), "error should explain it's in use: {err}");
    }

    /// delete_role removes an unused custom role.
    #[test]
    fn delete_role_removes_unused_custom() {
        let db = test_db();
        save_role(&db, &json!({ "key": "temp_role", "label": "Temp", "promptBody": "x" })).unwrap();
        let out = delete_role(&db, &json!({ "key": "temp_role" })).expect("unused custom deletes");
        assert_eq!(out["deleted"], "temp_role");
        assert!(db.get_role("temp_role").unwrap().is_none());
    }

    /// The authoring guide documents custom-role authoring.
    #[test]
    fn describe_schema_documents_custom_roles() {
        let schema = describe_pipeline_schema();
        let cr = &schema["customRoles"];
        assert!(cr["requiredFields"]["label"].is_string());
        assert!(cr["requiredFields"]["promptBody"].is_string());
        assert!(cr["optionalFields"]["artifactKind"].is_string());
        assert!(cr["rules"].as_array().unwrap().iter().any(|r| r
            .as_str()
            .unwrap_or("")
            .contains("built-in")));
    }
}
