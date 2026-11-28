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
use crate::talk_guard::{CardKind, Reach, ToolCard};
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;
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

    /// The mode a conversation is set to by name.
    pub fn settable(raw: &str) -> Option<Mode> {
        match raw {
            "plan" => Some(Mode::Plan),
            "ask" => Some(Mode::Ask),
            "edit" => Some(Mode::Edit),
            _ => None,
        }
    }

    /// The mode as the UI names it.
    pub fn label(self) -> &'static str {
        match self {
            Mode::Plan => "Plan only",
            Mode::Ask => "Ask first",
            Mode::Edit => "Edit freely",
        }
    }
}

/// How a mode switch during a turn's note starts ([`mode_note`]).
const MODE_NOTE_LEAD: &str = "Mode switched to ";

/// The quiet note (role `stopped`) a mode switch during a turn leaves before
/// the first round that runs in `mode` (#1231), so the record shows which
/// mode each round ran under.
pub fn mode_note(mode: Mode) -> String {
    format!("{MODE_NOTE_LEAD}{} from this round on.", mode.label())
}

/// Whether a stored row is a [`mode_note`], which the v2 transcript skips so
/// the turn still replays byte for byte.
pub fn is_mode_note(role: &str, content: &str) -> bool {
    role == "stopped" && content.starts_with(MODE_NOTE_LEAD)
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

/// What a call Ask first holds gets from a gate that has no one to ask.
pub const CANNOT_ASK: &str = "Not done: this conversation is in Ask first mode, and this call had no approval card to \
     wait on. Nothing was changed. Report what you would change instead.";

/// What a file change gets when the user declines its Ask first card.
pub const ASK_DECLINED_CHANGE: &str = "Not done: the user declined this change (the conversation is in Ask first \
     mode). Nothing was written. Ask the user what they want instead; do not retry the same change.";

/// What a command gets when the user declines its Ask first card.
pub const ASK_DECLINED_COMMAND: &str = "Not run: the user declined this command (the conversation is in Ask first \
     mode). Nothing ran. Ask the user how to proceed; do not retry the same command.";

/// Whether `call` may run in `mode`.
///
/// - **Plan only:** reads and the loop's own tools run. Writes are refused.
///   A command runs only under the read-only sandbox, and not when it
///   changes something elsewhere ([`remote_effect`]). An MCP tool runs only
///   when its server marks it read-only, and a sub-agent unless it names a
///   type that writes.
/// - **Ask first:** writes ask, and so does a command unless every command
///   in it only reads ([`reads_only`]). The host asks on [`ask_card`].
/// - **Edit freely:** everything runs, as before modes existed.
pub fn decide(mode: Mode, call: &ToolCall, ctx: &PolicyCtx) -> Decision {
    let field = |key: &str| call.input.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let refuse = |r: Refused| Decision::Deny { message: plan_refusal(r, ctx.forced) };
    // In every mode, before any other check: a control character the shared
    // shell's line editor would act on (`\r` ends the line there) means
    // what runs isn't what the checks read (#1231).
    if matches!(classify(call.name), Class::Exec) {
        if let Some(message) = crate::chat_engine::control_refusal(&field("command")) {
            return Decision::Deny { message };
        }
    }
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
        (Mode::Ask, Class::Exec) if reads_only(&field("command")) => Decision::Allow,
        (Mode::Ask, Class::Exec) => Decision::Ask { reason: "runs a command".into(), preview: field("command") },
        (Mode::Ask, Class::Net | Class::Delegate) => Decision::Allow,
    }
}

/// Programs Ask first runs without a card: they only read, whatever their
/// flags. A short list on purpose; anything else asks.
const READERS: &[&str] = &["ls", "cat", "head", "tail", "wc", "grep", "diff", "pwd", "echo", "stat", "which"];

/// `git` subcommands that only read, past which no flag writes a file
/// except `--output` (refused below).
const GIT_READERS: &[&str] = &["status", "diff", "log", "show", "blame", "ls-files", "rev-parse"];

/// Whether every command `command` runs only reads, so Ask first runs it
/// without a card (#1231). Only a command of [`plain_shape`] qualifies.
/// Then it is read the way the command check reads commands: every nested
/// one ([`crate::chat_engine::each_command`]), each word as the shell splits
/// it ([`crate::chat_engine::command_words`]). Each command must start with a
/// program in [`READERS`] (or `git` with a subcommand in [`GIT_READERS`]
/// right after it), named plainly, and nothing may redirect output except to
/// `/dev/null`. Anything the check can't tell asks: a path as the program,
/// an assignment before it, a wrapper or a shell keyword, a script.
pub fn reads_only(command: &str) -> bool {
    !command.trim().is_empty()
        && crate::chat_engine::control_refusal(command).is_none()
        && plain_shape(command)
        && matches!(crate::chat_engine::each_command(command, |line| (!line_reads_only(line)).then_some(())), Ok(None))
}

/// The characters a command [`plain_shape`] never holds: every way into an
/// expansion (`$`, a backtick, `{` and `}` of a brace expansion), quoting
/// that changes what the next character means (`\`), history expansion
/// (`!`), and the parentheses of a subshell or a function (`(`, `)`).
const NOT_PLAIN: &[char] = &['$', '`', '{', '}', '\\', '!', '(', ')'];

/// Words a command [`plain_shape`] never holds: they define or drop an alias
/// or a function, which changes what a later word runs.
const NOT_PLAIN_WORDS: &[&str] = &["alias", "function", "unalias"];

/// Whether `command` has the plain shape Ask first lets run without a card:
/// none of [`NOT_PLAIN`] anywhere in its raw text, quoted or not; no `<<`
/// (a here-document); none of [`NOT_PLAIN_WORDS`]; outside quotes no `*`,
/// `?` or `[` and no word that starts with `~`; and every quote closed.
///
/// A whitelist on purpose, not a list of tricks: bash builds code from many
/// shapes a reader check doesn't model, and each new one was a bypass.
/// `{$,}{PWD:_}` makes `${PWD:_}` by brace expansion, whose arithmetic runs
/// the command `$_` holds after `echo $'a[\x24(touch x)]'`; `$\⏎{` joins a
/// line; `$((…))` and `${x:-…}` expand. A glob or a tilde expands into words
/// the check never read, flags included: `git diff *` beside a file named
/// `--output=x` writes `x`, and `git lfs pu?h` can match `push` (quoted, a
/// glob is literal). A function or an alias gives a word a new meaning
/// (`f() ( touch x ); f`). Without these no expansion, substitution,
/// globbing, line join or new definition can happen, so what the check
/// reads is what runs. A command outside the shape only gets Ask first's
/// card. Pure.
pub fn plain_shape(command: &str) -> bool {
    if command.contains(NOT_PLAIN) || command.contains("<<") {
        return false;
    }
    let separator = |c: char| c.is_whitespace() || ";|&<>".contains(c);
    if command.split(separator).any(|w| NOT_PLAIN_WORDS.contains(&w)) {
        return false;
    }
    let mut quote: Option<char> = None;
    let mut word_start = true;
    for c in command.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None => match c {
                '\'' | '"' => quote = Some(c),
                '*' | '?' | '[' => return false,
                '~' if word_start => return false,
                _ => {}
            },
        }
        word_start = quote.is_none() && (c.is_whitespace() || ";|&()<>".contains(c));
    }
    quote.is_none()
}

