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

/// The skills a piece of prose names with a `/slug` token, in the order they
/// first appear, deduped.
///
/// DIRECT has no per-run "active skill" field the way a TALK turn does — the
/// brief is the only channel the director has. So a reference has to survive as
/// text and be resolved when the stage actually runs, which is also what makes
/// it robust: a hand-typed `/code-review` works exactly like one inserted from
/// the picker.
///
/// Matching is against the worktree's KNOWN skills only, so ordinary prose
/// (a path like `src/lib`, a date, `and/or`) can never be mistaken for a
/// reference. The token must also stand alone — `/code-review` matches,
/// `/code-review-notes` and `x/code-review` do not.
pub fn referenced_skills(worktree: &Path, text: &str) -> Vec<Skill> {
    let known = scan_skills(worktree);
    let mut out: Vec<Skill> = Vec::new();
    for skill in known {
        if out.iter().any(|s| s.name == skill.name) {
            continue;
        }
        if mentions_skill(text, &skill.name) {
            out.push(skill);
        }
    }
    out
}

/// Whether `text` carries a standalone `/name` token.
///
/// Boundaries are compared as CHARS, not bytes: a byte-level test treats every
/// UTF-8 continuation byte as "not alphanumeric", so `docs/café/code-review.md`
/// and `🚀/code-review` would count as references and silently append a whole
/// skill body to every stage's prompt.
fn mentions_skill(text: &str, name: &str) -> bool {
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
        // …and the name must end the token.
        let after_ok = text[end..].chars().next().is_none_or(|c| !is_word_char(c));
        if before_ok && after_ok {
            return true;
        }
        from = end;
    }
    false
}

/// The section appended to a stage's system prompt for each skill the brief
/// named. Same shape TALK uses for its active skill, so an agent meets the
/// instructions in a form it has already been trained on in this app.
pub fn skill_prompt_section(skills: &[Skill]) -> String {
    let mut out = String::new();
    for skill in skills {
        out.push_str(&format!("\n\n# Active skill: {}\n{}", skill.name, skill.body));
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
        assert_eq!(referenced_skills(tmp.path(), "café, then /code-review").len(), 1);
    }

    #[test]
    fn a_skill_named_twice_is_carried_once() {
        let tmp = tempfile::tempdir().expect("tmp");
        write_skill(tmp.path(), "simplify", "b");
        let found = referenced_skills(tmp.path(), "/simplify now, then /simplify again");
        assert_eq!(found.len(), 1);
    }

    #[test]
    fn skill_section_is_the_shape_talk_uses() {
        let tmp = tempfile::tempdir().expect("tmp");
        write_skill(tmp.path(), "code-review", "Review like a hawk.");
        let section = skill_prompt_section(&referenced_skills(tmp.path(), "/code-review"));
        assert!(section.contains("# Active skill: code-review"));
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

    #[test]
    fn allowed_tools_optional_and_list_forms() {
        let no_tools = parse_skill("---\nname: a\ndescription: d\n---\nbody", "user").unwrap();
        assert!(no_tools.allowed_tools.is_none());
        let bracketed = parse_skill("---\nname: a\ntools: [read_file, run_command]\n---\nb", "user").unwrap();
        assert_eq!(bracketed.allowed_tools.unwrap().len(), 2);
    }
}
