//! MCP (Model Context Protocol) client — connects to local stdio MCP servers,
//! lists their tools, and proxies tool calls into the chat agentic loop.
//!
//! Transport: newline-delimited JSON-RPC 2.0 over the server's stdin/stdout
//! (the MCP stdio transport). Servers are configured in `.claude/mcp.json`
//! (project ∪ user) in the Claude-Code-compatible shape:
//!
//! ```json
//! { "mcpServers": { "<name>": { "command": "…", "args": [...], "env": {...} } } }
//! ```
//!
//! A remote entry written as `{ "type": "http" | "sse", "url": …, "headers": {…} }`
//! is read into the Remote form and runs through the bridge (`remote`); any
//! other entry without a `command` is skipped, and a save keeps it as it was.
//!
//! Tools are surfaced to the model with namespaced names `mcp__<server>__<tool>`
//! so the agentic loop can route a tool_use back to the right server. Servers
//! are spawned lazily on first use and cached (killed on drop). A cached
//! connection is only reused for the config it was started with; saving the
//! config stops every server whose entry changed or was removed
//! (`apply_config_change`), Settings' Reconnect stops one (`reset_server`),
//! and a call that fails on the wire drops its connection so the next call
//! starts a fresh process. A server that fails to start/list is skipped with
//! a warning — it never breaks the chat.
//!
//! NOTE: end-to-end execution requires spawning the configured server binary;
//! the JSON-RPC framing, config parsing, and name (de)namespacing are
//! unit-tested here, but live tool calls need a real MCP server to verify.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::Arc;

pub mod content;
mod failure;
pub mod remote;
pub mod secrets;
pub use failure::{classify_failure, classify_failure_with, McpFailure};
// Per-conversation server scope and the registry's status read (Companion).
pub mod scope;
// A project's own servers start only once approved, bound to content (#1245).
pub mod approval;
// What the user trusts to run without a card in Edit freely (#1243).
pub mod trust;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
pub struct McpServerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Env names whose values live in the login Keychain (`secrets`); their
    /// `env` value is written as `""`, never the secret.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secret_env: Vec<String>,
    /// Env names that look like secrets but the user chose to keep in this
    /// file ("Keep in Keychain" off): the save's migration leaves them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plain_env: Vec<String>,
    /// A remote server's choices in Settings, from which Octopush builds
    /// the bridge in `command`/`args`/`env` (`remote::apply_bridge`). An
    /// entry without it is a local command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<remote::RemoteConfig>,
    /// Every other key of the entry (`cwd`, `type`, `disabled`, another
    /// client's own fields), kept as it was so a save never drops it.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/// A tool exposed by an MCP server, surfaced to the agentic loop.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub server: String,
    pub name: String,
    pub namespaced: String,
    pub description: String,
    pub input_schema: Value,
    /// The server marked the tool read-only (`annotations.readOnlyHint`).
    /// Anything else is treated as a possible write when a sub-agent calls it.
    #[serde(default)]
    pub read_only: bool,
    /// `annotations.destructiveHint` as the server set it (`None`: not set).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destructive: Option<bool>,
    /// The server set `readOnlyHint` or `destructiveHint` (either value).
    /// Only a tool with neither is classified by its name
    /// (`talk_guard::mcp_class`).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub annotated: bool,
}

/// Put tools in the order every request offers them: by server, then by tool
/// name. Neither the config map (a `HashMap`, rebuilt on every read) nor a
/// server's own `tools/list` promises an order, and the tool list is the
/// start of the prompt a provider caches: any reshuffle re-bills the whole
/// conversation at the cache-write price. A server that fails to start just
/// drops out; the others keep their places.
pub fn sort_tools(tools: &mut [McpToolInfo]) {
    tools.sort_by(|a, b| a.server.cmp(&b.server).then_with(|| a.name.cmp(&b.name)));
}

/// The configured servers in name order, so servers start (and fail) in
/// the same order every time.
pub(crate) fn sorted_server_configs(
    worktree: &Path,
    approvals: &dyn approval::ProjectApprovals,
) -> Vec<(String, McpServerConfig)> {
    let mut cfgs: Vec<(String, McpServerConfig)> = load_server_configs(worktree, approvals).into_iter().collect();
    cfgs.sort_by(|a, b| a.0.cmp(&b.0));
    cfgs
}

/// The raw `mcpServers` entries of `.claude/mcp.json` content (empty when the
/// file or the key is malformed).
fn raw_entries(content: &str) -> serde_json::Map<String, Value> {
    #[derive(Deserialize)]
    struct File {
        #[serde(default, rename = "mcpServers")]
        mcp_servers: serde_json::Map<String, Value>,
    }
    serde_json::from_str::<File>(content).map(|f| f.mcp_servers).unwrap_or_default()
}

/// One `mcpServers` entry as Octopush runs it: a local command, or a remote
/// entry in the `{"type": "http" | "sse", "url": …, "headers": {…}}` shape
/// other MCP clients write by hand, read into the Remote form's choices
/// (custom headers when it has any, else browser sign-in) so it runs through
/// the same bridge (`remote::apply_bridge`). `None` for an entry Octopush
/// can't run.
fn parse_entry(value: &Value) -> Option<McpServerConfig> {
    if let Ok(cfg) = serde_json::from_value::<McpServerConfig>(value.clone()) {
        return Some(cfg);
    }
    let mut obj = value.as_object()?.clone();
    let transport = match obj.get("type")?.as_str()? {
        "http" | "streamable-http" => "http-only",
        "sse" => "sse-only",
        _ => return None,
    };
    let url = obj.get("url")?.as_str()?.trim().to_string();
    if url.is_empty() {
        return None;
    }
    let headers: Vec<(String, String)> = match obj.get("headers") {
        None | Some(Value::Null) => Vec::new(),
        Some(h) => h
            .as_object()?
            .iter()
            .map(|(k, v)| Some((k.trim().to_string(), v.as_str()?.to_string())))
            .collect::<Option<_>>()?,
    };
    // Now in `remote` and `env`: a save writes the bridge in their place.
    for key in ["type", "url", "headers"] {
        obj.remove(key);
    }
    obj.insert("command".into(), json!("npx"));
    let mut cfg = serde_json::from_value::<McpServerConfig>(Value::Object(obj)).ok()?;
    for (name, v) in &headers {
        cfg.env.insert(remote::header_env(name), v.clone());
    }
    cfg.remote = Some(remote::RemoteConfig {
        url,
        auth: if headers.is_empty() { "oauth" } else { "headers" }.into(),
        header_names: headers.into_iter().map(|(n, _)| n).collect(),
        transport: transport.into(),
        ..Default::default()
    });
    Some(cfg)
}

/// Parse `.claude/mcp.json` content into a name→config map. Tolerant: a missing
/// or malformed file yields an empty map, and an entry Octopush can't run
/// (`parse_entry`) is skipped without hiding the others.
pub fn parse_mcp_config(content: &str) -> HashMap<String, McpServerConfig> {
    raw_entries(content)
        .iter()
        .filter_map(|(name, v)| match parse_entry(v) {
            Some(cfg) => Some((name.clone(), cfg)),
            None => {
                tracing::warn!(server = %name, "skipping an MCP server entry Octopush can't run");
                None
            }
        })
        .collect()
}

/// The user-level config path (`~/.claude/mcp.json`), if a home dir exists.
fn user_config_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude/mcp.json"))
}

/// Load ONLY the user-level (`~/.claude/mcp.json`) servers — the set the
/// Settings UI manages (project-level `.claude/mcp.json` is repo-committed and
/// edited in the repo, not here).
pub fn load_user_config() -> HashMap<String, McpServerConfig> {
    user_config_path().map(|p| load_config_at(&p)).unwrap_or_default()
}

/// The servers of the config file at `path` (empty when it's missing).
fn load_config_at(path: &Path) -> HashMap<String, McpServerConfig> {
    std::fs::read_to_string(path).map(|c| parse_mcp_config(&c)).unwrap_or_default()
}

/// Persist the user-level server map to `~/.claude/mcp.json` (pretty JSON under
/// the `mcpServers` key, matching the Claude-Code shape).
pub fn save_user_config(servers: &HashMap<String, McpServerConfig>) -> Result<(), String> {
    save_config_at(&user_config_path().ok_or("no home directory")?, servers)
}

/// [`save_user_config`] to the file at `path`.
fn save_config_at(path: &Path, servers: &HashMap<String, McpServerConfig>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Preserve any sibling top-level keys the user keeps in mcp.json — only the
    // `mcpServers` object is ours to rewrite. (Comments aren't preserved; JSON.)
    let content = std::fs::read_to_string(path).ok();
    let mut root = content
        .as_deref()
        .and_then(|c| serde_json::from_str::<serde_json::Value>(c).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    let mut entries = serde_json::to_value(servers).map_err(|e| e.to_string())?;
    // An entry Octopush can't run never reached Settings, so the save keeps
    // it as it was (unless a server now has its name).
    if let (Some(out), Some(c)) = (entries.as_object_mut(), content.as_deref()) {
        for (name, v) in raw_entries(c) {
            if parse_entry(&v).is_none() && !out.contains_key(&name) {
                out.insert(name, v);
            }
        }
    }
    root["mcpServers"] = entries;
    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(path, pretty).map_err(|e| e.to_string())
}

/// The servers Octopush may start for a worktree: the Settings servers, and
/// each server of the worktree's own `.claude/mcp.json` the user approved
/// in its project with exactly this entry (`approval::project_servers`). A
/// project entry never replaces a Settings server of the same name, and one
/// waiting for approval, or changed since, isn't here.
/// A remote entry's bridge is rebuilt from its `remote` choices
/// (`remote::with_bridges`), as Settings' Test and Reconnect do, so a
/// hand-edited `remote` block runs the same in Talk. A project entry can't
/// name Keychain items: its `secret_env` is dropped after the rebuild (which
/// would list a token's), so a repo's file never gets the user's secrets
/// into a command it chose.
pub fn load_server_configs(worktree: &Path, approvals: &dyn approval::ProjectApprovals) -> HashMap<String, McpServerConfig> {
    merge_servers(load_user_config(), worktree, approvals)
}

/// [`load_server_configs`] over the Settings servers `merged`.
fn merge_servers(
    mut merged: HashMap<String, McpServerConfig>,
    worktree: &Path,
    approvals: &dyn approval::ProjectApprovals,
) -> HashMap<String, McpServerConfig> {
    let project: Vec<(String, McpServerConfig)> = approval::project_servers(worktree, &merged, approvals)
        .into_iter()
        .filter(|(s, _)| s.state == approval::ProjectServerState::Approved)
        .map(|(s, cfg)| (s.name, cfg))
        .collect();
    let from_project: Vec<String> = project.iter().map(|(n, _)| n.clone()).collect();
    merged.extend(project);
    let mut merged = remote::with_bridges(merged);
    for name in &from_project {
        if let Some(cfg) = merged.get_mut(name) {
            cfg.secret_env.clear();
        }
    }
    merged
}

/// The servers of Settings › Integrations (`~/.claude/mcp.json`) as they
/// run, remote bridges rebuilt as in [`load_server_configs`], and never a
/// worktree's own `.claude/mcp.json`. What a Direct run pins when it is
/// created (#1134): a stage can only use a server the user configured.
pub fn load_user_servers() -> HashMap<String, McpServerConfig> {
    remote::with_bridges(load_user_config())
}

/// Where a call finds its server's config.
#[derive(Clone, Debug)]
pub enum CallConfigs {
    /// The worktree's servers as they read now (Talk, sub-agents).
    Worktree(std::path::PathBuf),
    /// Configs fixed beforehand and never re-read from a file: a Direct
    /// run's servers, pinned when the run was created.
    Pinned(Arc<HashMap<String, McpServerConfig>>),
}

/// The servers a worktree's own `.claude/mcp.json` defines, as written.
pub fn project_config(worktree: &Path) -> HashMap<String, McpServerConfig> {
    std::fs::read_to_string(worktree.join(".claude/mcp.json")).map(|c| parse_mcp_config(&c)).unwrap_or_default()
}

/// Settings' save of the user-level servers. `new_values` are the secret
/// values the form sent apart from the entries (server → env name →
/// value). Remote bridges are rebuilt, every secret value moves to `store`
/// (`secrets::plan_secrets`, with the migration of plain values that look
/// secret), `mcp.json` is written without them, and items nothing names any
/// more are deleted. Returns the old entries, the saved ones, and the
/// servers whose secret values changed.
#[allow(clippy::type_complexity)]
pub fn save_user_servers(
    servers: HashMap<String, McpServerConfig>,
    new_values: HashMap<String, HashMap<String, String>>,
    renamed: &HashMap<String, String>,
    store: &dyn secrets::SecretStore,
) -> Result<(HashMap<String, McpServerConfig>, HashMap<String, McpServerConfig>, Vec<String>), String> {
    save_servers_at(&user_config_path().ok_or("no home directory")?, servers, new_values, renamed, store)
}

/// [`save_user_servers`] with the config file at `path`. The Keychain is
/// written first: a write it refuses puts back what was written and stops
/// the save before the file is touched; a file write that fails then puts
/// the Keychain back too. Only after the file is written are unused items
/// deleted.
#[allow(clippy::type_complexity)]
fn save_servers_at(
    path: &Path,
    mut servers: HashMap<String, McpServerConfig>,
    new_values: HashMap<String, HashMap<String, String>>,
    renamed: &HashMap<String, String>,
    store: &dyn secrets::SecretStore,
) -> Result<(HashMap<String, McpServerConfig>, HashMap<String, McpServerConfig>, Vec<String>), String> {
    secrets::merge_new_values(&mut servers, new_values);
    let mut servers = remote::with_bridges(servers);
    let old = load_config_at(path);
    let plan = secrets::plan_secrets(&old, &mut servers, renamed);
    secrets::check_names(&servers)?;
    let undo = secrets::apply_before_save(store, &plan)?;
    if let Err(e) = save_config_at(path, &servers) {
        undo.revert(store);
        return Err(e);
    }
    secrets::apply_after_save(store, &plan);
    Ok((old, servers, plan.touched))
}

/// The renames a save really made (`renamed`: new name → old), as old →
/// new pairs sorted by the old name: the old name was saved before and is
/// gone now, and the new one is saved now.
pub fn real_renames(
    old: &HashMap<String, McpServerConfig>,
    new: &HashMap<String, McpServerConfig>,
    renamed: &HashMap<String, String>,
) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = renamed
        .iter()
        .filter(|(to, from)| to != from && old.contains_key(*from) && !new.contains_key(*from) && new.contains_key(*to))
        .map(|(to, from)| (from.clone(), to.clone()))
        .collect();
    pairs.sort();
    pairs
}

