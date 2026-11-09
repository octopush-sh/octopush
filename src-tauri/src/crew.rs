//! Portable crews — one pipeline plus the custom roles its stages reference,
//! as a versioned, human-readable `*.octocrew.json` file:
//!
//! ```text
//! { "octocrew": 1, "minApp": "0.4.115",
//!   "pipeline": { "name": "…", "description": "…", "stages": [ /* StageDraft[] */ ] },
//!   "roles": [ /* RoleDef[]: only the custom roles the stages use */ ] }
//! ```
//!
//! The file carries prompt text and tool permissions, nothing else: no keys,
//! provider URLs, workspace paths or run history. Import is a review, never an
//! execution: [`preview`] shows what would be saved, [`import`] saves it as a
//! normal custom pipeline after the same validator `save_pipeline` uses, and
//! nothing ever starts a run. Teams can also commit crews in the repo under
//! [`REPO_CREWS_DIR`] ([`scan_repo`]).

use crate::db::{Db, StageDraft};
use crate::error::{AppError, AppResult};
use crate::orchestrator::roles::RoleDef;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// The file format this build writes and the newest it reads.
pub const CREW_FORMAT: u32 = 1;
/// A crew file is a few KB; anything far larger is not one.
pub const MAX_CREW_BYTES: u64 = 512 * 1024;
/// Where a repo keeps its committed crews, relative to the worktree.
pub const REPO_CREWS_DIR: &str = ".octopush/crews";
pub const CREW_SUFFIX: &str = ".octocrew.json";
/// Room for long role prompts, but not for a pasted book.
const MAX_ROLE_PROMPT_CHARS: usize = 32_000;
/// At most this many repo crews are listed.
const MAX_REPO_CREWS: usize = 50;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CrewFile {
    pub octocrew: u32,
    /// The oldest app version that can import the file (informational for
    /// newer builds; an older build refuses it).
    #[serde(default)]
    pub min_app: String,
    pub pipeline: CrewPipeline,
    #[serde(default)]
    pub roles: Vec<RoleDef>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CrewPipeline {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub stages: Vec<StageDraft>,
}

/// One stage as the review sheet shows it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CrewStagePreview {
    pub position: usize,
    /// The custom name, else the role's label, else its key.
    pub label: String,
    /// The role key the stage will use (after any rename).
    pub role: String,
    pub agent_model: String,
    pub escalate_model: Option<String>,
    pub substrate: String,
    pub checkpoint: bool,
    /// [`crate::orchestrator::stage_read_only`]: false means it can write.
    pub read_only: bool,
    /// The role may commit, push and run release commands.
    pub action_role: bool,
    /// The tools it gets: its allowlist, else the role's defaults.
    pub tools: Vec<String>,
    pub instructions: Option<String>,
    pub unpriced_model: bool,
    pub unpriced_escalate: bool,
    pub problem: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CrewRolePreview {
    /// The key it will be saved under.
    pub key: String,
    /// The key in the file.
    pub original_key: String,
    pub label: String,
    pub prompt_body: String,
    /// "new" (saved as is) · "renamed" (key taken, suffixed) · "existing"
    /// (an identical custom role is already here; reused).
    pub fate: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CrewPreview {
    pub name: String,
    pub description: String,
    pub stages: Vec<CrewStagePreview>,
    pub roles: Vec<CrewRolePreview>,
    /// Problems not tied to a stage (name, a malformed role).
    pub problems: Vec<String>,
    /// True when nothing blocks the import.
    pub ok: bool,
}

/// A crew file found in the repo.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoCrew {
    pub file: String,
    pub name: String,
    pub description: String,
    pub stage_count: usize,
    /// The file's text, handed back to preview/import on "Fork".
    pub json: String,
    pub problem: Option<String>,
}

/// The crew for a saved pipeline: its stages exactly as `save_pipeline`
/// consumes them, plus every CUSTOM role they reference (built-ins ship with
/// every Octopush, so they never travel).
pub fn export(db: &Db, pipeline_id: &str) -> AppResult<CrewFile> {
    let head = db
        .list_pipelines()?
        .into_iter()
        .find(|p| p.id == pipeline_id)
        .ok_or_else(|| AppError::Other("pipeline not found".into()))?;
    let stages = db.pipeline_stage_drafts(pipeline_id)?;
    let mut roles: Vec<RoleDef> = Vec::new();
    for s in &stages {
        if roles.iter().any(|r| r.key == s.role) {
            continue;
        }
        if let Some(r) = db.get_role(&s.role)? {
            if !r.is_builtin {
                roles.push(r);
            }
        }
    }
    Ok(CrewFile {
        octocrew: CREW_FORMAT,
        min_app: env!("CARGO_PKG_VERSION").to_string(),
        pipeline: CrewPipeline { name: head.name, description: head.description, stages },
        roles,
    })
}

pub fn to_json(crew: &CrewFile) -> AppResult<String> {
    Ok(serde_json::to_string_pretty(crew)? + "\n")
}

/// `Bugfix relay (cheap plan)` → `bugfix-relay-cheap-plan.octocrew.json`.
pub fn file_name(pipeline_name: &str) -> String {
    let mut slug = String::new();
    for c in pipeline_name.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-');
    format!("{}{CREW_SUFFIX}", if slug.is_empty() { "crew" } else { slug })
}

/// `0.4.115` → `[0, 4, 115]`; a non-numeric part reads as 0.
fn version_parts(v: &str) -> Vec<u64> {
    v.trim().split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

/// Parse a crew file's text. Refuses non-crews and crews from a newer format
/// or app version with a sentence the user can act on.
pub fn parse(text: &str) -> AppResult<CrewFile> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|_| AppError::Other("This isn't JSON, so it can't be a crew file.".into()))?;
    let Some(format) = value.get("octocrew").and_then(|v| v.as_u64()) else {
        return Err(AppError::Other("This JSON isn't an Octopush crew (no \"octocrew\" version).".into()));
    };
    if format > CREW_FORMAT as u64 {
        return Err(AppError::Other(format!(
            "This crew uses format {format}, which a newer Octopush wrote. Update the app to import it."
        )));
    }
    let crew: CrewFile = serde_json::from_value(value)
        .map_err(|e| AppError::Other(format!("This crew file is malformed: {e}")))?;
    if !crew.min_app.is_empty() && version_parts(&crew.min_app) > version_parts(env!("CARGO_PKG_VERSION")) {
        return Err(AppError::Other(format!(
            "This crew needs Octopush {} or later. Update the app to import it.",
            crew.min_app
        )));
    }
    Ok(crew)
}

