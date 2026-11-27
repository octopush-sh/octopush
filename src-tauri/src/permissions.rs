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
use std::path::{Component, Path, PathBuf};
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

    /// The modes a conversation can be set to.
    pub fn settable(raw: &str) -> Option<Mode> {
        match raw {
            "plan" => Some(Mode::Plan),
            "ask" => Some(Mode::Ask),
            "edit" => Some(Mode::Edit),
            _ => None,
        }
    }

    /// The mode's name in the UI.
    pub fn label(self) -> &'static str {
        match self {
            Mode::Plan => "Plan only",
            Mode::Ask => "Ask first",
            Mode::Edit => "Edit freely",
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
    /// Where a command starts (the shared shell's directory, else the
    /// workspace root) and the workspace: in Ask first a git reader counts
    /// as one only inside the workspace ([`reads_only`]).
    pub cwd: Option<&'a Path>,
    pub workspace: Option<&'a Path>,
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

/// What a call that Ask first holds gets from a host that can't ask.
pub const ASK_UNAVAILABLE: &str = "Not done: this conversation is in Ask first mode, which this version can't ask \
     in yet. Nothing was changed. Tell the user, who can switch the conversation to Edit freely or Plan only.";

/// The fixed result of a call the user declined on its Ask first card.
pub const ASK_DECLINED: &str = "Not done: this conversation is in Ask first mode, and the user declined this call. \
     Nothing was run or changed. Do not retry it; ask the user how to proceed, or leave the step for them.";

/// Whether `call` may run in `mode`.
///
/// - **Plan only:** reads and the loop's own tools run. Writes are refused.
///   A command runs only under the read-only sandbox, and not when it
///   changes something elsewhere ([`remote_effect`]). An MCP tool runs only
///   when its server marks it read-only, and a sub-agent unless it names a
///   type that writes.
/// - **Ask first:** writes ask, and so does a command unless all it runs
///   only reads ([`reads_only`]). An MCP tool its server doesn't mark
///   read-only meets its own card (`talk_guard`), which no "don't ask
///   again" answers in Ask first, so every change waits for the user.
/// - **Edit freely:** everything runs, as before modes existed.
pub fn decide(mode: Mode, call: &ToolCall, ctx: &PolicyCtx) -> Decision {
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
        (Mode::Ask, Class::Exec) if reads_only(&field("command"), ctx.cwd, ctx.workspace) => Decision::Allow,
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
    crate::chat_engine::each_command(command, remote_line).unwrap_or(Some("nests more commands than the check reads"))
}

/// Shell keywords and programs that run the command after them
/// (`then git push`, `env X=1 git push`, `sudo -u x git push`).
const WRAPPERS: &[&str] = &[
    "then", "do", "else", "elif", "if", "while", "until", "!", "{", "time", "exec", "nohup", "xargs", "command", "builtin",
    "env", "nice", "sudo", "doas", "timeout", "gtimeout", "caffeinate", "stdbuf", "watch",
];

type RemoteRule = fn(&[&str]) -> Option<&'static str>;

fn remote_line(line: &str) -> Option<&'static str> {
    let words = crate::chat_engine::command_words(line);
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
    segments.iter().find_map(|seg| remote_command(seg))
}

fn program(w: &str) -> String {
    w.rsplit('/').next().unwrap_or(w).to_ascii_lowercase()
}

/// `words` from the program on.
fn remote_command(words: &[&str]) -> Option<&'static str> {
    let (first, rest) = words.split_first()?;
    let name = program(first);
    if name == "eval" {
        return remote_effect(&rest.join(" "));
    }
    if WRAPPERS.contains(&name.as_str()) {
        // A wrapper's own flags and values (`sudo -u x`, `timeout 10`) come first.
        let at = rest.iter().position(|&w| program(w) == "eval" || remote_rule(&program(w)).is_some())?;
        return remote_command(&rest[at..]);
    }
    remote_rule(&name)?(rest)
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

/// httpie (`http [METHOD] URL [ITEM…]`): the method it names, else POST
/// when an item carries data (`a=b`, `a:=1`, `a@file`; `a==b` is a query,
/// `A:b` a header).
fn httpie_remote(args: &[&str]) -> Option<&'static str> {
    const METHODS: &[&str] = &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
    let ops = operands(args, &["-a", "--auth", "-A", "--auth-type", "--session", "--session-read-only", "-o", "--output", "-p", "--print", "--proxy", "--timeout", "--verify", "--cert", "--cert-key", "--pretty", "-s", "--style"]);
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

/// Whether every command `command` runs only reads, so Ask first runs it
/// without a card (#1231). Read the way the command check reads a command:
/// each nested one on its own ([`crate::chat_engine::each_command`]; past
/// its caps, never), each word as the shell splits it
/// ([`crate::chat_engine::command_words`]). A line only reads when it
/// redirects no output (but to `/dev/null`), sets no shell state, and each
/// of its commands is a known reader ([`READERS`], `git` [`GIT_READS`])
/// named bare, with only the flags its entry lists. Anything else asks: an
/// unknown flag, an assignment (but a locale or display name before a
/// program, [`ONE_PROGRAM_ENV`]), arithmetic, any `${…}` but a plain
/// name, a wrapper, a keyword, a script, a path or a variable as the
/// program. A `git` reader also has to run inside `workspace`, from `cwd`
/// (where the command starts) through every `cd` it may take ([`Places`]).
/// A net for a workflow aid, not a sandbox; what it lets through still
/// meets the guards.
pub fn reads_only(command: &str, cwd: Option<&Path>, workspace: Option<&Path>) -> bool {
    if sets_state(command) {
        return false;
    }
    let places = Places::of(command, cwd, workspace);
    matches!(crate::chat_engine::each_command(command, |line| (!line_reads_only(line, &places)).then_some(())), Ok(None))
}

