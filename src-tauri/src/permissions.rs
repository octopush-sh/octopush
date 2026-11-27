//! Talk's permission modes (#1146): one pure policy, asked before every tool
//! call of a Talk turn, by the director and by each of its sub-agents. A mode
//! only ever makes Talk stricter. Everything a mode allows still meets the
//! guards (`talk_guard`, the command check, the secret guard), and no mode
//! answers their cards.
//!
//! The tool list never changes with the mode: a refused call gets a fixed
//! tool result instead, so a mode switch doesn't rewrite the provider's
//! cached prefix.

use crate::db::Db;
use crate::orchestrator::agentic::{ToolGate, ASK_DIRECTOR_TOOL, ASK_STAGE_TOOL, SUBMIT_VERDICT_TOOL};
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;

/// A conversation's posture. In the UI: Plan only, Ask first, Edit freely.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Plan,
    Ask,
    Edit,
}

impl Mode {
    /// The mode `chat_threads.permission_mode` holds. NULL, which every
    /// thread from before the column has, is Edit freely: today's behaviour.
    /// A value this build doesn't know reads as Plan only, so a mode written
    /// by a newer build never loosens an older one.
    pub fn from_stored(raw: Option<&str>) -> Mode {
        match raw {
            None | Some("edit") => Mode::Edit,
            Some("ask") => Mode::Ask,
            _ => Mode::Plan,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Plan => "plan",
            Mode::Ask => "ask",
            Mode::Edit => "edit",
        }
    }

    /// The modes a conversation can be set to in this build. Ask first
    /// arrives with its approval card.
    pub fn settable(raw: &str) -> Option<Mode> {
        match raw {
            "plan" => Some(Mode::Plan),
            "edit" => Some(Mode::Edit),
            _ => None,
        }
    }
}

/// What a tool call does, as the policy sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    Read,
    Write,
    Exec,
    /// An MCP tool: it reaches a server, which may change external state.
    Net,
    /// `Agent` / `Task`: starts a sub-agent.
    Delegate,
    /// The loop's own tools (recall, load a skill, ask the director, a
    /// verdict, ask a stage).
    Meta,
}

/// The class of a tool by name. A tool this policy doesn't know is a write
/// until it is classified here, so Plan only never runs a new tool unseen.
pub fn classify(name: &str) -> Class {
    match name {
        "read_file" | "list_files" | "grep" | "glob" => Class::Read,
        "run_command" => Class::Exec,
        crate::chat_engine::RECALL_TOOL_NAME
        | crate::skills::SKILL_TOOL_NAME
        | ASK_DIRECTOR_TOOL
        | SUBMIT_VERDICT_TOOL
        | ASK_STAGE_TOOL => Class::Meta,
        n if crate::chat_agents::is_agent_tool(n) => Class::Delegate,
        n if crate::mcp::is_mcp_tool(n) => Class::Net,
        _ => Class::Write,
    }
}

/// One tool call, as the model made it.
pub struct ToolCall<'a> {
    pub name: &'a str,
    pub input: &'a Value,
}

/// What the host knows about the call that the name doesn't say.
pub struct PolicyCtx<'a> {
    /// The write roots the host runs this call's command under. `Some([])`
    /// is the read-only seatbelt profile (temp files only).
    pub exec_roots: Option<&'a [String]>,
    /// The MCP tools this turn discovered with `readOnlyHint`.
    pub mcp_read_only: &'a HashSet<String>,
    /// For a Delegate call: it names a defined agent type whose tools can
    /// change the workspace ([`crate::chat_agents::definition_can_write`]).
    /// An untyped call runs: its sub-agent is bound by the same mode
    /// ([`ModeGate`]) and the same sandbox.
    pub delegate_writes: bool,
    /// Plan only is forced by a read-only mission rather than chosen, so a
    /// refusal names the mission and offers no switch.
    pub forced: bool,
    /// The workspace's mission ships nothing ([`crate::mission::ships_nothing`]):
    /// in every mode, a command that changes something elsewhere
    /// ([`remote_effect_local`]) and an MCP tool its server doesn't mark
    /// read-only are refused.
    pub ships_nothing: bool,
}

/// What a ship-nothing mission gives a command that changes something
/// elsewhere, with what it would change.
pub fn ship_nothing_command_refusal(what: &str) -> String {
    format!(
        "Not run: this mission runs everything locally and ships nothing, so no command that changes something \
         elsewhere ({what}). Note it in your findings instead."
    )
}

/// What a ship-nothing mission gives an MCP tool its server doesn't mark read-only.
pub const SHIP_NOTHING_MCP: &str = "Not called: this mission ships nothing, and this MCP tool's server doesn't mark \
     it read-only. Use a read-only tool, or note the step in your findings.";

/// The refusal a ship-nothing mission gives `call` before any mode decides,
/// or `None` when the mode decides it.
fn ship_nothing_refusal(call: &ToolCall, ctx: &PolicyCtx) -> Option<String> {
    if !ctx.ships_nothing {
        return None;
    }
    match classify(call.name) {
        Class::Exec => {
            let command = call.input.get("command").and_then(Value::as_str).unwrap_or("");
            remote_effect_local(command).map(ship_nothing_command_refusal)
        }
        Class::Net if !ctx.mcp_read_only.contains(call.name) => Some(SHIP_NOTHING_MCP.to_string()),
        _ => None,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    Allow,
    /// Ask first: the call waits for the user. `preview` is what the card
    /// shows (the command, or the file).
    Ask { reason: String, preview: String },
    Deny { message: String },
}

/// What Plan only refused, for its fixed result.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    Write,
    Net,
    /// A command the host couldn't put on the read-only sandbox.
    Unconfined,
    Delegate,
    /// A command that changes something elsewhere, and what ([`remote_effect`]).
    Remote(&'static str),
}

/// The fixed result Plan only gives a call it refuses, saying why Plan only
/// applies. When a read-only mission forces it, the text names the mission
/// and offers no switch to Edit freely, which doesn't exist there.
pub fn plan_refusal(refused: Refused, forced: bool) -> String {
    let why = if forced {
        "this workspace's mission is read-only, so Talk works in Plan only mode here"
    } else {
        "this conversation is in Plan only mode"
    };
    match refused {
        Refused::Write if forced => {
            format!("Not done: {why}, and no file can be written or edited. Report what you found and what you would change.")
        }
        Refused::Write => format!(
            "Not done: {why}, so no file can be written or edited. Keep exploring and present your plan; \
             the user can switch to Edit freely to carry it out."
        ),
        Refused::Net => format!(
            "Not called: {why}, and this MCP tool's server doesn't mark it read-only. Use a read-only tool, \
             or leave the step in your plan."
        ),
        Refused::Unconfined => {
            format!("Not run: {why}, and this command couldn't be put under the read-only sandbox. Read with the file tools instead.")
        }
        Refused::Delegate => format!(
            "Not started: {why}, which starts untyped sub-agents and read-only agent types only (no write, edit \
             or shell tool). Leave the type out, or name a read-only one."
        ),
        Refused::Remote(what) => format!(
            "Not run: {why}, which allows reading and fetching but no command that changes something elsewhere \
             ({what}). Leave the step in your plan."
        ),
    }
}

/// What a call that Ask first would hold gets until Ask first can ask.
pub const ASK_UNAVAILABLE: &str = "Not done: this conversation is in Ask first mode, which this version can't ask \
     in yet. Nothing was changed. Tell the user, who can switch the conversation to Edit freely or Plan only.";

/// Whether `call` may run in `mode`.
///
/// - **Plan only:** reads and the loop's own tools run. Writes are refused.
///   A command runs only under the read-only sandbox, and not when it
///   changes something elsewhere ([`remote_effect`]). An MCP tool runs only
///   when its server marks it read-only, and a sub-agent unless it names a
///   type that writes.
/// - **Ask first:** writes and commands ask.
/// - **Edit freely:** everything runs, as before modes existed.
///
/// A mission that ships nothing refuses, in every mode, a command that
/// changes something elsewhere and an MCP tool not marked read-only; what it
/// lets through, the mode then decides.
pub fn decide(mode: Mode, call: &ToolCall, ctx: &PolicyCtx) -> Decision {
    if let Some(message) = ship_nothing_refusal(call, ctx) {
        return Decision::Deny { message };
    }
    let field = |key: &str| call.input.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let refuse = |r: Refused| Decision::Deny { message: plan_refusal(r, ctx.forced) };
    match (mode, classify(call.name)) {
        (Mode::Edit, _) | (_, Class::Read | Class::Meta) => Decision::Allow,
        (Mode::Plan, Class::Write) => refuse(Refused::Write),
        (Mode::Plan, Class::Exec) => match remote_effect(&field("command")) {
            Some(what) => refuse(Refused::Remote(what)),
            None if matches!(ctx.exec_roots, Some([])) => Decision::Allow,
            None => refuse(Refused::Unconfined),
        },
        (Mode::Plan, Class::Net) if ctx.mcp_read_only.contains(call.name) => Decision::Allow,
        (Mode::Plan, Class::Net) => refuse(Refused::Net),
        (Mode::Plan, Class::Delegate) if !ctx.delegate_writes => Decision::Allow,
        (Mode::Plan, Class::Delegate) => refuse(Refused::Delegate),
        (Mode::Ask, Class::Write) => Decision::Ask { reason: "changes a file".into(), preview: field("path") },
        (Mode::Ask, Class::Exec) => Decision::Ask { reason: "runs a command".into(), preview: field("command") },
        (Mode::Ask, Class::Net | Class::Delegate) => Decision::Allow,
    }
}

/// The tool result a call gets instead of running, or `None` when it runs.
/// Until Ask first can ask, what it would hold is refused, never run.
pub fn refusal(decision: Decision) -> Option<String> {
    match decision {
        Decision::Allow => None,
        Decision::Deny { message } => Some(message),
        Decision::Ask { .. } => Some(ASK_UNAVAILABLE.to_string()),
    }
}

/// What a command would change outside this Mac, or `None`. Plan only means
/// no changes to the world, so it refuses these even on the read-only
/// sandbox, which doesn't stop the network. A heuristic over the command's
/// words, read like the command check reads them: every nested command
/// ([`crate::chat_engine::each_command`]), each word as the shell splits it
/// ([`crate::chat_engine::command_words`]: quotes, redirections), past
/// keywords and wrappers (`then`, `do`, `!`, `sudo`, `eval`…). Not a network
/// sandbox. It knows pushing, publishing, deploying and sending tools
/// (`git push`, `gh`/`hub` writes, `curl`/`wget`/httpie that send data,
/// package publishing and release tools, `docker push`,
/// `kubectl`/`helm`/`terraform` changes); reading and fetching pass.
pub fn remote_effect(command: &str) -> Option<&'static str> {
    remote_effect_in(command, false)
}

