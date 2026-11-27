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
    /// The loop's own tools (recall, ask the director, a verdict, ask a stage).
    Meta,
}

/// The class of a tool by name. A tool this policy doesn't know is a write
/// until it is classified here, so Plan only never runs a new tool unseen.
pub fn classify(name: &str) -> Class {
    match name {
        "read_file" | "list_files" | "grep" | "glob" => Class::Read,
        "run_command" => Class::Exec,
        crate::chat_engine::RECALL_TOOL_NAME | ASK_DIRECTOR_TOOL | SUBMIT_VERDICT_TOOL | ASK_STAGE_TOOL => Class::Meta,
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
/// words, like the command check whose walk over nested commands it shares
/// ([`crate::chat_engine::each_command`]); not a network sandbox. It knows
/// pushing, publishing, deploying and sending tools (`git push`, `gh` writes,
/// `curl`/`wget` that send data, package publishing, `docker push`,
/// `kubectl`/`helm`/`terraform` changes); reading and fetching pass.
pub fn remote_effect(command: &str) -> Option<&'static str> {
    crate::chat_engine::each_command(command, |line| line.split([';', '|', '&', '\n']).find_map(remote_segment))
        .unwrap_or(Some("nests more commands than the check reads"))
}

/// Programs that run the rest of their line (`env X=1 git push`).
const WRAPPERS: &[&str] =
    &["env", "command", "builtin", "exec", "nohup", "time", "nice", "sudo", "doas", "xargs", "timeout", "gtimeout", "caffeinate", "stdbuf", "watch"];

type RemoteRule = fn(&[&str]) -> Option<&'static str>;

fn remote_segment(segment: &str) -> Option<&'static str> {
    let words: Vec<&str> = segment
        .split_whitespace()
        .map(|w| w.trim_matches(['"', '\'', '`', '(', ')', '{', '}']).trim_start_matches('\\'))
        .filter(|w| !w.is_empty())
        .collect();
    let program = |w: &str| w.rsplit('/').next().unwrap_or(w).to_ascii_lowercase();
    let assigns = |w: &str| w.split_once('=').is_some_and(|(n, _)| !n.is_empty() && !n.starts_with('-') && n.bytes().all(|b| b == b'_' || b.is_ascii_alphanumeric()));
    let first = words.iter().position(|&w| !assigns(w))?;
    // A wrapper's own flags and values (`sudo -u x`, `timeout 10`) come first.
    let at = if WRAPPERS.contains(&program(words[first]).as_str()) {
        first + 1 + words[first + 1..].iter().position(|&w| remote_rule(&program(w)).is_some())?
    } else {
        first
    };
    remote_rule(&program(words[at]))?(&words[at + 1..])
}

