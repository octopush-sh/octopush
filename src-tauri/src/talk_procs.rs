//! Talk's background processes (#1160): what the agent starts with
//! `run_command { keep_running: true }`, and a foreground command promoted to
//! the live process panel when it is still running at its timeout.
//!
//! A background command gets its own PTY in the `octopush-pty-server` daemon
//! (`talkproc-<thread>-<n>`), so it outlives the turn and an Octopush restart,
//! as the conversation's shell does. The daemon starts it through a fixed
//! launcher ([`LAUNCHER`]) that runs it as a non-interactive `/bin/bash -c`,
//! as the isolated fallback runs a command: no profile, alias or function
//! applies, so what the command check read is what runs. A sandboxed
//! mission's command runs under its seatbelt profile, as a foreground one
//! does. A promoted command keeps running where it started: in the
//! conversation's shared shell.
//!
//! Each process keeps its last [`RING_BYTES`] of output in memory, read with
//! an absolute byte cursor (`read_output`), and its record on disk, one JSON
//! file per conversation beside the daemon's socket (`talk-procs/<thread>.json`),
//! so the list survives a restart. A background process still running in the
//! daemon after a restart is attached again, its output replayed from the
//! daemon's scrollback.

use crate::permissions::Mode;
use crate::pty_client::{DaemonClient, TermEvent};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The tool that reads a background process's output.
pub const READ_OUTPUT_TOOL: &str = "read_output";
/// The tool that stops one.
pub const STOP_TOOL: &str = "stop";

/// Background processes one conversation may have running at once.
pub const MAX_RUNNING: usize = 5;
/// Processes a conversation keeps, running or ended; the oldest ended ones go first.
const MAX_KEPT: usize = 10;
/// Output each process keeps, in bytes: the most recent.
pub const RING_BYTES: usize = 256 * 1024;
/// Most of a process's output one `read_output` returns (head and tail).
pub const READ_MAX_BYTES: usize = crate::chat_history::COMMAND_SHOWN_BYTES;
/// How long a start waits for a command's first output, or for it to end at once.
const START_PEEK: Duration = Duration::from_millis(1500);
/// How long a stop waits for a process to end after it is asked to.
const STOP_GRACE: Duration = Duration::from_secs(3);

/// The variables the launcher reads a command's argv from.
const ARGC_ENV: &str = "OCTOPUSH_PROC_ARGC";
const ARG_ENV: &str = "OCTOPUSH_PROC_ARG_";
/// The variable that says how long the launcher waits for its start line.
const WAIT_ENV: &str = "OCTOPUSH_PROC_WAIT";
/// How long the launcher waits for its start line, in seconds.
const START_WAIT_SECS: u64 = 10;
/// The exit code of a launcher whose start line never came: it ran nothing.
pub const NO_START_LINE: i32 = 125;

/// The script the daemon runs for a background command. The daemon starts
/// every terminal's program with `-l`, which this ignores. It runs nothing
/// until Octopush writes its start line, once the process is recorded,
/// attached and checked again (`TalkProcs::start`): a line that doesn't come
/// within [`WAIT_ENV`] seconds (10) means the start was abandoned, so it
/// exits with [`NO_START_LINE`] and the command never runs. The command's
/// argv comes in [`ARGC_ENV`] and `OCTOPUSH_PROC_ARG_<i>`, which leave the
/// environment before it runs. Privileged mode (`-p`) reads no `BASH_ENV`
/// and imports no function from the environment, and the command gets
/// neither.
pub(crate) const LAUNCHER: &str = r#"#!/bin/bash -p
# Octopush starts one Talk background command through this file (#1160).
if ! read -r -t "${OCTOPUSH_PROC_WAIT:-10}" _octo_go; then
  exit 125
fi
unset _octo_go OCTOPUSH_PROC_WAIT
n=${OCTOPUSH_PROC_ARGC:-0}
args=()
i=0
while [ "$i" -lt "$n" ]; do
  v="OCTOPUSH_PROC_ARG_$i"
  args+=("${!v}")
  unset "$v"
  i=$((i+1))
done
unset OCTOPUSH_PROC_ARGC BASH_ENV ENV
[ "$n" -gt 0 ] || exit 127
exec "${args[@]}"
"#;

/// Whether a `run_command` call asks to keep running in the background.
pub fn keeps_running(input: &serde_json::Value) -> bool {
    input.get("keep_running").and_then(serde_json::Value::as_bool) == Some(true)
}

/// Whether `name` is one of the tools that read or stop a background process.
pub fn is_proc_tool(name: &str) -> bool {
    name == READ_OUTPUT_TOOL || name == STOP_TOOL
}

/// What a `run_command` outside Talk's director (a sub-agent, a Direct
/// stage) answers to `keep_running`: those loops wait for every command, so
/// it isn't run rather than run until its timeout.
pub const NOT_HERE: &str = "Not run: keep_running is only available to Talk's main agent. Run a command that \
     finishes, or leave the server to the main agent.";

/// What a start gets when no daemon is attached.
const NO_DAEMON: &str = "Not started: background processes run in Octopush's terminal service, which isn't \
     available right now. Run a command that finishes instead.";

/// How a process came to run in the background.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcKind {
    /// `run_command { keep_running: true }`: its own PTY.
    Background,
    /// A foreground command still running at its timeout, in the shared shell.
    Promoted,
}

/// What a conversation allowed when a process started, so it never outlives
/// a stricter one (#1160): entering Ask first or Plan only, or a mission that
/// comes to ship nothing or to run sandboxed, stops what started before.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Posture {
    pub mode: Mode,
    pub ships_nothing: bool,
    pub sandboxed: bool,
}

impl Posture {
    fn rank(mode: Mode) -> u8 {
        match mode {
            Mode::Edit => 0,
            Mode::Ask => 1,
            Mode::Plan => 2,
        }
    }

    /// Whether this posture is stricter than `start` in any way. Pure.
    pub fn stricter_than(&self, start: &Posture) -> bool {
        Self::rank(self.mode) > Self::rank(start.mode)
            || (self.ships_nothing && !start.ships_nothing)
            || (self.sandboxed && !start.sandboxed)
    }
}

/// One process as kept on disk.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcRecord {
    /// The id the model and the panel use: `proc-<n>`, unique in its conversation.
    pub id: String,
    pub n: u64,
    /// The daemon terminal it runs in: its own, or the shared shell's.
    pub term_id: String,
    pub thread_id: String,
    pub workspace_id: String,
    pub kind: ProcKind,
    pub command: String,
    pub cwd: String,
    /// Unix seconds.
    pub started_at: i64,
    /// The conversation's mode as it started (`Mode::as_str`).
    pub mode: String,
    #[serde(default)]
    pub ships_nothing: bool,
    #[serde(default)]
    pub sandboxed: bool,
    #[serde(default)]
    pub ended_at: Option<i64>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    /// Stopped by the agent, the user, or a stricter mode.
    #[serde(default)]
    pub stopped: bool,
    /// Gone without a trace Octopush can follow: after a restart the
    /// terminal service no longer knew it, or its pid or its shell now hold
    /// another process. Nothing signals it then.
    #[serde(default)]
    pub lost: bool,
    /// Its process group as it started or was promoted: its own pid for a
    /// background process, the job that held the shared shell for a
    /// promoted one. A stop signals this group and no other.
    #[serde(default)]
    pub pgid: Option<i32>,
    /// When that group's leader started (`talk_shell::process_started`), so
    /// a pid used again later never passes for it.
    #[serde(default)]
    pub pgid_started: Option<u64>,
    /// Recorded before its spawn, and not yet given its start line: a
    /// record still starting after a restart was never confirmed, so what
    /// it started is stopped, and without one it is dropped.
    #[serde(default)]
    pub starting: bool,
}

impl ProcRecord {
    pub fn running(&self) -> bool {
        self.ended_at.is_none()
    }

    fn posture(&self) -> Posture {
        Posture { mode: Mode::from_stored(Some(&self.mode)), ships_nothing: self.ships_nothing, sandboxed: self.sandboxed }
    }

    /// Its state in a few words, for the model. Pure.
    fn status(&self) -> String {
        if self.running() {
            return "running".to_string();
        }
        if self.stopped {
            return "stopped".to_string();
        }
        if self.lost {
            return "lost: Octopush can no longer tell it from another process (after a restart), so it isn't signalled".to_string();
        }
        match self.exit_code {
            Some(code) => format!("exited {code}"),
            None => "ended".to_string(),
        }
    }

    fn view(&self) -> ProcView {
        ProcView {
            id: self.id.clone(),
            kind: self.kind,
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            started_at: self.started_at,
            running: self.running(),
            exit_code: self.exit_code,
            stopped: self.stopped,
            lost: self.lost,
        }
    }
}

/// One process as the panel and the commands see it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcView {
    pub id: String,
    pub kind: ProcKind,
    pub command: String,
    pub cwd: String,
    pub started_at: i64,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub stopped: bool,
    pub lost: bool,
}

/// A process's most recent output, with an absolute cursor: `total` counts
/// every byte it ever printed, and the buffer holds the last `cap` of them.
struct OutputRing {
    bytes: VecDeque<u8>,
    total: u64,
    cap: usize,
}

impl OutputRing {
    fn new(cap: usize) -> Self {
        Self { bytes: VecDeque::new(), total: 0, cap }
    }

    fn push(&mut self, data: &[u8]) {
        self.total += data.len() as u64;
        if data.len() >= self.cap {
            self.bytes.clear();
            self.bytes.extend(&data[data.len() - self.cap..]);
            return;
        }
        let over = (self.bytes.len() + data.len()).saturating_sub(self.cap);
        self.bytes.drain(..over);
        self.bytes.extend(data);
    }

    /// The cursor of the oldest byte kept.
    fn start(&self) -> u64 {
        self.total - self.bytes.len() as u64
    }

    /// The bytes kept from `since` on, and how many after `since` are no
    /// longer kept. Pure.
    fn since(&self, since: u64) -> (Vec<u8>, u64) {
        let start = self.start();
        let from = since.clamp(start, self.total);
        let skip = usize::try_from(from - start).unwrap_or(usize::MAX);
        (self.bytes.iter().skip(skip).copied().collect(), start.saturating_sub(since))
    }
}

struct Entry {
    record: ProcRecord,
    out: OutputRing,
    /// Loaded after a restart: its output from before then may be missing,
    /// and a promoted one has no stream to say when it ends.
    restored: bool,
}

#[derive(Default)]
struct State {
    threads: HashMap<String, Vec<Entry>>,
}

/// What [`TalkProcs::start`] needs to start a command.
pub struct StartSpec {
    pub thread_id: String,
    pub workspace_id: String,
    /// The sandbox's scope (its build caches), when it runs sandboxed.
    pub workspace_path: String,
    pub command: String,
    /// Where it starts: the shared shell's directory, or the workspace root.
    pub cwd: String,
    /// Variables it starts with besides PATH: the workspace's ports (#1219).
    pub env: Vec<(String, String)>,
    pub posture: Posture,
    /// The conversation's posture as it is now, read again once the process
    /// is spawned and before it runs: a stricter one kills it.
    pub posture_now: PostureSource,
    /// The turn's Stop: raised while it was spawned, it kills it.
    pub cancel: Option<Arc<std::sync::atomic::AtomicBool>>,
    /// The mission's write roots when it is sandboxed (`Some([])`, Plan
    /// only's read-only profile, starts nothing).
    pub sandbox_roots: Option<Vec<String>>,
}

/// Reads a conversation's posture as it is now.
pub type PostureSource = Arc<dyn Fn() -> Posture + Send + Sync>;

/// What a start killed because the turn was stopped while it was spawned.
const STOPPED_WHILE_STARTING: &str = "Not started: the turn was stopped while the command was starting, so it never ran.";

/// What a start killed because the conversation's posture grew stricter
/// while it was spawned says. Pure.
fn changed_while_starting(now: Posture) -> String {
    let why = if now.ships_nothing || now.sandboxed {
        "its workspace's mission changed".to_string()
    } else {
        format!("the conversation switched to {}", now.mode.label())
    };
    format!("Not started: {why} while the command was starting, so it never ran. Start it again if it is still needed.")
}

/// What holds a promoted command's shell, against the job recorded when it
/// was promoted (its group and start time).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Holder {
    /// That job: this group.
    Ours(i32),
    /// Another job: the command is gone, and this one must not be signalled.
    Other,
    /// The recorded group, its leader gone: the terminal still names it a
    /// moment after it ended, or members outlive the leader. Its start can't
    /// be checked, so it isn't signalled; it isn't another job either.
    Leaderless,
    /// No job: the shell is at its prompt.
    Nobody,
}

