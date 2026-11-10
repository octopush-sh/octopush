//! Portable crews — one pipeline plus the custom roles its stages reference,
//! as a versioned, human-readable `*.octocrew.json` file:
//!
//! ```text
//! { "octocrew": 1, "minApp": "0.4.117",
//!   "pipeline": { "name": "…", "description": "…", "stages": [ /* StageDraft[] */ ] },
//!   "roles": [ /* RoleDef[]: only the custom roles the stages use */ ] }
//! ```
//!
//! The file carries prompt text and tool permissions, nothing else: no keys,
//! provider URLs, workspace paths or run history. Import is a review, never an
//! execution: [`preview`] shows what would be saved, [`import`] saves it as a
//! normal custom pipeline after the same validator `save_pipeline` uses, and
//! nothing ever starts a run. Teams can also commit crews in the repo under
//! [`REPO_CREWS_DIR`] ([`scan_repo`], [`read_repo_crew`]).
//!
//! An imported file is untrusted (it may come from a cloned repo), so every
//! string in it is checked for hidden or control characters and bounded in
//! length before the review sheet shows it, and file reads never follow a
//! repo's symlinks or block on a FIFO.

use crate::db::{Db, StageDraft};
use crate::error::{AppError, AppResult};
use crate::orchestrator::roles::RoleDef;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

/// The file format this build writes and the newest it reads.
pub const CREW_FORMAT: u32 = 1;
/// The oldest app that reads format 1: the version that ships portable
/// crews. Fixed per format (never the exporting app's own version), so
/// teammates on different patch versions can share files.
pub const CREW_MIN_APP: &str = "0.4.117";
/// A crew file is a few KB; anything far larger is not one.
pub const MAX_CREW_BYTES: u64 = 512 * 1024;
/// More stages than any real crew; keeps the review sheet reviewable.
pub const MAX_CREW_STAGES: usize = 64;
/// More custom roles than any real crew needs.
pub const MAX_CREW_ROLES: usize = 32;
/// Where a repo keeps its committed crews, relative to the worktree.
pub const REPO_CREWS_DIR: &str = ".octopush/crews";
pub const CREW_SUFFIX: &str = ".octocrew.json";
/// The cold-start token prior of a role nobody has measured yet (the role
/// editor's default and `estimate_run_cost`'s fallback). An imported role
/// starts from it: a file's own estimates are not trusted.
pub const DEFAULT_TOKEN_EST_IN: i64 = 4_000;
pub const DEFAULT_TOKEN_EST_OUT: i64 = 1_000;
/// Room for long role prompts, but not for a pasted book.
const MAX_ROLE_PROMPT_CHARS: usize = 32_000;
/// The crew's name.
const MAX_NAME_CHARS: usize = 120;
/// The crew's and a role's description.
const MAX_DESCRIPTION_CHARS: usize = 2_000;
/// A role label, a stage's custom name, a model id.
const MAX_LABEL_CHARS: usize = 128;
/// A role key in the file: `^[a-z0-9][a-z0-9_-]{0,47}$`.
const MAX_ROLE_KEY_CHARS: usize = 48;
/// At most this many repo crews are listed.
const MAX_REPO_CREWS: usize = 50;
/// What the repo listing shows of a crew's description and of a problem.
const MAX_LISTED_DESCRIPTION_CHARS: usize = 280;
const MAX_LISTED_PROBLEM_CHARS: usize = 240;

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

/// One stage as the review sheet shows it. Every string is display-safe:
/// hidden and control characters are escaped (`\u{202e}`), and the import is
/// blocked when any were there.
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
    /// The CLI a `cli` stage runs (`claude` · `codex`, by
    /// [`crate::orchestrator::cli_runner::dialect_for_model`]); `None` on API.
    /// A CLI stage gets a full shell: its tool list does not apply.
    pub cli_dialect: Option<String>,
    pub checkpoint: bool,
    /// [`crate::orchestrator::stage_read_only`]: false means it can write.
    pub read_only: bool,
    /// The role may commit, push and run release commands.
    pub action_role: bool,
    /// The tools an API stage gets: its allowlist, else the role's defaults.
    /// Empty for a CLI stage (the allowlist only applies on the API path).
    pub tools: Vec<String>,
    pub instructions: Option<String>,
    pub effort: Option<crate::providers::Effort>,
    pub escalate_effort: Option<crate::providers::Effort>,
    /// The earlier stage (0-based position) a review loops back to.
    pub loop_target_position: Option<i64>,
    /// `gated` · `auto`.
    pub loop_mode: Option<String>,
    pub loop_max_iterations: i64,
    pub unpriced_model: bool,
    pub unpriced_escalate: bool,
    /// Worth reading, but not blocking (a tool list on a CLI stage).
    pub warnings: Vec<String>,
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

