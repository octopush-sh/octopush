//! TALK shell — a persistent bash PTY per chat thread for `$`-direct execution
//! and the agent's `run_command` (the unified shell).
//!
//! Reuses the `octopush-pty-server` daemon (the same PTY infra that backs RUN
//! mode) in a *capture* access pattern: the backend is the sole attached client,
//! writes a command, and drains output until the shell's next prompt.
//!
//! Completion is detected by a **prompt marker**: `PS1` is set to emit
//! `␞␞OCTO_DONE_<nonce>:<exit>:<cwd>␞␞` (the RS bytes come from a variable so the
//! marker bytes appear only in *output*, never in echoed *input*). bash prints
//! it whenever it returns to its prompt — after a command finishes, exits, or is
//! killed — so an interactive process can't consume it and SIGINT can't flush
//! it (the failure modes of the old queued-trailer approach).
//!
//! A command that doesn't finish within a short *promotion* window is handed off
//! as a **live process**: the receiver is moved out of the session and the
//! caller streams raw output (for an xterm panel, with interactive stdin) until
//! the process exits. One shell per thread keeps cwd/env across commands and
//! across an Octopush restart (reattach); each session has its own lock so a
//! long command in one thread never blocks another.

use crate::error::{AppError, AppResult};
use crate::pty_client::{DaemonClient, TermEvent};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The bash every Talk command runs in: this shell, and `chat_engine`'s
/// `run_command` and sandboxed writes. Pinned, so the login PATH can't swap
/// in another bash (Homebrew's 5.x, a conda or nix wrapper) and the agent's
/// commands behave as the user's `$` commands do.
pub(crate) const TALK_BASH: &str = "/bin/bash";

/// Git's own hardening for every Talk command, in every mode (#1231): a
/// bare repository is used only when named (`safe.bareRepository=explicit`),
/// so one planted in a folder can't bring its config (hooks,
/// `core.fsmonitor`) into a `git status`. Set by the engine through
/// `GIT_CONFIG_COUNT`, after any entries the environment already holds.
pub(crate) fn git_hardening_env() -> Vec<(String, String)> {
    git_hardening_after(std::env::var("GIT_CONFIG_COUNT").ok().as_deref())
}

/// [`git_hardening_env`] after `count` entries already set. Pure.
pub(crate) fn git_hardening_after(count: Option<&str>) -> Vec<(String, String)> {
    let n = count.and_then(|c| c.trim().parse::<usize>().ok()).unwrap_or(0);
    vec![
        ("GIT_CONFIG_COUNT".to_string(), (n + 1).to_string()),
        (format!("GIT_CONFIG_KEY_{n}"), "safe.bareRepository".to_string()),
        (format!("GIT_CONFIG_VALUE_{n}"), "explicit".to_string()),
    ]
}

/// Cap on a `$` command's captured output (bytes), so it can't bloat the DB
/// row / chat render. The agent's capture keeps up to
/// `chat_history::COMMAND_CAPTURE_BYTES`, leaving room for its notes within
/// `COMMAND_KEEP_BYTES`; the chat engine cuts the row's and the
/// model's copy and keeps the rest for recall.
const MAX_OUTPUT_BYTES: usize = crate::chat_history::COMMAND_SHOWN_BYTES;

/// Upper bound on a complete prompt marker (incl. a long cwd). The live filter
/// won't hold back a marker-prefix tail longer than this — beyond it the leading
/// RS byte was stray, not a forming marker.
const MAX_MARKER_LEN: usize = 4160;

/// Outcome of running one command in a TALK shell.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellResult {
    pub output: String,
    pub exit_code: i32,
    pub ok: bool,
    pub cwd: String,
    /// The cwd relativized for display (computed by the chat engine; empty at the
    /// workspace root). Single source of the cwd badge; rendered verbatim.
    #[serde(default)]
    pub cwd_label: String,
    /// True when the command was promoted to a live process.
    #[serde(default)]
    pub live: bool,
}

/// What `run` decided about a command.
pub enum RunOutcome {
    Done(ShellResult),
    Live(LiveRun),
    /// A live process is already occupying this thread's shell.
    Busy,
}

/// Result of a capture-only run (the agent loop): completed, or busy.
pub enum CaptureOutcome {
    Done(ShellResult),
    Busy,
}

/// Hand-off for a promoted long-running command. The caller drives
/// [`LiveRun::stream`] to pump output until the process exits, then the session
/// is restored for the next command.
pub struct LiveRun {
    rx: Receiver<TermEvent>,
    /// Raw output already seen during the promotion window, to paint first.
    pub initial: String,
    nonce: String,
    cwd: String,
    handle: Arc<Mutex<Session>>,
    client: Arc<DaemonClient>,
    thread_id: String,
}

/// Terminal state of a streamed live process.
#[derive(Debug, Clone)]
pub struct LiveExit {
    pub exit_code: i32,
    pub cwd: String,
    pub full_output: String,
}

/// A live bash PTY bound to one chat thread.
struct Session {
    id: String,
    /// The sole capture subscriber. `None` while a live process owns it.
    rx: Option<Receiver<TermEvent>>,
    cwd: String,
    /// Per-session random token mixed into the prompt marker.
    nonce: String,
    /// Whether Ask first may give its commands a read-only verdict (#1231).
    strict: Strictness,
}

/// Whether a Talk shell is fit for Ask first's read-only verdicts (#1231).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Strictness {
    /// Not started fresh and cleaned, or something not read-only ran in it
    /// since: what its words run is unknown.
    Unchecked,
    /// Started fresh ([`TalkShell::restart_strict`]), cleaned
    /// ([`apply_strict_shell`]), and its report said nothing was left.
    Verified,
    /// Started fresh and cleaned, but the cleanup didn't hold: why.
    Failed(String),
}

pub struct TalkShell {
    client: Mutex<Option<Arc<DaemonClient>>>,
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
    /// Per thread, the variables its shell is spawned with besides PATH (the
    /// workspace's ports, #1219). A shell already running keeps its env.
    spawn_env: Mutex<HashMap<String, Vec<(String, String)>>>,
    /// Threads in Ask first or Plan only (#1231): their shell is made strict
    /// ([`apply_strict_shell`]) before it runs anything.
    strict: Mutex<std::collections::HashSet<String>>,
}

impl TalkShell {
    pub fn new() -> Self {
        Self {
            client: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            spawn_env: Mutex::new(HashMap::new()),
            strict: Mutex::new(std::collections::HashSet::new()),
        }
    }

    /// Whether the thread is in Ask first or Plan only (#1231), read at each
    /// round. `true` when it just entered them (or this process just started),
    /// when its shell is to start fresh ([`Self::restart_strict`]).
    pub fn set_strict(&self, thread_id: &str, want: bool) -> bool {
        let mut strict = self.strict.lock();
        if want {
            strict.insert(thread_id.to_string())
        } else {
            strict.remove(thread_id);
            false
        }
    }

    /// Whether the thread's shell is in use by this process yet.
    pub fn has_session(&self, thread_id: &str) -> bool {
        self.sessions.lock().contains_key(thread_id)
    }

    /// Whether the thread's shell may host a read-only verdict now.
    pub fn strictness(&self, thread_id: &str) -> Strictness {
        self.sessions.lock().get(thread_id).map_or(Strictness::Unchecked, |h| h.lock().strict.clone())
    }

