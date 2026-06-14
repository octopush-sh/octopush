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
//! The frontmatter is parsed by hand (the three fields we use are simple
//! `key: value` lines) so we don't pull in a YAML dependency.

use serde::Serialize;
use std::path::{Path, PathBuf};

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

/// The two skill roots, project first (it shadows user skills of the same name).
fn skill_roots(worktree: &Path) -> Vec<(PathBuf, &'static str)> {
    let mut roots = vec![(worktree.join(".claude/skills"), "project")];
    if let Some(home) = dirs::home_dir() {
        roots.push((home.join(".claude/skills"), "user"));
    }
    roots
}

/// Parse a SKILL.md's text into a Skill. Returns None when there's no usable
/// frontmatter `name`. `source` labels the origin ("project"/"user").
pub fn parse_skill(content: &str, source: &str) -> Option<Skill> {
    // Frontmatter is a leading `---` … `---` block delimited by lines that are
    // exactly `---`. Parsing line-by-line (rather than substring-searching for
    // `\n---`) means a `---` horizontal rule or a leading `-` list item in the
    // BODY is never mistaken for the fence or stripped.
    let text = content.replace("\r\n", "\n");
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None; // must open with a `---` fence line
    }
    let mut front_lines: Vec<&str> = Vec::new();
    let mut body_lines: Vec<&str> = Vec::new();
    let mut closed = false;
    for line in lines {
        if !closed {
            if line.trim() == "---" {
                closed = true;
            } else {
                front_lines.push(line);
            }
        } else {
            body_lines.push(line);
        }
    }
    if !closed {
        return None; // no closing fence — malformed
    }
    let body = body_lines.join("\n").trim().to_string();

    let mut name = String::new();
    let mut description = String::new();
    let mut allowed_tools: Option<Vec<String>> = None;
    for line in front_lines {
        let Some((key, value)) = line.split_once(':') else { continue };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim().trim_matches(['"', '\'']).to_string();
        match key.as_str() {
            "name" => name = value,
            "description" => description = value,
            "allowed-tools" | "allowed_tools" | "tools" => {
                let list: Vec<String> = value
                    .trim_matches(['[', ']'])
                    .split(',')
                    .map(|s| s.trim().trim_matches(['"', '\'']).to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
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

/// Discover all skills for a worktree (project ∪ user), project shadowing user.
pub fn scan_skills(worktree: &Path) -> Vec<Skill> {
    let mut out: Vec<Skill> = Vec::new();
    for (root, source) in skill_roots(worktree) {
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let md = entry.path().join("SKILL.md");
            let Ok(content) = std::fs::read_to_string(&md) else { continue };
            if let Some(skill) = parse_skill(&content, source) {
                // Project shadows user: skip a user skill whose name a project
                // skill already claimed.
                if out.iter().any(|s| s.name == skill.name) {
                    continue;
                }
                out.push(skill);
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Load a single skill by name for a worktree (project shadowing user).
pub fn load_skill(worktree: &Path, name: &str) -> Option<Skill> {
    scan_skills(worktree).into_iter().find(|s| s.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn allowed_tools_optional_and_list_forms() {
        let no_tools = parse_skill("---\nname: a\ndescription: d\n---\nbody", "user").unwrap();
        assert!(no_tools.allowed_tools.is_none());
        let bracketed = parse_skill("---\nname: a\ntools: [read_file, run_command]\n---\nb", "user").unwrap();
        assert_eq!(bracketed.allowed_tools.unwrap().len(), 2);
    }
}
