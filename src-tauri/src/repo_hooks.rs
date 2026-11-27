//! What a repo's own Claude Code config runs: the hooks and status line in its
//! committed `.claude/settings.json`, the MCP servers in its `.mcp.json`, and
//! the inline shell commands of its `.claude/skills/*/SKILL.md` and
//! `.claude/commands/**/*.md`.
//!
//! Claude Code loads all of them from the working directory of every Claude
//! Code CLI stage. Hook entries live under `hooks.<Event>[].hooks[]`, each with a
//! `type` of `command` (`command`), `http` (`url`) or `mcp_tool` (`server`,
//! `tool`); `statusLine` is `{ "type": "command", "command": … }`; servers are
//! `mcpServers.<name>` with a `command` (+ `args`) or a `url`. A skill or
//! command runs `` !`<command>` `` and each ```` ```! ```` fenced block as it
//! loads, before its text reaches the model and without asking.
//!
//! Octopush only reads these files, never `settings.local.json` (personal and
//! uncommitted). A missing, oversized or malformed file reads as empty: the
//! launcher stays silent rather than guessing. The hash covers each entry's
//! raw JSON, canonicalised (object keys sorted), so it ignores key order and
//! formatting but changes whenever an entry does.

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

/// Files bigger than this are not read.
const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// At most this many skill and command files are read.
const MAX_SKILL_FILES: usize = 1000;

/// `.claude/commands` is walked this many folders deep, at most.
const MAX_COMMAND_DEPTH: usize = 8;

/// One hook, or the status line, from `.claude/settings.json`.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoHook {
    /// The hook event (`PreToolUse`, …), or `statusLine`.
    pub event: String,
    /// The entry's matcher, when it has a non-empty one.
    pub matcher: Option<String>,
    /// `command`, `http`, `mcp_tool` or `status_line`.
    pub kind: String,
    /// What it runs: the command, the URL, or `server · tool`.
    pub runs: String,
}

/// One MCP server from `.mcp.json`.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoMcpServer {
    pub name: String,
    /// The command line (`command` and `args`), or the URL.
    pub runs: String,
}

/// One shell command a committed skill or command runs as it loads.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoSkillShell {
    /// The skill's folder name, or the command's path under
    /// `.claude/commands` without `.md` (`deploy`, `db/reset`).
    pub skill: String,
    /// The command, as written (a fenced block's lines joined by newlines).
    pub command: String,
}

/// Everything the repo's committed Claude Code config runs.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoHooks {
    pub hooks: Vec<RepoHook>,
    pub servers: Vec<RepoMcpServer>,
    /// Skills first, then commands, each in name order; commands in file order.
    pub skill_shells: Vec<RepoSkillShell>,
    /// Lowercase hex SHA-256 over the canonical JSON of every entry above.
    pub hash: String,
}

fn str_field<'a>(obj: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    obj.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

/// The hooks and status line of a `.claude/settings.json` text, each with the
/// raw entry the hash covers. Events in name order, entries in file order.
/// Hook types that run nothing on the Mac (`prompt`, `agent`) and entries
/// missing their target are left out. Pure.
pub fn parse_settings(text: &str) -> Vec<(RepoHook, Value)> {
    let Ok(Value::Object(root)) = serde_json::from_str::<Value>(text) else { return Vec::new() };
    let mut out = Vec::new();
    if let Some(Value::Object(events)) = root.get("hooks") {
        let mut names: Vec<&String> = events.keys().collect();
        names.sort();
        for event in names {
            let Some(Value::Array(groups)) = events.get(event) else { continue };
            for group in groups {
                let Value::Object(group) = group else { continue };
                let matcher = str_field(group, "matcher").map(str::to_string);
                let Some(Value::Array(hooks)) = group.get("hooks") else { continue };
                for hook in hooks {
                    let Value::Object(h) = hook else { continue };
                    let runs = match str_field(h, "type") {
                        Some("command") => str_field(h, "command").map(str::to_string),
                        Some("http") => str_field(h, "url").map(str::to_string),
                        Some("mcp_tool") => match (str_field(h, "server"), str_field(h, "tool")) {
                            (Some(s), Some(t)) => Some(format!("{s} · {t}")),
                            (Some(s), None) => Some(s.to_string()),
                            (None, Some(t)) => Some(t.to_string()),
                            (None, None) => None,
                        },
                        _ => None,
                    };
                    let Some(runs) = runs else { continue };
                    let kind = str_field(h, "type").unwrap_or_default().to_string();
                    let raw = serde_json::json!({ "event": event, "matcher": matcher, "hook": hook });
                    out.push((RepoHook { event: event.clone(), matcher: matcher.clone(), kind, runs }, raw));
                }
            }
        }
    }
    if let Some(Value::Object(line)) = root.get("statusLine") {
        let is_command = matches!(str_field(line, "type"), None | Some("command"));
        if let Some(command) = str_field(line, "command").filter(|_| is_command) {
            let raw = serde_json::json!({ "statusLine": Value::Object(line.clone()) });
            out.push((
                RepoHook { event: "statusLine".into(), matcher: None, kind: "status_line".into(), runs: command.to_string() },
                raw,
            ));
        }
    }
    out
}

