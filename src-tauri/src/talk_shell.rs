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
    git_config_after(count, &[("safe.bareRepository", "explicit")])
}

/// `pairs` as `GIT_CONFIG_*` variables after `count` entries already set:
/// the new count, then each key and value. Pure.
pub(crate) fn git_config_after(count: Option<&str>, pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    let n = count.and_then(|c| c.trim().parse::<usize>().ok()).unwrap_or(0);
    let mut env = vec![("GIT_CONFIG_COUNT".to_string(), (n + pairs.len()).to_string())];
    for (i, (key, value)) in pairs.iter().enumerate() {
        env.push((format!("GIT_CONFIG_KEY_{}", n + i), key.to_string()));
        env.push((format!("GIT_CONFIG_VALUE_{}", n + i), value.to_string()));
    }
    env
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
    /// Where the cwd its prompt reports is kept (#1231).
    cwd_store: CwdStore,
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
    /// Whether [`apply_strict_shell`] has run in it since it was attached,
    /// and no command has run in it since while its thread wasn't strict
    /// (#1231).
    strict: bool,
    /// Whether it was spawned behind its mission's process barrier and
    /// proved it holds it (`ship_barrier`, #1275).
    barrier: bool,
}

impl Session {
    /// Whether it can run a command for a thread strict for `why`: strict,
    /// and behind the barrier when its mission ships nothing.
    fn holds(&self, why: StrictFor) -> bool {
        self.strict && (why != StrictFor::ShipsNothing || self.barrier)
    }
}

pub struct TalkShell {
    client: Mutex<Option<Arc<DaemonClient>>>,
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
    /// Per thread, the variables its shell is spawned with besides PATH (the
    /// workspace's ports, #1219). A shell already running keeps its env.
    spawn_env: Mutex<HashMap<String, Vec<(String, String)>>>,
    /// The threads whose shell runs strict, and why
    /// ([`TalkShell::set_strict_for`]).
    strict: Mutex<HashMap<String, StrictFor>>,
    /// Where each thread's shell last said it sits, kept on disk (#1231).
    cwd_store: Mutex<CwdStore>,
}

impl TalkShell {
    pub fn new() -> Self {
        Self {
            client: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            spawn_env: Mutex::new(HashMap::new()),
            strict: Mutex::new(HashMap::new()),
            cwd_store: Mutex::new(CwdStore::default()),
        }
    }

    /// Keep where each thread's shell last said it sits in `dir` (`None`:
    /// nowhere), so a shell reattached after a restart can be replaced
    /// there when the OS can't say ([`replacement_dir`], #1231).
    pub fn set_cwd_store(&self, dir: Option<std::path::PathBuf>) {
        *self.cwd_store.lock() = CwdStore(dir);
    }

    /// Run the thread's shell strict, or not, from its next command: in a
    /// mission that ships nothing its commands run in a shell without the
    /// profile's aliases and functions ([`apply_strict_shell`]), so a plain
    /// word such as `gp` can't stand for `git push`. Turning it off leaves
    /// a shell that already ran strict as it is; a command run while it is
    /// off means a fresh shell once it is on again (#1231).
    pub fn set_strict(&self, thread_id: &str, strict: bool) {
        self.set_strict_for(thread_id, strict.then_some(StrictFor::ShipsNothing));
    }

    /// [`Self::set_strict`], with why the shell runs strict: its mission
    /// ships nothing, or its conversation is in Ask first or Plan only
    /// (#1231), where a word the command check reads as a reader (`ls`,
    /// `git`) must run the reader. Why names the refusal and the terminal's
    /// "Shell restarted for ..." line. `None`: not strict.
    pub fn set_strict_for(&self, thread_id: &str, why: Option<StrictFor>) {
        let mut threads = self.strict.lock();
        match why {
            Some(why) => {
                threads.insert(thread_id.to_string(), why);
            }
            None => {
                threads.remove(thread_id);
            }
        }
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
        let keep = if promote { MAX_OUTPUT_BYTES } else { crate::chat_history::COMMAND_CAPTURE_BYTES };
        self.run_kept(thread_id, workspace_path, command, timeout, promote, keep)
    }

    /// The agent's command in the thread's shell (#1160): captured as
    /// [`Self::run_capture`] captures it (up to
    /// `chat_history::COMMAND_CAPTURE_BYTES`), but a command still running at
    /// `timeout` is promoted to a live process ([`RunOutcome::Live`]), as a
    /// long `$` command is, instead of being interrupted.
    pub fn run_agent(&self, thread_id: &str, workspace_path: &str, command: &str, timeout: Duration) -> AppResult<RunOutcome> {
        self.run_kept(thread_id, workspace_path, command, timeout, true, crate::chat_history::COMMAND_CAPTURE_BYTES)
    }

