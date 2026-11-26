//! What a Talk agent's tool call may reach without asking (#1147): the file
//! tools stay in the workspace, and an MCP tool its server doesn't mark
//! read-only asks first. Each check returns the card the call must pass
//! ([`ToolCard`]) or `None`; the `ApprovalBroker` asks. `run_command` isn't
//! confined here: the command check and the sandbox are its controls.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

/// What a card asks about when it isn't a shell command.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CardKind {
    /// An MCP tool call that may change external state.
    Mcp,
    /// A file tool reading outside the workspace.
    Read,
    /// A file tool writing outside the workspace.
    Write,
}

impl CardKind {
    /// Whether a thread's "don't ask again" may answer a card of this kind.
    /// A file outside the workspace asks every time.
    pub fn grantable(self) -> bool {
        matches!(self, CardKind::Mcp)
    }
}

/// A card a tool call must pass: its body (the MCP tool and its arguments,
/// or the path, never a file's contents), why it asks, what the model reads
/// when the user declines, and whether the path is a well-known credentials
/// location (the card's safe answer then leads).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolCard {
    pub kind: CardKind,
    pub shown: String,
    pub reason: String,
    pub denial: String,
    pub sensitive: bool,
}

/// An MCP card shows a string argument up to this long, a longer one (a
/// comment body, a file) as its length, and at most [`MCP_ARGS_MAX`] in all.
const MCP_ARG_SHOWN: usize = 160;
const MCP_ARGS_MAX: usize = 400;

/// The card for an MCP tool its server does not mark read-only. `label`
/// names the sub-agent that asks.
pub fn mcp_card(label: Option<&str>, tool: &str, input: &Value) -> ToolCard {
    let (reason, denial) = crate::chat_agents::mcp_gate_texts(label, tool);
    ToolCard { kind: CardKind::Mcp, shown: format!("{tool} {}", mcp_args_shown(input)), reason, denial, sensitive: false }
}

/// An MCP call's arguments as its card shows them: JSON, with each long
/// string replaced by its length and anything that looks like a credential
/// redacted (`secret_scan::redact_line`), cut to [`MCP_ARGS_MAX`]. Pure.
pub fn mcp_args_shown(input: &Value) -> String {
    fn elide(v: &Value) -> Value {
        match v {
            Value::String(s) if s.chars().count() > MCP_ARG_SHOWN => Value::String(format!("({} chars)", s.chars().count())),
            Value::Array(a) => Value::Array(a.iter().map(elide).collect()),
            Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), elide(v))).collect()),
            other => other.clone(),
        }
    }
    let json = serde_json::to_string(&elide(input)).unwrap_or_default();
    let shown = crate::secret_scan::redact_line(&json, &[]);
    if shown.len() <= MCP_ARGS_MAX {
        return shown;
    }
    format!("{}\u{2026}", crate::chat_engine::truncate_char_safe(&shown, MCP_ARGS_MAX))
}

/// The director's card for a tool call other than a command: an MCP tool
/// not in `mcp_read_only` (those this turn discovered with `readOnlyHint`,
/// so an undiscovered one asks too), or a file tool reaching outside.
pub fn director_card(
    name: &str,
    input: &Value,
    mcp_read_only: &HashSet<String>,
    reach: &Reach,
    writes_confined: bool,
) -> Option<ToolCard> {
    if crate::mcp::is_mcp_tool(name) {
        return (!mcp_read_only.contains(name)).then(|| mcp_card(None, name, input));
    }
    reach.outside_card(None, name, input, writes_confined)
}