/// Arithmetic (`$((…))`, `$[…]`) and every `${…}` but a plain name or its
/// length (`${name}`, `${#name}`), wherever they sit: an assigning
/// expansion (`${x:=1}`), an indirect one (`${!x}`), and an array subscript
/// or a substring offset (`${a[_]}`, `${PWD:_}`), whose arithmetic runs what
/// a variable holds.
fn sets_state(command: &str) -> bool {
    if command.contains("$((") || command.contains("$[") {
        return true;
    }
    let mut rest = command;
    while let Some(at) = rest.find("${") {
        let inner = &rest[at + 2..];
        let Some(end) = inner.find('}') else { return true };
        let name = inner[..end].strip_prefix('#').unwrap_or(&inner[..end]);
        let plain = name.starts_with(|c: char| c == '_' || c.is_ascii_alphabetic())
            && name.bytes().all(|b| b == b'_' || b.is_ascii_alphanumeric());
        if !plain {
            return true;
        }
        rest = &inner[end + 1..];
    }
    false
}

/// How many places a command's `cd`s may lead to before it asks.
const MAX_PLACES: usize = 32;

/// Where a command's programs may run, for its git readers: where it
/// starts, and every directory each `cd` may lead to from any of those, in
/// the order the check reads them (a `cd` in a subshell may not take
/// effect, so each one adds places and removes none). `dirs` is `None` when
/// a `cd` can't be followed: no operand, a flag or `-`, `~`, a word that
/// expands, or a bare name `CDPATH` may send elsewhere (`./name` is
/// followed), or when the command starts somewhere unknown.
struct Places {
    dirs: Option<Vec<PathBuf>>,
    workspace: Option<PathBuf>,
}

impl Places {
    fn of(command: &str, cwd: Option<&Path>, workspace: Option<&Path>) -> Self {
        let mut targets: Vec<Option<String>> = Vec::new();
        let walked = crate::chat_engine::each_command(command, |line| {
            targets.extend(cd_targets(line));
            None::<()>
        });
        let dirs = (|| {
            walked.ok()?;
            let mut dirs = vec![lexical(cwd?)];
            for target in targets {
                let target = target?;
                let more: Vec<PathBuf> = dirs.iter().map(|d| lexical(&d.join(&target))).collect();
                for dir in more {
                    if !dirs.contains(&dir) {
                        dirs.push(dir);
                    }
                }
                if dirs.len() > MAX_PLACES {
                    return None;
                }
            }
            Some(dirs)
        })();
        Places { dirs, workspace: workspace.and_then(|w| std::fs::canonicalize(w).ok()) }
    }

    /// Whether a git reader that changes into each of `chdirs` (`-C`, in
    /// order) runs inside the workspace from every place: each resolved as
    /// git resolves it, on the disk, links followed.
    fn keeps_git_inside(&self, chdirs: &[&str]) -> bool {
        let (Some(dirs), Some(workspace)) = (&self.dirs, &self.workspace) else { return false };
        dirs.iter().all(|dir| {
            let mut at = match std::fs::canonicalize(dir) {
                Ok(at) => at,
                Err(_) => return false,
            };
            for chdir in chdirs {
                at = match std::fs::canonicalize(at.join(chdir)) {
                    Ok(next) => next,
                    Err(_) => return false,
                };
            }
            at.starts_with(workspace)
        })
    }
}

/// `path` with `.` and `..` folded in as the shell's `cd` folds them.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The directory each `cd` in `line` changes to, `None` for one that can't
/// be followed (see [`Places`]).
fn cd_targets(line: &str) -> Vec<Option<String>> {
    let words = crate::chat_engine::command_words(line);
    let segs = segments(&words);
    let targets = segs
        .into_iter()
        .filter_map(|seg| {
            let at = seg.iter().position(|w| w.role == crate::chat_engine::WordRole::Program)?;
            (seg[at].word.to_ascii_lowercase() == "cd").then(|| match &seg[at + 1..] {
                [w] if !expands(w)
                    && !w.word.starts_with('-')
                    && (w.word.starts_with('/') || w.word == "." || w.word == ".." || w.word.starts_with("./") || w.word.starts_with("../")) =>
                {
                    Some(w.word.clone())
                }
                _ => None,
            })
        })
        .collect();
    targets
}

/// A line's commands, each its words but here-document bodies and
/// redirection targets.
fn segments(words: &[crate::chat_engine::CommandWord]) -> Vec<Vec<&crate::chat_engine::CommandWord>> {
    let mut segments: Vec<Vec<&crate::chat_engine::CommandWord>> = Vec::new();
    let mut last = None;
    for w in words.iter().filter(|w| w.role != crate::chat_engine::WordRole::Data && !w.redirect) {
        if last != Some(w.segment) {
            segments.push(Vec::new());
            last = Some(w.segment);
        }
        if let Some(seg) = segments.last_mut() {
            seg.push(w);
        }
    }
    segments
}

/// What may be set for one program: locale and display, never `PATH`,
/// `PROMPT_COMMAND`, `GIT_*` or any other name.
const ONE_PROGRAM_ENV: &[&str] = &["LANG", "TZ", "NO_COLOR", "TERM", "COLUMNS"];

fn one_program_env(word: &str) -> bool {
    let name = word.split('=').next().unwrap_or("");
    name.starts_with("LC_") || ONE_PROGRAM_ENV.contains(&name)
}