    /// Restart, don't clean (#1231): kill the thread's shell, whatever state
    /// earlier commands left in it, start a fresh `bash -l` in the same
    /// directory when it is known (else `workspace_path`), say so in the
    /// terminal ("Shell restarted for <mode>"), then run
    /// [`apply_strict_shell`] on that fresh shell. A shell busy with a live
    /// process isn't killed: it stays unchecked.
    pub fn restart_strict(&self, thread_id: &str, workspace_path: &str, mode: &str) -> Strictness {
        let Some(client) = self.client.lock().clone() else {
            return Strictness::Failed("the terminal daemon is unavailable".into());
        };
        let old = self.sessions.lock().get(thread_id).cloned();
        if let Some(old) = &old {
            if old.lock().rx.is_none() {
                return Strictness::Failed("the shell is busy with a running process".into());
            }
        }
        let cwd = old.map(|h| h.lock().cwd.clone()).filter(|c| !c.is_empty()).unwrap_or_else(|| workspace_path.to_string());
        self.sessions.lock().remove(thread_id);
        let id = format!("talk-{thread_id}");
        let _ = client.remove(&id);
        // Never attach to the old one again: wait until it is gone.
        let gone = || !client.list_terminals().unwrap_or_default().iter().any(|t| t.id == id && t.running);
        let deadline = Instant::now() + Duration::from_secs(3);
        while !gone() {
            if Instant::now() > deadline {
                return Strictness::Failed("the old shell didn't stop".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let extra = self.spawn_env.lock().get(thread_id).cloned().unwrap_or_default();
        let mut session = match Self::ensure_session(&client, thread_id, &cwd, &extra) {
            Ok(session) => session,
            Err(e) => return Strictness::Failed(format!("the shell didn't start again: {e}")),
        };
        if let Some(rx) = session.rx.take() {
            drain_pending(&rx);
            let note = format!("\\builtin printf '%s\\n' 'Shell restarted for {mode}'\n");
            if client.write(&session.id, note.as_bytes()).is_ok() {
                let _ = probe(&rx, Duration::from_secs(5), &session.nonce);
            }
            session.strict = match apply_strict_shell(&client, &session.id, &rx, &session.nonce) {
                Ok(()) => Strictness::Verified,
                Err(why) => Strictness::Failed(why),
            };
            session.rx = Some(rx);
        }
        let state = session.strict.clone();
        self.sessions.lock().insert(thread_id.to_string(), Arc::new(Mutex::new(session)));
        state
    }

    /// Set the variables the thread's shell starts with the next time it is
    /// spawned (its first command, or after a recycle).
    pub fn set_spawn_env(&self, thread_id: &str, env: Vec<(String, String)>) {
        self.spawn_env.lock().insert(thread_id.to_string(), env);
    }

    pub fn set_client(&self, client: Option<Arc<DaemonClient>>) {
        *self.client.lock() = client;
    }

    /// Whether a daemon client is attached — i.e. the shared shell is usable.
    pub fn available(&self) -> bool {
        self.client.lock().is_some()
    }

    /// Where the thread's shell is now, as it last reported (`None` before
    /// its first command): where an agent command's relative paths land.
    pub fn cwd(&self, thread_id: &str) -> Option<String> {
        let handle = self.sessions.lock().get(thread_id).cloned()?;
        let cwd = handle.lock().cwd.clone();
        (!cwd.is_empty()).then_some(cwd)
    }

    /// Run a command in the thread's shell.
    ///
    /// `promote = true` ($-direct): if it hasn't finished within `timeout`,
    /// return [`RunOutcome::Live`] so the caller streams the rest.
    /// `promote = false` (agent capture): never promote — on `timeout`, interrupt
    /// (Ctrl-C) and return the partial output, keeping the shell (env preserved).
    pub fn run(
        &self,
        thread_id: &str,
        workspace_path: &str,
        command: &str,
        timeout: Duration,
        promote: bool,
    ) -> AppResult<RunOutcome> {
        self.run_as(thread_id, workspace_path, command, timeout, promote, false)
    }

    /// [`Self::run`]. `keeps_strict`: the command had Ask first's read-only
    /// verdict in a verified shell, so it leaves it verified; anything else
    /// leaves it [`Strictness::Unchecked`] (#1231).
    fn run_as(
        &self,
        thread_id: &str,
        workspace_path: &str,
        command: &str,
        timeout: Duration,
        promote: bool,
        keeps_strict: bool,
    ) -> AppResult<RunOutcome> {
        let client = self
            .client
            .lock()
            .clone()
            .ok_or_else(|| AppError::Other("terminal daemon unavailable".into()))?;

        let existing = {
            let map = self.sessions.lock();
            map.get(thread_id).cloned()
        };
        let extra = self.spawn_env.lock().get(thread_id).cloned().unwrap_or_default();
        let handle = match existing {
            Some(h) => h,
            None => {
                let session = Self::ensure_session(&client, thread_id, workspace_path, &extra)?;
                let h = Arc::new(Mutex::new(session));
                let mut map = self.sessions.lock();
                Arc::clone(map.entry(thread_id.to_string()).or_insert(h))
            }
        };

        // Take the receiver out under the lock, then drop the lock so the drain
        // never blocks another thread. A concurrent run for THIS thread finds
        // `rx == None` and returns Busy.
        let (rx, nonce, id, cwd) = {
            let mut session = handle.lock();
            let Some(rx) = session.rx.take() else {
                return Ok(RunOutcome::Busy);
            };
            (rx, session.nonce.clone(), session.id.clone(), session.cwd.clone())
        };

        // What a command other than a verified read-only one leaves in the
        // shell is unknown (#1231): an alias, a function, a trap.
        if !keeps_strict || handle.lock().strict != Strictness::Verified {
            handle.lock().strict = Strictness::Unchecked;
        }

        // Discard any stale bytes (the idle prompt left in the buffer) so the
        // next prompt marker we see is unambiguously THIS command's completion.
        drain_pending(&rx);
        let keep = if promote { MAX_OUTPUT_BYTES } else { crate::chat_history::COMMAND_CAPTURE_BYTES };
        if let Err(e) = client.write(&id, format!("{command}\n").as_bytes()) {
            handle.lock().rx = Some(rx);
            return Err(e);
        }

        match probe(&rx, timeout, &nonce) {
            Probe::Done { output, exit_code, cwd: new_cwd } => {
                let final_cwd = if new_cwd.is_empty() { cwd } else { new_cwd };
                let mut session = handle.lock();
                session.rx = Some(rx);
                session.cwd = final_cwd.clone();
                Ok(RunOutcome::Done(ShellResult {
                    output: cap_output(output, keep, exit_code != 0),
                    exit_code,
                    ok: exit_code == 0,
                    cwd: final_cwd,
                    cwd_label: String::new(),
                    live: false,
                }))
            }
            Probe::Dead { output } => {
                let _ = client.remove(&id);
                match Self::ensure_session(&client, thread_id, &cwd, &extra) {
                    Ok(fresh) => *handle.lock() = fresh,
                    Err(e) => {
                        self.sessions.lock().remove(thread_id);
                        return Err(e);
                    }
                }
                Ok(RunOutcome::Done(ShellResult {
                    output: cap_output(output, keep, true),
                    exit_code: -1,
                    ok: false,
                    cwd,
                    cwd_label: String::new(),
                    live: false,
                }))
            }
            Probe::NotYet { raw } if promote => Ok(RunOutcome::Live(LiveRun {
                rx,
                initial: raw,
                nonce,
                cwd,
                handle,
                client,
                thread_id: thread_id.to_string(),
            })),
            // Capture-only timeout: interrupt, then read the prompt marker bash
            // prints once the killed command returns control — keeping the shell
            // (env preserved). Ctrl-C can't lose the marker now (it's a prompt,
            // not queued input). Recycle only if the marker never comes.
            Probe::NotYet { raw } => {
                let note = format!(
                    "(command was still running after {}s and was interrupted — the output \
                     above may be incomplete, and any process it backgrounded may still be \
                     running)",
                    timeout.as_secs()
                );
                let partial = strip_octo_markers(&clean_output(&raw), &nonce);
                let _ = client.write(&id, b"\x03");
                match probe(&rx, Duration::from_secs(3), &nonce) {
                    // The interrupt landed and the shell returned to its prompt —
                    // env/cwd preserved. Include any output the command emitted
                    // during the post-interrupt window (cleanup / SIGINT handler).
                    Probe::Done { output: tail, cwd: new_cwd, .. } => {
                        let final_cwd = if new_cwd.is_empty() { cwd } else { new_cwd };
                        let body = join_nonempty(&[&partial, &tail, &note]);
                        let mut session = handle.lock();
                        session.rx = Some(rx);
                        session.cwd = final_cwd.clone();
                        Ok(RunOutcome::Done(ShellResult {
                            output: cap_output(body, keep, true),
                            exit_code: -1,
                            ok: false,
                            cwd: final_cwd,
                            cwd_label: String::new(),
                            live: false,
                        }))
                    }
                    // The command ignored SIGINT and never returned to a prompt —
                    // recycle as a last resort (this DOES lose the shell's env/cwd).
                    _ => {
                        let body = join_nonempty(&[&partial, &note]);
                        let _ = client.remove(&id);
                        match Self::ensure_session(&client, thread_id, &cwd, &extra) {
                            Ok(fresh) => *handle.lock() = fresh,
                            Err(e) => {
                                self.sessions.lock().remove(thread_id);
                                return Err(e);
                            }
                        }
                        Ok(RunOutcome::Done(ShellResult {
                            output: cap_output(body, keep, true),
                            exit_code: -1,
                            ok: false,
                            cwd,
                            cwd_label: String::new(),
                            live: false,
                        }))
                    }
                }
            }
        }
    }

    /// Capture-only run for the agent loop (never promotes to a live process).
    pub fn run_capture(
        &self,
        thread_id: &str,
        workspace_path: &str,
        command: &str,
        timeout: Duration,
    ) -> AppResult<CaptureOutcome> {
        match self.run(thread_id, workspace_path, command, timeout, false)? {
            RunOutcome::Done(r) => Ok(CaptureOutcome::Done(r)),
            RunOutcome::Busy | RunOutcome::Live(_) => Ok(CaptureOutcome::Busy),
        }
    }

    /// [`Self::run_capture`] for a command with Ask first's read-only verdict
    /// in a verified shell, which stays verified (#1231).
    pub fn run_capture_read_only(
        &self,
        thread_id: &str,
        workspace_path: &str,
        command: &str,
        timeout: Duration,
    ) -> AppResult<CaptureOutcome> {
        match self.run_as(thread_id, workspace_path, command, timeout, false, true)? {
            RunOutcome::Done(r) => Ok(CaptureOutcome::Done(r)),
            RunOutcome::Busy | RunOutcome::Live(_) => Ok(CaptureOutcome::Busy),
        }
    }

    /// Send SIGINT (Ctrl-C) to a thread's live process.
    pub fn interrupt(&self, thread_id: &str) {
        if let Some(client) = self.client.lock().clone() {
            let _ = client.write(&format!("talk-{thread_id}"), b"\x03");
        }
    }

    /// Forward keystrokes to a thread's live process (interactive stdin).
    pub fn write_stdin(&self, thread_id: &str, data: &[u8]) {
        if let Some(client) = self.client.lock().clone() {
            let _ = client.write(&format!("talk-{thread_id}"), data);
        }
    }

    /// Resize a thread's PTY so a full-screen TUI lays out to the panel size.
    pub fn resize(&self, thread_id: &str, cols: u16, rows: u16) {
        if let Some(client) = self.client.lock().clone() {
            let _ = client.resize(&format!("talk-{thread_id}"), cols, rows);
        }
    }

    /// Drop a thread's shell (on thread delete / cleanup).
    pub fn close(&self, thread_id: &str) {
        let client = self.client.lock().clone();
        let handle = self.sessions.lock().remove(thread_id);
        self.spawn_env.lock().remove(thread_id);
        if let (Some(client), Some(handle)) = (client, handle) {
            let _ = client.remove(&handle.lock().id);
        }
    }

    /// Reattach to a surviving daemon PTY (so the shell persists across an
    /// Octopush restart) or spawn fresh; then (re-)install the prompt marker with
    /// a fresh nonce and wait until the shell confirms ready. Returns the cwd.
    fn ensure_session(
        client: &Arc<DaemonClient>,
        thread_id: &str,
        cwd: &str,
        extra: &[(String, String)],
    ) -> AppResult<Session> {
        let id = format!("talk-{thread_id}");
        let reattaching = client
            .list_terminals()
            .unwrap_or_default()
            .iter()
            .any(|t| t.id == id && t.running);

        // The PATH CLI stages spawn with, and no other login-shell variable.
        let path = crate::orchestrator::cli_runner::resolved_cli_path();
        // Without the login shell's own PATH (its probe failed or timed out),
        // `path` is only the app's PATH and the common dirs, which puts
        // `/usr/bin` ahead of Homebrew: leave `bash -l`'s PATH alone then.
        let has_login_path = crate::orchestrator::cli_runner::login_env_path().is_some();
        if !reattaching {
            Self::spawn_bash(client, &id, cwd, &spawn_env(&path, extra))?;
        }
        let nonce = gen_nonce();
        let rx = client.attach(&id, 0)?;

        match init_and_wait_ready(client, &id, &rx, &nonce) {
            Ok(ready_cwd) => {
                if has_login_path {
                    apply_login_path(client, &id, &rx, &nonce, &path);
                }
                // A reattached shell may predate the hardening, or a command
                // in it may have dropped it (#1231).
                apply_git_hardening(client, &id, &rx, &nonce);
                Ok(Session {
                    id,
                    rx: Some(rx),
                    cwd: ready_cwd.unwrap_or_else(|| cwd.to_string()),
                    nonce,
                    strict: Strictness::Unchecked,
                })
            }
            // Reattached but never ready — the surviving shell is busy with a
            // process from before the restart. Do NOT kill it; surface an error.
            Err(_) if reattaching => Err(AppError::Other(
                "This conversation's shell is busy with a process still running from before \
                 the restart. Wait for it to finish, or delete the conversation to stop it."
                    .into(),
            )),
            Err(e) => {
                let _ = client.remove(&id);
                Err(e)
            }
        }
    }

    fn spawn_bash(client: &Arc<DaemonClient>, id: &str, cwd: &str, env: &HashMap<String, String>) -> AppResult<()> {
        let mut env = env.clone();
        env.extend(git_hardening_env());
        client.spawn(id, cwd, &env, Some(TALK_BASH), 40, 120)?;
        Ok(())
    }
}

/// A Talk shell's spawn env: `path` as PATH, plus the thread's `extra`
/// variables (which never replace PATH).
fn spawn_env(path: &str, extra: &[(String, String)]) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = extra.iter().filter(|(k, _)| k != "PATH").cloned().collect();
    env.insert("PATH".to_string(), path.to_string());
    env
}

/// The line that gives a Talk shell `path` once (see [`apply_login_path`]):
/// skipped when `__octo_lp` is already set, `path` single-quoted. Pure.
fn login_path_line(path: &str) -> String {
    format!(
        "[ -n \"${{__octo_lp-}}\" ] || {{ export PATH='{}'; __octo_lp=1; }}\n",
        path.replace('\'', "'\\''")
    )
}

/// Set the shell's PATH to `path` after its profile ran. The spawn env alone
/// can't: `bash -l` sources `/etc/profile`, whose `path_helper` moves the
/// system dirs ahead of the PATH the shell was spawned with, so `/usr/bin`
/// would shadow Homebrew, nvm or pyenv. Written once the prompt is up, as
/// the commands are (a long line queued while the profile still runs may not
/// fit the terminal's line buffer), and guarded by a shell variable: a shell
/// that already ran it keeps any PATH change made in it across a restart,
/// and one spawned by an older build gets it on its first reattach. Best
/// effort: a shell that doesn't answer keeps the spawn PATH.
fn apply_login_path(client: &Arc<DaemonClient>, id: &str, rx: &Receiver<TermEvent>, nonce: &str, path: &str) {
    drain_pending(rx);
    if client.write(id, login_path_line(path).as_bytes()).is_err() {
        return;
    }
    if !matches!(probe(rx, Duration::from_secs(5), nonce), Probe::Done { .. }) {
        tracing::warn!(id, "talk shell did not confirm the login PATH");
    }
}

/// The line that gives a Talk shell git's hardening ([`git_hardening_env`])
/// unless it holds it already: after the `GIT_CONFIG_*` entries it has, so
/// writing it again changes nothing.
const GIT_HARDENING_LINE: &str = "__octo_gh() { local i=0 n=\"${GIT_CONFIG_COUNT:-0}\" k v; \
    case \"$n\" in ''|*[!0-9]*) n=0;; esac; \
    while [ \"$i\" -lt \"$n\" ]; do k=GIT_CONFIG_KEY_$i; v=GIT_CONFIG_VALUE_$i; \
    [ \"${!k}\" = safe.bareRepository ] && [ \"${!v}\" = explicit ] && return; i=$((i+1)); done; \
    export GIT_CONFIG_KEY_$n=safe.bareRepository GIT_CONFIG_VALUE_$n=explicit GIT_CONFIG_COUNT=$((n+1)); }; \
    __octo_gh; unset -f __octo_gh\n";

/// Give the shell git's hardening once its prompt is up, as the login PATH
/// is given (see [`apply_login_path`]): a shell an older build spawned, or
/// one whose environment lost it, gets it back on reattach. Best effort, as
/// that is.
fn apply_git_hardening(client: &Arc<DaemonClient>, id: &str, rx: &Receiver<TermEvent>, nonce: &str) {
    drain_pending(rx);
    if client.write(id, GIT_HARDENING_LINE.as_bytes()).is_err() {
        return;
    }
    if !matches!(probe(rx, Duration::from_secs(5), nonce), Probe::Done { .. }) {
        tracing::warn!(id, "talk shell did not confirm git's hardening");
    }
}

/// The two lines that make a Talk shell strict ([`apply_strict_shell`]),
/// with `nonce` in the new prompt marker and `tag` on the report. Pure.
///
/// The first runs with the profile's aliases still on, so each word it runs
/// is a `\`-named builtin, and in POSIX mode (`POSIXLY_CORRECT`), where a
/// special builtin (`trap`, `unset`) is found before a function of its name:
/// it drops the DEBUG, RETURN, ERR and EXIT traps, the functions that could
/// stand in for the builtins it uses next, every alias, alias expansion,
/// `PROMPT_COMMAND`, `PS0` and `command_not_found_handle`, and leaves an
/// empty prompt. The second, read once aliases are gone, unsets every
/// function `declare -F` lists (Octopush's own prompt functions too), sets
/// a prompt marker that needs no function (`printf` in `PS1`), and prints
/// one report line: the aliases, functions and traps left, and whether
/// `PROMPT_COMMAND` is set.
fn strict_shell_lines(nonce: &str, tag: &str) -> String {
    let first = "POSIXLY_CORRECT=1; \\trap - DEBUG RETURN ERR EXIT; \
        \\unset -f unset builtin command declare read printf trap shopt unalias alias set enable eval exec source local; \
        \\unset POSIXLY_CORRECT; \\builtin unalias -a; \\builtin shopt -u expand_aliases; \
        \\builtin unset PROMPT_COMMAND PS0 command_not_found_handle; PS1=''";
    let count = |var: &str, of: &str| {
        format!("{var}=0; while \\builtin read -r _; do {var}=$(({var}+1)); done < <(\\builtin {of}); ")
    };
    let second = format!(
        "while \\builtin read -r _ _ __octo_f; do \\builtin unset -f \"$__octo_f\"; done < <(\\builtin declare -F); \
         \\builtin set +H; \\builtin unset CDPATH __octo_f; __OCTORS=$(\\builtin printf '\\036'); \
         {}{}{}\\builtin printf 'OCTO_STRICT_%s:%d:%d:%d:%s\\n' {tag} \"$__octo_a\" \"$__octo_n\" \"$__octo_t\" \"${{PROMPT_COMMAND+set}}\"; \
         \\builtin unset __octo_a __octo_n __octo_t; \
         PS1='$(printf \"%s%sOCTO_DONE_%s:%d:%s%s%s\" \"$__OCTORS\" \"$__OCTORS\" {nonce} \"$?\" \"$PWD\" \"$__OCTORS\" \"$__OCTORS\")'",
        count("__octo_a", "alias"),
        count("__octo_n", "declare -F"),
        count("__octo_t", "trap -p"),
    );
    format!("{first}\n{second}\n")
}

/// Whether the cleanup held, from the shell's report line tagged `tag` in
/// `output` ([`strict_shell_lines`]): `Ok` only when it reports no alias, no
/// function, no trap and no `PROMPT_COMMAND`. Pure.
fn strict_report(output: &str, tag: &str) -> Result<(), String> {
    let re = regex::Regex::new(&format!(r"OCTO_STRICT_{}:(\d+):(\d+):(\d+):(\S*)", regex::escape(tag))).expect("valid report regex");
    let Some(c) = re.captures(output) else {
        return Err("the shell sent no report after its cleanup".into());
    };
    let (aliases, functions, traps, prompt) = (&c[1], &c[2], &c[3], &c[4]);
    if (aliases, functions, traps, prompt) == ("0", "0", "0", "") {
        return Ok(());
    }
    let pc = if prompt.is_empty() { "" } else { ", and PROMPT_COMMAND is still set" };
    Err(format!("after its cleanup the shell still has {aliases} alias(es), {functions} function(s) and {traps} trap(s){pc}"))
}

/// Make a fresh Talk shell strict for Ask first and Plan only (#1231), as
/// git's hardening is given (see [`apply_git_hardening`]), then prove it:
/// `bash -l` loads the user's profile, whose aliases, functions, traps and
/// `PROMPT_COMMAND` can turn a word the reader check counts as read-only
/// (`ls`, `git`) into a writer. Runs [`strict_shell_lines`] and accepts the
/// shell only when its report says nothing is left ([`strict_report`]);
/// the reason otherwise. Only ever run on a shell just started
/// ([`TalkShell::restart_strict`]): state an earlier command made could
/// defeat any cleanup.
fn apply_strict_shell(client: &Arc<DaemonClient>, id: &str, rx: &Receiver<TermEvent>, nonce: &str) -> Result<(), String> {
    drain_pending(rx);
    let tag = gen_nonce();
    if client.write(id, strict_shell_lines(nonce, &tag).as_bytes()).is_err() {
        return Err("the shell couldn't be written to".into());
    }
    match probe(rx, Duration::from_secs(10), nonce) {
        Probe::Done { output, .. } => strict_report(&output, &tag),
        _ => Err("the shell didn't come back after its cleanup".into()),
    }
}

impl LiveRun {
    /// Pump live output to `on_chunk` (raw, with ANSI — xterm draws it) until the
    /// process exits (the prompt marker prints), then restore the session and
    /// return the exit info. Blocking — run on a worker thread.
    pub fn stream<F: FnMut(&str)>(self, mut on_chunk: F) -> LiveExit {
        let mut filter = StreamFilter::new(&self.nonce);
        let mut full = String::new();
        let mut push = |emit: &str, full: &mut String, on_chunk: &mut F| {
            if !emit.is_empty() {
                full.push_str(emit);
                on_chunk(emit);
            }
        };

        let mut exit = LiveExit {
            exit_code: -1,
            cwd: self.cwd.clone(),
            full_output: String::new(),
        };

        let (init_emit, init_done) = filter.feed(&self.initial);
        push(&init_emit, &mut full, &mut on_chunk);
        if let Some((code, cwd)) = init_done {
            exit.exit_code = code;
            exit.cwd = cwd;
            return self.finish(exit, full);
        }

        loop {
            match self.rx.recv_timeout(Duration::from_millis(500)) {
                Ok(TermEvent::Data { bytes, .. }) => {
                    let chunk = String::from_utf8_lossy(&bytes);
                    let (emit, done) = filter.feed(&chunk);
                    push(&emit, &mut full, &mut on_chunk);
                    if let Some((code, cwd)) = done {
                        exit.exit_code = code;
                        exit.cwd = cwd;
                        break;
                    }
                }
                Ok(TermEvent::Exit { code }) => {
                    let tail = filter.flush();
                    push(&tail, &mut full, &mut on_chunk);
                    exit.exit_code = code.unwrap_or(-1);
                    break;
                }
                Ok(TermEvent::Error { .. }) | Err(RecvTimeoutError::Disconnected) => {
                    let tail = filter.flush();
                    push(&tail, &mut full, &mut on_chunk);
                    break;
                }
                Ok(TermEvent::Attention) | Ok(TermEvent::Foreground { .. }) | Ok(TermEvent::ReplayDone) | Err(RecvTimeoutError::Timeout) => {}
            }
        }

        self.finish(exit, full)
    }

    fn finish(self, mut exit: LiveExit, full: String) -> LiveExit {
        exit.full_output = cap_output(clean_output(&full), MAX_OUTPUT_BYTES, exit.exit_code != 0);
        let mut session = self.handle.lock();
        session.rx = Some(self.rx);
        if !exit.cwd.is_empty() {
            session.cwd = exit.cwd.clone();
        } else {
            exit.cwd = session.cwd.clone();
        }
        drop(session);
        let _ = (&self.client, &self.thread_id); // retained for future kill paths
        exit
    }
}

impl Default for TalkShell {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Capture (pure where possible, unit-tested) ───────────────────────

enum Probe {
    Done { output: String, exit_code: i32, cwd: String },
    /// Promotion window elapsed; `raw` is the output seen so far.
    NotYet { raw: String },
    Dead { output: String },
}

/// Discard the idle prompt (and any in-flight bytes) so the next prompt marker
/// is unambiguously the NEXT command's completion. Drains until the channel is
/// quiet for a short window rather than snapshotting it with try_recv — the idle
/// prompt arrives asynchronously and a bare try_recv loop races it, which would
/// make `probe` match the stale idle marker as this command's completion.
fn drain_pending(rx: &Receiver<TermEvent>) {
    // First clear whatever is already buffered.
    while rx.try_recv().is_ok() {}
    // Then wait briefly for a late idle prompt; stop once the channel goes quiet.
    // A hard deadline bounds the total wait so steady background output (a
    // watcher/dev-server the shell launched earlier) can't starve this loop and
    // block the command write indefinitely.
    let deadline = Instant::now() + Duration::from_millis(150);
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(40)) {
            Ok(_) => continue, // late idle bytes — keep draining (bounded by deadline)
            Err(_) => break,   // channel quiet → done
        }
    }
}

/// Drain until the prompt marker (command done) or `timeout`, accumulating raw
/// output (kept verbatim so a promoted stream can render ANSI).
fn probe(rx: &Receiver<TermEvent>, timeout: Duration, nonce: &str) -> Probe {
    let deadline = Instant::now() + timeout;
    let re = done_re(nonce);
    let mut buf = String::new();
    loop {
        if Instant::now() >= deadline {
            return Probe::NotYet { raw: buf };
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(TermEvent::Data { bytes, .. }) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                if let Some(caps) = re.captures(&buf) {
                    let whole = caps.get(0).unwrap();
                    let output = clean_output(&buf[..whole.start()]);
                    let exit_code = caps[1].parse().unwrap_or(-1);
                    let cwd = caps[2].to_string();
                    return Probe::Done { output, exit_code, cwd };
                }
            }
            Ok(TermEvent::Exit { .. }) | Ok(TermEvent::Error { .. }) => {
                // Strip markers too: the shell may have died mid-prompt, leaving a
                // partial OCTO_DONE marker that clean_output alone wouldn't remove.
                return Probe::Dead { output: strip_octo_markers(&clean_output(&buf), nonce) };
            }
            Ok(TermEvent::Attention) | Ok(TermEvent::Foreground { .. }) | Ok(TermEvent::ReplayDone) => {}
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Probe::Dead { output: strip_octo_markers(&clean_output(&buf), nonce) };
            }
        }
    }
}

