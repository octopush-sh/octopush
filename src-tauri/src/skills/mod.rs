//! Skills — Claude-Code-compatible `SKILL.md` files that specialize a chat
//! turn with a focused system prompt (and optionally a restricted tool set).
//!
//! A skill is a directory `<name>/SKILL.md` with YAML-ish frontmatter:
//!
//! ```text
//! ---
//! name: write-tests
//! description: Write thorough unit tests for the changed code.
//! allowed-tools: read_file, write_file, run_command
//! ---
//! You are a meticulous test engineer. …(body instructions)…
//! ```
//!
//! Skills are discovered from two roots, project shadowing user on name clash:
//!   - `<worktree>/.claude/skills/*/SKILL.md`  (project)
//!   - `~/.claude/skills/*/SKILL.md`           (user)
//!
//! A project's files are the repository's, so they are read the way its
//! `CLAUDE.md` is ([`definition_roots`], [`read_definition`]): only when they
//! resolve inside the project's work tree, and bounded. The user's own files
//! are trusted.
//!
//! The frontmatter is parsed by hand (the three fields we use are simple
//! `key: value` lines) so we don't pull in a YAML dependency.

pub mod agents;
pub mod builtin_agents;

use crate::request_context::{nearest_work_tree, read_memory_file, MemorySkip};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Lightweight skill descriptor for the picker (no body — keep the payload small).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SkillMeta {
    pub name: String,
    pub description: String,
    /// "project" or "user" — where the SKILL.md was found.
    pub source: String,
}

/// A fully-parsed skill, including its instruction body.
#[derive(Clone, Debug)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub body: String,
    /// When present, the chat turn is restricted to these tool names.
    pub allowed_tools: Option<Vec<String>>,
    pub source: String,
}

impl Skill {
    pub fn meta(&self) -> SkillMeta {
        SkillMeta {
            name: self.name.clone(),
            description: self.description.clone(),
            source: self.source.clone(),
        }
    }
}

/// A skill or agent file that was found but never read, and why.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkippedDefinition {
    /// What the user knows it by: the skill's directory, or the agent
    /// file's name without `.md`.
    pub name: String,
    /// Where it was found: `.claude/skills/<name>/SKILL.md` in the project,
    /// `~/.claude/…` for the user's.
    pub label: String,
    /// The full path where it was found (not where it resolves).
    pub path: String,
    /// `outside the project` or `over 4 MiB` ([`MemorySkip::as_str`]).
    pub reason: String,
}

/// What a scan of the definition roots found: the definitions read, and
/// the entries left unread.
#[derive(Clone, Debug)]
pub struct DefinitionScan<T> {
    pub found: Vec<T>,
    pub skipped: Vec<SkippedDefinition>,
}

impl<T> Default for DefinitionScan<T> {
    fn default() -> Self {
        Self { found: Vec::new(), skipped: Vec::new() }
    }
}

impl<T> DefinitionScan<T> {
    /// Note `path` (found under `root` as `rel`) as left unread.
    fn skip(&mut self, root: &DefinitionRoot, name: &str, rel: &str, path: &Path, why: MemorySkip) {
        self.skipped.push(SkippedDefinition {
            name: name.to_string(),
            label: format!("{}/{rel}", root.shown),
            path: path.display().to_string(),
            reason: why.as_str().to_string(),
        });
    }
}

/// One directory a scan reads definitions from.
pub(crate) struct DefinitionRoot {
    pub dir: PathBuf,
    /// "project" or "user".
    pub source: &'static str,
    /// How `dir` is written in a skipped entry's label.
    pub shown: String,
    /// Where its files must resolve: the work tree confining a project's
    /// files; `None` for the user's own directory, which is trusted.
    pub limit: Option<PathBuf>,
}

/// The roots of `.claude/<kind>` (`skills` or `agents`), project first (it
/// shadows the user's). The project's files are the repository's: each is
/// read only when it resolves, symlinks included, inside the nearest git
/// work tree around the worktree (`request_context::nearest_work_tree`, the
/// same reach its `.claude/CLAUDE.md` has), so a link to a file elsewhere
/// on the Mac, or into an outer repository, is never read. The user's
/// `~/.claude/<kind>` is trusted. A project whose `.claude/<kind>` resolves
/// to that very directory (home opened as a project, or a `.claude` linked
/// to `~/.claude`) has no root of its own: those files are the user's, and
/// are read, labelled and sourced as the user's.
pub(crate) fn definition_roots(worktree: &Path, home: Option<&Path>, kind: &str) -> Vec<DefinitionRoot> {
    let user = home.map(|h| h.join(".claude").join(kind));
    let user_real = user.as_deref().and_then(|u| std::fs::canonicalize(u).ok());
    let mut roots = Vec::new();
    // Resolved first: containment compares resolved paths.
    if let Ok(project) = std::fs::canonicalize(worktree) {
        let dir = project.join(".claude").join(kind);
        let users = user_real.is_some() && std::fs::canonicalize(&dir).ok() == user_real;
        if !users {
            roots.push(DefinitionRoot {
                limit: Some(nearest_work_tree(&project, &project)),
                dir,
                source: "project",
                shown: format!(".claude/{kind}"),
            });
        }
    }
    if let Some(dir) = user {
        roots.push(DefinitionRoot { dir, source: "user", shown: format!("~/.claude/{kind}"), limit: None });
    }
    roots
}