/// The servers whose entry differs between two configs: changed, removed or
/// added, sorted by name. These are the ones a save must stop.
pub fn changed_servers(
    old: &HashMap<String, McpServerConfig>,
    new: &HashMap<String, McpServerConfig>,
) -> Vec<String> {
    let mut names: Vec<String> = old
        .keys()
        .chain(new.keys())
        .filter(|n| old.get(*n) != new.get(*n))
        .cloned()
        .collect();
    names.sort();
    names.dedup();
    names
}

/// How a server is started: the program to run, and the PATH its process
/// gets (`None` when the server's own `env` sets PATH, which wins).
#[derive(Debug, PartialEq, Eq)]
struct SpawnPlan {
    program: std::path::PathBuf,
    path: Option<String>,
}

/// Resolve a server's command the way CLI stages resolve theirs.
/// `search_path` is the PATH CLI stages spawn with
/// (`cli_runner::resolved_cli_path`: the login shell's ∪ the app's ∪ common
/// bin dirs). An absolute command's own dir goes first, so a script such as
/// an nvm `npx` finds its sibling `node` through `/usr/bin/env`. A bare
/// command is looked up on the PATH the process will get; a command with a
/// slash is run as given.
fn spawn_plan(cfg: &McpServerConfig, search_path: &str) -> Result<SpawnPlan, String> {
    use crate::orchestrator::cli_runner::{merge_path_dirs, resolve_executable};
    let own = cfg.env.get("PATH");
    let child_path = match own {
        Some(p) => p.clone(),
        None => {
            let command = Path::new(&cfg.command);
            let own_dir = match command.parent() {
                Some(dir) if command.is_absolute() => dir.display().to_string(),
                _ => String::new(),
            };
            // Only absolute dirs: a relative one would resolve against
            // whatever the server's working directory is.
            merge_path_dirs(&[&own_dir, search_path])
                .split(':')
                .filter(|d| Path::new(d).is_absolute())
                .collect::<Vec<_>>()
                .join(":")
        }
    };
    // A remote entry's bridge saved an absolute `npx`; one that has since
    // moved (a Node upgrade under nvm) is looked up again on the PATH.
    let command = match cfg.remote {
        Some(_) if cfg.command.contains('/') && !Path::new(&cfg.command).exists() => "npx",
        _ => cfg.command.as_str(),
    };
    let program = if command.contains('/') {
        std::path::PathBuf::from(command)
    } else {
        resolve_executable(command, &child_path).ok_or_else(|| {
            let whose = if own.is_some() { "the server's own PATH" } else { "the PATH Octopush searched" };
            format!(
                "Octopush couldn't find `{command}` on {whose} ({child_path}). Use its full path (run `which {command}` in Terminal)."
            )
        })?
    };
    Ok(SpawnPlan { program, path: own.is_none().then_some(child_path) })
}

/// What the model is told when Octopush's connection to a server failed. The
/// first line of `reason` is the cause; any further lines (the server's own
/// stdout/stderr) follow the advice as a separate block.
pub fn connection_failure_text(server: &str, reason: &str) -> String {
    let reason = reason.trim();
    let (summary, detail) = match reason.split_once('\n') {
        Some((s, d)) => (s.trim(), d.trim()),
        None => (reason, ""),
    };
    let summary = summary.trim_end_matches('.');
    let summary = if summary.is_empty() { "unknown error" } else { summary };
    let mut text = format!(
        "Octopush's connection to {server} failed: {summary}. The user can reconnect it in Settings › Integrations."
    );
    if !detail.is_empty() {
        text.push_str("\n\nServer output:\n");
        text.push_str(&server_output(detail));
    }
    text
}

/// The most of a server's own output the model is shown, in bytes.
const SERVER_OUTPUT_CAP: usize = 1024;

/// An OAuth `code=` parameter (an auth URL a bridge such as mcp-remote prints).
static AUTH_CODE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)\bcode=([^\s&]+)").unwrap());

/// `Basic <base64>` credentials (an Authorization header's value).
static BASIC_AUTH: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)\bbasic\s+([A-Za-z0-9+/=._~-]{6,})").unwrap());
/// A bare JWT (`eyJ….eyJ….sig`): an id, access or refresh token.
static BARE_JWT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*").unwrap()
});
/// A quoted value under a secret-ish key, however short:
/// `"client_secret": "…"`, `'password':'…'`, `"refresh_token":"…"`.
static QUOTED_SECRET: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(
        r#"(?i)["']?[A-Za-z0-9_.\-]*(?:secret|passw(?:or)?d|token|api[_\-]?key|apikey|authorization|credential|private[_\-]?key|cookie)[A-Za-z0-9_.\-]*["']?\s*[:=]\s*["']([^"']+)["']"#,
    )
    .unwrap()
});
/// A header line under a secret-ish name: `X-API-Key: …`,
/// `Authorization: Basic …` (after mcp-remote's `[pid]` prefix, if any).
/// Group 1 is the name, so an error class (`InvalidTokenError: …`) keeps
/// its message.
static SECRET_HEADER: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)^\s*(?:\[\d+\]\s*)*([A-Za-z0-9_\-]*(?:authorization|api[_\-]?key|apikey|token|secret|passw(?:or)?d|cookie)[A-Za-z0-9_\-]*)\s*:\s*(\S.*)$",
    )
    .unwrap()
});
/// An env name that reads as a credential.
static SECRET_ENV_NAME: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"(?i)TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH|BEARER|CREDENTIAL|PRIVATE").unwrap()
});

/// Whether an env name reads as a credential's (`SECRET_ENV_NAME`).
pub(crate) fn secret_env_name(key: &str) -> bool {
    SECRET_ENV_NAME.is_match(key)
}

/// A value that looks like base64 rather than a word: a digit or `+/=`, or
/// a capital after its first character beside a lower-case letter.
fn looks_base64(v: &str) -> bool {
    v.chars().count() >= 8
        && (v.chars().any(|c| c.is_ascii_digit() || matches!(c, '+' | '/' | '='))
            || (v.chars().skip(1).any(|c| c.is_ascii_uppercase()) && v.chars().any(|c| c.is_ascii_lowercase())))
}

/// `line` with capture `group` of every match of `re` replaced by
/// `secret_scan::REDACTED`.
fn redact_group(line: &str, re: &regex::Regex, group: usize) -> String {
    let mut out = String::with_capacity(line.len());
    let mut last = 0;
    for c in re.captures_iter(line) {
        if let Some(m) = c.get(group) {
            out.push_str(&line[last..m.start()]);
            out.push_str(crate::secret_scan::REDACTED);
            last = m.end();
        }
    }
    out.push_str(&line[last..]);
    out
}

/// One line of a server's output with token-like values redacted, for the
/// model or for Settings' details: `known` values (the server's own env,
/// `known_secrets`), what `secret_scan::redact_line` catches (provider key
/// prefixes, `TOKEN=…`, `Bearer …`, URL passwords), OAuth `code=…`, `Basic
/// …`, bare JWTs, quoted values under secret-ish keys and header lines with
/// secret-ish names. A best effort for text shown on screen: a secret in a
/// shape none of these covers can still get through.
pub(crate) fn redact_output_line(line: &str, known: &[crate::secret_scan::KnownSecret]) -> String {
    use crate::secret_scan::REDACTED;
    let line = crate::secret_scan::redact_line(line, known);
    let line = AUTH_CODE.replace_all(&line, format!("code={REDACTED}")).into_owned();
    let line = redact_matching(&line, &BASIC_AUTH, |c| c.get(1).filter(|m| looks_base64(m.as_str())));
    let line = BARE_JWT.replace_all(&line, REDACTED).into_owned();
    let line = redact_group(&line, &QUOTED_SECRET, 1);
    redact_matching(&line, &SECRET_HEADER, |c| {
        let name = c.get(1)?.as_str().to_ascii_lowercase();
        if name.ends_with("error") || name.ends_with("exception") {
            return None;
        }
        c.get(2)
    })
}

/// `line` with the span `pick` chooses in each match of `re` (if any)
/// replaced by `secret_scan::REDACTED`.
fn redact_matching<'h>(
    line: &'h str,
    re: &regex::Regex,
    pick: impl Fn(&regex::Captures<'h>) -> Option<regex::Match<'h>>,
) -> String {
    let mut out = String::with_capacity(line.len());
    let mut last = 0;
    for c in re.captures_iter(line) {
        if let Some(m) = pick(&c) {
            out.push_str(&line[last..m.start()]);
            out.push_str(crate::secret_scan::REDACTED);
            last = m.end();
        }
    }
    out.push_str(&line[last..]);
    out
}

/// Whether env var `key`'s value could be a credential:
/// - a remote bridge's header or client-secret value, always;
/// - under a name that reads as one (`SECRET_ENV_NAME`), unless a path or
///   a plain number;
/// - a URL with a path or a query (a webhook URL carries its secret there);
/// - long, mixing letters and digits, and not a host or path.
///
/// A bare host, a plain word (`production`), a path or a number stays
/// readable, so a DNS failure can still name its host. Never PATH.
fn could_be_credential(key: &str, value: &str) -> bool {
    let v = value.trim();
    // Shorter values would redact every occurrence of a common string.
    if key == "PATH" || v.chars().count() < 4 {
        return false;
    }
    if key.starts_with(remote::HEADER_ENV_PREFIX) || key == remote::CLIENT_SECRET_ENV {
        return true;
    }
    let path_or_number = v.starts_with(['/', '~', '.']) || v.chars().all(|c| c.is_ascii_digit());
    if path_or_number {
        return false;
    }
    if SECRET_ENV_NAME.is_match(key) {
        return true;
    }
    if let Some((_, rest)) = v.split_once("://") {
        let path = rest.split_once('/').map_or("", |(_, p)| p);
        return !path.is_empty() || rest.contains('?');
    }
    v.chars().count() >= 20
        && v.chars().any(|c| c.is_ascii_digit())
        && v.chars().any(|c| c.is_ascii_alphabetic())
        && !v.contains(['.', '/', ':', ' '])
}

/// The server's own env values that could be credentials
/// (`could_be_credential`), to redact wherever they echo. A `Bearer …` or
/// `Basic …` value is also known without its scheme, since a server may
/// echo the bare token.
pub(crate) fn known_secrets(cfg: &McpServerConfig) -> Vec<crate::secret_scan::KnownSecret> {
    let mut known = Vec::new();
    for (k, v) in cfg.env.iter().filter(|(k, v)| could_be_credential(k, v)) {
        let v = v.trim();
        known.push(crate::secret_scan::KnownSecret::new(format!("env {k}"), v));
        let lower = v.to_ascii_lowercase();
        for scheme in ["bearer ", "basic "] {
            if lower.starts_with(scheme) {
                let bare = v[scheme.len()..].trim();
                if bare.chars().count() >= 4 {
                    known.push(crate::secret_scan::KnownSecret::new(format!("env {k}"), bare));
                }
            }
        }
    }
    known
}

/// `text` redacted line by line ([`redact_output_line`]).
pub(crate) fn redact_text(text: &str, known: &[crate::secret_scan::KnownSecret]) -> String {
    text.lines().map(|l| redact_output_line(l, known)).collect::<Vec<_>>().join("\n")
}

/// A server's stdout/stderr as the model may read it: redacted line by line
/// (`redact_output_line`), then cut to its last [`SERVER_OUTPUT_CAP`] bytes
/// from a line start, where the error usually is.
fn server_output(detail: &str) -> String {
    let redacted: Vec<String> = detail.lines().map(|l| redact_output_line(l, &[])).collect();
    let text = redacted.join("\n");
    if text.len() <= SERVER_OUTPUT_CAP {
        return text;
    }
    let mut start = text.len() - SERVER_OUTPUT_CAP;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let tail = &text[start..];
    let tail = tail.split_once('\n').map_or(tail, |(_, rest)| rest);
    format!("… (earlier output cut)\n{tail}")
}

/// Why an MCP call failed. Decides what happens to the cached connection and
/// what the model is told (`Display`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpCallError {
    /// Octopush's connection to the server failed: it could not start, its
    /// handshake failed, the process exited or the pipe broke. The cached
    /// connection is dropped, so the next call starts the server again; this
    /// call is not retried.
    Connection { server: String, reason: String },
    /// The server answered the call with a JSON-RPC error. It is alive, so
    /// its connection stays.
    Server { server: String, message: String },
    /// No server of that name is configured for the worktree.
    NotConfigured { server: String },
    /// The name isn't `mcp__<server>__<tool>`.
    NotMcpTool(String),
}

impl std::fmt::Display for McpCallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connection { server, reason } => f.write_str(&connection_failure_text(server, reason)),
            Self::Server { server, message } => write!(
                f,
                "{server} answered with an error: {message}. If it keeps failing, the user can \
                 reconnect it in Settings › Integrations."
            ),
            Self::NotConfigured { server } => write!(
                f,
                "No MCP server named {server} is configured for this project. Talk's MCP servers \
                 are managed in Settings › Integrations."
            ),
            Self::NotMcpTool(name) => write!(f, "{name} is not an MCP tool name."),
        }
    }
}

/// How one JSON-RPC request failed.
#[derive(Debug)]
enum RpcError {
    /// The wire broke: a write or read failed, or the server closed its
    /// stdout (it exited). The connection is unusable.
    Transport(String),
    /// The server answered with a JSON-RPC `error` — it is alive and speaking
    /// the protocol.
    Server(String),
}

impl From<RpcError> for String {
    fn from(e: RpcError) -> String {
        match e {
            RpcError::Transport(m) | RpcError::Server(m) => m,
        }
    }
}

/// `mcp__<server>__<tool>`.
pub fn namespaced_name(server: &str, tool: &str) -> String {
    format!("mcp__{server}__{tool}")
}

/// Parse a namespaced tool name back into `(server, tool)`, or None if it isn't
/// an MCP tool name.
pub fn parse_namespaced(name: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix("mcp__")?;
    let idx = rest.find("__")?;
    Some((rest[..idx].to_string(), rest[idx + 2..].to_string()))
}