/// Progressive prompt-marker filter for the live-stream path: emits output as it
/// arrives (holding back a tail that could be a partial marker) and reports exit
/// code + cwd when the prompt marker is seen.
struct StreamFilter {
    done_re: regex::Regex,
    carry: String,
}

impl StreamFilter {
    fn new(nonce: &str) -> Self {
        Self { done_re: done_re(nonce), carry: String::new() }
    }

    fn feed(&mut self, chunk: &str) -> (String, Option<(i32, String)>) {
        self.carry.push_str(chunk);
        if let Some(caps) = self.done_re.captures(&self.carry) {
            let whole = caps.get(0).unwrap();
            let emit = clean_inline(&self.carry[..whole.start()]);
            let code = caps[1].parse().unwrap_or(-1);
            let cwd = caps[2].to_string();
            self.carry.clear();
            return (emit, Some((code, cwd)));
        }
        // Hold back the tail ONLY if it's genuinely a forming prompt marker:
        // either a partial prefix of `␞␞OCTO_DONE_`, or that full prefix plus a
        // bounded amount still being completed. A stray RS that isn't forming a
        // marker (e.g. a tool emitting raw 0x1e) is emitted (stripped) so the
        // live panel never freezes waiting for a marker that won't come.
        const PREFIX: &str = "\u{1e}\u{1e}OCTO_DONE_";
        match self.carry.find('\u{1e}') {
            Some(i) => {
                let tail = &self.carry[i..];
                let forming = PREFIX.starts_with(tail)
                    || (tail.starts_with(PREFIX) && tail.len() <= MAX_MARKER_LEN);
                if forming {
                    let emit = self.carry[..i].to_string();
                    self.carry = self.carry[i..].to_string();
                    (emit, None)
                } else {
                    (clean_inline(&std::mem::take(&mut self.carry)), None)
                }
            }
            None => (std::mem::take(&mut self.carry), None),
        }
    }