/// A crew file found in the repo: names and counts only. Its text is read on
/// Fork through [`read_repo_crew`], so the listing stays small.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoCrew {
    pub file: String,
    pub name: String,
    pub description: String,
    pub stage_count: usize,
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
        min_app: CREW_MIN_APP.to_string(),
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

/// `0.4.115` → `[0, 4, 115]`. A pre-release or build suffix is dropped
/// (`0.4.117-beta.2` → `[0, 4, 117]`): a beta of a release already carries
/// that release's features. A leading `v` is allowed, missing parts read as 0
/// and a non-numeric part as 0.
pub fn version_parts(v: &str) -> [u64; 3] {
    let v = v.trim();
    let v = v.strip_prefix('v').unwrap_or(v);
    let core = v.split(['-', '+']).next().unwrap_or("");
    let mut out = [0u64; 3];
    for (slot, part) in out.iter_mut().zip(core.split('.')) {
        *slot = part.parse().unwrap_or(0);
    }
    out
}

/// Parse a crew file's text. Refuses non-crews, oversized text, crews from a
/// newer format or app version, and crews with more stages or roles than
/// [`MAX_CREW_STAGES`] / [`MAX_CREW_ROLES`], with a sentence the user can act
/// on. Pasted text goes through here too.
pub fn parse(text: &str) -> AppResult<CrewFile> {
    if text.len() as u64 > MAX_CREW_BYTES {
        return Err(AppError::Other("That is too large to be a crew (max 512 KB).".into()));
    }
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
    // This build reads format 1 in full, so it counts as at least the
    // format's floor even while its own version is older (a dev build).
    let this_app = version_parts(env!("CARGO_PKG_VERSION")).max(version_parts(CREW_MIN_APP));
    if !crew.min_app.is_empty() && version_parts(&crew.min_app) > this_app {
        return Err(AppError::Other(format!(
            "This crew needs Octopush {} or later. Update the app to import it.",
            visible(&crew.min_app, 40)
        )));
    }
    if crew.pipeline.stages.len() > MAX_CREW_STAGES {
        return Err(AppError::Other(format!(
            "This crew has {} stages; a crew can have at most {MAX_CREW_STAGES}.",
            crew.pipeline.stages.len()
        )));
    }
    if crew.roles.len() > MAX_CREW_ROLES {
        return Err(AppError::Other(format!(
            "This crew carries {} roles; a crew can carry at most {MAX_CREW_ROLES}.",
            crew.roles.len()
        )));
    }
    Ok(crew)
}

/// A stage's validator message as one sentence that names the stage once:
/// `stage 1 has no model` → `Stage 1 has no model`, `unknown tool 'x'` →
/// `Stage 2: unknown tool 'x'`. `save_pipeline`'s own messages are unchanged.
pub fn stage_message(position: usize, msg: &str) -> String {
    let n = position + 1;
    match msg.strip_prefix(&format!("stage {n} ")) {
        Some(rest) => format!("Stage {n} {rest}"),
        None => format!("Stage {n}: {msg}"),
    }
}

// ─── Untrusted text ──────────────────────────────────────────────────────

/// A character that can hide or reorder what the review sheet shows: Unicode
/// tag characters (U+E0000–E007F), bidi embeddings, overrides and isolates
/// (U+202A–202E, U+2066–2069), zero-width characters and marks, word joiners
/// and invisible operators (U+200B–200F, U+2060–2064), the BOM (U+FEFF), and
/// every C0/C1 control (and DEL) except `\n` and `\t`.
pub fn is_hidden_char(c: char) -> bool {
    let u = c as u32;
    (0xE0000..=0xE007F).contains(&u)
        || (0x202A..=0x202E).contains(&u)
        || (0x2066..=0x2069).contains(&u)
        || (0x200B..=0x200F).contains(&u)
        || (0x2060..=0x2064).contains(&u)
        || u == 0xFEFF
        || (c.is_control() && c != '\n' && c != '\t')
}