/// Read one definition file the way every project file is read
/// (`request_context::read_memory_file`): resolved, symlinks included, and
/// refused when it leaves `limit`; opened non-blocking, a regular file, at
/// most 4 MiB. `Ok(None)` when there is no regular file there, or it isn't
/// UTF-8 (as before: such a file is not a definition).
pub(crate) fn read_definition(path: &Path, limit: Option<&Path>) -> Result<Option<String>, MemorySkip> {
    Ok(read_memory_file(path, limit)?.and_then(|(_, raw)| String::from_utf8(raw).ok()))
}

/// Log each skipped definition once per path and reason: the readers rescan
/// on every turn, and agents have no list in the UI to show it in.
pub(crate) fn log_skipped(kind: &str, skipped: &[SkippedDefinition]) {
    static LOGGED: OnceLock<Mutex<HashSet<(String, String)>>> = OnceLock::new();
    // What one run remembers; past it, nothing more is logged.
    const MAX_LOGGED: usize = 1024;
    let mut logged = LOGGED.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    for s in skipped {
        if logged.len() < MAX_LOGGED && logged.insert((s.path.clone(), s.reason.clone())) {
            tracing::warn!(path = %s.path, "{kind} {} skipped: {}", s.name, s.reason);
        }
    }
}

/// Split a Claude-Code-style markdown file into its frontmatter pairs and
/// body. Frontmatter is a leading `---` … `---` block delimited by lines that
/// are exactly `---`. Parsing line-by-line (rather than substring-searching
/// for `\n---`) means a `---` horizontal rule or a leading `-` list item in
/// the BODY is never mistaken for the fence or stripped. Keys are lowercased;
/// values are trimmed and unquoted. `None` when the fence is missing or
/// unclosed. Shared by SKILL.md and `.claude/agents/*.md`.
pub(crate) fn split_frontmatter(content: &str) -> Option<(Vec<(String, String)>, String)> {
    let text = content.replace("\r\n", "\n");
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None; // must open with a `---` fence line
    }
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut body_lines: Vec<&str> = Vec::new();
    let mut closed = false;
    for line in lines {
        if !closed {
            if line.trim() == "---" {
                closed = true;
            } else if let Some((key, value)) = line.split_once(':') {
                pairs.push((
                    key.trim().to_ascii_lowercase(),
                    value.trim().trim_matches(['"', '\'']).to_string(),
                ));
            }
        } else {
            body_lines.push(line);
        }
    }
    if !closed {
        return None; // no closing fence — malformed
    }
    Some((pairs, body_lines.join("\n").trim().to_string()))
}