    fn flush(&mut self) -> String {
        clean_inline(&std::mem::take(&mut self.carry))
    }
}

fn gen_nonce() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    format!("{:08x}{:08x}", t.wrapping_mul(2_654_435_761) ^ n, n)
}

/// The init line that makes the shell run a command exactly as written:
/// no history expansion of `!`, a `cd` that goes where the path check reads
/// it (no `CDPATH`, #1229), and a TAB inserted rather than taken as a
/// completion request (see `init_and_wait_ready`).
const SHELL_INPUT_AS_WRITTEN: &str = "set +H; unset CDPATH; bind 'set disable-completion on' 2>/dev/null\n";

/// The prompt marker: `␞␞OCTO_DONE_<nonce>:<exit>:<cwd>␞␞`.
fn done_re(nonce: &str) -> regex::Regex {
    regex::Regex::new(&format!(
        r"\x1e\x1eOCTO_DONE_{}:(-?\d+):([^\x1e]*)\x1e\x1e",
        regex::escape(nonce)
    ))
    .expect("valid prompt-marker regex")
}

/// Install the prompt marker with `nonce` and wait until the shell prints it
/// (ready). On reattach this drains replayed scrollback past it. Returns cwd.
fn init_and_wait_ready(
    client: &Arc<DaemonClient>,
    id: &str,
    rx: &Receiver<TermEvent>,
    nonce: &str,
) -> AppResult<Option<String>> {
    // Leading newline flushes any partial line a reattached shell left behind.
    //
    // Completion marker design:
    // - `$__OCTORS` is a runtime-built RS byte, so the raw marker bytes never
    //   appear in (echoable) shell source.
    // - PS1 is `$(__octo_ps)` — a command substitution evaluated at prompt time.
    //   So `echo "$PS1"` / `set` / `declare` reproduce only the literal
    //   `$(__octo_ps)`, NOT the marker (a command printing the env can't forge a
    //   false completion).
    // - PROMPT_COMMAND re-asserts PS1 each prompt, so a command that overwrites
    //   PS1 (venv/conda activate, a sourced script) can't break detection. It
    //   re-asserts `set +H` too (below), so a command or sourced script that
    //   turns history expansion back on can't break the next command.
    //
    // Commands are typed into this interactive shell's readline as written
    // (`run`), so two of its interactive features would rewrite them:
    // history expansion (`node -e "if (!x) …"` fails with "event not found"
    // and never runs; macOS's bash 3.2 also fails `echo "done!"`) and TAB
    // completion (a heredoc's tabs vanish, which breaks a Makefile, and a
    // TAB with many matches asks "Display all N possibilities?" and eats the
    // next character). `set +H` turns the first off and `disable-completion`
    // makes TAB insert itself; neither is needed, since nobody types at this
    // prompt. On every attach, so a shell from an older build gets them too.
    let mut init = String::new();
    init.push('\n');
    init.push_str("stty -echo 2>/dev/null; PS2=''\n");
    init.push_str(SHELL_INPUT_AS_WRITTEN);
    init.push_str("__OCTORS=$(printf '\\036')\n");
    init.push_str(&format!(
        "__octo_ps() {{ printf '%s%sOCTO_DONE_{nonce}:%d:%s%s%s' \"$__OCTORS\" \"$__OCTORS\" \"$__octo_oc\" \"$PWD\" \"$__OCTORS\" \"$__OCTORS\"; }}\n"
    ));
    init.push_str("__octo_setps() { PS1='$(__octo_ps)'; }\n");
    init.push_str("__octo_oc=0; PROMPT_COMMAND='__octo_oc=$?; set +H; unset CDPATH; __octo_setps'\n");
    init.push_str("__octo_setps\n");
    client.write(id, init.as_bytes())?;

    let re = done_re(nonce);
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut buf = String::new();
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(TermEvent::Data { bytes, .. }) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                if let Some(caps) = re.captures(&buf) {
                    return Ok(Some(caps[2].to_string()));
                }
            }
            Ok(TermEvent::Exit { .. }) | Ok(TermEvent::Error { .. }) => {
                return Err(AppError::Other("talk shell exited during init".into()));
            }
            Ok(TermEvent::Attention) | Ok(TermEvent::Foreground { .. }) | Ok(TermEvent::ReplayDone) => {}
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Err(AppError::Other("talk shell channel closed during init".into()));
            }
        }
    }
    Err(AppError::Other("talk shell did not become ready".into()))
}