fn remote_rule(program: &str) -> Option<RemoteRule> {
    let rule: RemoteRule = match program {
        "git" => git_remote,
        "gh" => gh_remote,
        "curl" => curl_remote,
        "wget" => wget_remote,
        "npm" | "pnpm" | "yarn" | "bun" | "cargo" | "pip" | "pip3" | "poetry" | "uv" | "twine" | "gem" => publish_remote,
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

fn gh_remote(args: &[&str]) -> Option<&'static str> {
    let ops = operands(args, &["-R", "--repo"]);
    let group = ops.first().map(|s| s.to_ascii_lowercase());
    if group.as_deref() == Some("api") {
        // `gh api` sends a GET unless a method is named or a field is given.
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
        let sends = method.map_or(fields, |m| !is_read_method(m));
        return sends.then_some("gh api with a method other than GET");
    }
    let local = matches!(group.as_deref(), Some("alias" | "config" | "extension" | "ext" | "completion" | "auth" | "help"));
    let verb = ops.get(1).map(|s| s.to_ascii_lowercase());
    (!local && verb.is_some_and(|v| GH_WRITES.contains(&v.as_str()))).then_some("a gh command that changes GitHub")
}

fn curl_remote(args: &[&str]) -> Option<&'static str> {
    const WHY: &str = "curl that sends data or uses a method other than GET";
    // `-G` sends `-d` data as a GET query.
    let get = args.iter().any(|a| *a == "-G" || *a == "--get");
    for (i, a) in args.iter().enumerate() {
        let method = match *a {
            "-X" | "--request" => args.get(i + 1).copied(),
            _ => a.strip_prefix("--request="),
        };
        let sends_long = |flags: &[&str]| flags.iter().any(|f| a == f || a.strip_prefix(f).is_some_and(|r| r.starts_with('=')));
        if method.is_some_and(|m| !is_read_method(m))
            || sends_long(&["--form", "--form-string", "--upload-file"])
            || (!get && sends_long(&["--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json"]))
        {
            return Some(WHY);
        }
        // A cluster of short flags (`-sSd x`, `-XPOST`): a flag that takes a
        // value ends it.
        if let Some(cluster) = a.strip_prefix('-').filter(|c| !c.starts_with('-')) {
            for (j, c) in cluster.char_indices() {
                match c {
                    'F' | 'T' => return Some(WHY),
                    'd' if !get => return Some(WHY),
                    'X' => {
                        let rest = &cluster[j + 1..];
                        let m = if rest.is_empty() { args.get(i + 1).copied().unwrap_or("") } else { rest };
                        if !is_read_method(m) {
                            return Some(WHY);
                        }
                        break;
                    }
                    c if "dHouAebcmwxrEKDCYyzUQtP".contains(c) => break,
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

fn docker_remote(args: &[&str]) -> Option<&'static str> {
    args.iter().any(|a| a.eq_ignore_ascii_case("push") || *a == "--push").then_some("docker push")
}

fn publish_remote(args: &[&str]) -> Option<&'static str> {
    // `yarn npm publish` names it second.
    let ops = operands(args, &[]);
    let publishes = |o: &&str| matches!(o.to_ascii_lowercase().as_str(), "publish" | "unpublish" | "deprecate" | "yank" | "owner" | "upload" | "push");
    ops.iter().take(2).any(publishes).then_some("publishes a package")
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
    mcp_read_only: HashSet<String>,
    inner: Option<Box<dyn ToolGate>>,
}

impl ModeGate {
    pub fn new(
        mode: ModeSource,
        exec_roots: Option<Vec<String>>,
        forced: bool,
        mcp_read_only: HashSet<String>,
        inner: Option<Box<dyn ToolGate>>,
    ) -> Self {
        Self { mode, exec_roots, forced, mcp_read_only, inner }
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
        PolicyCtx { exec_roots: roots, mcp_read_only: ro, delegate_writes, forced: false }
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
        let forced = PolicyCtx { exec_roots: Some(sandboxed), mcp_read_only: &ro, delegate_writes: false, forced: true };
        assert_eq!(
            decide(Mode::Plan, &ToolCall { name: "write_file", input: &input }, &forced),
            Decision::Deny { message: plan_refusal(Refused::Write, true) }
        );
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
            ("curl that sends data or uses a method other than GET", "curl -X POST https://api.example.com"),
            ("curl that sends data or uses a method other than GET", "curl -XDELETE https://api.example.com/x"),
            ("curl that sends data or uses a method other than GET", "curl --request=PUT https://x"),
            ("curl that sends data or uses a method other than GET", "curl -sS -d '{}' https://x"),
            ("curl that sends data or uses a method other than GET", "curl -sSd x https://x"),
            ("curl that sends data or uses a method other than GET", "curl --data-binary @f https://x"),
            ("curl that sends data or uses a method other than GET", "curl --json '{}' https://x"),
            ("curl that sends data or uses a method other than GET", "curl -F file=@a.png https://x"),
            ("curl that sends data or uses a method other than GET", "curl -T a.tar https://x"),
            ("wget that sends data or uses a method other than GET", "wget --post-data=a=1 https://x"),
            ("wget that sends data or uses a method other than GET", "wget --method=DELETE https://x"),
            ("publishes a package", "npm publish"),
            ("publishes a package", "cargo publish --dry-run=false"),
            ("publishes a package", "pip publish dist/*"),
            ("publishes a package", "yarn npm publish"),
            ("publishes a package", "twine upload dist/*"),
            ("docker push", "docker push registry.example.com/app:1"),
            ("docker push", "docker buildx build --push ."),
            ("changes a cluster or infrastructure (kubectl, helm, terraform)", "kubectl apply -f deploy.yaml"),
            ("changes a cluster or infrastructure (kubectl, helm, terraform)", "kubectl -n prod delete pod web-1"),
            ("changes a cluster or infrastructure (kubectl, helm, terraform)", "terraform apply -auto-approve"),
            ("changes a cluster or infrastructure (kubectl, helm, terraform)", "helm upgrade web ./chart"),
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
            "execute_tool(&workspace_path, &u.name, &u.input, exec_roots.as_deref())",
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