/// How a stop of a promoted command came out.
enum Stopping {
    Ended,
    Gone,
    Running,
}

/// The job holding the terminal of the shell `pid`, and when its leader
/// started.
fn job_on(pid: Option<u32>) -> Option<(i32, Option<u64>)> {
    let group = crate::talk_shell::foreground_group(pid?)?;
    Some((group, u32::try_from(group).ok().and_then(crate::talk_shell::process_started)))
}

/// Whether `job` (a group and its leader's start) is the one `record` was
/// promoted as. Without a recorded identity it never is. Pure.
fn judge(record: &ProcRecord, job: Option<(i32, Option<u64>)>) -> Holder {
    match (job, record.pgid, record.pgid_started) {
        (None, ..) => Holder::Nobody,
        (Some((group, Some(at))), Some(g), Some(was)) if group == g && at == was => Holder::Ours(group),
        (Some((group, None)), Some(g), Some(_)) if group == g => Holder::Leaderless,
        (Some(_), ..) => Holder::Other,
    }
}

/// Whether `pid` is still the process `record` started as: its group and
/// its start time.
fn same_process(record: &ProcRecord, pid: u32) -> bool {
    match (record.pgid, record.pgid_started) {
        (Some(g), Some(at)) => i32::try_from(pid).is_ok_and(|p| p == g) && crate::talk_shell::process_started(pid) == Some(at),
        _ => false,
    }
}

/// A started process, and what it printed at once.
pub struct Started {
    pub view: ProcView,
    pub output: String,
    pub cursor: u64,
}

/// What [`TalkProcs::promote`] records.
pub struct PromoteSpec {
    pub thread_id: String,
    pub workspace_id: String,
    pub command: String,
    pub posture: Posture,
    /// The conversation's posture as it is now: stricter, it is stopped at once.
    pub posture_now: PostureSource,
}

/// What a promoted command's stream calls besides the registry: the panel's
/// output and its end. `on_exit` answers whether the user stopped it.
pub struct LiveHooks {
    pub on_chunk: Box<dyn FnMut(&str) + Send>,
    pub on_exit: Box<dyn FnOnce(&crate::talk_shell::LiveExit) -> bool + Send>,
}

/// Told about every change to a conversation's processes: its workspace,
/// its id and its list.
pub type Notify = Arc<dyn Fn(&str, &str, Vec<ProcView>) + Send + Sync>;

/// Where the records and the launcher live: `None` keeps nothing on disk
/// and starts nothing.
#[derive(Clone, Debug, Default)]
struct ProcStore(Option<PathBuf>);

/// Whether `id` is made of letters, digits, `-` and `_` only, so it names
/// no other path in a file or a terminal id.
fn plain_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl ProcStore {
    fn file(&self, thread_id: &str) -> Option<PathBuf> {
        let dir = self.0.as_ref()?;
        plain_id(thread_id).then(|| dir.join(format!("{thread_id}.json")))
    }

    fn launcher(&self) -> Option<PathBuf> {
        self.0.as_ref().map(|d| d.join("launch"))
    }

    fn ensure_dir(&self) -> std::io::Result<()> {
        let Some(dir) = &self.0 else { return Ok(()) };
        std::fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    /// Keep `records` as the conversation's list; none removes its file.
    /// Best effort, as the shell's directory is (`talk_shell::CwdStore`).
    fn write(&self, thread_id: &str, records: &[ProcRecord]) -> bool {
        let Some(file) = self.file(thread_id) else { return false };
        if records.is_empty() {
            return std::fs::remove_file(&file).is_ok() || !file.exists();
        }
        let part = file.with_extension("json.part");
        let wrote = self.ensure_dir().is_ok()
            && serde_json::to_vec_pretty(records).ok().is_some_and(|bytes| std::fs::write(&part, bytes).is_ok());
        if !wrote || std::fs::rename(&part, &file).is_err() {
            tracing::warn!(thread_id, "could not keep the conversation's background processes");
            return false;
        }
        true
    }

    /// Every conversation's records. A file that can't be read, or a record
    /// filed under another conversation's name, is skipped.
    fn read_all(&self) -> Vec<ProcRecord> {
        let Some(dir) = &self.0 else { return Vec::new() };
        let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(thread) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".json")) else { continue };
            if !plain_id(thread) {
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else { continue };
            let Ok(records) = serde_json::from_slice::<Vec<ProcRecord>>(&bytes) else {
                tracing::warn!(?path, "a background-process record could not be read");
                continue;
            };
            out.extend(records.into_iter().filter(|r| r.thread_id == thread && r.id == format!("proc-{}", r.n)));
        }
        out
    }

    /// Write the launcher unless it is already there, a regular file with
    /// exactly [`LAUNCHER`] in it.
    fn ensure_launcher(&self) -> std::io::Result<PathBuf> {
        let path = self.launcher().ok_or_else(|| std::io::Error::other("no folder for the launcher"))?;
        let kept = std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_file())
            && std::fs::read(&path).is_ok_and(|b| b == LAUNCHER.as_bytes());
        if kept {
            return Ok(path);
        }
        self.ensure_dir()?;
        let part = path.with_extension("part");
        let _ = std::fs::remove_file(&part);
        std::fs::write(&part, LAUNCHER)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o700))?;
        }
        std::fs::rename(&part, &path)?;
        Ok(path)
    }
}

/// The conversation's background processes (#1160). See the module's notes.
pub struct TalkProcs {
    client: Mutex<Option<Arc<DaemonClient>>>,
    store: Mutex<ProcStore>,
    state: Mutex<State>,
    notify: Mutex<Option<Notify>>,
    /// Held while the records load, once.
    loaded: Mutex<bool>,
    /// Held across a snapshot and its write, so the last write is the latest.
    persisting: Mutex<()>,
    /// Held across a start's spawn and registration, a promotion's
    /// registration, and every stop: a stop or a stricter mode's
    /// enforcement waits for a start in flight, then sees it (#1160).
    gate: Mutex<()>,
}

impl Default for TalkProcs {
    fn default() -> Self {
        Self::new()
    }
}

impl TalkProcs {
    pub fn new() -> Self {
        Self {
            client: Mutex::new(None),
            store: Mutex::new(ProcStore::default()),
            state: Mutex::new(State::default()),
            notify: Mutex::new(None),
            loaded: Mutex::new(false),
            persisting: Mutex::new(()),
            gate: Mutex::new(()),
        }
    }

    pub fn set_client(&self, client: Option<Arc<DaemonClient>>) {
        *self.client.lock() = client;
    }

    /// Keep the records and the launcher in `dir` (`None`: nowhere, and
    /// nothing starts).
    pub fn set_store(&self, dir: Option<PathBuf>) {
        *self.store.lock() = ProcStore(dir);
    }

    /// Tell `notify` about every change; the first one set stays.
    pub fn set_notify(&self, notify: Notify) {
        let mut slot = self.notify.lock();
        if slot.is_none() {
            *slot = Some(notify);
        }
    }

    fn client(&self) -> Option<Arc<DaemonClient>> {
        self.client.lock().clone()
    }

    /// The records from before a restart, once: a background process still
    /// running in the daemon, as the process it started as, is attached
    /// again and its output replayed; one the daemon no longer has, or whose
    /// pid is now another process, is lost. A promoted one runs while the
    /// job it was promoted as (its group and start time) still holds its
    /// shell; another job there means it is lost, and nothing signals it.
    fn load(self: &Arc<Self>) {
        let mut loaded = self.loaded.lock();
        if *loaded {
            return;
        }
        *loaded = true;
        let records = self.store.lock().read_all();
        if records.is_empty() {
            return;
        }
        let client = self.client();
        let terminals = client.as_ref().and_then(|c| c.list_terminals().ok()).unwrap_or_default();
        let mut attach = Vec::new();
        let mut abandoned = Vec::new();
        let mut threads = std::collections::BTreeSet::new();
        {
            let mut st = self.state.lock();
            for mut record in records {
                threads.insert(record.thread_id.clone());
                // Never confirmed: Octopush quit between the record and the
                // start line. What it started, as the process it started as,
                // is stopped; without that, the record goes.
                if record.starting {
                    let term = terminals.iter().find(|t| t.id == record.term_id);
                    if term.is_some() {
                        abandoned.push(record.term_id.clone());
                    }
                    let started = term.filter(|t| t.running).and_then(|t| t.pid).is_some_and(|pid| same_process(&record, pid));
                    if !started {
                        continue;
                    }
                    record.starting = false;
                    record.ended_at = Some(now());
                    record.stopped = true;
                }
                if record.running() {
                    let term = terminals.iter().find(|t| t.id == record.term_id);
                    let running_pid = term.filter(|t| t.running).and_then(|t| t.pid);
                    let (alive, lost) = match record.kind {
                        ProcKind::Background => match running_pid {
                            Some(pid) if same_process(&record, pid) => (true, false),
                            Some(_) => (false, true),
                            None => (false, term.is_none()),
                        },
                        ProcKind::Promoted => match judge(&record, job_on(running_pid)) {
                            Holder::Ours(_) => (true, false),
                            Holder::Other => (false, true),
                            Holder::Nobody | Holder::Leaderless => (false, false),
                        },
                    };
                    if !alive {
                        record.ended_at = Some(now());
                        record.lost = lost;
                    } else if record.kind == ProcKind::Background {
                        attach.push((record.thread_id.clone(), record.id.clone(), record.term_id.clone()));
                    }
                }
                let list = st.threads.entry(record.thread_id.clone()).or_default();
                if list.iter().all(|e| e.record.id != record.id) {
                    list.push(Entry { record, out: OutputRing::new(RING_BYTES), restored: true });
                }
            }
            for list in st.threads.values_mut() {
                list.sort_by_key(|e| e.record.n);
            }
        }
        drop(loaded);
        if let Some(client) = client {
            // The daemon kills its own child and drops the terminal.
            for term in abandoned {
                let _ = client.remove(&term);
            }
            for (thread, id, term) in attach {
                match client.attach(&term, 0) {
                    Ok(rx) => self.spawn_reader(thread, id, rx),
                    Err(e) => {
                        tracing::warn!(error = %e, term = %term, "could not attach to a background process again");
                        self.finish(&thread, &id, None, false);
                    }
                }
            }
        }
        for thread in threads {
            self.persist(&thread);
        }
    }

    /// The conversation's processes, oldest first.
    pub fn list(self: &Arc<Self>, thread_id: &str) -> Vec<ProcView> {
        self.load();
        self.refresh_restored(thread_id);
        self.views(thread_id)
    }

    fn views(&self, thread_id: &str) -> Vec<ProcView> {
        self.state.lock().threads.get(thread_id).map(|l| l.iter().map(|e| e.record.view()).collect()).unwrap_or_default()
    }

    fn record(&self, thread_id: &str, id: &str) -> Option<ProcRecord> {
        self.state.lock().threads.get(thread_id)?.iter().find(|e| e.record.id == id).map(|e| e.record.clone())
    }

    fn is_restored(&self, record: &ProcRecord) -> bool {
        let st = self.state.lock();
        st.threads.get(&record.thread_id).and_then(|l| l.iter().find(|e| e.record.id == record.id)).is_some_and(|e| e.restored)
    }

    /// A promoted process restored after a restart has no stream: it ended
    /// once no job holds its shell, and is lost once another job does.
    fn refresh_restored(self: &Arc<Self>, thread_id: &str) {
        let restored: Vec<ProcRecord> = {
            let st = self.state.lock();
            let Some(list) = st.threads.get(thread_id) else { return };
            list.iter().filter(|e| e.restored && e.record.running() && e.record.kind == ProcKind::Promoted).map(|e| e.record.clone()).collect()
        };
        for record in restored {
            match self.holder(&record) {
                Holder::Ours(_) => {}
                Holder::Other => self.mark_lost(thread_id, &record.id),
                Holder::Nobody | Holder::Leaderless => self.finish(thread_id, &record.id, None, false),
            }
        }
    }

    /// The pid of the daemon terminal `term_id`, while it runs.
    fn terminal_pid(&self, term_id: &str) -> Option<u32> {
        self.client()?.list_terminals().ok()?.into_iter().find(|t| t.id == term_id && t.running)?.pid
    }

    /// What holds a promoted record's shell now, against the job it was
    /// promoted as.
    fn holder(&self, record: &ProcRecord) -> Holder {
        judge(record, job_on(self.terminal_pid(&record.term_id)))
    }