/// [`remote_effect`] for a mission that ships nothing, which runs what it
/// tests on this Mac: the same walk, except that a `curl`, `wget` or httpie
/// request whose every URL is on a loopback host ([`loopback_url`]) counts
/// as local. A request with no URL it can read, or one that names a proxy,
/// a resolve override or a socket, stays remote.
pub fn remote_effect_local(command: &str) -> Option<&'static str> {
    remote_effect_in(command, true)
}

fn remote_effect_in(command: &str, local: bool) -> Option<&'static str> {
    crate::chat_engine::each_command(command, |line| remote_line(line, local))
        .unwrap_or(Some("nests more commands than the check reads"))
}

/// Shell keywords and programs that run the command after them
/// (`then git push`, `env X=1 git push`, `sudo -u x git push`).
const WRAPPERS: &[&str] = &[
    "then", "do", "else", "elif", "if", "while", "until", "!", "{", "time", "exec", "nohup", "xargs", "command", "builtin",
    "env", "nice", "sudo", "doas", "timeout", "gtimeout", "caffeinate", "stdbuf", "watch",
];

type RemoteRule = fn(&[&str]) -> Option<&'static str>;

fn remote_line(line: &str, local: bool) -> Option<&'static str> {
    let words = crate::chat_engine::command_words(line);
    // A proxy named anywhere on the line (`HTTPS_PROXY=… curl`, `env
    // ALL_PROXY=…`, `export http_proxy=…;`, `--proxy`) can send a loopback
    // request elsewhere, so it keeps none local.
    let local = local && !words.iter().any(|w| w.role != crate::chat_engine::WordRole::Data && names_proxy(&w.word));
    let mut segments: Vec<Vec<&str>> = Vec::new();
    let mut last = None;
    for w in &words {
        if last != Some(w.segment) {
            segments.push(Vec::new());
            last = Some(w.segment);
        }
        // What runs: the program and its arguments, not a here-document's
        // body or a redirection's target.
        let started = segments.last().is_some_and(|s| !s.is_empty());
        let runs = w.role == crate::chat_engine::WordRole::Program || (started && w.role == crate::chat_engine::WordRole::Argument);
        if runs && !w.redirect {
            if let Some(seg) = segments.last_mut() {
                seg.push(w.word.as_str());
            }
        }
    }
    segments.iter().find_map(|seg| remote_command(seg, local))
}

fn program(w: &str) -> String {
    w.rsplit('/').next().unwrap_or(w).to_ascii_lowercase()
}

/// `words` from the program on. With `local`, a request to loopback hosts
/// only is no remote effect ([`remote_effect_local`]).
fn remote_command(words: &[&str], local: bool) -> Option<&'static str> {
    let (first, rest) = words.split_first()?;
    let name = program(first);
    if name == "eval" {
        return remote_effect_in(&rest.join(" "), local);
    }
    if WRAPPERS.contains(&name.as_str()) {
        // A wrapper's own flags and values (`sudo -u x`, `timeout 10`) come first.
        let at = rest.iter().position(|&w| program(w) == "eval" || remote_rule(&program(w)).is_some())?;
        return remote_command(&rest[at..], local);
    }
    let what = remote_rule(&name)?(rest)?;
    let loopback = match name.as_str() {
        "curl" => curl_loopback(rest),
        "wget" => wget_loopback(rest),
        "http" | "https" | "xh" | "xhs" => httpie_loopback(rest),
        _ => false,
    };
    (!(local && loopback)).then_some(what)
}

/// A word that names a proxy: a flag (`--proxy`, `--socks5`, `-e
/// https_proxy=…` reads as its value) or a variable set before a command.
fn names_proxy(word: &str) -> bool {
    let w = word.to_ascii_lowercase();
    let name = match w.split_once('=') {
        Some((name, _)) if !name.contains('/') => name,
        _ if w.starts_with('-') => w.as_str(),
        _ => return false,
    };
    name.contains("proxy") || name.starts_with("--socks")
}

/// Whether `host` is this Mac: `localhost`, a `*.localhost` name,
/// `127.0.0.0/8` written as four decimal parts, or `::1`. Nothing that only
/// looks local (`localhost.example.com`, `127.0.0.1.example.com`).
fn loopback_host(host: &str) -> bool {
    if host == "localhost" || host == "::1" {
        return true;
    }
    if let Some(sub) = host.strip_suffix(".localhost") {
        return !sub.is_empty() && sub.split('.').all(|l| !l.is_empty() && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
    }
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4
        && parts[0] == "127"
        && parts.iter().all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()) && p.parse::<u16>().is_ok_and(|n| n <= 255))
}

/// Whether `url` (an `http`/`https` URL, or one with no scheme) names a
/// loopback host ([`loopback_host`]). Userinfo (`a@b`), escapes and a port
/// that isn't digits read as not loopback: they could name another host.
fn loopback_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let rest = match lower.split_once("://") {
        Some(("http" | "https", rest)) => rest,
        Some(_) => return false,
        None => lower.as_str(),
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains(['@', '\\', '%']) {
        return false;
    }
    let (host, port) = match authority.strip_prefix('[') {
        Some(v6) => match v6.split_once(']') {
            Some((h, "")) => (h, None),
            Some((h, p)) => match p.strip_prefix(':') {
                Some(p) => (h, Some(p)),
                None => return false,
            },
            None => return false,
        },
        None => match authority.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        },
    };
    port.is_none_or(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())) && loopback_host(host)
}

/// The URLs of a request: every word that isn't a flag or a flag's value,
/// plus what `url_flags` name. `None` when a flag can redirect the request
/// (`force`), so nothing counts as loopback. `short_valued` are the short
/// flags that take a value, in a cluster (`-sSd x`, `-XPOST`) too.
fn request_urls<'a>(
    args: &[&'a str],
    long_valued: &[&str],
    short_valued: &str,
    url_flags: &[&str],
    force: &[&str],
    short_force: &str,
) -> Option<Vec<&'a str>> {
    let mut urls = Vec::new();
    let mut it = args.iter();
    while let Some(&a) = it.next() {
        if let Some(long) = a.strip_prefix("--") {
            let (name, attached) = match long.split_once('=') {
                Some((n, v)) => (format!("--{n}"), Some(v)),
                None => (format!("--{long}"), None),
            };
            // Its abbreviations too (`--resol`, `--conf`), which getopt reads
            // as the whole flag.
            if force.iter().any(|f| f.starts_with(name.as_str())) {
                return None;
            }
            let takes = url_flags.contains(&name.as_str()) || long_valued.contains(&name.as_str());
            let value = if takes { attached.or_else(|| it.next().copied()) } else { None };
            if url_flags.contains(&name.as_str()) {
                urls.push(value?);
            }
        } else if let Some(cluster) = a.strip_prefix('-').filter(|c| !c.is_empty()) {
            for (j, c) in cluster.char_indices() {
                if short_force.contains(c) {
                    return None;
                }
                if short_valued.contains(c) {
                    if cluster[j + c.len_utf8()..].is_empty() {
                        it.next();
                    }
                    break;
                }
            }
        } else {
            urls.push(a);
        }
    }
    Some(urls)
}