/// A program that only reads, and the flags it may take. A flag it doesn't
/// list asks, as does a long flag's abbreviation.
struct Reader {
    name: &'static str,
    /// Short flags, alone or in a cluster (`-la`).
    short: &'static str,
    /// Short flags that take a value: the rest of the cluster, or the next
    /// word unless it starts with `-` (then it is read as a flag).
    short_valued: &'static str,
    /// Long flags, bare or `--name=value`.
    long: &'static [&'static str],
    /// Long flags that also take the next word as their value.
    long_valued: &'static [&'static str],
    /// Whole words it takes (`find`'s primaries, `test`'s operators).
    words: &'static [&'static str],
    /// The most operands it takes: `uniq in out` writes `out`.
    operands: Option<usize>,
    /// It has flags that write or run something, so a word the shell may
    /// expand into one asks.
    risky: bool,
}

const R: Reader =
    Reader { name: "", short: "", short_valued: "", long: &[], long_valued: &[], words: &[], operands: None, risky: false };

const GREP: Reader = Reader {
    short: "EFGPiyvwxclLnhHoqsrRaIbuzZU0123456789",
    short_valued: "efmABCdD",
    long: &[
        "--extended-regexp", "--fixed-strings", "--basic-regexp", "--perl-regexp", "--ignore-case", "--invert-match",
        "--word-regexp", "--line-regexp", "--count", "--color", "--colour", "--files-with-matches",
        "--files-without-match", "--only-matching", "--quiet", "--silent", "--no-messages", "--byte-offset",
        "--with-filename", "--no-filename", "--line-number", "--recursive", "--dereference-recursive", "--text",
        "--null", "--null-data",
    ],
    long_valued: &[
        "--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context", "--include",
        "--exclude", "--exclude-dir", "--binary-files", "--directories", "--devices", "--label",
    ],
    ..R
};