    /// A background process's group, while its terminal runs and its pid is
    /// still the process it started as.
    fn background_group(&self, record: &ProcRecord) -> Option<i32> {
        let pid = self.terminal_pid(&record.term_id)?;
        same_process(record, pid).then(|| i32::try_from(pid).ok()).flatten()
    }

    /// Keep the conversation's records on disk and tell the panel.
    fn persist(&self, thread_id: &str) -> bool {
        let kept = {
            let _order = self.persisting.lock();
            let records: Vec<ProcRecord> =
                self.state.lock().threads.get(thread_id).map(|l| l.iter().map(|e| e.record.clone()).collect()).unwrap_or_default();
            self.store.lock().clone().write(thread_id, &records)
        };
        self.tell(thread_id, None);
        kept
    }

    /// Change `id`'s record with `change`, and keep it.
    fn update(&self, thread_id: &str, id: &str, change: impl FnOnce(&mut ProcRecord)) -> bool {
        if let Some(e) = self.state.lock().threads.get_mut(thread_id).and_then(|l| l.iter_mut().find(|e| e.record.id == id)) {
            change(&mut e.record);
        }
        self.persist(thread_id)
    }

    /// Forget `id`'s record, on disk too: its start was abandoned.
    fn forget(&self, thread_id: &str, id: &str) {
        if let Some(list) = self.state.lock().threads.get_mut(thread_id) {
            list.retain(|e| e.record.id != id);
        }
        self.persist(thread_id);
    }

    fn tell(&self, thread_id: &str, workspace: Option<&str>) {
        let Some(notify) = self.notify.lock().clone() else { return };
        let (workspace_id, views) = {
            let st = self.state.lock();
            let list = st.threads.get(thread_id);
            let ws = workspace.map(str::to_string).or_else(|| list.and_then(|l| l.first()).map(|e| e.record.workspace_id.clone()));
            (ws, list.map(|l| l.iter().map(|e| e.record.view()).collect()).unwrap_or_default())
        };
        if let Some(ws) = workspace_id {
            notify(&ws, thread_id, views);
        }
    }

    fn append(&self, thread_id: &str, id: &str, bytes: &[u8]) {
        let mut st = self.state.lock();
        if let Some(e) = st.threads.get_mut(thread_id).and_then(|l| l.iter_mut().find(|e| e.record.id == id)) {
            e.out.push(bytes);
        }
    }

    /// Record that a process ended (`code` when known; `stopped` when it was
    /// stopped), once; a stop after it ended still marks it stopped.
    fn finish(&self, thread_id: &str, id: &str, code: Option<i32>, stopped: bool) {
        let changed = {
            let mut st = self.state.lock();
            match st.threads.get_mut(thread_id).and_then(|l| l.iter_mut().find(|e| e.record.id == id)) {
                Some(e) => {
                    let before = e.record.clone();
                    if e.record.ended_at.is_none() {
                        e.record.ended_at = Some(now());
                        e.record.exit_code = code;
                    }
                    e.record.stopped |= stopped;
                    e.record != before
                }
                None => false,
            }
        };
        if changed {
            self.persist(thread_id);
        }
    }

    /// Record that a process is gone without a trace Octopush can follow:
    /// its pid or its shell now hold another process, which nothing signals.
    fn mark_lost(&self, thread_id: &str, id: &str) {
        let changed = {
            let mut st = self.state.lock();
            match st.threads.get_mut(thread_id).and_then(|l| l.iter_mut().find(|e| e.record.id == id)) {
                Some(e) if e.record.running() => {
                    e.record.ended_at = Some(now());
                    e.record.lost = true;
                    true
                }
                _ => false,
            }
        };
        if changed {
            self.persist(thread_id);
        }
    }

    fn spawn_reader(self: &Arc<Self>, thread_id: String, id: String, rx: Receiver<TermEvent>) {
        let this = Arc::clone(self);
        let spawned = std::thread::Builder::new().name(format!("talk-proc-{id}")).spawn(move || {
            loop {
                match rx.recv() {
                    Ok(TermEvent::Data { bytes, .. }) => this.append(&thread_id, &id, &bytes),
                    Ok(TermEvent::Exit { code }) => {
                        this.finish(&thread_id, &id, code, false);
                        return;
                    }
                    Ok(_) => {}
                    // The subscription ended: stopped, removed, or the
                    // daemon went away. Ask the daemon which.
                    Err(_) => break,
                }
            }
            if let Some(record) = this.record(&thread_id, &id).filter(ProcRecord::running) {
                let running = this
                    .client()
                    .and_then(|c| c.list_terminals().ok())
                    .is_some_and(|ts| ts.iter().any(|t| t.id == record.term_id && t.running));
                if !running {
                    this.finish(&thread_id, &id, None, false);
                }
            }
        });
        if let Err(e) = spawned {
            tracing::warn!(error = %e, "could not read a background process's output");
        }
    }

    /// Start `spec`'s command in its own terminal, at once. `Err` says why
    /// it didn't start, for the model.
    ///
    /// The gate is held from the spawn to the registration, so a stop or a
    /// stricter mode's enforcement waits for a start in flight and then sees
    /// it. The launcher runs nothing until it gets its line, which comes
    /// only once the conversation's posture is read again and its turn's
    /// Stop checked: a switch to a stricter mode, or a Stop, while it was
    /// spawned kills it before the command runs.
    pub fn start(self: &Arc<Self>, spec: StartSpec) -> Result<Started, String> {
        self.load();
        let client = self.client().ok_or_else(|| NO_DAEMON.to_string())?;
        if spec.command.trim().is_empty() {
            return Err("Not started: the command is empty.".to_string());
        }
        if !plain_id(&spec.thread_id) {
            return Err("Not started: this conversation's id can't name a terminal.".to_string());
        }
        let (argv, sandbox_env) = argv_for(&spec)?;
        let launcher = self.store.lock().clone().ensure_launcher().map_err(|e| format!("Not started: the launcher couldn't be written ({e})."))?;
        let launcher = launcher.to_string_lossy().into_owned();
        let mut env = launch_env(&spec.env, &argv, sandbox_env);
        // A mission that ships nothing starts it behind the process barrier
        // (#1275), as its foreground commands, fail-closed.
        if spec.posture.ships_nothing {
            let barrier = crate::ship_barrier::Barrier::for_workspace(std::path::Path::new(&spec.workspace_path))
                .map_err(|e| crate::ship_barrier::unavailable(&e))?;
            barrier.daemon_env(&mut env);
        }

        let gate = self.gate.lock();
        let taken: Vec<String> = client.list_terminals().map(|ts| ts.into_iter().filter(|t| t.running).map(|t| t.id).collect()).unwrap_or_default();
        let record = {
            let mut st = self.state.lock();
            let list = st.threads.entry(spec.thread_id.clone()).or_default();
            let running: Vec<String> = list.iter().filter(|e| e.record.running()).map(|e| e.record.id.clone()).collect();
            if running.len() >= MAX_RUNNING {
                return Err(format!(
                    "Not started: this conversation already runs {MAX_RUNNING} background processes ({}). Stop one you no longer need with stop, then start this one.",
                    running.join(", ")
                ));
            }
            let mut n = list.iter().map(|e| e.record.n).max().unwrap_or(0) + 1;
            while taken.contains(&term_id(&spec.thread_id, n)) {
                n += 1;
            }
            let record = ProcRecord {
                id: format!("proc-{n}"),
                n,
                term_id: term_id(&spec.thread_id, n),
                thread_id: spec.thread_id.clone(),
                workspace_id: spec.workspace_id.clone(),
                kind: ProcKind::Background,
                command: spec.command.clone(),
                cwd: spec.cwd.clone(),
                started_at: now(),
                mode: spec.posture.mode.as_str().to_string(),
                ships_nothing: spec.posture.ships_nothing,
                sandboxed: spec.posture.sandboxed,
                ended_at: None,
                exit_code: None,
                stopped: false,
                lost: false,
                pgid: None,
                pgid_started: None,
                starting: true,
            };
            list.push(Entry { record: record.clone(), out: OutputRing::new(RING_BYTES), restored: false });
            record
        };
        let (thread, id) = (record.thread_id.as_str(), record.id.as_str());
        // On disk before the spawn: a quit or a crash from here on leaves a
        // record that names what it started.
        if !self.persist(thread) {
            self.forget(thread, id);
            return Err("Not started: its record couldn't be kept on disk, so it couldn't be stopped after a restart.".to_string());
        }
        let pid = match client.spawn(&record.term_id, &spec.cwd, &env, Some(&launcher), 40, 120) {
            Ok(pid) => pid,
            Err(e) => {
                self.forget(thread, id);
                return Err(format!("Not started: {e}"));
            }
        };
        let abandon = |why: String| {
            let _ = client.remove(&record.term_id);
            self.forget(thread, id);
            Err(why)
        };
        // Its group is its own (the daemon makes it a session leader); with
        // its start time, a pid used again later never matches it.
        let (pgid, pgid_started) = (i32::try_from(pid).ok(), crate::talk_shell::process_started(pid));
        self.update(thread, id, |r| {
            r.pgid = pgid;
            r.pgid_started = pgid_started;
        });
        let rx = match client.attach(&record.term_id, 0) {
            Ok(rx) => rx,
            Err(e) => return abandon(format!("Not started: {e}")),
        };
        if spec.cancel.as_ref().is_some_and(|c| c.load(std::sync::atomic::Ordering::Relaxed)) {
            return abandon(STOPPED_WHILE_STARTING.to_string());
        }
        let posture = (spec.posture_now)();
        if posture.stricter_than(&spec.posture) {
            return abandon(changed_while_starting(posture));
        }
        self.spawn_reader(record.thread_id.clone(), record.id.clone(), rx);
        // Recorded, attached and checked: the launcher may run the command.
        if let Err(e) = client.write(&record.term_id, b"\n") {
            return abandon(format!("Not started: its start line couldn't be sent ({e})."));
        }
        self.update(thread, id, |r| r.starting = false);
        drop(gate);
        self.prune(thread);

        // What it prints at once, or that it ended at once.
        let deadline = Instant::now() + START_PEEK;
        while Instant::now() < deadline && self.record(&record.thread_id, &record.id).is_some_and(|r| r.running()) {
            std::thread::sleep(Duration::from_millis(50));
        }
        let st = self.state.lock();
        let e = st.threads.get(thread).and_then(|l| l.iter().find(|e| e.record.id == id));
        let (view, output, cursor) = match e {
            Some(e) => (e.record.view(), clean(&e.out.since(0).0), e.out.total),
            None => (record.view(), String::new(), 0),
        };
        Ok(Started { view, output, cursor })
    }

    /// Track a promoted command, streaming it on a thread of its own until
    /// it ends. The job that holds the shell now, its group and its start
    /// time, is what a stop after a restart may signal, and nothing else.
    /// Registered under the gate, and stopped at once when the
    /// conversation's posture grew stricter than the one it ran under.
    pub fn promote(self: &Arc<Self>, spec: PromoteSpec, live: crate::talk_shell::LiveRun, hooks: LiveHooks) -> ProcView {
        self.load();
        let gate = self.gate.lock();
        let term = format!("talk-{}", spec.thread_id);
        let job = job_on(self.terminal_pid(&term));
        let record = {
            let mut st = self.state.lock();
            let list = st.threads.entry(spec.thread_id.clone()).or_default();
            let n = list.iter().map(|e| e.record.n).max().unwrap_or(0) + 1;
            let record = ProcRecord {
                id: format!("proc-{n}"),
                n,
                term_id: term,
                thread_id: spec.thread_id.clone(),
                workspace_id: spec.workspace_id.clone(),
                kind: ProcKind::Promoted,
                command: spec.command.clone(),
                cwd: live.cwd().to_string(),
                started_at: now(),
                mode: spec.posture.mode.as_str().to_string(),
                ships_nothing: spec.posture.ships_nothing,
                sandboxed: spec.posture.sandboxed,
                ended_at: None,
                exit_code: None,
                stopped: false,
                lost: false,
                pgid: job.map(|(group, _)| group),
                pgid_started: job.and_then(|(_, started)| started),
                starting: false,
            };
            list.push(Entry { record: record.clone(), out: OutputRing::new(RING_BYTES), restored: false });
            record
        };
        let this = Arc::clone(self);
        let (thread, id) = (record.thread_id.clone(), record.id.clone());
        let LiveHooks { mut on_chunk, on_exit } = hooks;
        let spawned = std::thread::Builder::new().name(format!("talk-promoted-{id}")).spawn(move || {
            // Ended here, under the registry's lock, before the shell takes
            // another command: a stop never signals what comes after it.
            let exit = live.stream_ending(
                |chunk| {
                    this.append(&thread, &id, chunk.as_bytes());
                    on_chunk(chunk);
                },
                |code| this.finish(&thread, &id, Some(code), false),
            );
            if on_exit(&exit) {
                this.finish(&thread, &id, None, true);
            }
        });
        if let Err(e) = spawned {
            tracing::warn!(error = %e, "could not stream a promoted command");
        }
        if (spec.posture_now)().stricter_than(&spec.posture) {
            let _ = self.stop_locked(&record.thread_id, &record.id);
        }
        drop(gate);
        self.prune(&record.thread_id);
        self.persist(&record.thread_id);
        self.record(&record.thread_id, &record.id).unwrap_or(record).view()
    }