/// `s` with every hidden character escaped (`\u{202e}`), so it can be shown.
pub fn escape_hidden(s: &str) -> String {
    if !s.chars().any(is_hidden_char) {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if is_hidden_char(c) {
            out.push_str(&format!("\\u{{{:x}}}", c as u32));
        } else {
            out.push(c);
        }
    }
    out
}

/// Display-safe and at most `max` characters (`…` when cut): for echoing a
/// file's text inside a message.
fn visible(s: &str, max: usize) -> String {
    let e = escape_hidden(s);
    if e.chars().count() <= max {
        e
    } else {
        e.chars().take(max).collect::<String>() + "…"
    }
}

/// `what` holds a hidden character, or is longer than `max` characters.
fn text_problem(what: &str, s: &str, max: usize) -> Option<String> {
    if let Some(c) = s.chars().find(|&c| is_hidden_char(c)) {
        return Some(format!("{what} contains a hidden or control character (U+{:04X})", c as u32));
    }
    let n = s.chars().count();
    if n > max {
        return Some(format!("{what} is too long ({n} characters, max {max})"));
    }
    None
}

fn valid_role_key(k: &str) -> bool {
    let b = k.as_bytes();
    !b.is_empty()
        && b.len() <= MAX_ROLE_KEY_CHARS
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-' || *c == b'_')
}

/// Same definition, ignoring the key, the built-in flag (an import is never
/// built-in) and the token estimates (an import's are reset).
fn same_role(a: &RoleDef, b: &RoleDef) -> bool {
    let norm = |r: &RoleDef| {
        let mut r = r.clone();
        r.key = String::new();
        r.is_builtin = false;
        r.token_est_in = 0;
        r.token_est_out = 0;
        serde_json::to_value(r).ok()
    };
    norm(a) == norm(b)
}

fn role_problem(r: &RoleDef) -> Option<String> {
    let key = visible(&r.key, 60);
    if !valid_role_key(&r.key) {
        return Some(format!(
            "role key '{key}' must be 1 to {MAX_ROLE_KEY_CHARS} lowercase letters, digits, '-' or '_', starting with a letter or digit"
        ));
    }
    let fields: [(&str, &str, usize); 4] = [
        ("label", &r.label, MAX_LABEL_CHARS),
        ("description", &r.description, MAX_DESCRIPTION_CHARS),
        ("prompt", &r.prompt_body, MAX_ROLE_PROMPT_CHARS),
        ("substrate", &r.default_substrate, MAX_LABEL_CHARS),
    ];
    for (what, value, max) in fields {
        if let Some(p) = text_problem(&format!("role '{key}' {what}"), value, max) {
            return Some(p);
        }
    }
    for t in &r.default_tools {
        if let Some(p) = text_problem(&format!("role '{key}' tool"), t, MAX_LABEL_CHARS) {
            return Some(p);
        }
    }
    if r.label.trim().is_empty() {
        return Some(format!("role '{key}' has no label"));
    }
    if r.prompt_body.trim().is_empty() {
        return Some(format!("role '{key}' has an empty prompt"));
    }
    if !matches!(r.default_substrate.as_str(), "api" | "cli") {
        return Some(format!("role '{key}' has an unknown substrate '{}'", visible(&r.default_substrate, 40)));
    }
    if let Some(t) = r.default_tools.iter().find(|t| !crate::db::KNOWN_TOOLS.contains(&t.as_str())) {
        return Some(format!("role '{key}' has an unknown tool '{}'", visible(t, 40)));
    }
    None
}