    /// [`Self::run`], keeping up to `keep` bytes of a finished command's output.
    fn run_kept(
        &self,
        thread_id: &str,
        workspace_path: &str,
        command: &str,
        timeout: Duration,
        promote: bool,
        keep: usize,
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
        let strict = self.strict.lock().get(thread_id).copied();
        // In a mission that ships nothing the shell starts behind the
        // process barrier (#1275), checked (and put back where it changed)
        // before every command; no command runs without it.
        let barrier = match strict {
            Some(StrictFor::ShipsNothing) => Some(
                crate::ship_barrier::Barrier::for_workspace(std::path::Path::new(workspace_path))
                    .map_err(|e| AppError::Other(format!("{STRICT_SHELL_REFUSED} couldn't be put behind the process barrier ({e}).")))?,
            ),
            _ => None,
        };
        let handle = match existing {
            Some(h) => h,
            None => {
                let recorded = self.cwd_store.lock().read(thread_id);
                let session = Self::ensure_session(&client, thread_id, workspace_path, &extra, strict, recorded, barrier.as_ref())?;
                let h = Arc::new(Mutex::new(session));
                let mut map = self.sessions.lock();
                Arc::clone(map.entry(thread_id.to_string()).or_insert(h))
            }
        };

        // A shell that ran before its mission came to ship nothing, or
        // before its conversation entered Ask first or Plan only (#1231), is
        // never cleaned in place: what ran in it can outlast any cleanup (a
        // function named `unset`, an `ls` defined in Edit freely). A fresh
        // `bash -l` takes its place, where it was, is made strict before
        // this command, and the terminal says so. So does one spawned
        // without the process barrier its mission now needs, and one behind
        // the barrier whose thread is no longer strict.
        let replace = {
            let session = handle.lock();
            match strict {
                Some(why) => !session.holds(why),
                None => session.barrier,
            }
        };
        if replace {
            let (id, cwd) = {
                let mut session = handle.lock();
                if session.rx.take().is_none() {
                    return Ok(RunOutcome::Busy);
                }
                (session.id.clone(), session.cwd.clone())
            };
            let _ = client.remove(&id);
            let start = if std::path::Path::new(&cwd).is_dir() { cwd.as_str() } else { workspace_path };
            match Self::ensure_session(&client, thread_id, start, &extra, strict, None, barrier.as_ref()) {
                Ok(fresh) => {
                    if let (Some(why), Some(rx)) = (strict, fresh.rx.as_ref()) {
                        note_restart(&client, &fresh.id, rx, &fresh.nonce, why);
                    }
                    *handle.lock() = fresh;
                }
                Err(e) => {
                    self.sessions.lock().remove(thread_id);
                    return Err(e);
                }
            }
        }

        // Take the receiver out under the lock, then drop the lock so the drain
        // never blocks another thread. A concurrent run for THIS thread finds
        // `rx == None` and returns Busy.
        let (rx, nonce, id, cwd) = {
            let mut session = handle.lock();
            let Some(rx) = session.rx.take() else {
                return Ok(RunOutcome::Busy);
            };
            // What a command leaves while its thread isn't strict (an alias,
            // a function, a trap) is unknown: the shell starts fresh once the
            // thread is strict again (#1231).
            if strict.is_none() {
                session.strict = false;
            }
            (rx, session.nonce.clone(), session.id.clone(), session.cwd.clone())
        };

        // Discard any stale bytes (the idle prompt left in the buffer) so the
        // next prompt marker we see is unambiguously THIS command's completion.
        drain_pending(&rx);
        if let Err(e) = client.write(&id, format!("{command}\n").as_bytes()) {
            handle.lock().rx = Some(rx);
            return Err(e);
        }

        match probe(&rx, timeout, &nonce) {
            Probe::Done { output, exit_code, cwd: new_cwd } => {
                let final_cwd = if new_cwd.is_empty() { cwd } else { new_cwd };
                self.cwd_store.lock().record(thread_id, &final_cwd);
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
                match Self::ensure_session(&client, thread_id, &cwd, &extra, strict, None, barrier.as_ref()) {
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
                cwd_store: self.cwd_store.lock().clone(),
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
                        self.cwd_store.lock().record(thread_id, &final_cwd);
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
                        match Self::ensure_session(&client, thread_id, &cwd, &extra, strict, None, barrier.as_ref()) {
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
        self.strict.lock().remove(thread_id);
        self.cwd_store.lock().forget(thread_id);
        if let (Some(client), Some(handle)) = (client, handle) {
            let _ = client.remove(&handle.lock().id);
        }
    }

    /// Reattach to a surviving daemon PTY (so the shell persists across an
    /// Octopush restart) or spawn fresh; then (re-)install the prompt marker with
    /// a fresh nonce and wait until the shell confirms ready. Returns the cwd.
    /// A `strict` shell is never reattached: the surviving one may have run
    /// before its mission came to ship nothing, or in Edit freely (#1231),
    /// so it is replaced by a fresh `bash -l` where it was, and the terminal
    /// says so. Nothing is ever typed into it first: an init would run its
    /// DEBUG trap, `PROMPT_COMMAND` and functions, with no card. Where it
    /// sat comes from the OS ([`replacement_dir`]; `recorded`, the directory
    /// its prompt last reported, when the OS can't say), and a job from
    /// before the restart that holds its terminal keeps it alive. A strict
    /// shell runs [`apply_strict_shell`] before anything else, and no
    /// command runs in it unless that proved it clean. With a `barrier` (a
    /// mission that ships nothing) it is spawned behind it, and the cleanup
    /// puts it back after the profile and proves it holds.
    #[allow(clippy::too_many_arguments)]
    fn ensure_session(
        client: &Arc<DaemonClient>,
        thread_id: &str,
        cwd: &str,
        extra: &[(String, String)],
        strict: Option<StrictFor>,
        recorded: Option<String>,
        barrier: Option<&crate::ship_barrier::Barrier>,
    ) -> AppResult<Session> {
        let id = format!("talk-{thread_id}");
        let live = client.list_terminals().unwrap_or_default().into_iter().find(|t| t.id == id && t.running);
        let mut reattaching = live.is_some();
        let mut cwd = cwd.to_string();
        let replaced = reattaching && strict.is_some();
        if replaced {
            let process = live.and_then(|t| t.pid).map(shell_process).unwrap_or_default();
            if process.busy {
                return Err(AppError::Other(SHELL_BUSY.into()));
            }
            cwd = replacement_dir(process.cwd, recorded, &cwd);
            client.remove(&id)?;
            reattaching = false;
        }

        // The PATH CLI stages spawn with, and no other login-shell variable.
        let path = crate::orchestrator::cli_runner::resolved_cli_path();
        // Without the login shell's own PATH (its probe failed or timed out),
        // `path` is only the app's PATH and the common dirs, which puts
        // `/usr/bin` ahead of Homebrew: leave `bash -l`'s PATH alone then.
        let has_login_path = crate::orchestrator::cli_runner::login_env_path().is_some();
        if !reattaching {
            Self::spawn_bash(client, &id, &cwd, &spawn_env(&path, extra), barrier)?;
        }
        let nonce = gen_nonce();
        let rx = client.attach(&id, 0)?;

        match init_and_wait_ready(client, &id, &rx, &nonce) {
            Ok(ready_cwd) => {
                if has_login_path {
                    apply_login_path(client, &id, &rx, &nonce, &path);
                }
                if let Some(reason) = strict {
                    if let Err(why) = apply_strict_shell(client, &id, &rx, &nonce, barrier) {
                        let _ = client.remove(&id);
                        return Err(AppError::Other(format!("{} {why}.", reason.refused())));
                    }
                    if replaced {
                        note_restart(client, &id, &rx, &nonce, reason);
                    }
                }
                // A reattached shell may predate the hardening, or a command
                // in it may have dropped it (#1231). After the strict cleanup,
                // so its words are the builtins.
                apply_git_hardening(client, &id, &rx, &nonce);
                Ok(Session {
                    id,
                    rx: Some(rx),
                    cwd: ready_cwd.unwrap_or_else(|| cwd.clone()),
                    nonce,
                    strict: strict.is_some(),
                    barrier: strict.is_some() && barrier.is_some(),
                })
            }
            // Reattached but never ready — the surviving shell is busy with a
            // process from before the restart. Do NOT kill it; surface an error.
            Err(_) if reattaching => Err(AppError::Other(SHELL_BUSY.into())),
            Err(e) => {
                let _ = client.remove(&id);
                Err(e)
            }
        }
    }

    /// Spawn the thread's `bash -l` with `env` and git's hardening; behind
    /// `barrier`, with its variables too ([`crate::ship_barrier::Barrier::env`])
    /// and each token it scrubs set empty, since the daemon only sets
    /// variables. The profile runs after this, so the strict cleanup puts the
    /// barrier back once it has ([`apply_strict_shell`]).
    fn spawn_bash(
        client: &Arc<DaemonClient>,
        id: &str,
        cwd: &str,
        env: &HashMap<String, String>,
        barrier: Option<&crate::ship_barrier::Barrier>,
    ) -> AppResult<()> {
        let mut env = env.clone();
        match barrier {
            Some(barrier) => {
                let path = env.get("PATH").cloned().unwrap_or_default();
                let count = std::env::var("GIT_CONFIG_COUNT").ok();
                env.extend(barrier.env(&path, count.as_deref()));
                for name in crate::ship_barrier::SCRUBBED {
                    env.insert(name.to_string(), String::new());
                }
            }
            None => env.extend(git_hardening_env()),
        }
        client.spawn(id, cwd, &env, Some(TALK_BASH), 40, 120)?;
        Ok(())
    }
}

/// Why a reattached shell runs nothing: it never came back to its prompt,
/// or a job from before the restart holds its terminal.
const SHELL_BUSY: &str = "This conversation's shell is busy with a process still running from before \
    the restart. Wait for it to finish, or delete the conversation to stop it.";

/// What the OS says about a reattached shell's process, read without typing
/// anything into it (#1231).
#[derive(Debug, Default, PartialEq)]
struct ShellProcess {
    /// Where it sits.
    cwd: Option<String>,
    /// A job holds its terminal: the terminal's foreground process group
    /// isn't the shell's.
    busy: bool,
}

/// [`ShellProcess`] for `pid`. Unknown parts stay empty: no directory, not
/// busy.
fn shell_process(pid: u32) -> ShellProcess {
    ShellProcess { cwd: process_cwd(pid), busy: process_busy(pid) }
}

/// The working directory of `pid`, from the kernel (`proc_pidinfo` with
/// `PROC_PIDVNODEPATHINFO`).
#[cfg(target_os = "macos")]
fn process_cwd(pid: u32) -> Option<String> {
    let pid = libc::c_int::try_from(pid).ok()?;
    // SAFETY: a plain C struct, valid zeroed; `proc_pidinfo` writes at most
    // `size` bytes into it, which is its size, and fails on a bad pid.
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = libc::c_int::try_from(std::mem::size_of::<libc::proc_vnodepathinfo>()).ok()?;
    let wrote = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDVNODEPATHINFO, 0, (&mut info as *mut libc::proc_vnodepathinfo).cast(), size) };
    if wrote != size {
        return None;
    }
    let path: Vec<u8> = info.pvi_cdir.vip_path.iter().flatten().map(|&c| c as u8).take_while(|&b| b != 0).collect();
    String::from_utf8(path).ok().filter(|p| p.starts_with('/'))
}

/// Whether a job holds the terminal of `pid` (`proc_pidinfo` with
/// `PROC_PIDTBSDINFO`: the terminal's foreground group against the
/// process's own).
#[cfg(target_os = "macos")]
fn process_busy(pid: u32) -> bool {
    let Ok(pid) = libc::c_int::try_from(pid) else { return false };
    // SAFETY: as in `process_cwd`.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let Ok(size) = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdinfo>()) else { return false };
    let wrote = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
    wrote == size && info.e_tpgid != 0 && info.e_tpgid != info.pbi_pgid
}

/// The process group a job holds `pid`'s terminal with, when one does
/// (#1160): the group to signal to stop a command running in a shell,
/// without typing into the shell. `None` while the shell is at its prompt,
/// or when the OS can't say.
#[cfg(target_os = "macos")]
pub(crate) fn foreground_group(pid: u32) -> Option<i32> {
    let pid = libc::c_int::try_from(pid).ok()?;
    // SAFETY: as in `process_cwd`.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).ok()?;
    let wrote = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
    let held = wrote == size && info.e_tpgid != 0 && info.e_tpgid != info.pbi_pgid;
    held.then(|| i32::try_from(info.e_tpgid).ok()).flatten()
}

#[cfg(target_os = "linux")]
pub(crate) fn foreground_group(pid: u32) -> Option<i32> {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).ok().and_then(|stat| stat_job_group(&stat))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(crate) fn foreground_group(_pid: u32) -> Option<i32> {
    None
}

/// When `pid` started, as an opaque stamp from the OS (#1160): with the
/// pid, it names one process, so a pid used again later never matches.
/// `None` when the process is gone or the OS can't say.
#[cfg(target_os = "macos")]
pub(crate) fn process_started(pid: u32) -> Option<u64> {
    let pid = libc::c_int::try_from(pid).ok()?;
    // SAFETY: as in `process_cwd`.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).ok()?;
    let wrote = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
    (wrote == size).then(|| info.pbi_start_tvsec.wrapping_mul(1_000_000).wrapping_add(info.pbi_start_tvusec))
}

#[cfg(target_os = "linux")]
pub(crate) fn process_started(pid: u32) -> Option<u64> {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).ok().and_then(|stat| stat_started(&stat))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(crate) fn process_started(_pid: u32) -> Option<u64> {
    None
}

/// A `/proc/<pid>/stat` line's `starttime` (its 22nd field: clock ticks
/// after boot). Pure.
#[cfg(any(target_os = "linux", test))]
fn stat_started(stat: &str) -> Option<u64> {
    stat.rsplit_once(')')?.1.split_whitespace().nth(19)?.parse().ok()
}

/// The group a job holds the terminal with, from a `/proc/<pid>/stat`
/// line: its `tpgid`, when set and not the process's own `pgrp`. Pure.
#[cfg(any(target_os = "linux", test))]
fn stat_job_group(stat: &str) -> Option<i32> {
    let fields: Vec<&str> = stat.rsplit_once(')')?.1.split_whitespace().collect();
    let pgrp: i64 = fields.get(2)?.parse().ok()?;
    let tpgid: i64 = fields.get(5)?.parse().ok()?;
    (tpgid > 0 && tpgid != pgrp).then(|| i32::try_from(tpgid).ok()).flatten()
}

#[cfg(target_os = "linux")]
fn process_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()?.to_str().map(str::to_string)
}

#[cfg(target_os = "linux")]
fn process_busy(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).ok().and_then(|stat| stat_busy(&stat)).unwrap_or(false)
}

