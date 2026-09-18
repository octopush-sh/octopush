//! Agent definitions — Claude-Code-compatible `.claude/agents/*.md` files
//! that name a sub-agent type for TALK's `Agent` tool.
//!
//! A definition is one markdown file with frontmatter:
//!
//! ```text
//! ---
//! name: security-reviewer
//! description: Reviews a diff for security issues. Use for any auth/crypto change.
//! tools: Read, Grep, Glob, Bash
//! model: haiku
//! ---
//! You are a security reviewer. …(the sub-agent's system prompt)…
//! ```
//!
//! Discovered from two roots, project shadowing user on a name clash:
//!   - `<worktree>/.claude/agents/*.md`  (project)
//!   - `~/.claude/agents/*.md`           (user)
//!
//! When an `Agent` call's `subagent_type` names one of these, the sub-agent
//! runs under the definition's body (appended to the generic sub-agent
//! prompt), restricted to its `tools` (Claude Code names mapped onto the
//! workspace tools), on its `model` when that resolves to a configured model.
//! An unknown `subagent_type` still works as a plain role hint — the same
//! files that drive Claude Code drive Octopush, nothing else to set up.

use super::{split_frontmatter, split_list};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// A parsed agent definition.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentDefinition {
    pub name: String,
    pub description: String,
    /// The sub-agent's own instructions (the file body).
    pub body: String,
    /// Workspace tool names the sub-agent is limited to; `None` = the full set.
    pub tools: Option<Vec<String>>,
    /// The frontmatter `model` as written (an id, or an alias like `haiku`);
    /// resolved against the configured models at run time.
    pub model: Option<String>,
    /// "project" or "user".
    pub source: String,
}

/// Picker-sized descriptor (no body).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinitionMeta {
    pub name: String,
    pub description: String,
    pub source: String,
    pub tools: Option<Vec<String>>,
    pub model: Option<String>,
}

impl AgentDefinition {
    pub fn meta(&self) -> AgentDefinitionMeta {
        AgentDefinitionMeta {
            name: self.name.clone(),
            description: self.description.clone(),
            source: self.source.clone(),
            tools: self.tools.clone(),
            model: self.model.clone(),
        }
    }
}

/// Claude Code tool name → the workspace tool it corresponds to. Octopush
/// names pass through; anything else (WebFetch, TodoWrite, Task…) has no
/// counterpart here and is dropped.
pub fn map_tool_name(name: &str) -> Option<&'static str> {
    let n = name.trim();
    let lower = n.to_ascii_lowercase();
    // Claude Code allows `Bash(git:*)`-style scoped grants; the scope is not
    // enforceable here, so the base tool is what counts.
    let base = lower.split('(').next().unwrap_or("").trim();
    Some(match base {
        "read" | "read_file" | "notebookread" => "read_file",
        "write" | "write_file" => "write_file",
        "edit" | "multiedit" | "edit_file" | "notebookedit" => "edit_file",
        "bash" | "run_command" => "run_command",
        "grep" => "grep",
        "glob" => "glob",
        "ls" | "list_files" => "list_files",
        _ => return None,
    })
}

/// Map a frontmatter `tools` list onto workspace tools, deduped, in order.
/// `None` when nothing maps (a definition that only names tools we lack
/// falls back to the full set rather than an agent with no hands).
pub fn map_tools(list: &[String]) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for t in list {
        if let Some(mapped) = map_tool_name(t) {
            if !out.iter().any(|o| o == mapped) {
                out.push(mapped.to_string());
            }
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

/// The provider-agnostic tier names a definition or an `Agent` call may ask
/// for, and the Claude Code aliases that map onto them.
pub const MODEL_TIERS: [&str; 3] = ["fast", "balanced", "strong"];

/// `haiku` → `fast`, `sonnet` → `balanced`, `opus` → `strong`; a tier name
/// maps to itself; anything else is not a tier.
pub fn tier_for_alias(spec: &str) -> Option<&'static str> {
    match spec.trim().to_ascii_lowercase().as_str() {
        "fast" | "haiku" => Some("fast"),
        "balanced" | "sonnet" => Some("balanced"),
        "strong" | "opus" => Some("strong"),
        _ => None,
    }
}

/// Resolve a `model` spec against the configured model ids, with no tier
/// mapping — see [`resolve_model_with_tiers`].
pub fn resolve_model<'a>(spec: &str, known: &'a [String]) -> Option<&'a str> {
    resolve_model_with_tiers(spec, known, &std::collections::HashMap::new())
}