const READERS: &[Reader] = &[
    Reader { name: "ls", short: "1@ABCFGHILOPRSTUWabcdefghiklmnopqrstuvwxy%,", short_valued: "w",
        long: &["--all", "--almost-all", "--classify", "--color", "--colour", "--directory", "--dereference", "--full-time",
            "--group-directories-first", "--human-readable", "--inode", "--numeric-uid-gid", "--recursive", "--reverse", "--size", "--si"],
        long_valued: &["--sort", "--time", "--time-style", "--format", "--ignore", "--hide", "--width", "--block-size"], ..R },
    Reader { name: "cat", short: "AbeEnstTuvl",
        long: &["--show-all", "--number-nonblank", "--number", "--squeeze-blank", "--show-ends", "--show-tabs", "--show-nonprinting"], ..R },
    Reader { name: "head", short: "qvz0123456789", short_valued: "nc", long: &["--quiet", "--silent", "--verbose", "--zero-terminated"],
        long_valued: &["--lines", "--bytes"], ..R },
    Reader { name: "tail", short: "fFqrvz0123456789", short_valued: "ncbs", long: &["--follow", "--retry", "--quiet", "--silent", "--verbose", "--zero-terminated"],
        long_valued: &["--lines", "--bytes", "--pid", "--sleep-interval"], ..R },
    Reader { name: "wc", short: "clmwL", long: &["--bytes", "--chars", "--lines", "--words", "--max-line-length"], ..R },
    Reader { name: "pwd", short: "LP", ..R },
    Reader { name: "echo", short: "neE", ..R },
    // `printf -v name` sets a variable: no flag is listed.
    Reader { name: "printf", risky: true, ..R },
    Reader { name: "which", short: "as", ..R },
    Reader { name: "type", short: "afptP", ..R },
    Reader { name: "stat", short: "FLlnqrsx", short_valued: "fct", long: &["--dereference", "--terse", "--file-system"],
        long_valued: &["--format", "--printf"], ..R },
    Reader { name: "du", short: "aAcHhkLlmPsxg0", short_valued: "dBt",
        long: &["--all", "--apparent-size", "--total", "--dereference", "--human-readable", "--si", "--summarize", "--one-file-system", "--null"],
        long_valued: &["--max-depth", "--block-size", "--threshold", "--exclude"], ..R },
    Reader { name: "df", short: "aghHiklmPT", short_valued: "tx",
        long: &["--all", "--human-readable", "--si", "--inodes", "--local", "--portability", "--print-type", "--total"],
        long_valued: &["--type", "--exclude-type"], ..R },
    Reader { name: "diff", short: "abBdEilNpqrstTuwyZ", short_valued: "UCWxXIF",
        long: &["--unified", "--context", "--recursive", "--brief", "--report-identical-files", "--side-by-side", "--ignore-case",
            "--ignore-all-space", "--ignore-space-change", "--ignore-blank-lines", "--new-file", "--text", "--color",
            "--no-dereference", "--strip-trailing-cr", "--suppress-common-lines", "--minimal", "--normal"],
        long_valued: &["--exclude", "--width", "--ignore-matching-lines", "--label"], ..R },
    Reader { name: "cmp", short: "blsx", short_valued: "in", ..R },
    Reader { name: "basename", short: "az", short_valued: "s", ..R },
    Reader { name: "dirname", short: "z", ..R },
    Reader { name: "realpath", short: "eLmPqsz", ..R },
    Reader { name: "readlink", short: "efmnqsvz", ..R },
    Reader { name: "grep", ..GREP },
    Reader { name: "egrep", ..GREP },
    Reader { name: "fgrep", ..GREP },
    Reader { name: "cut", short: "nsz", short_valued: "bcdf", long: &["--only-delimited", "--complement", "--zero-terminated"],
        long_valued: &["--bytes", "--characters", "--delimiter", "--fields", "--output-delimiter"], ..R },
    Reader { name: "tr", short: "cdsCt", ..R },
    Reader { name: "nl", short: "p", short_valued: "bdfhilnsvw", ..R },
    Reader { name: "tac", short: "br", short_valued: "s", ..R },
    Reader { name: "rev", ..R },
    Reader { name: "od", short: "bcdDefFhHiIlLoOsvxX", short_valued: "AjNtw", ..R },
    Reader { name: "hexdump", short: "bcCdovx", short_valued: "efns", ..R },
    Reader { name: "strings", short: "ao0123456789", short_valued: "nt", ..R },
    Reader { name: "jq", short: "rjcnesSCMaR", short_valued: "fL",
        long: &["--raw-output", "--join-output", "--compact-output", "--null-input", "--exit-status", "--slurp", "--sort-keys",
            "--color-output", "--monochrome-output", "--ascii-output", "--raw-input", "--tab", "--args", "--jsonargs"],
        long_valued: &["--indent", "--arg", "--argjson", "--slurpfile", "--rawfile", "--from-file"], ..R },
    Reader { name: "cd", short: "LPe@", ..R },
    Reader { name: "true", ..R },
    Reader { name: "false", ..R },
    Reader { name: "test", short: "0123456789", words: TEST_OPS, ..R },
    Reader { name: "[", short: "0123456789", words: TEST_OPS, ..R },
    Reader { name: "uname", short: "aimnoprsv", ..R },
    Reader { name: "whoami", ..R },
    Reader { name: "printenv", ..R },
    Reader { name: "sleep", ..R },
    // Not `--pre`, `--hostname-bin` or `-z`/`--search-zip`, which run programs.
    Reader { name: "rg", risky: true, short: "iISsvwxcnNlLHoqFpPuUa0123456789.", short_valued: "egtTABCmMjrE",
        long: &["--hidden", "--no-ignore", "--files", "--files-with-matches", "--files-without-match", "--count", "--count-matches",
            "--line-number", "--no-line-number", "--column", "--heading", "--no-heading", "--with-filename", "--no-filename",
            "--ignore-case", "--smart-case", "--case-sensitive", "--fixed-strings", "--word-regexp", "--line-regexp",
            "--invert-match", "--only-matching", "--multiline", "--multiline-dotall", "--json", "--stats", "--trim",
            "--vimgrep", "--follow", "--text", "--null", "--type-list", "--pretty", "--unrestricted", "--pcre2", "--passthru", "--quiet"],
        long_valued: &["--glob", "--iglob", "--type", "--type-not", "--context", "--before-context", "--after-context", "--max-count",
            "--max-depth", "--max-filesize", "--color", "--colors", "--sort", "--sortr", "--regexp", "--replace", "--threads",
            "--encoding", "--engine"], ..R },
    // Not `-o`/`--output`, `-T`, `--compress-program`.
    Reader { name: "sort", risky: true, short: "bdfghiMmnRrsuVcCz", short_valued: "ktS",
        long: &["--reverse", "--numeric-sort", "--unique", "--ignore-case", "--human-numeric-sort", "--version-sort", "--stable",
            "--general-numeric-sort", "--month-sort", "--random-sort", "--check", "--merge", "--zero-terminated",
            "--dictionary-order", "--ignore-leading-blanks", "--ignore-nonprinting"],
        long_valued: &["--key", "--field-separator", "--buffer-size", "--parallel"], ..R },
    Reader { name: "uniq", risky: true, operands: Some(1), short: "cdDiuz", short_valued: "fsw",
        long: &["--count", "--repeated", "--all-repeated", "--unique", "--ignore-case", "--zero-terminated"],
        long_valued: &["--skip-fields", "--skip-chars", "--check-chars"], ..R },
    // Not `-o` (writes a file), `-R` (writes one per folder) or `-H`.
    Reader { name: "tree", risky: true, short: "adlfxiqNQpugshDFvtcUrnCASJX", short_valued: "LPI",
        long: &["--noreport", "--dirsfirst", "--gitignore", "--si", "--inodes", "--device", "--prune", "--matchdirs", "--ignore-case", "--du"],
        long_valued: &["--charset", "--filelimit", "--timefmt", "--sort"], ..R },
    // Not `-exec`, `-execdir`, `-ok`, `-delete`, `-fprint*` or `-fls`.
    Reader { name: "find", risky: true, short: "0123456789",
        words: &["-H", "-L", "-P", "-E", "-X", "-s", "-x", "-d", "-name", "-iname", "-path", "-ipath", "-wholename", "-type",
            "-maxdepth", "-mindepth", "-size", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-newer", "-empty",
            "-print", "-print0", "-printf", "-prune", "-not", "-and", "-or", "-a", "-o", "-regex", "-iregex", "-user",
            "-group", "-perm", "-links", "-depth", "-follow", "-xdev", "-mount", "-readable", "-writable", "-executable",
            "-samefile", "-inum", "-ls", "-true", "-false", "-nouser", "-nogroup", "-lname", "-ilname"], ..R },
];

const TEST_OPS: &[&str] = &[
    "-a", "-b", "-c", "-d", "-e", "-f", "-g", "-h", "-k", "-L", "-n", "-o", "-p", "-r", "-s", "-S", "-t", "-u", "-w",
    "-x", "-z", "-O", "-G", "-N", "-nt", "-ot", "-ef", "-eq", "-ne", "-lt", "-le", "-gt", "-ge",
];

/// Git subcommands that only read.
const GIT_READS: &[&str] =
    &["status", "diff", "log", "show", "blame", "ls-files", "ls-tree", "rev-parse", "describe", "shortlog", "grep"];