/// A comma-separated (optionally bracketed) frontmatter list → items.
pub(crate) fn split_list(value: &str) -> Vec<String> {
    value
        .trim_matches(['[', ']'])
        .split(',')
        .map(|s| s.trim().trim_matches(['"', '\'']).to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Parse a SKILL.md's text into a Skill. Returns None when there's no usable
/// frontmatter `name`. `source` labels the origin ("project"/"user").
pub fn parse_skill(content: &str, source: &str) -> Option<Skill> {
    let (pairs, body) = split_frontmatter(content)?;
    let mut name = String::new();
    let mut description = String::new();
    let mut allowed_tools: Option<Vec<String>> = None;
    for (key, value) in pairs {
        match key.as_str() {
            "name" => name = value,
            "description" => description = value,
            "allowed-tools" | "allowed_tools" | "tools" => {
                let list = split_list(&value);
                if !list.is_empty() {
                    allowed_tools = Some(list);
                }
            }
            _ => {}
        }
    }

    if name.is_empty() {
        return None;
    }
    Some(Skill {
        name,
        description,
        body,
        allowed_tools,
        source: source.to_string(),
    })
}

/// Discover all skills for a worktree (project ∪ user), project shadowing
/// user. Skipped entries go to the log ([`log_skipped`]).
pub fn scan_skills(worktree: &Path) -> Vec<Skill> {
    let scan = scan_skills_in(worktree, dirs::home_dir().as_deref());
    log_skipped("skill", &scan.skipped);
    scan.found
}

/// [`scan_skills`] with the user's home given, and the entries left unread:
/// a project skill whose `SKILL.md` resolves outside the project, or one
/// over 4 MiB ([`definition_roots`], [`read_definition`]). A skill directory
/// may be a link: where its `SKILL.md` resolves decides. Entries are read in
/// name order, so which of two same-named skills in one root wins is stable.
pub fn scan_skills_in(worktree: &Path, home: Option<&Path>) -> DefinitionScan<Skill> {
    let mut scan: DefinitionScan<Skill> = DefinitionScan::default();
    for root in definition_roots(worktree, home, "skills") {
        let Ok(entries) = std::fs::read_dir(&root.dir) else { continue };
        let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        for dir in dirs {
            let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let md = dir.join("SKILL.md");
            let content = match read_definition(&md, root.limit.as_deref()) {
                Ok(Some(content)) => content,
                Ok(None) => continue,
                Err(why) => {
                    scan.skip(&root, &name, &format!("{name}/SKILL.md"), &md, why);
                    continue;
                }
            };
            if let Some(skill) = parse_skill(&content, root.source) {
                // Project shadows user: skip a user skill whose name a project
                // skill already claimed.
                if scan.found.iter().any(|s| s.name == skill.name) {
                    continue;
                }
                scan.found.push(skill);
            }
        }
    }
    scan.found.sort_by(|a, b| a.name.cmp(&b.name));
    scan
}

/// Load a single skill by name for a worktree (project shadowing user).
pub fn load_skill(worktree: &Path, name: &str) -> Option<Skill> {
    scan_skills(worktree).into_iter().find(|s| s.name == name)
}

/// The skills a piece of prose names with a `/slug` token, in the order they
/// first appear, deduped.
///
/// Both TALK and DIRECT resolve skills this way: a reference is text, kept
/// with the message or brief it was written in, and resolved when the turn
/// or stage actually runs. That is also what makes it robust: a hand-typed
/// `/code-review` works exactly like one inserted from the picker, and a
/// message carries exactly the skills it names — nothing is pinned.
///
/// Matching is against the worktree's KNOWN skills only, so ordinary prose
/// (a path like `src/lib`, a date, `and/or`) can never be mistaken for a
/// reference. The token must also stand alone — `/code-review` matches,
/// `/code-review-notes` and `x/code-review` do not — and fenced code is
/// never searched (an `@file` expansion pastes the file as a fenced block;
/// a CHANGELOG line saying "run /release" must not invoke the skill).
///
/// The order is the text's, not the catalogue's: it is the order the skills
/// share the per-turn budget in ([`skill_prompt_section`]).
pub fn referenced_skills(worktree: &Path, text: &str) -> Vec<Skill> {
    named_in(scan_skills(worktree), text)
}

/// [`referenced_skills`] with the user's home given.
pub fn referenced_skills_in(worktree: &Path, home: Option<&Path>, text: &str) -> Vec<Skill> {
    named_in(scan_skills_in(worktree, home).found, text)
}

/// The `known` skills `text` names, by first mention, deduped by name.
fn named_in(known: Vec<Skill>, text: &str) -> Vec<Skill> {
    let prose = outside_fences(text);
    let mut found: Vec<(usize, Skill)> = Vec::new();
    for skill in known {
        if found.iter().any(|(_, s)| s.name == skill.name) {
            continue;
        }
        if let Some(at) = first_mention(&prose, &skill.name) {
            found.push((at, skill));
        }
    }
    found.sort_by_key(|(at, _)| *at);
    found.into_iter().map(|(_, s)| s).collect()
}

/// The text with every fenced code block (``` … ```, fence lines included)
/// removed; an unclosed fence runs to the end. As in Markdown, a fence closes
/// only on a bare line of at least as many backticks as opened it, so a
/// ```` fence (what Talk writes around content holding ```) holds ``` lines.
/// Mirrors `fencedRanges` in `src/lib/skillMentions.ts`, so the composer
/// highlights exactly what the backend will invoke.
fn outside_fences(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut fence: Option<usize> = None;
    for line in text.split_inclusive('\n') {
        let t = line.trim_start_matches([' ', '\t']);
        let run = t.bytes().take_while(|&b| b == b'`').count();
        match fence {
            None if run >= 3 => fence = Some(run),
            None => out.push_str(line),
            Some(open) if run >= open && t[run..].trim().is_empty() => fence = None,
            Some(_) => {}
        }
    }
    out
}

/// Where `text` first carries a standalone `/name` token (the slash's byte
/// offset), if it does.
///
/// Boundaries are compared as CHARS, not bytes: a byte-level test treats every
/// UTF-8 continuation byte as "not alphanumeric", so `docs/café/code-review.md`
/// and `🚀/code-review` would count as references and silently append a whole
/// skill body to every stage's prompt.
fn first_mention(text: &str, name: &str) -> Option<usize> {
    fn is_word_char(c: char) -> bool {
        c.is_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '/'
    }
    let needle = format!("/{name}");
    let mut from = 0usize;
    while let Some(rel) = text[from..].find(&needle) {
        let start = from + rel;
        let end = start + needle.len();
        // The slash must not be glued to a preceding word (a path segment)…
        let before_ok = text[..start].chars().next_back().is_none_or(|c| !is_word_char(c));
        // …and the name must end the token — a sentence-ending period does
        // not continue it (`/release.` invokes; `/release.md` does not).
        let mut rest = text[end..].chars();
        let after_ok = match rest.next() {
            None => true,
            Some('.') => rest.next().is_none_or(|c| !is_word_char(c)),
            Some(c) => !is_word_char(c),
        };
        if before_ok && after_ok {
            return Some(start);
        }
        from = end;
    }
    None
}

/// The most bytes of skill bodies the skills a message or brief *names*
/// carry in one Talk turn or Direct stage: they share it, in the order
/// named. About 25k tokens, so ordinary skills always go whole, while a
/// runaway file (each may be up to 4 MiB) can't fill the prompt or the
/// bill. A skill the request pins is outside it ([`skill_prompt_section_with`]).
pub const SKILLS_CAP_BYTES: usize = 100_000;

/// With less than this left, a skill is left out rather than trimmed.
const MIN_TRIMMED_SKILL_BYTES: usize = 1_000;

/// The section appended to a system prompt for each skill a message or brief
/// named — the one shape TALK and DIRECT share, so an agent meets the
/// instructions in the same form on both substrates. The bodies share
/// [`SKILLS_CAP_BYTES`] in the order given (the order named,
/// [`referenced_skills`]): a skill that fits what is left goes whole, a
/// larger one is trimmed to it (beginning and end kept), or left out when
/// under 1,000 bytes are left; either way the section says so, and so does
/// the log.
pub fn skill_prompt_section(skills: &[Skill]) -> String {
    skill_prompt_section_with(None, skills)
}

/// [`skill_prompt_section`] with the skill the request pins (Talk's
/// `ChatRequest.skill`): it comes first and is sent whole, bounded only by
/// the 4 MiB a skill file may be, and it doesn't draw on the budget the
/// `named` skills share after it. A named skill of the same name is the
/// pinned one, not sent twice.
pub fn skill_prompt_section_with(pinned: Option<&Skill>, named: &[Skill]) -> String {
    let mut out = String::new();
    if let Some(skill) = pinned {
        out.push_str(&format!("\n\n# Skill: {}\n{}", skill.name, skill.body));
    }
    let mut left = SKILLS_CAP_BYTES;
    for skill in named {
        if pinned.is_some_and(|p| p.name == skill.name) {
            continue;
        }
        let body = if skill.body.len() <= left {
            skill.body.clone()
        } else if left < MIN_TRIMMED_SKILL_BYTES {
            tracing::warn!(skill = %skill.name, "skill left out: the invoked skills pass {SKILLS_CAP_BYTES} bytes");
            format!(
                "[Left out: the skills invoked here pass the {SKILLS_CAP_BYTES}-byte limit per turn. Ask the user to \
                 invoke fewer skills at once if you need this one.]"
            )
        } else {
            tracing::warn!(skill = %skill.name, "skill trimmed: the invoked skills pass {SKILLS_CAP_BYTES} bytes");
            format!(
                "[Trimmed: the skills invoked here pass the {SKILLS_CAP_BYTES}-byte limit per turn; the beginning \
                 and end of this one are kept.]\n{}",
                crate::orchestrator::runner::cap_to(&skill.body, left)
            )
        };
        left = left.saturating_sub(body.len());
        out.push_str(&format!("\n\n# Skill: {}\n{}", skill.name, body));
    }
    out
}

/// The tool the model loads a skill with on its own (#1135), the way a
/// `/name` mention loads one for the user.
pub const SKILL_TOOL_NAME: &str = "Skill";

/// How many skills the system prompt lists by name and description; the
/// rest are counted, and `Skill` still loads them by name.
pub const SKILL_LIST_MAX: usize = 50;

/// The longest description a listed skill carries, in chars.
const SKILL_DESCRIPTION_MAX: usize = 300;

/// The `Skill` tool. Its bytes never change (the skills are listed in the
/// system prompt instead), so the tool list, where the provider's prompt
/// cache starts, holds from one turn to the next.
pub fn skill_tool_definition() -> crate::providers::LlmTool {
    crate::providers::LlmTool {
        name: SKILL_TOOL_NAME.to_string(),
        description: "Load one of the skills listed under \"# Skills\" in your instructions: returns its \
             instructions, which you then follow. Load a skill when the task matches its description, \
             before you start the work it covers. A skill that names its tools allows only those \
             workspace tools for the rest of this turn."
            .to_string(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "The skill's name, exactly as listed"
                }
            },
            "required": ["name"]
        }),
    }
}