    /// The output of `id` from `since` on, for the model. `Err` when the
    /// conversation has no such process.
    pub fn read(self: &Arc<Self>, thread_id: &str, id: &str, since: Option<u64>) -> Result<String, String> {
        self.load();
        self.refresh_restored(thread_id);
        let st = self.state.lock();
        let list = st.threads.get(thread_id).map(Vec::as_slice).unwrap_or_default();
        let Some(e) = list.iter().find(|e| e.record.id == id) else {
            return Err(unknown(id, list));
        };
        Ok(read_view(&e.record, &e.out, since, e.restored))
    }

    /// What `id` printed, cleaned, head and tail within [`READ_MAX_BYTES`]:
    /// for a command stopped at its timeout.
    pub fn output(&self, thread_id: &str, id: &str) -> String {
        let st = self.state.lock();
        let Some(e) = st.threads.get(thread_id).and_then(|l| l.iter().find(|e| e.record.id == id)) else { return String::new() };
        let text = clean(&e.out.since(0).0);
        if text.len() > READ_MAX_BYTES {
            crate::chat_history::command_excerpt(&text, READ_MAX_BYTES, true, "")
        } else {
            text
        }
    }

    /// Stop `id` and its process group. Blocking: it waits a moment for the
    /// process to end, and for a start in flight to register.
    pub fn stop(self: &Arc<Self>, thread_id: &str, id: &str) -> Result<ProcView, String> {
        self.load();
        let _gate = self.gate.lock();
        self.stop_locked(thread_id, id)
    }

    /// [`Self::stop`], the gate held.
    fn stop_locked(self: &Arc<Self>, thread_id: &str, id: &str) -> Result<ProcView, String> {
        let record = match self.record(thread_id, id) {
            Some(r) => r,
            None => {
                let st = self.state.lock();
                return Err(unknown(id, st.threads.get(thread_id).map(Vec::as_slice).unwrap_or_default()));
            }
        };
        if record.running() {
            match record.kind {
                ProcKind::Background => {
                    self.stop_background(&record);
                    self.finish(thread_id, id, None, true);
                }
                ProcKind::Promoted => match self.stop_promoted(&record) {
                    Stopping::Ended => self.finish(thread_id, id, None, true),
                    Stopping::Gone => self.mark_lost(thread_id, id),
                    Stopping::Running => {}
                },
            }
        }
        Ok(self.record(thread_id, id).unwrap_or(record).view())
    }

    fn wait_ended(&self, record: &ProcRecord, within: Duration, alive: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + within;
        loop {
            let ended = !self.record(&record.thread_id, &record.id).is_some_and(|r| r.running()) || !alive();
            if ended || Instant::now() >= deadline {
                return ended;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// TERM to its group (and to a job holding its terminal, which is in
    /// its session: `set -m`), a moment to end, KILL to that job, then
    /// `remove`, which kills its group and drops the terminal and its
    /// scrollback. Only while its pid is still the process it started as;
    /// otherwise nothing is signalled and only the daemon's own record of
    /// the terminal goes.
    fn stop_background(&self, record: &ProcRecord) {
        let Some(client) = self.client() else { return };
        if let Some(group) = self.background_group(record) {
            let job = u32::try_from(group).ok().and_then(crate::talk_shell::foreground_group);
            signal_group(group, libc::SIGTERM);
            if let Some(job) = job {
                signal_group(job, libc::SIGTERM);
            }
            let running = || client.list_terminals().is_ok_and(|ts| ts.iter().any(|t| t.id == record.term_id && t.running));
            if !self.wait_ended(record, STOP_GRACE, running) {
                if let Some(job) = self.background_group(record).and_then(|g| u32::try_from(g).ok()).and_then(crate::talk_shell::foreground_group) {
                    signal_group(job, libc::SIGKILL);
                }
            }
        }
        let _ = client.remove(&record.term_id);
    }

    /// SIGINT to the job holding the shared shell, as the panel's Ctrl-C
    /// sends; then TERM and KILL if it is still there. The shell stays.
    ///
    /// While its stream runs, what holds the shell is this command: the
    /// stream marks it ended under the registry's lock before the shell
    /// takes another, and each signal is sent under that lock. One
    /// restored after a restart has no stream: it is signalled only while
    /// the job holding the shell is the group it was promoted as, with the
    /// same start time; another job there means it is gone, and nothing is
    /// signalled.
    fn stop_promoted(&self, record: &ProcRecord) -> Stopping {
        let restored = self.is_restored(record);
        for sig in [libc::SIGINT, libc::SIGTERM, libc::SIGKILL] {
            {
                let st = self.state.lock();
                let running = st.threads.get(&record.thread_id).and_then(|l| l.iter().find(|e| e.record.id == record.id)).is_some_and(|e| e.record.running());
                if !running {
                    return Stopping::Ended;
                }
                let job = job_on(self.terminal_pid(&record.term_id));
                let target = match (restored, judge(record, job)) {
                    (true, Holder::Ours(group)) => Some(group),
                    (true, Holder::Other) => return Stopping::Gone,
                    (true, Holder::Nobody | Holder::Leaderless) => return Stopping::Ended,
                    (false, _) => job.map(|(group, _)| group),
                };
                if let Some(group) = target {
                    signal_group(group, sig);
                }
                drop(st);
            }
            let alive = || !restored || matches!(self.holder(record), Holder::Ours(_));
            if self.wait_ended(record, STOP_GRACE, alive) {
                return match restored {
                    true if matches!(self.holder(record), Holder::Other) => Stopping::Gone,
                    _ => Stopping::Ended,
                };
            }
        }
        Stopping::Running
    }

    /// Stop the conversation's processes that started under a looser
    /// posture than `now` (#1160). Blocking, and after any start in flight
    /// registered. Returns their ids.
    pub fn enforce(self: &Arc<Self>, thread_id: &str, now: Posture) -> Vec<String> {
        self.load();
        let _gate = self.gate.lock();
        let outgrown: Vec<String> = {
            let st = self.state.lock();
            st.threads
                .get(thread_id)
                .map(|l| l.iter().filter(|e| e.record.running() && now.stricter_than(&e.record.posture())).map(|e| e.record.id.clone()).collect())
                .unwrap_or_default()
        };
        for id in &outgrown {
            let _ = self.stop_locked(thread_id, id);
        }
        outgrown
    }

    /// The conversation is gone: stop its processes and forget them.
    pub fn close_thread(self: &Arc<Self>, thread_id: &str) {
        self.load();
        let _gate = self.gate.lock();
        let records: Vec<ProcRecord> =
            self.state.lock().threads.get(thread_id).map(|l| l.iter().map(|e| e.record.clone()).collect()).unwrap_or_default();
        for record in &records {
            if record.running() {
                let _ = self.stop_locked(thread_id, &record.id);
            } else if record.kind == ProcKind::Background {
                if let Some(client) = self.client() {
                    let _ = client.remove(&record.term_id);
                }
            }
        }
        let workspace = records.first().map(|r| r.workspace_id.clone());
        self.state.lock().threads.remove(thread_id);
        {
            let _order = self.persisting.lock();
            self.store.lock().clone().write(thread_id, &[]);
        }
        self.tell(thread_id, workspace.as_deref());
    }

    /// Keep at most [`MAX_KEPT`] processes: drop the oldest ended ones, and
    /// their terminals' scrollback.
    fn prune(&self, thread_id: &str) {
        let dropped: Vec<ProcRecord> = {
            let mut st = self.state.lock();
            let Some(list) = st.threads.get_mut(thread_id) else { return };
            let mut over = list.len().saturating_sub(MAX_KEPT);
            let mut dropped = Vec::new();
            list.retain(|e| {
                if over > 0 && !e.record.running() {
                    over -= 1;
                    dropped.push(e.record.clone());
                    return false;
                }
                true
            });
            dropped
        };
        if let Some(client) = self.client() {
            for record in dropped.iter().filter(|r| r.kind == ProcKind::Background) {
                let _ = client.remove(&record.term_id);
            }
        }
    }

    #[cfg(test)]
    fn insert_for_test(&self, record: ProcRecord, output: &[u8]) {
        let mut out = OutputRing::new(RING_BYTES);
        out.push(output);
        *self.loaded.lock() = true;
        self.state.lock().threads.entry(record.thread_id.clone()).or_default().push(Entry { record, out, restored: false });
    }
}

fn term_id(thread_id: &str, n: u64) -> String {
    format!("talkproc-{thread_id}-{n}")
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Signal process group `group` (never 0 or 1, which mean ours and every one).
fn signal_group(group: i32, sig: libc::c_int) -> bool {
    if group <= 1 {
        return false;
    }
    // SAFETY: kill(2) with a negative pid signals that process group; it
    // touches no memory of ours.
    unsafe { libc::kill(-group, sig) == 0 }
}

/// What the launcher runs: its argv, and the sandbox's variables.
type Launch = (Vec<String>, Vec<(String, String)>);

/// The argv the launcher runs, and the sandbox's variables: `/bin/bash -c`,
/// under the mission's seatbelt profile when it is sandboxed. Fails closed.
fn argv_for(spec: &StartSpec) -> Result<Launch, String> {
    let shell = crate::talk_shell::TALK_BASH;
    let args = ["-c".to_string(), spec.command.clone()];
    match spec.sandbox_roots.as_deref() {
        Some([]) => Err(crate::permissions::plan_refusal(crate::permissions::Refused::Background, false)),
        Some(roots) => {
            let prepared = crate::orchestrator::sandbox::prepare(roots, Some(&spec.workspace_path), std::ffi::OsStr::new(shell), &args)
                .map_err(|e| format!("Sandbox unavailable — refusing to start the command unconfined: {e}"))?;
            let mut argv = vec![prepared.program.to_string_lossy().into_owned()];
            argv.extend(prepared.args.iter().map(|a| a.to_string_lossy().into_owned()));
            Ok((argv, prepared.env))
        }
        None => Ok((std::iter::once(shell.to_string()).chain(args).collect(), Vec::new())),
    }
}

/// A background command's spawn env: `extra` (never PATH or the launcher's
/// own variables), git's hardening, the sandbox's variables, the login PATH
/// last, and the argv for the launcher. Pure but for the PATH and git reads.
fn launch_env(extra: &[(String, String)], argv: &[String], sandbox: Vec<(String, String)>) -> HashMap<String, String> {
    let mut env: HashMap<String, String> =
        extra.iter().filter(|(k, _)| k != "PATH" && k != ARGC_ENV && k != WAIT_ENV && !k.starts_with(ARG_ENV)).cloned().collect();
    env.insert(WAIT_ENV.to_string(), START_WAIT_SECS.to_string());
    env.extend(crate::talk_shell::git_hardening_env());
    env.extend(sandbox);
    env.insert("PATH".to_string(), crate::orchestrator::cli_runner::resolved_cli_path());
    env.insert(ARGC_ENV.to_string(), argv.len().to_string());
    for (i, arg) in argv.iter().enumerate() {
        env.insert(format!("{ARG_ENV}{i}"), arg.clone());
    }
    env
}

/// Output as the model reads it: colours and carriage returns gone.
fn clean(bytes: &[u8]) -> String {
    crate::talk_shell::clean_output(&String::from_utf8_lossy(bytes))
}

/// The conversation has no process `id`: say which it has.
fn unknown(id: &str, list: &[Entry]) -> String {
    if list.is_empty() {
        return format!("No background process `{id}` in this conversation: it has none.");
    }
    let ids: Vec<String> = list.iter().map(|e| format!("{} ({})", e.record.id, e.record.status())).collect();
    format!("No background process `{id}` in this conversation. It has: {}.", ids.join(", "))
}

/// `read_output`'s result: the process's state, its output from `since` on
/// (cleaned, head and tail within [`READ_MAX_BYTES`]) and the next cursor. Pure.
fn read_view(record: &ProcRecord, out: &OutputRing, since: Option<u64>, restored: bool) -> String {
    let asked = since.unwrap_or(0);
    let reset = asked > out.total;
    let (bytes, dropped) = out.since(if reset { 0 } else { asked });
    let text = clean(&bytes);
    let text = if text.len() > READ_MAX_BYTES { crate::chat_history::command_excerpt(&text, READ_MAX_BYTES, false, "") } else { text };
    let mut lines = vec![format!("{} \u{b7} {} \u{b7} {}", record.id, record.status(), record.command)];
    if reset {
        lines.push(
            "(your cursor is past this process's output: Octopush restarted since, and the output was read again \
             from the terminal's scrollback; this is all of it that is kept)"
                .to_string(),
        );
    } else if dropped > 0 {
        lines.push(format!("({dropped} bytes after your cursor are no longer kept: a process keeps its last {} KB)", RING_BYTES / 1024));
    }
    if restored && record.kind == ProcKind::Promoted {
        lines.push("(this command was running in the conversation's shell before Octopush restarted; its output from before then isn't kept)".to_string());
    }
    lines.push(if text.is_empty() { "(no new output)".to_string() } else { text });
    lines.push(format!("(cursor {}: pass \"since\": {} to read only what comes after)", out.total, out.total));
    lines.join("\n")
}

/// `run_command { keep_running: true }`'s result. Pure.
pub fn started_result(started: &Started, cwd_label: &str) -> (String, bool) {
    let v = &started.view;
    let at = if cwd_label.is_empty() { "the workspace root".to_string() } else { cwd_label.to_string() };
    let mut out = if v.running {
        format!(
            "Started in the background as {id}, in {at}. It keeps running after this turn, and the user sees it \
             in the conversation's live process panel. Read what it prints with read_output {{\"id\": \"{id}\"}}; \
             stop it with stop {{\"id\": \"{id}\"}} once you no longer need it.",
            id = v.id
        )
    } else {
        format!("{} ended at once ({}).", v.id, if v.stopped { "stopped".to_string() } else { v.exit_code.map_or("ended".to_string(), |c| format!("exit code {c}")) })
    };
    let output = if started.output.len() > READ_MAX_BYTES {
        crate::chat_history::command_excerpt(&started.output, READ_MAX_BYTES, !v.running, "")
    } else {
        started.output.clone()
    };
    if !output.is_empty() {
        out.push_str("\nOutput so far:\n");
        out.push_str(&output);
    }
    if v.running {
        out.push_str(&format!("\n(cursor {}: pass \"since\": {} to read_output to read only what comes after)", started.cursor, started.cursor));
    }
    let ok = v.running || v.exit_code == Some(0);
    (out, ok)
}

/// A promoted command's result: it is still running, moved to the panel. Pure.
pub fn promoted_result(view: &ProcView, timeout_secs: u64, partial: &str) -> String {
    let mut out = format!(
        "Still running after {timeout_secs}s, so it was moved to the conversation's live process panel instead of \
         being stopped: it is {id}. Read what it prints with read_output {{\"id\": \"{id}\"}}; stop it with \
         stop {{\"id\": \"{id}\"}} once you no longer need it. While it runs, your other commands run in an isolated \
         shell at the workspace root.",
        id = view.id
    );
    let partial = crate::talk_shell::clean_output(partial);
    let partial = if partial.len() > READ_MAX_BYTES { crate::chat_history::command_excerpt(&partial, READ_MAX_BYTES, false, "") } else { partial };
    if !partial.is_empty() {
        out.push_str("\nOutput so far:\n");
        out.push_str(&partial);
    }
    out
}

/// The `run_command` input a foreground command still running at its
/// timeout is judged as (#1160): the same command, kept running, so it
/// keeps running only on a background start's terms. Pure.
pub fn kept_running(command: &str) -> serde_json::Value {
    serde_json::json!({ "command": command, "keep_running": true })
}

/// Ask first's card for a command still running at its timeout: the
/// background start's card, saying why it asks now. Pure.
pub fn promotion_card(card: crate::talk_guard::ToolCard, timeout_secs: u64) -> crate::talk_guard::ToolCard {
    let reason = format!("is still running after {timeout_secs}s and would keep running in the background (Ask first)");
    crate::talk_guard::ToolCard { reason, ..card }
}

/// Why a command still running at its timeout was stopped when the user
/// declined Ask first's card.
pub const KEEP_DECLINED: &str = "the user declined to keep it running in the background (the conversation is in Ask first mode)";

/// A command stopped at its timeout instead of kept running: what it
/// printed, then why. Pure.
pub fn stopped_at_timeout(output: &str, timeout_secs: u64, why: &str) -> String {
    let note = format!("(command was still running after {timeout_secs}s and was stopped, not kept running in the background: {why})");
    match output.is_empty() {
        true => note,
        false => format!("{output}\n{note}"),
    }
}

/// `stop`'s result. Pure.
pub fn stopped_result(view: &ProcView) -> String {
    if view.running {
        format!("{} is still running: it didn't end after SIGINT, SIGTERM and SIGKILL to its process group.", view.id)
    } else if view.stopped {
        format!("Stopped {} ({}).", view.id, view.command)
    } else {
        let how = if view.lost {
            "Octopush lost track of it (after a restart, or its shell now holds another command), so nothing was signalled".to_string()
        } else {
            view.exit_code.map_or("it had ended".to_string(), |c| format!("it had exited {c}"))
        };
        format!("{} was no longer running: {how}.", view.id)
    }
}

/// `run_command`'s definition for Talk's director, with `keep_running`
/// (#1160); sub-agents and Direct stages keep the shared one, which waits.
fn director_run_command() -> crate::providers::LlmTool {
    crate::providers::LlmTool {
        name: "run_command".to_string(),
        description: format!(
            "Run a shell command in the workspace directory, with bash, in the shell you share with the user. Use this for \
             git, tests, installs or any shell task. A command still running at its timeout (timeout_secs, default 600, \
             max 3600) is moved to the conversation's live process panel instead of being stopped, and the result gives \
             its process id. To start a dev server, a watcher or anything else that doesn't exit, pass keep_running: true: \
             it starts at once as a background process (its own shell, from the shared shell's directory, with the \
             workspace's OCTOPUSH_PORT) and the result gives its id. Read what a process prints with read_output and \
             end it with stop. Stop every process you started once you no longer need it, before you finish. A \
             background start meets the same checks and approvals as any command; Plan only starts none, and a \
             conversation runs at most {MAX_RUNNING} at once."
        ),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The shell command to execute"
                },
                "timeout_secs": {
                    "type": "integer",
                    "description": "Optional seconds to wait for the command (default 600, max 3600). One still running then keeps running in the live process panel. Not used with keep_running."
                },
                "keep_running": {
                    "type": "boolean",
                    "description": "Start the command as a background process and return at once with its id, for a dev server, a watcher or another command that doesn't exit. Stop it with stop when you are done."
                }
            },
            "required": ["command"]
        }),
    }
}