/// Resolve a definition's (or a call's) `model` against the configured model
/// ids: an exact id wins; a tier name or Claude Code alias (`fast`/`haiku`,
/// `balanced`/`sonnet`, `strong`/`opus`) takes the tier the user mapped in
/// Settings › Models when that id is configured; otherwise an alias picks the
/// first configured id containing it (case-insensitive); `inherit`/empty or
/// no match → `None` (the conversation's model). Pure over the id list and
/// the tier map so the rule is testable without a provider config.
pub fn resolve_model_with_tiers<'a>(
    spec: &str,
    known: &'a [String],
    tiers: &std::collections::HashMap<String, String>,
) -> Option<&'a str> {
    let spec = spec.trim();
    if spec.is_empty() || spec.eq_ignore_ascii_case("inherit") {
        return None;
    }
    if let Some(exact) = known.iter().find(|k| k.as_str() == spec) {
        return Some(exact.as_str());
    }
    if let Some(tier) = tier_for_alias(spec) {
        if let Some(mapped) = tiers.get(tier) {
            if let Some(exact) = known.iter().find(|k| k.as_str() == mapped) {
                return Some(exact.as_str());
            }
        }
    }
    let needle = spec.to_ascii_lowercase();
    known
        .iter()
        .find(|k| k.to_ascii_lowercase().contains(&needle))
        .map(String::as_str)
}

/// Parse one agent file. `None` without a usable frontmatter `name`.
pub fn parse_agent_definition(content: &str, source: &str) -> Option<AgentDefinition> {
    let (pairs, body) = split_frontmatter(content)?;
    let mut name = String::new();
    let mut description = String::new();
    let mut tools: Option<Vec<String>> = None;
    let mut model: Option<String> = None;
    for (key, value) in pairs {
        match key.as_str() {
            "name" => name = value,
            "description" => description = value,
            "tools" | "allowed-tools" | "allowed_tools" => {
                let raw = split_list(&value);
                if !raw.is_empty() {
                    tools = map_tools(&raw);
                    if tools.is_none() {
                        tracing::warn!(
                            agent = %name,
                            "agent definition names no tool this app has ({}); using the full set",
                            raw.join(", ")
                        );
                    }
                }
            }
            "model" => {
                if !value.is_empty() {
                    model = Some(value);
                }
            }
            _ => {}
        }
    }
    if name.is_empty() {
        return None;
    }
    Some(AgentDefinition { name, description, body, tools, model, source: source.to_string() })
}

fn agent_roots(worktree: &Path) -> Vec<(PathBuf, &'static str)> {
    let mut roots = vec![(worktree.join(".claude/agents"), "project")];
    if let Some(home) = dirs::home_dir() {
        roots.push((home.join(".claude/agents"), "user"));
    }
    roots
}