/// Whether `command` runs `git` from outside `workspace` (#1231): `cwd` is
/// where it starts (the shared shell's directory, or the workspace root for
/// a command run elsewhere), resolved on the disk, links followed. Ask
/// first's git readers skip the card only inside the workspace: elsewhere a
/// repository's own config (`core.fsmonitor`, a bare repository's) can run
/// code. An unknown start (`None`: a reattached shell whose directory isn't
/// read yet) and a directory that can't be resolved count as outside.
pub fn git_outside(command: &str, cwd: Option<&Path>, workspace: &Path) -> bool {
    use crate::chat_engine::WordRole;
    let runs_git = crate::chat_engine::each_command(command, |line| {
        crate::chat_engine::command_words(line).iter().any(|w| w.role == WordRole::Program && w.word == "git").then_some(())
    });
    if matches!(runs_git, Ok(None)) {
        return false;
    }
    let Some(cwd) = cwd else { return true };
    match (std::fs::canonicalize(cwd), std::fs::canonicalize(workspace)) {
        (Ok(at), Ok(workspace)) => !at.starts_with(workspace),
        _ => true,
    }
}

fn line_reads_only(line: &str) -> bool {
    use crate::chat_engine::WordRole;
    let words = crate::chat_engine::command_words(line);
    if words.iter().any(|w| w.writes && w.word != "/dev/null") {
        return false;
    }
    let mut segments: Vec<Vec<&crate::chat_engine::CommandWord>> = Vec::new();
    let mut last = None;
    for w in &words {
        if last != Some(w.segment) {
            segments.push(Vec::new());
            last = Some(w.segment);
        }
        if let Some(seg) = segments.last_mut() {
            seg.push(w);
        }
    }
    segments.iter().all(|seg| {
        let Some((first, rest)) = seg.split_first() else { return true };
        let plain = first.role == WordRole::Program && !first.unmodeled && first.word == first.pattern && !first.word.contains('/');
        let args: Vec<&str> = rest.iter().filter(|w| w.role == WordRole::Argument && !w.redirect).map(|w| w.word.as_str()).collect();
        plain
            && match first.word.as_str() {
                "git" => args.first().is_some_and(|sub| GIT_READERS.contains(sub)) && !args.iter().any(|a| a.starts_with("--output") || *a == "--ext-diff"),
                program => READERS.contains(&program),
            }
    })
}

/// Lines of context around each change in an Ask first card's diff.
const DIFF_CONTEXT: usize = 3;
/// The most lines the diff shows; the rest is counted.
const DIFF_MAX_LINES: usize = 300;
/// The most of one line the diff shows (bytes).
const DIFF_LINE_MAX: usize = 400;
/// Past this many line pairs the changed middle isn't aligned line by line:
/// it shows as removed, then added.
const DIFF_MAX_CELLS: usize = 1_000_000;
/// A file larger than this (bytes) gets no preview.
const PREVIEW_MAX_BYTES: u64 = 2_000_000;

/// The card Ask first holds `name` on (#1231). A file change shows the
/// unified diff it makes, the file as it is against the file as the call
/// would leave it; once approved, the host checks again
/// (`chat_engine::guard_card`), so a file that changed while the card waited
/// asks again with its new diff. A path outside the workspace, in a
/// credentials location or named like an env file or a key gets no preview,
/// so the card never reads it; the outside-workspace card still asks after
/// this one. `label` names the sub-agent that asks. It offers no "don't ask
/// again": Edit freely is the mode for that.
pub fn ask_card(label: Option<&str>, name: &str, input: &Value, reach: &Reach) -> ToolCard {
    let field = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let card = |kind, shown: String, reason: String, denial: &str, diff, bound| ToolCard {
        kind,
        shown,
        reason: crate::talk_guard::sub_agent(label, reason),
        denial: denial.to_string(),
        sensitive: false,
        grant: None,
        trust: None,
        diff,
        bound,
    };
    if name == "run_command" {
        return card(CardKind::Exec, field("command"), "runs a command (Ask first)".into(), ASK_DECLINED_COMMAND, None, None);
    }
    let path = field("path");
    let (reason, diff, bound) = match name {
        "write_file" | "edit_file" if !previewed(reach, name, input, &path) => {
            ("changes a file outside the workspace or that may hold credentials, so the card doesn't preview it".to_string(), None, None)
        }
        "write_file" | "edit_file" => {
            // The user's own keys are redacted too, like any credential.
            let known = crate::secret_scan::known_secrets_from(&crate::settings::load_settings().unwrap_or_default());
            let (reason, diff) = change_preview(reach.workspace(), name, input, &path, &known);
            (reason, diff, Some(change_bound(&reach.workspace().join(&path), input)))
        }
        _ => (format!("calls {name}, which can change files"), None, None),
    };
    let reason = match runs_code {
        true => format!("{reason} \u{b7} it can make Octopush or Claude Code run commands"),
        false => reason,
    };
    let shown = if path.is_empty() { name.to_string() } else { path };
    card(CardKind::Edit, shown, format!("{reason} (Ask first)"), ASK_DECLINED_CHANGE, diff, bound)
}

/// Whether Ask first's card reads the file `name` changes at `path` to show
/// its diff: inside the workspace, and not named like an env file or a key.
/// A workspace file that runs commands (`talk_guard::RUNS_CODE`) keeps its
/// preview: its own Config card asks after this one (#1245).
fn previewed(reach: &Reach, name: &str, input: &Value, path: &str) -> bool {
    let marked = crate::secret_scan::is_env_file(path) || crate::secret_scan::is_sensitive_name(path);
    !marked && reach.outside_card(None, name, input, false, &[]).is_none_or(|c| c.kind == CardKind::Config)
}

/// What an Ask first approval binds to (#1231): the SHA-256 of the file at
/// `full` as it is now (every byte, or that it can't be read) and of the
/// call's input, which with it fixes the whole file the call leaves. The
/// diff shows a part at most; this is all of it.
fn change_bound(full: &Path, input: &Value) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut hasher = Sha256::new();
    match std::fs::File::open(full) {
        Ok(mut file) => {
            hasher.update(b"file\0");
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match file.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => hasher.update(&buf[..n]),
                    Err(e) => {
                        hasher.update(format!("\0unreadable {}", e.kind()).as_bytes());
                        break;
                    }
                }
            }
        }
        Err(e) => hasher.update(format!("none\0{}", e.kind()).as_bytes()),
    }
    hasher.update(b"\0input\0");
    hasher.update(input.to_string().as_bytes());
    hasher.finalize().into()
}

/// The refusal a file change gets from the tool whatever the user answers,
/// so Ask first returns it instead of a card nobody could approve (#1231):
/// a write outside the mission's sandbox (`roots`), and an `edit_file` that
/// can't apply to the file as it is. Read like the tool reads them, with the
/// tool's own words; a file the card wouldn't preview isn't read here.
pub fn refused_before_card(reach: &Reach, name: &str, input: &Value, roots: Option<&[String]>) -> Option<String> {
    let path = input.get("path").and_then(Value::as_str).unwrap_or("");
    sandbox_refusal(reach, name, input, roots).or_else(|| {
        (name == "edit_file" && previewed(reach, name, input, path)).then(|| {
            crate::chat_engine::edit_input_problem(input).or_else(|| match std::fs::read_to_string(reach.workspace().join(path)) {
                Ok(content) => crate::chat_engine::apply_edit(&content, input, path).err(),
                Err(e) => Some(format!("Error reading {path}: {e}")),
            })
        })?
    })
}