/// The flags those subcommands may take, together. Not `--output`,
/// `--ext-diff`, `--textconv`, `-O`/`--open-files-in-pager`.
const GIT: Reader = Reader {
    name: "git",
    risky: true,
    short: "abBcdEFhHiIklMNoprRstuvwWz0123456789",
    short_valued: "ACeGfLmnSUxX",
    long: &[
        "--short", "--branch", "--porcelain", "--long", "--verbose", "--untracked-files", "--ignored", "--ahead-behind",
        "--no-ahead-behind", "--renames", "--no-renames", "--show-stash", "--column", "--no-column", "--stat", "--numstat",
        "--shortstat", "--name-only", "--name-status", "--cached", "--staged", "--patch", "--no-patch", "--unified", "--raw",
        "--color", "--no-color", "--word-diff", "--color-words", "--ignore-all-space", "--ignore-space-change",
        "--ignore-blank-lines", "--summary", "--check", "--minimal", "--patience", "--histogram", "--relative",
        "--exit-code", "--quiet", "--text", "--abbrev", "--full-index", "--no-prefix", "--dirstat", "--no-index",
        "--no-ext-diff", "--no-textconv", "--find-renames", "--find-copies", "--oneline", "--graph", "--decorate",
        "--no-decorate", "--all", "--branches", "--tags", "--remotes", "--reverse", "--first-parent", "--merges",
        "--no-merges", "--follow", "--abbrev-commit", "--left-right", "--cherry-pick", "--all-match", "--regexp-ignore-case",
        "--extended-regexp", "--fixed-strings", "--perl-regexp", "--source", "--topo-order", "--date-order",
        "--simplify-by-decoration", "--boundary", "--no-walk", "--show-signature", "--porcelain", "--line-porcelain",
        "--show-email", "--root", "--incremental", "--others", "--modified", "--deleted", "--stage", "--unmerged",
        "--exclude-standard", "--full-name", "--error-unmatch", "--directory", "--no-empty-directory", "--full-tree",
        "--object-only", "--abbrev-ref", "--symbolic-full-name", "--verify", "--show-toplevel", "--git-dir",
        "--is-inside-work-tree", "--show-prefix", "--show-cdup", "--git-common-dir", "--absolute-git-dir", "--always",
        "--dirty", "--exact-match", "--contains", "--summary", "--numbered", "--email", "--committer", "--count",
        "--files-with-matches", "--files-without-match", "--line-number", "--ignore-case", "--word-regexp", "--invert-match",
        "--untracked", "--break", "--heading", "--show-function", "--function-context", "--null",
    ],
    long_valued: &[
        "--format", "--pretty", "--author", "--grep", "--since", "--until", "--after", "--before", "--max-count", "--skip",
        "--date", "--diff-filter", "--stat-width", "--match", "--exclude", "--group", "--max-depth", "--context",
        "--after-context", "--before-context", "--ignore-submodules", "--word-diff-regex", "--anchored",
    ],
    ..R
};

fn line_reads_only(line: &str, places: &Places) -> bool {
    use crate::chat_engine::WordRole;
    let words = crate::chat_engine::command_words(line);
    // An output redirection (`>`, `>>`, `&>`, `<>`) outside a here-document's
    // body writes, but to `/dev/null`.
    if words.iter().any(|w| w.writes && w.role != WordRole::Data && w.word != "/dev/null") {
        return false;
    }
    let segs = segments(&words);
    let reads = segs.iter().all(|seg| {
        // Assignments alone, or before a program, set shell state: they ask,
        // but for a locale or display name set for one program.
        let Some(at) = seg.iter().position(|w| w.role == WordRole::Program) else { return false };
        let name = seg[at].word.to_ascii_lowercase();
        seg[..at].iter().all(|w| one_program_env(&w.word))
            && !seg[at].unmodeled
            && !name.contains('/')
            && program_reads(&name, &seg[at + 1..], places)
    });
    reads
}

/// Whether `program` with `args` only reads.
fn program_reads(program: &str, args: &[&crate::chat_engine::CommandWord], places: &Places) -> bool {
    if program == "git" {
        return git_reads(args, places);
    }
    READERS.iter().find(|r| r.name == program).is_some_and(|r| takes_only_listed(r, args))
}

/// `git` past `-C <dir>` and `--no-pager` (any other option before the
/// subcommand, such as `-c`, asks), running a subcommand that reads, with
/// only the flags [`GIT`] lists, inside the workspace from every place the
/// command may be in ([`Places::keeps_git_inside`]): a repository elsewhere
/// brings its own config (hooks, `core.fsmonitor`) into a `git status`.
fn git_reads(mut args: &[&crate::chat_engine::CommandWord], places: &Places) -> bool {
    if args.iter().any(|w| expands(w)) {
        return false;
    }
    let mut chdirs: Vec<&str> = Vec::new();
    loop {
        match args {
            [c, dir, rest @ ..] if c.word == "-C" => {
                chdirs.push(dir.word.as_str());
                args = rest;
            }
            [p, rest @ ..] if p.word == "--no-pager" => args = rest,
            _ => break,
        }
    }
    places.keeps_git_inside(&chdirs)
        && match args.split_first() {
            None => true,
            Some((sub, flags)) => GIT_READS.contains(&sub.word.as_str()) && takes_only_listed(&GIT, flags),
        }
}