/// Discover every agent definition for a worktree (project ∪ user), project
/// shadowing user on a name clash, sorted by name.
pub fn scan_agent_definitions(worktree: &Path) -> Vec<AgentDefinition> {
    let mut out: Vec<AgentDefinition> = Vec::new();
    for (root, source) in agent_roots(worktree) {
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x == "md").unwrap_or(false))
            .collect();
        files.sort();
        for path in files {
            let Ok(content) = std::fs::read_to_string(&path) else { continue };
            if let Some(def) = parse_agent_definition(&content, source) {
                if out.iter().any(|d| d.name == def.name) {
                    continue;
                }
                out.push(def);
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Look one definition up by `subagent_type`. Case-sensitive on the name
/// (Claude Code is), with a case-insensitive fallback so `Explore` finds
/// `explore`.
pub fn find_agent_definition<'a>(defs: &'a [AgentDefinition], name: &str) -> Option<&'a AgentDefinition> {
    defs.iter()
        .find(|d| d.name == name)
        .or_else(|| defs.iter().find(|d| d.name.eq_ignore_ascii_case(name)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const FILE: &str = "---\nname: security-reviewer\ndescription: Finds security issues.\ntools: Read, Grep, Glob, Bash(git:*), WebFetch\nmodel: haiku\n---\nYou hunt for injection and auth bugs.\n\n---\nStill body.";

    #[test]
    fn parses_name_description_tools_model_and_body() {
        let d = parse_agent_definition(FILE, "project").unwrap();
        assert_eq!(d.name, "security-reviewer");
        assert_eq!(d.description, "Finds security issues.");
        assert_eq!(
            d.tools.as_deref(),
            Some(&["read_file".to_string(), "grep".into(), "glob".into(), "run_command".into()][..])
        );
        assert_eq!(d.model.as_deref(), Some("haiku"));
        // A `---` rule inside the body is body, not a fence.
        assert_eq!(d.body, "You hunt for injection and auth bugs.\n\n---\nStill body.");
        assert_eq!(d.source, "project");
    }

    #[test]
    fn tools_that_map_to_nothing_leave_the_full_set() {
        let d = parse_agent_definition("---\nname: x\ntools: WebFetch, TodoWrite\n---\nbody", "user").unwrap();
        assert_eq!(d.tools, None);
        assert_eq!(map_tools(&["Edit".into(), "MultiEdit".into(), "edit_file".into()]), Some(vec!["edit_file".into()]));
        assert_eq!(map_tool_name("LS"), Some("list_files"));
        assert_eq!(map_tool_name("Task"), None);
    }

    #[test]
    fn requires_a_name_and_a_closed_fence() {
        assert!(parse_agent_definition("---\ndescription: d\n---\nbody", "project").is_none());
        assert!(parse_agent_definition("---\nname: x\nbody", "project").is_none());
        assert!(parse_agent_definition("name: x\n", "project").is_none());
    }

    #[test]
    fn model_resolution_prefers_exact_then_alias_then_inherits() {
        let known = vec![
            "claude-opus-5".to_string(),
            "claude-haiku-4-5-20251001".to_string(),
            "gpt-4o-mini".to_string(),
        ];
        assert_eq!(resolve_model("gpt-4o-mini", &known), Some("gpt-4o-mini"));
        assert_eq!(resolve_model("haiku", &known), Some("claude-haiku-4-5-20251001"));
        assert_eq!(resolve_model("Opus", &known), Some("claude-opus-5"));
        assert_eq!(resolve_model("sonnet", &known), None);
        assert_eq!(resolve_model("inherit", &known), None);
        assert_eq!(resolve_model("", &known), None);
    }

    #[test]
    fn tiers_take_precedence_over_substring_aliases_and_work_for_any_provider() {
        use std::collections::HashMap;
        let known = vec![
            "claude-opus-5".to_string(),
            "claude-haiku-4-5-20251001".to_string(),
            "gpt-4o-mini".to_string(),
            "deepseek-chat".to_string(),
        ];
        let tiers: HashMap<String, String> = [
            ("fast".to_string(), "gpt-4o-mini".to_string()),
            ("balanced".to_string(), "deepseek-chat".to_string()),
            ("strong".to_string(), "not-configured".to_string()),
        ]
        .into_iter()
        .collect();
        // A mapped tier beats the substring alias: `haiku` → the fast tier.
        assert_eq!(resolve_model_with_tiers("haiku", &known, &tiers), Some("gpt-4o-mini"));
        assert_eq!(resolve_model_with_tiers("FAST", &known, &tiers), Some("gpt-4o-mini"));
        // A provider-agnostic tier with no Anthropic-flavoured alias at all.
        assert_eq!(resolve_model_with_tiers("balanced", &known, &tiers), Some("deepseek-chat"));
        assert_eq!(resolve_model_with_tiers("sonnet", &known, &tiers), Some("deepseek-chat"));
        // A tier mapped to an id that is no longer configured falls through to
        // the substring alias (`opus` matches), then to inherit.
        assert_eq!(resolve_model_with_tiers("opus", &known, &tiers), Some("claude-opus-5"));
        assert_eq!(resolve_model_with_tiers("strong", &known, &tiers), None);
        // Exact ids still win over everything.
        assert_eq!(resolve_model_with_tiers("deepseek-chat", &known, &tiers), Some("deepseek-chat"));
        assert_eq!(tier_for_alias("Opus"), Some("strong"));
        assert_eq!(tier_for_alias("gpt-4o"), None);
    }

    #[test]
    fn scan_reads_project_agents_sorted_and_finds_case_insensitively() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".claude/agents");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("zeta.md"), "---\nname: Zeta\ndescription: z\n---\nz body").unwrap();
        fs::write(dir.join("alpha.md"), "---\nname: alpha\ndescription: a\n---\na body").unwrap();
        fs::write(dir.join("notes.txt"), "---\nname: ignored\n---\n").unwrap();
        fs::write(dir.join("broken.md"), "no frontmatter").unwrap();
        let defs = scan_agent_definitions(tmp.path());
        let names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
        // Sorted by name; the .txt and the fence-less file are skipped. (A
        // user-level ~/.claude/agents may add more on a developer machine,
        // so assert containment and order, not the exact set.)
        assert!(names.contains(&"Zeta") && names.contains(&"alpha"), "{names:?}");
        let a = names.iter().position(|n| *n == "Zeta").unwrap();
        let b = names.iter().position(|n| *n == "alpha").unwrap();
        assert!(a < b, "uppercase sorts first: {names:?}");
        assert_eq!(find_agent_definition(&defs, "zeta").map(|d| d.body.as_str()), Some("z body"));
        assert_eq!(find_agent_definition(&defs, "alpha").map(|d| d.source.as_str()), Some("project"));
        assert!(find_agent_definition(&defs, "nope").is_none());
    }
}
