//! The Octopush MCP tool surface: definitions (name + JSON Schema) and the
//! dispatch into `octopush_lib::db`.
//!
//! v1 scope is **read + author**, never execute: list/inspect pipelines,
//! projects, workspaces, and runs; create/update/delete pipeline templates;
//! stage runs in `draft`; link a workspace to an issue. Nothing here spends
//! tokens or touches a git working tree — run execution stays in the app.

use octopush_lib::db::{Db, StageDraft};
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
             loop & checkpoint rules the validator enforces, recommended model \
             ids, and a fully annotated example. CALL THIS FIRST before \
             create_pipeline or update_pipeline.",
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
             an ordered list of stages. Stages are validated (roles, substrates, \
             tool allowlists, loop/checkpoint rules) before saving; invalid \
             drafts are rejected with a reason. Returns the new pipeline id. \
             Does not run anything.",
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
                "loopMode": { "type": ["string", "null"], "enum": ["gated", "auto", null], "description": "'gated' (human-approved) or 'auto'. Required when looping." }
            },
            "required": ["role", "agentModel"],
            "additionalProperties": false
        }
    })
}

/// Dispatch a `tools/call`. Returns the MCP result object (success or in-band
/// tool error). A `None` return is impossible — unknown tools are reported as
/// tool errors so the model can recover.
pub fn call_tool(db: &Db, name: &str, args: &Value) -> Value {
    let outcome = match name {
        "describe_pipeline_schema" => Ok(describe_pipeline_schema()),
        "list_pipelines" => list_pipelines(db),
        "get_pipeline" => get_pipeline(db, args),
        "create_pipeline" => save_pipeline(db, args, None),
        "update_pipeline" => save_pipeline(db, args, Some(())),
        "delete_pipeline" => delete_pipeline(db, args),
        "list_projects" => list_projects(db),
        "list_workspaces" => list_workspaces(db, args),
        "get_workspace" => get_workspace(db, args),
        "link_workspace_issue" => link_workspace_issue(db, args),
        "create_run" => create_run(db, args),
        "list_runs" => list_runs(db, args),
        "get_run" => get_run(db, args),
        other => Err(format!("unknown tool '{other}'")),
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
            "loopMode": "'gated' (human approves each loop) or 'auto'; required when looping."
        },
        "rules": [
            "At least one stage.",
            "Each `parents` entry must reference a strictly-earlier position; no duplicates; the graph must be acyclic.",
            "Only review roles (plan_review, code_review, critique, verify) may carry a loop.",
            "A loop's target must be an earlier stage; in an authored graph it must lie on the review's own ancestry path.",
            "When loopTargetPosition is null, loopMaxIterations must be 0 and loopMode must be null.",
            "substrate must be 'api' or 'cli'; agentModel must be non-empty; maxIterations in 1..100."
        ],
        "recommendedModels": {
            "claude-opus-4-8": "Most capable — heavy implement/plan stages.",
            "claude-sonnet-4-6": "Balanced — implement, fix, refine, plan.",
            "claude-haiku-4-5": "Fast & cheap — plan, reviews, tests.",
            "note": "Any model id your configured providers support is accepted; these are the defaults the built-in pipelines use."
        },
        "annotatedExample": {
            "name": "Feature Factory (custom)",
            "description": "Plan → review the plan → implement → review code (loops back to implement) → test.",
            "stages": [
                { "role": "plan",        "agentModel": "claude-haiku-4-5",  "substrate": "api" },
                { "role": "plan_review", "agentModel": "claude-haiku-4-5",  "substrate": "api" },
                { "role": "implement",   "agentModel": "claude-sonnet-4-6", "substrate": "api", "checkpoint": true },
                { "role": "code_review", "agentModel": "claude-haiku-4-5",  "substrate": "api", "checkpoint": true,
                  "loopTargetPosition": 2, "loopMaxIterations": 2, "loopMode": "gated" },
                { "role": "test",        "agentModel": "claude-haiku-4-5",  "substrate": "api", "checkpoint": true }
            ]
        }
    })
}
