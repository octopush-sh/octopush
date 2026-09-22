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
//! Discovered from two roots plus the built-in library, project shadowing
//! user shadowing built-in on a name clash:
//!   - `<worktree>/.claude/agents/*.md`  (project)
//!   - `~/.claude/agents/*.md`           (user)
//!   - `skills::builtin_agents`          (builtin — explorer, implementer, …)
//!
//! One extra frontmatter key Claude Code does not read: `escalate: <tier or
//! model>` — retry once on that model when the report comes back failed,
//! blocked, or cut off at the turn limit.
//!
//! When an `Agent` call's `subagent_type` names one of these, the sub-agent
//! runs under the definition's body (appended to the generic sub-agent
//! prompt), restricted to its `tools` (Claude Code names mapped onto the
//! workspace tools), on its `model` when that resolves to a configured model.
//! An unknown `subagent_type` still works as a plain role hint — the same
//! files that drive Claude Code drive Octopush, nothing else to set up.

use super::{split_frontmatter, split_list};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A parsed agent definition.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentDefinition {
    pub name: String,
    pub description: String,
    /// The sub-agent's own instructions (the file body).
    pub body: String,
    /// Workspace tool names the sub-agent is limited to; `None` = the full set.
    pub tools: Option<Vec<String>>,
    /// Which of the workspace's MCP tools the sub-agent may call.
    pub mcp: McpGrant,
    /// The frontmatter `model` as written (an id, or an alias like `haiku`);
    /// resolved against the configured models at run time.
    pub model: Option<String>,
    /// The frontmatter `escalate` (a tier or an id): the model to retry on,
    /// once, when the first attempt fails, blocks, or hits its turn cap.
    pub escalate: Option<String>,
    /// The frontmatter `max-turns`: the most tool rounds one run of this
    /// sub-agent may take. `None` = the thread's own cap. A cap that lands
    /// mid-work is not the end — the report says so and the director (or the
    /// user, from the crew journal) can give it more turns.
    #[serde(default)]
    pub max_turns: Option<u32>,
    /// The frontmatter `effort` (`low` … `max`): how hard one run of this
    /// sub-agent thinks. `None` = the tier's default (fast → low, balanced →
    /// medium, strong → high; see `chat_agents::default_effort_for_tier`).
    #[serde(default)]
    pub effort: Option<crate::providers::Effort>,
    /// "project", "user" or "builtin".
    pub source: String,
}

/// Which MCP tools (`mcp__server__tool`) a definition grants. A definition
/// with no `tools` list gets every server the workspace configures; one with
/// a list gets only the `mcp__…` entries it names — `mcp__server__tool` for
/// one tool, `mcp__server` for a whole server, `mcp__*` (or `mcp`) for all —
/// exactly as Claude Code reads them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum McpGrant {
    All,
    Only(Vec<String>),
}

impl McpGrant {
    /// Whether `namespaced` (`mcp__server__tool`) is granted.
    pub fn allows(&self, namespaced: &str) -> bool {
        match self {
            McpGrant::All => true,
            McpGrant::Only(patterns) => patterns.iter().any(|p| {
                p == "mcp__*"
                    || p == "mcp"
                    || p == namespaced
                    || (namespaced.starts_with(p.as_str()) && namespaced[p.len()..].starts_with("__"))
            }),
        }
    }
}

/// Split a frontmatter `tools` list into MCP grants and the rest.
pub fn split_mcp_entries(list: &[String]) -> (Vec<String>, Vec<String>) {
    let mut mcp = Vec::new();
    let mut rest = Vec::new();
    for t in list {
        let t = t.trim();
        if t == "mcp" || t.starts_with("mcp__") {
            // `mcp__jira__*` is a common spelling of the server grant.
            let t = t.strip_suffix("__*").filter(|b| b.len() > "mcp__".len()).unwrap_or(t);
            mcp.push(t.to_string());
        } else {
            rest.push(t.to_string());
        }
    }
    (mcp, rest)
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
    pub escalate: Option<String>,
    pub max_turns: Option<u32>,
    pub effort: Option<crate::providers::Effort>,
}