fn read_output_tool() -> crate::providers::LlmTool {
    crate::providers::LlmTool {
        name: READ_OUTPUT_TOOL.to_string(),
        description: format!(
            "Read what a background process of this conversation printed: one run_command started with keep_running, or \
             a command moved to the live process panel at its timeout. Pass since, the cursor the last read returned, to \
             get only what is new. The output has its terminal colours removed and is capped like a command's; a process \
             keeps its last {} KB.",
            RING_BYTES / 1024
        ),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "The process id run_command returned, such as proc-1" },
                "since": { "type": "integer", "description": "Optional cursor from the last read_output: only output after it" }
            },
            "required": ["id"]
        }),
    }
}

fn stop_tool() -> crate::providers::LlmTool {
    crate::providers::LlmTool {
        name: STOP_TOOL.to_string(),
        description: "Stop a background process this conversation started, with its whole process group, by the id \
             run_command returned. Stop what you started once you no longer need it."
            .to_string(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "The process id run_command returned, such as proc-1" }
            },
            "required": ["id"]
        }),
    }
}

/// Give Talk's director its `run_command` with `keep_running` in place of
/// the shared one. The tool list keeps its order.
pub fn director_command_tool(tools: &mut [crate::providers::LlmTool]) {
    if let Some(t) = tools.iter_mut().find(|t| t.name == "run_command") {
        *t = director_run_command();
    }
}