/// Is this tool name routed to an MCP server?
pub fn is_mcp_tool(name: &str) -> bool {
    name.starts_with("mcp__")
}

/// The server process, behind its own lock so it can be killed while a
/// request holds the connection lock (a hung `read_line` inside `request`
/// would otherwise keep the process alive for as long as the server likes).
type ChildHandle = Arc<Mutex<Child>>;

/// The process one bounded call is using (`call_bounded`), so its timeout
/// stops that process and no other.
type CallTarget = Arc<Mutex<Target>>;

#[derive(Default)]
struct Target {
    /// Set once the call has its connection, before it sends its request.
    child: Option<ChildHandle>,
    /// The bound passed: a call that gets its connection only now never
    /// sends its request.
    aborted: bool,
}

struct Connection {
    child: ChildHandle,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
    next_id: i64,
    tools: Vec<McpToolInfo>,
    /// Stderr drained by a background thread; included in "closed the connection"
    /// errors so bridge tools (e.g. mcp-remote) can surface auth/network failures.
    stderr_log: Arc<Mutex<StderrLog>>,
}

impl Connection {
    /// Send a JSON-RPC request and block until the matching-id response,
    /// skipping any interleaved notifications.
    fn request(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id;
        self.next_id += 1;
        let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.write_message(&req)
            .map_err(|e| RpcError::Transport(format!("couldn't write to the server: {e}")))?;
        // Non-JSON stdout lines collected for diagnostics (bridge tools like
        // mcp-remote print auth URLs and status to stdout before the handshake).
        let mut stdout_lines: Vec<String> = Vec::new();
        loop {
            let mut buf = String::new();
            let n = self
                .reader
                .read_line(&mut buf)
                .map_err(|e| RpcError::Transport(format!("couldn't read from the server: {e}")))?;
            if n == 0 {
                let stderr = self.stderr_log.lock().text();
                let stderr = stderr.trim();
                let stdout = stdout_lines.join("\n");
                let stdout = stdout.trim();
                let mut parts: Vec<&str> = vec!["MCP server closed the connection"];
                if !stdout.is_empty() {
                    parts.push(stdout);
                }
                if !stderr.is_empty() {
                    parts.push(stderr);
                }
                return Err(RpcError::Transport(parts.join("\n")));
            }
            let Ok(msg) = serde_json::from_str::<Value>(buf.trim()) else {
                // Collect non-JSON lines (bridge tools may print auth/status here).
                let line = buf.trim().to_string();
                if !line.is_empty() && stdout_lines.len() < 20 {
                    stdout_lines.push(line);
                }
                continue;
            };
            if msg.get("id").and_then(|v| v.as_i64()) == Some(id) {
                if let Some(err) = msg.get("error") {
                    return Err(RpcError::Server(err.to_string()));
                }
                return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
            }
            // A server→client REQUEST (has both id and method, e.g.
            // sampling/createMessage, roots/list) — reply method-not-found so
            // the server isn't left blocked waiting on us (which would deadlock
            // our own read). Plain notifications (method, no id) are ignored.
            if msg.get("method").is_some() {
                if let Some(req_id) = msg.get("id") {
                    let _ = self.write_message(&json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": { "code": -32601, "message": "method not supported" }
                    }));
                }
            }
        }
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write_message(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    fn write_message(&mut self, msg: &Value) -> Result<(), String> {
        let line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        self.stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        self.stdin.write_all(b"\n").map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Kill AND reap a server process — std's Child doesn't wait on drop, so
/// without the wait a killed server lingers as a zombie. The server is
/// spawned in its own process group, and the whole group is killed: a
/// wrapper (`npx`, a shell) hands its stdout pipe to the real server, and
/// killing only the wrapper would leave that pipe open — and our reader
/// blocked — for as long as the grandchild lives.
fn kill_and_reap(child: &ChildHandle) {
    let mut c = child.lock();
    // Only while the child is unreaped: a reaped pid is free for reuse, and
    // the group signal is raw (std's `kill` guards itself, this must too).
    // The handle is shared, so a second caller after the reap is normal.
    if !matches!(c.try_wait(), Ok(None)) {
        return;
    }
    #[cfg(unix)]
    {
        let pgid = c.id() as libc::pid_t;
        if pgid > 0 {
            // SAFETY: plain syscall on a pid that is still ours — the child is
            // unreaped (checked above), so the number cannot have been reused.
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        }
    }
    let _ = c.kill();
    let _ = c.wait();
}

impl Drop for Connection {
    fn drop(&mut self) {
        kill_and_reap(&self.child);
    }
}

/// A live server: the connection (locked for the length of a request) and
/// its process handle (reachable without that lock — what an abort kills).
/// Kept together so the two can never describe different processes.
struct Entry {
    conn: Arc<Mutex<Connection>>,
    child: ChildHandle,
    /// The config the process was started with: the entry serves only
    /// callers asking for that same config (`cached`).
    cfg: McpServerConfig,
}

/// A server that failed to start, remembered with the config that failed.
struct Failure {
    cfg: McpServerConfig,
    reason: String,
}

/// The most of a server's stderr kept from its start, and from its end, in
/// bytes: the head says what it was doing, the tail how it failed (a late
/// "Fatal error" after a long log).
const STDERR_HEAD: usize = 2048;
const STDERR_TAIL: usize = 2048;

/// A server's stderr, bounded: its first [`STDERR_HEAD`] bytes of lines and
/// its last [`STDERR_TAIL`] bytes of lines, with a count of what fell between.
#[derive(Default)]
struct StderrLog {
    head: String,
    tail: std::collections::VecDeque<String>,
    tail_bytes: usize,
    cut: usize,
}

impl StderrLog {
    fn push(&mut self, line: &str) {
        if self.tail.is_empty() && self.head.len() + line.len() < STDERR_HEAD {
            self.head.push_str(line);
            self.head.push('\n');
            return;
        }
        // A single line longer than the tail keeps its end (and its newline fits).
        let line = if line.len() >= STDERR_TAIL {
            let mut start = line.len() - (STDERR_TAIL - 1);
            while !line.is_char_boundary(start) {
                start += 1;
            }
            &line[start..]
        } else {
            line
        };
        self.tail_bytes += line.len() + 1;
        self.tail.push_back(line.to_string());
        while self.tail_bytes > STDERR_TAIL {
            match self.tail.pop_front() {
                Some(old) => {
                    self.tail_bytes -= old.len() + 1;
                    self.cut += 1;
                }
                None => break,
            }
        }
    }

    fn text(&self) -> String {
        let mut out = self.head.clone();
        if self.cut > 0 {
            let s = if self.cut == 1 { "" } else { "s" };
            out.push_str(&format!("… ({} line{s} cut)\n", self.cut));
        }
        for line in &self.tail {
            out.push_str(line);
            out.push('\n');
        }
        out
    }
}

/// Drain `stderr` into `log` (bounded, `StderrLog`). Runs on a dedicated
/// thread per server so the child process is never blocked writing
/// diagnostics.
fn drain_stderr(stderr: ChildStderr, log: Arc<Mutex<StderrLog>>) {
    let reader = BufReader::new(stderr);
    for line in reader.lines().map_while(Result::ok) {
        log.lock().push(&line);
    }
}

/// Holds live connections to MCP servers, keyed by server name.
pub struct McpRegistry {
    conns: Mutex<HashMap<String, Entry>>,
    /// Processes spawned whose handshake has not finished yet — abortable
    /// while `connect` is still reading, which would otherwise hang the
    /// per-server connect lock for every later caller.
    pending: Mutex<HashMap<String, ChildHandle>>,
    /// One lock per server around spawn + handshake, so two callers racing to
    /// a not-yet-connected server spawn it once, not twice.
    connecting: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Servers that failed to start this session — skipped on subsequent turns
    /// so a broken config doesn't re-spawn a failing process every turn. Only
    /// while the config is the one that failed: an edited entry is tried
    /// again, and a reset forgets the failure.
    failed: Mutex<HashMap<String, Failure>>,
    /// Per-server reset count (`reset_server`). A start that began before a
    /// reset neither caches its connection nor records its failure, so a
    /// save or Reconnect racing a first call can't leave the old config's
    /// process (or its failure) behind.
    ///
    /// Lock order: `conns` or `failed` may be held while taking `resets`,
    /// never the other way round.
    resets: Mutex<HashMap<String, u64>>,
    /// Where an entry's `secret_env` values are read at spawn.
    secrets: Arc<dyn secrets::SecretStore>,
    /// Which of a project's own servers the user approved (#1245). Read
    /// without holding any of the locks above.
    approvals: Arc<dyn approval::ProjectApprovals>,
}

/// How long one MCP `tools/call` may take on the wire before the caller
/// gives up and stops the server (`call_bounded`).
pub const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// The server a namespaced tool name belongs to.
pub fn server_of(namespaced: &str) -> Option<String> {
    parse_namespaced(namespaced).map(|(s, _)| s)
}

/// `registry.call(...)` off the async runtime, bounded by `bound`, with the
/// error as the model reads it (`McpCallError`'s `Display`). On a timeout
/// the server process the call was using is **stopped** (`abort_call`: that
/// connection's process, or the start it waited on), so a call reported as
/// timed out can never complete later in the background — the blocked
/// worker gets EOF and returns, and the next call re-spawns the server. The
/// error says so, and warns that a request the server had already sent (a
/// write to a tracker) may still have landed. A result comes back rendered
/// (`content::McpOutput`): the text the model reads, and the original when
/// a binary payload in it was replaced.
pub async fn call_bounded(
    registry: Arc<McpRegistry>,
    worktree: std::path::PathBuf,
    namespaced: String,
    input: Value,
    bound: std::time::Duration,
) -> Result<content::McpOutput, String> {
    call_bounded_from(registry, CallConfigs::Worktree(worktree), namespaced, input, bound).await
}

/// [`call_bounded`] with the server's config taken from `configs`.
pub async fn call_bounded_from(
    registry: Arc<McpRegistry>,
    configs: CallConfigs,
    namespaced: String,
    input: Value,
    bound: std::time::Duration,
) -> Result<content::McpOutput, String> {
    let reg = Arc::clone(&registry);
    let name = namespaced.clone();
    let target = CallTarget::default();
    let t = Arc::clone(&target);
    let work = tokio::task::spawn_blocking(move || match &configs {
        CallConfigs::Worktree(worktree) => reg.call_on(&reg.configs(worktree), &name, &input, Some(&t)),
        CallConfigs::Pinned(pinned) => reg.call_on(pinned, &name, &input, Some(&t)),
    });
    match tokio::time::timeout(bound, work).await {
        Ok(Ok(Ok(out))) => Ok(out),
        Ok(Ok(Err(e))) => Err(e.to_string()),
        Ok(Err(e)) => Err(format!("MCP error: call task failed: {e}")),
        Err(_) => {
            let server = server_of(&namespaced);
            if let Some(server) = server.clone() {
                // Kill + reap off the runtime thread.
                let reg = Arc::clone(&registry);
                let _ = tokio::task::spawn_blocking(move || reg.abort_call(&server, &target)).await;
            }
            Err(format!(
                "{} The server was stopped, so this call cannot complete later; if it had already \
                 sent its request, the change may exist — check before retrying.",
                connection_failure_text(
                    server.as_deref().unwrap_or(&namespaced),
                    &format!("`{namespaced}` timed out after {}s", bound.as_secs()),
                )
            ))
        }
    }
}

impl McpRegistry {
    pub fn new() -> Self {
        Self::with_secrets(secrets::keychain())
    }

    /// A registry reading secrets from `store` (the Keychain in the app).
    pub fn with_secrets(store: Arc<dyn secrets::SecretStore>) -> Self {
        Self {
            conns: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            connecting: Mutex::new(HashMap::new()),
            failed: Mutex::new(HashMap::new()),
            resets: Mutex::new(HashMap::new()),
            secrets: store,
            approvals: Arc::new(approval::NoApprovals),
        }
    }

    /// Start a project's own servers once the user approved them, as
    /// `approvals` records (#1245). Without it, none ever starts.
    pub fn with_approvals(mut self, approvals: Arc<dyn approval::ProjectApprovals>) -> Self {
        self.approvals = approvals;
        self
    }

    /// Tests of the registry itself: every project server counts as approved.
    #[cfg(test)]
    pub fn trusting_projects() -> Self {
        Self::new().with_approvals(Arc::new(approval::TrustAll))
    }

    /// The servers this registry may start for `worktree`
    /// ([`load_server_configs`] with its approvals).
    pub fn configs(&self, worktree: &Path) -> HashMap<String, McpServerConfig> {
        load_server_configs(worktree, &*self.approvals)
    }

    /// [`Self::configs`] in name order.
    pub(crate) fn sorted_configs(&self, worktree: &Path) -> Vec<(String, McpServerConfig)> {
        sorted_server_configs(worktree, &*self.approvals)
    }

    /// The worktree's own servers and where each stands (approved, waiting,
    /// changed since approved, or clashing with a Settings server).
    pub fn project_servers(&self, worktree: &Path) -> Vec<approval::ProjectServer> {
        approval::project_servers(worktree, &load_user_config(), &*self.approvals).into_iter().map(|(s, _)| s).collect()
    }

    fn reset_count(&self, name: &str) -> u64 {
        self.resets.lock().get(name).copied().unwrap_or(0)
    }

    /// The cached connection and its process, if it was started with `cfg`.
    /// One started with another config is stale (the file was edited, or a
    /// project's config names the server differently): it is forgotten here,
    /// and its process ends when the last call still using it lets go — or
    /// when such a call times out (`abort_connection` holds its handle).
    fn cached(&self, name: &str, cfg: &McpServerConfig) -> Option<(Arc<Mutex<Connection>>, ChildHandle)> {
        let mut conns = self.conns.lock();
        match conns.get(name) {
            Some(e) if &e.cfg == cfg => return Some((Arc::clone(&e.conn), Arc::clone(&e.child))),
            Some(_) => {}
            None => return None,
        }
        let stale = conns.remove(name);
        // The process may be killed and reaped as the entry drops: never
        // under the registry lock.
        drop(conns);
        drop(stale);
        None
    }

    /// Drop a server's cached connection after IT errored — only when the
    /// cached one is still `conn` (a sibling may have re-spawned the server
    /// in the meantime; that fresh connection must not be thrown away). The
    /// process itself is killed when the last holder lets go
    /// (`Connection::drop`).
    fn evict_if_current(&self, name: &str, conn: &Arc<Mutex<Connection>>) {
        let mut conns = self.conns.lock();
        if conns.get(name).is_some_and(|e| Arc::ptr_eq(&e.conn, conn)) {
            conns.remove(name);
        }
    }

    /// Stop the process a timed-out call was using — kill it and forget its
    /// connection if it is still the cached one — even while the request is
    /// blocked reading. That reader gets EOF and returns an error; the next
    /// call re-spawns the server. Only that process: one started since with
    /// another config (an entry edited by hand, or a worktree that defines
    /// the server differently) keeps running.
    fn abort_connection(&self, name: &str, child: &ChildHandle) {
        let mut conns = self.conns.lock();
        let live = match conns.get(name) {
            Some(e) if Arc::ptr_eq(&e.child, child) => conns.remove(name),
            _ => None,
        };
        drop(conns);
        tracing::warn!(server = %name, reason = "a call timed out", "stopping MCP server");
        kill_and_reap(child);
        drop(live);
    }

    /// Stop a server's start in progress (its handshake), for a call that
    /// timed out before it had a connection. A live connection is left alone:
    /// it isn't the one that call was waiting on.
    fn abort_start(&self, name: &str) {
        let pending = self.pending.lock().get(name).cloned();
        if let Some(child) = pending {
            tracing::warn!(server = %name, reason = "a call timed out while it started", "stopping MCP server");
            kill_and_reap(&child);
        }
    }

    /// After `call_bounded`'s bound: stop what the call was using, and make
    /// sure it never sends its request if it hadn't yet.
    fn abort_call(&self, name: &str, target: &CallTarget) {
        let child = {
            let mut t = target.lock();
            t.aborted = true;
            t.child.take()
        };
        match child {
            Some(child) => self.abort_connection(name, &child),
            None => self.abort_start(name),
        }
    }

    /// Kill a server's live and starting processes and forget its
    /// connection. Never takes a connection's own lock, so a request blocked
    /// on it can't hold this up: it gets EOF and returns an error.
    fn stop(&self, name: &str, why: &str) {
        let live = self.conns.lock().remove(name);
        let pending = self.pending.lock().get(name).cloned();
        for child in live.iter().map(|e| &e.child).chain(pending.iter()) {
            tracing::warn!(server = %name, reason = why, "stopping MCP server");
            kill_and_reap(child);
        }
    }

    /// Start a server over: stop its process (a call in flight on it fails),
    /// cancel a start in progress, and forget a failure, so the next use
    /// spawns it from its current config. Used when its config changes
    /// (`apply_config_change`) and by Settings' Reconnect.
    pub fn reset_server(&self, name: &str) {
        // Count the reset first: a start still running past this point
        // sees it and discards its process (or its failure).
        *self.resets.lock().entry(name.to_string()).or_insert(0) += 1;
        self.stop(name, "reset");
        self.failed.lock().remove(name);
    }

    /// After the user-level config was saved: reset every server whose entry
    /// changed or was removed (or was added, which forgets an old failure
    /// under that name). Returns the names reset.
    pub fn apply_config_change(
        &self,
        old: &HashMap<String, McpServerConfig>,
        new: &HashMap<String, McpServerConfig>,
    ) -> Vec<String> {
        let changed = changed_servers(old, new);
        for name in &changed {
            self.reset_server(name);
        }
        changed
    }

    /// [`Self::apply_config_change`], then also reset every server in
    /// `touched` (its secret values changed, so its entry reads the same
    /// but its process holds the old ones). Returns the names reset.
    pub fn apply_save(
        &self,
        old: &HashMap<String, McpServerConfig>,
        new: &HashMap<String, McpServerConfig>,
        touched: &[String],
    ) -> Vec<String> {
        let mut reset = self.apply_config_change(old, new);
        let more: Vec<String> = touched.iter().filter(|n| !reset.contains(n)).cloned().collect();
        for name in more {
            self.reset_server(&name);
            reset.push(name);
        }
        reset.sort();
        reset
    }

    /// A call's connection failure as the model may read it: the server's
    /// own env values and its Keychain values redacted.
    fn redact_call_failure(&self, server: &str, cfg: &McpServerConfig, reason: &str) -> String {
        let values = secrets::resolve(server, cfg, &*self.secrets).unwrap_or_default();
        redact_text(&secrets::scrub(reason, &values), &known_secrets(cfg))
    }

    /// Spawn a server, run the MCP initialize handshake, and fetch its tools.
    /// The process is registered as `pending` for the length of the
    /// handshake so an abort can reach it.
    fn connect(&self, name: &str, cfg: &McpServerConfig) -> Result<Connection, String> {
        let (child, values) = Self::spawn(name, cfg, &*self.secrets)?;
        self.pending.lock().insert(name.to_string(), Arc::clone(&child));
        // A server that echoes its own env or Keychain values can't show
        // them in the failure.
        let result = Self::handshake(name, child)
            .map_err(|e| redact_text(&secrets::scrub(&e, &values), &known_secrets(cfg)));
        self.pending.lock().remove(name);
        result
    }

    /// Start a server's process, its `secret_env` values read from `store`
    /// into its environment. Returns them too, to scrub from a failure.
    #[allow(clippy::type_complexity)]
    fn spawn(
        name: &str,
        cfg: &McpServerConfig,
        store: &dyn secrets::SecretStore,
    ) -> Result<(ChildHandle, Vec<(String, String)>), String> {
        // The PATH CLI stages run with: a GUI app starts from launchd's
        // minimal PATH, where `npx`, `uvx` or `node` aren't found.
        let plan = spawn_plan(cfg, &crate::orchestrator::cli_runner::resolved_cli_path())?;
        let secret_values = secrets::resolve(name, cfg, store)?;
        let mut cmd = Command::new(&plan.program);
        cmd.args(&cfg.args)
            .envs(&cfg.env)
            .envs(secret_values.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Only PATH comes from the login shell; the rest of the environment
        // is the app's own plus the server's `env`, as before.
        if let Some(path) = &plan.path {
            cmd.env("PATH", path);
        }
        // Own process group, so an abort can take the wrapper AND the
        // server it spawned (see `kill_and_reap`).
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let child = cmd.spawn().map_err(|e| format!("spawn {}: {e}", plan.program.display()))?;
        Ok((Arc::new(Mutex::new(child)), secret_values))
    }

    /// The MCP initialize handshake + `tools/list` over an already-spawned
    /// process. A failure drops the connection, which kills the process.
    fn handshake(name: &str, child: ChildHandle) -> Result<Connection, String> {
        let (stdin, stdout, stderr) = {
            let mut c = child.lock();
            (
                c.stdin.take().ok_or("no stdin")?,
                c.stdout.take().ok_or("no stdout")?,
                c.stderr.take(),
            )
        };
        // Drain stderr on a background thread so the process is never blocked
        // writing diagnostics. The buffer is capped at 4 KiB; we include it in
        // "closed the connection" errors so bridge tools (e.g. mcp-remote) can
        // surface auth and network failures instead of silently exiting.
        let stderr_log: Arc<Mutex<StderrLog>> = Arc::new(Mutex::new(StderrLog::default()));
        if let Some(stderr) = stderr {
            let log = Arc::clone(&stderr_log);
            std::thread::spawn(move || drain_stderr(stderr, log));
        }
        let mut conn = Connection {
            child,
            stdin,
            reader: BufReader::new(stdout),
            next_id: 1,
            tools: Vec::new(),
            stderr_log,
        };
        conn.request(
            "initialize",
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "octopush", "version": env!("CARGO_PKG_VERSION") }
            }),
        )?;
        conn.notify("notifications/initialized", json!({}))?;
        let result = conn.request("tools/list", json!({}))?;
        let tools = result
            .get("tools")
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default();
        conn.tools = tools
            .iter()
            .filter_map(|t| {
                let tool = t.get("name")?.as_str()?.to_string();
                let hint = |key: &str| t.get("annotations").and_then(|a| a.get(key)).and_then(Value::as_bool);
                Some(McpToolInfo {
                    server: name.to_string(),
                    namespaced: namespaced_name(name, &tool),
                    name: tool,
                    description: t
                        .get("description")
                        .and_then(|d| d.as_str())
                        .unwrap_or("")
                        .to_string(),
                    input_schema: t
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or(json!({ "type": "object" })),
                    read_only: hint("readOnlyHint").unwrap_or(false),
                    destructive: hint("destructiveHint"),
                    annotated: hint("readOnlyHint").is_some() || hint("destructiveHint").is_some(),
                })
            })
            .collect();
        Ok(conn)
    }

    /// One-shot smoke test: spawn the server, run the handshake, and return its
    /// tools — then drop the connection (the child is killed on drop). Used by
    /// the Settings "Test connection" button and the integration test. Does NOT
    /// touch the cache or the failed-set, so testing a broken config doesn't
    /// poison a real session.
    pub fn test_connect(name: &str, cfg: &McpServerConfig) -> Result<Vec<McpToolInfo>, String> {
        Self::test_connect_with(name, cfg, &*secrets::keychain())
    }

    /// [`Self::test_connect`] reading secrets from `store`.
    pub fn test_connect_with(
        name: &str,
        cfg: &McpServerConfig,
        store: &dyn secrets::SecretStore,
    ) -> Result<Vec<McpToolInfo>, String> {
        let (child, values) = Self::spawn(name, cfg, store)?;
        let conn = Self::handshake(name, child)
            .map_err(|e| redact_text(&secrets::scrub(&e, &values), &known_secrets(cfg)))?;
        // Settings lists them in the order every request offers them.
        let mut tools = conn.tools.clone();
        sort_tools(&mut tools);
        Ok(tools)
    }

    /// Lazily connect (and cache) a server's connection. Spawn + handshake
    /// run under a per-server lock: concurrent first callers (a sub-agent
    /// fan-out) wait for one connection instead of each spawning their own.
    fn ensure(&self, name: &str, cfg: &McpServerConfig) -> Result<(Arc<Mutex<Connection>>, ChildHandle), String> {
        if let Some(live) = self.cached(name, cfg) {
            return Ok(live);
        }
        let spawn_lock = Arc::clone(
            self.connecting.lock().entry(name.to_string()).or_insert_with(|| Arc::new(Mutex::new(()))),
        );
        let _spawning = spawn_lock.lock();
        if let Some(live) = self.cached(name, cfg) {
            return Ok(live);
        }
        if let Some(f) = self.failed.lock().get(name).filter(|f| &f.cfg == cfg) {
            // Only the cause: the server's output went with the first failure.
            let cause = f.reason.trim().lines().next().unwrap_or("").trim();
            return Err(format!("it failed to start earlier in this session: {cause}"));
        }
        let resets = self.reset_count(name);
        let started = self.connect(name, cfg);
        self.finish_start(name, cfg, resets, started)
    }

    /// Cache a start's connection, or remember its failure — unless the
    /// server was reset since the start began (`resets` is the count then).
    fn finish_start(
        &self,
        name: &str,
        cfg: &McpServerConfig,
        resets: u64,
        started: Result<Connection, String>,
    ) -> Result<(Arc<Mutex<Connection>>, ChildHandle), String> {
        match started {
            Ok(conn) => {
                let child = Arc::clone(&conn.child);
                let arc = Arc::new(Mutex::new(conn));
                let mut conns = self.conns.lock();
                if self.reset_count(name) != resets {
                    // Reset while it started (its config was saved, or the
                    // user pressed Reconnect): this may be the old config's
                    // process. Dropping the last handle kills it.
                    drop(conns);
                    drop(arc);
                    return Err("it was restarted while starting; try again".into());
                }
                let stale =
                    conns.insert(name.to_string(), Entry { conn: Arc::clone(&arc), child: Arc::clone(&child), cfg: cfg.clone() });
                drop(conns);
                drop(stale);
                Ok((arc, child))
            }
            Err(e) => {
                // Remember the failure so we don't re-spawn it every turn —
                // unless a reset interrupted this start.
                let mut failed = self.failed.lock();
                if self.reset_count(name) == resets {
                    failed.insert(name.to_string(), Failure { cfg: cfg.clone(), reason: e.clone() });
                }
                Err(e)
            }
        }
    }

    /// All tools across configured + reachable servers for a worktree, in
    /// [`sort_tools`] order. Unreachable servers are skipped with a warning
    /// (never fatal).
    pub fn list_tools(&self, worktree: &Path) -> Vec<McpToolInfo> {
        let mut out = Vec::new();
        for (name, cfg) in self.sorted_configs(worktree) {
            match self.ensure(&name, &cfg) {
                Ok((conn, _)) => out.extend(conn.lock().tools.clone()),
                Err(e) => {
                    tracing::warn!(server = %name, error = %e, "MCP server unavailable; skipping")
                }
            }
        }
        sort_tools(&mut out);
        out
    }

    /// Call a namespaced MCP tool (`mcp__server__tool`), returning the textual
    /// result the model reads (MCP `tools/call` content blocks joined, binary
    /// payloads as short placeholders: `content::render_call_result`). A tool
    /// that reports its own failure (`isError`) is a result like any other.
    pub fn call(&self, worktree: &Path, namespaced: &str, input: &Value) -> Result<String, McpCallError> {
        self.call_on(&self.configs(worktree), namespaced, input, None).map(|out| out.text)
    }

    /// [`Self::call`] with the server's config looked up in `cfgs`,
    /// recording the process it uses in `target` before the request goes out
    /// (`call_bounded`'s abort stops that one).
    fn call_on(
        &self,
        cfgs: &HashMap<String, McpServerConfig>,
        namespaced: &str,
        input: &Value,
        target: Option<&CallTarget>,
    ) -> Result<content::McpOutput, McpCallError> {
        let (server, tool) =
            parse_namespaced(namespaced).ok_or_else(|| McpCallError::NotMcpTool(namespaced.to_string()))?;
        let Some(cfg) = cfgs.get(&server) else {
            return Err(McpCallError::NotConfigured { server });
        };
        let (conn, child) = self
            .ensure(&server, cfg)
            .map_err(|reason| McpCallError::Connection { server: server.clone(), reason })?;
        if let Some(target) = target {
            let mut t = target.lock();
            if t.aborted {
                return Err(McpCallError::Connection { server, reason: "the call was stopped before it was sent".into() });
            }
            t.child = Some(child);
        }
        let answer = conn.lock().request("tools/call", json!({ "name": tool, "arguments": input }));
        let result = match answer {
            Ok(r) => r,
            // The server answered: it is alive, so its connection stays.
            Err(RpcError::Server(message)) => return Err(McpCallError::Server { server, message }),
            Err(RpcError::Transport(reason)) => {
                // The wire broke (the process exited, a pipe closed): evict
                // the connection so the next call spawns a fresh server
                // instead of reusing a corpse. This call isn't retried — it
                // may already have reached the server.
                self.evict_if_current(&server, &conn);
                let reason = self.redact_call_failure(&server, cfg, &reason);
                return Err(McpCallError::Connection { server, reason });
            }
        };
        Ok(content::render_call_result(&result))
    }
}