/// Whether every flag in `args` is one `reader` lists, and its operands fit.
/// Past `--`, every word is an operand; so is `-`.
fn takes_only_listed(reader: &Reader, args: &[&crate::chat_engine::CommandWord]) -> bool {
    if reader.risky && args.iter().any(|w| expands(w)) {
        return false;
    }
    // A value is the next word unless it looks like a flag, which is then
    // read as one: a value can never hide a flag.
    let value_next = |i: usize| args.get(i).is_some_and(|w| !w.word.starts_with('-'));
    let (mut operands, mut ended, mut i) = (0, false, 0);
    while let Some(w) = args.get(i) {
        let a = w.word.as_str();
        i += 1;
        if ended || a == "-" || !a.starts_with('-') {
            operands += 1;
        } else if a == "--" {
            ended = true;
        } else if reader.words.contains(&a) {
        } else if a.starts_with("--") {
            let (name, valued) = match a.split_once('=') {
                Some((name, _)) => (name, true),
                None => (a, false),
            };
            if reader.long_valued.contains(&name) {
                if !valued && value_next(i) {
                    i += 1;
                }
            } else if !reader.long.contains(&name) {
                return false;
            }
        } else {
            // A cluster of short flags; one that takes a value ends it.
            let cluster = &a[1..];
            for (j, c) in cluster.char_indices() {
                if reader.short_valued.contains(c) {
                    if j + c.len_utf8() == cluster.len() && value_next(i) {
                        i += 1;
                    }
                    break;
                }
                if !reader.short.contains(c) {
                    return false;
                }
            }
        }
    }
    reader.operands.is_none_or(|max| operands <= max)
}

/// A word the shell may turn into other words: a variable, a `$(…)`, or an
/// unquoted glob or brace (`pattern` writes quoted ones after a `\`).
fn expands(w: &crate::chat_engine::CommandWord) -> bool {
    let mut chars = w.pattern.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                chars.next();
            }
            '{' | '*' | '?' | '[' => return true,
            _ => {}
        }
    }
    w.unmodeled
}

/// The quiet note a turn writes when its mode changes between rounds (#1231).
pub fn mode_note(mode: Mode) -> String {
    let what = match mode {
        Mode::Plan => ": nothing is written",
        Mode::Ask => ": each change waits for your OK",
        Mode::Edit => "",
    };
    format!("{} from this round on{what}", mode.label())
}

/// The mode a turn's last round ran in, so the next boundary can note a
/// change: the mode is read at each boundary, so a switch made while a
/// round runs applies from the next one.
#[derive(Default)]
pub struct ModeWatch(Option<Mode>);

impl ModeWatch {
    /// The note for a round that runs in `now`, when the one before ran in
    /// another mode.
    pub fn at_round(&mut self, now: Mode) -> Option<String> {
        match self.0.replace(now) {
            Some(before) if before != now => Some(mode_note(now)),
            _ => None,
        }
    }
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
    let (stored, effective, _) = thread_mode_state(db, thread_id);
    (stored, effective)
}

/// [`thread_modes`], and whether a read-only mission forces the mode, so the
/// Composer's control can say so and refuse a change.
pub fn thread_mode_state(db: &Mutex<Db>, thread_id: &str) -> (Mode, Mode, bool) {
    let stored = thread_mode(db, thread_id);
    let db = db.lock();
    let mission = db
        .chat_thread_workspace(thread_id)
        .ok()
        .flatten()
        .and_then(|w| db.active_mission_for_workspace(&w).ok().flatten());
    // Only whether the roots are empty matters here, not the workspace's path.
    let roots = mission.and_then(|m| crate::orchestrator::sandbox::sandbox_write_roots(&m.git_isolation, &m.exec_isolation, ""));
    (stored, effective(stored, roots.as_deref()), forced(roots.as_deref()))
}

/// How a gate learns the mode at the moment a call is checked.
pub type ModeSource = Arc<dyn Fn() -> Mode + Send + Sync>;

/// A thread's mode, read at each call, within the run's own `roots` (a run
/// that started in Plan only keeps its read-only sandbox, so it stays Plan).
pub fn thread_mode_source(db: Arc<Mutex<Db>>, thread_id: String, roots: Option<Vec<String>>) -> ModeSource {
    Arc::new(move || effective(thread_mode(&db, &thread_id), roots.as_deref()))
}

/// How a gate asks the user about a call Ask first holds (#1231).
#[async_trait::async_trait]
pub trait Asker: Send + Sync {
    /// `None` once the user approves it (the call then meets the guards),
    /// else the fixed result it gets instead of running.
    async fn ask(&self, name: &str, input: &Value) -> Option<String>;
}

/// The mode check as a [`ToolGate`], for the loop Talk sub-agents run on:
/// each call is decided in the thread's mode first, then what the mode
/// allows goes to `inner` (the sub-agent's approval gate). Sub-agents never
/// get the `Agent` tool, so a Delegate call is treated as one that writes.
/// A call Ask first holds goes to `asker`; without one it is refused.
pub struct ModeGate {
    mode: ModeSource,
    exec_roots: Option<Vec<String>>,
    /// A read-only mission forces Plan only ([`PolicyCtx::forced`]).
    forced: bool,
    mcp_read_only: HashSet<String>,
    inner: Option<Box<dyn ToolGate>>,
    asker: Option<Box<dyn Asker>>,
    /// The workspace: a sub-agent's commands start at its root.
    workspace: Option<PathBuf>,
}

impl ModeGate {
    pub fn new(
        mode: ModeSource,
        exec_roots: Option<Vec<String>>,
        forced: bool,
        mcp_read_only: HashSet<String>,
        inner: Option<Box<dyn ToolGate>>,
    ) -> Self {
        Self { mode, exec_roots, forced, mcp_read_only, inner, asker: None, workspace: None }
    }

    /// The workspace the sub-agent's commands start in.
    pub fn with_workspace(mut self, workspace: PathBuf) -> Self {
        self.workspace = Some(workspace);
        self
    }