impl AgentDefinition {
    pub fn meta(&self) -> AgentDefinitionMeta {
        AgentDefinitionMeta {
            name: self.name.clone(),
            description: self.description.clone(),
            source: self.source.clone(),
            tools: self.tools.clone(),
            model: self.model.clone(),
            escalate: self.escalate.clone(),
            max_turns: self.max_turns,
            effort: self.effort,
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

/// The tier a configured model id is mapped to in Settings › Models, if any
/// (`strong` when the id is the strong tier's model, …). The reverse of the
/// tier map, for the crew card's tier mix and the all-strong baseline.
pub fn tier_of_model<'a>(
    model: &str,
    tiers: &'a std::collections::HashMap<String, String>,
) -> Option<&'a str> {
    MODEL_TIERS
        .iter()
        .find(|t| tiers.get(**t).is_some_and(|m| m == model))
        .and_then(|t| tiers.get_key_value(*t).map(|(k, _)| k.as_str()))
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
    let mut mcp = McpGrant::All;
    let mut model: Option<String> = None;
    let mut escalate: Option<String> = None;
    let mut max_turns: Option<u32> = None;
    let mut effort: Option<crate::providers::Effort> = None;
    for (key, value) in pairs {
        match key.as_str() {
            "name" => name = value,
            "description" => description = value,
            "tools" | "allowed-tools" | "allowed_tools" => {
                let raw = split_list(&value);
                if !raw.is_empty() {
                    let (mcp_entries, rest) = split_mcp_entries(&raw);
                    let has_mcp = !mcp_entries.is_empty();
                    mcp = McpGrant::Only(mcp_entries);
                    tools = map_tools(&rest);
                    if tools.is_none() && has_mcp {
                        // `tools: mcp__jira` is a complete allowlist (Claude
                        // Code semantics): MCP only, no workspace tools — never
                        // the full set by accident.
                        tools = Some(Vec::new());
                    } else if tools.is_none() && !rest.is_empty() {
                        tracing::warn!(
                            agent = %name,
                            "agent definition names no tool this app has ({}); using the full set",
                            rest.join(", ")
                        );
                    }
                }
            }
            "model" => {
                if !value.is_empty() {
                    model = Some(value);
                }
            }
            "escalate" | "escalate_to" | "escalate-to" => {
                if !value.is_empty() {
                    escalate = Some(value);
                }
            }
            "effort" => {
                effort = crate::providers::Effort::from_str(&value);
            }
            "max-turns" | "max_turns" | "maxTurns" => {
                // Zero or garbage means "no cap of its own", never a
                // sub-agent that cannot take a single turn.
                max_turns = value.trim().parse::<u32>().ok().filter(|n| *n > 0);
            }
            _ => {}
        }
    }
    if name.is_empty() {
        return None;
    }
    Some(AgentDefinition { name, description, body, tools, mcp, model, escalate, max_turns, effort, source: source.to_string() })
}

fn agent_roots(worktree: &Path) -> Vec<(PathBuf, &'static str)> {
    let mut roots = vec![(worktree.join(".claude/agents"), "project")];
    if let Some(home) = dirs::home_dir() {
        roots.push((home.join(".claude/agents"), "user"));
    }
    roots
}

/// Discover every agent definition for a worktree (project ∪ user ∪
/// builtin), project shadowing user shadowing builtin on a name clash,
/// sorted by name.
pub fn scan_agent_definitions(worktree: &Path) -> Vec<AgentDefinition> {
    let mut out = scan_agent_files(worktree);
    for def in super::builtin_agents::builtin_agent_definitions() {
        if !out.iter().any(|d| d.name.eq_ignore_ascii_case(&def.name)) {
            out.push(def);
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// The on-disk definitions only (project ∪ user), project shadowing user.
fn scan_agent_files(worktree: &Path) -> Vec<AgentDefinition> {
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

    #[test]
    fn max_turns_is_parsed_from_the_frontmatter_and_ignores_garbage() {
        let d = parse_agent_definition("---\nname: a\nmax-turns: 12\n---\nbody", "project").unwrap();
        assert_eq!(d.max_turns, Some(12));
        assert_eq!(d.meta().max_turns, Some(12));
        let d = parse_agent_definition("---\nname: a\nmax_turns: 0\n---\nbody", "project").unwrap();
        assert_eq!(d.max_turns, None, "zero means no cap of its own");
        let d = parse_agent_definition("---\nname: a\nmax-turns: lots\n---\nbody", "project").unwrap();
        assert_eq!(d.max_turns, None);
        let d = parse_agent_definition("---\nname: a\n---\nbody", "project").unwrap();
        assert_eq!(d.max_turns, None);
    }

    #[test]
    fn agent_definitions_round_trip_through_json_for_saved_runs() {
        let d = parse_agent_definition("---\nname: a\ntools: Read, mcp__jira\nmodel: fast\nescalate: strong\nmax-turns: 15\neffort: low\n---\nbody", "builtin").unwrap();
        assert_eq!(d.effort, Some(crate::providers::Effort::Low));
        assert_eq!(parse_agent_definition("---\nname: b\neffort: absurd\n---\nbody", "project").unwrap().effort, None);
        let json = serde_json::to_string(&d).unwrap();
        let back: AgentDefinition = serde_json::from_str(&json).unwrap();
        assert_eq!(back, d);
    }
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
        assert_eq!(d.escalate, None);
        // A tools list without MCP entries grants no MCP tool; no list grants all.
        assert_eq!(d.mcp, McpGrant::Only(vec![]));
        let e = parse_agent_definition("---\nname: impl\nmodel: balanced\nescalate: strong\n---\nbody", "project").unwrap();
        assert_eq!(e.escalate.as_deref(), Some("strong"));
        assert_eq!(e.mcp, McpGrant::All);
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
    fn mcp_grants_follow_claude_code_patterns() {
        let d = parse_agent_definition(
            "---\nname: t\ntools: Read, mcp__jira__get_issue, mcp__github\n---\nbody",
            "project",
        )
        .unwrap();
        assert_eq!(d.tools.as_deref(), Some(&["read_file".to_string()][..]));
        assert!(d.mcp.allows("mcp__jira__get_issue"));
        assert!(!d.mcp.allows("mcp__jira__create_issue"));
        assert!(d.mcp.allows("mcp__github__list_prs"), "a server grant covers its tools");
        assert!(!d.mcp.allows("mcp__githubx__list_prs"), "prefix must end at a separator");
        assert!(McpGrant::Only(vec!["mcp__*".into()]).allows("mcp__any__thing"));
        assert!(McpGrant::All.allows("mcp__any__thing"));
        // An MCP-only list is a complete allowlist: MCP tools, no workspace
        // tools — never the full set by accident.
        let only = parse_agent_definition("---\nname: t\ntools: mcp__jira__*\n---\nbody", "project").unwrap();
        assert_eq!(only.tools, Some(vec![]));
        assert_eq!(only.mcp, McpGrant::Only(vec!["mcp__jira".into()]), "`__*` spells the server grant");
        assert!(only.mcp.allows("mcp__jira__get_issue"));
        // Same when the non-MCP entries map to nothing this app has.
        let unmappable = parse_agent_definition("---\nname: t\ntools: WebFetch, mcp__jira\n---\nbody", "project").unwrap();
        assert_eq!(unmappable.tools, Some(vec![]));
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
        // The built-in library rides along …
        assert_eq!(find_agent_definition(&defs, "explorer").map(|d| d.source.as_str()), Some("builtin"));
        assert_eq!(find_agent_definition(&defs, "reviewer").and_then(|d| d.model.as_deref()), Some("strong"));
    }

    #[test]
    fn a_project_file_shadows_a_builtin_of_the_same_name() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".claude/agents");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("reviewer.md"), "---\nname: Reviewer\ndescription: ours\nmodel: fast\n---\nour body").unwrap();
        let defs = scan_agent_definitions(tmp.path());
        let ours: Vec<&AgentDefinition> = defs.iter().filter(|d| d.name.eq_ignore_ascii_case("reviewer")).collect();
        assert_eq!(ours.len(), 1, "{:?}", defs.iter().map(|d| &d.name).collect::<Vec<_>>());
        assert_eq!(ours[0].source, "project");
        assert_eq!(ours[0].model.as_deref(), Some("fast"));
    }

    #[test]
    fn tier_of_model_is_the_reverse_of_the_tier_map() {
        use std::collections::HashMap;
        let tiers: HashMap<String, String> = [
            ("fast".to_string(), "gpt-4o-mini".to_string()),
            ("strong".to_string(), "claude-opus-5".to_string()),
        ]
        .into_iter()
        .collect();
        assert_eq!(tier_of_model("claude-opus-5", &tiers), Some("strong"));
        assert_eq!(tier_of_model("gpt-4o-mini", &tiers), Some("fast"));
        assert_eq!(tier_of_model("deepseek-chat", &tiers), None);
        assert_eq!(tier_of_model("claude-opus-5", &HashMap::new()), None);
    }
}