/// The first hidden character or over-long value in a stage's strings, as
/// the validator would word it (`stage N …` is added by [`stage_message`]).
fn stage_text_problem(s: &StageDraft) -> Option<String> {
    let mut fields: Vec<(&str, &str, usize)> = vec![
        ("role", &s.role, MAX_LABEL_CHARS),
        ("model", &s.agent_model, MAX_LABEL_CHARS),
        ("substrate", &s.substrate, MAX_LABEL_CHARS),
    ];
    if let Some(m) = &s.escalate_model {
        fields.push(("escalation model", m, MAX_LABEL_CHARS));
    }
    if let Some(n) = &s.custom_name {
        fields.push(("name", n, MAX_LABEL_CHARS));
    }
    if let Some(i) = &s.instructions {
        // The validator caps the length; only the characters are checked here.
        fields.push(("instructions", i, usize::MAX));
    }
    if let Some(m) = &s.loop_mode {
        fields.push(("loop mode", m, MAX_LABEL_CHARS));
    }
    for t in s.tools.iter().flatten() {
        fields.push(("tool", t, MAX_LABEL_CHARS));
    }
    fields.into_iter().find_map(|(what, value, max)| text_problem(what, value, max))
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
    /// Blocking per-stage problems found before the validator runs (hidden
    /// characters, lengths, a role the file defines but couldn't import).
    stage_problems: Vec<(usize, String)>,
}

fn plan(db: &Db, crew: &CrewFile, model_swaps: &[(String, String)]) -> AppResult<Plan> {
    let mut problems = Vec::new();
    if let Some(p) = text_problem("the crew's name", &crew.pipeline.name, MAX_NAME_CHARS) {
        problems.push(p);
    } else if crew.pipeline.name.trim().is_empty() {
        problems.push("the crew has no name".to_string());
    }
    if let Some(p) = text_problem("the crew's description", &crew.pipeline.description, MAX_DESCRIPTION_CHARS) {
        problems.push(p);
    }
    if crew.pipeline.stages.is_empty() {
        problems.push("the crew has no stages".to_string());
    }
    if crew.pipeline.stages.len() > MAX_CREW_STAGES {
        problems.push(format!("the crew has more than {MAX_CREW_STAGES} stages"));
    }
    if crew.roles.len() > MAX_CREW_ROLES {
        problems.push(format!("the crew carries more than {MAX_CREW_ROLES} roles"));
    }
    // Every key the file defines, valid or not: a stage that names one means
    // the FILE's role, never a local role that happens to share the key.
    let file_keys: HashSet<&str> = crew.roles.iter().map(|r| r.key.as_str()).collect();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut renames: Vec<(String, String)> = Vec::new();
    let mut to_save: Vec<RoleDef> = Vec::new();
    let mut resolved: Vec<RoleDef> = Vec::new();
    let mut role_previews = Vec::new();
    for incoming in &crew.roles {
        if !seen.insert(incoming.key.as_str()) {
            problems.push(format!("role '{}' is listed twice", visible(&incoming.key, 60)));
            continue;
        }
        if let Some(p) = role_problem(incoming) {
            problems.push(p);
            continue;
        }
        let mut role = incoming.clone();
        role.is_builtin = false;
        role.token_est_in = DEFAULT_TOKEN_EST_IN;
        role.token_est_out = DEFAULT_TOKEN_EST_OUT;
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
                Some(local) if !local.is_builtin && !taken_here && same_role(&local, &role) => {
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
    // Stage text and role references, checked on the file's own keys before
    // any rename is applied.
    let mut stage_problems = Vec::new();
    for (i, s) in crew.pipeline.stages.iter().enumerate() {
        let problem = stage_text_problem(s).or_else(|| {
            (file_keys.contains(s.role.as_str()) && !renames.iter().any(|(from, _)| *from == s.role)).then(|| {
                format!("uses role '{}', which this file defines but can't import", visible(&s.role, 60))
            })
        });
        if let Some(p) = problem {
            stage_problems.push((i, stage_message(i, &p)));
        }
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
        stage_problems,
    })
}

/// Everything the review sheet shows. Writes nothing.
pub fn preview(db: &Db, crew: &CrewFile, model_swaps: &[(String, String)]) -> AppResult<CrewPreview> {
    use crate::orchestrator::cli_runner::{dialect_for_model, CliDialect};
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
            // A role the file defines but couldn't import stays unresolved,
            // so a local role sharing its key never stands in for it.
            None if crew.roles.iter().any(|r| r.key == s.role) => None,
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
        let cli = s.substrate == "cli";
        let cli_dialect = cli.then(|| match dialect_for_model(&s.agent_model) {
            CliDialect::Claude => "claude".to_string(),
            CliDialect::Codex => "codex".to_string(),
        });
        let mut warnings = Vec::new();
        if cli && s.tools.is_some() {
            warnings.push(
                "Its tool list only limits API stages. As a CLI stage it gets a full shell instead.".to_string(),
            );
        }
        let tools = if cli {
            Vec::new()
        } else {
            s.tools
                .clone()
                .or_else(|| role.as_ref().map(|r| r.default_tools.clone()))
                .unwrap_or_default()
                .iter()
                .map(|t| escape_hidden(t))
                .collect()
        };
        let problem = plan
            .stage_problems
            .iter()
            .find(|(p, _)| *p == i)
            .map(|(_, m)| m.clone())
            .or_else(|| issues.iter().find(|(p, _)| *p == i).map(|(p, m)| stage_message(*p, m)));
        stages.push(CrewStagePreview {
            position: i,
            label: escape_hidden(&label),
            role: escape_hidden(&s.role),
            agent_model: escape_hidden(&s.agent_model),
            unpriced_model: !priced(&s.agent_model),
            unpriced_escalate: escalate_model.as_deref().map(|m| !priced(m)).unwrap_or(false),
            escalate_model: escalate_model.as_deref().map(escape_hidden),
            substrate: escape_hidden(&s.substrate),
            cli_dialect,
            checkpoint: s.checkpoint,
            read_only: crate::orchestrator::stage_read_only(&s.substrate, &s.agent_model, s.tools.as_deref(), role.as_ref()),
            action_role: role
                .as_ref()
                .map(|r| matches!(r.environment, crate::orchestrator::types::RoleEnvironment::Action))
                .unwrap_or(false),
            tools,
            instructions: s.instructions.as_deref().filter(|t| !t.trim().is_empty()).map(escape_hidden),
            effort: s.effort,
            escalate_effort: s.escalate_effort,
            loop_target_position: s.loop_target_position,
            loop_mode: s.loop_mode.as_deref().map(escape_hidden),
            loop_max_iterations: s.loop_max_iterations,
            warnings,
            problem: problem.map(|m| escape_hidden(&m)),
        });
    }
    let ok = plan.problems.is_empty() && plan.stage_problems.is_empty() && issues.is_empty();
    Ok(CrewPreview {
        name: escape_hidden(&plan.name),
        description: escape_hidden(&plan.description),
        stages,
        roles: plan.role_previews,
        problems: plan.problems.iter().map(|p| escape_hidden(p)).collect(),
        ok,
    })
}