/// Same definition, ignoring the key and the built-in flag (an import is
/// never built-in).
fn same_role(a: &RoleDef, b: &RoleDef) -> bool {
    let norm = |r: &RoleDef| {
        let mut r = r.clone();
        r.key = String::new();
        r.is_builtin = false;
        serde_json::to_value(r).ok()
    };
    norm(a) == norm(b)
}

fn role_problem(r: &RoleDef) -> Option<String> {
    if r.key.trim().is_empty() || r.key != r.key.trim() {
        return Some(format!("role '{}' has an empty or padded key", r.label));
    }
    if r.label.trim().is_empty() {
        return Some(format!("role '{}' has no label", r.key));
    }
    if r.prompt_body.trim().is_empty() {
        return Some(format!("role '{}' has an empty prompt", r.key));
    }
    if r.prompt_body.chars().count() > MAX_ROLE_PROMPT_CHARS {
        return Some(format!("role '{}' prompt is too long (max {MAX_ROLE_PROMPT_CHARS} characters)", r.key));
    }
    if !matches!(r.default_substrate.as_str(), "api" | "cli") {
        return Some(format!("role '{}' has an unknown substrate '{}'", r.key, r.default_substrate));
    }
    if let Some(t) = r.default_tools.iter().find(|t| !crate::db::KNOWN_TOOLS.contains(&t.as_str())) {
        return Some(format!("role '{}' has an unknown tool '{t}'", r.key));
    }
    None
}

/// The crew as it would be saved: roles re-keyed so no local role is ever
/// overwritten (a taken key gets `-2`, `-3`, …; an identical custom role is
/// reused), stage roles rewritten to match, and models swapped as the user
/// chose in the review sheet.
struct Plan {
    name: String,
    description: String,
    stages: Vec<StageDraft>,
    /// Roles to save, and every role the stages may reference from the file.
    to_save: Vec<RoleDef>,
    resolved: Vec<RoleDef>,
    role_previews: Vec<CrewRolePreview>,
    problems: Vec<String>,
}