/// The tools that read and stop background processes, offered after the
/// skill filter, as recall is: they read or end what the conversation
/// started, and widen nothing a skill allows.
pub fn proc_tools() -> Vec<crate::providers::LlmTool> {
    vec![read_output_tool(), stop_tool()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(n: u64, kind: ProcKind) -> ProcRecord {
        ProcRecord {
            id: format!("proc-{n}"),
            n,
            term_id: term_id("t-1", n),
            thread_id: "t-1".into(),
            workspace_id: "w-1".into(),
            kind,
            command: "npm run dev".into(),
            cwd: "/tmp".into(),
            started_at: 1,
            mode: "edit".into(),
            ships_nothing: false,
            sandboxed: false,
            ended_at: None,
            exit_code: None,
            stopped: false,
            lost: false,
            pgid: None,
            pgid_started: None,
            starting: false,
        }
    }

    #[test]
    fn keep_running_is_a_flag_on_run_command() {
        assert!(keeps_running(&serde_json::json!({"command": "npm run dev", "keep_running": true})));
        assert!(!keeps_running(&serde_json::json!({"command": "npm test"})));
        assert!(!keeps_running(&serde_json::json!({"command": "x", "keep_running": "true"})), "a string isn't the flag");
        assert!(is_proc_tool("read_output") && is_proc_tool("stop") && !is_proc_tool("run_command"));
    }

    /// The ring keeps the last bytes, with an absolute cursor, and says how
    /// many after a cursor it no longer has.
    #[test]
    fn the_output_ring_keeps_the_end_with_an_absolute_cursor() {
        let mut ring = OutputRing::new(8);
        ring.push(b"abcd");
        assert_eq!((ring.since(0), ring.total), ((b"abcd".to_vec(), 0), 4));
        ring.push(b"efgh");
        assert_eq!(ring.since(2), (b"cdefgh".to_vec(), 0));
        ring.push(b"ij");
        assert_eq!(ring.start(), 2);
        assert_eq!(ring.since(0), (b"cdefghij".to_vec(), 2), "two bytes after the cursor are gone");
        assert_eq!(ring.since(10), (Vec::new(), 0));
        ring.push(b"0123456789");
        assert_eq!(ring.since(0), (b"23456789".to_vec(), 12));
        assert_eq!(ring.total, 20);
    }

    /// `read_output` caps what it returns, head and tail, and gives the
    /// cursor after it; a later read with that cursor gets only what is new.
    #[test]
    fn read_output_is_capped_and_reads_from_its_cursor() {
        let procs = Arc::new(TalkProcs::new());
        let big = format!("FIRST\n{}\nLAST\n", "x".repeat(300_000));
        procs.insert_for_test(record(1, ProcKind::Background), big.as_bytes());
        let out = procs.read("t-1", "proc-1", None).unwrap();
        assert!(out.starts_with("proc-1 \u{b7} running \u{b7} npm run dev\n"), "{}", &out[..80]);
        assert!(out.len() < READ_MAX_BYTES + 1_000, "{}", out.len());
        assert!(out.contains("chars omitted") && out.contains("LAST"), "head and tail");
        assert!(out.contains("bytes after your cursor are no longer kept"), "the ring dropped the start");
        let total = big.len();
        assert!(out.ends_with(&format!("(cursor {total}: pass \"since\": {total} to read only what comes after)")), "{}", &out[out.len() - 120..]);
        let again = procs.read("t-1", "proc-1", Some(total as u64)).unwrap();
        assert!(again.contains("(no new output)"), "{again}");
        let colour = procs.read("t-1", "proc-1", Some(total as u64 - 5)).unwrap();
        assert!(colour.contains("LAST"), "{colour}");
        // A cursor past the end (a restart since) reads everything kept.
        let past = procs.read("t-1", "proc-1", Some(total as u64 * 2)).unwrap();
        assert!(past.contains("Octopush restarted since"), "{past}");
        // Another conversation's process isn't this one's.
        assert!(procs.read("t-2", "proc-1", None).unwrap_err().contains("it has none"));
        assert!(procs.read("t-1", "proc-9", None).unwrap_err().contains("It has: proc-1 (running)"));
    }

    #[test]
    fn read_output_strips_terminal_colours() {
        let procs = Arc::new(TalkProcs::new());
        procs.insert_for_test(record(1, ProcKind::Background), b"\x1b[32mready\x1b[0m on 40010\r\n");
        let out = procs.read("t-1", "proc-1", None).unwrap();
        assert!(out.contains("\nready on 40010\n"), "{out:?}");
    }

    /// Entering a stricter posture outgrows what started under a looser
    /// one; the same or a looser one doesn't (#1160).
    #[test]
    fn a_stricter_posture_outgrows_a_looser_start() {
        let p = |mode, ships_nothing, sandboxed| Posture { mode, ships_nothing, sandboxed };
        let edit = p(Mode::Edit, false, false);
        assert!(p(Mode::Ask, false, false).stricter_than(&edit));
        assert!(p(Mode::Plan, false, false).stricter_than(&p(Mode::Ask, false, false)));
        assert!(p(Mode::Edit, true, false).stricter_than(&edit), "a mission that came to ship nothing");
        assert!(p(Mode::Edit, false, true).stricter_than(&edit), "a mission that came to run sandboxed");
        assert!(!edit.stricter_than(&p(Mode::Ask, false, false)));
        assert!(!p(Mode::Ask, false, false).stricter_than(&p(Mode::Ask, false, false)));
        let r = ProcRecord { mode: "ask".into(), ships_nothing: true, ..record(1, ProcKind::Background) };
        assert_eq!(r.posture(), p(Mode::Ask, true, false));
    }

    /// The records survive as one file per conversation; a file under
    /// another conversation's name or an odd id keeps nothing.
    #[test]
    fn records_are_kept_per_conversation() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = ProcStore(Some(dir.path().join("talk-procs")));
        assert!(store.read_all().is_empty());
        let mut ended = record(2, ProcKind::Promoted);
        ended.ended_at = Some(5);
        ended.exit_code = Some(130);
        store.write("t-1", &[record(1, ProcKind::Background), ended.clone()]);
        assert_eq!(store.read_all(), vec![record(1, ProcKind::Background), ended]);
        // A record from an older build, without the later fields, reads.
        let old = r#"[{"id":"proc-3","n":3,"termId":"talkproc-t-3-3","threadId":"t-3","workspaceId":"w","kind":"background","command":"x","cwd":"/","startedAt":1,"mode":"edit"}]"#;
        std::fs::write(dir.path().join("talk-procs").join("t-3.json"), old).unwrap();
        // Filed under another conversation's name: skipped.
        std::fs::write(dir.path().join("talk-procs").join("t-4.json"), old).unwrap();
        let all = store.read_all();
        assert_eq!(all.len(), 3, "{all:?}");
        assert!(all.iter().any(|r| r.thread_id == "t-3" && !r.stopped && r.ended_at.is_none()));
        for odd in ["", "../t", "a/b", "t 1"] {
            assert_eq!(store.file(odd), None, "{odd:?}");
        }
        store.write("t-1", &[]);
        assert_eq!(store.read_all().len(), 1, "an empty list removes the file");
        assert!(ProcStore::default().read_all().is_empty());
    }

    #[test]
    fn the_launcher_is_written_once_and_replaced_when_changed() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = ProcStore(Some(dir.path().join("talk-procs")));
        let path = store.ensure_launcher().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), LAUNCHER);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o700);
        }
        std::fs::write(&path, "#!/bin/sh\necho changed\n").unwrap();
        store.ensure_launcher().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), LAUNCHER, "a changed launcher is written again");
        assert!(LAUNCHER.starts_with("#!/bin/bash -p\n"), "no BASH_ENV, no function from the environment");
    }

    /// The spawn env: the workspace's ports, git's hardening and the login
    /// PATH, the argv for the launcher, and nothing the caller sets can stand
    /// for the launcher's own variables or PATH.
    #[test]
    fn the_launch_env_carries_the_ports_and_the_argv() {
        let extra = vec![
            ("OCTOPUSH_PORT".to_string(), "40010".to_string()),
            ("PATH".to_string(), "/evil".to_string()),
            ("OCTOPUSH_PROC_ARG_0".to_string(), "/evil".to_string()),
        ];
        let argv = vec!["/bin/bash".to_string(), "-c".to_string(), "npm run dev".to_string()];
        let env = launch_env(&extra, &argv, vec![("TMPDIR".into(), "/t".into())]);
        assert_eq!(env["OCTOPUSH_PORT"], "40010");
        assert_eq!(env["OCTOPUSH_PROC_ARGC"], "3");
        assert_eq!(env["OCTOPUSH_PROC_ARG_0"], "/bin/bash");
        assert_eq!(env["OCTOPUSH_PROC_ARG_2"], "npm run dev");
        assert_eq!(env["TMPDIR"], "/t");
        assert_ne!(env["PATH"], "/evil");
        assert!(env.values().any(|v| v == "safe.bareRepository"), "git's hardening");
        // Plan only's read-only profile starts nothing.
        let spec = StartSpec {
            thread_id: "t".into(),
            workspace_id: "w".into(),
            workspace_path: "/ws".into(),
            command: "x".into(),
            cwd: "/ws".into(),
            env: Vec::new(),
            posture: Posture { mode: Mode::Edit, ships_nothing: false, sandboxed: false },
            posture_now: Arc::new(|| Posture { mode: Mode::Edit, ships_nothing: false, sandboxed: false }),
            cancel: None,
            sandbox_roots: Some(Vec::new()),
        };
        assert!(argv_for(&spec).unwrap_err().starts_with("Not started: this conversation is in Plan only mode"));
        let plain = StartSpec { sandbox_roots: None, ..spec };
        assert_eq!(argv_for(&plain).unwrap().0, ["/bin/bash", "-c", "x"]);
    }

    #[test]
    fn results_name_the_id_and_the_next_step() {
        let view = record(2, ProcKind::Background).view();
        let (text, ok) = started_result(&Started { view: view.clone(), output: "ready".into(), cursor: 5 }, "web");
        assert!(ok && text.starts_with("Started in the background as proc-2, in web."), "{text}");
        assert!(text.contains("read_output {\"id\": \"proc-2\"}") && text.contains("stop {\"id\": \"proc-2\"}"), "{text}");
        assert!(text.contains("Output so far:\nready") && text.ends_with("(cursor 5: pass \"since\": 5 to read_output to read only what comes after)"));
        let failed = ProcView { running: false, exit_code: Some(127), ..view.clone() };
        let (text, ok) = started_result(&Started { view: failed, output: "bash: nope: command not found".into(), cursor: 30 }, "");
        assert!(!ok && text.starts_with("proc-2 ended at once (exit code 127)."), "{text}");
        let promoted = promoted_result(&view, 600, "\x1b[1mbuilding\x1b[0m\r\n");
        assert!(promoted.starts_with("Still running after 600s, so it was moved to the conversation's live process panel"), "{promoted}");
        assert!(promoted.ends_with("Output so far:\nbuilding"), "{promoted}");
        assert_eq!(stopped_result(&ProcView { running: false, stopped: true, ..view.clone() }), "Stopped proc-2 (npm run dev).");
        assert_eq!(stopped_result(&ProcView { running: false, exit_code: Some(0), ..view }), "proc-2 was no longer running: it had exited 0.");
    }

    /// A command still running at its timeout keeps running only on a
    /// background start's terms (#1160): never in Plan only, on Ask
    /// first's card (a reader too), as a ship-nothing mission's refusals
    /// say. Stopped instead, its result says why after what it printed.
    #[test]
    fn a_command_at_its_timeout_meets_the_background_policy() {
        use crate::permissions::{decide, Decision, PolicyCtx, ToolCall};
        let ro = std::collections::HashSet::new();
        let read_only: &[String] = &[];
        let at = |mode: Mode, ships_nothing: bool, command: &str| {
            let roots = (mode == Mode::Plan).then_some(read_only);
            let ctx = PolicyCtx { exec_roots: roots, mcp_read_only: &ro, delegate_writes: false, forced: false, ships_nothing };
            decide(mode, &ToolCall { name: "run_command", input: &kept_running(command) }, &ctx)
        };
        assert!(keeps_running(&kept_running("npm test")));
        assert_eq!(at(Mode::Plan, false, "npm test"), Decision::Deny { message: crate::permissions::plan_refusal(crate::permissions::Refused::Background, false) });
        assert!(matches!(at(Mode::Ask, false, "tail -f log.txt"), Decision::Ask { .. }), "a reader asks too");
        assert!(matches!(at(Mode::Ask, false, "npm test"), Decision::Ask { .. }));
        assert_eq!(at(Mode::Edit, false, "npm test"), Decision::Allow);
        for mode in [Mode::Ask, Mode::Edit] {
            assert!(matches!(at(mode, true, "git push origin main"), Decision::Deny { .. }), "{mode:?}");
            assert!(matches!(at(mode, true, "bash -c 'npm test'"), Decision::Deny { .. }), "{mode:?}");
        }
        let ws = tempfile::TempDir::new().unwrap();
        let reach = crate::talk_guard::Reach::of_workspace(ws.path(), None);
        let card = promotion_card(crate::permissions::ask_card(None, "run_command", &kept_running("npm test"), &reach), 600);
        assert_eq!(card.shown, "npm test");
        assert_eq!(card.reason, "is still running after 600s and would keep running in the background (Ask first)");
        assert_eq!(
            stopped_at_timeout("built 3 of 9", 600, KEEP_DECLINED),
            "built 3 of 9\n(command was still running after 600s and was stopped, not kept running in the background: the user declined to keep it running in the background (the conversation is in Ask first mode))"
        );
        assert!(stopped_at_timeout("", 5, "x").starts_with("(command was still running after 5s"));
    }

    /// A promoted record names its job by group and start time; only that
    /// job, with that start time, is its own (#1160).
    #[test]
    fn a_promoted_record_knows_its_job_only() {
        let r = ProcRecord { pgid: Some(4242), pgid_started: Some(77), ..record(1, ProcKind::Promoted) };
        assert_eq!(judge(&r, Some((4242, Some(77)))), Holder::Ours(4242));
        assert_eq!(judge(&r, Some((4242, Some(78)))), Holder::Other, "the group's id used again");
        assert_eq!(judge(&r, Some((5151, Some(77)))), Holder::Other, "another job");
        assert_eq!(judge(&r, Some((4242, None))), Holder::Leaderless, "its group, its leader gone: not signalled, not another job");
        assert_eq!(judge(&r, Some((5151, None))), Holder::Other);
        assert_eq!(judge(&r, None), Holder::Nobody);
        let unknown = record(1, ProcKind::Promoted);
        assert_eq!(judge(&unknown, Some((4242, Some(77)))), Holder::Other, "without a recorded job, nothing is its own");
        assert!(!same_process(&unknown, std::process::id()));
        let me = ProcRecord {
            pgid: i32::try_from(std::process::id()).ok(),
            pgid_started: crate::talk_shell::process_started(std::process::id()),
            ..record(1, ProcKind::Background)
        };
        assert_eq!(same_process(&me, std::process::id()), me.pgid_started.is_some());
        assert!(!same_process(&ProcRecord { pgid_started: me.pgid_started.map(|t| t + 1), ..me.clone() }, std::process::id()));
        assert!(changed_while_starting(Posture { mode: Mode::Plan, ships_nothing: false, sandboxed: false }).starts_with("Not started: the conversation switched to Plan only while"));
        assert!(changed_while_starting(Posture { mode: Mode::Edit, ships_nothing: true, sandboxed: false }).starts_with("Not started: its workspace's mission changed while"));
    }

    /// Talk's director gets `run_command` with `keep_running`, and the tools
    /// that read and stop a process; the shared definition, which
    /// sub-agents and Direct stages get, has no `keep_running`.
    #[test]
    fn only_the_director_offers_keep_running() {
        let mut tools = crate::chat_engine::build_llm_tools();
        let shared = tools.iter().find(|t| t.name == "run_command").unwrap().clone();
        assert!(shared.input_schema["properties"].get("keep_running").is_none());
        let names: Vec<String> = tools.iter().map(|t| t.name.clone()).collect();
        director_command_tool(&mut tools);
        assert_eq!(tools.iter().map(|t| t.name.clone()).collect::<Vec<_>>(), names, "same tools, same order");
        let run = tools.iter().find(|t| t.name == "run_command").unwrap();
        assert_eq!(run.input_schema["properties"]["keep_running"]["type"], "boolean");
        assert!(run.description.contains("Stop every process you started"), "{}", run.description);
        let extra: Vec<String> = proc_tools().into_iter().map(|t| t.name).collect();
        assert_eq!(extra, ["read_output", "stop"]);
    }
}