fn ansi_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()#][0-9A-Za-z]|\x1b[=>]|[\x00\x07]",
        )
        .unwrap()
    })
}

/// Strip ANSI escapes, normalize PTY CRLFs, and trim — for the captured result.
fn clean_output(s: &str) -> String {
    let no_ansi = ansi_re().replace_all(s, "");
    no_ansi.replace("\r\n", "\n").replace('\r', "").trim().to_string()
}

/// Light cleanup for live chunks: keep ANSI (xterm renders it) but drop the bare
/// RS bytes our marker uses, so a stray RS never reaches xterm.
fn clean_inline(s: &str) -> String {
    s.replace('\u{1e}', "")
}

/// Join the non-empty parts with newlines (for assembling partial + tail + note).
fn join_nonempty(parts: &[&str]) -> String {
    parts
        .iter()
        .filter(|p| !p.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("\n")
}

/// Remove leftover prompt-marker noise (RS bytes / a partial marker for THIS
/// session's nonce) — used on best-effort partial output where a marker may be
/// unterminated. Nonce-scoped so a literal `OCTO_DONE_` in real output is kept.
fn strip_octo_markers(s: &str, nonce: &str) -> String {
    let re = regex::Regex::new(&format!(
        r"\x1e+|OCTO_DONE_{}(?::-?\d*:?[^\n\x1e]*)?",
        regex::escape(nonce)
    ))
    .expect("valid marker-strip regex");
    re.replace_all(s, "").trim().to_string()
}

/// Cap output at `max` bytes, keeping its head and tail on char boundaries
/// (the tail weighted when the command `failed`) and marking the gap.
fn cap_output(s: String, max: usize, failed: bool) -> String {
    if s.len() <= max {
        return s;
    }
    crate::chat_history::command_excerpt(&s, max, failed, "")
}

#[cfg(test)]
mod tests {
    use super::*;

    const RS: char = '\u{1e}';
    const N: &str = "abc123";

    /// A `cd` goes where the path check reads it (#1229): no `CDPATH`.
    #[test]
    fn a_strict_shell_is_wanted_in_ask_first_and_plan_only_and_drops_aliases_and_functions() {
        let shell = TalkShell::new();
        assert_eq!(shell.strictness("t"), Strictness::Unchecked, "no shell yet: no read-only verdict");
        assert!(shell.set_strict("t", true), "entering: the shell starts fresh");
        assert!(!shell.set_strict("t", true), "staying: it doesn't");
        assert!(!shell.set_strict("t", false));
        assert!(shell.set_strict("t", true), "back again: fresh again");
        let lines = strict_shell_lines("N0NCE", "T4G");
        let (first, second) = lines.split_once('\n').unwrap();
        for part in ["POSIXLY_CORRECT=1; \\trap - DEBUG RETURN ERR EXIT;", "\\unset -f unset builtin", "\\builtin unalias -a", "\\builtin shopt -u expand_aliases", "\\builtin unset PROMPT_COMMAND PS0 command_not_found_handle", "PS1=''"] {
            assert!(first.contains(part), "{part}");
        }
        for part in ["\\builtin unset -f \"$__octo_f\"", "< <(\\builtin declare -F)", "< <(\\builtin alias)", "< <(\\builtin trap -p)", "OCTO_STRICT_%s", " T4G ", "${PROMPT_COMMAND+set}", " N0NCE "] {
            assert!(second.contains(part), "{part}");
        }
        assert!(!lines.contains("OCTO_DONE_N0NCE"), "the marker is never in the shell's source");
    }

    /// The shell counts as strict only when its report says nothing is left.
    #[test]
    fn a_strict_report_must_say_zero_for_everything() {
        assert_eq!(strict_report("noise\nOCTO_STRICT_t1:0:0:0:\n", "t1"), Ok(()));
        let failed = strict_report("OCTO_STRICT_t1:0:1:0:\n", "t1").unwrap_err();
        assert_eq!(failed, "after its cleanup the shell still has 0 alias(es), 1 function(s) and 0 trap(s)");
        assert!(strict_report("OCTO_STRICT_t1:0:0:1:set\n", "t1").unwrap_err().ends_with("and 1 trap(s), and PROMPT_COMMAND is still set"));
        assert_eq!(strict_report("OCTO_STRICT_other:0:0:0:\n", "t1"), Err("the shell sent no report after its cleanup".into()), "another tag isn't the report");
        assert!(strict_report("", "t1").is_err());
    }

    #[test]
    fn the_shell_runs_without_cdpath() {
        assert!(SHELL_INPUT_AS_WRITTEN.starts_with("set +H; unset CDPATH;"), "{SHELL_INPUT_AS_WRITTEN}");
        // Split, so this test's own text isn't what it finds.
        let line = ["init.push_str(\"__octo_oc=0; PROMPT_COMMAND='", "__octo_oc=$?; set +H; unset CDPATH; __octo_setps'"].concat();
        assert!(include_str!("talk_shell.rs").contains(&line), "every prompt clears it again");
    }

    #[test]
    fn the_login_path_line_runs_once_and_quotes_the_path() {
        assert_eq!(
            login_path_line("/opt/homebrew/bin:/usr/bin"),
            "[ -n \"${__octo_lp-}\" ] || { export PATH='/opt/homebrew/bin:/usr/bin'; __octo_lp=1; }\n"
        );
        assert!(login_path_line("/a b/it's:/bin").contains("export PATH='/a b/it'\\''s:/bin';"));
    }

    #[test]
    fn spawn_env_adds_the_extra_variables_but_keeps_path() {
        let extra = vec![
            ("OCTOPUSH_PORT".to_string(), "40010".to_string()),
            ("PATH".to_string(), "/evil".to_string()),
        ];
        let env = spawn_env("/usr/bin", &extra);
        assert_eq!(env["PATH"], "/usr/bin");
        assert_eq!(env["OCTOPUSH_PORT"], "40010");
        assert_eq!(spawn_env("/usr/bin", &[]).len(), 1);
    }

    /// One command's captured stream: output then the prompt marker.
    fn stream_buf(output: &str, code: i32, cwd: &str) -> String {
        format!("{output}{RS}{RS}OCTO_DONE_{N}:{code}:{cwd}{RS}{RS}\n")
    }

    fn first_done(buf: &str) -> (String, i32, String) {
        let mut f = StreamFilter::new(N);
        let (emit, done) = f.feed(buf);
        let (code, cwd) = done.expect("marker present");
        (emit, code, cwd)
    }

    #[test]
    fn filter_parses_output_exit_and_cwd() {
        let (out, code, cwd) = first_done(&stream_buf("hello world\r\n", 0, "/repo/src"));
        assert!(out.contains("hello world"));
        assert_eq!((code, cwd.as_str()), (0, "/repo/src"));
    }

    #[test]
    fn filter_handles_nonzero_exit_and_keeps_ansi() {
        let (out, code, _cwd) = first_done(&stream_buf("\x1b[31mboom\x1b[0m\r\n", 1, "/tmp"));
        assert!(out.contains("\x1b[31mboom"), "ANSI kept for xterm: {out:?}");
        assert_eq!(code, 1);
    }

    #[test]
    fn filter_cwd_with_colon_survives() {
        let (_o, code, cwd) = first_done(&stream_buf("ok", 130, "/weird:path"));
        assert_eq!((code, cwd.as_str()), (130, "/weird:path"));
    }

    #[test]
    fn filter_emits_progressively_then_reports_exit() {
        let mut f = StreamFilter::new(N);
        let (e1, d1) = f.feed(&"x".repeat(200));
        assert!(d1.is_none());
        assert_eq!(e1.len(), 200, "non-marker output emitted immediately");
        let (e2, d2) = f.feed(&format!("tail{RS}{RS}OCTO_DONE_{N}:0:/srv{RS}{RS}\n"));
        assert_eq!(d2.expect("done").0, 0);
        assert!(e2.contains("tail") && !e2.contains("OCTO_DONE"));
    }

    #[test]
    fn filter_handles_marker_split_across_chunks() {
        let mut f = StreamFilter::new(N);
        let marker = format!("{RS}{RS}OCTO_DONE_{N}:7:/p{RS}{RS}\n");
        let (a, b) = marker.split_at(marker.len() / 2);
        let (_e1, d1) = f.feed(&format!("output\n{a}"));
        assert!(d1.is_none(), "half a marker must not terminate");
        let (e2, d2) = f.feed(b);
        assert_eq!(d2.expect("reassembled").0, 7);
        assert!(!e2.contains("OCTO_DONE"));
    }

    #[test]
    fn probe_done_parses_via_done_re() {
        // parse the same way probe() does, on a synthetic completed buffer.
        let buf = stream_buf("result line\r\n", 0, "/x");
        let caps = done_re(N).captures(&buf).unwrap();
        let out = clean_output(&buf[..caps.get(0).unwrap().start()]);
        assert_eq!(out, "result line");
        assert_eq!(&caps[1], "0");
        assert_eq!(&caps[2], "/x");
    }

    #[test]
    fn filter_does_not_freeze_on_stray_record_separator() {
        let mut f = StreamFilter::new(N);
        // A raw RS that isn't forming our marker must be emitted (stripped), not
        // held until the process exits.
        let (emit, done) = f.feed("data\u{1e}more output here");
        assert!(done.is_none());
        assert!(emit.contains("data") && emit.contains("more output here"), "{emit:?}");
        assert!(!emit.contains('\u{1e}'), "RS stripped from emit");
    }

    #[test]
    fn filter_holds_a_genuine_forming_marker() {
        let mut f = StreamFilter::new(N);
        // A trailing partial marker prefix is held until it completes.
        let (e1, d1) = f.feed(&format!("out{RS}{RS}OCTO_DONE_"));
        assert!(d1.is_none() && e1 == "out", "forming marker held: {e1:?}");
        let (_e2, d2) = f.feed(&format!("{N}:0:/x{RS}{RS}"));
        assert_eq!(d2.expect("completes").0, 0);
    }

    #[test]
    fn strip_octo_markers_removes_partial_marker() {
        let s = format!("partial output{RS}{RS}OCTO_DONE_{N}:0:");
        let cleaned = strip_octo_markers(&s, N);
        assert_eq!(cleaned, "partial output");
    }

    #[test]
    fn cap_output_truncates_on_char_boundary() {
        let capped = cap_output("é".repeat(40_000), MAX_OUTPUT_BYTES, false);
        assert!(capped.len() <= MAX_OUTPUT_BYTES + 64);
        assert!(capped.contains("chars omitted"));
    }

    #[test]
    fn cap_output_keeps_the_tail_of_a_failed_command() {
        let out = format!("HEAD\n{}\nassertion failed: left == right", "x".repeat(200_000));
        let capped = cap_output(out.clone(), MAX_OUTPUT_BYTES, true);
        assert!(capped.starts_with("HEAD") && capped.ends_with("assertion failed: left == right"), "both ends survive");
        let tail = &capped[capped.find("omitted]").unwrap()..];
        assert!(tail.len() > MAX_OUTPUT_BYTES / 2, "a failure keeps more of the end");
        assert_eq!(cap_output(out.clone(), crate::chat_history::COMMAND_CAPTURE_BYTES, true), out, "the agent's capture keeps it whole");
    }

    #[test]
    fn nonces_are_unique() {
        assert_ne!(gen_nonce(), gen_nonce());
    }
}

#[cfg(all(test, unix))]
mod e2e {
    use super::*;
    use serial_test::serial;
    use std::fs;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;
    use tempfile::TempDir;

    fn find_daemon_bin() -> PathBuf {
        crate::test_support::pty_server_bin()
    }

    fn start_daemon(home: &std::path::Path) -> std::process::Child {
        let child = Command::new(find_daemon_bin())
            .env("HOME", home)
            .env("OCTOPUSH_PTY_AUTO_EXIT_SECS", "20")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn daemon");
        std::thread::sleep(Duration::from_millis(250));
        child
    }

    fn wait_for_socket(sock: &PathBuf) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if sock.exists() && std::os::unix::net::UnixStream::connect(sock).is_ok() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    fn shell_on(sock: &PathBuf) -> TalkShell {
        let client = DaemonClient::connect_to(sock.to_str().unwrap()).unwrap();
        let shell = TalkShell::new();
        shell.set_client(Some(client));
        shell
    }

    fn done(o: RunOutcome) -> ShellResult {
        match o {
            RunOutcome::Done(r) => r,
            RunOutcome::Live(_) => panic!("expected Done, got Live"),
            RunOutcome::Busy => panic!("expected Done, got Busy"),
        }
    }

    fn cap(o: CaptureOutcome) -> ShellResult {
        match o {
            CaptureOutcome::Done(r) => r,
            CaptureOutcome::Busy => panic!("expected Done, got Busy"),
        }
    }

    struct Daemon {
        _tmp: TempDir,
        child: std::process::Child,
        sock: PathBuf,
    }
    fn boot() -> Daemon {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join(".octopush");
        fs::create_dir_all(&base).unwrap();
        let sock = base.join("pty-server.sock");
        let child = start_daemon(tmp.path());
        assert!(wait_for_socket(&sock), "daemon socket did not appear");
        Daemon { _tmp: tmp, child, sock }
    }
    impl Drop for Daemon {
        fn drop(&mut self) {
            self.child.kill().ok();
        }
    }

    #[test]
    #[serial]
    fn quick_capture_persists_cwd_and_promotes_long_commands() {
        let d = boot();
        let shell = shell_on(&d.sock);
        let quick = Duration::from_secs(5);

        let r = done(shell.run("t", "/tmp", "echo hello world", quick, true).unwrap());
        assert_eq!(r.output, "hello world");
        assert!(r.ok);
        assert_eq!(r.exit_code, 0);

        let r = done(shell.run("t", "/tmp", "false", quick, true).unwrap());
        assert_eq!(r.exit_code, 1);
        assert!(!r.ok);

        done(shell.run("t", "/tmp", "cd /tmp", quick, true).unwrap());
        let r = done(shell.run("t", "/tmp", "pwd", quick, true).unwrap());
        assert!(r.output.ends_with("tmp"), "cwd not inherited: {:?}", r.output);

        // A long command promotes; streaming it yields all output + a clean exit.
        let live = match shell
            .run("t", "/tmp", "echo live-start; sleep 1; echo live-done", Duration::from_millis(300), true)
            .unwrap()
        {
            RunOutcome::Live(l) => l,
            _ => panic!("expected promotion to Live"),
        };
        assert!(matches!(shell.run("t", "/tmp", "echo x", quick, true).unwrap(), RunOutcome::Busy));
        let chunks = Arc::new(StdMutex::new(String::new()));
        let c2 = Arc::clone(&chunks);
        let exit = live.stream(move |s| c2.lock().unwrap().push_str(s));
        let streamed = chunks.lock().unwrap().clone();
        assert!(streamed.contains("live-start") && streamed.contains("live-done"), "{streamed:?}");
        assert!(!streamed.contains("OCTO_DONE"), "marker leaked: {streamed:?}");
        assert_eq!(exit.exit_code, 0);

        let r = done(shell.run("t", "/tmp", "echo back", quick, true).unwrap());
        assert_eq!(r.output, "back");

        shell.close("t");
    }

    #[test]
    #[serial]
    fn reattaches_to_surviving_shell_across_restart() {
        let d = boot();
        let quick = Duration::from_secs(5);
        {
            let shell = shell_on(&d.sock);
            done(shell.run("persist", "/", "cd /tmp && export OCTO_T3=kept", quick, true).unwrap());
            let r = done(shell.run("persist", "/", "pwd", quick, true).unwrap());
            assert!(r.output.ends_with("tmp"));
            // `shell` drops here — simulating an Octopush restart.
        }
        {
            let shell = shell_on(&d.sock);
            let r = done(shell.run("persist", "/", "pwd", quick, true).unwrap());
            assert!(r.output.ends_with("tmp"), "cwd not restored: {:?}", r.output);
            let r = done(shell.run("persist", "/", "echo \"$OCTO_T3\"", quick, true).unwrap());
            assert_eq!(r.output, "kept", "env var not restored on reattach");
            shell.close("persist");
        }
    }

    #[test]
    #[serial]
    fn agent_capture_shares_cwd_and_env_with_direct_shell() {
        let d = boot();
        let shell = shell_on(&d.sock);
        let quick = Duration::from_secs(5);

        done(shell.run("u", "/", "cd /tmp && export OCTO_T4=shared", quick, true).unwrap());
        let r = cap(shell.run_capture("u", "/", "pwd", quick).unwrap());
        assert!(r.output.ends_with("tmp"), "agent didn't share cwd: {:?}", r.output);
        let r = cap(shell.run_capture("u", "/", "echo \"$OCTO_T4\"", quick).unwrap());
        assert_eq!(r.output, "shared", "agent didn't share env");

        // A hanging agent command is interrupted — env survives (no recycle).
        let r = cap(shell.run_capture("u", "/", "sleep 30", Duration::from_secs(1)).unwrap());
        assert!(!r.ok && r.output.contains("was interrupted"), "{:?}", r.output);
        let r = cap(shell.run_capture("u", "/", "echo \"$OCTO_T4\"", quick).unwrap());
        assert_eq!(r.output, "shared", "env lost after a timeout interrupt");

        shell.close("u");
    }

    /// The workspace's port block (#1219) is in the thread's shell, for `$`
    /// commands and the agent's alike.
    #[test]
    #[serial]
    fn the_shell_starts_with_the_workspace_ports() {
        let d = boot();
        let shell = shell_on(&d.sock);
        let quick = Duration::from_secs(5);
        shell.set_spawn_env("ports", crate::workspace_ports::PortBlock::new(40060).env());

        let r = done(shell.run("ports", "/tmp", "echo \"$OCTOPUSH_PORT/$OCTOPUSH_PORT_COUNT/$CONDUCTOR_PORT\"", quick, true).unwrap());
        assert_eq!(r.output, "40060/10/40060");
        let r = cap(shell.run_capture("ports", "/tmp", "echo \"$OCTOPUSH_PORT\"", quick).unwrap());
        assert_eq!(r.output, "40060");

        shell.close("ports");
    }

    #[test]
    #[serial]
    fn live_process_accepts_interactive_stdin() {
        let d = boot();
        let shell = shell_on(&d.sock);

        // `cat` reads stdin and echoes it; it blocks → promotes to a live process.
        let live = match shell
            .run("i", "/tmp", "cat", Duration::from_millis(400), true)
            .unwrap()
        {
            RunOutcome::Live(l) => l,
            _ => panic!("expected cat to promote to a live process"),
        };

        let chunks = Arc::new(StdMutex::new(String::new()));
        let exit = std::thread::scope(|s| {
            s.spawn(|| {
                std::thread::sleep(Duration::from_millis(300));
                shell.write_stdin("i", b"hello from stdin\n");
                std::thread::sleep(Duration::from_millis(300));
                shell.write_stdin("i", b"\x04"); // Ctrl-D → cat exits → bash prompts
            });
            let c2 = Arc::clone(&chunks);
            live.stream(move |x| c2.lock().unwrap().push_str(x))
        });

        let streamed = chunks.lock().unwrap().clone();
        assert!(
            streamed.contains("hello from stdin"),
            "interactive stdin not echoed by the live process: {streamed:?}"
        );
        assert!(!streamed.contains("OCTO_DONE"), "marker leaked: {streamed:?}");
        // The prompt marker fired even though cat is interactive — the panel
        // closes cleanly and the shell is reusable.
        let _ = exit;
        let r = cap(shell.run_capture("i", "/tmp", "echo done", Duration::from_secs(5)).unwrap());
        assert_eq!(r.output, "done");

        shell.close("i");
    }

    #[test]
    #[serial]
    fn live_process_stop_via_interrupt_ends_cleanly() {
        let d = boot();
        let shell = shell_on(&d.sock);

        // A non-stdin long process (sleep); Stop (Ctrl-C) must end the stream —
        // the prompt marker fires after the kill (the old trailer would've been
        // flushed by SIGINT and hung).
        let live = match shell
            .run("s", "/tmp", "sleep 60", Duration::from_millis(300), true)
            .unwrap()
        {
            RunOutcome::Live(l) => l,
            _ => panic!("expected sleep to promote"),
        };
        let collected = Arc::new(StdMutex::new(String::new()));
        let exit = std::thread::scope(|s| {
            s.spawn(|| {
                std::thread::sleep(Duration::from_millis(300));
                shell.interrupt("s"); // Stop button
            });
            let c2 = Arc::clone(&collected);
            live.stream(move |x| c2.lock().unwrap().push_str(x))
        });
        // 130 = 128 + SIGINT(2).
        assert_eq!(exit.exit_code, 130, "Stop didn't end the stream cleanly");

        // Shell is immediately reusable after Stop (env/cwd intact, no recycle).
        let r = cap(shell.run_capture("s", "/tmp", "echo after-stop", Duration::from_secs(5)).unwrap());
        assert_eq!(r.output, "after-stop");

        shell.close("s");
    }

    /// The agent's commands reach bash as written: a `!` isn't taken as a
    /// history expansion and a TAB isn't taken as a completion request, so a
    /// heredoc keeps its tabs (both reproduced against an interactive PTY
    /// bash before the fix).
    #[test]
    #[serial]
    fn commands_with_a_bang_or_a_tab_run_as_written() {
        let d = boot();
        let shell = shell_on(&d.sock);
        let quick = Duration::from_secs(5);

        let r = cap(shell.run_capture("h", "/tmp", r#"echo "if (!fs.existsSync(p)) ok"; echo "done!""#, quick).unwrap());
        assert_eq!(r.output, "if (!fs.existsSync(p)) ok\ndone!", "history expansion rewrote the command");
        assert!(r.ok);
        // `$` commands share the shell, and its settings.
        let r = done(shell.run("h", "/tmp", r#"echo "ok!then""#, quick, true).unwrap());
        assert_eq!(r.output, "ok!then");
        // A command that turns history expansion back on doesn't keep it on.
        done(shell.run("h", "/tmp", "set -H", quick, true).unwrap());
        let r = cap(shell.run_capture("h", "/tmp", r#"echo "again!x""#, quick).unwrap());
        assert_eq!(r.output, "again!x", "the next prompt turns it off again");

        let dir = TempDir::new().unwrap();
        let makefile = dir.path().join("Makefile");
        let heredoc = format!("cat > '{}' <<'EOF'\nall:\n\t@echo ok\nEOF", makefile.display());
        let r = cap(shell.run_capture("h", "/tmp", &heredoc, quick).unwrap());
        assert!(r.ok, "{:?}", r.output);
        assert_eq!(fs::read_to_string(&makefile).unwrap(), "all:\n\t@echo ok\n", "the heredoc lost its tab");
        // A TAB mid-line, where completion would have looked for matches.
        let r = cap(shell.run_capture("h", "/tmp", "printf '%s' 'a\tb' | od -c | head -n 1", quick).unwrap());
        assert!(r.output.contains("\\t"), "the TAB didn't reach printf: {:?}", r.output);

        shell.close("h");
    }

    /// A shell started by an older build, without those settings, gets them
    /// on its first reattach.
    #[test]
    #[serial]
    fn a_shell_from_an_older_build_runs_commands_as_written_after_reattach() {
        let d = boot();
        let quick = Duration::from_secs(5);
        let old = DaemonClient::connect_to(d.sock.to_str().unwrap()).unwrap();
        let env = HashMap::from([("PATH".to_string(), "/usr/bin:/bin".to_string())]);
        old.spawn("talk-older", "/tmp", &env, Some("/bin/bash"), 40, 120).unwrap();
        let shell = shell_on(&d.sock);
        let r = cap(shell.run_capture("older", "/tmp", r#"echo "if (!x) ok""#, quick).unwrap());
        assert_eq!(r.output, "if (!x) ok");
        shell.close("older");
    }

    /// A conversation's shell started by an older build, without git's
    /// bare-repository hardening, gets it on reattach; one whose environment
    /// lost it gets it back, and it is never added twice (#1231).
    #[test]
    #[serial]
    fn a_reattached_shell_gets_git_hardening() {
        use crate::orchestrator::cli_runner::with_login_shell_env;
        let d = boot();
        // Roomy: a busy CI runner can take seconds to bring a shell up.
        let quick = Duration::from_secs(20);
        let old = DaemonClient::connect_to(d.sock.to_str().unwrap()).unwrap();
        let env = HashMap::from([("PATH".to_string(), "/usr/bin:/bin".to_string())]);
        old.spawn("talk-oldgit", "/tmp", &env, Some("/bin/bash"), 40, 120).unwrap();
        with_login_shell_env(&[], || {
            let probe = "printf '%s|%s' \"$(git config --get safe.bareRepository)\" \"$GIT_CONFIG_COUNT\"";
            {
                let shell = shell_on(&d.sock);
                let r = cap(shell.run_capture("oldgit", "/tmp", probe, quick).unwrap());
                assert_eq!(r.output, "explicit|1", "the reattached shell has the hardening");
                done(shell.run("oldgit", "/tmp", "unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0", quick, true).unwrap());
                // `shell` drops here, as at an Octopush restart.
            }
            {
                let shell = shell_on(&d.sock);
                let r = cap(shell.run_capture("oldgit", "/tmp", probe, quick).unwrap());
                assert_eq!(r.output, "explicit|1", "a shell that lost it gets it back");
            }
            let shell = shell_on(&d.sock);
            let r = cap(shell.run_capture("oldgit", "/tmp", probe, quick).unwrap());
            assert_eq!(r.output, "explicit|1", "never added twice");
            shell.close("oldgit");
        });
    }

    /// A reattached shell's directory isn't known until it reports it, so no
    /// grant, bound to a folder, matches it before then (#1231): the shell
    /// may sit anywhere after a restart.
    #[test]
    #[serial]
    fn a_reattached_shells_unknown_directory_matches_no_grant() {
        use crate::orchestrator::cli_runner::with_login_shell_env;
        use crate::talk_guard::{Grant, GrantKind};
        let d = boot();
        let old = DaemonClient::connect_to(d.sock.to_str().unwrap()).unwrap();
        let env = HashMap::from([("PATH".to_string(), "/usr/bin:/bin".to_string())]);
        old.spawn("talk-oldcwd", "/tmp", &env, Some("/bin/bash"), 40, 120).unwrap();
        let grant = Grant { kind: GrantKind::Command, value: "ls".into(), shown: "ls".into() };
        with_login_shell_env(&[], || {
            let shell = shell_on(&d.sock);
            assert_eq!(shell.cwd("oldcwd"), None, "reattached: where it sits isn't read yet");
            assert!(crate::chat_engine::grants_where(true, shell.cwd("oldcwd").as_deref(), vec![grant.clone()]).is_empty());
            done(shell.run("oldcwd", "/tmp", "true", Duration::from_secs(20), true).unwrap());
            assert!(shell.cwd("oldcwd").is_some(), "known once it has run");
            assert_eq!(crate::chat_engine::grants_where(true, shell.cwd("oldcwd").as_deref(), vec![grant.clone()]), vec![grant.clone()]);
            assert_eq!(crate::chat_engine::grants_where(false, None, vec![grant.clone()]).len(), 1, "off the shared shell, it starts at the root");
            shell.close("oldcwd");
        });
    }

    /// Ask first, then Edit freely, where the agent defines `ls`, then Ask
    /// first again: the shell starts fresh and is cleaned, so `ls` is the
    /// real one and writes nothing (#1231). What the agent left (a DEBUG
    /// trap, a `PROMPT_COMMAND`) is gone with the old shell.
    #[test]
    #[serial]
    fn a_strict_shell_survives_an_ls_defined_in_edit_freely() {
        use crate::orchestrator::cli_runner::with_login_shell_env;
        let d = boot();
        let dir = tempfile::tempdir().unwrap();
        let at = dir.path().to_string_lossy().into_owned();
        let quick = Duration::from_secs(20);
        with_login_shell_env(&[], || {
            let shell = shell_on(&d.sock);
            assert!(shell.set_strict("rt", true));
            assert_eq!(shell.restart_strict("rt", &at, "Ask first"), Strictness::Verified);
            // Edit freely: the agent defines `ls`, a DEBUG trap and a PROMPT_COMMAND.
            assert!(!shell.set_strict("rt", false));
            let plant = format!("cd '{at}' && ls(){{ touch x;}} && trap 'touch dbg' DEBUG && PROMPT_COMMAND=\"$PROMPT_COMMAND; touch pc\"");
            done(shell.run("rt", &at, &plant, quick, false).unwrap());
            assert_eq!(shell.strictness("rt"), Strictness::Unchecked);
            for f in ["dbg", "pc"] {
                let _ = std::fs::remove_file(dir.path().join(f));
            }
            // Back to Ask first: a fresh shell, in the same folder.
            assert!(shell.set_strict("rt", true));
            assert_eq!(shell.restart_strict("rt", &at, "Ask first"), Strictness::Verified);
            let r = cap(shell.run_capture_read_only("rt", &at, "ls; type -t ls; pwd", quick).unwrap());
            for f in ["x", "dbg", "pc"] {
                assert!(!dir.path().join(f).exists(), "{f}: {}", r.output);
            }
            assert!(r.output.contains("file"), "{}", r.output);
            assert!(r.output.trim_end().ends_with(dir.path().canonicalize().unwrap().to_str().unwrap()) || r.output.trim_end().ends_with(at.as_str()), "{}", r.output);
            assert_eq!(shell.strictness("rt"), Strictness::Verified, "a read-only command keeps it");
            done(shell.run("rt", &at, "true", quick, false).unwrap());
            assert_eq!(shell.strictness("rt"), Strictness::Unchecked, "anything else doesn't");
            shell.close("rt");
        });
    }

    /// The cleanup itself drops a profile's DEBUG trap, `PROMPT_COMMAND`,
    /// aliases and functions, a hijacked `builtin` included, and reports it;
    /// what it can't drop (a readonly function) fails the report.
    #[test]
    #[serial]
    fn the_cleanup_drops_traps_and_prompt_command_and_reports_what_it_cant() {
        use crate::orchestrator::cli_runner::with_login_shell_env;
        let d = boot();
        let dir = tempfile::tempdir().unwrap();
        let at = dir.path().to_string_lossy().into_owned();
        let quick = Duration::from_secs(20);
        let clean = |shell: &TalkShell, thread: &str| {
            let handle = shell.sessions.lock().get(thread).cloned().unwrap();
            let client = shell.client.lock().clone().unwrap();
            let (id, nonce, rx) = {
                let mut s = handle.lock();
                (s.id.clone(), s.nonce.clone(), s.rx.take().unwrap())
            };
            let result = apply_strict_shell(&client, &id, &rx, &nonce);
            handle.lock().rx = Some(rx);
            result
        };
        with_login_shell_env(&[], || {
            let shell = shell_on(&d.sock);
            let plant = format!(
                "cd '{at}' && alias ls='touch by-alias' && builtin(){{ :;}} && trap 'touch dbg' DEBUG && PROMPT_COMMAND=\"$PROMPT_COMMAND; touch pc\""
            );
            done(shell.run("cl", &at, &plant, quick, false).unwrap());
            assert_eq!(clean(&shell, "cl"), Ok(()));
            for f in ["dbg", "pc"] {
                let _ = std::fs::remove_file(dir.path().join(f));
            }
            let r = done(shell.run("cl", &at, "ls >/dev/null; trap -p; echo \"pc=${PROMPT_COMMAND+set}\"", quick, false).unwrap());
            assert_eq!(r.output.trim(), "pc=", "{}", r.output);
            for f in ["by-alias", "dbg", "pc"] {
                assert!(!dir.path().join(f).exists(), "{f}");
            }
            // A failed report: a readonly function can't be unset.
            done(shell.run("cl", &at, "f(){ :;}; readonly -f f", quick, false).unwrap());
            let failed = clean(&shell, "cl").unwrap_err();
            assert!(failed.contains("1 function(s)"), "{failed}");
            shell.close("cl");
        });
    }

    /// A dir holding `octo-1087-tool`, an executable found only through it.
    fn login_bin() -> TempDir {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let tool = dir.path().join("octo-1087-tool");
        fs::write(&tool, "#!/bin/sh\necho found-on-login-path\n").unwrap();
        fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).unwrap();
        dir
    }

    /// `$` commands and the agent's commands share the shell, and it gets the
    /// login PATH exactly as CLI stages do (#1087), after `bash -l`'s profile.
    #[test]
    #[serial]
    fn the_shell_gets_the_login_path_and_keeps_its_own_changes() {
        use crate::orchestrator::cli_runner::{resolved_cli_path, with_login_shell_env};
        let d = boot();
        let bin = login_bin();
        let bin_path = bin.path().to_string_lossy().into_owned();
        let quick = Duration::from_secs(5);
        let login = [("PATH", bin_path.as_str()), ("OCTO_1087_LOGIN_ONLY", "leaked")];
        with_login_shell_env(&login, || {
            let path = resolved_cli_path();
            assert!(path.starts_with(&bin_path), "{path}");
            {
                let shell = shell_on(&d.sock);
                let r = done(shell.run("lp", "/tmp", "printf '%s' \"$PATH\"", quick, true).unwrap());
                assert_eq!(r.output, path, "a `$` command gets the PATH CLI stages spawn with");
                let r = cap(shell.run_capture("lp", "/tmp", "octo-1087-tool", quick).unwrap());
                assert_eq!(r.output, "found-on-login-path", "the agent's run_command finds the login-only tool");
                let r = done(shell.run("lp", "/tmp", "echo \"${OCTO_1087_LOGIN_ONLY-unset}\"", quick, true).unwrap());
                assert_eq!(r.output, "unset", "no other login-shell variable");
                done(shell.run("lp", "/tmp", "export PATH=\"/octo-1087-own:$PATH\"", quick, true).unwrap());
                // `shell` drops here — simulating an Octopush restart.
            }
            let shell = shell_on(&d.sock);
            let r = done(shell.run("lp", "/tmp", "printf '%s' \"$PATH\"", quick, true).unwrap());
            assert_eq!(r.output, format!("/octo-1087-own:{path}"), "a reattach keeps the shell's own PATH");
            shell.close("lp");
        });
    }

    /// A conversation's shell started by an older build (the app's own PATH)
    /// gets the login PATH on its first reattach.
    #[test]
    #[serial]
    fn a_shell_from_an_older_build_gets_the_login_path_on_reattach() {
        use crate::orchestrator::cli_runner::{resolved_cli_path, with_login_shell_env};
        let d = boot();
        let bin = login_bin();
        let bin_path = bin.path().to_string_lossy().into_owned();
        let quick = Duration::from_secs(5);
        let old = DaemonClient::connect_to(d.sock.to_str().unwrap()).unwrap();
        let env = HashMap::from([("PATH".to_string(), "/usr/bin:/bin".to_string())]);
        old.spawn("talk-old", "/tmp", &env, Some("/bin/bash"), 40, 120).unwrap();
        with_login_shell_env(&[("PATH", bin_path.as_str())], || {
            let shell = shell_on(&d.sock);
            let r = cap(shell.run_capture("old", "/tmp", "octo-1087-tool", quick).unwrap());
            assert_eq!(r.output, "found-on-login-path");
            let r = done(shell.run("old", "/tmp", "printf '%s' \"$PATH\"", quick, true).unwrap());
            assert_eq!(r.output, resolved_cli_path());
            shell.close("old");
        });
    }

    /// Without the login shell's PATH (its probe failed or timed out) the
    /// shell keeps `bash -l`'s PATH: the fallback puts `/usr/bin` ahead of
    /// Homebrew.
    #[test]
    #[serial]
    fn without_a_login_path_the_shell_keeps_its_profile_path() {
        use crate::orchestrator::cli_runner::with_login_shell_env;
        let d = boot();
        let quick = Duration::from_secs(5);
        with_login_shell_env(&[("OCTO_1087_LOGIN_ONLY", "leaked")], || {
            let shell = shell_on(&d.sock);
            let r = done(shell.run("nolp", "/tmp", "echo \"${__octo_lp-unset}\"", quick, true).unwrap());
            assert_eq!(r.output, "unset", "the login PATH step didn't run");
            let r = done(shell.run("nolp", "/tmp", "echo ok", quick, true).unwrap());
            assert_eq!(r.output, "ok");
            shell.close("nolp");
        });
    }
}