/// The MCP servers of a `.mcp.json` text, in name order, each with the raw
/// entry the hash covers. A server with neither a command nor a URL is left
/// out. Pure.
pub fn parse_mcp(text: &str) -> Vec<(RepoMcpServer, Value)> {
    let Ok(Value::Object(root)) = serde_json::from_str::<Value>(text) else { return Vec::new() };
    let Some(Value::Object(servers)) = root.get("mcpServers") else { return Vec::new() };
    let mut names: Vec<&String> = servers.keys().collect();
    names.sort();
    let mut out = Vec::new();
    for name in names {
        let Some(Value::Object(s)) = servers.get(name) else { continue };
        let runs = if let Some(command) = str_field(s, "command") {
            let args = s.get("args").and_then(Value::as_array).map(|a| {
                a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")
            });
            match args.filter(|a| !a.is_empty()) {
                Some(args) => format!("{command} {args}"),
                None => command.to_string(),
            }
        } else if let Some(url) = str_field(s, "url") {
            url.to_string()
        } else {
            continue;
        };
        let raw = serde_json::json!({ "name": name, "server": Value::Object(s.clone()) });
        out.push((RepoMcpServer { name: name.clone(), runs }, raw));
    }
    out
}

/// The shell commands a skill or command text runs as it loads, in file
/// order: each `` !`…` `` whose `!` starts a line or follows whitespace (the
/// span ends at the next backtick on that line), and the body of each fenced
/// block opened with ```` ```! ```` (to its closing fence, or the end of the
/// text). Empty commands are left out. Pure.
pub fn parse_skill_shell(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        if line.trim_start().starts_with("```!") {
            let mut body = Vec::new();
            for inner in lines.by_ref() {
                if inner.trim_start().starts_with("```") {
                    break;
                }
                body.push(inner);
            }
            let command = body.join("\n");
            let command = command.trim();
            if !command.is_empty() {
                out.push(command.to_string());
            }
            continue;
        }
        let bytes = line.as_bytes();
        let mut i = 0;
        while i + 1 < bytes.len() {
            let opens = bytes[i] == b'!' && bytes[i + 1] == b'`' && (i == 0 || bytes[i - 1].is_ascii_whitespace());
            if !opens {
                i += 1;
                continue;
            }
            let start = i + 2;
            let Some(len) = line[start..].find('`') else { break };
            let command = line[start..start + len].trim();
            if !command.is_empty() {
                out.push(command.to_string());
            }
            i = start + len + 1;
        }
    }
    out
}

/// `value` as JSON with every object's keys sorted and no whitespace.
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String((*key).clone()).to_string());
                out.push(':');
                write_canonical(&map[*key], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// The hooks and servers of the two texts, or `None` when they hold neither.
/// Pure.
pub fn from_texts(settings: &str, mcp: &str) -> Option<RepoHooks> {
    from_sources(settings, mcp, &[])
}

/// [`from_texts`] plus the inline shell commands of `skills`, each a
/// `(skill name, file text)` pair in the order to list them. `None` when
/// nothing runs. A repo without skill shell commands hashes as before. Pure.
pub fn from_sources(settings: &str, mcp: &str, skills: &[(String, String)]) -> Option<RepoHooks> {
    let (hooks, hook_raw): (Vec<_>, Vec<_>) = parse_settings(settings).into_iter().unzip();
    let (servers, server_raw): (Vec<_>, Vec<_>) = parse_mcp(mcp).into_iter().unzip();
    let skill_shells: Vec<RepoSkillShell> = skills
        .iter()
        .flat_map(|(skill, text)| {
            parse_skill_shell(text).into_iter().map(|command| RepoSkillShell { skill: skill.clone(), command })
        })
        .collect();
    if hooks.is_empty() && servers.is_empty() && skill_shells.is_empty() {
        return None;
    }
    let mut covered = serde_json::json!({ "hooks": hook_raw, "servers": server_raw });
    if !skill_shells.is_empty() {
        let raw: Vec<Value> =
            skill_shells.iter().map(|s| serde_json::json!({ "skill": s.skill, "command": s.command })).collect();
        covered["skillShells"] = Value::Array(raw);
    }
    let canonical = canonical_json(&covered);
    let hash: String = Sha256::digest(canonical.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    Some(RepoHooks { hooks, servers, skill_shells, hash })
}

fn read_small(path: &Path) -> String {
    match std::fs::metadata(path) {
        Ok(m) if m.is_file() && m.len() <= MAX_FILE_BYTES => std::fs::read_to_string(path).unwrap_or_default(),
        _ => String::new(),
    }
}

/// The entries of `dir` in name order; nothing when it can't be read.
fn sorted_entries(dir: &Path) -> Vec<std::fs::DirEntry> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut entries: Vec<_> = rd.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());
    entries
}