fn plan(db: &Db, crew: &CrewFile, model_swaps: &[(String, String)]) -> AppResult<Plan> {
    let mut problems = Vec::new();
    if crew.pipeline.name.trim().is_empty() {
        problems.push("the crew has no name".to_string());
    }
    if crew.pipeline.stages.is_empty() {
        problems.push("the crew has no stages".to_string());
    }
    let mut renames: Vec<(String, String)> = Vec::new();
    let mut to_save: Vec<RoleDef> = Vec::new();
    let mut resolved: Vec<RoleDef> = Vec::new();
    let mut role_previews = Vec::new();
    for incoming in &crew.roles {
        if renames.iter().any(|(from, _)| *from == incoming.key) {
            problems.push(format!("role '{}' is listed twice", incoming.key));
            continue;
        }
        if let Some(p) = role_problem(incoming) {
            problems.push(p);
            continue;
        }
        let mut role = incoming.clone();
        role.is_builtin = false;
        // First key that is free, or already holds this exact custom role.
        let mut n = 1;
        let fate = loop {
            let key = if n == 1 { incoming.key.clone() } else { format!("{}-{n}", incoming.key) };
            let taken_here = to_save.iter().any(|r| r.key == key);
            match db.get_role(&key)? {
                None if !taken_here => {
                    role.key = key;
                    let fate = if n == 1 { "new" } else { "renamed" };
                    break fate;
                }
                Some(local) if !local.is_builtin && same_role(&local, &role) => {
                    role.key = key;
                    break "existing";
                }
                _ => n += 1,
            }
        };
        renames.push((incoming.key.clone(), role.key.clone()));
        role_previews.push(CrewRolePreview {
            key: role.key.clone(),
            original_key: incoming.key.clone(),
            label: role.label.clone(),
            prompt_body: role.prompt_body.clone(),
            fate: fate.to_string(),
        });
        if fate != "existing" {
            to_save.push(role.clone());
        }
        resolved.push(role);
    }
    let swap = |m: &str| -> String {
        model_swaps
            .iter()
            .find(|(from, _)| from == m)
            .map(|(_, to)| to.clone())
            .unwrap_or_else(|| m.to_string())
    };
    let stages = crew
        .pipeline
        .stages
        .iter()
        .map(|s| {
            let mut s = s.clone();
            if let Some((_, to)) = renames.iter().find(|(from, _)| *from == s.role) {
                s.role = to.clone();
            }
            s.agent_model = swap(&s.agent_model);
            s.escalate_model = s.escalate_model.as_deref().map(&swap);
            s
        })
        .collect();
    Ok(Plan {
        name: crew.pipeline.name.trim().to_string(),
        description: crew.pipeline.description.trim().to_string(),
        stages,
        to_save,
        resolved,
        role_previews,
        problems,
    })
}

/// Everything the review sheet shows. Writes nothing.
pub fn preview(db: &Db, crew: &CrewFile, model_swaps: &[(String, String)]) -> AppResult<CrewPreview> {
    let plan = plan(db, crew, model_swaps)?;
    let issues = if plan.stages.is_empty() {
        Vec::new()
    } else {
        db.pipeline_stage_issues(&plan.stages, &plan.resolved)?
    };
    let router = crate::token_engine::catalog();
    let priced = |m: &str| crate::token_engine::prices_in(router.as_deref(), m).is_some();
    let mut stages = Vec::with_capacity(plan.stages.len());
    for (i, s) in plan.stages.iter().enumerate() {
        let role = match plan.resolved.iter().find(|r| r.key == s.role) {
            Some(r) => Some(r.clone()),
            None => db.get_role(&s.role)?,
        };
        let label = s
            .custom_name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_string)
            .or_else(|| role.as_ref().map(|r| r.label.clone()))
            .unwrap_or_else(|| s.role.clone());
        let escalate_model = s.escalate_model.as_deref().map(str::trim).filter(|m| !m.is_empty()).map(str::to_string);
        stages.push(CrewStagePreview {
            position: i,
            label,
            role: s.role.clone(),
            agent_model: s.agent_model.clone(),
            unpriced_model: !priced(&s.agent_model),
            unpriced_escalate: escalate_model.as_deref().map(|m| !priced(m)).unwrap_or(false),
            escalate_model,
            substrate: s.substrate.clone(),
            checkpoint: s.checkpoint,
            read_only: crate::orchestrator::stage_read_only(&s.substrate, &s.agent_model, s.tools.as_deref(), role.as_ref()),
            action_role: role
                .as_ref()
                .map(|r| matches!(r.environment, crate::orchestrator::types::RoleEnvironment::Action))
                .unwrap_or(false),
            tools: s
                .tools
                .clone()
                .or_else(|| role.as_ref().map(|r| r.default_tools.clone()))
                .unwrap_or_default(),
            instructions: s.instructions.clone().filter(|t| !t.trim().is_empty()),
            problem: issues.iter().find(|(p, _)| *p == i).map(|(_, m)| m.clone()),
        });
    }
    let ok = plan.problems.is_empty() && issues.is_empty();
    Ok(CrewPreview {
        name: plan.name,
        description: plan.description,
        stages,
        roles: plan.role_previews,
        problems: plan.problems,
        ok,
    })
}