/// Every URL of a `curl` request is on a loopback host.
fn curl_loopback(args: &[&str]) -> bool {
    const VALUED: &[&str] = &[
        "--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode", "--json", "--form", "--form-string",
        "--header", "--request", "--output", "--output-dir", "--user", "--user-agent", "--referer", "--cookie", "--cookie-jar",
        "--max-time", "--connect-timeout", "--retry", "--retry-delay", "--retry-max-time", "--write-out", "--upload-file",
        "--cacert", "--capath", "--cert", "--cert-type", "--key", "--key-type", "--dump-header", "--range", "--continue-at",
        "--limit-rate", "--max-filesize", "--oauth2-bearer", "--trace", "--trace-ascii", "--stderr", "--interface",
        "--local-port", "--variable", "--url-query", "--quote", "--telnet-option", "--ftp-port", "--speed-limit",
        "--speed-time", "--time-cond", "--expect100-timeout", "--keepalive-time", "--netrc-file", "--create-file-mode",
    ];
    const FORCE: &[&str] = &[
        "--config", "--resolve", "--connect-to", "--unix-socket", "--abstract-unix-socket", "--doh-url", "--proxy",
        "--preproxy", "--noproxy", "--socks4", "--socks4a", "--socks5", "--socks5-hostname",
    ];
    request_urls(args, VALUED, "dHouAebcmwxrEDCYyzUQtPXFTK", &["--url"], FORCE, "xK")
        .is_some_and(|urls| !urls.is_empty() && urls.iter().all(|u| loopback_url(u)))
}

/// Every URL of a `wget` request is on a loopback host. A URL list read
/// from a file (`-i`), a base (`-B`) or a setting (`-e`) can't be read.
fn wget_loopback(args: &[&str]) -> bool {
    const VALUED: &[&str] = &[
        "--output-document", "--output-file", "--append-output", "--directory-prefix", "--user-agent", "--tries",
        "--timeout", "--wait", "--waitretry", "--quota", "--level", "--header", "--post-data", "--post-file", "--body-data",
        "--body-file", "--method", "--user", "--password", "--http-user", "--http-password", "--load-cookies",
        "--save-cookies", "--referer", "--ca-certificate", "--certificate", "--private-key", "--limit-rate", "--domains",
        "--reject", "--accept", "--dns-timeout", "--connect-timeout", "--read-timeout",
    ];
    const FORCE: &[&str] = &["--input-file", "--base", "--execute", "--config", "--bind-address", "--proxy"];
    request_urls(args, VALUED, "OoaPUtTwQlDRAXI", &[], FORCE, "iBeY")
        .is_some_and(|urls| !urls.is_empty() && urls.iter().all(|u| loopback_url(u)))
}

/// An httpie request's URL is on a loopback host. httpie reads `:3000/x`
/// as `localhost:3000/x`.
fn httpie_loopback(args: &[&str]) -> bool {
    const METHODS: &[&str] = &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
    let ops = operands(args, HTTPIE_VALUED);
    let url = match ops.split_first() {
        Some((m, rest)) if METHODS.iter().any(|x| m.eq_ignore_ascii_case(x)) => rest.first(),
        Some((u, _)) => Some(u),
        None => None,
    };
    url.is_some_and(|u| match u.strip_prefix(':') {
        Some(rest) => loopback_url(&format!("localhost:{rest}")),
        None => loopback_url(u),
    })
}

fn remote_rule(program: &str) -> Option<RemoteRule> {
    let rule: RemoteRule = match program {
        "git" => git_remote,
        "gh" => gh_remote,
        "hub" => hub_remote,
        "curl" => curl_remote,
        "wget" => wget_remote,
        "http" | "https" | "xh" | "xhs" => httpie_remote,
        "npm" | "pnpm" | "yarn" | "bun" | "npx" | "pnpx" | "bunx" | "cargo" | "pip" | "pip3" | "poetry" | "uv" | "uvx" | "twine"
        | "gem" => publish_remote,
        "python" | "python3" | "py" => python_remote,
        "docker" | "podman" => docker_remote,
        "kubectl" | "oc" | "helm" | "terraform" | "tofu" => deploy_remote,
        _ => return None,
    };
    Some(rule)
}

/// The words that aren't flags; a flag in `valued` takes the next word.
fn operands<'a>(args: &[&'a str], valued: &[&str]) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if valued.contains(a) {
            it.next();
        } else if !a.starts_with('-') {
            out.push(*a);
        }
    }
    out
}

fn is_read_method(m: &str) -> bool {
    m.eq_ignore_ascii_case("GET") || m.eq_ignore_ascii_case("HEAD")
}

fn git_remote(args: &[&str]) -> Option<&'static str> {
    let ops = operands(args, &["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
    match ops.first().map(|s| s.to_ascii_lowercase()).as_deref() {
        Some("push") => Some("git push"),
        Some("send-email") => Some("git send-email"),
        _ => None,
    }
}

/// `gh` verbs that change GitHub, in groups other than the local ones.
const GH_WRITES: &[&str] = &[
    "create", "merge", "close", "reopen", "comment", "edit", "delete", "review", "ready", "lock", "unlock", "transfer",
    "pin", "unpin", "upload", "archive", "unarchive", "rename", "fork", "sync", "set", "add", "remove", "run", "rerun",
    "cancel", "enable", "disable", "develop", "deploy",
];

/// `gh api` / `hub api` send a GET unless a method is named or a field is given.
fn api_sends(args: &[&str]) -> bool {
    let (mut method, mut fields) = (None, false);
    for (i, a) in args.iter().enumerate() {
        if *a == "-X" || *a == "--method" {
            method = args.get(i + 1).copied();
        } else if let Some(m) = a.strip_prefix("--method=").or_else(|| a.strip_prefix("-X").filter(|m| !m.is_empty())) {
            method = Some(m);
        } else if ["-f", "-F", "--field", "--raw-field", "--input"].iter().any(|f| a.starts_with(f)) {
            fields = true;
        }
    }
    method.map_or(fields, |m| !is_read_method(m))
}

fn gh_remote(args: &[&str]) -> Option<&'static str> {
    let ops = operands(args, &["-R", "--repo"]);
    let group = ops.first().map(|s| s.to_ascii_lowercase());
    if group.as_deref() == Some("api") {
        return api_sends(args).then_some("gh api with a method other than GET");
    }
    let local = matches!(group.as_deref(), Some("alias" | "config" | "extension" | "ext" | "completion" | "auth" | "help"));
    let verb = ops.get(1).map(|s| s.to_ascii_lowercase());
    (!local && verb.is_some_and(|v| GH_WRITES.contains(&v.as_str()))).then_some("a gh command that changes GitHub")
}

/// `hub` wraps git and adds GitHub commands of its own.
fn hub_remote(args: &[&str]) -> Option<&'static str> {
    let ops = operands(args, &["-C", "-c"]);
    let changes = match ops.first().map(|s| s.to_ascii_lowercase()).as_deref() {
        Some("pull-request" | "create" | "fork" | "delete") => true,
        Some("api") => api_sends(args),
        _ => git_remote(args).is_some() || gh_remote(args).is_some(),
    };
    changes.then_some("a hub command that changes GitHub")
}

fn curl_remote(args: &[&str]) -> Option<&'static str> {
    const WHY: &str = "curl that sends data, uses a method other than GET, or reads a config file";
    // `-G` sends `-d` data as a GET query.
    let get = args.iter().any(|a| *a == "-G" || *a == "--get");
    for (i, a) in args.iter().enumerate() {
        let method = match *a {
            "-X" | "--request" => args.get(i + 1).copied(),
            _ => a.strip_prefix("--request="),
        };
        let sends_long = |flags: &[&str]| flags.iter().any(|f| a == f || a.strip_prefix(f).is_some_and(|r| r.starts_with('=')));
        // A config file can name any of these, so it isn't read past.
        if method.is_some_and(|m| !is_read_method(m))
            || sends_long(&["--form", "--form-string", "--upload-file", "--config"])
            || (!get && sends_long(&["--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json"]))
        {
            return Some(WHY);
        }
        // A cluster of short flags (`-sSd x`, `-XPOST`): a flag that takes a
        // value ends it.
        if let Some(cluster) = a.strip_prefix('-').filter(|c| !c.starts_with('-')) {
            for (j, c) in cluster.char_indices() {
                match c {
                    'F' | 'T' | 'K' => return Some(WHY),
                    'd' if !get => return Some(WHY),
                    'X' => {
                        let rest = &cluster[j + 1..];
                        let m = if rest.is_empty() { args.get(i + 1).copied().unwrap_or("") } else { rest };
                        if !is_read_method(m) {
                            return Some(WHY);
                        }
                        break;
                    }
                    c if "dHouAebcmwxrEDCYyzUQtP".contains(c) => break,
                    _ => {}
                }
            }
        }
    }
    None
}