/// Well-known credentials locations under home, and what each holds. Matched
/// without case, since the volume is case-insensitive.
const HOME_SECRETS: &[(&str, &str)] = &[
    (".ssh", "SSH keys"), (".aws", "AWS credentials"), (".config/gh", "GitHub CLI tokens"),
    (".config/gcloud", "Google Cloud credentials"), (".azure", "Azure credentials"), (".kube", "Kubernetes credentials"),
    (".docker", "Docker registry logins"), (".gnupg", "GPG keys"), (".password-store", "a password store"),
    (".netrc", "saved logins"), (".git-credentials", "saved Git credentials"), (".npmrc", "npm tokens"),
    (".pypirc", "PyPI tokens"), (".cargo/credentials", "Cargo registry tokens"),
    (".cargo/credentials.toml", "Cargo registry tokens"), (".octopush", "Octopush's settings and API keys"),
    (".mcp-auth", "MCP server sign-ins"), (".claude/.credentials.json", "Claude Code's sign-in"),
    (".codex/auth.json", "Codex's sign-in"), ("Library/Keychains", "keychains"),
];

/// The same, outside home.
const SYSTEM_SECRETS: &[(&str, &str)] = &[("/Library/Keychains", "keychains")];

/// Whether `path` is `prefix` or inside it, by components and without case.
fn under(path: &Path, prefix: &Path) -> bool {
    let mut p = path.components();
    prefix.components().all(|c| {
        p.next().is_some_and(|q| q.as_os_str().to_string_lossy().to_lowercase() == c.as_os_str().to_string_lossy().to_lowercase())
    })
}

/// Where a Talk turn's file tools may go without asking: the workspace, as
/// the tools join paths onto it and resolved (`None` if it can't be: then
/// every target asks); for reads also its main checkout, where a linked
/// dependency folder points; and home, for the credentials locations.
pub struct Reach {
    workspace: PathBuf,
    root: Option<PathBuf>,
    main_checkout: Option<PathBuf>,
    home: Option<PathBuf>,
}

impl Reach {
    pub fn new(workspace: &Path, home: Option<&Path>) -> Self {
        Self {
            workspace: workspace.to_path_buf(),
            root: std::fs::canonicalize(workspace).ok(),
            main_checkout: crate::codex_trust::main_repo_root(workspace).and_then(|m| std::fs::canonicalize(m).ok()),
            home: home.map(|h| std::fs::canonicalize(h).unwrap_or_else(|_| h.to_path_buf())),
        }
    }

    /// [`Reach::new`] with the user's home.
    pub fn of_workspace(workspace: &Path) -> Self {
        Self::new(workspace, dirs::home_dir().as_deref())
    }

    /// `path` as the card names it: `~/…` under home, else in full.
    fn shown(&self, path: &Path) -> String {
        match self.home.as_deref().and_then(|h| path.strip_prefix(h).ok()) {
            Some(rest) if rest.as_os_str().is_empty() => "~".to_string(),
            Some(rest) => format!("~/{}", rest.display()),
            None => path.display().to_string(),
        }
    }

    /// The credentials location `real` is in (or, when `walks`, holds), as
    /// the card says it, e.g. "~/.ssh holds SSH keys".
    fn secret_location(&self, real: &Path, walks: bool) -> Option<String> {
        let home = self.home.as_deref();
        let places = HOME_SECRETS
            .iter()
            .filter_map(|(rel, why)| home.map(|h| (h.join(rel), *why)))
            .chain(SYSTEM_SECRETS.iter().map(|(p, why)| (PathBuf::from(*p), *why)));
        for (place, why) in places {
            if under(real, &place) {
                return Some(format!("{} holds {why}", self.shown(&place)));
            }
            if walks && under(&place, real) && place.symlink_metadata().is_ok() {
                return Some(format!("the folder holds {} ({why})", self.shown(&place)));
            }
        }
        None
    }