/// Save the crew as a new custom pipeline (and its new roles). Validates the
/// whole crew first, so an invalid file saves nothing. Never starts a run.
/// Returns the new pipeline's id.
pub fn import(db: &Db, crew: &CrewFile, model_swaps: &[(String, String)]) -> AppResult<String> {
    let plan = plan(db, crew, model_swaps)?;
    if let Some(p) = plan.problems.first() {
        return Err(AppError::Other(p.clone()));
    }
    if let Some((i, msg)) = db.pipeline_stage_issues(&plan.stages, &plan.resolved)?.into_iter().next() {
        return Err(AppError::Other(format!("stage {}: {msg}", i + 1)));
    }
    let mut saved: Vec<&str> = Vec::new();
    for r in &plan.to_save {
        if let Err(e) = db.upsert_role(r) {
            for k in &saved {
                let _ = db.delete_role(k);
            }
            return Err(e);
        }
        saved.push(&r.key);
    }
    match db.save_pipeline(None, &plan.name, &plan.description, &plan.stages) {
        Ok(id) => Ok(id),
        Err(e) => {
            for k in &saved {
                let _ = db.delete_role(k);
            }
            Err(e)
        }
    }
}

/// Read a crew file the user picked (or dropped), bounded in size.
pub fn read_file(path: &Path) -> AppResult<String> {
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Err(AppError::Other("That isn't a file.".into()));
    }
    if meta.len() > MAX_CREW_BYTES {
        return Err(AppError::Other("That file is too large to be a crew.".into()));
    }
    Ok(std::fs::read_to_string(path)?)
}

/// The crews committed under `<worktree>/.octopush/crews/*.octocrew.json`,
/// sorted by file name and re-read on every call, so an edit on disk shows the
/// next time the launcher opens. Symlinks are skipped (a repo must not point
/// the app at files outside it); an unreadable or invalid file is listed with
/// its problem rather than hidden.
pub fn scan_repo(worktree: &Path) -> Vec<RepoCrew> {
    let dir = worktree.join(REPO_CREWS_DIR);
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut files: Vec<(String, std::path::PathBuf)> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.ends_with(CREW_SUFFIX).then(|| (name, e.path()))
        })
        .collect();
    files.sort();
    files.truncate(MAX_REPO_CREWS);
    files
        .into_iter()
        .map(|(file, path)| {
            let fallback = file.trim_end_matches(CREW_SUFFIX).to_string();
            let read = read_file(&path).map_err(|e| e.to_string());
            let json = read.clone().unwrap_or_default();
            match read.and_then(|t| parse(&t).map_err(|e| e.to_string())) {
                Ok(crew) => RepoCrew {
                    file,
                    name: crew.pipeline.name,
                    description: crew.pipeline.description,
                    stage_count: crew.pipeline.stages.len(),
                    json,
                    problem: None,
                },
                Err(problem) => RepoCrew {
                    file,
                    name: fallback,
                    description: String::new(),
                    stage_count: 0,
                    json,
                    problem: Some(problem),
                },
            }
        })
        .collect()
}