/// Whether a `/proc/<pid>/stat` line says a job holds the process's
/// terminal: its `tpgid` set and not its `pgrp`. Pure.
#[cfg(any(target_os = "linux", test))]
fn stat_busy(stat: &str) -> Option<bool> {
    // After the command name: state, ppid, pgrp, session, tty_nr, tpgid.
    let fields: Vec<&str> = stat.rsplit_once(')')?.1.split_whitespace().collect();
    let pgrp: i64 = fields.get(2)?.parse().ok()?;
    let tpgid: i64 = fields.get(5)?.parse().ok()?;
    Some(tpgid > 0 && tpgid != pgrp)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_cwd(_pid: u32) -> Option<String> {
    None
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_busy(_pid: u32) -> bool {
    false
}

/// Where a replaced shell's fresh one starts (#1231): where the OS says the
/// old one sat, else where its prompt last said (kept on disk), else
/// `root`; each only while it is a directory. Never asks the old shell. A
/// directory outside the workspace stays, as a `cd` there would.
fn replacement_dir(os: Option<String>, recorded: Option<String>, root: &str) -> String {
    [os, recorded].into_iter().flatten().find(|c| std::path::Path::new(c).is_dir()).unwrap_or_else(|| root.to_string())
}

/// Where each thread's shell last said it sits, one file per thread in a
/// folder (`~/.octopush/talk-cwd/`), so a shell reattached after a restart
/// is replaced where it was even when the OS can't say (#1231). Best
/// effort: a write or read that fails keeps nothing.
#[derive(Clone, Debug, Default)]
struct CwdStore(Option<std::path::PathBuf>);

impl CwdStore {
    /// The thread's file: only for an id made of letters, digits, `-` and
    /// `_`, so it never names another path.
    fn file(&self, thread_id: &str) -> Option<std::path::PathBuf> {
        let dir = self.0.as_ref()?;
        let plain = !thread_id.is_empty() && thread_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        plain.then(|| dir.join(format!("{thread_id}.cwd")))
    }

    fn record(&self, thread_id: &str, cwd: &str) {
        let Some(file) = self.file(thread_id) else { return };
        if !cwd.starts_with('/') || std::fs::read_to_string(&file).is_ok_and(|was| was == cwd) {
            return;
        }
        let part = file.with_extension("cwd.part");
        let wrote = file.parent().is_some_and(|d| std::fs::create_dir_all(d).is_ok()) && std::fs::write(&part, cwd).is_ok();
        if !wrote || std::fs::rename(&part, &file).is_err() {
            tracing::debug!(thread_id, "could not keep the talk shell's directory");
        }
    }

    fn read(&self, thread_id: &str) -> Option<String> {
        std::fs::read_to_string(self.file(thread_id)?).ok().filter(|c| c.starts_with('/'))
    }

    fn forget(&self, thread_id: &str) {
        if let Some(file) = self.file(thread_id) {
            let _ = std::fs::remove_file(file);
        }
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

/// Why a thread's shell runs strict ([`TalkShell::set_strict_for`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StrictFor {
    /// Its mission ships nothing (#1241).
    ShipsNothing,
    /// Its conversation is in this mode, Ask first or Plan only (#1231).
    Mode(crate::permissions::Mode),
}

impl StrictFor {
    /// Why a thread in `mode` runs strict, if it does: a mission that ships
    /// nothing, else Ask first and Plan only. Pure.
    pub fn of(ships_nothing: bool, mode: crate::permissions::Mode) -> Option<Self> {
        use crate::permissions::Mode;
        match (ships_nothing, mode) {
            (true, _) => Some(Self::ShipsNothing),
            (false, Mode::Ask | Mode::Plan) => Some(Self::Mode(mode)),
            (false, Mode::Edit) => None,
        }
    }

    /// How a command refused for a shell [`apply_strict_shell`] didn't prove
    /// clean starts; the reason follows.
    fn refused(self) -> String {
        match self {
            Self::ShipsNothing => STRICT_SHELL_REFUSED.to_string(),
            Self::Mode(mode) => format!("{STRICT_MODE_REFUSED}{}, and its shell", mode.label()),
        }
    }

    /// What started a fresh shell, for the terminal's line.
    fn label(self) -> &'static str {
        match self {
            Self::ShipsNothing => "a mission that ships nothing",
            Self::Mode(mode) => mode.label(),
        }
    }
}

/// How a command refused in Ask first or Plan only, for a shell
/// [`apply_strict_shell`] didn't prove clean, starts (#1231).
const STRICT_MODE_REFUSED: &str = "Not run: this conversation is in ";

/// Whether `message` is a strict shell's refusal ([`StrictFor::refused`]):
/// no command runs, in this shell or another.
pub(crate) fn strict_refusal(message: &str) -> bool {
    message.starts_with(STRICT_SHELL_REFUSED) || message.starts_with(STRICT_MODE_REFUSED)
}

/// The line a fresh strict shell prints, so the terminal's transcript says
/// why the shell's state is gone: "Shell restarted for Ask first". Pure.
fn restart_note_line(why: StrictFor) -> String {
    format!("\\builtin printf '%s\\n' 'Shell restarted for {}'\n", why.label())
}

/// Print [`restart_note_line`] in a shell just made strict, and wait for its
/// prompt. Best effort, as the login PATH is ([`apply_login_path`]).
fn note_restart(client: &Arc<DaemonClient>, id: &str, rx: &Receiver<TermEvent>, nonce: &str, why: StrictFor) {
    drain_pending(rx);
    if client.write(id, restart_note_line(why).as_bytes()).is_err() {
        return;
    }
    if !matches!(probe(rx, Duration::from_secs(5), nonce), Probe::Done { .. }) {
        tracing::warn!(id, "talk shell did not confirm its restart line");
    }
}

/// How a command refused by a strict shell's caller starts; the reason
/// [`apply_strict_shell`] gave follows.
pub(crate) const STRICT_SHELL_REFUSED: &str = "Not run: this mission ships nothing, and this conversation's shell";

/// What [`apply_strict_shell`] writes before its report, a line at a time.
/// bash expands a line's aliases as it reads it, so only lines read after
/// `unalias -a` ran use reserved words an alias could replace (`while`,
/// `case`); every command word is quoted (`\builtin`), which no alias
/// matches. A profile's `builtin` or `unset` function goes first, in POSIX
/// mode, where a special builtin is found before a function:
/// `POSIXLY_CORRECT` turns it on, an assignment no function or alias can
/// take, and comes off again unless the profile had it. Then every
/// function but the `__octo_*` ones that draw the prompt marker, every
/// trap with an action, `PROMPT_COMMAND`, `PS0`, `command_not_found_handle`
/// and `CDPATH`, and the command hash. `PROMPT_COMMAND`, `PS0` and `CDPATH`
/// stay unset and `PS1` stays the marker, as readonly variables, so nothing
/// run later can set them; a virtual environment's activation leaves the
/// prompt alone (`VIRTUAL_ENV_DISABLE_PROMPT`). `interactive_comments` is
/// on, so a `#` starts a comment as the command check reads it.
const STRICT_SHELL_LINES: [&str; 2] = [
    r#"__octo_px=${POSIXLY_CORRECT+y}; POSIXLY_CORRECT=y; \unset -f builtin unset; \builtin test -n "$__octo_px" || \builtin unset POSIXLY_CORRECT; \builtin unset __octo_px; \builtin unalias -a; \builtin shopt -u expand_aliases; \builtin shopt -s interactive_comments; \builtin trap - DEBUG RETURN ERR EXIT; \builtin unset PROMPT_COMMAND PS0 command_not_found_handle CDPATH; \builtin hash -r"#,
    r#"while \builtin read -r _ _ __octo_f; do case $__octo_f in ''|__octo_*) ;; *) \builtin unset -f "$__octo_f";; esac; done <<< "$(\builtin declare -F)"; while \builtin read -r __octo_f; do case $__octo_f in ''|"trap -- - "*|"trap -- '' "*) ;; *) \builtin trap - "${__octo_f##* }";; esac; done <<< "$(\builtin trap -p)"; \builtin unset __octo_f; \builtin readonly PROMPT_COMMAND PS0 PS1 CDPATH; \builtin export VIRTUAL_ENV_DISABLE_PROMPT=1"#,
];

/// The line that reports what a strict shell still holds, tagged with
/// `nonce`: its aliases, its functions but the `__octo_*` ones, its traps
/// with an action, and whether `PROMPT_COMMAND` holds anything to run
/// (`1`; any element of an array counts, the readonly, unset one the
/// cleanup leaves doesn't). The RS bytes come from a variable, so the tag
/// is whole only in the shell's output.
fn strict_report_line(nonce: &str) -> String {
    format!(
        r#"__octo_count() {{ __octo_k=0; while \builtin read -r __octo_f; do case $__octo_f in ''|*' __octo_'*|"trap -- - "*|"trap -- '' "*) ;; *) __octo_k=$((__octo_k+1));; esac; done <<< "$1"; \builtin printf %s "$__octo_k"; }}; __octo_pc=0; case ${{PROMPT_COMMAND[*]-}} in '') ;; *) __octo_pc=1;; esac; \builtin printf '%s%sOCTO_STRICT_{nonce}:%s:%s:%s:%s%s%s\n' "$__OCTORS" "$__OCTORS" "$(__octo_count "$(\builtin alias)")" "$(__octo_count "$(\builtin declare -F)")" "$(__octo_count "$(\builtin trap -p)")" "$__octo_pc" "$__OCTORS" "$__OCTORS"; \builtin unset -f __octo_count; \builtin unset __octo_k __octo_f __octo_pc"#
    )
}

/// What a strict shell reported it still holds ([`strict_report_line`]).
#[derive(Debug, PartialEq)]
struct StrictReport {
    aliases: u32,
    functions: u32,
    traps: u32,
    prompt_command: bool,
}

impl StrictReport {
    /// The report tagged with `nonce` in `output`, if there is one. Pure.
    fn read(output: &str, nonce: &str) -> Option<Self> {
        let re = regex::Regex::new(&format!(r"\x1e\x1eOCTO_STRICT_{}:(\d+):(\d+):(\d+):([01])\x1e\x1e", regex::escape(nonce))).ok()?;
        let caps = re.captures(output)?;
        Some(Self {
            aliases: caps[1].parse().ok()?,
            functions: caps[2].parse().ok()?,
            traps: caps[3].parse().ok()?,
            prompt_command: &caps[4] == "1",
        })
    }

    /// What is left, as the end of a refusal (`None` when nothing is).
    /// Pure.
    fn left(&self) -> Option<String> {
        let count = |n: u32, one: &str, many: &str| match n {
            0 => None,
            1 => Some(format!("1 {one}")),
            n => Some(format!("{n} {many}")),
        };
        let parts: Vec<String> = [
            count(self.aliases, "alias", "aliases"),
            count(self.functions, "function", "functions"),
            count(self.traps, "trap", "traps"),
            self.prompt_command.then(|| "PROMPT_COMMAND".to_string()),
        ]
        .into_iter()
        .flatten()
        .collect();
        let held = match parts.as_slice() {
            [] => return None,
            [one] => one.clone(),
            [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
        };
        Some(format!(
            "still holds {held} after the cleanup that makes it strict; a function or variable marked readonly can't be removed"
        ))
    }
}

/// Make the shell strict: no alias (`unalias -a`, and `shopt -u
/// expand_aliases` so none expands later), no function (`unset -f` for
/// each one `declare -F` lists, the prompt marker's `__octo_*` aside), no
/// trap, no `PROMPT_COMMAND`, `PS0` or `command_not_found_handle`, and an
/// empty command hash ([`STRICT_SHELL_LINES`]), so each word of a command
/// runs the builtin or the program on the PATH it names, which is what the
/// command check reads. PATH and the rest of the profile's environment
/// stay. Then the shell reports what it still holds, on one line tagged
/// with `nonce` ([`strict_report_line`]). Run on a fresh shell, once its
/// prompt is up, as the login PATH is ([`apply_login_path`]). `Ok` only
/// when the report came back with everything at zero; otherwise why, for
/// the caller's refusal. No command may run in the shell until it is `Ok`.
///
/// With a `barrier` (a mission that ships nothing, #1275), the clean shell
/// is then put behind it, after everything the profile did
/// ([`crate::ship_barrier::Barrier::shell_lines`]: the shims first on PATH,
/// the tokens unset, the askpass refuser, the push rewrite), and reports
/// again, tagged with the same nonce, whether it holds it
/// ([`crate::ship_barrier::Barrier::report_line`]). `Ok` only when it does.
fn apply_strict_shell(
    client: &Arc<DaemonClient>,
    id: &str,
    rx: &Receiver<TermEvent>,
    nonce: &str,
    barrier: Option<&crate::ship_barrier::Barrier>,
) -> Result<(), String> {
    let no_answer = || "didn't answer the cleanup that makes it strict".to_string();
    let run_line = |line: &str| -> Result<String, String> {
        drain_pending(rx);
        client.write(id, format!("{line}\n").as_bytes()).map_err(|_| no_answer())?;
        match probe(rx, Duration::from_secs(5), nonce) {
            Probe::Done { output, .. } => Ok(output),
            _ => Err(no_answer()),
        }
    };
    for line in STRICT_SHELL_LINES {
        run_line(line)?;
    }
    let output = run_line(&strict_report_line(nonce))?;
    let report = StrictReport::read(&output, nonce).ok_or_else(|| "didn't report what it holds after the cleanup that makes it strict".to_string())?;
    if let Some(why) = report.left() {
        tracing::warn!(id, ?report, "talk shell isn't strict after its cleanup");
        return Err(why);
    }
    let Some(barrier) = barrier else { return Ok(()) };
    for line in barrier.shell_lines() {
        run_line(&line)?;
    }
    let output = run_line(&barrier.report_line(nonce))?;
    let held = crate::ship_barrier::BarrierReport::read(&output, nonce)
        .ok_or_else(|| "didn't report whether it holds the process barrier".to_string())?;
    match held.missing() {
        None => Ok(()),
        Some(why) => {
            tracing::warn!(id, ?held, "talk shell doesn't hold the process barrier");
            Err(why)
        }
    }
}

impl LiveRun {
    /// Where the command started: the shell's directory as it last reported it.
    pub fn cwd(&self) -> &str {
        &self.cwd
    }

    /// Pump live output to `on_chunk` (raw, with ANSI — xterm draws it) until the
    /// process exits (the prompt marker prints), then restore the session and
    /// return the exit info. Blocking — run on a worker thread.
    pub fn stream<F: FnMut(&str)>(self, on_chunk: F) -> LiveExit {
        self.stream_ending(on_chunk, |_| {})
    }

    /// [`Self::stream`], calling `ending` with the exit code once the process
    /// ended and before the shell takes another command (#1160): until then,
    /// whatever holds the shell's terminal is this command.
    pub fn stream_ending<F: FnMut(&str), G: FnOnce(i32)>(self, mut on_chunk: F, ending: G) -> LiveExit {
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
            ending(exit.exit_code);
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

        ending(exit.exit_code);
        self.finish(exit, full)
    }

    fn finish(self, mut exit: LiveExit, full: String) -> LiveExit {
        exit.full_output = cap_output(clean_output(&full), MAX_OUTPUT_BYTES, exit.exit_code != 0);
        let mut session = self.handle.lock();
        session.rx = Some(self.rx);
        if !exit.cwd.is_empty() {
            session.cwd = exit.cwd.clone();
            self.cwd_store.record(&self.thread_id, &exit.cwd);
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
    // - The exit code is `$?` as the marker is drawn (bash keeps it across
    //   PROMPT_COMMAND), so the marker itself needs no PROMPT_COMMAND: a
    //   strict shell has none (`apply_strict_shell`), and PS1 is readonly
    //   there instead.
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
        "__octo_ps() {{ printf '%s%sOCTO_DONE_{nonce}:%d:%s%s%s' \"$__OCTORS\" \"$__OCTORS\" \"$?\" \"$PWD\" \"$__OCTORS\" \"$__OCTORS\"; }}\n"
    ));
    init.push_str("__octo_setps() { PS1='$(__octo_ps)'; }\n");
    init.push_str("PROMPT_COMMAND='set +H; unset CDPATH; __octo_setps'\n");
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
pub(crate) fn clean_output(s: &str) -> String {
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
    fn the_shell_runs_without_cdpath() {
        assert!(SHELL_INPUT_AS_WRITTEN.starts_with("set +H; unset CDPATH;"), "{SHELL_INPUT_AS_WRITTEN}");
        // Split, so this test's own text isn't what it finds.
        let line = ["init.push_str(\"PROMPT_COMMAND='", "set +H; unset CDPATH; __octo_setps'"].concat();
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

    /// A replaced shell's fresh one starts where the OS says the old one
    /// sat, else where its prompt last said, else the workspace root, each
    /// only while it is a directory; nothing asks the old shell (#1231).
    #[test]
    fn a_replaced_shell_starts_where_the_os_says_it_sat() {
        let (os, kept) = (tempfile::TempDir::new().unwrap(), tempfile::TempDir::new().unwrap());
        let (os, kept) = (os.path().to_str().unwrap().to_string(), kept.path().to_str().unwrap().to_string());
        assert_eq!(replacement_dir(Some(os.clone()), Some(kept.clone()), "/ws"), os);
        assert_eq!(replacement_dir(None, Some(kept.clone()), "/ws"), kept);
        assert_eq!(replacement_dir(Some("/no/such/octo-dir".into()), Some(kept.clone()), "/ws"), kept);
        assert_eq!(replacement_dir(Some("/no/such/octo-dir".into()), None, "/ws"), "/ws");
        assert_eq!(replacement_dir(None, None, "/ws"), "/ws");
        // A job holds the terminal when its group, not the shell's, is in front.
        assert_eq!(stat_busy("123 (bash) S 1 123 123 34816 123 4194560 0"), Some(false));
        assert_eq!(stat_busy("123 (ba sh)) S 1 123 123 34816 456 4194560 0"), Some(true));
        assert_eq!(stat_busy("123 (bash) S 1 123 123 0 -1 4194560 0"), Some(false));
        assert_eq!(stat_busy("garbage"), None);
        // The group to signal to stop it (#1160).
        assert_eq!(stat_job_group("123 (ba sh)) S 1 123 123 34816 456 4194560 0"), Some(456));
        assert_eq!(stat_job_group("123 (bash) S 1 123 123 34816 123 4194560 0"), None);
        assert_eq!(stat_job_group("123 (bash) S 1 123 123 0 -1 4194560 0"), None);
        assert_eq!(stat_job_group("garbage"), None);
        // When it started, which a pid used again never matches.
        let stat = "123 (ba sh)) S 1 123 123 34816 456 4194560 0 0 0 0 10 2 0 0 20 0 1 0 987654 1000 10";
        assert_eq!(stat_started(stat), Some(987_654));
        assert_eq!(stat_started("123 (bash) S 1"), None);
        assert_eq!(stat_started("garbage"), None);
        // Where the shell last said it sits, kept per thread.
        let dir = tempfile::TempDir::new().unwrap();
        let store = CwdStore(Some(dir.path().join("talk-cwd")));
        assert_eq!(store.read("t-1"), None);
        store.record("t-1", &os);
        assert_eq!(store.read("t-1"), Some(os.clone()));
        store.record("t-1", "relative/dir");
        assert_eq!(store.read("t-1"), Some(os.clone()), "only an absolute directory");
        store.record("t-1", &kept);
        assert_eq!(store.read("t-1"), Some(kept.clone()));
        for odd in ["", "../t", "a/b", "t 1"] {
            assert_eq!(store.file(odd), None, "{odd:?}");
        }
        store.forget("t-1");
        assert_eq!(store.read("t-1"), None);
        CwdStore::default().record("t-1", &os);
        assert_eq!(CwdStore::default().read("t-1"), None, "no folder, nothing kept");
    }

    /// Why a shell runs strict names its refusal and the terminal's line
    /// (#1231): a mission that ships nothing first, then Ask first and Plan
    /// only; Edit freely isn't strict.
    #[test]
    fn a_strict_shell_says_why_it_is_strict() {
        use crate::permissions::Mode;
        assert_eq!(StrictFor::of(true, Mode::Edit), Some(StrictFor::ShipsNothing));
        assert_eq!(StrictFor::of(true, Mode::Ask), Some(StrictFor::ShipsNothing));
        assert_eq!(StrictFor::of(false, Mode::Ask), Some(StrictFor::Mode(Mode::Ask)));
        assert_eq!(StrictFor::of(false, Mode::Plan), Some(StrictFor::Mode(Mode::Plan)));
        assert_eq!(StrictFor::of(false, Mode::Edit), None);
        assert_eq!(StrictFor::ShipsNothing.refused(), STRICT_SHELL_REFUSED);
        let ask = StrictFor::Mode(Mode::Ask).refused();
        assert_eq!(ask, "Not run: this conversation is in Ask first, and its shell");
        assert!(strict_refusal(&format!("{ask} didn't answer.")) && strict_refusal(&format!("{STRICT_SHELL_REFUSED} x.")));
        assert!(!strict_refusal(SHELL_BUSY) && !strict_refusal("terminal daemon unavailable"));
        assert_eq!(restart_note_line(StrictFor::Mode(Mode::Ask)), "\\builtin printf '%s\\n' 'Shell restarted for Ask first'\n");
        assert!(restart_note_line(StrictFor::ShipsNothing).contains("'Shell restarted for a mission that ships nothing'"));
    }

    /// The strict shell's report: read only with its nonce and RS bytes,
    /// and a refusal that names what is left (#1241).
    #[test]
    fn the_strict_report_names_what_is_left() {
        let line = |a: u32, f: u32, t: u32, p: u32| format!("noise\n{RS}{RS}OCTO_STRICT_{N}:{a}:{f}:{t}:{p}{RS}{RS}");
        let clean = StrictReport { aliases: 0, functions: 0, traps: 0, prompt_command: false };
        assert_eq!(StrictReport::read(&line(0, 0, 0, 0), N), Some(clean));
        assert_eq!(StrictReport::read(&line(0, 0, 0, 0), N).unwrap().left(), None);
        assert_eq!(StrictReport::read(&line(0, 0, 0, 0), "other"), None, "another nonce");
        assert_eq!(StrictReport::read(&format!("OCTO_STRICT_{N}:0:0:0:0"), N), None, "the typed line, without RS bytes");
        let left = |a, f, t, p| StrictReport::read(&line(a, f, t, p), N).unwrap().left().unwrap();
        assert!(left(0, 1, 0, 0).starts_with("still holds 1 function after"), "{}", left(0, 1, 0, 0));
        assert!(left(2, 1, 3, 1).starts_with("still holds 2 aliases, 1 function, 3 traps and PROMPT_COMMAND after"), "{}", left(2, 1, 3, 1));
        assert!(left(0, 0, 0, 1).contains("readonly can't be removed"));
        // Every cleanup the review asked for is in the lines.
        let lines = STRICT_SHELL_LINES.concat();
        for part in [
            r"\builtin unalias -a",
            r"\builtin shopt -u expand_aliases",
            r#"\builtin unset -f "$__octo_f""#,
            r"\builtin trap - DEBUG RETURN ERR EXIT",
            r"\builtin unset PROMPT_COMMAND PS0 command_not_found_handle CDPATH",
            r"\builtin readonly PROMPT_COMMAND PS0 PS1 CDPATH",
        ] {
            assert!(lines.contains(part), "{part}");
        }
        assert!(strict_report_line(N).contains(&format!("OCTO_STRICT_{N}:%s:%s:%s:%s")));
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

    /// The agent's command still running at its timeout is promoted to a
    /// live process instead of being interrupted (#1160): the shell is busy
    /// while it runs and takes the next command once it ends.
    #[test]
    #[serial]
    fn an_agent_command_past_its_timeout_is_promoted() {
        let d = boot();
        let shell = shell_on(&d.sock);
        let quick = Duration::from_secs(5);
        let r = done(shell.run_agent("pr", "/tmp", "echo quick", quick).unwrap());
        assert_eq!(r.output, "quick");
        let live = match shell.run_agent("pr", "/tmp", "echo promoted-start; sleep 1; echo promoted-done", Duration::from_millis(300)).unwrap() {
            RunOutcome::Live(l) => l,
            _ => panic!("expected the command to be promoted"),
        };
        assert!(live.cwd().ends_with("tmp"), "{}", live.cwd());
        assert!(matches!(shell.run_agent("pr", "/tmp", "echo x", quick).unwrap(), RunOutcome::Busy));
        let chunks = Arc::new(StdMutex::new(String::new()));
        let c2 = Arc::clone(&chunks);
        let exit = live.stream(move |s| c2.lock().unwrap().push_str(s));
        assert_eq!(exit.exit_code, 0);
        let streamed = chunks.lock().unwrap().clone();
        assert!(streamed.contains("promoted-start") && streamed.contains("promoted-done"), "{streamed:?}");
        let r = done(shell.run_agent("pr", "/tmp", "echo back", quick).unwrap());
        assert_eq!(r.output, "back");
        shell.close("pr");
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

    /// A profile with the alias `gp` and the functions `gp` and `git`, read
    /// by the daemon's `bash -l` from the test's HOME.
    const PROFILE: &str = "alias gp='echo PROFILE_ALIAS'\nfunction gp { echo PROFILE_FUNCTION; }\nfunction git { echo PROFILE_FUNCTION; }\n";
    /// What a strict shell prints for this: no alias, no function but the
    /// prompt marker's, no trap, no `PROMPT_COMMAND`.
    const DEFINITIONS: &str = "alias; declare -F | grep -v ' __octo_'; trap -p; echo \"${PROMPT_COMMAND-}end\"";

    /// In a mission that ships nothing (#1241), the profile's alias and
    /// functions don't run: not in a new shell, and not in one that was
    /// running when its mission came to ship nothing, which is replaced by
    /// a fresh `bash -l` in the same directory. A shell that isn't strict,
    /// a Build or Fix mission's, keeps them as before.
    #[test]
    #[serial]
    fn a_strict_shell_runs_no_alias_or_function_from_the_profile() {
        use crate::orchestrator::cli_runner::with_login_shell_env;
        let d = boot();
        fs::write(d._tmp.path().join(".bash_profile"), PROFILE).unwrap();
        // Roomy: a busy CI runner can take seconds to bring a shell up.
        let quick = Duration::from_secs(20);
        with_login_shell_env(&[], || {
            let shell = shell_on(&d.sock);
            let r = done(shell.run("loose", "/tmp", "type -t gp git", quick, true).unwrap());
            assert_eq!(r.output.lines().collect::<Vec<_>>(), ["alias", "function"], "the profile was read");
            let r = done(shell.run("loose", "/tmp", "gp", quick, true).unwrap());
            assert_eq!(r.output, "PROFILE_ALIAS", "not strict: as before");

            shell.set_strict("strict", true);
            for word in ["gp", "git"] {
                let r = done(shell.run("strict", "/tmp", word, quick, true).unwrap());
                assert!(!r.output.contains("PROFILE_"), "{word} ran the profile's: {:?}", r.output);
            }
            let r = done(shell.run("strict", "/tmp", DEFINITIONS, quick, true).unwrap());
            assert_eq!(r.output, "end");
            let r = done(shell.run("strict", "/tmp", "false", quick, true).unwrap());
            assert_eq!(r.exit_code, 1, "the marker reads the exit code without PROMPT_COMMAND");

            // A shell already running when it became strict: a fresh one,
            // where it was.
            done(shell.run("loose", "/tmp", "cd /usr && export OCTO_T5=old", quick, true).unwrap());
            shell.set_strict("loose", true);
            let r = done(shell.run("loose", "/tmp", "gp; git; echo \"${OCTO_T5-fresh}\"; pwd", quick, true).unwrap());
            assert!(!r.output.contains("PROFILE_") && r.output.ends_with("fresh\n/usr"), "{:?}", r.output);
            let r = done(shell.run("loose", "/tmp", DEFINITIONS, quick, true).unwrap());
            assert_eq!(r.output, "end");
            shell.close("strict");
            shell.close("loose");
        });
    }

    /// A strict shell is never reattached (#1241): what ran in it before
    /// its mission came to ship nothing can outlast a cleanup (functions
    /// named `unset` and `builtin`, a `DEBUG` trap, `PROMPT_COMMAND`), so
    /// a fresh `bash -l` takes its place in the same directory, and is made
    /// strict, after every restart.
    #[test]
    #[serial]
    fn the_strict_shell_runs_again_after_a_reattach() {
        use crate::orchestrator::cli_runner::with_login_shell_env;
        let d = boot();
        fs::write(d._tmp.path().join(".bash_profile"), PROFILE).unwrap();
        let quick = Duration::from_secs(20);
        with_login_shell_env(&[], || {
            {
                // A Build mission's shell, where the agent ran anything.
                let shell = shell_on(&d.sock);
                let before = "unset() { :; }; builtin() { :; }; trap 'echo TRAPPED' DEBUG; \
                              PROMPT_COMMAND='echo PC'; export OCTO_T6=old; cd /usr";
                done(shell.run("restrict", "/tmp", before, quick, true).unwrap());
                // `shell` drops here, as at an Octopush restart.
            }
            {
                let shell = shell_on(&d.sock);
                shell.set_strict("restrict", true);
                let r = done(shell.run("restrict", "/tmp", DEFINITIONS, quick, true).unwrap());
                assert_eq!(r.output, "end", "the reattached shell was replaced and made strict");
                let r = done(shell.run("restrict", "/tmp", "echo \"${OCTO_T6-fresh}\"; pwd; type -t unset builtin", quick, true).unwrap());
                assert_eq!(r.output.lines().collect::<Vec<_>>(), ["fresh", "/usr", "builtin", "builtin"]);
                // Defined again in the shell, as a `$` command could.
                let again = "shopt -s expand_aliases; alias gp='echo PROFILE_ALIAS'; function git { echo PROFILE_FUNCTION; }";
                done(shell.run("restrict", "/tmp", again, quick, true).unwrap());
                let r = done(shell.run("restrict", "/tmp", DEFINITIONS, quick, true).unwrap());
                assert_ne!(r.output, "end", "defined again: {:?}", r.output);
            }
            let shell = shell_on(&d.sock);
            shell.set_strict("restrict", true);
            let r = done(shell.run("restrict", "/tmp", DEFINITIONS, quick, true).unwrap());
            assert_eq!(r.output, "end", "strict again after the reattach");
            let r = done(shell.run("restrict", "/tmp", "gp; git; pwd", quick, true).unwrap());
            assert!(!r.output.contains("PROFILE_") && r.output.ends_with("/usr"), "{:?}", r.output);
            shell.close("restrict");
        });
    }

    /// No command runs in a strict shell its report doesn't prove clean: a
    /// function or a `PROMPT_COMMAND` the profile made readonly can't be
    /// removed, so nothing runs, and the refusal says what is left (#1241).
    #[test]
    #[serial]
    fn a_strict_shell_that_cant_drop_a_function_runs_nothing() {
        use crate::orchestrator::cli_runner::with_login_shell_env;
        let d = boot();
        let profile = format!("{PROFILE}readonly -f git\nPROMPT_COMMAND=true\nreadonly PROMPT_COMMAND\n");
        fs::write(d._tmp.path().join(".bash_profile"), profile).unwrap();
        let dir = TempDir::new().unwrap();
        let cwd = dir.path().to_str().unwrap().to_string();
        let quick = Duration::from_secs(20);
        with_login_shell_env(&[], || {
            let shell = shell_on(&d.sock);
            shell.set_strict("stuck", true);
            for _ in 0..2 {
                let err = shell.run("stuck", &cwd, "touch ran", quick, true).err().expect("refused");
                let err = err.to_string();
                assert!(err.contains(STRICT_SHELL_REFUSED) && err.contains("still holds 1 function and PROMPT_COMMAND"), "{err}");
            }
            assert!(!dir.path().join("ran").exists(), "the command ran");
            shell.close("stuck");
        });
    }

    /// A mission that ships nothing puts its shell behind the process
    /// barrier once the profile ran (#1275): the shims first on PATH, no
    /// token from the daemon's environment or the profile, the askpass
    /// refuser, and a push refused by the shim. A shell strict for Ask
    /// first, as a Build or Fix mission's conversation can be, gets none of
    /// it, and neither does one in Edit freely.
    #[test]
    #[serial]
    fn a_ship_nothing_shell_starts_behind_the_process_barrier() {
        use crate::orchestrator::cli_runner::with_login_shell_env;
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join(".octopush");
        fs::create_dir_all(&base).unwrap();
        let sock = base.join("pty-server.sock");
        let mut child = Command::new(find_daemon_bin())
            .env("HOME", tmp.path())
            .env("OCTOPUSH_PTY_AUTO_EXIT_SECS", "20")
            .env("GITHUB_TOKEN", "ghp_from_the_daemon")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn daemon");
        assert!(wait_for_socket(&sock), "daemon socket did not appear");
        fs::write(tmp.path().join(".bash_profile"), "export NPM_TOKEN=npm_from_the_profile\nexport PATH=/usr/bin:/bin:$PATH\n").unwrap();
        let ws = TempDir::new().unwrap();
        let wsp = ws.path().to_str().unwrap().to_string();
        let quick = Duration::from_secs(20);
        let probe = "printf '%s|%s|%s|%s' \"${GITHUB_TOKEN-unset}\" \"${NPM_TOKEN-unset}\" \"${PATH%%:*}\" \"${GIT_ASKPASS-unset}\"";
        with_login_shell_env(&[], || {
            let shell = shell_on(&sock);
            shell.set_strict_for("ship", Some(StrictFor::ShipsNothing));
            let barrier = crate::ship_barrier::Barrier::for_workspace(ws.path()).unwrap();
            let r = done(shell.run("ship", &wsp, probe, quick, true).unwrap());
            assert_eq!(r.output, format!("unset|unset|{}|{}", barrier.bin().display(), barrier.askpass().display()));
            let r = done(shell.run("ship", &wsp, "git push origin main", quick, true).unwrap());
            assert!(r.exit_code != 0 && r.output.contains("Octopush refused `git`"), "{:?}", r.output);
            let r = done(shell.run("ship", &wsp, "git --version", quick, true).unwrap());
            assert!(r.exit_code == 0 && r.output.starts_with("git version"), "{:?}", r.output);

            for (thread, why) in [("ask", StrictFor::of(false, crate::permissions::Mode::Ask)), ("edit", None)] {
                shell.set_strict_for(thread, why);
                let r = done(shell.run(thread, &wsp, probe, quick, true).unwrap());
                assert!(r.output.starts_with("ghp_from_the_daemon|npm_from_the_profile|/usr/bin|"), "{thread}: {:?}", r.output);
                assert!(!r.output.contains(&barrier.askpass().display().to_string()), "{thread}: {:?}", r.output);
            }
            // The Ask first shell, whose mission comes to ship nothing, is
            // replaced by one behind the barrier.
            shell.set_strict_for("ask", Some(StrictFor::ShipsNothing));
            let r = done(shell.run("ask", &wsp, probe, quick, true).unwrap());
            assert!(r.output.ends_with(&format!("unset|unset|{}|{}", barrier.bin().display(), barrier.askpass().display())), "{:?}", r.output);
            for thread in ["ship", "ask", "edit"] {
                shell.close(thread);
            }
        });
        child.kill().ok();
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

    /// Edit freely, where the agent leaves a DEBUG trap and a
    /// `PROMPT_COMMAND`, then Ask first; Edit freely again, where it defines
    /// an `ls` that writes, then Ask first again: each time the shell starts
    /// fresh where it was and is made strict, so `ls` is the real one and
    /// nothing writes (#1231). Staying in Ask first, or leaving it with no
    /// command run, keeps the shell.
    #[test]
    #[serial]
    fn ask_first_starts_a_fresh_shell_after_edit_freely() {
        use crate::orchestrator::cli_runner::with_login_shell_env;
        use crate::permissions::Mode;
        let d = boot();
        let dir = TempDir::new().unwrap();
        let at = dir.path().canonicalize().unwrap().to_string_lossy().into_owned();
        let quick = Duration::from_secs(20);
        let planted = |what: &[&str]| what.iter().filter(|f| dir.path().join(f).exists()).map(|f| f.to_string()).collect::<Vec<_>>();
        with_login_shell_env(&[], || {
            let shell = shell_on(&d.sock);
            // Edit freely first: a shell that was never strict.
            let plant = format!("cd '{at}' && trap 'touch dbg' DEBUG && PROMPT_COMMAND=\"touch pc; $PROMPT_COMMAND\" && export OCTO_RT=old");
            done(shell.run("rt", "/tmp", &plant, quick, true).unwrap());
            for f in ["dbg", "pc"] {
                let _ = fs::remove_file(dir.path().join(f));
            }
            shell.set_strict_for("rt", StrictFor::of(false, Mode::Ask));
            let r = done(shell.run("rt", "/tmp", "ls; echo \"${OCTO_RT-fresh}\"; pwd", quick, true).unwrap());
            assert_eq!(r.output.lines().collect::<Vec<_>>(), ["fresh", at.as_str()], "{:?}", r.output);
            assert_eq!(planted(&["dbg", "pc"]), Vec::<String>::new(), "the old shell's trap and PROMPT_COMMAND ran");
            done(shell.run("rt", "/tmp", "export OCTO_RT=kept", quick, true).unwrap());
            let r = done(shell.run("rt", "/tmp", "echo \"$OCTO_RT\"", quick, true).unwrap());
            assert_eq!(r.output, "kept", "staying in Ask first keeps the shell");

            // Edit freely again: the agent defines `ls`.
            shell.set_strict_for("rt", None);
            done(shell.run("rt", "/tmp", "ls(){ touch x;}; trap 'touch dbg' DEBUG", quick, true).unwrap());
            let _ = fs::remove_file(dir.path().join("dbg"));
            shell.set_strict_for("rt", StrictFor::of(false, Mode::Ask));
            let r = done(shell.run("rt", "/tmp", "ls; type -t ls; echo \"${OCTO_RT-fresh}\"; pwd", quick, true).unwrap());
            assert_eq!(r.output.lines().collect::<Vec<_>>(), ["file", "fresh", at.as_str()], "{:?}", r.output);
            assert_eq!(planted(&["x", "dbg", "pc"]), Vec::<String>::new());
            let r = done(shell.run("rt", "/tmp", DEFINITIONS, quick, true).unwrap());
            assert_eq!(r.output, "end");

            // Ask first, Edit freely with no command, Ask first: nothing ran
            // outside it, so the shell stays.
            done(shell.run("rt", "/tmp", "export OCTO_RT=still", quick, true).unwrap());
            shell.set_strict_for("rt", None);
            shell.set_strict_for("rt", StrictFor::of(false, Mode::Ask));
            let r = done(shell.run("rt", "/tmp", "echo \"$OCTO_RT\"", quick, true).unwrap());
            assert_eq!(r.output, "still");
            shell.close("rt");
        });
    }

    /// In Ask first, a shell its report doesn't prove clean runs nothing,
    /// and the refusal names the mode, not a mission (#1231).
    #[test]
    #[serial]
    fn an_ask_first_shell_that_cant_be_proved_clean_runs_nothing() {
        use crate::orchestrator::cli_runner::with_login_shell_env;
        let d = boot();
        fs::write(d._tmp.path().join(".bash_profile"), format!("{PROFILE}readonly -f git\n")).unwrap();
        let dir = TempDir::new().unwrap();
        let cwd = dir.path().to_str().unwrap().to_string();
        with_login_shell_env(&[], || {
            let shell = shell_on(&d.sock);
            shell.set_strict_for("askstuck", StrictFor::of(false, crate::permissions::Mode::Ask));
            let err = match shell.run("askstuck", &cwd, "touch ran", Duration::from_secs(20), true) {
                Err(AppError::Other(m)) => m,
                Err(e) => panic!("{e}"),
                Ok(_) => panic!("ran"),
            };
            assert!(err.starts_with("Not run: this conversation is in Ask first, and its shell still holds 1 function"), "{err}");
            assert!(strict_refusal(&err));
            assert!(!dir.path().join("ran").exists(), "the command ran");
            shell.close("askstuck");
        });
    }

    /// After a restart, the shell found running is replaced without a
    /// keystroke (#1231): its DEBUG trap and `PROMPT_COMMAND` never run, in
    /// a mission that ships nothing and in Ask first alike. The fresh shell
    /// starts where the OS says the old one sat, which was also kept on
    /// disk.
    #[test]
    #[serial]
    fn a_reattached_shell_is_replaced_without_typing_into_it() {
        use crate::orchestrator::cli_runner::with_login_shell_env;
        let d = boot();
        let dir = TempDir::new().unwrap();
        let at = dir.path().canonicalize().unwrap().to_string_lossy().into_owned();
        let store = TempDir::new().unwrap();
        let quick = Duration::from_secs(20);
        with_login_shell_env(&[], || {
            for (thread, why) in [("noinit-sn", StrictFor::ShipsNothing), ("noinit-ask", StrictFor::Mode(crate::permissions::Mode::Ask))] {
                let fired = dir.path().join(format!("{thread}-fired"));
                let f = fired.to_string_lossy().into_owned();
                {
                    // Edit freely or a Build mission, then an Octopush restart.
                    let shell = shell_on(&d.sock);
                    shell.set_cwd_store(Some(store.path().to_path_buf()));
                    done(shell.run(thread, "/tmp", &format!("cd '{at}'"), quick, true).unwrap());
                    let plant = format!("trap \"touch '{f}'\" DEBUG; PROMPT_COMMAND=\"touch '{f}'; $PROMPT_COMMAND\"");
                    done(shell.run(thread, "/tmp", &plant, quick, true).unwrap());
                    assert!(fired.exists(), "the trap is armed");
                    fs::remove_file(&fired).unwrap();
                    assert_eq!(fs::read_to_string(store.path().join(format!("{thread}.cwd"))).unwrap(), at, "where it sits is kept");
                }
                let shell = shell_on(&d.sock);
                shell.set_strict_for(thread, Some(why));
                let r = done(shell.run(thread, "/tmp", "pwd", quick, true).unwrap());
                assert_eq!(r.output, at, "{thread}");
                assert!(!fired.exists(), "{thread}: something ran in the old shell");
                shell.close(thread);
            }
        });
    }

    /// A reattached shell whose terminal a job from before the restart
    /// holds isn't killed, and runs nothing (#1231): the OS says so, so
    /// nothing is typed into the job either.
    #[test]
    #[serial]
    fn a_reattached_shell_a_job_holds_is_left_alone() {
        use crate::orchestrator::cli_runner::with_login_shell_env;
        let d = boot();
        let old = DaemonClient::connect_to(d.sock.to_str().unwrap()).unwrap();
        let env = HashMap::from([("PATH".to_string(), "/usr/bin:/bin".to_string())]);
        old.spawn("talk-held", "/tmp", &env, Some("/bin/bash"), 40, 120).unwrap();
        std::thread::sleep(Duration::from_millis(800));
        old.write("talk-held", b"sleep 30\n").unwrap();
        std::thread::sleep(Duration::from_millis(800));
        with_login_shell_env(&[], || {
            let shell = shell_on(&d.sock);
            shell.set_strict("held", true);
            let err = match shell.run("held", "/tmp", "true", Duration::from_secs(20), true) {
                Err(AppError::Other(m)) => m,
                Err(e) => panic!("{e}"),
                Ok(_) => panic!("ran"),
            };
            assert_eq!(err, SHELL_BUSY);
            assert!(old.list_terminals().unwrap().iter().any(|t| t.id == "talk-held" && t.running), "the job's shell was killed");
        });
        let _ = old.remove("talk-held");
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