#[cfg(all(test, unix))]
mod e2e {
    use super::*;
    use serial_test::serial;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use tempfile::TempDir;

    pub(super) struct Daemon {
        pub(super) tmp: TempDir,
        child: std::process::Child,
        pub(super) sock: PathBuf,
    }

    impl Drop for Daemon {
        fn drop(&mut self) {
            self.child.kill().ok();
        }
    }

    pub(super) fn boot() -> Daemon {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join(".octopush");
        std::fs::create_dir_all(&base).unwrap();
        let sock = base.join("pty-server.sock");
        let child = Command::new(crate::test_support::pty_server_bin())
            .env("HOME", tmp.path())
            .env("OCTOPUSH_PTY_AUTO_EXIT_SECS", "30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn daemon");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !(sock.exists() && std::os::unix::net::UnixStream::connect(&sock).is_ok()) {
            assert!(Instant::now() < deadline, "daemon socket did not appear");
            std::thread::sleep(Duration::from_millis(50));
        }
        Daemon { tmp, child, sock }
    }

    pub(super) const EDIT: Posture = Posture { mode: Mode::Edit, ships_nothing: false, sandboxed: false };

    pub(super) fn procs_on(d: &Daemon) -> Arc<TalkProcs> {
        let procs = Arc::new(TalkProcs::new());
        procs.set_client(Some(DaemonClient::connect_to(d.sock.to_str().unwrap()).unwrap()));
        procs.set_store(Some(d.tmp.path().join("talk-procs")));
        procs
    }

    pub(super) fn spec(thread: &str, command: &str, cwd: &str) -> StartSpec {
        StartSpec {
            thread_id: thread.into(),
            workspace_id: "w-1".into(),
            workspace_path: cwd.into(),
            command: command.into(),
            cwd: cwd.into(),
            env: crate::workspace_ports::PortBlock::new(40070).env(),
            posture: EDIT,
            posture_now: Arc::new(|| EDIT),
            cancel: None,
            sandbox_roots: None,
        }
    }

    /// Read `id` until its output holds `needle`.
    fn read_until(procs: &Arc<TalkProcs>, thread: &str, id: &str, since: Option<u64>, needle: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let out = procs.read(thread, id, since).unwrap();
            if out.contains(needle) {
                return out;
            }
            assert!(Instant::now() < deadline, "{needle:?} never came: {out}");
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn cursor_of(out: &str) -> u64 {
        let at = out.rfind("(cursor ").unwrap() + "(cursor ".len();
        out[at..].split(':').next().unwrap().parse().unwrap()
    }

    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// Start a command that keeps running, read its output with a cursor,
    /// then stop it: its whole process group goes, a child it backgrounded
    /// included. It starts where it was asked, with the workspace's ports
    /// (#1219) and no launcher variable left in its environment.
    #[test]
    #[serial]
    fn start_read_with_a_cursor_and_stop() {
        let d = boot();
        let procs = procs_on(&d);
        let dir = TempDir::new().unwrap();
        let cwd = dir.path().canonicalize().unwrap().to_string_lossy().into_owned();
        let pidfile = dir.path().join("child.pid");
        let command = format!(
            "echo \"port=$OCTOPUSH_PORT args=${{OCTOPUSH_PROC_ARGC-gone}} at=$PWD\"; sleep 300 & echo $! > '{}'; \
             echo first; sleep 1; echo second; wait",
            pidfile.display()
        );
        let started = procs.start(spec("t-a", &command, &cwd)).unwrap();
        assert_eq!(started.view.id, "proc-1");
        let recorded = procs.record("t-a", "proc-1").unwrap();
        assert!(recorded.pgid.is_some() && recorded.pgid_started.is_some(), "{recorded:?}");
        assert!(started.view.running);
        let out = read_until(&procs, "t-a", "proc-1", None, "second");
        assert!(out.contains(&format!("port=40070 args=gone at={cwd}")), "{out}");
        assert!(out.contains("first"), "{out}");
        let cursor = cursor_of(&out);
        let again = procs.read("t-a", "proc-1", Some(cursor)).unwrap();
        // The header names the command; the output after it is only what is new.
        assert!(again.contains("(no new output)") && !again.lines().skip(1).any(|l| l.contains("first")), "{again}");

        let child: i32 = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
        assert!(alive(child));
        let stopped = procs.stop("t-a", "proc-1").unwrap();
        assert!(stopped.stopped && !stopped.running, "{stopped:?}");
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive(child) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!alive(child), "the backgrounded child outlived the stop");
        assert!(procs.read("t-a", "proc-1", None).unwrap().starts_with("proc-1 \u{b7} stopped"));
        let listed = procs.list("t-a");
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].running);
        procs.close_thread("t-a");
        assert!(procs.list("t-a").is_empty());
    }

    /// In a mission that ships nothing a background command starts behind
    /// the process barrier (#1275): the shims first on its PATH, no token,
    /// and a push refused by the git shim.
    #[test]
    #[serial]
    fn a_ship_nothing_background_command_starts_behind_the_barrier() {
        let d = boot();
        let procs = procs_on(&d);
        let dir = TempDir::new().unwrap();
        let cwd = dir.path().canonicalize().unwrap().to_string_lossy().into_owned();
        let ships = Posture { mode: Mode::Edit, ships_nothing: true, sandboxed: false };
        let command = "printf 'first=%s token=%s\\n' \"${PATH%%:*}\" \"${GITHUB_TOKEN:-none}\"; git push origin main; echo \"push=$?\"; sleep 30";
        let mut s = spec("t-s", command, &cwd);
        s.posture = ships;
        s.posture_now = Arc::new(move || ships);
        s.env.push(("GITHUB_TOKEN".to_string(), "ghp_example".to_string()));
        procs.start(s).unwrap();
        let out = read_until(&procs, "t-s", "proc-1", None, "push=");
        let barrier = crate::ship_barrier::Barrier::for_workspace(std::path::Path::new(&cwd)).unwrap();
        assert!(out.contains(&format!("first={} token=none", barrier.bin().display())), "{out}");
        assert!(out.contains("Octopush refused `git`") && out.contains("push=1"), "{out}");
        procs.stop("t-s", "proc-1").unwrap();
        procs.close_thread("t-s");
    }

    /// A command that ends at once says so in its start, with its exit code.
    #[test]
    #[serial]
    fn a_command_that_ends_at_once_says_so() {
        let d = boot();
        let procs = procs_on(&d);
        let started = procs.start(spec("t-b", "echo nope >&2; exit 3", "/tmp")).unwrap();
        assert!(!started.view.running, "{:?}", started.view);
        assert_eq!(started.view.exit_code, Some(3));
        assert!(started.output.contains("nope"), "{}", started.output);
        let (text, ok) = started_result(&started, "");
        assert!(!ok && text.contains("exit code 3"), "{text}");
        procs.close_thread("t-b");
    }

    /// The conversation's processes survive an Octopush restart: a new
    /// registry reads the records, attaches to the process again and
    /// replays its output, and can still stop it. The next one gets the
    /// next number.
    #[test]
    #[serial]
    fn a_background_process_survives_a_restart() {
        let d = boot();
        {
            let procs = procs_on(&d);
            let started = procs.start(spec("t-r", "echo before-restart; sleep 300", "/tmp")).unwrap();
            assert_eq!(started.view.id, "proc-1");
            read_until(&procs, "t-r", "proc-1", None, "before-restart");
            // `procs` drops here, as at an Octopush restart.
        }
        let procs = procs_on(&d);
        let listed = procs.list("t-r");
        assert_eq!(listed.len(), 1, "{listed:?}");
        assert!(listed[0].running && listed[0].command.contains("before-restart"));
        let out = read_until(&procs, "t-r", "proc-1", None, "before-restart");
        assert!(out.starts_with("proc-1 \u{b7} running"), "{out}");
        let next = procs.start(spec("t-r", "sleep 300", "/tmp")).unwrap();
        assert_eq!(next.view.id, "proc-2");
        assert!(procs.stop("t-r", "proc-1").unwrap().stopped);
        assert!(procs.stop("t-r", "proc-2").unwrap().stopped);
        procs.close_thread("t-r");

        // One the daemon no longer has is lost, not running.
        let store = ProcStore(Some(d.tmp.path().join("talk-procs")));
        store.write("t-l", &[ProcRecord { thread_id: "t-l".into(), term_id: term_id("t-l", 1), ..super::tests_record() }]);
        let procs = procs_on(&d);
        let listed = procs.list("t-l");
        assert!(!listed[0].running && listed[0].lost, "{listed:?}");
        procs.close_thread("t-l");
    }

    /// A conversation runs at most [`MAX_RUNNING`] at once, and a stricter
    /// mode stops what started under a looser one (#1160).
    #[test]
    #[serial]
    fn the_cap_and_a_stricter_mode() {
        let d = boot();
        let procs = procs_on(&d);
        for n in 1..=MAX_RUNNING {
            assert_eq!(procs.start(spec("t-c", "sleep 300", "/tmp")).unwrap().view.id, format!("proc-{n}"));
        }
        let refused = procs.start(spec("t-c", "sleep 300", "/tmp")).err().unwrap();
        assert!(refused.starts_with(&format!("Not started: this conversation already runs {MAX_RUNNING} background processes")), "{refused}");
        let ask = Posture { mode: Mode::Ask, ships_nothing: false, sandboxed: false };
        let stopped = procs.enforce("t-c", ask);
        assert_eq!(stopped.len(), MAX_RUNNING);
        assert!(procs.list("t-c").iter().all(|p| !p.running && p.stopped));
        // Started in Ask first, it stays in Ask first and goes in Plan only.
        let in_ask = procs.start(StartSpec { posture: ask, ..spec("t-c", "sleep 300", "/tmp") }).unwrap();
        assert!(procs.enforce("t-c", ask).is_empty());
        assert_eq!(procs.enforce("t-c", Posture { mode: Mode::Plan, ..ask }), vec![in_ask.view.id]);
        procs.close_thread("t-c");
    }

    /// A promoted command is tracked from the shared shell: its output is
    /// read with a cursor, and stop ends it with Ctrl-C while the shell
    /// stays for the next command.
    #[test]
    #[serial]
    fn a_promoted_command_is_read_and_stopped() {
        let d = boot();
        let procs = procs_on(&d);
        let shell = crate::talk_shell::TalkShell::new();
        shell.set_client(Some(DaemonClient::connect_to(d.sock.to_str().unwrap()).unwrap()));
        let live = match shell.run_agent("t-p", "/tmp", "echo promoted; sleep 300", Duration::from_millis(500)).unwrap() {
            crate::talk_shell::RunOutcome::Live(l) => l,
            _ => panic!("expected the command to be promoted"),
        };
        let exited = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Arc::clone(&exited);
        let hooks = LiveHooks {
            on_chunk: Box::new(|_| {}),
            on_exit: Box::new(move |_| {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
                false
            }),
        };
        let spec = PromoteSpec { thread_id: "t-p".into(), workspace_id: "w-1".into(), command: "sleep 300".into(), posture: EDIT, posture_now: Arc::new(|| EDIT) };
        let view = procs.promote(spec, live, hooks);
        assert_eq!((view.id.as_str(), view.kind), ("proc-1", ProcKind::Promoted));
        let recorded = procs.record("t-p", "proc-1").unwrap();
        assert!(recorded.pgid.is_some() && recorded.pgid_started.is_some(), "its job is recorded: {recorded:?}");
        read_until(&procs, "t-p", "proc-1", None, "promoted");
        let stopped = procs.stop("t-p", "proc-1").unwrap();
        assert!(stopped.stopped, "{stopped:?}");
        assert!(exited.load(std::sync::atomic::Ordering::SeqCst), "the stream ended");
        assert!(procs.output("t-p", "proc-1").contains("promoted"), "what it printed, for the stop's result");
        match shell.run_agent("t-p", "/tmp", "echo after", Duration::from_secs(5)).unwrap() {
            crate::talk_shell::RunOutcome::Done(r) => assert_eq!(r.output, "after"),
            _ => panic!("the shell didn't take the next command"),
        }
        shell.close("t-p");
        procs.close_thread("t-p");
    }
}

#[cfg(all(test, unix))]
mod e2e_races {
    use super::*;
    use serial_test::serial;
    use std::sync::atomic::AtomicBool;

    fn daemon_client(d: &super::e2e::Daemon) -> Arc<DaemonClient> {
        DaemonClient::connect_to(d.sock.to_str().unwrap()).unwrap()
    }

