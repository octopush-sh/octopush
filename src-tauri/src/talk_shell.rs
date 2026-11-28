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
    /// Whether [`apply_strict_shell`] has run in it since it was attached.
    strict: bool,
}

pub struct TalkShell {
    client: Mutex<Option<Arc<DaemonClient>>>,
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
    /// Per thread, the variables its shell is spawned with besides PATH (the
    /// workspace's ports, #1219). A shell already running keeps its env.
    spawn_env: Mutex<HashMap<String, Vec<(String, String)>>>,
    /// The threads whose shell runs strict ([`TalkShell::set_strict`]).
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

    /// Run the thread's shell strict, or not, from its next command: in a
    /// mission that ships nothing its commands run in a shell without the
    /// profile's aliases and functions ([`apply_strict_shell`]), so a plain
    /// word such as `gp` can't stand for `git push`. Turning it off leaves
    /// a shell that already ran strict as it is.
    pub fn set_strict(&self, thread_id: &str, strict: bool) {
        let mut threads = self.strict.lock();
        if strict {
            threads.insert(thread_id.to_string());
        } else {
            threads.remove(thread_id);
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
        let strict = self.strict.lock().contains(thread_id);
        let handle = match existing {
            Some(h) => h,
            None => {
                let session = Self::ensure_session(&client, thread_id, workspace_path, &extra, strict)?;
                let h = Arc::new(Mutex::new(session));
                let mut map = self.sessions.lock();
                Arc::clone(map.entry(thread_id.to_string()).or_insert(h))
            }
        };

        // Take the receiver out under the lock, then drop the lock so the drain
        // never blocks another thread. A concurrent run for THIS thread finds
        // `rx == None` and returns Busy.
        let (rx, nonce, id, cwd, ran_strict) = {
            let mut session = handle.lock();
            let Some(rx) = session.rx.take() else {
                return Ok(RunOutcome::Busy);
            };
            (rx, session.nonce.clone(), session.id.clone(), session.cwd.clone(), session.strict)
        };

        // A shell that was running when its mission came to ship nothing.
        if strict && !ran_strict {
            if !apply_strict_shell(&client, &id, &rx, &nonce) {
                handle.lock().rx = Some(rx);
                return Err(AppError::Other(STRICT_SHELL_UNCONFIRMED.into()));
            }
            handle.lock().strict = true;
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
                match Self::ensure_session(&client, thread_id, &cwd, &extra, strict) {
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
                        match Self::ensure_session(&client, thread_id, &cwd, &extra, strict) {
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
        if let (Some(client), Some(handle)) = (client, handle) {
            let _ = client.remove(&handle.lock().id);
        }
    }

    /// Reattach to a surviving daemon PTY (so the shell persists across an
    /// Octopush restart) or spawn fresh; then (re-)install the prompt marker with
    /// a fresh nonce and wait until the shell confirms ready. Returns the cwd.
    /// A `strict` shell runs [`apply_strict_shell`] on every attach, and no
    /// command runs in it until the shell confirms it.
    fn ensure_session(
        client: &Arc<DaemonClient>,
        thread_id: &str,
        cwd: &str,
        extra: &[(String, String)],
        strict: bool,
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
                // On a reattach too: a command typed in the shell since, or
                // an older build, may have left definitions in it.
                if strict && !apply_strict_shell(client, &id, &rx, &nonce) {
                    if !reattaching {
                        let _ = client.remove(&id);
                    }
                    return Err(AppError::Other(STRICT_SHELL_UNCONFIRMED.into()));
                }
                Ok(Session {
                    id,
                    rx: Some(rx),
                    cwd: ready_cwd.unwrap_or_else(|| cwd.to_string()),
                    nonce,
                    strict,
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
        client.spawn(id, cwd, env, Some(TALK_BASH), 40, 120)?;
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

/// Why a command didn't run in a strict shell that didn't confirm it.
pub(crate) const STRICT_SHELL_UNCONFIRMED: &str = "Not run: this mission ships nothing, and this conversation's \
    shell didn't confirm it dropped the aliases and functions from your shell profile, which can make a command \
    run something other than what it names. A function marked readonly (`readonly -f`) can't be dropped.";

/// What [`apply_strict_shell`] writes, a line at a time. bash expands a
/// line's aliases as it reads it, so only the second line, read after
/// `unalias -a` ran, uses reserved words an alias could replace (`while`,
/// `case`); every command word is quoted (`\builtin`), which no alias
/// matches. A profile's `builtin` or `unset` function goes first, in POSIX
/// mode, where a special builtin is found before a function:
/// `POSIXLY_CORRECT` turns it on, an assignment no function or alias can
/// take, and comes off again unless the profile had it. Traps go too, since
/// a `DEBUG` trap would call a function that is gone, and the command hash.
/// `interactive_comments` is on, so a `#` starts a comment as the command
/// check reads it. The `__octo_*` functions draw the prompt marker and
/// stay. The second line fails when a function can't be dropped
/// (`readonly -f`).
const STRICT_SHELL_LINES: [&str; 2] = [
    r#"__octo_px=${POSIXLY_CORRECT+y}; POSIXLY_CORRECT=y; \unset -f builtin unset; \builtin test -n "$__octo_px" || \builtin unset POSIXLY_CORRECT; \builtin unset __octo_px; \builtin unalias -a; \builtin shopt -u expand_aliases; \builtin shopt -s interactive_comments; \builtin trap - DEBUG RETURN ERR; \builtin hash -r"#,
    r#"__octo_bad=0; while \builtin read -r _ _ __octo_f; do case $__octo_f in ''|__octo_*) ;; *) \builtin unset -f "$__octo_f" 2>/dev/null || __octo_bad=1;; esac; done <<< "$(\builtin declare -F)"; \builtin unset __octo_f; \builtin test "$__octo_bad" = 0"#,
];

/// Make the shell strict for a mission that ships nothing: no alias
/// (`unalias -a`, and `shopt -u expand_aliases` so none expands later), no
/// function from the profile (`unset -f` for each one `declare -F` lists),
/// no trap and an empty command hash, so each word of a command runs the
/// builtin or the program on the PATH it names, which is what the command
/// check reads. PATH and the rest of the profile's environment stay. Written
/// once the prompt is up, as the login PATH is ([`apply_login_path`]), on
/// every attach. True only once the shell confirmed both lines; the caller
/// runs no command until then.
fn apply_strict_shell(client: &Arc<DaemonClient>, id: &str, rx: &Receiver<TermEvent>, nonce: &str) -> bool {
    for line in STRICT_SHELL_LINES {
        drain_pending(rx);
        if client.write(id, format!("{line}\n").as_bytes()).is_err() {
            return false;
        }
        if !matches!(probe(rx, Duration::from_secs(5), nonce), Probe::Done { exit_code: 0, .. }) {
            tracing::warn!(id, "talk shell did not confirm the strict shell");
            return false;
        }
    }
    true
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

    /// A profile with the alias `gp` and the functions `gp` and `git`, read
    /// by the daemon's `bash -l` from the test's HOME.
    const PROFILE: &str = "alias gp='echo PROFILE_ALIAS'\nfunction gp { echo PROFILE_FUNCTION; }\nfunction git { echo PROFILE_FUNCTION; }\n";
    /// What a strict shell prints for this: no alias, and no function but
    /// the prompt marker's.
    const DEFINITIONS: &str = "alias; declare -F | grep -v ' __octo_'; echo end";

    /// In a mission that ships nothing (#1241), the profile's alias and
    /// functions don't run: not in a new shell, and not in one that was
    /// running when its mission came to ship nothing. A shell that isn't
    /// strict, a Build or Fix mission's, keeps them as before.
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

            // A shell already running when it became strict.
            shell.set_strict("loose", true);
            let r = done(shell.run("loose", "/tmp", "gp; git; echo end", quick, true).unwrap());
            assert!(!r.output.contains("PROFILE_") && r.output.ends_with("end"), "{:?}", r.output);
            let r = done(shell.run("loose", "/tmp", DEFINITIONS, quick, true).unwrap());
            assert_eq!(r.output, "end");
            shell.close("strict");
            shell.close("loose");
        });
    }

    /// The strict shell runs on every attach, so definitions made in the
    /// shell since (or by a shell an older build started) are gone after
    /// a restart (#1241).
    #[test]
    #[serial]
    fn the_strict_shell_runs_again_after_a_reattach() {
        use crate::orchestrator::cli_runner::with_login_shell_env;
        let d = boot();
        fs::write(d._tmp.path().join(".bash_profile"), PROFILE).unwrap();
        let quick = Duration::from_secs(20);
        let old = DaemonClient::connect_to(d.sock.to_str().unwrap()).unwrap();
        let env = HashMap::from([("PATH".to_string(), "/usr/bin:/bin".to_string())]);
        old.spawn("talk-restrict", "/tmp", &env, Some("/bin/bash"), 40, 120).unwrap();
        with_login_shell_env(&[], || {
            {
                let shell = shell_on(&d.sock);
                shell.set_strict("restrict", true);
                let r = done(shell.run("restrict", "/tmp", DEFINITIONS, quick, true).unwrap());
                assert_eq!(r.output, "end", "the reattached shell ran strict");
                // Defined again in the shell, as a `$` command could.
                let again = "shopt -s expand_aliases; alias gp='echo PROFILE_ALIAS'; function git { echo PROFILE_FUNCTION; }";
                done(shell.run("restrict", "/tmp", again, quick, true).unwrap());
                let r = done(shell.run("restrict", "/tmp", DEFINITIONS, quick, true).unwrap());
                assert_ne!(r.output, "end", "defined again: {:?}", r.output);
                // `shell` drops here, as at an Octopush restart.
            }
            let shell = shell_on(&d.sock);
            shell.set_strict("restrict", true);
            let r = done(shell.run("restrict", "/tmp", DEFINITIONS, quick, true).unwrap());
            assert_eq!(r.output, "end", "strict again after the reattach");
            let r = done(shell.run("restrict", "/tmp", "gp; git; echo end", quick, true).unwrap());
            assert!(!r.output.contains("PROFILE_") && r.output.ends_with("end"), "{:?}", r.output);
            shell.close("restrict");
        });
    }

    /// No command runs in a strict shell until it confirmed: a function the
    /// profile made readonly can't be dropped, so nothing runs (#1241).
    #[test]
    #[serial]
    fn a_strict_shell_that_cant_drop_a_function_runs_nothing() {
        use crate::orchestrator::cli_runner::with_login_shell_env;
        let d = boot();
        fs::write(d._tmp.path().join(".bash_profile"), format!("{PROFILE}readonly -f git\n")).unwrap();
        let dir = TempDir::new().unwrap();
        let cwd = dir.path().to_str().unwrap().to_string();
        let quick = Duration::from_secs(20);
        with_login_shell_env(&[], || {
            let shell = shell_on(&d.sock);
            shell.set_strict("stuck", true);
            for _ in 0..2 {
                let err = shell.run("stuck", &cwd, "touch ran", quick, true).err().expect("refused");
                assert!(err.to_string().contains("didn't confirm it dropped the aliases and functions"), "{err}");
            }
            assert!(!dir.path().join("ran").exists(), "the command ran");
            shell.close("stuck");
        });
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