impl Default for McpRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_code_config_shape() {
        let cfg = parse_mcp_config(
            r#"{ "mcpServers": { "github": { "command": "npx", "args": ["-y","@modelcontextprotocol/server-github"], "env": {"TOKEN":"x"} } } }"#,
        );
        let s = cfg.get("github").expect("github server");
        assert_eq!(s.command, "npx");
        assert_eq!(s.args.len(), 2);
        assert_eq!(s.env.get("TOKEN").map(String::as_str), Some("x"));
    }

    #[test]
    fn malformed_config_is_empty() {
        assert!(parse_mcp_config("not json").is_empty());
        assert!(parse_mcp_config("{}").is_empty());
    }

    const MIXED: &str = r#"{"mcpServers":{
        "local":{"command":"uvx","args":["example-server"]},
        "web":{"type":"http","url":"https://mcp.example.com/mcp","headers":{"X-Api-Key":"k-123"},"disabled":false},
        "stream":{"type":"sse","url":" https://mcp.example.com/sse "},
        "odd":{"type":"websocket","url":"wss://mcp.example.com"},
        "broken":{"args":["no-command"]}
    }}"#;

    #[test]
    fn one_entry_octopush_cant_run_hides_no_other() {
        let servers = parse_mcp_config(MIXED);
        let mut names: Vec<&str> = servers.keys().map(String::as_str).collect();
        names.sort();
        assert_eq!(names, vec!["local", "stream", "web"], "only the entries it can't run are skipped");
        assert_eq!(servers["local"].command, "uvx");

        // `type: http` with headers reads into the Remote form's custom headers.
        let web = &servers["web"];
        let r = web.remote.as_ref().expect("a remote entry");
        assert_eq!((r.url.as_str(), r.auth.as_str(), r.transport.as_str()), ("https://mcp.example.com/mcp", "headers", "http-only"));
        assert_eq!(r.header_names, vec!["X-Api-Key"]);
        assert_eq!(web.env["OCTOPUSH_MCP_H_X_API_KEY"], "k-123");
        assert_eq!(web.extra.get("disabled"), Some(&json!(false)), "its other keys stay");
        assert!(!web.extra.contains_key("type") && !web.extra.contains_key("headers"));
        // `type: sse` without headers is a browser sign-in.
        let r = servers["stream"].remote.as_ref().unwrap();
        assert_eq!((r.url.as_str(), r.auth.as_str(), r.transport.as_str()), ("https://mcp.example.com/sse", "oauth", "sse-only"));

        // And it runs through the bridge, the value only in its env.
        let built = remote::with_bridges(servers);
        let args = &built["web"].args;
        assert_eq!(&args[1..], ["mcp-remote@^0.16", "https://mcp.example.com/mcp", "--header", "X-Api-Key:${OCTOPUSH_MCP_H_X_API_KEY}", "--transport", "http-only"]);
        assert!(!args.iter().any(|a| a.contains("k-123")));
    }

    #[test]
    fn a_save_keeps_the_entries_octopush_cant_run() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        std::fs::write(&path, MIXED).unwrap();
        let store = secrets::MemoryStore::with(&[]);
        let mut servers = load_config_at(&path);
        servers.remove("local");
        save_servers_at(&path, servers, HashMap::new(), &HashMap::new(), &store).unwrap();
        let file: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let saved = file["mcpServers"].as_object().unwrap();
        assert!(!saved.contains_key("local"), "a removed server goes");
        assert_eq!(saved["odd"], json!({"type":"websocket","url":"wss://mcp.example.com"}), "kept as it was");
        assert_eq!(saved["broken"], json!({"args":["no-command"]}));
        assert_eq!(saved["web"]["remote"]["url"], "https://mcp.example.com/mcp");
        assert!(saved["web"]["command"].as_str().unwrap().ends_with("npx"));
        // Read again: the two remote servers, still runnable.
        let mut names: Vec<String> = load_config_at(&path).into_keys().collect();
        names.sort();
        assert_eq!(names, vec!["stream", "web"]);
    }

    // A minimal MCP server (bash) that speaks just enough JSON-RPC to exercise
    // the real stdio client: initialize → tools/list → tools/call, echoing back
    // each request's id. Used to verify the client end-to-end without network.
    const FIXTURE: &str = r#"#!/usr/bin/env bash
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"fixture","version":"0"}}}\n' "$id" ;;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","description":"echoes","inputSchema":{"type":"object"}}]}}\n' "$id" ;;
    *'"method":"tools/call"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"pong"}]}}\n' "$id" ;;
  esac