fn wget_remote(args: &[&str]) -> Option<&'static str> {
    args.iter().enumerate().find_map(|(i, a)| {
        let method = if *a == "--method" { args.get(i + 1).copied() } else { a.strip_prefix("--method=") };
        let data = ["--post-data", "--post-file", "--body-data", "--body-file"].iter().any(|f| a.starts_with(f));
        (data || method.is_some_and(|m| !is_read_method(m))).then_some("wget that sends data or uses a method other than GET")
    })
}

/// httpie's flags that take a value.
const HTTPIE_VALUED: &[&str] = &[
    "-a", "--auth", "-A", "--auth-type", "--session", "--session-read-only", "-o", "--output", "-p", "--print", "--proxy",
    "--timeout", "--verify", "--cert", "--cert-key", "--pretty", "-s", "--style",
];

/// httpie (`http [METHOD] URL [ITEM…]`): the method it names, else POST
/// when an item carries data (`a=b`, `a:=1`, `a@file`; `a==b` is a query,
/// `A:b` a header).
fn httpie_remote(args: &[&str]) -> Option<&'static str> {
    const METHODS: &[&str] = &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
    let ops = operands(args, HTTPIE_VALUED);
    let (method, items) = match ops.split_first() {
        Some((m, rest)) if METHODS.iter().any(|x| m.eq_ignore_ascii_case(x)) => (Some(*m), rest.get(1..).unwrap_or(&[])),
        Some((_, rest)) => (None, rest),
        None => return None,
    };
    let data = |item: &&str| item.contains(":=") || item.contains('@') || item.split_once('=').is_some_and(|(_, v)| !v.starts_with('='));
    let sends = method.map_or_else(|| items.iter().any(data), |m| !is_read_method(m));
    sends.then_some("an httpie request that sends data or uses a method other than GET")
}

/// Release tools that publish when they run (`npx semantic-release`).
const RELEASERS: &[&str] = &["semantic-release", "release-it", "np"];

fn publish_remote(args: &[&str]) -> Option<&'static str> {
    // Past every flag (`npm --workspace a publish`), and in a package an
    // npx-style runner starts (`npx lerna publish`, `npx semantic-release@22`).
    let ops = operands(args, &["--workspace", "-w", "--registry", "--tag", "--otp", "--access", "--filter", "--dir", "--cwd", "--manifest-path", "-p", "--package"]);
    let publishes = |o: &&str| {
        let o = o.to_ascii_lowercase();
        let name = match o.strip_prefix('@') {
            Some(scoped) => scoped.split('@').next().unwrap_or(scoped),
            None => o.split('@').next().unwrap_or(&o),
        };
        matches!(o.as_str(), "publish" | "unpublish" | "deprecate" | "yank" | "owner" | "upload" | "push") || RELEASERS.contains(&name)
    };
    ops.iter().any(publishes).then_some("publishes a package or a release")
}

/// `python -m <module>` runs the module as the program (`python -m twine upload`).
fn python_remote(args: &[&str]) -> Option<&'static str> {
    let at = args.iter().position(|a| *a == "-m")?;
    let module = args.get(at + 1)?;
    remote_rule(&program(module))?(&args[at + 2..])
}

fn docker_remote(args: &[&str]) -> Option<&'static str> {
    args.iter().any(|a| a.eq_ignore_ascii_case("push") || *a == "--push").then_some("docker push")
}

/// Words that change a cluster or infrastructure, anywhere in the command.
const DEPLOY_WRITES: &[&str] = &[
    "apply", "delete", "create", "replace", "patch", "edit", "scale", "label", "annotate", "drain", "cordon", "uncordon",
    "taint", "untaint", "expose", "autoscale", "set", "destroy", "import", "install", "upgrade", "uninstall", "rollback",
    "restart", "undo", "push", "rm", "mv",
];

fn deploy_remote(args: &[&str]) -> Option<&'static str> {
    args.iter()
        .any(|a| DEPLOY_WRITES.contains(&a.to_ascii_lowercase().as_str()))
        .then_some("changes a cluster or infrastructure (kubectl, helm, terraform)")
}

/// The mode a call runs in: a read-only mission forces Plan only, since a
/// mode can narrow a mission's isolation, never widen it.
pub fn effective(mode: Mode, mission_roots: Option<&[String]>) -> Mode {
    if forced(mission_roots) {
        Mode::Plan
    } else {
        mode
    }
}

/// Whether the mission's roots (`Some([])`: read-only) force Plan only.
pub fn forced(mission_roots: Option<&[String]>) -> bool {
    matches!(mission_roots, Some([]))
}

/// The write roots a command runs under in `mode`: Plan only's read-only
/// profile, else the mission's own (`None` = not sandboxed). Never wider
/// than the mission's.
pub fn exec_roots(mode: Mode, mission_roots: Option<&[String]>) -> Option<Vec<String>> {
    match mode {
        Mode::Plan => Some(Vec::new()),
        Mode::Ask | Mode::Edit => mission_roots.map(<[String]>::to_vec),
    }
}

/// A thread's stored mode. A read that fails is Plan only: a mode never
/// loosens on an error.
pub fn thread_mode(db: &Mutex<Db>, thread_id: &str) -> Mode {
    match db.lock().thread_permission_mode(thread_id) {
        Ok(raw) => Mode::from_stored(raw.as_deref()),
        Err(e) => {
            tracing::warn!(error = %e, "could not read the conversation's permission mode; using Plan only");
            Mode::Plan
        }
    }
}

/// A thread's stored mode, and the mode its turns run in now: Plan only
/// when its workspace's active mission is read-only.
pub fn thread_modes(db: &Mutex<Db>, thread_id: &str) -> (Mode, Mode) {
    let stored = thread_mode(db, thread_id);
    let db = db.lock();
    let mission = db
        .chat_thread_workspace(thread_id)
        .ok()
        .flatten()
        .and_then(|w| db.active_mission_for_workspace(&w).ok().flatten());
    // Only whether the roots are empty matters here, not the workspace's path.
    let roots = mission.and_then(|m| crate::orchestrator::sandbox::sandbox_write_roots(&m.git_isolation, &m.exec_isolation, ""));
    (stored, effective(stored, roots.as_deref()))
}

/// How a gate learns the mode at the moment a call is checked.
pub type ModeSource = Arc<dyn Fn() -> Mode + Send + Sync>;

/// A thread's mode, read at each call, within the run's own `roots` (a run
/// that started in Plan only keeps its read-only sandbox, so it stays Plan).
pub fn thread_mode_source(db: Arc<Mutex<Db>>, thread_id: String, roots: Option<Vec<String>>) -> ModeSource {
    Arc::new(move || effective(thread_mode(&db, &thread_id), roots.as_deref()))
}

/// The mode check as a [`ToolGate`], for the loop Talk sub-agents run on:
/// each call is decided in the thread's mode first, then what the mode
/// allows goes to `inner` (the sub-agent's approval gate). Sub-agents never
/// get the `Agent` tool, so a Delegate call is treated as one that writes.
pub struct ModeGate {
    mode: ModeSource,
    exec_roots: Option<Vec<String>>,
    /// A read-only mission forces Plan only ([`PolicyCtx::forced`]).
    forced: bool,
    /// The mission ships nothing ([`PolicyCtx::ships_nothing`]).
    ships_nothing: bool,
    mcp_read_only: HashSet<String>,
    inner: Option<Box<dyn ToolGate>>,
}

impl ModeGate {
    pub fn new(
        mode: ModeSource,
        exec_roots: Option<Vec<String>>,
        forced: bool,
        ships_nothing: bool,
        mcp_read_only: HashSet<String>,
        inner: Option<Box<dyn ToolGate>>,
    ) -> Self {
        Self { mode, exec_roots, forced, ships_nothing, mcp_read_only, inner }
    }
}