    fn running_terms(client: &DaemonClient, prefix: &str) -> Vec<String> {
        client.list_terminals().unwrap().into_iter().filter(|t| t.running && t.id.starts_with(prefix)).map(|t| t.id).collect()
    }

    /// A stricter mode, or the turn's Stop, while a start was being spawned
    /// kills it before its command runs; nothing is registered (#1160).
    #[test]
    #[serial]
    fn a_start_rechecks_its_posture_and_stop_before_the_command_runs() {
        let d = super::e2e::boot();
        let procs = super::e2e::procs_on(&d);
        let dir = tempfile::TempDir::new().unwrap();
        let marker = dir.path().join("ran");
        let command = format!("touch '{}'; sleep 300", marker.display());
        let ask = Posture { mode: Mode::Ask, ..super::e2e::EDIT };
        let switched = StartSpec { posture_now: Arc::new(move || ask), ..super::e2e::spec("t-s", &command, "/tmp") };
        let err = procs.start(switched).err().expect("killed");
        assert!(err.starts_with("Not started: the conversation switched to Ask first while the command was starting"), "{err}");
        let stopped = StartSpec { cancel: Some(Arc::new(AtomicBool::new(true))), ..super::e2e::spec("t-s", &command, "/tmp") };
        assert_eq!(procs.start(stopped).err().as_deref(), Some(STOPPED_WHILE_STARTING));
        std::thread::sleep(Duration::from_millis(500));
        assert!(!marker.exists(), "the command ran");
        assert!(procs.list("t-s").is_empty(), "nothing registered");
        assert!(running_terms(&daemon_client(&d), "talkproc-t-s-").is_empty(), "a terminal outlived the kill");
        // A looser posture now changes nothing.
        let looser = StartSpec { posture: ask, posture_now: Arc::new(|| super::e2e::EDIT), ..super::e2e::spec("t-s", "sleep 300", "/tmp") };
        assert!(procs.start(looser).unwrap().view.running);
        procs.close_thread("t-s");
    }

    /// A mode switch whose enforcement comes while a start is in flight
    /// waits for the start to register, then sees and stops it: nothing
    /// runs untracked (#1160).
    #[test]
    #[serial]
    fn enforcement_during_a_start_waits_and_stops_it() {
        let d = super::e2e::boot();
        let procs = super::e2e::procs_on(&d);
        let (tx, rx) = std::sync::mpsc::channel();
        let racer = Arc::clone(&procs);
        let ask = Posture { mode: Mode::Ask, ..super::e2e::EDIT };
        // Read once the process is spawned, the gate held: the switch lands
        // now, and its enforcement runs on another thread.
        let posture_now: PostureSource = Arc::new(move || {
            let racer = Arc::clone(&racer);
            let _ = tx.send(std::thread::spawn(move || racer.enforce("t-e", ask)));
            super::e2e::EDIT
        });
        let started = procs.start(StartSpec { posture_now, ..super::e2e::spec("t-e", "sleep 300", "/tmp") }).unwrap();
        let enforced = rx.recv().unwrap().join().unwrap();
        assert_eq!(enforced, vec![started.view.id.clone()], "the enforcement saw the start");
        let listed = procs.list("t-e");
        assert!(!listed[0].running && listed[0].stopped, "{listed:?}");
        assert!(running_terms(&daemon_client(&d), "talkproc-t-e-").is_empty(), "it runs untracked");
        procs.close_thread("t-e");
    }

    /// Spawn the launcher as a start does, for `command`, waiting `wait`
    /// seconds for its start line, which this never sends. Returns its pid.
    fn spawn_unconfirmed(d: &super::e2e::Daemon, client: &DaemonClient, term: &str, command: &str, wait: u64) -> u32 {
        let store = ProcStore(Some(d.tmp.path().join("talk-procs")));
        let launcher = store.ensure_launcher().unwrap();
        let argv = vec!["/bin/bash".to_string(), "-c".to_string(), command.to_string()];
        let mut env = launch_env(&[], &argv, Vec::new());
        env.insert(WAIT_ENV.to_string(), wait.to_string());
        client.spawn(term, "/tmp", &env, Some(launcher.to_str().unwrap()), 40, 120).unwrap()
    }

    /// A launcher whose start line doesn't come in time runs nothing: it
    /// exits with [`NO_START_LINE`] instead of running the command (#1160).
    #[test]
    #[serial]
    fn without_its_start_line_the_launcher_runs_nothing() {
        let d = super::e2e::boot();
        let client = daemon_client(&d);
        let dir = tempfile::TempDir::new().unwrap();
        let marker = dir.path().join("ran");
        spawn_unconfirmed(&d, &client, "talkproc-t-w-1", &format!("touch '{}'", marker.display()), 1);
        let rx = client.attach("talkproc-t-w-1", 0).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let code = loop {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(TermEvent::Exit { code }) => break code,
                Ok(_) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => assert!(Instant::now() < deadline, "it kept waiting"),
                Err(e) => panic!("{e}"),
            }
        };
        assert_eq!(code, Some(NO_START_LINE));
        assert!(!marker.exists(), "the command ran without its start line");
        let _ = client.remove("talkproc-t-w-1");
    }

    /// A start keeps its record on disk before the spawn and fills in the
    /// group and start time once known, all before its start line (#1160).
    #[test]
    #[serial]
    fn a_start_is_recorded_before_its_command_runs() {
        let d = super::e2e::boot();
        let procs = super::e2e::procs_on(&d);
        let store = ProcStore(Some(d.tmp.path().join("talk-procs")));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let kept = Arc::clone(&seen);
        // Read once the process is spawned, before its start line.
        let posture_now: PostureSource = Arc::new(move || {
            *kept.lock() = store.read_all();
            super::e2e::EDIT
        });
        let started = procs.start(StartSpec { posture_now, ..super::e2e::spec("t-p1", "sleep 300", "/tmp") }).unwrap();
        let seen = seen.lock().clone();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].starting && seen[0].pgid.is_some() && seen[0].pgid_started.is_some(), "{:?}", seen[0]);
        let store = ProcStore(Some(d.tmp.path().join("talk-procs")));
        let now = store.read_all();
        assert!(!now[0].starting && now[0].running(), "confirmed once its line was sent: {:?}", now[0]);
        assert!(procs.stop("t-p1", &started.view.id).unwrap().stopped);
        procs.close_thread("t-p1");
    }

    /// After a restart, a record still starting was never confirmed: with
    /// its process still there, as the process it started as, it is
    /// stopped; without, it is dropped, and a terminal it left goes too
    /// (#1160).
    #[test]
    #[serial]
    fn a_starting_record_is_cleaned_up_on_restore() {
        let d = super::e2e::boot();
        let client = daemon_client(&d);
        let store = ProcStore(Some(d.tmp.path().join("talk-procs")));
        let dir = tempfile::TempDir::new().unwrap();
        let marker = dir.path().join("ran");
        let touch = format!("touch '{}'", marker.display());
        let starting = |n: u64, pgid: Option<i32>, pgid_started: Option<u64>| ProcRecord {
            id: format!("proc-{n}"),
            n,
            term_id: term_id("t-q", n),
            thread_id: "t-q".into(),
            starting: true,
            pgid,
            pgid_started,
            ..tests_record()
        };
        // 1: spawned, its group recorded, never given its line.
        let pid = spawn_unconfirmed(&d, &client, &term_id("t-q", 1), &touch, 60);
        let one = starting(1, i32::try_from(pid).ok(), crate::talk_shell::process_started(pid));
        // 2: recorded, and Octopush quit before the spawn.
        let two = starting(2, None, None);
        // 3: spawned, and Octopush quit before its group was recorded.
        spawn_unconfirmed(&d, &client, &term_id("t-q", 3), &touch, 60);
        let three = starting(3, None, None);
        store.write("t-q", &[one, two, three]);

        let procs = super::e2e::procs_on(&d);
        let listed = procs.list("t-q");
        assert_eq!(listed.len(), 1, "{listed:?}");
        assert_eq!(listed[0].id, "proc-1");
        assert!(listed[0].stopped && !listed[0].running, "{listed:?}");
        assert!(running_terms(&client, "talkproc-t-q-").is_empty(), "an unconfirmed process runs on");
        assert_eq!(store.read_all().iter().map(|r| (r.id.clone(), r.starting)).collect::<Vec<_>>(), vec![("proc-1".to_string(), false)]);
        std::thread::sleep(Duration::from_millis(300));
        assert!(!marker.exists(), "an unconfirmed command ran");
        procs.close_thread("t-q");
    }

    /// A command run in a shell and promoted, as the agent's would be.
    fn live_in(shell: &crate::talk_shell::TalkShell, thread: &str, command: &str) -> crate::talk_shell::LiveRun {
        match shell.run(thread, "/tmp", command, Duration::from_millis(500), true).unwrap() {
            crate::talk_shell::RunOutcome::Live(l) => l,
            _ => panic!("expected {command} to be promoted"),
        }
    }

    /// The job holding the shell `pid`, once one does.
    fn job_of(pid: u32) -> (i32, Option<u64>) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(job) = job_on(Some(pid)).filter(|(_, started)| started.is_some()) {
                return job;
            }
            assert!(Instant::now() < deadline, "no job took the shell");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// After a restart, a promoted record's shell may hold another job, the
    /// user's next `$` command: the record is lost and nothing signals that
    /// job. A record of the job that holds the shell, same group and start
    /// time, is stopped (#1160).
    #[test]
    #[serial]
    fn a_restored_promoted_record_signals_only_its_own_job() {
        let d = super::e2e::boot();
        let shell = crate::talk_shell::TalkShell::new();
        shell.set_client(Some(daemon_client(&d)));
        let client = daemon_client(&d);
        let shell_pid = || client.list_terminals().unwrap().into_iter().find(|t| t.id == "talk-t-x" && t.running).and_then(|t| t.pid).unwrap();
        let store = ProcStore(Some(d.tmp.path().join("talk-procs")));
        let record = |n: u64, job: (i32, Option<u64>)| ProcRecord {
            id: format!("proc-{n}"),
            n,
            term_id: "talk-t-x".into(),
            thread_id: "t-x".into(),
            kind: ProcKind::Promoted,
            pgid: Some(job.0),
            pgid_started: job.1,
            ..tests_record()
        };
        // The agent's command, promoted before a restart, its job recorded.
        let first = live_in(&shell, "t-x", "sleep 300");
        let agent = job_of(shell_pid());
        store.write("t-x", &[record(1, agent)]);
        // It ends, and the user runs their own command in the shell.
        shell.interrupt("t-x");
        assert_eq!(first.stream(|_| {}).exit_code, 130);
        let user = live_in(&shell, "t-x", "sleep 300");
        let theirs = job_of(shell_pid());
        assert_ne!(theirs.0, agent.0);

        // After the restart: stopping the old record signals nothing.
        let procs = super::e2e::procs_on(&d);
        let view = procs.stop("t-x", "proc-1").unwrap();
        assert!(!view.running && view.lost && !view.stopped, "{view:?}");
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(job_on(Some(shell_pid())), Some(theirs), "the user's job was signalled");
        assert!(stopped_result(&view).contains("nothing was signalled"), "{}", stopped_result(&view));
        // Listed, a record whose shell holds another job is lost too.
        store.write("t-x", &[record(1, agent)]);
        let procs = super::e2e::procs_on(&d);
        let listed = procs.list("t-x");
        assert!(!listed[0].running && listed[0].lost, "{listed:?}");
        assert_eq!(job_on(Some(shell_pid())), Some(theirs));

        // A record of the job that holds the shell is stopped, with SIGINT.
        store.write("t-x", &[record(2, theirs)]);
        let procs = super::e2e::procs_on(&d);
        assert!(procs.list("t-x")[0].running, "its own job is running");
        let view = procs.stop("t-x", "proc-2").unwrap();
        assert!(view.stopped && !view.lost, "{view:?}");
        assert_eq!(user.stream(|_| {}).exit_code, 130);
        shell.close("t-x");
        procs.close_thread("t-x");
    }
}

#[cfg(all(test, unix))]
fn tests_record() -> ProcRecord {
    ProcRecord {
        id: "proc-1".into(),
        n: 1,
        term_id: term_id("t", 1),
        thread_id: "t".into(),
        workspace_id: "w-1".into(),
        kind: ProcKind::Background,
        command: "sleep 300".into(),
        cwd: "/tmp".into(),
        started_at: 1,
        mode: "edit".into(),
        ships_nothing: false,
        sandboxed: false,
        ended_at: None,
        exit_code: None,
        stopped: false,
        lost: false,
        pgid: None,
        pgid_started: None,
        starting: false,
    }
}