done
"#;

    #[cfg(unix)]
    #[test]
    fn client_connects_and_lists_tools_against_a_fixture_server() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fixture.sh");
        std::fs::write(&script, FIXTURE).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let cfg = McpServerConfig {
            command: "bash".into(),
            args: vec![script.to_string_lossy().to_string()],
            ..Default::default()
        };
        // Real spawn + initialize handshake + tools/list over stdio JSON-RPC.
        let tools = McpRegistry::test_connect("fix", &cfg).expect("fixture should connect");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "echo");
        assert_eq!(tools[0].namespaced, "mcp__fix__echo");

        // Full path incl. tools/call via the cached registry against a worktree
        // config pointing at the same fixture.
        let claude = dir.path().join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        std::fs::write(
            claude.join("mcp.json"),
            format!(
                r#"{{"mcpServers":{{"fix":{{"command":"bash","args":[{:?}]}}}}}}"#,
                script.to_string_lossy()
            ),
        )
        .unwrap();
        let reg = McpRegistry::trusting_projects();
        let out = reg
            .call(dir.path(), "mcp__fix__echo", &serde_json::json!({"x": 1}))
            .expect("tools/call should succeed");
        assert_eq!(out, "pong");
    }

    // A fixture that answers the handshake but never answers `tools/call`
    // (it sleeps), and appends a line to `$SPAWN_LOG` each time it starts.
    const HANGING_FIXTURE: &str = r#"#!/usr/bin/env bash
echo start >> "$SPAWN_LOG"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"hang","version":"0"}}}\n' "$id" ;;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"slow","description":"never answers","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}}]}}\n' "$id" ;;
    *'"method":"tools/call"'*)
      echo call >> "$SPAWN_LOG"; sleep 30 ;;
  esac
done
"#;

    // A fixture that never answers `initialize` at all.
    const MUTE_FIXTURE: &str = r#"#!/usr/bin/env bash
echo start >> "$SPAWN_LOG"
sleep 30
"#;

    #[cfg(unix)]
    fn log_lines(log: &std::path::Path, word: &str) -> usize {
        std::fs::read_to_string(log).unwrap_or_default().lines().filter(|l| *l == word).count()
    }

    #[cfg(unix)]
    fn wait_for(log: &std::path::Path, word: &str, n: usize) {
        let started = std::time::Instant::now();
        while log_lines(log, word) < n {
            assert!(started.elapsed() < std::time::Duration::from_secs(10), "fixture never wrote {word}");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    #[cfg(unix)]
    fn hanging_worktree() -> (tempfile::TempDir, std::path::PathBuf) {
        fixture_worktree(HANGING_FIXTURE)
    }

    #[cfg(unix)]
    fn fixture_worktree(fixture: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let (dir, log) = fixture_dir(fixture);
        write_servers(dir.path(), &HashMap::from([("hang".to_string(), fixture_config(dir.path(), &[]))]));
        (dir, log)
    }

    /// A temp worktree holding the fixture script (`hang.sh`); its spawn log
    /// is `spawns.log`. No config is written yet.
    #[cfg(unix)]
    fn fixture_dir(fixture: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("hang.sh");
        std::fs::write(&script, fixture).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let log = dir.path().join("spawns.log");
        (dir, log)
    }

    /// The config that runs the worktree's fixture, with `SPAWN_LOG` and
    /// `extra` in its environment.
    #[cfg(unix)]
    fn fixture_config(dir: &std::path::Path, extra: &[(&str, &str)]) -> McpServerConfig {
        let mut env = HashMap::from([("SPAWN_LOG".to_string(), dir.join("spawns.log").to_string_lossy().into_owned())]);
        env.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        McpServerConfig {
            command: "bash".into(),
            args: vec![dir.join("hang.sh").to_string_lossy().into_owned()],
            env,
            ..Default::default()
        }
    }

    /// Write `servers` as the worktree's project-level `.claude/mcp.json`.
    #[cfg(unix)]
    fn write_servers(dir: &std::path::Path, servers: &HashMap<String, McpServerConfig>) {
        let claude = dir.join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        std::fs::write(claude.join("mcp.json"), json!({ "mcpServers": servers }).to_string()).unwrap();
    }

    // A fixture that answers every call with `$ECHO_TEXT` (also its one
    // tool's description), and logs `start` each time it starts. The tool
    // `refuse` fails inside the tool (`isError`); `reject` gets a JSON-RPC
    // error. Either way the server itself is fine.
    const ECHO_FIXTURE: &str = r#"#!/usr/bin/env bash
echo start >> "$SPAWN_LOG"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"echo","version":"0"}}}\n' "$id" ;;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","description":"%s","inputSchema":{"type":"object"}}]}}\n' "$id" "$ECHO_TEXT" ;;
    *'"name":"refuse"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"isError":true,"content":[{"type":"text","text":"no such issue"}]}}\n' "$id" ;;
    *'"name":"reject"'*)
      printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32602,"message":"bad arguments"}}\n' "$id" ;;
    *'"method":"tools/call"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"%s"}]}}\n' "$id" "$ECHO_TEXT" ;;
  esac