/// `(name, text)` of each `.claude/skills/<name>/SKILL.md`, then of each
/// `.claude/commands/**/<name>.md` (named by its path there, without `.md`).
/// Symlinked folders under `commands` are not followed; each file is read
/// as [`read_small`] does, and at most [`MAX_SKILL_FILES`] of them. Blocking.
fn skill_texts(worktree: &Path) -> Vec<(String, String)> {
    let claude = worktree.join(".claude");
    let mut out = Vec::new();
    for entry in sorted_entries(&claude.join("skills")) {
        if out.len() >= MAX_SKILL_FILES {
            return out;
        }
        if entry.path().is_dir() {
            let text = read_small(&entry.path().join("SKILL.md"));
            out.push((entry.file_name().to_string_lossy().into_owned(), text));
        }
    }
    fn walk(dir: &Path, prefix: &str, depth: usize, out: &mut Vec<(String, String)>) {
        for entry in sorted_entries(dir) {
            if out.len() >= MAX_SKILL_FILES {
                return;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if depth < MAX_COMMAND_DEPTH {
                    walk(&entry.path(), &format!("{prefix}{name}/"), depth + 1, out);
                }
            } else if let Some(stem) = name.strip_suffix(".md").filter(|s| !s.is_empty()) {
                out.push((format!("{prefix}{stem}"), read_small(&entry.path())));
            }
        }
    }
    walk(&claude.join("commands"), "", 0, &mut out);
    out
}