    /// The card a file tool's call must pass, or `None` when its target,
    /// resolved as the tool will open it ([`resolve`]), is inside the
    /// workspace. An absolute path, a `..` or a link that leads out asks. A
    /// credentials location asks even inside (a workspace opened at home),
    /// and outside, a file named like an env file or a key is sensitive too.
    /// `writes_confined`: the mission's sandbox refuses a write outside, so
    /// it doesn't ask. `label` names the sub-agent that asks.
    pub fn outside_card(&self, label: Option<&str>, name: &str, input: &Value, writes_confined: bool) -> Option<ToolCard> {
        let path = |default: &'static str| input.get("path").and_then(|p| p.as_str()).unwrap_or(default).to_string();
        let (kind, verb, act, raw) = match name {
            "read_file" => (CardKind::Read, "reads a file", "read", path("")),
            "list_files" => (CardKind::Read, "lists a folder", "list", path(".")),
            "grep" => (CardKind::Read, "searches", "search", path(".")),
            "write_file" => (CardKind::Write, "writes a file", "write", path("")),
            "edit_file" => (CardKind::Write, "edits a file", "edit", path("")),
            _ => return None,
        };
        if kind == CardKind::Write && writes_confined {
            return None;
        }
        let real = resolve(&self.workspace.join(&raw));
        let reads_main = kind == CardKind::Read && self.main_checkout.as_deref().is_some_and(|m| real.starts_with(m));
        let inside = reads_main || self.root.as_deref().is_some_and(|r| real.starts_with(r));
        let location = self.secret_location(&real, name == "grep");
        if inside && location.is_none() {
            return None;
        }
        let text = real.to_string_lossy();
        let by_name = match (inside, crate::secret_scan::is_env_file(&text), crate::secret_scan::is_sensitive_name(&text)) {
            (true, ..) => None,
            (_, true, _) => Some("its name marks it as an env file"),
            (_, _, true) => Some("its name marks it as a key or credentials file"),
            _ => None,
        };
        let place = if inside { "in a credentials location" } else { "outside the workspace" };
        let why = location.or(by_name.map(str::to_string));
        let mut reason = match &why {
            Some(why) => format!("{verb} {place} \u{b7} {why}"),
            None => format!("{verb} {place}"),
        };
        if let Some(l) = label {
            reason = format!("Sub-agent \u{201c}{l}\u{201d}: {reason}");
        }
        let shown = self.shown(&real);
        let denial = format!(
            "Tool call not made \u{2014} the user declined to let it {act} {shown}, {place}. \
             Work inside the workspace, or ask the user for what you need; do not retry it."
        );
        Some(ToolCard { kind, shown, reason, denial, sensitive: why.is_some() })
    }
}

/// How deep [`resolve`] follows a chain of dangling links.
const MAX_LINK_DEPTH: usize = 16;

/// Where `path` leads, as a file tool opening it gets there: each existing
/// component resolved, symlinks followed (a `..` after a link goes up from
/// its target, as the kernel does), a missing component kept as written, and
/// a dangling link followed to its target (a write through it creates it).
/// Resolved at every component, so a `..` out of a missing folder can't hide
/// a link after it.
pub fn resolve(path: &Path) -> PathBuf {
    resolve_at(path, 0)
}