/// A write or edit outside a sandboxed mission's roots, in the tool's own
/// words, or `None`: refused in every mode before any card asks about it.
/// Lexical, like the tool's own check; nothing is read.
pub fn sandbox_refusal(reach: &Reach, name: &str, input: &Value, roots: Option<&[String]>) -> Option<String> {
    let verb = match name {
        "write_file" => "write",
        "edit_file" => "edit",
        _ => return None,
    };
    let path = input.get("path").and_then(Value::as_str).unwrap_or("");
    let outside = roots.is_some_and(|roots| !crate::orchestrator::sandbox::is_write_allowed(&reach.workspace().join(path), roots));
    outside.then(|| format!("Sandboxed: refusing to {verb} outside the mission workspace ({path})"))
}

/// What an Ask first card adds when the change it stood for moved while it
/// waited, so the user sees why it asks again.
pub const CHANGED_WHILE_WAITING: &str =
    "The file changed while the last card waited, so that approval no longer holds: this is the change as it is now.";

/// How an Ask first card ended.
#[derive(Debug, PartialEq, Eq)]
pub enum AskOutcome {
    Approved,
    /// The user declined: the card's fixed result.
    Declined(String),
    /// Once approved, the tool would refuse the call anyway: its refusal.
    Refused(String),
}

/// Ask about Ask first's `card` and, once it is approved, read the call
/// again (#1231). The approval holds only for exactly the change approved:
/// the whole file before and after (`ToolCard::bound`), not only the diff
/// shown. A change that moved meanwhile gets a new card that says so
/// ([`CHANGED_WHILE_WAITING`]); one the tool would now refuse (`refused`)
/// gets that refusal and no second card.
pub async fn guard_ask_first<C, CFut, F, Fut>(
    mut card: ToolCard,
    recheck: C,
    refused: impl Fn() -> Option<String>,
    ask: F,
) -> AskOutcome
where
    C: Fn() -> CFut,
    CFut: std::future::Future<Output = Option<ToolCard>>,
    F: Fn(ToolCard) -> Fut,
    Fut: std::future::Future<Output = crate::chat_engine::ApprovalDecision>,
{
    loop {
        if ask(card.clone()).await == crate::chat_engine::ApprovalDecision::Deny {
            return AskOutcome::Declined(card.denial);
        }
        if let Some(why) = refused() {
            return AskOutcome::Refused(why);
        }
        let Some(next) = recheck().await else { return AskOutcome::Approved };
        let same = (next.kind, &next.shown, &next.diff, next.bound) == (card.kind, &card.shown, &card.diff, card.bound);
        if same {
            return AskOutcome::Approved;
        }
        card = ToolCard { reason: format!("{} {CHANGED_WHILE_WAITING}", next.reason), ..next };
    }
}

/// Why a file change asks, and its diff: the file at `path` under
/// `workspace` now against what `name` would leave there.
fn change_preview(workspace: &Path, name: &str, input: &Value, path: &str, known: &[crate::secret_scan::KnownSecret]) -> (String, Option<String>) {
    let full = workspace.join(path);
    let no_preview = |why: &str| (format!("changes a file {why}, so the card doesn't preview it"), None);
    let current = match std::fs::metadata(&full) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Ok(m) if m.is_file() && m.len() <= PREVIEW_MAX_BYTES => match std::fs::read(&full) {
            Ok(bytes) => match String::from_utf8(bytes).ok().filter(|t| !t.contains('\0')) {
                Some(text) => Some(text),
                None => return no_preview("that isn't text"),
            },
            Err(_) => return no_preview("that can't be read"),
        },
        Ok(m) if m.is_file() => return no_preview("too large to show"),
        _ => return no_preview("that can't be read"),
    };
    let after = match (name, current.as_deref()) {
        ("write_file", _) => input.get("content").and_then(Value::as_str).unwrap_or("").to_string(),
        (_, None) => return ("edits a file that doesn't exist".to_string(), None),
        (_, Some(text)) => match crate::chat_engine::apply_edit(text, input, path) {
            Ok((updated, _)) => updated,
            Err(why) => return (format!("edits a file, but the edit doesn't apply to it as it is now: {why}"), None),
        },
    };
    let verb = match (name, &current) {
        (_, None) => "creates a file",
        ("edit_file", _) => "edits a file",
        _ => "writes a file",
    };
    let diff = unified_diff_redacting(current.as_deref().unwrap_or(""), &after, known);
    if diff.is_empty() {
        return (format!("{verb} without changing a line"), Some(diff));
    }
    (verb.to_string(), Some(diff))
}

/// The unified diff from `old` to `new`: each changed line with
/// [`DIFF_CONTEXT`] lines around it, under `@@ -a,b +c,d @@` headers, each
/// line redacted (`secret_scan::redact_line`) and cut to [`DIFF_LINE_MAX`],
/// at most [`DIFF_MAX_LINES`] lines with the rest counted. Empty when no
/// line changes. Pure.
pub fn unified_diff(old: &str, new: &str) -> String {
    unified_diff_redacting(old, new, &[])
}

/// [`unified_diff`], with `known` (the user's own keys) redacted as well.
pub fn unified_diff_redacting(old: &str, new: &str, known: &[crate::secret_scan::KnownSecret]) -> String {
    let (a, b): (Vec<&str>, Vec<&str>) = (old.lines().collect(), new.lines().collect());
    let pre = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let suf = a[pre..].iter().rev().zip(b[pre..].iter().rev()).take_while(|(x, y)| x == y).count();
    let mut ops: Vec<(char, &str)> = a[..pre].iter().map(|l| (' ', *l)).collect();
    ops.extend(align(&a[pre..a.len() - suf], &b[pre..b.len() - suf]));
    ops.extend(a[a.len() - suf..].iter().map(|l| (' ', *l)));
    hunks(&ops, known)
}

/// The lines of `a` and `b` as kept (` `), removed (`-`) and added (`+`),
/// along a longest common subsequence.
fn align<'a>(a: &[&'a str], b: &[&'a str]) -> Vec<(char, &'a str)> {
    let (n, m) = (a.len(), b.len());
    if n == 0 || m == 0 || n.saturating_mul(m) > DIFF_MAX_CELLS {
        return a.iter().map(|l| ('-', *l)).chain(b.iter().map(|l| ('+', *l))).collect();
    }
    // common[i * w + j]: the lines `a[i..]` and `b[j..]` have in common.
    let w = m + 1;
    let mut common = vec![0u32; (n + 1) * w];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            common[i * w + j] = if a[i] == b[j] { common[(i + 1) * w + j + 1] + 1 } else { common[(i + 1) * w + j].max(common[i * w + j + 1]) };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut ops = Vec::with_capacity(n + m);
    while i < n && j < m {
        if a[i] == b[j] {
            ops.push((' ', a[i]));
            (i, j) = (i + 1, j + 1);
        } else if common[(i + 1) * w + j] >= common[i * w + j + 1] {
            ops.push(('-', a[i]));
            i += 1;
        } else {
            ops.push(('+', b[j]));
            j += 1;
        }
    }
    ops.extend(a[i..].iter().map(|l| ('-', *l)));
    ops.extend(b[j..].iter().map(|l| ('+', *l)));
    ops
}