    /// Ask the user about what Ask first holds, before `inner` checks it.
    pub fn with_asker(mut self, asker: Box<dyn Asker>) -> Self {
        self.asker = Some(asker);
        self
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
            cwd: self.workspace.as_deref(),
            workspace: self.workspace.as_deref(),
        };
        let decision = decide((self.mode)(), &ToolCall { name, input }, &ctx);
        let asks = matches!(decision, Decision::Ask { .. });
        match &self.asker {
            Some(asker) if asks => {
                if let Some(declined) = asker.ask(name, input).await {
                    return Some(declined);
                }
            }
            _ => {
                if let Some(refused) = refusal(decision) {
                    return Some(refused);
                }
            }
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
        let root = Some(Path::new("/"));
        PolicyCtx { exec_roots: roots, mcp_read_only: ro, delegate_writes, forced: false, cwd: root, workspace: root }
    }

    fn deny(r: Refused) -> Decision {
        Decision::Deny { message: plan_refusal(r, false) }
    }

    #[test]
    fn mode_by_tool_class_table() {
        let ro: HashSet<String> = ["mcp__docs__search".to_string()].into();
        let sandboxed: &[String] = &[];
        let ws: &[String] = &["/ws".to_string()];
        let input = json!({ "path": "a.rs", "command": "cargo test" });
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
            ("run_command", allow.clone(), ask("runs a command", "cargo test"), allow.clone()),
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
        // Ask first runs a command that only reads without a card.
        let read = json!({ "command": "git status && ls -la" });
        assert_eq!(decide(Mode::Ask, &ToolCall { name: "run_command", input: &read }, &ctx(None, &ro, false)), allow);
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
        let forced = PolicyCtx { exec_roots: Some(sandboxed), mcp_read_only: &ro, delegate_writes: false, forced: true, cwd: None, workspace: None };
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
        assert_eq!((Mode::settable("plan"), Mode::settable("edit"), Mode::settable("ask")), (Some(Mode::Plan), Some(Mode::Edit), Some(Mode::Ask)));
        assert_eq!(Mode::settable("bypass"), None);

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
        assert_eq!(thread_mode_state(&db, &thread), (Mode::Edit, Mode::Plan, true), "and says it forces it");
        assert_eq!(thread_modes(&db, "gone"), (Mode::Edit, Mode::Edit));
        assert!(!thread_mode_state(&db, "gone").2);
    }

    /// Ask first runs a command without a card only when everything it runs
    /// reads; anything the check can't tell asks.
    #[test]
    fn ask_first_runs_only_readers_without_a_card() {
        let ws = tempfile::tempdir().unwrap();
        std::fs::create_dir(ws.path().join("src")).unwrap();
        let reads_only = |c: &str| super::reads_only(c, Some(ws.path()), Some(ws.path()));
        let readers = [
            "ls -la src",
            "cat Cargo.toml | head -20",
            "grep -rn 'fn main' src 2>/dev/null",
            "ls -la 2>&1 | tail -5",
            "git status --short && git diff HEAD~1 --stat",
            "git -C src --no-pager log --oneline -5",
            "git",
            "rg -n 'TODO|FIXME' src",
            "find . -name '*.rs' -type f",
            "sort -u names.txt | uniq -c",
            "cd src && ls",
            "wc -l $(git ls-files)",
            "LC_ALL=C grep -c x a.txt",
            "tree -L 2",
            "jq '.version' package.json",
            "cat <<'EOF'\nrm -rf / > x\nEOF",
            "LC_ALL=C sort -u a.txt",
            "TZ=UTC ls -l",
            "NO_COLOR=1 TERM=dumb COLUMNS=80 LANG=C ls",
            "head -n 20 a.txt && tail -5 a.txt",
            "grep -A3 --include='*.rs' -rn x src",
            "git log -n 5 --format=%H --stat",
            "uniq -c -",
            "printf '%s\\n' done",
            "[ -f a.txt ] && echo yes",
            "echo ${HOME} ${#PATH} ${_}",
            "cd ./src && git status",
        ];
        for c in readers {
            assert!(reads_only(c), "{c}");
        }
        let writers = [
            "echo x > out.txt",
            "cat a >> b",
            "ls &> listing.txt",
            "cat <>f",
            "rm -rf build",
            "cargo test",
            "sed -i 's/a/b/' f",
            "tee out.txt",
            "find . -name '*.tmp' -delete",
            "find . -exec rm {} \\;",
            "find . $FLAG",
            "find . -{delete,print}",
            "git commit -m x",
            "git checkout main",
            "git -c core.pager=sh log",
            "git diff --output=patch.diff",
            "git log --out=x",
            "git grep --open-files-in-pager=vi x",
            "sort -o sorted.txt names.txt",
            "sort -ro out names.txt",
            "sort --compress-program=sh names",
            "uniq in.txt out.txt",
            "rg --pre ./decode.sh x",
            "tree -o listing.txt",
            "cat x | sh",
            "ls; touch new",
            "ls $(touch y)",
            "./scripts/check.sh",
            "/bin/ls",
            "$CMD",
            "bash -c 'ls'",
            "xargs cat",
            "env ls",
            "for f in *.md; do cat \"$f\"; done",
            // Shell state: assignments, `export`, `declare`, `printf -v`, arithmetic.
            "PROMPT_COMMAND='touch x' ls",
            "PATH=/tmp/evil ls",
            "GIT_DIR=/tmp/x git status",
            "x=1",
            "x=1; ls",
            "export PATH=/tmp/evil",
            "declare -x A=1",
            "printf -v PATH %s /tmp/evil",
            "echo $((x=1))",
            "echo $[x=1]",
            "echo ${PROMPT_COMMAND:=x}",
            "echo ${x=1}",
            // Flags a reader doesn't list.
            "rg --hostname-bin=/tmp/x foo",
            "rg -z foo",
            "rg --pr ./decode.sh x",
            "uniq - out.txt",
            "uniq -- in.txt out.txt",
            "tree -R -H .",
            "ls --some-new-flag",
            "cat -Z a",
            "grep --exclude-from-somewhere x",
            "git log --textconv",
            "git status -O x",
            "sort -T /tmp a",
            // Expansions whose arithmetic or indirection runs what a
            // variable holds, and `test -v`'s subscript.
            "echo $'a[\\x24(touch pwned)]'; echo ${a[_]}",
            "echo x; echo ${!_}",
            "echo 1; echo ${PWD:_}",
            "echo $'a[\\x24(touch pwned)]'; test -v 'a[_]'",
            "echo ${x//a/b} ${x[1]} ${#}",
            // A git reader outside the workspace, or after a `cd` the check
            // can't follow.
            "git -C ../repo --no-pager log --oneline -5",
            "cd src && git status",
            "cd && git status",
            "cd - && git log",
            "(cd ./src); cd ../../elsewhere && git status",
        ];
        for c in writers {
            assert!(!reads_only(c), "{c}");
        }
        assert!(!reads_only("$(".repeat(6).as_str()), "past the nesting it reads, it asks");
    }