/// `text` on one line, at most `max` chars (an ellipsis marks a cut).
fn one_line(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let mut cut: String = flat.chars().take(max.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

/// The section of a system prompt that lists the skills the model may load
/// with `Skill`: name and description, sorted by name, the first
/// [`SKILL_LIST_MAX`], then how many more. The skills `invoked` names (by a
/// `/name` mention, already in the prompt) aren't offered again. A pure
/// function of the skill files, so the cached system block holds until one
/// changes. Empty when there is nothing to offer.
pub fn skill_list_section(skills: &[Skill], invoked: &[&str]) -> String {
    let mut offered: Vec<&Skill> = skills.iter().filter(|s| !invoked.contains(&s.name.as_str())).collect();
    if offered.is_empty() {
        return String::new();
    }
    offered.sort_by(|a, b| a.name.cmp(&b.name));
    let mut out = String::from(
        "\n\n# Skills\nWhen the task matches one of these skills, call the Skill tool with its name to load \
         its instructions first:",
    );
    for s in offered.iter().take(SKILL_LIST_MAX) {
        let description = one_line(&s.description, SKILL_DESCRIPTION_MAX);
        if description.is_empty() {
            out.push_str(&format!("\n- {}", s.name));
        } else {
            out.push_str(&format!("\n- {}: {}", s.name, description));
        }
    }
    if offered.len() > SKILL_LIST_MAX {
        out.push_str(&format!(
            "\n- and {} more, not listed here; Skill loads any of them by name.",
            offered.len() - SKILL_LIST_MAX
        ));
    }
    out
}

/// One skill the model loaded with `Skill` in this turn.
#[derive(Clone, Debug)]
struct LoadedSkill {
    name: String,
    allowed_tools: Option<Vec<String>>,
}

/// The skills the model loaded with `Skill` in one turn (or one sub-agent
/// run), and what their `allowed-tools` let it run. Checked when each call
/// runs rather than by narrowing the tool list, so the tools the provider
/// caches stay byte for byte the same through the turn.
#[derive(Clone, Debug, Default)]
pub struct SkillScope {
    loaded: Vec<LoadedSkill>,
}

impl SkillScope {
    pub fn is_loaded(&self, name: &str) -> bool {
        self.loaded.iter().any(|s| s.name == name)
    }

    pub fn add(&mut self, skill: &Skill) {
        if !self.is_loaded(&skill.name) {
            self.loaded.push(LoadedSkill { name: skill.name.clone(), allowed_tools: skill.allowed_tools.clone() });
        }
    }

    /// Why a call to `tool` is refused, or `None` to run it. Only the
    /// workspace tools (`restrictable`) are limited, as a `/name` mention
    /// limits them; MCP, sub-agent, recall and Skill calls always run. The
    /// grant is the union of the loaded skills' `allowed-tools`, and a loaded
    /// skill that names none leaves every tool open. A grant that names no
    /// workspace tool at all (a typo, another tool's names) limits nothing,
    /// the way the mention path keeps the full set then.
    pub fn refusal(&self, tool: &str, restrictable: &[String]) -> Option<String> {
        if !restrictable.iter().any(|t| t == tool) {
            return None;
        }
        if self.loaded.is_empty() || self.loaded.iter().any(|s| s.allowed_tools.is_none()) {
            return None;
        }
        let granted: Vec<&String> = self.loaded.iter().flat_map(|s| s.allowed_tools.iter().flatten()).collect();
        let usable: Vec<&String> = restrictable.iter().filter(|t| granted.contains(t)).collect();
        if usable.is_empty() || usable.iter().any(|t| *t == tool) {
            return None;
        }
        let names = self.loaded.iter().map(|s| format!("`{}`", s.name)).collect::<Vec<_>>().join(", ");
        let (skills, allow) = if self.loaded.len() == 1 { ("skill", "allows") } else { ("skills", "allow") };
        let usable = usable.iter().map(|t| format!("`{t}`")).collect::<Vec<_>>().join(", ");
        Some(format!(
            "`{tool}` was not run: the {skills} {names} you loaded this turn {allow} only {usable} among the \
             workspace tools. Use one of those, or finish without it."
        ))
    }
}

/// Run one `Skill` call against `catalogue` (the worktree's skills): the
/// skill's instructions, and `ok`. `invoked` are the skills a `/name`
/// mention already put in the prompt. A loaded skill joins `scope`, so its
/// `allowed-tools` apply to the calls after it ([`SkillScope::refusal`]).
/// An unknown or missing name is an error result naming what exists.
pub fn run_skill_tool(
    catalogue: &[Skill],
    invoked: &[&str],
    scope: &mut SkillScope,
    input: &serde_json::Value,
) -> (String, bool) {
    let asked = input
        .get("name")
        .or_else(|| input.get("skill"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().trim_start_matches('/'))
        .unwrap_or("");
    if asked.is_empty() {
        return ("Skill needs a `name`: one of the skills listed under \"# Skills\".".to_string(), false);
    }
    if invoked.contains(&asked) {
        return (
            format!("The skill `{asked}` is already loaded: the user named it, and its instructions are in your system prompt."),
            true,
        );
    }
    let Some(skill) = catalogue.iter().find(|s| s.name == asked) else {
        let known: Vec<String> = catalogue.iter().take(SKILL_LIST_MAX).map(|s| format!("`{}`", s.name)).collect();
        let hint = if known.is_empty() {
            "This workspace has no skills.".to_string()
        } else {
            format!("The skills here: {}.", known.join(", "))
        };
        return (format!("No skill named `{asked}`. {hint}"), false);
    };
    if scope.is_loaded(&skill.name) {
        return (format!("The skill `{}` is already loaded: its instructions are earlier in this turn.", skill.name), true);
    }
    scope.add(skill);
    (skill_tool_result(skill), true)
}

/// What a loaded skill returns: its name, the tools it allows (when it
/// names them) and its body, bounded like the skills a message names.
fn skill_tool_result(skill: &Skill) -> String {
    let mut out = format!("# Skill: {}\n", skill.name);
    if let Some(tools) = &skill.allowed_tools {
        out.push_str(&format!("[For the rest of this turn, this skill allows these tools: {}.]\n", tools.join(", ")));
    }
    if skill.body.len() <= SKILLS_CAP_BYTES {
        out.push_str(&skill.body);
    } else {
        tracing::warn!(skill = %skill.name, "skill trimmed: its body passes {SKILLS_CAP_BYTES} bytes");
        out.push_str(&format!(
            "[Trimmed: this skill passes the {SKILLS_CAP_BYTES}-byte limit; its beginning and end are kept.]\n{}",
            crate::orchestrator::runner::cap_to(&skill.body, SKILLS_CAP_BYTES)
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::fs;

    /// Writes a project skill into `<root>/.claude/skills/<name>/SKILL.md`.
    fn write_skill(root: &Path, name: &str, body: &str) {
        let dir = root.join(".claude/skills").join(name);
        fs::create_dir_all(&dir).expect("mkdir skill");
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: d\n---\n{body}"),
        )
        .expect("write skill");
    }

    #[test]
    fn brief_reference_resolves_to_the_skill_body() {
        let tmp = tempfile::tempdir().expect("tmp");
        write_skill(tmp.path(), "code-review", "Review like a hawk.");
        let found = referenced_skills(tmp.path(), "Ship the parser, then /code-review it.");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "code-review");
        assert!(found[0].body.contains("Review like a hawk."));
    }

    #[test]
    fn unknown_slash_tokens_and_paths_are_not_references() {
        let tmp = tempfile::tempdir().expect("tmp");
        write_skill(tmp.path(), "code-review", "b");
        // A path segment, a longer slug, and a skill that does not exist.
        for brief in [
            "look at src/code-review.ts",
            "run the /code-review-notes checklist",
            "use the /security-review skill",
            "and/or something",
        ] {
            assert!(
                referenced_skills(tmp.path(), brief).is_empty(),
                "false positive for: {brief}"
            );
        }
    }

    #[test]
    fn non_ascii_neighbours_do_not_make_a_reference() {
        let tmp = tempfile::tempdir().expect("tmp");
        write_skill(tmp.path(), "code-review", "b");
        // A byte-level boundary test treats UTF-8 continuation bytes as
        // non-word characters, so these used to count as references.
        for brief in ["see docs/café/code-review.md", "ñ/code-review"] {
            assert!(
                referenced_skills(tmp.path(), brief).is_empty(),
                "false positive for: {brief}"
            );
        }
        // A non-word neighbour IS a boundary, whatever its byte width: an emoji
        // or a comma before the slash leaves a genuine reference standing.
        assert_eq!(referenced_skills(tmp.path(), "🚀 /code-review").len(), 1);
        // Glued, too — the policy is "not a word char" and an emoji is not one.
        assert_eq!(referenced_skills(tmp.path(), "🚀/code-review").len(), 1);
        assert_eq!(referenced_skills(tmp.path(), "café, then /code-review").len(), 1);
    }

    #[test]
    fn a_sentence_ending_period_closes_the_token_but_an_extension_does_not() {
        let tmp = tempfile::tempdir().expect("tmp");
        write_skill(tmp.path(), "release", "b");
        for text in ["then /release.", "then /release.\nnext line", "(/release), /release? /release,"] {
            assert_eq!(referenced_skills(tmp.path(), text).len(), 1, "should invoke: {text}");
        }
        for text in ["open /release.md", "see /release..notes", "/release.v2"] {
            assert!(referenced_skills(tmp.path(), text).is_empty(), "false positive for: {text}");
        }
    }

    #[test]
    fn fenced_code_is_content_not_an_invocation() {
        let tmp = tempfile::tempdir().expect("tmp");
        write_skill(tmp.path(), "release", "b");
        // An `@file` expansion: the prose names nothing, the file does.
        let pasted = "summarise this\n\nCHANGELOG.md\n```\nrun /release before tagging\n```";
        assert!(referenced_skills(tmp.path(), pasted).is_empty());
        // The same token in the prose still invokes.
        let both = "/release this\n\n```\nrun /release before tagging\n```";
        assert_eq!(referenced_skills(tmp.path(), both).len(), 1);
        // An unclosed fence runs to the end.
        assert!(referenced_skills(tmp.path(), "```\n/release").is_empty());
        assert_eq!(outside_fences("a\n```\nb\n```\nc"), "a\nc");
        // A longer fence holds a ``` line of its own content (#1046).
        let nested = "see\n\nREADME.md\n````\n```\n/release\n```\n````\nok";
        assert_eq!(outside_fences(nested), "see\n\nREADME.md\nok");
        assert!(referenced_skills(tmp.path(), nested).is_empty());
    }

    #[test]
    fn a_skill_named_twice_is_carried_once() {
        let tmp = tempfile::tempdir().expect("tmp");
        write_skill(tmp.path(), "simplify", "b");
        let found = referenced_skills(tmp.path(), "/simplify now, then /simplify again");
        assert_eq!(found.len(), 1);
    }

    #[test]
    fn skill_section_is_the_shape_both_substrates_use() {
        let tmp = tempfile::tempdir().expect("tmp");
        write_skill(tmp.path(), "code-review", "Review like a hawk.");
        let section = skill_prompt_section(&referenced_skills(tmp.path(), "/code-review"));
        assert!(section.contains("# Skill: code-review"));
        assert!(section.contains("Review like a hawk."));
    }

    #[test]
    fn no_reference_appends_nothing() {
        assert_eq!(skill_prompt_section(&[]), "");
    }

    #[test]
    fn parses_frontmatter_and_body() {
        let md = "---\nname: write-tests\ndescription: Write tests.\nallowed-tools: read_file, write_file\n---\nYou are a test engineer.\nBe thorough.";
        let s = parse_skill(md, "project").expect("should parse");
        assert_eq!(s.name, "write-tests");
        assert_eq!(s.description, "Write tests.");
        assert_eq!(s.allowed_tools.as_deref(), Some(&["read_file".to_string(), "write_file".to_string()][..]));
        assert!(s.body.starts_with("You are a test engineer."));
        assert!(s.body.contains("Be thorough."));
    }

    #[test]
    fn body_leading_dash_and_hr_are_preserved() {
        // A body that starts with a markdown list must keep its first bullet,
        // and a `---` horizontal rule inside the body must not be eaten.
        let md = "---\nname: s\ndescription: d\n---\n- step one\n- step two\n\n---\n\ntail";
        let s = parse_skill(md, "project").unwrap();
        assert_eq!(s.body, "- step one\n- step two\n\n---\n\ntail");
    }

    #[test]
    fn missing_closing_fence_is_rejected() {
        // Without a closing fence we must not swallow body into frontmatter.
        assert!(parse_skill("---\nname: s\ndescription: d\nbody with no fence", "user").is_none());
    }

    #[test]
    fn no_name_is_rejected() {
        assert!(parse_skill("---\ndescription: x\n---\nbody", "user").is_none());
        assert!(parse_skill("no frontmatter here", "user").is_none());
    }

    fn skill(name: &str, description: &str, allowed: Option<&[&str]>) -> Skill {
        Skill {
            name: name.to_string(),
            description: description.to_string(),
            body: format!("Body of {name}."),
            allowed_tools: allowed.map(|a| a.iter().map(|t| t.to_string()).collect()),
            source: "project".to_string(),
        }
    }

    fn workspace_tools() -> Vec<String> {
        ["run_command", "read_file", "write_file", "edit_file", "list_files", "grep", "glob"]
            .iter()
            .map(|t| t.to_string())
            .collect()
    }

    #[test]
    fn the_skill_list_is_sorted_bounded_and_stable() {
        let mut many: Vec<Skill> = (0..60).rev().map(|i| skill(&format!("s{i:02}"), "Does a thing.", None)).collect();
        many.push(skill("long", &"word ".repeat(200), None));
        let section = skill_list_section(&many, &[]);
        assert!(section.starts_with("\n\n# Skills\n"));
        let listed: Vec<&str> = section.lines().filter(|l| l.starts_with("- ")).collect();
        // 50 skills, then the count of the rest.
        assert_eq!(listed.len(), SKILL_LIST_MAX + 1);
        assert_eq!(listed[0], "- long: ".to_string() + &one_line(&"word ".repeat(200), SKILL_DESCRIPTION_MAX));
        assert!(listed[0].chars().count() < SKILL_DESCRIPTION_MAX + 10, "a description is bounded");
        assert_eq!(listed[1], "- s00: Does a thing.");
        assert_eq!(listed[SKILL_LIST_MAX], "- and 11 more, not listed here; Skill loads any of them by name.");
        // The order the files were read in doesn't matter: same skills, same bytes.
        let mut shuffled = many.clone();
        shuffled.reverse();
        assert_eq!(skill_list_section(&shuffled, &[]), section);
        assert_eq!(skill_list_section(&[], &[]), "");
    }

    #[test]
    fn a_skill_named_by_mention_is_not_offered_again() {
        let all = [skill("review", "Review code.", None), skill("release", "Cut a release.", None)];
        let section = skill_list_section(&all, &["review"]);
        assert!(section.contains("- release: Cut a release."));
        assert!(!section.contains("review:"));
        assert_eq!(skill_list_section(&all, &["review", "release"]), "");
        // Asked for anyway, it isn't sent twice.
        let mut scope = SkillScope::default();
        let (text, ok) = run_skill_tool(&all, &["review"], &mut scope, &serde_json::json!({"name": "review"}));
        assert!(ok);
        assert!(text.contains("already loaded") && !text.contains("Body of review."), "{text}");
        assert!(!scope.is_loaded("review"));
    }

    #[test]
    fn the_skill_tool_loads_the_body_and_its_allowed_tools() {
        let all = [skill("audit", "Audit the code.", Some(&["read_file", "grep"][..])), skill("free", "", None)];
        let tools = workspace_tools();
        let mut scope = SkillScope::default();
        // Nothing loaded yet: every tool runs.
        assert!(scope.refusal("write_file", &tools).is_none());
        let (text, ok) = run_skill_tool(&all, &[], &mut scope, &serde_json::json!({"name": "/audit"}));
        assert!(ok);
        assert!(text.starts_with("# Skill: audit\n"));
        assert!(text.contains("allows these tools: read_file, grep"));
        assert!(text.contains("Body of audit."));
        // Its allowed-tools hold for the calls after it.
        assert!(scope.refusal("read_file", &tools).is_none());
        let refused = scope.refusal("write_file", &tools).expect("write_file is refused");
        assert!(refused.contains("`audit`") && refused.contains("`read_file`, `grep`"), "{refused}");
        // MCP, sub-agent, recall and Skill calls are never limited.
        for tool in ["mcp__github__create_issue", "Agent", "recall_tool_output", SKILL_TOOL_NAME] {
            assert!(scope.refusal(tool, &tools).is_none(), "{tool}");
        }
        // A second load of the same skill doesn't resend it.
        let (again, ok) = run_skill_tool(&all, &[], &mut scope, &serde_json::json!({"name": "audit"}));
        assert!(ok && !again.contains("Body of audit."));
        // A skill with no allowed-tools opens the full set again.
        run_skill_tool(&all, &[], &mut scope, &serde_json::json!({"name": "free"}));
        assert!(scope.refusal("write_file", &tools).is_none());
    }

    #[test]
    fn allowed_tools_naming_no_workspace_tool_limit_nothing() {
        let all = [skill("cc", "", Some(&["Read", "Bash"][..]))];
        let mut scope = SkillScope::default();
        run_skill_tool(&all, &[], &mut scope, &serde_json::json!({"name": "cc"}));
        assert!(scope.refusal("write_file", &workspace_tools()).is_none());
    }

    #[test]
    fn an_unknown_or_missing_skill_name_is_an_error() {
        let all = [skill("review", "", None)];
        let mut scope = SkillScope::default();
        let (text, ok) = run_skill_tool(&all, &[], &mut scope, &serde_json::json!({"name": "deploy"}));
        assert!(!ok);
        assert!(text.contains("No skill named `deploy`") && text.contains("`review`"), "{text}");
        let (_, ok) = run_skill_tool(&all, &[], &mut scope, &serde_json::json!({}));
        assert!(!ok);
        let (text, ok) = run_skill_tool(&[], &[], &mut scope, &serde_json::json!({"name": "x"}));
        assert!(!ok && text.contains("no skills"));
    }

    #[test]
    fn the_skill_tool_reads_the_project_skill_over_the_users() {
        let project = tempfile::tempdir().expect("project");
        let home = tempfile::tempdir().expect("home");
        write_skill(project.path(), "review", "The project's review.");
        let user_dir = home.path().join(".claude/skills/review");
        fs::create_dir_all(&user_dir).expect("mkdir");
        fs::write(user_dir.join("SKILL.md"), "---\nname: review\ndescription: d\n---\nThe user's review.").expect("write");
        let user_only = home.path().join(".claude/skills/notes");
        fs::create_dir_all(&user_only).expect("mkdir");
        fs::write(user_only.join("SKILL.md"), "---\nname: notes\ndescription: Take notes.\n---\nNotes.").expect("write");
        let catalogue = scan_skills_in(project.path(), Some(home.path())).found;
        let mut scope = SkillScope::default();
        let (text, ok) = run_skill_tool(&catalogue, &[], &mut scope, &serde_json::json!({"name": "review"}));
        assert!(ok && text.contains("The project's review.") && !text.contains("The user's review."), "{text}");
        let section = skill_list_section(&catalogue, &[]);
        assert!(section.contains("- notes: Take notes.") && section.matches("- review").count() == 1, "{section}");
    }

    #[test]
    fn the_skill_tool_schema_is_fixed() {
        let tool = skill_tool_definition();
        assert_eq!(tool.name, "Skill");
        assert_eq!(tool.input_schema["required"], serde_json::json!(["name"]));
        assert_eq!(skill_tool_definition().description, tool.description);
    }

    #[test]
    fn allowed_tools_optional_and_list_forms() {
        let no_tools = parse_skill("---\nname: a\ndescription: d\n---\nbody", "user").unwrap();
        assert!(no_tools.allowed_tools.is_none());
        let bracketed = parse_skill("---\nname: a\ntools: [read_file, run_command]\n---\nb", "user").unwrap();
        assert_eq!(bracketed.allowed_tools.unwrap().len(), 2);
    }
}