fn hunks(ops: &[(char, &str)], known: &[crate::secret_scan::KnownSecret]) -> String {
    // Where each op stands in the old and the new file, before it.
    let (mut old_at, mut new_at) = (Vec::with_capacity(ops.len() + 1), Vec::with_capacity(ops.len() + 1));
    let (mut o, mut n) = (0usize, 0usize);
    for (kind, _) in ops {
        old_at.push(o);
        new_at.push(n);
        o += usize::from(*kind != '+');
        n += usize::from(*kind != '-');
    }
    old_at.push(o);
    new_at.push(n);
    let mut groups: Vec<(usize, usize)> = Vec::new();
    for (i, _) in ops.iter().enumerate().filter(|(_, (kind, _))| *kind != ' ') {
        let (start, end) = (i.saturating_sub(DIFF_CONTEXT), (i + DIFF_CONTEXT + 1).min(ops.len()));
        match groups.last_mut() {
            Some(g) if start <= g.1 => g.1 = end,
            _ => groups.push((start, end)),
        }
    }
    let range = |at: &[usize], s: usize, e: usize| match at[e] - at[s] {
        0 => format!("{},0", at[s]),
        count => format!("{},{count}", at[s] + 1),
    };
    let total: usize = groups.iter().map(|(s, e)| e - s + 1).sum();
    let mut out: Vec<String> = Vec::new();
    'all: for &(s, e) in &groups {
        if out.len() + 1 >= DIFF_MAX_LINES {
            break;
        }
        out.push(format!("@@ -{} +{} @@", range(&old_at, s, e), range(&new_at, s, e)));
        for (kind, line) in &ops[s..e] {
            if out.len() >= DIFF_MAX_LINES {
                break 'all;
            }
            // Redacted whole, then cut, so a cut never leaves part of a value.
            let redacted = crate::secret_scan::redact_line(line, known);
            let cut = crate::chat_engine::truncate_char_safe(&redacted, DIFF_LINE_MAX);
            let more = if cut.len() < redacted.len() { "\u{2026}" } else { "" };
            out.push(format!("{kind}{cut}{more}"));
        }
    }
    if total > out.len() {
        out.push(format!("\u{2026} {} more lines", total - out.len()));
    }
    out.join("\n")
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
    let state = thread_mode_state(db, thread_id);
    (state.stored, state.effective)
}

/// A thread's mode as the Composer shows it (#1231): stored, in force, and
/// whether a read-only mission forces Plan only, by the rule its turns run
/// under ([`forced`]), whatever is stored (Plan only included).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ThreadModeState {
    pub stored: Mode,
    pub effective: Mode,
    pub forced: bool,
}

pub fn thread_mode_state(db: &Mutex<Db>, thread_id: &str) -> ThreadModeState {
    let stored = thread_mode(db, thread_id);
    let db = db.lock();
    let mission = db
        .chat_thread_workspace(thread_id)
        .ok()
        .flatten()
        .and_then(|w| db.active_mission_for_workspace(&w).ok().flatten());
    // Only whether the roots are empty matters here, not the workspace's path.
    let roots = mission.and_then(|m| crate::orchestrator::sandbox::sandbox_write_roots(&m.git_isolation, &m.exec_isolation, ""));
    ThreadModeState { stored, effective: effective(stored, roots.as_deref()), forced: forced(roots.as_deref()) }
}

/// How a gate learns the mode at the moment a call is checked.
pub type ModeSource = Arc<dyn Fn() -> Mode + Send + Sync>;

/// A thread's mode, read at each call, within the run's own `roots` (a run
/// that started in Plan only keeps its read-only sandbox, so it stays Plan).
pub fn thread_mode_source(db: Arc<Mutex<Db>>, thread_id: String, roots: Option<Vec<String>>) -> ModeSource {
    Arc::new(move || effective(thread_mode(&db, &thread_id), roots.as_deref()))
}