/// Save the crew as a new custom pipeline (and its new roles). Validates the
/// whole crew first, so an invalid file saves nothing. Never starts a run.
/// Returns the new pipeline's id.
pub fn import(db: &Db, crew: &CrewFile, model_swaps: &[(String, String)]) -> AppResult<String> {
    let plan = plan(db, crew, model_swaps)?;
    if let Some(p) = plan.problems.first() {
        return Err(AppError::Other(escape_hidden(p)));
    }
    if let Some((_, p)) = plan.stage_problems.first() {
        return Err(AppError::Other(escape_hidden(p)));
    }
    if let Some((i, msg)) = db.pipeline_stage_issues(&plan.stages, &plan.resolved)?.into_iter().next() {
        return Err(AppError::Other(stage_message(i, &msg)));
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

// ─── Reading files ───────────────────────────────────────────────────────

/// Read a crew file, bounded in size and never blocking. The file is opened
/// with `O_NONBLOCK` (a FIFO can't hang the app) and, unless
/// `follow_symlinks`, `O_NOFOLLOW` (a repo can't point the app at a file
/// outside it); the OPENED handle must be a regular file within
/// [`MAX_CREW_BYTES`], and at most that many bytes (+1, to detect a file that
/// grew) are read before the UTF-8 decode. The file the user picked in the
/// open dialog may be a symlink; a repo's crew may not.
pub fn read_file(path: &Path, follow_symlinks: bool) -> AppResult<String> {
    use std::io::Read;
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut flags = libc::O_NONBLOCK;
        if !follow_symlinks {
            flags |= libc::O_NOFOLLOW;
        }
        opts.custom_flags(flags);
    }
    #[cfg(not(unix))]
    if !follow_symlinks && std::fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(AppError::Other("That is a link, not a crew file.".into()));
    }
    let file = opts.open(path).map_err(|e| {
        #[cfg(unix)]
        if !follow_symlinks && e.raw_os_error() == Some(libc::ELOOP) {
            return AppError::Other("That is a link, not a crew file.".into());
        }
        AppError::from(e)
    })?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(AppError::Other("That isn't a file.".into()));
    }
    let too_large = || AppError::Other("That file is too large to be a crew.".into());
    if meta.len() > MAX_CREW_BYTES {
        return Err(too_large());
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(MAX_CREW_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_CREW_BYTES {
        return Err(too_large());
    }
    String::from_utf8(bytes).map_err(|_| AppError::Other("That file isn't UTF-8 text, so it can't be a crew.".into()))
}

/// `<worktree>/.octopush/crews`, when both folders are real directories
/// (not symlinks).
fn repo_crews_dir(worktree: &Path) -> Option<std::path::PathBuf> {
    let dir = worktree.join(REPO_CREWS_DIR);
    let real_dir = |p: &Path| std::fs::symlink_metadata(p).map(|m| m.is_dir()).unwrap_or(false);
    (dir.parent().is_some_and(real_dir) && real_dir(&dir)).then_some(dir)
}

/// A plain `*.octocrew.json` name inside the crews folder: no separators, no
/// leading dot, no hidden characters.
fn plain_crew_file_name(name: &str) -> bool {
    name.ends_with(CREW_SUFFIX)
        && name.len() > CREW_SUFFIX.len()
        && name.chars().count() <= 200
        && !name.starts_with('.')
        && !name.contains(['/', '\\'])
        && !name.chars().any(is_hidden_char)
}

/// The text of one repo crew, for Fork: `file` must be a name
/// [`scan_repo`] lists; read without following symlinks.
pub fn read_repo_crew(worktree: &Path, file: &str) -> AppResult<String> {
    if !plain_crew_file_name(file) {
        return Err(AppError::Other("That isn't a crew file in this repo.".into()));
    }
    let dir = repo_crews_dir(worktree).ok_or_else(|| AppError::Other("This repo has no crews folder.".into()))?;
    read_file(&dir.join(file), false)
}

/// The crews committed under `<worktree>/.octopush/crews/*.octocrew.json`,
/// sorted by file name and re-read on every call, so an edit on disk shows the
/// next time the launcher opens. Symlinks are skipped — the files and the
/// `.octopush` / `.octopush/crews` folders alike (a repo must not point the
/// app at files outside it); an unreadable or invalid file is listed with its
/// problem rather than hidden. Only names and counts are returned, each
/// bounded; [`read_repo_crew`] reads a crew's text on Fork.
pub fn scan_repo(worktree: &Path) -> Vec<RepoCrew> {
    let Some(dir) = repo_crews_dir(worktree) else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut files: Vec<(String, std::path::PathBuf)> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            plain_crew_file_name(&name).then(|| (name, e.path()))
        })
        .collect();
    files.sort();
    files.truncate(MAX_REPO_CREWS);
    files
        .into_iter()
        .map(|(file, path)| {
            let fallback = file.trim_end_matches(CREW_SUFFIX).to_string();
            let listed = read_file(&path, false)
                .and_then(|t| parse(&t))
                .map_err(|e| e.to_string().trim_start_matches("other: ").to_string())
                .and_then(|crew| {
                    match text_problem("The crew's name", &crew.pipeline.name, MAX_NAME_CHARS)
                        .or_else(|| text_problem("The crew's description", &crew.pipeline.description, MAX_DESCRIPTION_CHARS))
                    {
                        Some(p) => Err(p),
                        None => Ok(crew),
                    }
                });
            match listed {
                Ok(crew) => RepoCrew {
                    file,
                    name: crew.pipeline.name,
                    description: visible(&crew.pipeline.description, MAX_LISTED_DESCRIPTION_CHARS),
                    stage_count: crew.pipeline.stages.len(),
                    problem: None,
                },
                Err(problem) => RepoCrew {
                    file,
                    name: fallback,
                    description: String::new(),
                    stage_count: 0,
                    problem: Some(visible(&problem, MAX_LISTED_PROBLEM_CHARS)),
                },
            }
        })
        .collect()
}