done
"#;

    /// An echo fixture configured as server `fix`, answering `text`.
    #[cfg(unix)]
    fn echo_worktree(text: &str) -> (tempfile::TempDir, std::path::PathBuf, HashMap<String, McpServerConfig>) {
        let (dir, log) = fixture_dir(ECHO_FIXTURE);
        let servers = HashMap::from([("fix".to_string(), fixture_config(dir.path(), &[("ECHO_TEXT", text)]))]);
        write_servers(dir.path(), &servers);
        (dir, log, servers)
    }

    /// #1245: a committed project server starts only once approved in its
    /// project, with exactly this entry; a change or a revoke stops it from
    /// starting, and a Settings server of the same name keeps its entry.
    #[cfg(unix)]
    #[test]
    fn a_project_server_starts_only_while_its_entry_is_approved() {
        use approval::ProjectServerState::{Approved, Changed, Waiting};
        let (dir, log, mut servers) = echo_worktree("hello");
        let wt = dir.path().to_string_lossy().into_owned();
        let db = Arc::new(Mutex::new(crate::db::Db::open(&dir.path().join("app.db")).unwrap()));
        db.lock().insert_project("p1", "Sample", &wt).unwrap();
        let reg = McpRegistry::new().with_approvals(Arc::new(approval::DbApprovals(Arc::clone(&db))));
        let state = || reg.project_servers(dir.path())[0].state;

        assert!(reg.list_tools(dir.path()).is_empty(), "a committed server waits for approval");
        assert!(reg.call(dir.path(), "mcp__fix__echo", &json!({})).is_err());
        assert!(reg.status(dir.path()).is_empty());
        assert_eq!((state(), log_lines(&log, "start")), (Waiting, 0), "never started");

        let hash = reg.project_servers(dir.path())[0].hash.clone();
        assert!(approval::approve(&db, &reg, dir.path(), "fix", "another entry").is_err(), "only what the card showed");
        approval::approve(&db, &reg, dir.path(), "fix", &hash).unwrap();
        assert_eq!(state(), Approved);
        assert_eq!(reg.call(dir.path(), "mcp__fix__echo", &json!({})).unwrap(), "hello");
        assert_eq!(log_lines(&log, "start"), 1);

        // A changed entry asks again: nothing starts, and calls are refused.
        servers.get_mut("fix").unwrap().env.insert("ECHO_TEXT".into(), "changed".into());
        write_servers(dir.path(), &servers);
        assert_eq!(state(), Changed);
        assert!(reg.list_tools(dir.path()).is_empty());
        assert!(matches!(reg.call(dir.path(), "mcp__fix__echo", &json!({})), Err(McpCallError::NotConfigured { .. })));

        // Approved again, then revoked: it stops and doesn't start again.
        let hash = reg.project_servers(dir.path())[0].hash.clone();
        approval::approve(&db, &reg, dir.path(), "fix", &hash).unwrap();
        assert_eq!(reg.call(dir.path(), "mcp__fix__echo", &json!({})).unwrap(), "changed");
        assert!(approval::revoke(&db, &reg, "p1", "fix").unwrap());
        assert_eq!(state(), Waiting);
        assert!(reg.list_tools(dir.path()).is_empty());
        assert!(reg.call(dir.path(), "mcp__fix__echo", &json!({})).is_err());
        assert_eq!(log_lines(&log, "start"), 2, "revoked, it never starts again");

        // A Settings server of the same name keeps its entry, approved or not.
        let user = HashMap::from([("fix".to_string(), McpServerConfig { command: "from-settings".into(), ..Default::default() })]);
        let merged = merge_servers(user, dir.path(), &approval::TrustAll);
        assert_eq!(merged["fix"].command, "from-settings");
    }

    #[cfg(unix)]
    fn reaped(child: &ChildHandle) -> bool {
        matches!(child.lock().try_wait(), Ok(Some(_)))
    }

    #[cfg(unix)]
    #[test]
    fn saving_a_changed_config_stops_the_old_server_and_the_next_use_starts_the_new_one() {
        let (dir, log, before) = echo_worktree("old");
        let reg = McpRegistry::trusting_projects();
        assert_eq!(reg.call(dir.path(), "mcp__fix__echo", &json!({})).unwrap(), "old");
        let old_child = Arc::clone(&reg.conns.lock()["fix"].child);

        // A save that leaves the entry as it was stops nothing.
        assert!(reg.apply_config_change(&before, &before).is_empty());
        assert!(reg.conns.lock().contains_key("fix") && !reaped(&old_child));

        // The user saves a new config for the server.
        let after = HashMap::from([("fix".to_string(), fixture_config(dir.path(), &[("ECHO_TEXT", "new")]))]);
        write_servers(dir.path(), &after);
        assert_eq!(reg.apply_config_change(&before, &after), vec!["fix".to_string()]);
        assert!(reg.conns.lock().is_empty(), "the old connection is dropped");
        assert!(reaped(&old_child), "and its process stopped");

        // The next list and call use a fresh process with the new config.
        let tools = reg.list_tools(dir.path());
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].description, "new");
        assert_eq!(reg.call(dir.path(), "mcp__fix__echo", &json!({})).unwrap(), "new");
        assert_eq!(log_lines(&log, "start"), 2, "one process per config");

        // Removing the server stops it too.
        let child = Arc::clone(&reg.conns.lock()["fix"].child);
        assert_eq!(reg.apply_config_change(&after, &HashMap::new()), vec!["fix".to_string()]);
        assert!(reg.conns.lock().is_empty() && reaped(&child));
    }

    #[cfg(unix)]
    #[test]
    fn a_save_stops_a_call_in_flight_without_blocking_and_the_next_call_respawns() {
        let (dir, log) = hanging_worktree();
        let reg = Arc::new(McpRegistry::trusting_projects());
        assert_eq!(reg.list_tools(dir.path()).len(), 1);
        let (r2, wt) = (Arc::clone(&reg), dir.path().to_path_buf());
        let worker = std::thread::spawn(move || r2.call(&wt, "mcp__hang__slow", &json!({})));
        wait_for(&log, "call", 1);

        let before = HashMap::from([("hang".to_string(), fixture_config(dir.path(), &[]))]);
        let after = HashMap::from([("hang".to_string(), fixture_config(dir.path(), &[("TOKEN", "fresh")]))]);
        write_servers(dir.path(), &after);
        let started = std::time::Instant::now();
        reg.apply_config_change(&before, &after);
        let res = worker.join().unwrap();
        assert!(matches!(res, Err(McpCallError::Connection { .. })), "the old process's call fails: {res:?}");
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        assert_eq!(reg.list_tools(dir.path()).len(), 1);
        assert_eq!(log_lines(&log, "start"), 2, "the next use spawned the new config");
    }

    #[cfg(unix)]
    #[test]
    fn a_reset_during_a_handshake_neither_caches_nor_remembers_a_failure() {
        let (dir, log) = fixture_worktree(MUTE_FIXTURE);
        let reg = Arc::new(McpRegistry::trusting_projects());
        let (r2, wt) = (Arc::clone(&reg), dir.path().to_path_buf());
        let worker = std::thread::spawn(move || r2.list_tools(&wt).len());
        wait_for(&log, "start", 1);
        std::thread::sleep(std::time::Duration::from_millis(100));
        let started = std::time::Instant::now();
        reg.reset_server("hang");
        assert_eq!(worker.join().unwrap(), 0, "the interrupted start fails instead of blocking");
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        assert!(reg.conns.lock().is_empty() && reg.pending.lock().is_empty());
        assert!(reg.failed.lock().is_empty(), "a start a reset interrupted isn't a failure to remember");
    }

    #[cfg(unix)]
    #[test]
    fn a_killed_server_fails_its_call_and_the_next_call_respawns() {
        let (dir, log, _) = echo_worktree("pong");
        let reg = McpRegistry::trusting_projects();
        assert_eq!(reg.call(dir.path(), "mcp__fix__echo", &json!({})).unwrap(), "pong");
        // The process dies behind the registry's back.
        let child = Arc::clone(&reg.conns.lock()["fix"].child);
        let pid = child.lock().id() as libc::pid_t;
        // SAFETY: the child is ours and unreaped, so the pid can't be reused.
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
        let started = std::time::Instant::now();
        while !reaped(&child) {
            assert!(started.elapsed() < std::time::Duration::from_secs(10), "the fixture never exited");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        let err = reg.call(dir.path(), "mcp__fix__echo", &json!({})).unwrap_err();
        assert!(matches!(err, McpCallError::Connection { .. }), "{err:?}");
        let text = err.to_string();
        assert!(text.starts_with("Octopush's connection to fix failed: "), "{text}");
        assert!(text.contains("The user can reconnect it in Settings › Integrations."), "{text}");
        assert!(!text.contains("/mcp"), "{text}");
        assert_eq!(log_lines(&log, "start"), 1, "the failed call isn't retried");
        assert!(reg.conns.lock().is_empty(), "the dead connection is dropped");

        assert_eq!(reg.call(dir.path(), "mcp__fix__echo", &json!({})).unwrap(), "pong");
        assert_eq!(log_lines(&log, "start"), 2, "the next call started a fresh server");
    }

    #[cfg(unix)]
    #[test]
    fn a_tool_level_error_keeps_the_connection() {
        let (dir, log, _) = echo_worktree("pong");
        let reg = McpRegistry::trusting_projects();
        // The tool failed and said so: a result, from a healthy server.
        assert_eq!(reg.call(dir.path(), "mcp__fix__refuse", &json!({})).unwrap(), "no such issue");
        let conn = Arc::clone(&reg.conns.lock()["fix"].conn);
        // A JSON-RPC error answer: the server is alive too.
        let err = reg.call(dir.path(), "mcp__fix__reject", &json!({})).unwrap_err();
        assert!(matches!(&err, McpCallError::Server { message, .. } if message.contains("bad arguments")), "{err:?}");
        assert!(!err.to_string().contains("connection to fix failed"), "{err}");
        assert!(Arc::ptr_eq(&conn, &reg.conns.lock()["fix"].conn), "the connection stays cached");
        assert_eq!(reg.call(dir.path(), "mcp__fix__echo", &json!({})).unwrap(), "pong");
        assert_eq!(log_lines(&log, "start"), 1, "one process throughout");
    }

    #[cfg(unix)]
    #[test]
    fn reconnect_restarts_a_live_server_and_forgets_a_failure() {
        let (dir, log, _) = echo_worktree("pong");
        let reg = McpRegistry::trusting_projects();
        assert_eq!(reg.call(dir.path(), "mcp__fix__echo", &json!({})).unwrap(), "pong");
        let child = Arc::clone(&reg.conns.lock()["fix"].child);
        reg.reset_server("fix");
        assert!(reg.conns.lock().is_empty() && reaped(&child));
        assert_eq!(reg.call(dir.path(), "mcp__fix__echo", &json!({})).unwrap(), "pong");
        assert_eq!(log_lines(&log, "start"), 2);

        // A server that failed to start is skipped until it is reset.
        let broken = HashMap::from([(
            "gone".to_string(),
            McpServerConfig { command: dir.path().join("missing-server").to_string_lossy().into_owned(), ..Default::default() },
        )]);
        write_servers(dir.path(), &broken);
        assert!(reg.list_tools(dir.path()).is_empty());
        let err = reg.call(dir.path(), "mcp__gone__x", &json!({})).unwrap_err();
        assert!(err.to_string().contains("failed to start earlier in this session"), "{err}");
        reg.reset_server("gone");
        assert!(reg.failed.lock().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_hand_edited_config_is_used_without_a_save() {
        let (dir, log, _) = echo_worktree("old");
        let reg = McpRegistry::trusting_projects();
        assert_eq!(reg.call(dir.path(), "mcp__fix__echo", &json!({})).unwrap(), "old");
        // The file changes outside Settings: the cached process was started
        // with the old entry, so it isn't reused.
        write_servers(dir.path(), &HashMap::from([("fix".to_string(), fixture_config(dir.path(), &[("ECHO_TEXT", "new")]))]));
        assert_eq!(reg.call(dir.path(), "mcp__fix__echo", &json!({})).unwrap(), "new");
        assert_eq!(log_lines(&log, "start"), 2);

        // A failure is remembered for the config that failed, not the name.
        let bad = McpServerConfig { command: dir.path().join("missing-server").to_string_lossy().into_owned(), ..Default::default() };
        write_servers(dir.path(), &HashMap::from([("fix".to_string(), bad)]));
        assert!(matches!(reg.call(dir.path(), "mcp__fix__echo", &json!({})), Err(McpCallError::Connection { .. })));
        write_servers(dir.path(), &HashMap::from([("fix".to_string(), fixture_config(dir.path(), &[("ECHO_TEXT", "back")]))]));
        assert_eq!(reg.call(dir.path(), "mcp__fix__echo", &json!({})).unwrap(), "back");
    }

    /// An executable stand-in for a CLI such as `npx`, in `dir`.
    #[cfg(unix)]
    fn fake_bin(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join(name);
        std::fs::write(&bin, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    #[cfg(unix)]
    fn command(command: &str, env: &[(&str, &str)]) -> McpServerConfig {
        McpServerConfig {
            command: command.into(),
            args: vec!["-y".into(), "mcp-remote".into(), "https://mcp.example/sse".into()],
            env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            ..Default::default()
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_bare_command_resolves_on_the_cli_path_the_server_then_runs_with() {
        let login = tempfile::tempdir().unwrap();
        let npx = fake_bin(login.path(), "npx");
        let search = format!("/nonexistent/xyz:{}", login.path().display());
        let plan = spawn_plan(&command("npx", &[]), &search).unwrap();
        assert_eq!(plan.program, npx);
        assert_eq!(plan.path.as_deref(), Some(search.as_str()));

        assert_eq!(
            spawn_plan(&command("npx", &[]), "/nonexistent/xyz").unwrap_err(),
            "Octopush couldn't find `npx` on the PATH Octopush searched (/nonexistent/xyz). Use its full path \
             (run `which npx` in Terminal)."
        );
        assert_eq!(
            spawn_plan(&command("npx", &[("PATH", "/nonexistent/own")]), "/usr/bin").unwrap_err(),
            "Octopush couldn't find `npx` on the server's own PATH (/nonexistent/own). Use its full path \
             (run `which npx` in Terminal)."
        );
    }

    #[cfg(unix)]
    #[test]
    fn relative_path_entries_are_skipped() {
        // `npx` in a dir named relative to the working directory: found only
        // through the relative entry, which is skipped.
        let cwd = std::env::current_dir().unwrap();
        let rel = tempfile::tempdir_in(&cwd).unwrap();
        fake_bin(rel.path(), "npx");
        let name = rel.path().file_name().unwrap().to_string_lossy().into_owned();
        let search = format!(".:{name}:/nonexistent/xyz");
        assert!(spawn_plan(&command("npx", &[]), &search).is_err());
        let login = tempfile::tempdir().unwrap();
        fake_bin(login.path(), "npx");
        let plan = spawn_plan(&command("npx", &[]), &format!("{name}:{}", login.path().display())).unwrap();
        assert_eq!(plan.path, Some(login.path().display().to_string()), "the server's PATH drops it too");
    }

    #[cfg(unix)]
    #[test]
    fn an_absolute_command_runs_as_given_with_its_own_dir_first() {
        let nvm = tempfile::tempdir().unwrap();
        let npx = fake_bin(nvm.path(), "npx");
        let plan = spawn_plan(&command(&npx.to_string_lossy(), &[]), "/usr/bin:/bin").unwrap();
        assert_eq!(plan.program, npx);
        assert_eq!(plan.path, Some(format!("{}:/usr/bin:/bin", nvm.path().display())));
        // A path that doesn't exist is still run as given: the spawn reports it.
        let plan = spawn_plan(&command("/nowhere/npx", &[]), "/usr/bin").unwrap();
        assert_eq!(plan.program, std::path::PathBuf::from("/nowhere/npx"));
    }

    #[cfg(unix)]
    #[test]
    fn a_remote_bridges_npx_that_moved_is_found_again_on_the_path() {
        let login = tempfile::tempdir().unwrap();
        let npx = fake_bin(login.path(), "npx");
        let mut cfg = command("/nowhere/old-node/bin/npx", &[]);
        cfg.remote = Some(remote::RemoteConfig { url: "https://mcp.example.com/mcp".into(), ..Default::default() });
        let plan = spawn_plan(&cfg, &login.path().to_string_lossy()).unwrap();
        assert_eq!(plan.program, npx);
        // One that still exists is used as saved.
        cfg.command = npx.to_string_lossy().into_owned();
        assert_eq!(spawn_plan(&cfg, "/usr/bin").unwrap().program, npx);
    }

    #[cfg(unix)]
    #[test]
    fn the_servers_own_path_wins() {
        let own = tempfile::tempdir().unwrap();
        let uvx = fake_bin(own.path(), "uvx");
        let own_path = own.path().to_string_lossy().into_owned();
        let login = tempfile::tempdir().unwrap();
        fake_bin(login.path(), "npx");
        let login_path = login.path().to_string_lossy().into_owned();

        let plan = spawn_plan(&command("uvx", &[("PATH", own_path.as_str())]), &login_path).unwrap();
        assert_eq!(plan.program, uvx);
        assert_eq!(plan.path, None, "the server's env sets PATH, so it is left alone");
        // The lookup uses the PATH the server will run with, not the login one.
        assert!(spawn_plan(&command("npx", &[("PATH", own_path.as_str())]), &login_path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_server_gets_the_cli_path_and_nothing_else_from_the_login_shell() {
        const DUMP_FIXTURE: &str = "#!/usr/bin/env bash\ncompgen -e > \"$ENV_DUMP\"\nprintf '%s' \"$PATH\" > \"$PATH_DUMP\"\n";
        let (dir, _log) = fixture_dir(DUMP_FIXTURE);
        let (env_dump, path_dump) = (dir.path().join("env.txt"), dir.path().join("path.txt"));
        let cfg = McpServerConfig {
            command: "bash".into(),
            args: vec![dir.path().join("hang.sh").to_string_lossy().into_owned()],
            env: HashMap::from([
                ("ENV_DUMP".to_string(), env_dump.to_string_lossy().into_owned()),
                ("PATH_DUMP".to_string(), path_dump.to_string_lossy().into_owned()),
            ]),
            ..Default::default()
        };
        // The script exits without a handshake: only its environment matters.
        assert!(McpRegistry::test_connect("dump", &cfg).is_err());
        let resolved = crate::orchestrator::cli_runner::resolved_cli_path();
        // Its absolute dirs (`spawn_plan` drops relative ones).
        let resolved = resolved.split(':').filter(|d| Path::new(d).is_absolute()).collect::<Vec<_>>().join(":");
        assert_eq!(std::fs::read_to_string(&path_dump).unwrap(), resolved, "the PATH CLI stages run with");
        let names: std::collections::HashSet<String> =
            std::fs::read_to_string(&env_dump).unwrap().lines().map(str::to_string).collect();
        for (key, _) in crate::orchestrator::cli_runner::login_shell_env() {
            if key != "PATH" && std::env::var_os(key).is_none() && !cfg.env.contains_key(key) {
                assert!(!names.contains(key), "{key} came from the login shell");
            }
        }

        let err = McpRegistry::test_connect("x", &command("octopush-no-such-server-xyz", &[])).unwrap_err();
        assert_eq!(
            err,
            format!(
                "Octopush couldn't find `octopush-no-such-server-xyz` on the PATH Octopush searched ({resolved}). \
                 Use its full path (run `which octopush-no-such-server-xyz` in Terminal)."
            )
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_servers_keychain_secrets_reach_its_process_and_never_its_failure() {
        // Writes the token where the test can read it, reads the first
        // request, echoes the token and exits before answering.
        const SECRET_FIXTURE: &str =
            "#!/usr/bin/env bash\nprintf '%s' \"$MY_TOKEN\" > \"$DUMP\"\nread -r line\necho \"token is $MY_TOKEN\"\nexit 1\n";
        let (dir, _log) = fixture_dir(SECRET_FIXTURE);
        let dump = dir.path().join("token.txt");
        let cfg = McpServerConfig {
            command: "bash".into(),
            args: vec![dir.path().join("hang.sh").to_string_lossy().into_owned()],
            env: HashMap::from([
                ("DUMP".to_string(), dump.to_string_lossy().into_owned()),
                ("MY_TOKEN".to_string(), String::new()),
            ]),
            secret_env: vec!["MY_TOKEN".into()],
            ..Default::default()
        };
        let store = secrets::MemoryStore::with(&[("example/MY_TOKEN", "tok-from-keychain")]);
        let err = McpRegistry::test_connect_with("example", &cfg, &store).unwrap_err();
        assert_eq!(std::fs::read_to_string(&dump).unwrap(), "tok-from-keychain", "the process got the value");
        assert!(err.contains("token is [redacted]") && !err.contains("tok-from-keychain"), "{err}");

        // A secret that isn't saved fails before anything starts.
        std::fs::remove_file(&dump).unwrap();
        let err = McpRegistry::test_connect_with("other", &cfg, &store).unwrap_err();
        assert_eq!(err, "The value for MY_TOKEN isn't in the Keychain; edit other to enter it.");
        assert!(!dump.exists());
        assert_eq!(classify_failure(&err).summary, "The value for MY_TOKEN isn't in the Keychain.");

        // The same entry in a repo's `.claude/mcp.json`, even approved, gets
        // nothing from the Keychain: Talk starts it with the file's empty value.
        write_servers(dir.path(), &HashMap::from([("example".to_string(), cfg.clone())]));
        let store = Arc::new(secrets::MemoryStore::with(&[("example/MY_TOKEN", "tok-2")]));
        let reg = McpRegistry::with_secrets(Arc::clone(&store) as Arc<dyn secrets::SecretStore>)
            .with_approvals(Arc::new(approval::TrustAll));
        assert!(reg.call(dir.path(), "mcp__example__x", &json!({})).is_err());
        assert_eq!(std::fs::read_to_string(&dump).unwrap(), "");
        assert!(store.reads.lock().is_empty(), "the Keychain wasn't even read");
    }

    #[test]
    fn the_file_is_never_written_before_the_keychain() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        let before = r#"{"mcpServers":{"a-first":{"command":"uvx","env":{"API_KEY":""},"secret_env":["API_KEY"]}}}"#;
        std::fs::write(&path, before).unwrap();
        let store = secrets::MemoryStore::with(&[("a-first/API_KEY", "old-a")]);
        *store.deny.lock() = Some("b-second/API_KEY".into());
        let cfg = |v: &str| McpServerConfig {
            command: "uvx".into(),
            env: HashMap::from([("API_KEY".to_string(), v.to_string())]),
            secret_env: vec!["API_KEY".into()],
            ..Default::default()
        };
        let servers = HashMap::from([("a-first".to_string(), cfg("new-a")), ("b-second".to_string(), cfg("new-b"))]);
        let err = save_servers_at(&path, servers.clone(), HashMap::new(), &HashMap::new(), &store).unwrap_err();
        assert!(err.contains("denied"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "the file is untouched");
        assert_eq!(store.items.lock()["a-first/API_KEY"], "old-a", "the write that went through is put back");
        assert!(!store.items.lock().contains_key("b-second/API_KEY"));

        // The Keychain takes them, the file write fails: the Keychain is put back too.
        *store.deny.lock() = None;
        let blocked = dir.path().join("not-a-dir");
        std::fs::write(&blocked, "a file").unwrap();
        assert!(save_servers_at(&blocked.join("mcp.json"), servers.clone(), HashMap::new(), &HashMap::new(), &store).is_err());
        assert_eq!(store.items.lock()["a-first/API_KEY"], "old-a");
        assert!(!store.items.lock().contains_key("b-second/API_KEY"));

        // And when both work, the file holds no value.
        let (_, saved, touched) = save_servers_at(&path, servers, HashMap::new(), &HashMap::new(), &store).unwrap();
        assert_eq!(touched, vec!["a-first", "b-second"]);
        assert_eq!(saved["a-first"].env["API_KEY"], "");
        let file = std::fs::read_to_string(&path).unwrap();
        assert!(!file.contains("new-a") && !file.contains("new-b"), "{file}");
        assert_eq!(store.items.lock()["b-second/API_KEY"], "new-b");
        // An invalid name stops the save before anything is written.
        let bad = HashMap::from([("x".to_string(), McpServerConfig { secret_env: vec!["b/C".into()], ..cfg("v") })]);
        assert!(save_servers_at(&path, bad, HashMap::new(), &HashMap::new(), &store).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), file);
    }

    #[cfg(unix)]
    #[test]
    fn a_save_whose_secret_changed_restarts_the_server_whose_entry_reads_the_same() {
        let (dir, _log, servers) = echo_worktree("pong");
        let reg = McpRegistry::trusting_projects();
        assert_eq!(reg.call(dir.path(), "mcp__fix__echo", &json!({})).unwrap(), "pong");
        let child = Arc::clone(&reg.conns.lock()["fix"].child);
        // Same entry, nothing touched: it keeps running.
        assert!(reg.apply_save(&servers, &servers, &[]).is_empty());
        assert!(reg.conns.lock().contains_key("fix") && !reaped(&child));
        // Same entry, but its Keychain value changed: restarted.
        assert_eq!(reg.apply_save(&servers, &servers, &["fix".to_string()]), vec!["fix"]);
        assert!(reg.conns.lock().is_empty() && reaped(&child));
    }

    #[test]
    fn a_project_entry_cant_name_keychain_items() {
        let content = r#"{"mcpServers":{
            "example":{"command":"uvx","env":{"GITHUB_TOKEN":""},"secret_env":["GITHUB_TOKEN"]},
            "example-remote":{"command":"npx","env":{"OCTOPUSH_MCP_H_AUTHORIZATION":""},
                "remote":{"url":"https://mcp.example.com/mcp","auth":"token"}}}}"#;
        assert_eq!(parse_mcp_config(content)["example"].secret_env, vec!["GITHUB_TOKEN"], "user-level entries keep it");
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".claude")).unwrap();
        std::fs::write(dir.path().join(".claude/mcp.json"), content).unwrap();
        let cfgs = load_server_configs(dir.path(), &approval::TrustAll);
        assert!(cfgs["example"].secret_env.is_empty());
        // Not even the token name the rebuilt bridge would list.
        assert!(cfgs["example-remote"].secret_env.is_empty(), "{:?}", cfgs["example-remote"].secret_env);
        assert_eq!(cfgs["example-remote"].args[0..2], ["-y", "mcp-remote@^0.16"]);
    }

    #[test]
    fn talk_runs_a_remote_entrys_bridge_as_its_choices_describe() {
        let dir = tempfile::tempdir().unwrap();
        let mut stale = McpServerConfig { command: "npx".into(), args: vec!["-y".into(), "stale-bridge".into()], ..Default::default() };
        stale.remote = Some(remote::RemoteConfig {
            url: "https://mcp.example.com/mcp".into(),
            auth: "oauth".into(),
            transport: "sse-only".into(),
            ..Default::default()
        });
        let claude = dir.path().join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        std::fs::write(claude.join("mcp.json"), json!({ "mcpServers": { "example-remote": stale } }).to_string()).unwrap();
        let cfgs = load_server_configs(dir.path(), &approval::TrustAll);
        assert_eq!(
            cfgs["example-remote"].args,
            vec!["-y", "mcp-remote@^0.16", "https://mcp.example.com/mcp", "--transport", "sse-only"],
            "rebuilt from `remote`, not the args written"
        );
        assert_eq!(project_config(dir.path())["example-remote"].args, vec!["-y", "stale-bridge"], "the file as written");
    }

    #[test]
    fn only_real_renames_count() {
        let cfg = |c: &str| McpServerConfig { command: c.into(), ..Default::default() };
        let old = HashMap::from([("docs".to_string(), cfg("a")), ("kept".to_string(), cfg("b"))]);
        let new = HashMap::from([("docs-server".to_string(), cfg("a")), ("kept".to_string(), cfg("b"))]);
        let renamed = HashMap::from([
            ("docs-server".to_string(), "docs".to_string()),
            // Not renames: the old name is still there, it never existed, or the new one isn't saved.
            ("kept".to_string(), "kept".to_string()),
            ("ghost".to_string(), "never-saved".to_string()),
            ("missing".to_string(), "docs".to_string()),
        ]);
        assert_eq!(real_renames(&old, &new, &renamed), vec![("docs".to_string(), "docs-server".to_string())]);
        assert!(real_renames(&old, &new, &HashMap::new()).is_empty());
    }

    #[test]
    fn changed_servers_lists_changed_removed_and_added_entries() {
        let cfg = |c: &str| McpServerConfig { command: c.into(), ..Default::default() };
        let old = HashMap::from([("a".to_string(), cfg("x")), ("b".to_string(), cfg("y")), ("c".to_string(), cfg("z"))]);
        let new = HashMap::from([("a".to_string(), cfg("x")), ("b".to_string(), cfg("y2")), ("d".to_string(), cfg("w"))]);
        assert_eq!(changed_servers(&old, &new), vec!["b", "c", "d"]);
        assert!(changed_servers(&old, &old).is_empty());
        let mut env_only = old.clone();
        env_only.get_mut("a").unwrap().env.insert("TOKEN".into(), "new".into());
        assert_eq!(changed_servers(&old, &env_only), vec!["a"]);
    }

    #[test]
    fn connection_failures_tell_the_model_what_applies_in_octopush() {
        assert_eq!(
            connection_failure_text("jira", "MCP server closed the connection"),
            "Octopush's connection to jira failed: MCP server closed the connection. The user can reconnect it in Settings › Integrations."
        );
        assert_eq!(
            connection_failure_text("jira", "MCP server closed the connection\nPlease authenticate\n"),
            "Octopush's connection to jira failed: MCP server closed the connection. The user can reconnect it in Settings › Integrations.\n\nServer output:\nPlease authenticate"
        );
        assert_eq!(
            connection_failure_text("jira", "it timed out."),
            "Octopush's connection to jira failed: it timed out. The user can reconnect it in Settings › Integrations."
        );
        let server = McpCallError::Server { server: "jira".into(), message: "{\"code\":-32602}".into() }.to_string();
        assert!(server.starts_with("jira answered with an error: ") && server.contains("Settings › Integrations"), "{server}");
        let missing = McpCallError::NotConfigured { server: "jira".into() }.to_string();
        assert!(missing.contains("Settings › Integrations"), "{missing}");
        for text in [server, missing] {
            assert!(!text.contains("/mcp") && !text.contains("claude mcp"), "{text}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn abort_server_unblocks_a_hung_call_and_the_next_call_respawns() {
        let (dir, log) = hanging_worktree();
        let reg = Arc::new(McpRegistry::trusting_projects());
        let tools = reg.list_tools(dir.path());
        assert_eq!(tools.len(), 1);
        assert!(tools[0].read_only, "readOnlyHint is parsed");
        // A call that the server never answers, on its own thread.
        let target = CallTarget::default();
        let (r2, wt, t2) = (Arc::clone(&reg), dir.path().to_path_buf(), Arc::clone(&target));
        let worker =
            std::thread::spawn(move || r2.call_on(&r2.configs(&wt), "mcp__hang__slow", &json!({}), Some(&t2)));
        wait_for(&log, "call", 1);
        assert!(!worker.is_finished(), "the call is blocked on the server");
        let started = std::time::Instant::now();
        reg.abort_call("hang", &target);
        let res = worker.join().unwrap();
        assert!(res.is_err(), "the blocked call returns once the server is stopped: {res:?}");
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        // The next use re-spawns the server (a second start line) and works.
        assert_eq!(reg.list_tools(dir.path()).len(), 1);
        assert_eq!(log_lines(&log, "start"), 2, "one spawn before the abort, one after");
    }

    #[cfg(unix)]
    #[test]
    fn abort_reaches_a_server_stuck_in_its_handshake() {
        let (dir, log) = fixture_worktree(MUTE_FIXTURE);
        let reg = Arc::new(McpRegistry::trusting_projects());
        let (r2, wt) = (Arc::clone(&reg), dir.path().to_path_buf());
        let worker = std::thread::spawn(move || r2.list_tools(&wt).len());
        wait_for(&log, "start", 1);
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!worker.is_finished(), "the handshake is hung");
        let started = std::time::Instant::now();
        // A call with no connection yet: its abort reaches the start.
        reg.abort_call("hang", &CallTarget::default());
        assert_eq!(worker.join().unwrap(), 0, "the hung connect fails instead of blocking forever");
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        assert!(reg.pending.lock().is_empty() && reg.conns.lock().is_empty());
        // A second caller is not blocked behind the dead handshake.
        let started = std::time::Instant::now();
        let _ = reg.list_tools(dir.path());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn call_bounded_times_out_stops_the_server_and_says_so() {
        let (dir, log) = hanging_worktree();
        let reg = Arc::new(McpRegistry::trusting_projects());
        let err = call_bounded(
            Arc::clone(&reg),
            dir.path().to_path_buf(),
            "mcp__hang__slow".into(),
            json!({}),
            std::time::Duration::from_secs(3),
        )
        .await
        .unwrap_err();
        assert!(err.contains("timed out") && err.contains("server was stopped"), "{err}");
        assert!(err.starts_with("Octopush's connection to hang failed: "), "{err}");
        assert!(err.contains("The user can reconnect it in Settings › Integrations."), "{err}");
        // Stopped: the connection is gone and the process was reaped; a
        // later discovery spawns a fresh one.
        assert!(reg.conns.lock().is_empty() && reg.pending.lock().is_empty());
        let wt = dir.path().to_path_buf();
        let tools = tokio::task::spawn_blocking(move || reg.list_tools(&wt)).await.unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(log_lines(&log, "start"), 2);
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_first_callers_spawn_a_server_once() {
        let (dir, log) = hanging_worktree();
        let reg = Arc::new(McpRegistry::trusting_projects());
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let (r, wt) = (Arc::clone(&reg), dir.path().to_path_buf());
                std::thread::spawn(move || r.list_tools(&wt).len())
            })
            .collect();
        for h in handles {
            assert_eq!(h.join().unwrap(), 1);
        }
        assert_eq!(log_lines(&log, "start"), 1, "one process for four callers");
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_timeout_stops_the_process_its_call_was_on_not_a_newer_one() {
        let (dir, log) = hanging_worktree();
        let reg = Arc::new(McpRegistry::trusting_projects());
        let call = tokio::spawn(call_bounded(
            Arc::clone(&reg),
            dir.path().to_path_buf(),
            "mcp__hang__slow".into(),
            json!({}),
            std::time::Duration::from_secs(3),
        ));
        let (r2, wt, l2) = (Arc::clone(&reg), dir.path().to_path_buf(), log.clone());
        let (old, new) = tokio::task::spawn_blocking(move || {
            wait_for(&l2, "call", 1);
            let old = Arc::clone(&r2.conns.lock()["hang"].child);
            // The entry is edited by hand while the call hangs: the next use
            // starts a second process with the new config.
            write_servers(&wt, &HashMap::from([("hang".to_string(), fixture_config(&wt, &[("V", "2")]))]));
            assert_eq!(r2.list_tools(&wt).len(), 1);
            let new = Arc::clone(&r2.conns.lock()["hang"].child);
            (old, new)
        })
        .await
        .unwrap();
        assert!(!Arc::ptr_eq(&old, &new));
        let err = call.await.unwrap().unwrap_err();
        assert!(err.contains("timed out") && err.contains("server was stopped"), "{err}");
        assert!(reaped(&old), "the hung call's process was stopped");
        assert!(!reaped(&new), "the newer process keeps running");
        assert!(Arc::ptr_eq(&reg.conns.lock()["hang"].child, &new), "and stays cached");
        assert_eq!(log_lines(&log, "start"), 2);
    }

    #[cfg(unix)]
    #[test]
    fn a_start_that_completes_after_a_reset_is_discarded() {
        let (dir, log, servers) = echo_worktree("pong");
        let reg = McpRegistry::trusting_projects();
        let cfg = &servers["fix"];
        let resets = reg.reset_count("fix");
        // The handshake finished, and the reset lands before it is cached.
        let started = reg.connect("fix", cfg);
        let child = Arc::clone(&started.as_ref().unwrap().child);
        reg.reset_server("fix");
        let err = reg.finish_start("fix", cfg, resets, started).err().unwrap();
        assert!(err.contains("restarted while starting"), "{err}");
        assert!(reg.conns.lock().is_empty(), "the old start isn't cached");
        assert!(reaped(&child), "and its process was stopped");
        // A failure from before the reset isn't remembered either.
        assert!(reg.finish_start("fix", cfg, resets, Err("boom".into())).is_err());
        assert!(reg.failed.lock().is_empty());
        assert_eq!(reg.call(dir.path(), "mcp__fix__echo", &json!({})).unwrap(), "pong");
        assert_eq!(log_lines(&log, "start"), 2, "the next call started a fresh server");
    }

    #[test]
    fn server_output_is_redacted_and_capped() {
        let gh = format!("ghp_{}", "a".repeat(36));
        let reason = format!(
            "MCP server closed the connection\nOpen https://auth.example/cb?code=s3cr3tc0de&state=1\n\
             Authorization: Bearer abcdefgh12345678\nACCESS_TOKEN=tok-value-123 and {gh}"
        );
        let text = connection_failure_text("jira", &reason);
        for secret in ["s3cr3tc0de", "abcdefgh12345678", "tok-value-123", gh.as_str()] {
            assert!(!text.contains(secret), "{secret} in {text}");
        }
        assert!(text.contains("cb?code=[redacted]&state=1") && text.contains("Authorization: [redacted]"), "{text}");

        let lines: Vec<String> = (0..200).map(|i| format!("line {i}")).collect();
        let text = connection_failure_text("jira", &format!("closed\n{}", lines.join("\n")));
        let output = text.split_once("Server output:\n").unwrap().1;
        assert!(output.len() <= SERVER_OUTPUT_CAP + 32, "{} bytes", output.len());
        assert!(output.starts_with("… (earlier output cut)\nline "), "{output}");
        assert!(output.ends_with("line 199"), "{output}");
    }

    #[cfg(unix)]
    #[test]
    fn a_start_failure_shows_its_output_once() {
        const NOISY_FAILURE: &str =
            "#!/usr/bin/env bash\necho start >> \"$SPAWN_LOG\"\nread -r line\necho 'auth failed: token=abcdef123456'\nexit 1\n";
        let (dir, _log) = fixture_worktree(NOISY_FAILURE);
        let reg = McpRegistry::trusting_projects();
        let first = reg.call(dir.path(), "mcp__hang__x", &json!({})).unwrap_err().to_string();
        assert!(first.contains("Server output:\nauth failed: token=[redacted]"), "{first}");
        assert!(!first.contains("abcdef123456"), "{first}");
        let again = reg.call(dir.path(), "mcp__hang__x", &json!({})).unwrap_err().to_string();
        assert!(
            again.contains("failed: it failed to start earlier in this session: MCP server closed the connection."),
            "{again}"
        );
        assert!(!again.contains("Server output") && !again.contains("auth failed"), "{again}");
    }

    #[test]
    fn keys_octopush_doesnt_know_round_trip() {
        let file = r#"{"mcpServers":{"example":{"command":"uvx","args":["example-server"],"env":{"LOG":"debug"},"cwd":"/repo","type":"stdio","disabled":true,"timeout":{"ms":5000}}}}"#;
        let servers = parse_mcp_config(file);
        let cfg = &servers["example"];
        assert_eq!(cfg.command, "uvx");
        assert_eq!(cfg.extra.get("cwd"), Some(&json!("/repo")));
        assert_eq!(cfg.extra.get("disabled"), Some(&json!(true)));
        // Written the way `save_user_config` writes it, then read again.
        let written = json!({ "mcpServers": servers }).to_string();
        let back: Value = serde_json::from_str(&written).unwrap();
        let original: Value = serde_json::from_str(file).unwrap();
        assert_eq!(back, original, "every key survives a save");
        assert_eq!(parse_mcp_config(&written), servers);
        // An entry with none still writes only its own keys.
        let plain = McpServerConfig { command: "uvx".into(), ..Default::default() };
        assert_eq!(serde_json::to_value(&plain).unwrap(), json!({ "command": "uvx", "args": [], "env": {} }));
    }

    #[test]
    fn stderr_keeps_its_head_and_its_tail() {
        let mut log = StderrLog::default();
        log.push("starting example-server");
        for i in 0..2000 {
            log.push(&format!("debug line {i}"));
        }
        log.push("Fatal error: the last thing it said");
        let text = log.text();
        assert!(text.starts_with("starting example-server\n"), "{text}");
        assert!(text.trim_end().ends_with("Fatal error: the last thing it said"), "{text}");
        assert!(text.contains(" lines cut)\n"), "{text}");
        assert!(text.len() <= STDERR_HEAD + STDERR_TAIL + 64, "{} bytes", text.len());
        // A short log is kept whole, with no marker.
        let mut short = StderrLog::default();
        short.push("one");
        short.push("two");
        assert_eq!(short.text(), "one\ntwo\n");
        // One huge line keeps its end.
        let mut huge = StderrLog::default();
        huge.push(&"x".repeat(STDERR_HEAD));
        huge.push(&format!("{}END", "y".repeat(3 * STDERR_TAIL)));
        assert!(huge.text().trim_end().ends_with("END") && huge.text().len() <= STDERR_HEAD + STDERR_TAIL + 64);
    }

    #[test]
    fn known_secrets_are_the_servers_env_values_that_could_be_credentials() {
        let cfg = McpServerConfig {
            command: "uvx".into(),
            env: HashMap::from([
                ("API_KEY".to_string(), "k-1234567890".to_string()),
                ("LOG".to_string(), "debug".to_string()),
                ("PATH".to_string(), "/opt/homebrew/bin:/usr/bin".to_string()),
                ("CA".to_string(), "/etc/ssl/ca-bundle.pem".to_string()),
                ("PORT".to_string(), "123456789".to_string()),
            ]),
            ..Default::default()
        };
        let known = known_secrets(&cfg);
        let text = redact_text("key k-1234567890 at debug level on /opt/homebrew/bin port 123456789", &known);
        assert_eq!(text, "key [redacted] at debug level on /opt/homebrew/bin port 123456789");
        // A plain name's short or host-like value stays; a long random one goes.
        let cfg = McpServerConfig {
            command: "uvx".into(),
            env: HashMap::from([
                ("STAGE".to_string(), "production".to_string()),
                ("HOST".to_string(), "internal-mcp.corp.example.com".to_string()),
                ("SESSION".to_string(), "a8f3k29dk3m4n5b6v7c8x9".to_string()),
            ]),
            ..Default::default()
        };
        let text = redact_text("production at internal-mcp.corp.example.com with a8f3k29dk3m4n5b6v7c8x9", &known_secrets(&cfg));
        assert_eq!(text, "production at internal-mcp.corp.example.com with [redacted]");
    }

    #[test]
    fn a_bridge_value_is_known_from_four_characters() {
        let known = |v: &str| {
            let cfg = McpServerConfig {
                command: "npx".into(),
                env: HashMap::from([
                    ("OCTOPUSH_MCP_H_X_SESSION".to_string(), v.to_string()),
                    ("OCTOPUSH_MCP_CLIENT_SECRET".to_string(), v.to_string()),
                ]),
                ..Default::default()
            };
            known_secrets(&cfg).len()
        };
        assert_eq!(known("abc"), 0, "three characters would redact every `abc` in the output");
        assert_eq!(known("abcd"), 2, "four are enough, whatever their shape");
        assert_eq!(known("  ab  "), 0, "trimmed first");
    }

    #[test]
    fn a_bridges_header_values_and_a_webhook_url_are_always_known() {
        let cfg = McpServerConfig {
            command: "npx".into(),
            env: HashMap::from([
                ("OCTOPUSH_MCP_H_AUTHORIZATION".to_string(), "Bearer tok-abc".to_string()),
                ("OCTOPUSH_MCP_H_COOKIE".to_string(), "sid=x9".to_string()),
                ("OCTOPUSH_MCP_H_X_SESSION".to_string(), "short".to_string()),
                ("OCTOPUSH_MCP_CLIENT_SECRET".to_string(), "shh1".to_string()),
                ("NOTIFY".to_string(), "https://hooks.example.com/services/T0/B0/abc".to_string()),
                ("CALLBACK".to_string(), "https://hooks.example.com?sig=abc".to_string()),
                ("UPSTREAM".to_string(), "https://mcp.example.com".to_string()),
                ("REGION".to_string(), "eu-west-1".to_string()),
            ]),
            ..Default::default()
        };
        let known = known_secrets(&cfg);
        let text = redact_text(
            "token tok-abc · cookie sid=x9 · session short · secret shh1 · https://hooks.example.com/services/T0/B0/abc · \
             https://hooks.example.com?sig=abc · upstream https://mcp.example.com in eu-west-1",
            &known,
        );
        for secret in ["tok-abc", "sid=x9", "short", "shh1", "services/T0", "sig=abc"] {
            assert!(!text.contains(secret), "{secret} in {text}");
        }
        assert!(text.contains("upstream https://mcp.example.com in eu-west-1"), "{text}");
    }

    #[cfg(unix)]
    #[test]
    fn a_failure_never_shows_the_servers_own_env() {
        const ECHO_ENV: &str = "#!/usr/bin/env bash\necho start >> \"$SPAWN_LOG\"\nread -r line\necho \"using $SAMPLE_TOKEN\"\nexit 1\n";
        let (dir, _log) = fixture_dir(ECHO_ENV);
        let cfg = fixture_config(dir.path(), &[("SAMPLE_TOKEN", "sample-value-123")]);
        let err = McpRegistry::test_connect("fix", &cfg).unwrap_err();
        assert!(err.contains("using [redacted]") && !err.contains("sample-value-123"), "{err}");
        write_servers(dir.path(), &HashMap::from([("fix".to_string(), cfg)]));
        let err = McpRegistry::trusting_projects().call(dir.path(), "mcp__fix__x", &json!({})).unwrap_err().to_string();
        assert!(!err.contains("sample-value-123"), "{err}");
    }

    #[test]
    fn namespacing_roundtrips() {
        assert_eq!(namespaced_name("github", "create_issue"), "mcp__github__create_issue");
        assert_eq!(
            parse_namespaced("mcp__github__create_issue"),
            Some(("github".into(), "create_issue".into()))
        );
        assert!(is_mcp_tool("mcp__x__y"));
        assert!(!is_mcp_tool("read_file"));
        assert!(parse_namespaced("read_file").is_none());
        assert_eq!(server_of("mcp__github__create_issue").as_deref(), Some("github"));
        assert_eq!(server_of("read_file"), None);
    }
}