/// The mode check as a [`ToolGate`], for the loop Talk sub-agents run on:
/// each call is decided in the thread's mode first; one Ask first holds asks
/// through `inner` ([`ToolGate::ask_first`]: the sub-agent's approval gate,
/// on the director's broker, its card naming the sub-agent); then what the
/// mode lets through meets `inner`'s guards. Sub-agents never get the
/// `Agent` tool, so a Delegate call is treated as one that writes.
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
        match decide((self.mode)(), &ToolCall { name, input }, &ctx) {
            Decision::Allow => {}
            Decision::Deny { message } => return Some(message),
            Decision::Ask { .. } => {
                let held = match &self.inner {
                    Some(gate) => gate.ask_first(name, input).await,
                    None => Some(CANNOT_ASK.to_string()),
                };
                if held.is_some() {
                    return held;
                }
            }
        }
        match &self.inner {
            Some(gate) => gate.check(name, input).await,
            None => None,
        }
    }

    fn write_check(&self, name: &str, input: &Value) -> Option<crate::talk_guard::WriteCheck> {
        self.inner.as_ref().and_then(|g| g.write_check(name, input))
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
            // `ls` only reads, so Ask first runs it (`ask_first_reader_table`).
            ("run_command", allow.clone(), allow.clone(), allow.clone()),
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
        // Every refusal names the mode.
        for r in [Refused::Write, Refused::Net, Refused::Unconfined, Refused::Delegate, Refused::Remote("git push")] {
            assert!(plan_refusal(r, false).contains("Plan only mode"), "{r:?}");
        }
        // Ask first holds a command that doesn't only read, and the push too.
        let touch = json!({ "command": "touch a.rs" });
        assert_eq!(decide(Mode::Ask, &ToolCall { name: "run_command", input: &touch }, &ctx(None, &ro, false)), ask("runs a command", "touch a.rs"));
        assert_eq!(decide(Mode::Ask, &ToolCall { name: "run_command", input: &push }, &ctx(None, &ro, false)), ask("runs a command", "git push origin main"));
    }

    /// What Ask first runs without a card: commands that only read. Anything
    /// the check can't tell asks.
    #[test]
    fn ask_first_reader_table() {
        let runs = [
            "ls", "ls -la src", "cat README.md", "head -n 20 a.rs", "tail -n 5 log.txt", "wc -l a.rs b.rs",
            "grep -rn 'TODO' src", "diff a.txt b.txt", "pwd", "echo hello", "stat a.rs", "which cargo",
            "git status", "git status --porcelain", "git diff HEAD~1", "git log --oneline -5", "git show HEAD:a.rs",
            "git blame a.rs", "git ls-files", "git rev-parse HEAD",
            "cat a.rs | grep fn | head -3", "ls && git status; pwd", "grep x a.rs 2>/dev/null", "ls >/dev/null 2>&1",
            "cat < a.rs", "grep -c fn a.rs || echo none", "grep -n 'foo*' a.rs",
        ];
        for command in runs {
            assert!(reads_only(command), "{command} should run without a card");
        }
        let asks = [
            // Writes, or programs not on the list.
            "touch a.rs", "rm a.rs", "mkdir x", "cp a b", "sed -i s/a/b/ a.rs", "npm test", "cargo build",
            "find . -delete", "sort -o a.txt a.txt", "tee out.txt", "python3 -c 'print(1)'",
            // Output redirected.
            "echo x > a.rs", "cat a >> b", "ls &> out.txt", "grep x a.rs 2> err.txt",
            // A reader beside a writer, or nested in one.
            "ls; rm a.rs", "cat a.rs | tee b.rs", "echo $(rm a.rs)", "ls `touch x`", "cat <(rm -rf x)",
            // Outside the plain shape, a reader asks too (`plain_shape`).
            "echo $(git rev-parse HEAD)", "cat \"$FILE\"",
            // git that writes, or git flags before the subcommand.
            "git commit -m x", "git push", "git checkout main", "git branch -D x", "git -c core.pager=x log",
            "git -C .. status", "git diff --output=patch.txt", "git log --output patch.txt", "git diff --ext-diff",
            // What the check can't tell: a variable or a path as the program,
            // an assignment before it, a wrapper, a keyword, a script.
            "$EDITOR a.rs", "/bin/ls", "./ls", "PAGER=x git log", "env ls", "sudo cat a", "xargs cat",
            "bash -c 'ls'", "sh script.sh", "if true; then ls; fi", "for f in *; do cat $f; done", "",
        ];
        for command in asks {
            assert!(!reads_only(command), "{command} should ask");
        }
        assert!(!reads_only(&format!("echo {}", "$(".repeat(6))), "past the nesting it reads, it asks");
    }

    /// The shared shell's line editor acts on control characters as keys
    /// (`\r` ends the line, DEL erases), so a command holding one is
    /// refused before any check, in every mode: `echo hi\rtouch x` would
    /// run `touch` with no card.
    #[test]
    fn a_control_character_is_refused_in_every_mode_before_any_check() {
        let ro = HashSet::new();
        let refused = |mode: Mode, command: &str| {
            let input = json!({ "command": command });
            match decide(mode, &ToolCall { name: "run_command", input: &input }, &ctx(None, &ro, false)) {
                Decision::Deny { message } => Some(message),
                _ => None,
            }
        };
        for mode in [Mode::Plan, Mode::Ask, Mode::Edit] {
            let why = refused(mode, "echo hi\rtouch x").unwrap_or_else(|| panic!("{mode:?} let it through"));
            assert!(why.starts_with("Not run: the command holds the control character U+000D (carriage return)"), "{why}");
            let plain = refused(mode, "ls\t-la\nls");
            assert!(plain.is_none_or(|m| !m.contains("control character")), "{mode:?}: a tab and a newline pass");
        }
        assert!(!reads_only("echo hi\rtouch x"), "the reader check reads `\\r` as a space; readline ends the line there");
        // Edit freely's command check is fooled the same way: readline's
        // DEL erases the `x`, so `rm -rf /` runs.
        assert_eq!(crate::chat_engine::dangerous_command("rx\u{7f}m -rf /"), None);
        assert!(refused(Mode::Edit, "rx\u{7f}m -rf /").is_some_and(|w| w.contains("U+007F (delete)")));
        for (command, named) in [("ls\u{1b}[A", "U+001B (escape)"), ("ls\u{3}", "U+0003 (Ctrl-C)"), ("ls\u{4}", "U+0004 (Ctrl-D)"), ("ls\u{15}", "U+0015 (Ctrl-U)"), ("ls\u{0}", "U+0000"), ("ls\u{9b}", "U+009B")] {
            assert!(refused(Mode::Edit, command).is_some_and(|w| w.contains(named)), "{command:?}");
        }
    }

    /// A line continued with `\` can hide an expansion from the reader
    /// check: bash joins `$\⏎{PWD:_}` into `${PWD:_}`, which runs `touch`.
    #[test]
    fn a_line_continuation_asks() {
        for command in ["echo $'a[\\x24(touch x)]'; echo $\\\n{PWD:_}", "echo $'a[\\x24(touch x)]'; echo $\\\n[_]", "ls \\\n-la"] {
            assert!(!reads_only(command), "{command:?} should ask");
        }
        // `$'\x24'` decodes to a plain `$`, which bash never expands again;
        // it still asks, as anything with a `$` does (`plain_shape`).
        assert!(!reads_only("echo $'\\x24'{PWD:_}"));
        let dir = tempfile::tempdir().unwrap();
        let run = |command: &str| std::process::Command::new("/bin/bash").arg("-c").arg(command).current_dir(dir.path()).output().unwrap();
        run("echo 'a[$(touch x)]' >/dev/null; echo $'\\x24'{PWD:_} >/dev/null; echo $'\\x24(touch y)' >/dev/null");
        assert!(!dir.path().join("x").exists() && !dir.path().join("y").exists(), "bash ran a decoded `$`");
        run("echo $'a[\\x24(touch z)]' >/dev/null; echo $\\\n{PWD:_} >/dev/null");
        assert!(dir.path().join("z").exists(), "the continuation does run it: the case the check asks for");
    }

    /// Only a command of the plain shape runs without Ask first's card: no
    /// `$`, backtick, brace, backslash, `!` or `<<`. Brace expansion builds
    /// `${PWD:_}` from `{$,}{PWD:_}`, whose arithmetic runs what `$_` holds.
    #[test]
    fn only_a_plain_shape_reads() {
        for command in [
            // Brace expansion builds `${PWD:_}`: bash ran `touch` from this one.
            "echo $'a[\\x24(touch x)]'; echo {$,}{PWD:_}",
            "echo {$,}{PWD:_}",
            "echo 'a[$(touch x)]'; echo $_",
            "echo ${x:-a.rs}",
            "echo $((1+1))",
            "echo 'a[$(touch x)]'; echo ${PWD:_}",
            "echo ${a[_]}",
            "echo $[_]",
            "cat ${!_}",
            "cat \"${FILE}\"",
            "echo ${#PATH}",
            "ls {a,b}.rs",
            "grep x '${a[_]}'",
            "echo hi!",
            "grep 'a\\.b' a.rs",
            "cat <<EOF",
            // A glob or a tilde expands into words the check never read.
            "git diff *",
            "git lfs pu?h",
            "grep -n foo src/*.rs",
            "ls [ab].rs",
            "cat ~/.bashrc",
            "ls ~",
            "echo 'open",
            // An alias or a function changes what a later word runs.
            "f() ( touch x ); f",
            "alias ls=touch",
            "unalias ls",
            "function git",
            "(ls)",
        ] {
            assert!(!plain_shape(command) && !reads_only(command), "{command} should ask");
        }
        for command in ["grep -n 'foo*' a.rs", "cat 'a*b' \"c?d\" '[x]' '~'", "git diff HEAD~1", "cat a.rs | head -3", "ls -la src > /dev/null 2>&1"] {
            assert!(plain_shape(command) && reads_only(command), "{command} should run without a card");
        }
        let dir = tempfile::tempdir().unwrap();
        let ran = std::process::Command::new("/bin/bash")
            .arg("-c")
            .arg("echo $'a[\\x24(touch x)]' >/dev/null; echo {$,}{PWD:_} >/dev/null")
            .current_dir(dir.path())
            .status();
        assert!(ran.is_ok_and(|s| s.success()) && dir.path().join("x").exists(), "bash runs it: the case the shape asks for");
        // A glob expands into a flag: beside a file named `--output=x`, `git
        // diff *` writes `x`.
        let repo = tempfile::tempdir().unwrap();
        let sh = |script: &str| std::process::Command::new("/bin/bash").arg("-c").arg(script).current_dir(repo.path()).output();
        if sh("git init -q . && : > a && : > ./--output=x").is_ok_and(|o| o.status.success()) {
            let _ = sh("git diff *");
            assert!(repo.path().join("x").exists(), "git diff * wrote through a file named like a flag");
        }
    }

    /// A git reader skips the card only where it starts inside the
    /// workspace, resolved on the disk.
    #[test]
    fn a_git_reader_outside_the_workspace_asks() {
        let (ws, other) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        std::fs::create_dir(ws.path().join("sub")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(other.path(), ws.path().join("out")).unwrap();
        let w = ws.path();
        assert!(!git_outside("git status", Some(w), w), "at the workspace root");
        assert!(git_outside("git status", None, w), "an unknown start (a reattached shell) asks");
        assert!(!git_outside("cat a.rs", None, w), "only git is held");
        assert!(!git_outside("git log -1", Some(&w.join("sub")), w));
        assert!(git_outside("git status", Some(other.path()), w));
        assert!(git_outside("ls && git diff", Some(other.path()), w), "any git in the command");
        assert!(git_outside("git status", Some(&w.join("missing")), w), "unresolvable counts as outside");
        #[cfg(unix)]
        assert!(git_outside("git status", Some(&w.join("out")), w), "a link out of the workspace is outside");
        assert!(!git_outside("cat a.rs", Some(other.path()), w), "only git is held");
    }

    fn workspace_reach(files: &[(&str, &str)]) -> (tempfile::TempDir, tempfile::TempDir, Reach) {
        let (ws, home) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        for (path, content) in files {
            std::fs::write(ws.path().join(path), content).unwrap();
        }
        let reach = Reach::new(ws.path(), None, Some(home.path()));
        (ws, home, reach)
    }

    /// In Ask first a file change waits on a card that shows its diff: the
    /// file as it is against the file as the call would leave it.
    #[test]
    fn ask_edit_parks_with_diff() {
        let ro = HashSet::new();
        let (ws, _home, reach) = workspace_reach(&[("a.rs", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n")]);
        let edit = json!({ "path": "a.rs", "old_string": "two", "new_string": "2" });
        let decided = decide(Mode::Ask, &ToolCall { name: "edit_file", input: &edit }, &ctx(None, &ro, false));
        assert_eq!(decided, Decision::Ask { reason: "changes a file".into(), preview: "a.rs".into() });
        let card = ask_card(None, "edit_file", &edit, &reach);
        assert_eq!((card.kind, card.shown.as_str(), card.reason.as_str()), (CardKind::Edit, "a.rs", "edits a file (Ask first)"));
        // Three lines of context, and no more.
        assert_eq!(card.diff.as_deref(), Some("@@ -1,5 +1,5 @@\n one\n-two\n+2\n three\n four\n five"));
        assert!(!CardKind::Edit.grantable() && !CardKind::Exec.grantable(), "no \"don't ask again\"");
        assert_eq!(std::fs::read_to_string(ws.path().join("a.rs")).unwrap().lines().nth(1), Some("two"), "nothing is written");
        // A new file, and a whole file rewritten.
        let new = ask_card(None, "write_file", &json!({ "path": "b.md", "content": "hello\nworld\n" }), &reach);
        assert_eq!((new.reason.as_str(), new.diff.as_deref()), ("creates a file (Ask first)", Some("@@ -0,0 +1,2 @@\n+hello\n+world")));
        assert!(!ws.path().join("b.md").exists());
        // Credential-looking values are redacted.
        let token = format!("ghp_{}", "a".repeat(36));
        let secret = ask_card(None, "write_file", &json!({ "path": "c.sh", "content": format!("GITHUB_TOKEN={token}\n") }), &reach);
        assert!(secret.diff.as_deref().is_some_and(|d| d.starts_with("@@ -0,0 +1,1 @@\n+GITHUB_TOKEN=") && !d.contains(&token)), "{secret:?}");
        // Outside the workspace, or named like an env file: no preview, the path named.
        for path in ["../elsewhere.txt", ".env", "deploy.pem"] {
            let c = ask_card(None, "write_file", &json!({ "path": path, "content": "x" }), &reach);
            assert_eq!((c.kind, c.shown.as_str(), c.diff.as_deref()), (CardKind::Edit, path, None), "{path}");
        }
        // A file that runs commands keeps its diff, and its Config card still
        // asks after this one (#1245).
        std::fs::create_dir_all(ws.path().join(".claude")).unwrap();
        std::fs::write(ws.path().join(".claude/mcp.json"), "{}\n").unwrap();
        let mcp = json!({ "path": ".claude/mcp.json", "content": "{\"mcpServers\":{}}\n" });
        let c = ask_card(None, "write_file", &mcp, &reach);
        assert_eq!(c.kind, CardKind::Edit);
        assert_eq!(c.reason, "writes a file \u{b7} it can make Octopush or Claude Code run commands (Ask first)");
        assert_eq!(c.diff.as_deref(), Some("@@ -1,1 +1,1 @@\n-{}\n+{\"mcpServers\":{}}"));
        assert_eq!(reach.outside_card(None, "write_file", &mcp, false, &[]).map(|g| g.kind), Some(CardKind::Config));
        let settings = ask_card(None, "write_file", &json!({ "path": ".claude/settings.json", "content": "{}\n" }), &reach);
        assert_eq!(settings.diff.as_deref(), Some("@@ -0,0 +1,1 @@\n+{}"), "a new one previews too");
        // Claude Code's local settings may hold credentials: no preview, as before.
        let local = ask_card(None, "write_file", &json!({ "path": ".claude/settings.local.json", "content": "{}\n" }), &reach);
        assert_eq!(local.diff, None);
        // A command's card shows the command; a sub-agent's names it.
        let run = ask_card(Some("Fix the tests"), "run_command", &json!({ "command": "npm test" }), &reach);
        assert_eq!((run.kind, run.shown.as_str()), (CardKind::Exec, "npm test"));
        assert_eq!(run.reason, "Sub-agent \u{201c}Fix the tests\u{201d}: runs a command (Ask first)");
        // A long diff is capped, and counts what it leaves out.
        let long: String = (0..1000).map(|i| format!("line {i}\n")).collect();
        let capped = unified_diff("", &long);
        assert_eq!(capped.lines().count(), DIFF_MAX_LINES + 1);
        assert!(capped.ends_with(&format!("\u{2026} {} more lines", 1001 - DIFF_MAX_LINES)), "{:?}", capped.lines().last());
        assert_eq!(unified_diff("same\n", "same\n"), "");
        assert_eq!(unified_diff("a\nb\nc\n", "a\nc\n"), "@@ -1,3 +1,2 @@\n a\n-b\n c");
    }

    /// Denied, a call gets a fixed tool result and nothing runs: on the
    /// director's card, and through a sub-agent's gate.
    #[tokio::test]
    async fn deny_returns_fixed_result() {
        use crate::chat_engine::{guard_card, ApprovalDecision};
        let (ws, _home, reach) = workspace_reach(&[("a.rs", "old\n")]);
        let write = json!({ "path": "a.rs", "content": "new\n" });
        let check = || Some(ask_card(None, "write_file", &write, &reach));
        let deny = |_: ToolCard| std::future::ready(ApprovalDecision::Deny);
        assert_eq!(guard_card(check().unwrap(), || std::future::ready(check()), deny).await.as_deref(), Some(ASK_DECLINED_CHANGE));
        let command = json!({ "command": "npm test" });
        let run = || Some(ask_card(None, "run_command", &command, &reach));
        assert_eq!(guard_card(run().unwrap(), || std::future::ready(run()), deny).await.as_deref(), Some(ASK_DECLINED_COMMAND));
        assert_eq!(std::fs::read_to_string(ws.path().join("a.rs")).unwrap(), "old\n");

        // A sub-agent's gate asks through its approval gate before the guards.
        struct Declines(Mutex<Vec<String>>);
        #[async_trait::async_trait]
        impl ToolGate for Declines {
            async fn check(&self, name: &str, _input: &Value) -> Option<String> {
                self.0.lock().push(format!("check {name}"));
                None
            }
            async fn ask_first(&self, name: &str, _input: &Value) -> Option<String> {
                self.0.lock().push(format!("ask {name}"));
                Some(ASK_DECLINED_CHANGE.to_string())
            }
        }
        let calls = Arc::new(Declines(Mutex::new(Vec::new())));
        struct Shared(Arc<Declines>);
        #[async_trait::async_trait]
        impl ToolGate for Shared {
            async fn check(&self, name: &str, input: &Value) -> Option<String> {
                self.0.check(name, input).await
            }
            async fn ask_first(&self, name: &str, input: &Value) -> Option<String> {
                self.0.ask_first(name, input).await
            }
        }
        let gate = ModeGate::new(Arc::new(|| Mode::Ask), None, false, HashSet::new(), Some(Box::new(Shared(Arc::clone(&calls)))));
        assert_eq!(gate.check("write_file", &write).await.as_deref(), Some(ASK_DECLINED_CHANGE));
        assert_eq!(gate.check("run_command", &json!({ "command": "git status" })).await, None);
        assert_eq!(*calls.0.lock(), ["ask write_file", "check run_command"], "a declined call never reaches the tool; a reader skips the card, not the guards");
        let alone = ModeGate::new(Arc::new(|| Mode::Ask), None, false, HashSet::new(), None);
        assert_eq!(alone.check("edit_file", &write).await.as_deref(), Some(CANNOT_ASK));
    }

    /// Once approved, the call runs only if its diff is still the one the
    /// card showed: a file that changed while the card waited asks again.
    #[tokio::test]
    async fn a_file_that_changed_while_its_card_waited_asks_again() {
        use crate::chat_engine::{guard_card, ApprovalDecision};
        let (ws, _home, reach) = workspace_reach(&[("a.rs", "old\n")]);
        let write = json!({ "path": "a.rs", "content": "new\n" });
        let check = || Some(ask_card(None, "write_file", &write, &reach));
        let shown = Mutex::new(Vec::<String>::new());
        let approve = |c: ToolCard| {
            let first = shown.lock().is_empty();
            shown.lock().push(c.diff.clone().unwrap_or_default());
            if first {
                std::fs::write(ws.path().join("a.rs"), "changed meanwhile\n").unwrap();
            }
            std::future::ready(ApprovalDecision::Approve)
        };
        assert_eq!(guard_card(check().unwrap(), || std::future::ready(check()), approve).await, None, "approved again, it runs");
        let shown = shown.into_inner();
        assert_eq!(shown, ["@@ -1,1 +1,1 @@\n-old\n+new", "@@ -1,1 +1,1 @@\n-changed meanwhile\n+new"]);
    }

    /// The approval binds to the whole change, not the diff shown: a line
    /// far past the preview that changes while the card waits asks again,
    /// and the new card says why. A cut diff says how many lines it hides.
    #[tokio::test]
    async fn an_approval_binds_to_the_whole_change_not_the_diff_shown() {
        use crate::chat_engine::ApprovalDecision;
        let long: String = (0..1000).map(|i| format!("line {i}\n")).collect();
        let (ws, _home, reach) = workspace_reach(&[("a.txt", &long)]);
        let edit = json!({ "path": "a.txt", "old_string": "line 0\n", "new_string": "first\n" });
        let check = || ask_card(None, "edit_file", &edit, &reach);
        let first = check();
        let asked = Mutex::new(Vec::<String>::new());
        let approve = |c: ToolCard| {
            asked.lock().push(c.reason.clone());
            if asked.lock().len() == 1 {
                std::fs::write(ws.path().join("a.txt"), long.replace("line 900\n", "line 900, edited\n")).unwrap();
            }
            std::future::ready(ApprovalDecision::Approve)
        };
        let recheck = || std::future::ready(Some(check()));
        assert_eq!(guard_ask_first(first.clone(), recheck, || None, approve).await, AskOutcome::Approved);
        let asked = asked.into_inner();
        assert_eq!(asked.len(), 2, "{asked:?}");
        assert_eq!(asked[1], format!("{} {CHANGED_WHILE_WAITING}", first.reason));
        let now = ask_card(None, "edit_file", &edit, &reach);
        assert_eq!(now.diff, first.diff, "the diff shown is the same");
        assert_ne!(now.bound, first.bound, "the change isn't");
        // A rewrite too long to show says how many lines it leaves out.
        let all: String = (0..1000).map(|i| format!("new {i}\n")).collect();
        let big = ask_card(None, "write_file", &json!({ "path": "a.txt", "content": all }), &reach);
        assert!(big.diff.as_deref().is_some_and(|d| d.lines().last().is_some_and(|l| l.starts_with('\u{2026}') && l.ends_with(" more lines"))), "{:?}", big.diff);
    }

    /// A change the tool refuses whatever the user answers gets that
    /// refusal, in the tool's words, and never a card; once approved, one the
    /// tool would now refuse gets the refusal, not a second card.
    #[tokio::test]
    async fn a_change_the_tool_would_refuse_gets_no_card() {
        use crate::chat_engine::ApprovalDecision;
        let (ws, _home, reach) = workspace_reach(&[("a.rs", "one\n"), (".env", "A=1\n")]);
        let refused = |name: &str, input: Value, roots: Option<&[String]>| refused_before_card(&reach, name, &input, roots);
        let edit = |path: &str, old: &str| json!({ "path": path, "old_string": old, "new_string": "x" });
        assert!(refused("edit_file", edit("a.rs", "two"), None).is_some_and(|r| r.starts_with("old_string not found in a.rs")));
        assert!(refused("edit_file", edit("b.rs", "one"), None).is_some_and(|r| r.starts_with("Error reading b.rs:")));
        assert_eq!(refused("edit_file", edit("a.rs", ""), None).as_deref(), Some("edit_file needs a non-empty `old_string`"));
        let roots = [ws.path().to_string_lossy().into_owned()];
        let outside = json!({ "path": "../elsewhere.txt", "content": "x" });
        assert_eq!(
            refused("write_file", outside.clone(), Some(&roots)).as_deref(),
            Some("Sandboxed: refusing to write outside the mission workspace (../elsewhere.txt)")
        );
        assert_eq!(refused("write_file", outside, None), None, "unconfined, the outside card asks");
        assert_eq!(
            refused("edit_file", json!({ "path": "../elsewhere.txt", "old_string": "a", "new_string": "b" }), Some(&roots)).as_deref(),
            Some("Sandboxed: refusing to edit outside the mission workspace (../elsewhere.txt)"),
            "an edit outside the sandbox, which the card wouldn't preview, is refused too"
        );
        let outside_edit = json!({ "path": "../elsewhere.txt", "old_string": "a", "new_string": "b" });
        assert!(sandbox_refusal(&reach, "edit_file", &outside_edit, Some(&roots)).is_some(), "in every mode");
        assert_eq!(sandbox_refusal(&reach, "edit_file", &edit("a.rs", "two"), Some(&roots)), None, "only the sandbox's refusal");
        assert_eq!(refused("edit_file", edit("a.rs", "one"), Some(&roots)), None, "an edit that applies");
        assert_eq!(refused("edit_file", edit(".env", "B"), None), None, "a file the card won't read isn't read here");
        // Approved, then the edit stopped applying: its refusal, asked once.
        let input = edit("a.rs", "one");
        let check = || ask_card(None, "edit_file", &input, &reach);
        let asked = Mutex::new(0);
        let approve = |_: ToolCard| {
            *asked.lock() += 1;
            std::fs::write(ws.path().join("a.rs"), "replaced\n").unwrap();
            std::future::ready(ApprovalDecision::Approve)
        };
        let now = || refused_before_card(&reach, "edit_file", &input, None);
        let outcome = guard_ask_first(check(), || std::future::ready(Some(check())), now, approve).await;
        assert!(matches!(&outcome, AskOutcome::Refused(r) if r.starts_with("old_string not found")), "{outcome:?}");
        assert_eq!(*asked.lock(), 1);
    }

    /// The user's own keys are redacted from a diff like any credential.
    #[test]
    fn a_diff_redacts_the_users_own_keys() {
        let key = "sample-own-key-0123456789abcdef";
        let known = [crate::secret_scan::KnownSecret::new("your sample API key", key)];
        let diff = unified_diff_redacting("", &format!("note {key}\n"), &known);
        assert!(diff.starts_with("@@ -0,0 +1,1 @@\n+note ") && !diff.contains(key), "{diff}");
        assert!(unified_diff("", &format!("note {key}\n")).contains(key), "no pattern marks it: only the known key does");
    }

    /// A mode change during a turn applies at the next round, where the
    /// director reads it, and leaves one quiet note naming the mode now in
    /// force. An `AppHandle` can't be built in a test, so this reads the
    /// loop's source; the transcript side is `the_v2_transcript_skips_a_mode_note`.
    #[test]
    fn mode_switch_applies_next_round_with_note() {
        for (mode, label) in [(Mode::Plan, "Plan only"), (Mode::Ask, "Ask first"), (Mode::Edit, "Edit freely")] {
            assert_eq!(mode_note(mode), format!("Mode switched to {label} from this round on."));
            assert!(is_mode_note("stopped", &mode_note(mode)));
        }
        let engine = include_str!("chat_engine.rs");
        let from = engine.find("// \u{2500}\u{2500}\u{2500} Agentic loop").expect("the director's loop");
        let to = from + engine[from..].find("// \u{2500}\u{2500}\u{2500} Handle tool use").expect("its tool rounds");
        let round = &engine[from..to];
        let read = round.find("permissions::thread_mode(").expect("the boundary reads the mode");
        let noted = round.find("if round_mode.is_some_and(|was| was != mode) {").expect("a switch is noted");
        let note = round.find("crate::permissions::mode_note(mode)").expect("the note names the mode");
        let kept = round.find("round_mode = Some(mode);").expect("the round's mode is kept");
        assert!(read < noted && noted < note && note < kept, "{round}");
        assert_eq!(round.matches("mode_note(").count(), 1, "one note per switch");
        // The mode it reads is the thread's, at that moment.
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Arc::new(Mutex::new(Db::open(tmp.path()).unwrap()));
        let thread = {
            let d = db.lock();
            d.insert_project("p-sw", "P", "/tmp/octo-mode-switch").unwrap();
            d.insert_workspace("w-sw", "p-sw", "ws", "", "main", None, "", None).unwrap();
            d.create_chat_thread("w-sw", "Switch").unwrap().id
        };
        let source = thread_mode_source(Arc::clone(&db), thread.clone(), None);
        assert_eq!(source(), Mode::Edit);
        db.lock().set_thread_permission_mode(&thread, Mode::settable("ask").unwrap()).unwrap();
        assert_eq!(source(), Mode::Ask, "the next read sees the switch");
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
        assert_eq!(thread_modes(&db, "gone"), (Mode::Edit, Mode::Edit));
        // The Composer reads `forced` from this rule, Plan only stored too
        // (#1231): its control locks, and offers no mode the turns won't run.
        let state = |db: &Mutex<Db>| thread_mode_state(db, &thread);
        assert_eq!(state(&db), ThreadModeState { stored: Mode::Edit, effective: Mode::Plan, forced: true });
        db.lock().set_thread_permission_mode(&thread, Mode::Plan).unwrap();
        assert_eq!(state(&db), ThreadModeState { stored: Mode::Plan, effective: Mode::Plan, forced: true }, "stored=plan under a read-only mission");
        assert!(!thread_mode_state(&db, "gone").forced);
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
            "let git_outside = mode == crate::permissions::Mode::Ask && !mode_denied && u.name == \"run_command\" && {",
            "crate::permissions::git_outside(command, cwd.as_deref().map(Path::new), Path::new(&request.workspace_path))",
            "let held = (mode_asks.contains(&u.id) || git_outside || loose_shell.is_some()) && skill_refusal.is_none();",
            "crate::talk_shell::Strictness::Verified => None,",
            "let entered = self.talk_shell.set_strict(&request.thread_id, strict_mode);",
            "tokio::task::spawn_blocking(move || shell.restart_strict(&tid, &wp, label)).await;",
            "true => shell.run_capture_read_only(&tid, &wp, &command, std::time::Duration::from_secs(600)),",
            "if held && pre_refused.is_none() {",
            "let ask_place = || Some(crate::permissions::ask_card(None, &u.name, &u.input, &reach));",
            "if !reach.checked(&granted).await {",
            "match crate::permissions::guard_ask_first(card, &check, refused, ask).await {",
            "None if inside() => self.file_seen_refusal(&request.thread_id, &workspace_path, &u.name, &u.input).await,",
            "forced: crate::permissions::forced(sandbox_roots.as_deref()),",
            "let parsed = match mode_denials.get(&u.id) {",
            "let mut denied: Option<String> = mode_denials.get(&u.id).filter(|_| !is_agent).cloned();",
            "let mut was_denied = denied.is_some() || mode_denied;",
            "self.talk_shell.available() && exec_roots.is_none()",
            "run_confined(&workspace_path, &u.input, exec_roots.clone(), &cancel).await",
            "name_forced_mission(out, crate::permissions::forced(sandbox_roots.as_deref()))",
            "run_builtin(&workspace_path, &u.name, &u.input, exec_roots.clone(), &cancel, landing).await",
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
        // In Ask first no "don't ask again" answers a card (#1231): every
        // card the director and a sub-agent gate raise carries the mode.
        assert_eq!(body.matches("self.approvals.await_card(").count(), body.matches(", c, mode)").count(), "{body}");
        assert!(body.contains("command, reason, grant, mode)"), "the destructive-command card");
        let at = agents.find("impl ToolGate for SubagentGate").expect("the sub-agent gate");
        let gate = &agents[at..at + agents[at..].find("\n}\n").unwrap()];
        assert_eq!(gate.matches("self.broker.await_card(").count(), gate.matches(", c, mode)").count(), "{gate}");
        assert!(gate.contains("&card_reason, grant, mode)"), "{gate}");
    }
}