/// What `worktree`'s `.claude/settings.json`, `.mcp.json`, skills and
/// commands run, or `None` when none runs anything (or all are missing or
/// malformed). Blocking.
pub fn read(worktree: &Path) -> Option<RepoHooks> {
    from_sources(
        &read_small(&worktree.join(".claude").join("settings.json")),
        &read_small(&worktree.join(".mcp.json")),
        &skill_texts(worktree),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const SETTINGS: &str = r#"{
      "permissions": { "allow": ["Bash(npm test)"] },
      "hooks": {
        "PreToolUse": [
          { "matcher": "Bash", "hooks": [
            { "type": "command", "command": "./scripts/guard.sh" },
            { "type": "http", "url": "https://hooks.example.com/pre" }
          ] }
        ],
        "PostToolUse": [
          { "matcher": "", "hooks": [
            { "type": "mcp_tool", "server": "linter", "tool": "lint_file" },
            { "type": "prompt", "prompt": "Was that ok?" }
          ] }
        ]
      },
      "statusLine": { "type": "command", "command": "~/.claude/status.sh" }
    }"#;

    const MCP: &str = r#"{
      "mcpServers": {
        "db": { "command": "npx", "args": ["-y", "db-mcp"], "env": { "DB": "local" } },
        "docs": { "type": "http", "url": "https://mcp.example.com/docs" },
        "empty": { "type": "stdio" }
      }
    }"#;

    fn hook(event: &str, matcher: Option<&str>, kind: &str, runs: &str) -> RepoHook {
        RepoHook { event: event.into(), matcher: matcher.map(Into::into), kind: kind.into(), runs: runs.into() }
    }

    #[test]
    fn reads_each_hook_type_and_the_status_line() {
        let hooks: Vec<RepoHook> = parse_settings(SETTINGS).into_iter().map(|(h, _)| h).collect();
        assert_eq!(
            hooks,
            vec![
                hook("PostToolUse", None, "mcp_tool", "linter · lint_file"),
                hook("PreToolUse", Some("Bash"), "command", "./scripts/guard.sh"),
                hook("PreToolUse", Some("Bash"), "http", "https://hooks.example.com/pre"),
                hook("statusLine", None, "status_line", "~/.claude/status.sh"),
            ],
            "events in name order, entries in file order, prompt hooks left out"
        );
    }

    #[test]
    fn reads_command_and_url_servers() {
        let servers: Vec<RepoMcpServer> = parse_mcp(MCP).into_iter().map(|(s, _)| s).collect();
        assert_eq!(
            servers,
            vec![
                RepoMcpServer { name: "db".into(), runs: "npx -y db-mcp".into() },
                RepoMcpServer { name: "docs".into(), runs: "https://mcp.example.com/docs".into() },
            ]
        );
    }

    #[test]
    fn malformed_or_empty_texts_stay_silent() {
        for bad in ["", "{", "[1,2]", "null", "{\"hooks\": 3}", "{\"hooks\": {\"PreToolUse\": {}}}",
            "{\"hooks\": {\"PreToolUse\": [{\"hooks\": [{\"type\": \"command\"}]}]}}",
            "{\"statusLine\": {\"type\": \"command\", \"command\": \"  \"}}"]
        {
            assert!(parse_settings(bad).is_empty(), "settings {bad:?}");
        }
        for bad in ["", "not json", "{\"mcpServers\": []}", "{\"mcpServers\": {\"x\": 1}}", "{\"servers\": {}}"] {
            assert!(parse_mcp(bad).is_empty(), "mcp {bad:?}");
        }
        assert_eq!(from_texts("{", "{"), None);
        assert_eq!(from_texts("{}", "{\"mcpServers\": {}}"), None);
    }

    #[test]
    fn the_hash_ignores_key_order_and_formatting() {
        let a = from_texts(SETTINGS, MCP).unwrap();
        let reordered_settings = r#"{"statusLine":{"command":"~/.claude/status.sh","type":"command"},
          "hooks":{"PostToolUse":[{"hooks":[{"tool":"lint_file","server":"linter","type":"mcp_tool"},
            {"prompt":"Was that ok?","type":"prompt"}],"matcher":""}],
          "PreToolUse":[{"hooks":[{"command":"./scripts/guard.sh","type":"command"},
            {"url":"https://hooks.example.com/pre","type":"http"}],"matcher":"Bash"}]},
          "permissions":{"allow":["Bash(npm test)"]}}"#;
        let reordered_mcp = r#"{"mcpServers":{"empty":{"type":"stdio"},
          "docs":{"url":"https://mcp.example.com/docs","type":"http"},
          "db":{"env":{"DB":"local"},"args":["-y","db-mcp"],"command":"npx"}}}"#;
        let b = from_texts(reordered_settings, reordered_mcp).unwrap();
        assert_eq!(a.hash, b.hash);
        assert_eq!(a.hash.len(), 64);
        assert_eq!(canonical_json(&serde_json::json!({"b": [2, {"d": 1, "c": "x"}], "a": null})), r#"{"a":null,"b":[2,{"c":"x","d":1}]}"#);
    }

    #[test]
    fn the_hash_changes_when_an_entry_changes() {
        let base = from_texts(SETTINGS, MCP).unwrap().hash;
        let changed = [
            from_texts(&SETTINGS.replace("guard.sh", "guard2.sh"), MCP),
            from_texts(&SETTINGS.replace("\"Bash\"", "\"Edit\""), MCP),
            from_texts(&SETTINGS.replace("status.sh", "status2.sh"), MCP),
            from_texts(SETTINGS, &MCP.replace("\"local\"", "\"prod\"")),
            from_texts(SETTINGS, &MCP.replace("\"-y\", ", "")),
        ];
        for (i, c) in changed.iter().enumerate() {
            assert_ne!(c.as_ref().unwrap().hash, base, "change {i}");
        }
        // Settings outside the entries don't count.
        let perms = SETTINGS.replace("npm test", "npm run lint");
        assert_eq!(from_texts(&perms, MCP).unwrap().hash, base);
    }

    #[test]
    fn reads_the_committed_files_only() {
        let tmp = tempfile::tempdir().unwrap();
        let wt = tmp.path();
        assert_eq!(read(wt), None, "missing files: silent");
        std::fs::create_dir_all(wt.join(".claude")).unwrap();
        std::fs::write(
            wt.join(".claude/settings.local.json"),
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]}}"#,
        )
        .unwrap();
        assert_eq!(read(wt), None, "settings.local.json is never read");
        std::fs::write(wt.join(".claude/settings.json"), SETTINGS).unwrap();
        std::fs::write(wt.join(".mcp.json"), MCP).unwrap();
        let got = read(wt).unwrap();
        assert_eq!(got.hooks.len(), 4);
        assert_eq!(got.servers.len(), 2);
        assert_eq!(got, from_texts(SETTINGS, MCP).unwrap());
        std::fs::write(wt.join(".claude/settings.json"), "{ broken").unwrap();
        assert!(read(wt).unwrap().hooks.is_empty(), "a malformed settings file reads as empty");
    }

    const SKILL: &str = "---\nname: deploy\ndescription: Ship it\n---\n\
        Current branch: !`git branch --show-current`\n\
        !`git status --short` and also !`  `, a!`not-this`, and `!`plain code`.\n\
        Use `npm test` normally; shout! `no`.\n\
        ```!\nnpm ci\nnpm run build\n```\n\
        ```bash\nnot run\n```\n";

    #[test]
    fn finds_inline_and_fenced_skill_shell_commands() {
        assert_eq!(
            parse_skill_shell(SKILL),
            vec!["git branch --show-current", "git status --short", "npm ci\nnpm run build"],
            "a ! after a word or a backtick, an empty span and a plain fence don't count"
        );
        assert_eq!(parse_skill_shell("!`unclosed\n```!\n\n```"), Vec::<String>::new());
        assert_eq!(parse_skill_shell("  ```!sh\necho a\n"), vec!["echo a"], "an unclosed fence runs to the end");
        assert_eq!(parse_skill_shell("é !`ls` !`pwd`"), vec!["ls", "pwd"]);
        assert!(parse_skill_shell("").is_empty());
    }

    #[test]
    fn skill_shells_join_the_notice_and_its_hash() {
        let skills = vec![("deploy".to_string(), SKILL.to_string())];
        let only = from_sources("", "", &skills).unwrap();
        assert!(only.hooks.is_empty() && only.servers.is_empty());
        assert_eq!(
            only.skill_shells[0],
            RepoSkillShell { skill: "deploy".into(), command: "git branch --show-current".into() }
        );
        assert_eq!(only.skill_shells.len(), 3);
        // A repo without skill shell commands keeps the hash it had.
        let plain = from_texts(SETTINGS, MCP).unwrap().hash;
        let none = vec![("readme".to_string(), "No shell here.".to_string())];
        assert_eq!(from_sources(SETTINGS, MCP, &none).unwrap().hash, plain);
        let with = from_sources(SETTINGS, MCP, &skills).unwrap().hash;
        assert_ne!(with, plain);
        let edited = vec![("deploy".to_string(), SKILL.replace("--short", "--long"))];
        assert_ne!(from_sources(SETTINGS, MCP, &edited).unwrap().hash, with, "an edited command asks again");
        let renamed = vec![("ship".to_string(), SKILL.to_string())];
        assert_ne!(from_sources(SETTINGS, MCP, &renamed).unwrap().hash, with);
        assert_eq!(from_sources("", "", &none), None);
    }

    #[test]
    fn reads_committed_skills_and_commands() {
        let tmp = tempfile::tempdir().unwrap();
        let wt = tmp.path();
        let claude = wt.join(".claude");
        std::fs::create_dir_all(claude.join("skills/deploy")).unwrap();
        std::fs::create_dir_all(claude.join("skills/empty")).unwrap();
        std::fs::create_dir_all(claude.join("commands/db")).unwrap();
        std::fs::write(claude.join("skills/deploy/SKILL.md"), "!`git log -1`").unwrap();
        std::fs::write(claude.join("skills/stray.md"), "!`not a skill`").unwrap();
        std::fs::write(claude.join("commands/db/reset.md"), "```!\ndropdb app\n```").unwrap();
        std::fs::write(claude.join("commands/a.md"), "Today: !`date`").unwrap();
        std::fs::write(claude.join("commands/notes.txt"), "!`not markdown`").unwrap();
        let got = read(wt).unwrap();
        let shells: Vec<(&str, &str)> = got.skill_shells.iter().map(|s| (s.skill.as_str(), s.command.as_str())).collect();
        assert_eq!(shells, vec![("deploy", "git log -1"), ("a", "date"), ("db/reset", "dropdb app")]);
        assert!(got.hooks.is_empty() && got.servers.is_empty());
        // Oversized reads as empty.
        let big = format!("!`git log -1`{}", " ".repeat(MAX_FILE_BYTES as usize));
        std::fs::write(claude.join("skills/deploy/SKILL.md"), big).unwrap();
        assert_eq!(read(wt).unwrap().skill_shells.len(), 2);
    }
}