#[async_trait::async_trait]
impl ToolGate for ModeGate {
    async fn check(&self, name: &str, input: &Value) -> Option<String> {
        let ctx = PolicyCtx {
            exec_roots: self.exec_roots.as_deref(),
            mcp_read_only: &self.mcp_read_only,
            delegate_writes: true,
            forced: self.forced,
            ships_nothing: self.ships_nothing,
        };
        if let Some(refused) = refusal(decide((self.mode)(), &ToolCall { name, input }, &ctx)) {
            return Some(refused);
        }
        match &self.inner {
            Some(gate) => gate.check(name, input).await,
            None => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx<'a>(roots: Option<&'a [String]>, ro: &'a HashSet<String>, delegate_writes: bool) -> PolicyCtx<'a> {
        PolicyCtx { exec_roots: roots, mcp_read_only: ro, delegate_writes, forced: false, ships_nothing: false }
    }

    fn deny(r: Refused) -> Decision {
        Decision::Deny { message: plan_refusal(r, false) }
    }

    #[test]
    fn mode_by_tool_class_table() {
        let ro: HashSet<String> = ["mcp__docs__search".to_string()].into();
        let sandboxed: &[String] = &[];
        let ws: &[String] = &["/ws".to_string()];
        let input = json!({ "path": "a.rs", "command": "ls" });
        let d = |mode, name: &str, roots: Option<&[String]>, delegate_writes| {
            decide(mode, &ToolCall { name, input: &input }, &ctx(roots, &ro, delegate_writes))
        };
        let allow = Decision::Allow;
        let ask = |reason: &str, preview: &str| Decision::Ask { reason: reason.into(), preview: preview.into() };
        // (tool, Plan only, Ask first, Edit freely), with commands under the
        // read-only profile and an untyped or read-only agent call.
        let table: Vec<(&str, Decision, Decision, Decision)> = vec![
            ("read_file", allow.clone(), allow.clone(), allow.clone()),
            ("list_files", allow.clone(), allow.clone(), allow.clone()),
            ("grep", allow.clone(), allow.clone(), allow.clone()),
            ("glob", allow.clone(), allow.clone(), allow.clone()),
            ("write_file", deny(Refused::Write), ask("changes a file", "a.rs"), allow.clone()),
            ("edit_file", deny(Refused::Write), ask("changes a file", "a.rs"), allow.clone()),
            ("a_tool_nobody_classified", deny(Refused::Write), ask("changes a file", "a.rs"), allow.clone()),
            ("run_command", allow.clone(), ask("runs a command", "ls"), allow.clone()),
            ("mcp__docs__search", allow.clone(), allow.clone(), allow.clone()),
            ("mcp__jira__create_issue", deny(Refused::Net), allow.clone(), allow.clone()),
            ("Agent", allow.clone(), allow.clone(), allow.clone()),
            ("Task", allow.clone(), allow.clone(), allow.clone()),
            ("recall_tool_output", allow.clone(), allow.clone(), allow.clone()),
            ("ask_director", allow.clone(), allow.clone(), allow.clone()),
            ("submit_verdict", allow.clone(), allow.clone(), allow.clone()),
            ("ask_stage", allow.clone(), allow.clone(), allow.clone()),
            ("Skill", allow.clone(), allow.clone(), allow.clone()),
        ];
        for (tool, plan, ask_first, edit) in table {
            assert_eq!(d(Mode::Plan, tool, Some(sandboxed), false), plan, "{tool} in Plan only");
            assert_eq!(d(Mode::Ask, tool, None, false), ask_first, "{tool} in Ask first");
            assert_eq!(d(Mode::Edit, tool, None, true), edit, "{tool} in Edit freely");
        }
        // Plan only runs a command only under the read-only profile, and
        // refuses an agent type that writes.
        assert_eq!(d(Mode::Plan, "run_command", None, false), deny(Refused::Unconfined));
        assert_eq!(d(Mode::Plan, "run_command", Some(ws), false), deny(Refused::Unconfined));
        assert_eq!(d(Mode::Plan, "Agent", Some(sandboxed), true), deny(Refused::Delegate));
        // A command that changes something elsewhere is refused even there.
        let push = json!({ "command": "git push origin main" });
        let plan = decide(Mode::Plan, &ToolCall { name: "run_command", input: &push }, &ctx(Some(sandboxed), &ro, false));
        assert_eq!(plan, deny(Refused::Remote("git push")));
        assert_eq!(decide(Mode::Edit, &ToolCall { name: "run_command", input: &push }, &ctx(None, &ro, false)), allow);
        // Every refusal names the mode, and Ask first refuses until it can ask.
        for r in [Refused::Write, Refused::Net, Refused::Unconfined, Refused::Delegate, Refused::Remote("git push")] {
            assert!(plan_refusal(r, false).contains("Plan only mode"), "{r:?}");
        }
        assert_eq!(refusal(ask("runs a command", "ls")), Some(ASK_UNAVAILABLE.to_string()));
        assert_eq!(refusal(Decision::Allow), None);
    }

    /// Plan only forced by a read-only mission says so, and never offers a
    /// switch to Edit freely, which doesn't exist there.
    #[test]
    fn a_forced_refusal_names_the_mission() {
        for r in [Refused::Write, Refused::Net, Refused::Unconfined, Refused::Delegate, Refused::Remote("git push")] {
            let forced = plan_refusal(r, true);
            assert!(forced.contains("mission is read-only") && forced.contains("Plan only mode"), "{forced}");
            assert!(!forced.contains("Edit freely") && !forced.contains("switch"), "{forced}");
            assert!(!plan_refusal(r, false).contains("mission"), "{r:?}");
        }
        assert!(plan_refusal(Refused::Write, false).contains("switch to Edit freely"));
        let ro = HashSet::new();
        let input = json!({ "path": "a.rs" });
        let sandboxed: &[String] = &[];
        let forced = PolicyCtx { exec_roots: Some(sandboxed), mcp_read_only: &ro, delegate_writes: false, forced: true, ships_nothing: false };
        assert_eq!(
            decide(Mode::Plan, &ToolCall { name: "write_file", input: &input }, &forced),
            Decision::Deny { message: plan_refusal(Refused::Write, true) }
        );
        // A command the forced sandbox stopped names the mission too (#1230);
        // Plan only the user chose keeps the plain note.
        use crate::chat_engine::{name_forced_mission, READ_ONLY_MISSION_NOTE, READ_ONLY_NOTE};
        let stopped = format!("touch: a.rs: Operation not permitted\n{READ_ONLY_NOTE}");
        let named = name_forced_mission(stopped.clone(), true);
        assert!(named.ends_with(READ_ONLY_MISSION_NOTE) && named.contains("mission is read-only"), "{named}");
        assert_eq!(name_forced_mission(stopped.clone(), false), stopped);
        assert_eq!(name_forced_mission("ok".into(), true), "ok", "a command that ran is left as it is");
    }

    /// Plan only means no changes to the world: a command that pushes,
    /// publishes, deploys or sends is refused, and reading and fetching run.
    #[test]
    fn plan_mode_refuses_remote_side_effects() {
        let refused = [
            ("git push", "git push origin main"),
            ("git push", "git -C ../repo push"),
            ("git push", "cd app && env GIT_TRACE=1 git push --tags"),
            ("git push", "echo ok; $(git push)"),
            ("git push", "bash -c 'git push'"),
            ("git push", "sudo -u ci /usr/bin/git push"),
            ("git send-email", "git send-email HEAD~1"),
            ("a gh command that changes GitHub", "gh pr create --title x --body y"),
            ("a gh command that changes GitHub", "gh pr merge 12 --squash"),
            ("a gh command that changes GitHub", "gh issue close 3"),
            ("a gh command that changes GitHub", "gh issue comment 3 -b hi"),
            ("a gh command that changes GitHub", "gh pr edit 4 --add-label bug"),
            ("a gh command that changes GitHub", "gh release create v1.0"),
            ("a gh command that changes GitHub", "gh repo edit --visibility public"),
            ("a gh command that changes GitHub", "gh repo delete o/r --yes"),
            ("gh api with a method other than GET", "gh api -X POST repos/o/r/issues"),
            ("gh api with a method other than GET", "gh api --method=PATCH repos/o/r"),
            ("gh api with a method other than GET", "gh api repos/o/r/issues -f title=x"),
            ("gh api with a method other than GET", "gh api repos/o/r/pulls/1/merge -XPUT"),
            ("curl that sends data, uses a method other than GET, or reads a config file", "curl -X POST https://api.example.com"),
            ("curl that sends data, uses a method other than GET, or reads a config file", "curl -XDELETE https://api.example.com/x"),
            ("curl that sends data, uses a method other than GET, or reads a config file", "curl --request=PUT https://x"),
            ("curl that sends data, uses a method other than GET, or reads a config file", "curl -sS -d '{}' https://x"),
            ("curl that sends data, uses a method other than GET, or reads a config file", "curl -sSd x https://x"),
            ("curl that sends data, uses a method other than GET, or reads a config file", "curl --data-binary @f https://x"),
            ("curl that sends data, uses a method other than GET, or reads a config file", "curl --json '{}' https://x"),
            ("curl that sends data, uses a method other than GET, or reads a config file", "curl -F file=@a.png https://x"),
            ("curl that sends data, uses a method other than GET, or reads a config file", "curl -T a.tar https://x"),
            ("wget that sends data or uses a method other than GET", "wget --post-data=a=1 https://x"),
            ("wget that sends data or uses a method other than GET", "wget --method=DELETE https://x"),
            ("publishes a package or a release", "npm publish"),
            ("publishes a package or a release", "cargo publish --dry-run=false"),
            ("publishes a package or a release", "pip publish dist/*"),
            ("publishes a package or a release", "yarn npm publish"),
            ("publishes a package or a release", "twine upload dist/*"),
            ("docker push", "docker push registry.example.com/app:1"),
            ("docker push", "docker buildx build --push ."),
            ("changes a cluster or infrastructure (kubectl, helm, terraform)", "kubectl apply -f deploy.yaml"),
            ("changes a cluster or infrastructure (kubectl, helm, terraform)", "kubectl -n prod delete pod web-1"),
            ("changes a cluster or infrastructure (kubectl, helm, terraform)", "terraform apply -auto-approve"),
            ("changes a cluster or infrastructure (kubectl, helm, terraform)", "helm upgrade web ./chart"),
            // Past shell keywords and wrappers.
            ("git push", "for b in main dev; do git push origin $b; done"),
            ("git push", "if git diff --quiet; then git push; fi"),
            ("git push", "if git push; then echo ok; fi"),
            ("git push", "while true; do git push; sleep 60; done"),
            ("git push", "! git push"),
            ("git push", "eval git push"),
            ("git push", "eval \"git push --force\""),
            ("git push", "time nohup git push &"),
            // Words as the shell splits them: quotes and redirections.
            ("git push", "git -C \"my dir\" push"),
            ("git push", "git push>/dev/null 2>&1"),
            ("git push", "git push --repo='o r'"),
            // Publishing past every flag, release tools, modules.
            ("publishes a package or a release", "npm --workspace a --workspace b publish"),
            ("publishes a package or a release", "pnpm --filter web publish --no-git-checks"),
            ("publishes a package or a release", "npx semantic-release"),
            ("publishes a package or a release", "npx --yes semantic-release@22"),
            ("publishes a package or a release", "npx lerna publish from-git"),
            ("publishes a package or a release", "python -m twine upload dist/*"),
            ("publishes a package or a release", "python3 -m poetry publish"),
            ("a hub command that changes GitHub", "hub pull-request -m 'Fix it'"),
            ("a hub command that changes GitHub", "hub push origin main"),
            ("a hub command that changes GitHub", "hub release create v1.0"),
            ("a hub command that changes GitHub", "hub api -X POST repos/o/r/issues"),
            ("an httpie request that sends data or uses a method other than GET", "http POST api.example.com/items name=x"),
            ("an httpie request that sends data or uses a method other than GET", "http api.example.com/items name=x"),
            ("an httpie request that sends data or uses a method other than GET", "https PUT api.example.com/items/1 count:=2"),
            ("an httpie request that sends data or uses a method other than GET", "http -f api.example.com/upload file@a.png"),
            ("an httpie request that sends data or uses a method other than GET", "http DELETE api.example.com/items/1"),
            ("curl that sends data, uses a method other than GET, or reads a config file", "curl -K req.cfg https://x"),
            ("curl that sends data, uses a method other than GET, or reads a config file", "curl --config=req.cfg https://x"),
            ("curl that sends data, uses a method other than GET, or reads a config file", "curl -sK req.cfg"),
        ];
        for (why, command) in refused {
            assert_eq!(remote_effect(command), Some(why), "{command}");
        }
        let allowed = [
            "git fetch origin",
            "git log --grep push",
            "git status && git diff",
            "gh pr view 12",
            "gh pr list --state open",
            "gh pr checks 12",
            "gh issue view 3 --comments",
            "gh api repos/o/r/pulls",
            "gh api -X GET repos/o/r/issues -f state=open",
            "gh alias set co 'pr checkout'",
            "curl -sSL https://example.com",
            "curl -I https://example.com",
            "curl -G -d q=1 https://example.com/search",
            "curl -H 'Accept: x' -o out.json https://example.com",
            "wget -q https://example.com/a.tar",
            "npm view react version",
            "cargo build --release",
            "docker pull alpine",
            "kubectl get pods -n prod",
            "terraform plan",
            "echo git push",
            "grep -rn 'git push' .",
            "for f in *.md; do git add \"$f\"; done",
            "if git diff --quiet; then echo clean; fi",
            "git log --format='%s push' -1",
            "git commit -m \"then git push\"",
            "hub pr list",
            "hub api repos/o/r",
            "http api.example.com/items",
            "http GET api.example.com/search q==x Accept:application/json",
            "https HEAD example.com",
            "npx eslint .",
            "npm --workspace a test",
            "python -m http.server 8000",
            "python -m pytest -q",
        ];
        for command in allowed {
            assert_eq!(remote_effect(command), None, "{command}");
        }
        assert!(remote_effect(&"$(".repeat(6)).is_some(), "past the nesting it reads, it refuses");
    }

    const CURL_SENDS: &str = "curl that sends data, uses a method other than GET, or reads a config file";

    /// A mission that ships nothing (#1239): local work runs as the mode
    /// allows, and what would change something elsewhere is refused in every
    /// mode, with text that names the mission. Plan only keeps its own rules.
    #[test]
    fn a_mission_that_ships_nothing_runs_locally() {
        let ro: HashSet<String> = ["mcp__docs__search".to_string()].into();
        let sandboxed: &[String] = &[];
        let decide_in = |mode: Mode, ships_nothing: bool, name: &str, input: &Value| {
            let roots = (mode == Mode::Plan).then_some(sandboxed);
            let ctx = PolicyCtx { exec_roots: roots, mcp_read_only: &ro, delegate_writes: false, forced: false, ships_nothing };
            decide(mode, &ToolCall { name, input }, &ctx)
        };
        let cmd = |c: &str| json!({ "command": c });
        let file = json!({ "path": "src/a.rs", "content": "x", "old_string": "a", "new_string": "b" });
        for c in ["npm ci", "npm test", "npm run build", "git commit -m x", "docker compose up -d", "curl -X POST http://localhost:3000/api/x"] {
            assert_eq!(decide_in(Mode::Edit, true, "run_command", &cmd(c)), Decision::Allow, "{c}");
        }
        for tool in ["write_file", "edit_file", "read_file", "mcp__docs__search", "Agent"] {
            assert_eq!(decide_in(Mode::Edit, true, tool, &file), Decision::Allow, "{tool}");
        }
        let refused = [
            ("git push", "git push origin main"),
            ("git push", "bash -c 'git push'"),
            ("git push", "sudo git push"),
            ("git push", "env GIT_TRACE=1 git push --tags"),
            ("a gh command that changes GitHub", "gh pr create --title x --body y"),
            ("publishes a package or a release", "npm publish"),
            ("docker push", "docker push registry.example.com/app:1"),
            ("changes a cluster or infrastructure (kubectl, helm, terraform)", "kubectl apply -f deploy.yaml"),
            (CURL_SENDS, "curl -X POST https://api.example.com"),
        ];
        for mode in [Mode::Edit, Mode::Ask, Mode::Plan] {
            for (what, c) in refused {
                let want = Decision::Deny { message: ship_nothing_command_refusal(what) };
                assert_eq!(decide_in(mode, true, "run_command", &cmd(c)), want, "{c} in {mode:?}");
            }
            let mcp = Decision::Deny { message: SHIP_NOTHING_MCP.to_string() };
            assert_eq!(decide_in(mode, true, "mcp__jira__create_issue", &json!({})), mcp, "{mode:?}");
            assert_eq!(decide_in(mode, true, "mcp__docs__search", &json!({})), Decision::Allow, "{mode:?}");
        }
        // Plan only's own rules still apply on top, a POST to localhost included.
        assert_eq!(decide_in(Mode::Plan, true, "write_file", &file), deny(Refused::Write));
        assert_eq!(
            decide_in(Mode::Plan, true, "run_command", &cmd("curl -X POST http://localhost:3000/api/x")),
            deny(Refused::Remote(CURL_SENDS))
        );
        assert_eq!(decide_in(Mode::Plan, true, "run_command", &cmd("npm test")), Decision::Allow);
        // Without the posture, Edit freely runs a push as it always has.
        assert_eq!(decide_in(Mode::Edit, false, "run_command", &cmd("git push")), Decision::Allow);
        // The refusals name the mission and offer no switch.
        for text in [ship_nothing_command_refusal("git push"), SHIP_NOTHING_MCP.to_string()] {
            assert!(text.contains("this mission") && text.contains("ships nothing"), "{text}");
            assert!(!text.contains("Edit freely") && !text.contains("switch"), "{text}");
        }
    }

    /// In a ship-nothing mission a request to this Mac is local; anything
    /// that only looks local, mixes in another host or could be sent
    /// elsewhere stays remote. Plan only still refuses every one.
    #[test]
    fn loopback_requests_are_local() {
        let local = [
            "curl -X POST http://localhost:3000/api/x",
            "curl -X POST http://127.0.0.1:8080/x -d '{}'",
            "curl -sS -X PUT 'http://[::1]:3000/items/1' --json '{}'",
            "curl -X POST http://api.localhost/x",
            "curl -XPOST HTTP://LOCALHOST:3000/x",
            "curl -d a=1 localhost:3000/form",
            "curl -X DELETE http://127.0.0.1/a http://localhost/b",
            "curl -H 'Host: api.example.com' -X POST http://127.0.0.2:3000",
            "curl --url http://localhost:3000 -X POST",
            "wget --post-data=a=1 http://localhost:3000/x",
            "http POST :3000/items name=x",
            "http POST localhost:3000/items name=x",
            "https PUT 127.0.0.1:8443/x a=b",
            "sudo curl -X POST http://localhost/x",
        ];
        for c in local {
            assert_eq!(remote_effect_local(c), None, "{c}");
            assert!(remote_effect(c).is_some(), "Plan only still refuses {c}");
        }
        let remote = [
            "curl -X POST https://api.example.com",
            "curl -X POST http://localhost.example.com/x",
            "curl -X POST http://127.0.0.1.example.com/x",
            "curl -X POST http://localhost:3000/x https://api.example.com/y",
            "curl -X POST http://localhost@api.example.com/x",
            "curl -X POST http://localhost%2eexample.com/x",
            "curl -X POST http://127.1/x",
            "curl -X POST http://0x7f.0.0.1/x",
            "curl -X POST 'http://[::2]/x'",
            "curl -X POST http://.localhost/x",
            "curl -X POST http://localhost:$PORT/x",
            "curl -X POST $URL",
            "curl -X POST",
            "curl -X POST ftp://localhost/x",
            "curl -x http://proxy.example.com:8080 -X POST http://localhost:3000/x",
            "curl --prox http://proxy.example.com -X POST http://localhost:3000/x",
            "HTTPS_PROXY=http://proxy.example.com curl -X POST http://localhost:3000/x",
            "env ALL_PROXY=socks5://proxy.example.com curl -X POST http://localhost:3000/x",
            "export http_proxy=http://proxy.example.com; curl -X POST http://localhost:3000/x",
            "curl --resolve localhost:80:203.0.113.5 -X POST http://localhost/x",
            "curl --connect-to localhost:80:api.example.com:80 -X POST http://localhost/x",
            "curl --unix-socket /var/run/docker.sock -X POST http://localhost/images/x/push",
            "wget --post-data=a=1 -i urls.txt",
            "wget --post-data=a=1 -e use_proxy=on http://localhost/x",
            "http POST api.example.com/items name=x",
            "http POST localhost.example.com/items name=x",
        ];
        for c in remote {
            assert!(remote_effect_local(c).is_some(), "{c}");
        }
        // Only requests are read for loopback: a push stays a push.
        assert_eq!(remote_effect_local("git push http://localhost/repo.git"), Some("git push"));
        assert_eq!(remote_effect_local("bash -c 'curl -X POST https://api.example.com'"), Some(CURL_SENDS));
    }

    /// A sub-agent's gate in a ship-nothing mission refuses a push and runs
    /// the tests, in Edit freely.
    #[tokio::test]
    async fn the_mode_gate_keeps_a_mission_shipping_nothing() {
        let gate = ModeGate::new(Arc::new(|| Mode::Edit), None, false, true, HashSet::new(), None);
        let push = gate.check("run_command", &json!({ "command": "git push origin HEAD" })).await;
        assert_eq!(push, Some(ship_nothing_command_refusal("git push")));
        assert_eq!(gate.check("run_command", &json!({ "command": "npm test" })).await, None);
        assert_eq!(gate.check("mcp__jira__add_comment", &json!({})).await, Some(SHIP_NOTHING_MCP.to_string()));
        let shipping = ModeGate::new(Arc::new(|| Mode::Edit), None, false, false, HashSet::new(), None);
        assert_eq!(shipping.check("run_command", &json!({ "command": "git push origin HEAD" })).await, None);
    }

    /// The director decides each round's calls with the turn's mission
    /// posture, and a sub-agent's gate reads it from the workspace's mission.
    /// An `AppHandle` can't be built in a test, so this reads the sources.
    #[test]
    fn the_hosts_read_the_missions_posture() {
        let engine = include_str!("chat_engine.rs");
        assert!(engine.contains("let ships_nothing = crate::mission::read_ships_nothing(&mission);"), "the turn reads the posture");
        let from = engine.find("let mode_denials: HashMap<String, String>").expect("the round's mode decisions");
        let to = from + engine[from..].find("crate::permissions::decide(mode, &call, &ctx)").expect("the decision");
        let ctx = &engine[from..to];
        assert!(ctx.contains("PolicyCtx {") && ctx.contains("ships_nothing,"), "the PolicyCtx in mode_denials reads the mission: {ctx}");
        let agents = include_str!("chat_agents.rs");
        let at = agents.find("pub fn mode_gate(").expect("the sub-agent gate");
        let gate = &agents[at..at + agents[at..].find("\n}\n").unwrap()];
        assert!(gate.contains("crate::mission::workspace_ships_nothing(&db.lock(), &spec.workspace_id)"), "{gate}");
        assert!(gate.contains("        ships_nothing,\n"), "{gate}");
    }

    #[test]
    fn a_mode_narrows_a_mission_never_widens_it() {
        let ws: &[String] = &["/ws".to_string()];
        let read_only: &[String] = &[];
        // A read-only mission forces Plan only, whatever the thread says.
        for m in [Mode::Plan, Mode::Ask, Mode::Edit] {
            assert_eq!(effective(m, Some(read_only)), Mode::Plan);
            assert_eq!(effective(m, Some(ws)), m);
            assert_eq!(effective(m, None), m);
        }
        assert_eq!(exec_roots(Mode::Plan, None), Some(vec![]));
        assert_eq!(exec_roots(Mode::Plan, Some(ws)), Some(vec![]));
        assert_eq!(exec_roots(Mode::Edit, Some(ws)), Some(ws.to_vec()));
        assert_eq!(exec_roots(Mode::Ask, Some(ws)), Some(ws.to_vec()));
        assert_eq!(exec_roots(Mode::Edit, None), None);
        assert_eq!(exec_roots(Mode::Edit, Some(read_only)), Some(vec![]));
    }

    #[test]
    fn null_mode_is_edit() {
        assert_eq!(Mode::from_stored(None), Mode::Edit);
        assert_eq!(Mode::from_stored(Some("edit")), Mode::Edit);
        assert_eq!(Mode::from_stored(Some("plan")), Mode::Plan);
        assert_eq!(Mode::from_stored(Some("ask")), Mode::Ask);
        assert_eq!(Mode::from_stored(Some("bypass")), Mode::Plan, "an unknown mode never loosens");
        assert_eq!((Mode::settable("plan"), Mode::settable("edit"), Mode::settable("ask")), (Some(Mode::Plan), Some(Mode::Edit), None));

        let tmp = tempfile::NamedTempFile::new().unwrap();
        {
            // A thread table from before the column, with a row.
            let conn = rusqlite::Connection::open(tmp.path()).unwrap();
            conn.execute_batch(
                r#"
                CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL, last_opened TEXT NOT NULL);
                CREATE TABLE workspaces (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
                    task TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL, worktree_path TEXT,
                    setup_script TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
                    created_at TEXT NOT NULL, last_active TEXT NOT NULL);
                CREATE TABLE chat_threads (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT 'New conversation', created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0);
                INSERT INTO projects VALUES ('p1', 'Old', '/tmp/octo-mode-old', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
                INSERT INTO workspaces (id, project_id, name, branch, created_at, last_active)
                    VALUES ('w1', 'p1', 'main', 'main', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
                INSERT INTO chat_threads (id, workspace_id, title, created_at, updated_at)
                    VALUES ('t-old', 'w1', 'Old talk', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
                "#,
            )
            .unwrap();
        }
        let db = Arc::new(Mutex::new(Db::open(tmp.path()).unwrap()));
        assert_eq!(db.lock().thread_permission_mode("t-old").unwrap(), None);
        assert_eq!(thread_mode(&db, "t-old"), Mode::Edit, "an old thread reads as Edit freely");
        // The mode persists per thread, and a fork keeps it.
        db.lock().set_thread_permission_mode("t-old", Mode::Plan).unwrap();
        assert_eq!(thread_mode(&db, "t-old"), Mode::Plan);
        let id = db.lock().insert_chat_message("w1", "t-old", "user", "look around", None, None, None, None).unwrap();
        let (fork, ..) = db.lock().fork_chat_thread("t-old", id).unwrap();
        assert_eq!(thread_mode(&db, &fork.id), Mode::Plan);
        let source = thread_mode_source(Arc::clone(&db), "t-old".into(), None);
        db.lock().set_thread_permission_mode("t-old", Mode::Edit).unwrap();
        assert_eq!(source(), Mode::Edit, "the source reads the mode now");
        let pinned = thread_mode_source(Arc::clone(&db), "t-old".into(), Some(vec![]));
        assert_eq!(pinned(), Mode::Plan, "a run on the read-only sandbox stays Plan only");
    }

    /// Plan only's commands run under the read-only seatbelt profile: one
    /// that writes to the workspace fails, and says why. The workspace sits
    /// outside `$TMPDIR`, which the profile keeps writable.
    #[test]
    #[cfg(target_os = "macos")]
    fn plan_mode_command_cannot_write() {
        let caches = dirs::cache_dir().unwrap();
        std::fs::create_dir_all(&caches).unwrap();
        let ws = tempfile::Builder::new().prefix("octopush-plan-test-").tempdir_in(&caches).unwrap();
        std::fs::write(ws.path().join("seed.txt"), "seed").unwrap();
        let roots = exec_roots(Mode::Plan, None).unwrap();
        let run = |command: &str| {
            crate::chat_engine::execute_tool(ws.path(), "run_command", &json!({ "command": command }), Some(&roots))
        };
        let (out, ok) = run("echo x > planned.txt");
        assert!(!ok, "{out}");
        assert!(!ws.path().join("planned.txt").exists(), "nothing was written");
        assert!(out.contains(crate::chat_engine::READ_ONLY_NOTE), "the result names the cause: {out}");
        let (out, ok) = run("rm seed.txt");
        assert!(!ok && ws.path().join("seed.txt").exists(), "{out}");
        let (out, ok) = run("cat seed.txt");
        assert!(ok && out.contains("seed"), "reads still work: {out}");
        let (out, ok) = run("t=$(mktemp) && echo x > \"$t\" && rm \"$t\"");
        assert!(ok, "temp files stay writable: {out}");
    }

    /// The director never changes its tool list with the mode: it is built
    /// once, before the loop that reads the mode at each round boundary. An
    /// `AppHandle` can't be built in a test, so this reads the loop's source.
    #[test]
    fn the_director_loop_never_touches_the_tool_list() {
        let engine = include_str!("chat_engine.rs");
        let from = engine.find("// \u{2500}\u{2500}\u{2500} Agentic loop").expect("the director's loop");
        let to = from + engine[from..].find("// \u{2500}\u{2500}\u{2500} Cap reached").expect("its forced close");
        let body = &engine[from..to];
        assert!(body.contains("permissions::thread_mode("), "the loop reads the mode");
        let edits = ["tools.push(", "tools.retain(", "tools.extend(", "tools.insert(", "tools.remove(", "tools.clear(", "tools.truncate(", "&mut tools", "let tools", "let mut tools"];
        for edit in edits {
            assert!(!body.contains(edit), "the loop changes the tool list: {edit}");
        }
        let assigned = body.lines().map(str::trim).find(|l| l.starts_with("tools = ") && l.ends_with(';'));
        assert_eq!(assigned, None, "the loop replaces the tool list");
    }

    /// `get_thread_permission_mode` reports the stored mode and the mode the
    /// turns run in, so a control can show when a mission forces Plan only.
    #[test]
    fn a_read_only_mission_shows_as_the_effective_mode() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Mutex::new(Db::open(tmp.path()).unwrap());
        let thread = {
            let d = db.lock();
            d.insert_project("p-eff", "P", "/tmp/octo-mode-effective").unwrap();
            d.insert_workspace("w-eff", "p-eff", "ws", "", "main", None, "", None).unwrap();
            d.create_chat_thread("w-eff", "Look").unwrap().id
        };
        assert_eq!(thread_modes(&db, &thread), (Mode::Edit, Mode::Edit));
        db.lock().set_thread_permission_mode(&thread, Mode::Plan).unwrap();
        assert_eq!(thread_modes(&db, &thread), (Mode::Plan, Mode::Plan));
        db.lock().set_thread_permission_mode(&thread, Mode::Edit).unwrap();
        db.lock().insert_mission("m-ro", Some("w-eff"), "p-eff", "review", "Review it", "active", None, "readonly", "none", "{}").unwrap();
        assert_eq!(thread_modes(&db, &thread), (Mode::Edit, Mode::Plan), "the mission forces Plan only");
        assert_eq!(thread_modes(&db, "gone"), (Mode::Edit, Mode::Edit));
    }

    /// A Plan only command runs off the turn's runtime thread and stops with
    /// the turn: on a one-thread runtime the canceller below could never
    /// run while a blocking command held the thread.
    #[test]
    fn a_plan_only_command_stops_with_the_turn() {
        let ws = tempfile::tempdir().unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let started = std::time::Instant::now();
        let (out, ok) = rt.block_on(async {
            let flag = Arc::clone(&cancel);
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
            });
            crate::chat_engine::run_confined(ws.path(), &json!({ "command": "sleep 30" }), None, &cancel).await
        });
        assert!(!ok, "{out}");
        assert!(started.elapsed() < std::time::Duration::from_secs(15), "Stop didn't reach the command: {out}");
    }

    /// The hosts are only as strict as their call sites. An `AppHandle` can't
    /// be built in a test, so this reads them: the director decides each
    /// round's calls (`mode_denials`) and runs its commands on the round's
    /// roots, cancellably; a sub-agent runs narrowed (`mode_spec`) behind the
    /// mode gate, on every attempt.
    #[test]
    fn the_hosts_call_the_policy() {
        let engine = include_str!("chat_engine.rs");
        let from = engine.find("// \u{2500}\u{2500}\u{2500} Agentic loop").expect("the director's loop");
        let to = from + engine[from..].find("// \u{2500}\u{2500}\u{2500} Cap reached").expect("its forced close");
        let body = &engine[from..to];
        for call in [
            "let exec_roots = crate::permissions::exec_roots(mode, sandbox_roots.as_deref());",
            "crate::permissions::refusal(crate::permissions::decide(mode, &call, &ctx))",
            "forced: crate::permissions::forced(sandbox_roots.as_deref()),",
            "let parsed = match mode_denials.get(&u.id) {",
            "let mut denied: Option<String> = mode_denials.get(&u.id).filter(|_| !is_agent).cloned();",
            "let mut was_denied = denied.is_some() || mode_denied;",
            "self.talk_shell.available() && exec_roots.is_none()",
            "run_confined(&workspace_path, &u.input, exec_roots.clone(), &cancel).await",
            "name_forced_mission(out, crate::permissions::forced(sandbox_roots.as_deref()))",
            "run_builtin(&workspace_path, &u.name, &u.input, exec_roots.clone(), &cancel).await",
            "run_fallback_shell(&workspace_path, &u.input, &reason, &cancel).await",
        ] {
            assert!(body.contains(call), "the director's loop no longer has: {call}");
        }
        let agents = include_str!("chat_agents.rs");
        let at = agents.find("pub async fn run_one_subagent(").expect("the sub-agent runner");
        let run = &agents[at..at + agents[at..].find("\n}\n").unwrap()];
        for call in [
            "let spec = &mode_spec(&db, &planned);",
            "let tool_gate = mode_gate(&db, spec, planned.sandbox_roots.as_deref(), mcp_tools, Some(Box::new(approval_gate)));",
            "persist_run(&db, &planned, &outcome);",
        ] {
            assert!(run.contains(call), "the sub-agent runner no longer has: {call}");
        }
        let attempts: Vec<&str> = run.lines().filter(|l| l.contains("run_attempt(")).collect();
        assert_eq!(attempts.len(), 3, "{attempts:?}");
        assert!(attempts.iter().all(|l| l.contains("&sink, &tool_gate, external_ref")), "an attempt skips the mode gate: {attempts:?}");
    }
}