fn resolve_at(path: &Path, depth: usize) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::Prefix(_) | Component::RootDir => out.push(c.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(name) => {
                out.push(name);
                if let Ok(real) = std::fs::canonicalize(&out) {
                    out = real;
                } else if depth < MAX_LINK_DEPTH {
                    if let Ok(target) = std::fs::read_link(&out) {
                        let base = out.parent().map(Path::to_path_buf).unwrap_or_default();
                        out = resolve_at(&base.join(target), depth + 1);
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A workspace and a home beside it, both resolved (on macOS a temp dir
    /// sits behind the `/var` → `/private/var` link).
    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let (ws, home) = (dir.path().join("ws"), dir.path().join("home"));
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::write(home.join(".ssh/id_ed25519"), "k").unwrap();
        std::fs::write(home.join("notes.txt"), "n").unwrap();
        std::fs::write(ws.join("a.txt"), "a").unwrap();
        let (ws, home) = (std::fs::canonicalize(ws).unwrap(), std::fs::canonicalize(home).unwrap());
        (dir, ws, home)
    }

    fn card(reach: &Reach, tool: &str, path: impl AsRef<Path>) -> Option<ToolCard> {
        reach.outside_card(None, tool, &json!({"path": path.as_ref().to_string_lossy(), "content": "c"}), false)
    }

    #[test]
    fn read_file_of_an_absolute_path_outside_the_workspace_asks() {
        let (_d, ws, home) = setup();
        let reach = Reach::new(&ws, Some(&home));
        let c = card(&reach, "read_file", home.join("notes.txt")).expect("an absolute path outside asks");
        assert_eq!((c.kind, c.shown.as_str(), c.sensitive), (CardKind::Read, "~/notes.txt", false), "it names the path");
        assert_eq!(c.reason, "reads a file outside the workspace");
        assert!(c.denial.contains("~/notes.txt") && c.denial.contains("do not retry"));
        assert_eq!(card(&reach, "read_file", "../home/notes.txt").unwrap().shown, "~/notes.txt", "a `..` out asks too");
    }

    #[test]
    fn a_read_inside_the_workspace_runs_without_a_card() {
        let (_d, ws, home) = setup();
        let reach = Reach::new(&ws, Some(&home));
        let abs = ws.join("a.txt");
        let abs = abs.to_str().unwrap();
        for (tool, path) in [("read_file", "a.txt"), ("read_file", abs), ("list_files", "."), ("grep", "."), ("write_file", "new/dir/b.txt"), ("edit_file", "./a.txt"), ("glob", "/"), ("run_command", "/")] {
            assert_eq!(card(&reach, tool, path), None, "{tool} {path}");
        }
        assert_eq!(reach.outside_card(None, "grep", &json!({"pattern": "x"}), false), None, "no path: the workspace");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_inside_the_workspace_that_points_out_asks() {
        let (_d, ws, home) = setup();
        for (to, at) in [(home.join("notes.txt"), "link.txt"), (home.clone(), "homedir"), (home.join("planted.txt"), "dangling"), (ws.join("a.txt"), "inner")] {
            std::os::unix::fs::symlink(to, ws.join(at)).unwrap();
        }
        let reach = Reach::new(&ws, Some(&home));
        let c = card(&reach, "read_file", "link.txt").unwrap();
        assert_eq!((c.shown.as_str(), c.reason.as_str()), ("~/notes.txt", "reads a file outside the workspace"), "it names where the link leads");
        // A linked folder behind a `..` out of a missing one.
        assert_eq!(card(&reach, "read_file", "nope/../homedir/notes.txt").unwrap().shown, "~/notes.txt");
        // A dangling link: a write through it would create its target.
        let w = card(&reach, "write_file", "dangling").unwrap();
        assert_eq!((w.kind, w.shown.as_str()), (CardKind::Write, "~/planted.txt"));
        assert_eq!(card(&reach, "read_file", "inner"), None, "a link that stays inside runs as before");
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_dependency_folder_reads_from_the_main_checkout_without_a_card() {
        let (d, _, home) = setup();
        let main = std::fs::canonicalize(d.path()).unwrap().join("main");
        let wt = main.join(".octopus-worktrees/wt");
        std::fs::create_dir_all(main.join(".git/worktrees/wt")).unwrap();
        std::fs::create_dir_all(main.join("node_modules/x")).unwrap();
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(main.join(".git/worktrees/wt/commondir"), "../..\n").unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", main.join(".git/worktrees/wt").display())).unwrap();
        std::os::unix::fs::symlink(main.join("node_modules"), wt.join("node_modules")).unwrap();
        let reach = Reach::new(&wt, Some(&home));
        assert_eq!(card(&reach, "read_file", "node_modules/x/index.js"), None);
        assert_eq!(card(&reach, "write_file", "node_modules/x/index.js").map(|c| c.kind), Some(CardKind::Write), "a write there asks");
    }

    #[test]
    fn write_outside_workspace_requires_approval() {
        let (_d, ws, home) = setup();
        let reach = Reach::new(&ws, Some(&home));
        for tool in ["write_file", "edit_file"] {
            let c = card(&reach, tool, home.join("new/plan.md")).unwrap_or_else(|| panic!("{tool} outside asks"));
            assert_eq!((c.kind, c.shown.as_str()), (CardKind::Write, "~/new/plan.md"));
            assert!(!c.kind.grantable(), "no \"don't ask again\" answers it");
        }
        // A sandboxed mission refuses the write itself; a read there still asks.
        let target = json!({"path": home.join("x").to_string_lossy()});
        assert_eq!(reach.outside_card(None, "write_file", &target, true), None);
        assert!(reach.outside_card(None, "read_file", &target, true).is_some());
    }

    #[test]
    fn credentials_locations_are_marked_and_say_why() {
        let (_d, ws, home) = setup();
        let reach = Reach::new(&ws, Some(&home));
        let key = card(&reach, "read_file", home.join(".SSH/id_ed25519")).unwrap();
        assert!(key.sensitive && key.reason == "reads a file outside the workspace \u{b7} ~/.ssh holds SSH keys", "{}", key.reason);
        let grep = card(&reach, "grep", &home).unwrap();
        assert!(grep.sensitive && grep.reason.ends_with("the folder holds ~/.ssh (SSH keys)"), "{}", grep.reason);
        let env = card(&reach, "read_file", "../.env.local").unwrap();
        assert!(env.sensitive && env.reason.ends_with("its name marks it as an env file"));
        assert_eq!(card(&reach, "read_file", ".env"), None, "an env file inside runs as before");
        // A workspace opened at home still asks for ~/.ssh.
        let at_home = Reach::new(&home, Some(&home));
        let c = at_home.outside_card(Some("Scout"), "read_file", &json!({"path": ".ssh/id_ed25519"}), false).unwrap();
        assert!(c.sensitive && c.reason == "Sub-agent \u{201c}Scout\u{201d}: reads a file in a credentials location \u{b7} ~/.ssh holds SSH keys");
        assert_eq!(card(&at_home, "read_file", "notes.txt"), None);
    }

    #[test]
    fn director_mcp_write_requires_approval() {
        let (_d, ws, home) = setup();
        let reach = Reach::new(&ws, Some(&home));
        let read_only: HashSet<String> = ["mcp__github__get_issue".to_string()].into();
        let c = director_card("mcp__github__merge_pr", &json!({"number": 7}), &read_only, &reach, false)
            .expect("a tool without readOnlyHint asks");
        assert_eq!((c.kind, c.shown.as_str()), (CardKind::Mcp, "mcp__github__merge_pr {\"number\":7}"));
        assert!(c.reason.starts_with("MCP tool `mcp__github__merge_pr` may change external state"));
        assert!(c.kind.grantable(), "the thread's \"don't ask again\" may answer it");
        assert!(director_card("mcp__other__thing", &json!({}), &read_only, &reach, false).is_some(), "an undiscovered tool asks");
    }

    #[test]
    fn director_mcp_readonly_runs_without_card() {
        let (_d, ws, home) = setup();
        let reach = Reach::new(&ws, Some(&home));
        let read_only: HashSet<String> = ["mcp__github__get_issue".to_string()].into();
        for (tool, input) in [("mcp__github__get_issue", json!({"number": 7})), ("read_file", json!({"path": "a.txt"}))] {
            assert_eq!(director_card(tool, &input, &read_only, &reach, false), None, "{tool}");
        }
    }

    #[test]
    fn an_mcp_card_shows_short_arguments_never_a_body_or_a_token() {
        let shown = mcp_args_shown(&json!({"repo": "a/b", "body": "x".repeat(500), "token": "ghp_0123456789abcdefghijklmnopqrstuvwxyz"}));
        assert!(shown.contains("\"repo\":\"a/b\"") && shown.contains("\"body\":\"(500 chars)\""), "{shown}");
        assert!(!shown.contains("ghp_0123456789"), "{shown}");
        let long = mcp_args_shown(&json!({"items": (0..200).map(|i| i.to_string()).collect::<Vec<_>>()}));
        assert!(long.chars().count() <= MCP_ARGS_MAX + 1 && long.ends_with('\u{2026}'));
    }
}