    /// A git reader runs only inside the workspace: a repository planted
    /// elsewhere, reached with `-C` or after a `cd`, or the shared shell
    /// left in it, asks (its config could run anything).
    #[test]
    fn a_git_reader_outside_the_workspace_asks() {
        let ws = tempfile::tempdir().unwrap();
        let planted = tempfile::tempdir().unwrap();
        let (ws_dir, out) = (ws.path(), planted.path().display().to_string());
        let here = |c: &str| reads_only(c, Some(ws_dir), Some(ws_dir));
        assert!(here("git status") && here("git -C . log -1") && here("ls; git diff"));
        assert!(!here(&format!("git -C {out} status")), "the -C form");
        assert!(!here(&format!("cd {out} && git log")), "the cd form");
        assert!(here(&format!("cd {out} && ls")), "only git cares where it runs");
        assert!(!reads_only("git status", Some(planted.path()), Some(ws_dir)), "a shell left outside");
        assert!(!reads_only("git status", None, Some(ws_dir)) && !reads_only("git status", Some(ws_dir), None));
        assert!(reads_only("ls", None, None));
    }

    /// A switch made while a round runs applies from the next round, whose
    /// boundary writes the note once; the round before ran in the old mode.
    #[test]
    fn mode_switch_applies_next_round_with_note() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Mutex::new(Db::open(tmp.path()).unwrap());
        let thread = {
            let d = db.lock();
            d.insert_project("p-note", "P", "/tmp/octo-mode-note").unwrap();
            d.insert_workspace("w-note", "p-note", "ws", "", "main", None, "", None).unwrap();
            d.create_chat_thread("w-note", "Switch").unwrap().id
        };
        let ro = HashSet::new();
        let write = json!({ "path": "a.rs", "content": "x" });
        let decided = |mode| decide(mode, &ToolCall { name: "write_file", input: &write }, &ctx(None, &ro, false));
        let mut watch = ModeWatch::default();
        let round1 = thread_mode(&db, &thread);
        assert_eq!((watch.at_round(round1), decided(round1)), (None, Decision::Allow), "round 1 runs in Edit freely");
        // The user picks Ask first while round 1 runs.
        db.lock().set_thread_permission_mode(&thread, Mode::Ask).unwrap();
        let round2 = thread_mode(&db, &thread);
        assert_eq!(watch.at_round(round2), Some(mode_note(Mode::Ask)));
        assert!(matches!(decided(round2), Decision::Ask { .. }), "from round 2 a write asks");
        assert_eq!(watch.at_round(thread_mode(&db, &thread)), None, "one note per change");
        for m in [Mode::Plan, Mode::Ask, Mode::Edit] {
            assert!(mode_note(m).starts_with(&format!("{} from this round on", m.label())), "{m:?}");
        }
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
            "match crate::permissions::decide(mode, &call, &ctx) {",
            "!crate::permissions::reads_only(command, Some(command_dir().as_path()), Some(workspace_path.as_path()))",
            "decision => crate::permissions::refusal(decision).map(|m| (u.id.clone(), m)),",
            "if let Some(note) = mode_watch.at_round(mode) {",
            "if denied.is_none() && skill_refusal.is_none() && (mode_asks.contains(&u.id) || moved) {",
            "denied = crate::ask_first::ask_first(preview, ask, refused).await;",
            "let grants = mode != crate::permissions::Mode::Ask;",
            "self.approvals.await_card(&app, &request.workspace_id, &request.thread_id, &u.id, c, grants)",
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
            "let tool_gate = mode_gate(&db, spec, planned.sandbox_roots.as_deref(), mcp_tools, Some(Box::new(approval_gate)))",
            ".with_asker(Box::new(SubagentAsk::new(approvals, app.clone(), spec)));",
            ".with_mode(crate::permissions::thread_mode_source(Arc::clone(&db), spec.thread_id.clone(), spec.sandbox_roots.clone()));",
            "persist_run(&db, &planned, &outcome);",
        ] {
            assert!(run.contains(call), "the sub-agent runner no longer has: {call}");
        }
        let attempts: Vec<&str> = run.lines().filter(|l| l.contains("run_attempt(")).collect();
        assert_eq!(attempts.len(), 3, "{attempts:?}");
        assert!(attempts.iter().all(|l| l.contains("&sink, &tool_gate, external_ref")), "an attempt skips the mode gate: {attempts:?}");
    }
}
