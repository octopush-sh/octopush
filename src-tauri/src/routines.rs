//! Routines — scheduled crews (Pro, `routines.scheduled`).
//!
//! A routine is a saved pipeline + a schedule. An in-app scheduler ticks every
//! 30s, fires the routines whose window has come due, and drives each via the
//! same guarded launch path a user's Begin uses — so a scheduled crew is a
//! detached crew, surviving the app quitting once it's running.
//!
//! Phase 1 fires only while the app runs; a window missed while the app was
//! closed catches up ONCE on the next tick (never N times — `next_due` jumps
//! to the next future slot). See the design record:
//! `docs/superpowers/plans/2026-07-13-routines-phase1-design.md`.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Datelike, Local, NaiveDate, TimeZone, Utc};

use crate::db::RoutineRow;
use crate::orchestrator::launch;
use crate::orchestrator::Orchestrator;

/// Scheduler cadence. Coarser than the detached bridge (a schedule resolves to
/// minutes, not seconds); one indexed SELECT per tick, nothing when no routine
/// is due.
const TICK_SECS: u64 = 30;

/// How long a routine's `fire_condition` may run before it's treated as a
/// (skip-inducing) error. Bounds the command so a hung check can never stall the
/// 30s scheduler tick.
const CONDITION_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a fresh worktree's setup script (`npm install`, …) may run before
/// the fire is skipped. Fires run detached, so this never stalls the tick; it
/// stays under the 15-minute minimum window so fires can't overlap.
const SETUP_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// The schedule kinds. `interval`/`daily` are the original simple cadences;
/// `recurring` is the flexible Days×Times model (spec = JSON, see `RecurringSpec`).
pub const KIND_INTERVAL: &str = "interval";
pub const KIND_DAILY: &str = "daily";
pub const KIND_RECURRING: &str = "recurring";

/// The quota-safety floor on a window's step, analogous to `interval`'s 60s
/// floor: a window can fire at most every 15 minutes (≤ 96 fires/day).
const MIN_WINDOW_STEP_MIN: i64 = 15;

/// Why a fire skipped its window (each existing skip site maps onto one). Serde
/// carries a machine token + a human `reason` string for the ipc/toast.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum SkipReason {
    /// The target workspace already has a live run (or the launch was refused).
    Busy,
    /// The `fire_condition` command exited 1 — nothing to do this window.
    ConditionNotMet,
    /// The `fire_condition` couldn't be evaluated (spawn failure / timeout / an
    /// exit other than 0 or 1) — fail-SAFE: skip rather than fire blindly, and
    /// surface why.
    ConditionError(String),
    /// The workspace couldn't be resolved (deleted / off-disk / unconfigured).
    WorkspaceUnavailable,
    /// The guarded launch refused the run (monthly quota, budget, parallel-runs
    /// gate, lease) — carries the refusal's first line so the toast/`last_outcome`
    /// name the real reason instead of a misleading "workspace busy".
    LaunchRefused(String),
    /// A fresh worktree's setup script failed — the worktree is discarded and
    /// no run is created.
    SetupFailed(String),
}

impl SkipReason {
    /// A short human string for `last_outcome` and the run-now toast.
    pub fn label(&self) -> String {
        match self {
            SkipReason::Busy => "workspace busy".to_string(),
            SkipReason::ConditionNotMet => "condition not met".to_string(),
            SkipReason::ConditionError(msg) => format!("condition error: {msg}"),
            SkipReason::WorkspaceUnavailable => "workspace unavailable".to_string(),
            SkipReason::LaunchRefused(msg) => msg.clone(),
            SkipReason::SetupFailed(msg) => format!("setup failed: {msg}"),
        }
    }

    /// A stable machine token for the frontend (the run-now toast picks its
    /// wording by it, never by parsing `label`).
    pub fn token(&self) -> &'static str {
        match self {
            SkipReason::Busy => "busy",
            SkipReason::ConditionNotMet => "condition_not_met",
            SkipReason::ConditionError(_) => "condition_error",
            SkipReason::WorkspaceUnavailable => "workspace_unavailable",
            SkipReason::LaunchRefused(_) => "launch_refused",
            SkipReason::SetupFailed(_) => "setup_failed",
        }
    }
}

/// Whether a routine fire actually dispatched a run (vs. skipped the window).
/// Lets `run_routine_now` report honestly instead of always celebrating a
/// dispatch, and drives the legibility `last_outcome`.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum FireOutcome {
    Dispatched,
    Skipped(SkipReason),
}

impl FireOutcome {
    /// The string stamped into `last_outcome` on every evaluation.
    pub fn last_outcome_label(&self) -> String {
        match self {
            FireOutcome::Dispatched => "dispatched".to_string(),
            FireOutcome::Skipped(reason) => reason.label(),
        }
    }

    /// The flattened, serde-friendly shape the frontend renders:
    /// `{ outcome: "dispatched" | "skipped", reason?: <human string>, skip?: <token> }`.
    pub fn view(&self) -> FireOutcomeView {
        match self {
            FireOutcome::Dispatched => FireOutcomeView {
                outcome: "dispatched",
                reason: None,
                skip: None,
            },
            FireOutcome::Skipped(reason) => FireOutcomeView {
                outcome: "skipped",
                reason: Some(reason.label()),
                skip: Some(reason.token()),
            },
        }
    }
}

/// The ipc shape for a fire outcome — `run_routine_now` returns this so "Run
/// now" can report honestly (dispatched, or "skipped · condition not met").
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FireOutcomeView {
    /// "dispatched" | "skipped".
    pub outcome: &'static str,
    /// The human skip reason, present only for a skip.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The skip's machine token (`SkipReason::token`), present only for a skip.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip: Option<&'static str>,
}

/// Frontend event a fire emits as it moves through its phases
/// (`{ routineId, phase }`), so "Run now" can say what it is waiting on.
pub const ROUTINE_PHASE_EVENT: &str = "routine://phase";

/// The phases a fire reports, in order (a phase that doesn't apply is skipped).
pub const PHASE_CONDITION: &str = "condition";
pub const PHASE_WORKSPACE: &str = "workspace";
pub const PHASE_SETUP: &str = "setup";
pub const PHASE_LAUNCHING: &str = "launching";

/// The outcome of resolving + guarding a fixed routine's workspace: ready to
/// fire (with its id + worktree path), or a reason to skip this window.
enum FixedResolve {
    Ready { id: String, worktree: Option<String> },
    Skip(SkipReason),
}

/// The result of evaluating a routine's `fire_condition` command.
#[derive(Debug, PartialEq, Eq)]
pub enum ConditionEval {
    /// exit 0 — fire.
    Met,
    /// exit 1 — skip this window (nothing to do).
    NotMet,
    /// couldn't evaluate (spawn failure, timeout, or any exit other than 0/1,
    /// e.g. `127` command not found) — skip, fail-safe, and say why.
    Error(String),
}

/// How long resolving the user's login-shell PATH may take. A slow or
/// interactive rc file (a prompt, a `read`, a network call) can never hang a
/// routine: past this, the condition falls back to the inherited PATH.
const LOGIN_PATH_TIMEOUT: Duration = Duration::from_secs(5);

/// Delimits `$PATH` in the login shell's stdout, so whatever the rc files print
/// (banners, `nvm` notices) can't be mistaken for it.
const PATH_MARKER: &str = "__OCTOPUSH_PATH__";

/// How many trailing stderr lines a condition error keeps for `last_outcome`.
const STDERR_TAIL_LINES: usize = 2;

/// Cap on the stderr part of a condition error, so one noisy line can't flood
/// the Routines list.
const STDERR_TAIL_MAX_CHARS: usize = 160;

/// Pull the PATH printed between two `PATH_MARKER`s out of a login shell's
/// stdout. `None` when the markers are missing or the PATH is empty.
pub fn extract_marked_path(stdout: &str) -> Option<String> {
    let start = stdout.find(PATH_MARKER)? + PATH_MARKER.len();
    let len = stdout[start..].find(PATH_MARKER)?;
    let path = stdout[start..start + len].trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// Ask `shell` for the PATH a login + interactive session would have
/// (`$SHELL -l -i -c`, so `~/.zprofile` AND `~/.zshrc` are sourced — where
/// Homebrew, nvm and `~/.local/bin` usually land). Bounded by `timeout`; the
/// shell gets no stdin and its own session, and the whole group is killed on
/// timeout. `None` on any failure.
pub async fn login_shell_path(shell: &str, timeout: Duration) -> Option<String> {
    let mut cmd = tokio::process::Command::new(shell);
    cmd.args(["-l", "-i", "-c"])
        .arg(format!("printf '%s%s%s' '{PATH_MARKER}' \"$PATH\" '{PATH_MARKER}'"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    unsafe {
        // SAFETY: as in `evaluate_condition_with_path`.
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = cmd.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let read = tokio::spawn(read_to_string_lossy(stdout));
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(_)) => {}
        _ => {
            kill_process_group(&mut child);
            let _ = child.wait().await;
            return None;
        }
    }
    // The marker is printed before exit; a backgrounded rc job still holding
    // the pipe must not stall us either.
    let out = tokio::time::timeout(Duration::from_secs(1), read).await.ok()?.ok()?;
    extract_marked_path(&out)
}

/// The PATH a fire condition runs with: the user's login-shell PATH (resolved
/// once per app session and cached), then the app's inherited PATH. GUI apps
/// start from launchd's minimal `/usr/bin:/bin:/usr/sbin:/sbin`, and `bash -l`
/// alone never reads zsh's rc files, so without this `gh`/`node`/`claude` are
/// "command not found".
async fn condition_path() -> String {
    static LOGIN_PATH: tokio::sync::OnceCell<Option<String>> = tokio::sync::OnceCell::const_new();
    let login = LOGIN_PATH
        .get_or_init(|| async {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            let path = login_shell_path(&shell, LOGIN_PATH_TIMEOUT).await;
            if path.is_none() {
                tracing::warn!(%shell, "could not resolve the login-shell PATH for routine conditions — using the inherited PATH");
            }
            path
        })
        .await;
    let inherited = std::env::var("PATH").unwrap_or_default();
    crate::orchestrator::cli_runner::merge_path_dirs(&[login.as_deref().unwrap_or(""), &inherited])
}

/// The last `STDERR_TAIL_LINES` non-empty lines of `stderr`, joined with
/// " · " and capped at `STDERR_TAIL_MAX_CHARS` (an ellipsis marks the cut).
pub fn stderr_tail(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let tail = lines[lines.len().saturating_sub(STDERR_TAIL_LINES)..].join(" · ");
    if tail.chars().count() <= STDERR_TAIL_MAX_CHARS {
        return tail;
    }
    let cut: String = tail.chars().take(STDERR_TAIL_MAX_CHARS - 1).collect();
    format!("{cut}…")
}

/// Classify a finished condition: exit 0 ⇒ `Met`, exit 1 ⇒ `NotMet`, anything
/// else (exit 2, 127, killed by a signal) ⇒ `Error` carrying the stderr tail,
/// so a broken check never reads as a legitimate "nothing to do".
pub fn classify_condition_exit(code: Option<i32>, stderr: &str) -> ConditionEval {
    let what = match code {
        Some(0) => return ConditionEval::Met,
        Some(1) => return ConditionEval::NotMet,
        Some(n) => format!("exit {n}"),
        None => "killed by a signal".to_string(),
    };
    let tail = stderr_tail(stderr);
    if tail.is_empty() {
        ConditionEval::Error(what)
    } else {
        ConditionEval::Error(format!("{what} · {tail}"))
    }
}

/// Read a child pipe to the end, lossily (a condition's stderr is shown, never
/// parsed, so bad UTF-8 must not lose the rest).
async fn read_to_string_lossy(mut pipe: impl tokio::io::AsyncRead + Unpin) -> String {
    use tokio::io::AsyncReadExt;
    let mut buf = Vec::new();
    let _ = pipe.read_to_end(&mut buf).await;
    String::from_utf8_lossy(&buf).into_owned()
}

/// Run a routine's `fire_condition` shell command in `cwd`, bounded by `timeout`,
/// with the user's login-shell PATH (`condition_path`) so `gh`, `node`, `npx`
/// and `claude` resolve — the SAME trust model as a run's `run_command` (their
/// command, their machine). See `evaluate_condition_with_path`.
pub async fn evaluate_condition(command: &str, cwd: &Path, timeout: Duration) -> ConditionEval {
    let path = condition_path().await;
    evaluate_condition_with_path(command, cwd, timeout, &path).await
}

/// Run `command` under `bash -c` with `PATH = path`. exit 0 ⇒ `Met`; exit 1 ⇒
/// `NotMet`; any other exit, spawn failure or timeout ⇒ `Error` (with the last
/// stderr lines, so the Routines list shows *why*).
pub async fn evaluate_condition_with_path(command: &str, cwd: &Path, timeout: Duration, path: &str) -> ConditionEval {
    match run_bounded("condition", command, cwd, timeout, path).await {
        Ok((code, stderr)) => classify_condition_exit(code, &stderr),
        Err(msg) => ConditionEval::Error(msg),
    }
}

/// Run a project's setup script headless in a Routine's fresh worktree, before
/// its crew launches: the same `bash -c` + login-shell PATH as a fire
/// condition. `Err` carries why it failed, for `last_outcome`.
pub async fn run_setup(script: &str, cwd: &Path, timeout: Duration) -> Result<(), String> {
    let path = condition_path().await;
    run_setup_with_path(script, cwd, timeout, &path).await
}

/// See `run_setup`; `path` is the PATH the script runs with.
pub async fn run_setup_with_path(script: &str, cwd: &Path, timeout: Duration, path: &str) -> Result<(), String> {
    let (code, stderr) = run_bounded("setup", script, cwd, timeout, path).await?;
    classify_setup_exit(code, &stderr)
}

/// Whether a fresh routine workspace whose setup failed may be removed: only
/// a worktree `workspace::create` just made. An adopted, reused or restored
/// one is an existing checkout, and its files are never deleted.
pub fn discards_on_setup_failure(outcome: crate::workspace::CreateOutcome) -> bool {
    outcome == crate::workspace::CreateOutcome::Created
}

/// exit 0 ⇒ `Ok`; anything else ⇒ `Err("exit N · <stderr tail>")`.
pub fn classify_setup_exit(code: Option<i32>, stderr: &str) -> Result<(), String> {
    let what = match code {
        Some(0) => return Ok(()),
        Some(n) => format!("exit {n}"),
        None => "killed by a signal".to_string(),
    };
    let tail = stderr_tail(stderr);
    Err(if tail.is_empty() { what } else { format!("{what} · {tail}") })
}

/// Run `command` under `bash -c` in `cwd` with `PATH = path`, bounded by
/// `timeout`. `Ok((exit code, stderr))` when it finished; `Err` (naming `what`)
/// on a spawn failure or a timeout.
///
/// The child is launched as its OWN process-group/session leader (`setsid`), so
/// on timeout the WHOLE group is killed — a pipeline like `gh … | grep -q .`
/// leaves no orphaned `gh` reparented past the tick. `kill_on_drop` is the
/// backstop.
async fn run_bounded(what: &str, command: &str, cwd: &Path, timeout: Duration, path: &str) -> Result<(Option<i32>, String), String> {
    let mut cmd = tokio::process::Command::new("bash");
    cmd.arg("-c")
        .arg(command)
        .current_dir(cwd)
        .env("PATH", path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    // Own session/process group so a timeout can kill the whole pipeline, not
    // just `bash` (mirrors how the detached worker isolates its group).
    #[cfg(unix)]
    unsafe {
        // SAFETY: `setsid()` is async-signal-safe and is the only call made in
        // the forked child before exec.
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => return Err(format!("could not launch {what}: {e}")),
    };
    // Until the child is reaped, a dropped future (or the app quitting) kills
    // its whole group — `kill_on_drop` alone would kill only `bash`.
    let mut group = GroupGuard::new(child.id());
    // Drain stderr concurrently so a chatty command can't block on a full pipe.
    let stderr = child.stderr.take().map(|pipe| tokio::spawn(read_to_string_lossy(pipe)));
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => {
            group.disarm();
            // A backgrounded grandchild may still hold stderr open — never wait
            // on it past a moment.
            let err = match stderr {
                Some(task) => tokio::time::timeout(Duration::from_secs(1), task)
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .unwrap_or_default(),
                None => String::new(),
            };
            Ok((status.code(), err))
        }
        Ok(Err(e)) => Err(format!("{what} wait failed: {e}")),
        Err(_) => {
            // Timed out — kill the whole process group (not just `bash`), then
            // reap so no zombie lingers.
            kill_process_group(&mut child);
            let _ = child.wait().await;
            group.disarm();
            Err(format!("{what} timed out after {}s", timeout.as_secs()))
        }
    }
}

/// The process groups of the conditions and setup scripts running right now.
/// The process can exit on quit without dropping their futures, so
/// `kill_live_groups` (on `RunEvent::Exit`) kills them explicitly.
static LIVE_GROUPS: std::sync::Mutex<Vec<i32>> = std::sync::Mutex::new(Vec::new());

/// SIGKILL every live condition / setup process group (the app is quitting).
pub fn kill_live_groups() {
    let groups = std::mem::take(&mut *LIVE_GROUPS.lock().unwrap_or_else(|e| e.into_inner()));
    for pid in groups {
        kill_group(pid);
    }
}

#[cfg(unix)]
fn kill_group(pid: i32) {
    // SAFETY: kill(-pid, SIGKILL) signals the group `setsid` created for a
    // child that has not been reaped yet (the guard disarms on reap).
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_group(_pid: i32) {}

/// Registers a `setsid` child's process group in `LIVE_GROUPS` and kills the
/// group when dropped still armed. `disarm` once the child is reaped, so a
/// recycled pid is never signalled.
struct GroupGuard {
    pid: Option<i32>,
}

impl GroupGuard {
    fn new(pid: Option<u32>) -> Self {
        let pid = pid.map(|p| p as i32);
        if let Some(p) = pid {
            LIVE_GROUPS.lock().unwrap_or_else(|e| e.into_inner()).push(p);
        }
        Self { pid }
    }

    /// Unregister without killing; the pid when it was still registered.
    fn release(&mut self) -> Option<i32> {
        let pid = self.pid.take()?;
        let mut live = LIVE_GROUPS.lock().unwrap_or_else(|e| e.into_inner());
        let pos = live.iter().position(|&p| p == pid)?;
        live.swap_remove(pos);
        Some(pid)
    }

    fn disarm(&mut self) {
        self.release();
    }
}

impl Drop for GroupGuard {
    fn drop(&mut self) {
        // Not in the list any more ⇒ `kill_live_groups` already killed it.
        if let Some(pid) = self.release() {
            kill_group(pid);
        }
    }
}

/// SIGKILL the child's entire process group. The child is a session leader
/// (`setsid` in `evaluate_condition`), so `-pid` addresses its group and reaps
/// any pipeline members with it. Falls back to killing just the child when the
/// group can't be addressed (no pid / non-Unix).
fn kill_process_group(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // SAFETY: kill(-pid, SIGKILL) signals the group `setsid` created for this
        // child; `pid` comes from the live child handle.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
        return;
    }
    let _ = child.start_kill();
}

/// Compute a routine's next fire as a UTC RFC3339 string, from its schedule and
/// a reference instant (`after`, in machine-local time). Pure — the scheduler
/// passes `Local::now()`, tests pass a fixed instant. `None` for an invalid
/// spec (a routine with no `next_due_at` is simply never due).
///
/// - `interval`: spec = whole seconds; next = `after + secs` (no drift accrual —
///   scheduling from the fire instant, not a fixed epoch, keeps catch-up to one).
/// - `daily`: spec = `HH:MM` machine-local; next = the next occurrence strictly
///   after `after`. Stored in UTC so SQL string comparison stays a valid time
///   comparison across DST offset changes.
pub fn next_due(kind: &str, spec: &str, after: DateTime<Local>) -> Option<String> {
    match kind {
        KIND_INTERVAL => {
            let secs: i64 = spec.trim().parse().ok()?;
            if secs <= 0 {
                return None;
            }
            Some((after + chrono::Duration::seconds(secs)).with_timezone(&Utc).to_rfc3339())
        }
        KIND_DAILY => {
            let (hh, mm) = parse_hhmm(spec)?;
            // Today's HH:MM local; if already passed, tomorrow's.
            let mut candidate = local_at(after, hh, mm)?;
            if candidate <= after {
                let tomorrow = after + chrono::Duration::days(1);
                candidate = local_at(tomorrow, hh, mm)?;
            }
            Some(candidate.with_timezone(&Utc).to_rfc3339())
        }
        KIND_RECURRING => {
            let spec = RecurringSpec::parse(spec).ok()?;
            next_due_recurring(&spec, after)
        }
        _ => None,
    }
}

// ── recurring schedules (Days × Times) ──────────────────────────────────────

/// A `recurring` schedule: which days it's active, and at what time(s) within a
/// day. Serialized as JSON into `schedule_spec`. See the design record.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct RecurringSpec {
    pub days: DaySel,
    pub time: TimeSel,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DaySel {
    /// A non-empty set of ISO weekdays (1 = Monday … 7 = Sunday). Covers "every
    /// day" (all 7), "weekdays" (1–5), and any specific subset.
    Weekly { set: Vec<u8> },
    /// A single calendar date (YYYY-MM-DD) — a one-shot.
    Date { date: String },
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TimeSel {
    /// Fire once per active day, at `at` (HH:MM machine-local).
    Once { at: String },
    /// Fire every `every_minutes` from `start` through `end` (inclusive),
    /// machine-local.
    Window {
        start: String,
        #[serde(rename = "everyMinutes")]
        every_minutes: i64,
        end: String,
    },
}

impl RecurringSpec {
    fn parse(spec: &str) -> Result<Self, String> {
        serde_json::from_str(spec).map_err(|e| format!("invalid recurring schedule: {e}"))
    }
}

/// The (hh, mm) fire times within a single active day, ascending. `once` yields
/// one; `window` enumerates `start, start+every, … ≤ end`. Returns empty on a
/// malformed HH:MM or a non-positive step (the caller then finds no instant).
fn day_times(time: &TimeSel) -> Vec<(u32, u32)> {
    match time {
        TimeSel::Once { at } => parse_hhmm(at).into_iter().collect(),
        TimeSel::Window { start, every_minutes, end } => {
            let (Some((sh, sm)), Some((eh, em))) = (parse_hhmm(start), parse_hhmm(end)) else {
                return Vec::new();
            };
            if *every_minutes <= 0 {
                return Vec::new();
            }
            let start_min = sh as i64 * 60 + sm as i64;
            let end_min = eh as i64 * 60 + em as i64;
            let mut out = Vec::new();
            let mut t = start_min;
            // Bounded by a day; the ≥15-min validated floor caps this at ≤96.
            // `saturating_add` is belt-and-suspenders against a step that slipped
            // past validation (the validator also caps it at 1440).
            let mut guard = 0;
            while t <= end_min && guard < 24 * 60 {
                out.push(((t / 60) as u32, (t % 60) as u32));
                t = t.saturating_add(*every_minutes);
                guard += 1;
            }
            out
        }
    }
}

/// Whether `day` (a local calendar date) is active for this day selector.
fn day_active(day: NaiveDate, days: &DaySel) -> bool {
    match days {
        DaySel::Weekly { set } => set.contains(&(day.weekday().number_from_monday() as u8)),
        DaySel::Date { date } => NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map(|d| d == day)
            .unwrap_or(false),
    }
}

/// Next fire (UTC RFC3339) for a recurring schedule strictly after `after`.
/// Scans forward day-by-day (bounded) for the first active day with a fire
/// instant after `after`. A `date` selector whose date is already past → None.
fn next_due_recurring(spec: &RecurringSpec, after: DateTime<Local>) -> Option<String> {
    let start_day = after.date_naive();
    // A one-shot `date` is a single known day — compute it DIRECTLY (no scan
    // bound), so a date arbitrarily far in the future still fires. A date fully
    // in the past (or today with all its times already elapsed) → None.
    if let DaySel::Date { date } = &spec.days {
        let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
        if d < start_day {
            return None;
        }
        return day_times(&spec.time)
            .into_iter()
            .filter_map(|(hh, mm)| local_at_date(d, hh, mm))
            .find(|inst| *inst > after)
            .map(|inst| inst.with_timezone(&Utc).to_rfc3339());
    }
    // Weekly: a non-empty day set guarantees an active day within 7 — 400 is
    // ample headroom (and can't miss a fire).
    for offset in 0..400 {
        let day = start_day.checked_add_signed(chrono::Duration::days(offset))?;
        if !day_active(day, &spec.days) {
            continue;
        }
        for (hh, mm) in day_times(&spec.time) {
            if let Some(inst) = local_at_date(day, hh, mm) {
                if inst > after {
                    return Some(inst.with_timezone(&Utc).to_rfc3339());
                }
            }
        }
    }
    None
}

/// The next `n` fires (UTC RFC3339, ascending) after `after`, for the editor
/// preview. Iterates the real `next_due` — one engine, no drift. Stops early if
/// the schedule runs out (a past one-shot yields an empty list).
pub fn next_n_due(kind: &str, spec: &str, after: DateTime<Local>, n: usize) -> Vec<String> {
    let mut out = Vec::with_capacity(n);
    let mut cursor = after;
    for _ in 0..n {
        let Some(iso) = next_due(kind, spec, cursor) else { break };
        let Ok(parsed) = DateTime::parse_from_rfc3339(&iso) else { break };
        cursor = parsed.with_timezone(&Local);
        out.push(iso);
    }
    out
}

/// Validate a schedule spec at authoring time (clear error before it's stored).
pub fn validate_schedule(kind: &str, spec: &str) -> Result<(), String> {
    match kind {
        KIND_INTERVAL => {
            let secs: i64 = spec
                .trim()
                .parse()
                .map_err(|_| "interval must be a whole number of seconds".to_string())?;
            // Floor at a minute — a tighter cadence than the tick is meaningless
            // and would hammer the quota.
            if secs < 60 {
                return Err("interval must be at least 60 seconds".into());
            }
            Ok(())
        }
        KIND_DAILY => parse_hhmm(spec)
            .map(|_| ())
            .ok_or_else(|| "daily time must be HH:MM (24-hour)".to_string()),
        KIND_RECURRING => validate_recurring(spec),
        other => Err(format!("unknown schedule kind '{other}'")),
    }
}

/// Validate a `recurring` spec: at least one active day, valid times, and a
/// window bounded to the ≥15-min floor with end ≥ start.
fn validate_recurring(spec: &str) -> Result<(), String> {
    let spec = RecurringSpec::parse(spec)?;
    match &spec.days {
        DaySel::Weekly { set } => {
            if set.is_empty() {
                return Err("choose at least one day of the week".into());
            }
            if set.iter().any(|d| !(1..=7).contains(d)) {
                return Err("weekday numbers must be 1 (Monday) through 7 (Sunday)".into());
            }
        }
        DaySel::Date { date } => {
            NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .map_err(|_| "date must be YYYY-MM-DD".to_string())?;
        }
    }
    match &spec.time {
        TimeSel::Once { at } => {
            parse_hhmm(at).ok_or_else(|| "time must be HH:MM (24-hour)".to_string())?;
        }
        TimeSel::Window { start, every_minutes, end } => {
            let (sh, sm) = parse_hhmm(start).ok_or("window start must be HH:MM (24-hour)")?;
            let (eh, em) = parse_hhmm(end).ok_or("window end must be HH:MM (24-hour)")?;
            if *every_minutes < MIN_WINDOW_STEP_MIN {
                return Err(format!("a window must step at least {MIN_WINDOW_STEP_MIN} minutes"));
            }
            // A window lives inside one day; an upper bound (also) keeps the
            // enumeration arithmetic well away from overflow.
            if *every_minutes > 24 * 60 {
                return Err("a window step can't exceed a day (1440 minutes)".into());
            }
            let (s, e) = (sh as i64 * 60 + sm as i64, eh as i64 * 60 + em as i64);
            if e < s {
                return Err("the window's end time must be at or after its start".into());
            }
        }
    }
    Ok(())
}

/// Cross-field validation at authoring time. Phase-1 rule: a `fresh`-workspace
/// routine must fire **at most once per day**. A fresh fire creates a NEW
/// worktree, and phase 1 has no auto-reaper — a sub-daily `fresh` cadence would
/// generate worktrees without bound. So a fresh routine may be `daily`, or
/// `recurring` with a `once` time (any days) — but never `interval` or a
/// `recurring` `window`. Frequent-fresh returns with the retention reaper.
pub fn validate_routine(
    workspace_mode: &str,
    schedule_kind: &str,
    schedule_spec: &str,
) -> Result<(), String> {
    if workspace_mode != "fresh" {
        return Ok(());
    }
    let once_per_day = match schedule_kind {
        KIND_DAILY => true,
        KIND_RECURRING => matches!(
            RecurringSpec::parse(schedule_spec).map(|s| s.time),
            Ok(TimeSel::Once { .. })
        ),
        _ => false, // interval (unbounded) and anything unknown
    };
    if !once_per_day {
        return Err(
            "a fresh-workspace routine must fire at most once a day — a new worktree per run needs a daily cadence (use Daily, or a Custom schedule with a single time; frequent fresh runs arrive with automatic cleanup)".into(),
        );
    }
    Ok(())
}

fn parse_hhmm(spec: &str) -> Option<(u32, u32)> {
    let (h, m) = spec.trim().split_once(':')?;
    let hh: u32 = h.parse().ok()?;
    let mm: u32 = m.parse().ok()?;
    if hh < 24 && mm < 60 {
        Some((hh, mm))
    } else {
        None
    }
}

/// The local datetime at `date_of(reference)` + `HH:MM`. Resolves a DST gap/fold
/// to the earliest valid instant (a routine at a skipped/dup wall-clock time
/// still fires once, close to intent).
fn local_at(reference: DateTime<Local>, hh: u32, mm: u32) -> Option<DateTime<Local>> {
    local_at_date(reference.date_naive(), hh, mm)
}

/// The local datetime at `date` + `HH:MM`, resolving a DST gap/fold to the
/// earliest valid instant (a routine at a skipped/dup wall-clock time still
/// fires once, close to intent).
fn local_at_date(date: NaiveDate, hh: u32, mm: u32) -> Option<DateTime<Local>> {
    let naive = date.and_hms_opt(hh, mm, 0)?;
    match Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => Some(dt),
        chrono::LocalResult::Ambiguous(a, _) => Some(a),
        chrono::LocalResult::None => {
            // Spring-forward gap: nudge past it and take the resulting instant.
            Local.from_local_datetime(&(naive + chrono::Duration::hours(1))).earliest()
        }
    }
}

/// Compute a routine's next due from its own schedule, anchored at `now`.
fn next_due_for(r: &RoutineRow, now: DateTime<Local>) -> Option<String> {
    next_due(&r.schedule_kind, &r.schedule_spec, now)
}

impl Orchestrator {
    /// Spawn the background scheduler (one line beside `spawn_detached_bridge`
    /// in `lib.rs`). Idles cheaply — one indexed SELECT per tick — until a
    /// routine comes due.
    pub fn spawn_routine_scheduler(self: Arc<Self>) {
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(TICK_SECS)).await;
                self.routine_tick().await;
            }
        });
    }

    /// Fire a specific routine now (the "run now" affordance), regardless of
    /// schedule or enabled state — but through the identical guarded fire path.
    ///
    /// Schedule handling is asymmetric on purpose: if the routine's window is
    /// already OVERDUE (`next_due <= now`), consume it (advance to the next slot
    /// after now) so the next scheduler tick won't re-fire the SAME window — a
    /// manual fire on a due window must not become a double run/spend. A FUTURE
    /// window is left untouched (a manual test must not reschedule it).
    pub async fn run_routine_now(self: Arc<Self>, routine_id: &str) -> crate::error::AppResult<FireOutcome> {
        let routine = self.db()
            .lock()
            .get_routine(routine_id)?
            .ok_or_else(|| crate::error::AppError::Other("routine not found".into()))?;
        if let Some(due) = routine.next_due_at.as_deref() {
            if let Ok(due_dt) = DateTime::parse_from_rfc3339(due) {
                if due_dt.with_timezone(&Utc) <= Utc::now() {
                    let next = next_due_for(&routine, Local::now());
                    self.db().lock().set_routine_next_due(&routine.id, next.as_deref())?;
                }
            }
        }
        self.fire_routine(&routine).await
    }

    async fn routine_tick(self: &Arc<Self>) {
        // Defense in depth: a plan downgrade silently stops firing (the
        // create/enable commands are also gated).
        if !crate::entitlement::Entitlement::current()
            .has_feature(crate::entitlement::feature::ROUTINES_SCHEDULED)
        {
            return;
        }
        let now = Utc::now().to_rfc3339();
        let due = match self.db().lock().list_due_routines(&now) {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!(error = %e, "routine scheduler: list_due failed");
                return;
            }
        };
        for routine in due {
            // Advance the window FIRST, synchronously (the crash-safe invariant:
            // a window fires at most once, even if the fire below crashes or the
            // next tick races — next_due is already past `now`, so it won't be
            // re-selected). Only the SCHEDULED path advances; `run_routine_now`
            // deliberately does NOT (a manual test must not touch the schedule).
            if let Err(e) = self.advance_routine_window(&routine) {
                tracing::warn!(routine = %routine.id, error = %e, "routine scheduler: advance failed — skipping this tick");
                continue;
            }
            // Fire DETACHED: a condition may take up to CONDITION_TIMEOUT, and
            // awaiting each fire here would serialize the tick and delay every
            // other due routine (and the next tick). The outcome is stamped for
            // legibility inside `fire_routine`.
            let orch = Arc::clone(self);
            tokio::spawn(async move {
                if let Err(e) = orch.fire_routine(&routine).await {
                    tracing::warn!(routine = %routine.id, error = %e, "routine fire failed");
                }
            });
        }
    }

    /// Advance a routine past its current due window without firing (skip).
    fn advance_routine_window(&self, r: &RoutineRow) -> crate::error::AppResult<()> {
        let next = next_due_for(r, Local::now());
        self.db().lock().set_routine_next_due(&r.id, next.as_deref())
    }

    /// Fire one routine, then record the evaluation outcome for legibility on
    /// EVERY path — dispatch, skip, OR a hard error — so a routine that keeps
    /// skipping (or erroring) shows it's alive ("condition not met · 2m ago")
    /// instead of looking never-evaluated. Both the scheduled tick and
    /// `run_routine_now` go through this wrapper, so both stamp.
    async fn fire_routine(self: &Arc<Self>, r: &RoutineRow) -> crate::error::AppResult<FireOutcome> {
        let result = self.fire_routine_inner(r).await;
        let label = match &result {
            Ok(outcome) => outcome.last_outcome_label(),
            Err(e) => format!("error: {e}"),
        };
        // Best-effort — a legibility write must never mask the fire's own result.
        let _ = self
            .db()
            .lock()
            .set_routine_fire_result(&r.id, &Utc::now().to_rfc3339(), &label);
        result
    }

    /// The fire itself, branched by workspace mode. `next_due` is NOT advanced
    /// here (the scheduled tick advances up front; `run_routine_now` must not
    /// touch the schedule). Returns whether a run was dispatched or the window
    /// skipped (with the reason).
    async fn fire_routine_inner(self: &Arc<Self>, r: &RoutineRow) -> crate::error::AppResult<FireOutcome> {
        if r.workspace_mode == "fresh" {
            self.fire_fresh(r).await
        } else {
            self.fire_fixed(r).await
        }
    }

    /// Fixed mode: resolve + guard the chosen workspace FIRST (so a deleted
    /// workspace still auto-disables and a busy one is labelled `Busy`, not run
    /// into), THEN evaluate the condition inside that healthy, idle worktree,
    /// THEN dispatch.
    async fn fire_fixed(self: &Arc<Self>, r: &RoutineRow) -> crate::error::AppResult<FireOutcome> {
        let (workspace_id, worktree) = match self.resolve_fixed_workspace(r)? {
            FixedResolve::Ready { id, worktree } => (id, worktree),
            FixedResolve::Skip(reason) => return Ok(FireOutcome::Skipped(reason)),
        };

        // Condition gate — cwd = the resolved worktree (a healthy dir; the
        // resolver already skipped a deleted/off-disk one). A workspace with no
        // worktree path can't host a condition ⇒ fail-safe ConditionError.
        // `fire_condition` is already trimmed/None (the DB normalizes on write).
        if let Some(command) = r.fire_condition.as_deref() {
            self.emit_phase(r, PHASE_CONDITION);
            let eval = match &worktree {
                Some(path) => evaluate_condition(command, Path::new(path), CONDITION_TIMEOUT).await,
                None => ConditionEval::Error("routine's fixed workspace has no worktree".into()),
            };
            if let Some(skip) = self.condition_skip(r, eval) {
                return Ok(FireOutcome::Skipped(skip));
            }
        }

        self.dispatch_run(r, &workspace_id).await
    }

    /// Fresh mode: guard against stacking a worktree on the previous crew, THEN
    /// evaluate the condition at the project root (the fresh worktree doesn't
    /// exist yet), THEN create the worktree (only now — a skip creates none),
    /// run the project's setup script in it (a failure discards it and skips)
    /// and dispatch.
    async fn fire_fresh(self: &Arc<Self>, r: &RoutineRow) -> crate::error::AppResult<FireOutcome> {
        // Runaway guard: don't stack a new worktree while this routine's previous
        // crew is still active.
        if let Some(prev) = &r.last_run_id {
            if let Some(run) = self.db().lock().get_run(prev)? {
                if run.status == "running" || run.status == "paused" {
                    return Ok(FireOutcome::Skipped(SkipReason::Busy));
                }
            }
        }

        // Resolve the project ONCE — reused for the condition cwd AND the fresh
        // worktree (one SELECT per fire). A missing project is a hard error
        // (stamped + surfaced), consistent with a fixed routine's missing workspace.
        let project_path = self
            .db()
            .lock()
            .get_project_by_id(&r.project_id)?
            .ok_or_else(|| crate::error::AppError::Other("routine's project not found".into()))?
            .2;

        // Condition gate — cwd = the project root (the fresh worktree doesn't
        // exist yet). `fire_condition` is already trimmed/None (DB-normalized).
        if let Some(command) = r.fire_condition.as_deref() {
            self.emit_phase(r, PHASE_CONDITION);
            let eval = evaluate_condition(command, Path::new(&project_path), CONDITION_TIMEOUT).await;
            if let Some(skip) = self.condition_skip(r, eval) {
                return Ok(FireOutcome::Skipped(skip));
            }
        }

        // Create the fresh worktree only now (a skipped condition created none),
        // then run the project's setup-script template in it before the crew.
        let setup_script = self.db().lock().get_project_setup_script(&r.project_id)?;
        self.emit_phase(r, PHASE_WORKSPACE);
        let (ws, outcome) = self.create_fresh_routine_workspace(r, &project_path, &setup_script).await?;
        if !setup_script.trim().is_empty() {
            self.emit_phase(r, PHASE_SETUP);
            let result = match ws.worktree_path.as_deref() {
                Some(wt) => run_setup(&setup_script, Path::new(wt), SETUP_TIMEOUT).await,
                None => Err("the fresh workspace has no worktree".into()),
            };
            if let Err(msg) = result {
                tracing::warn!(routine = %r.id, error = %msg, "routine setup script failed — skipping");
                // A failed setup leaves no run behind — nor a worktree per window.
                // Only a worktree this fire created is removed: an adopted or
                // reused checkout is somebody's, never wiped.
                if discards_on_setup_failure(outcome) {
                    self.discard_fresh_workspace(&project_path, &ws);
                }
                return Ok(FireOutcome::Skipped(SkipReason::SetupFailed(msg)));
            }
        }
        self.dispatch_run(r, &ws.id).await
    }

    /// Tell the frontend which phase this fire is in (`ROUTINE_PHASE_EVENT`).
    fn emit_phase(&self, r: &RoutineRow, phase: &str) {
        crate::orchestrator::events::EventSink::emit(
            &**self.events(),
            ROUTINE_PHASE_EVENT,
            serde_json::json!({ "routineId": r.id, "phase": phase }),
        );
    }

    /// Remove a fresh routine workspace that will never run: its worktree, its
    /// branch (only when Octopush created it) and its row. Callers check
    /// `discards_on_setup_failure` first.
    fn discard_fresh_workspace(&self, project_path: &str, ws: &crate::db::WorkspaceRow) {
        let repo = Path::new(project_path);
        if let Some(wt) = ws.worktree_path.as_deref() {
            let _ = crate::git_ops::delete_worktree(repo, Path::new(wt));
            if Path::new(wt).exists() {
                let _ = std::fs::remove_dir_all(wt);
            }
        }
        let created_branch = self.db().lock().is_branch_created_by_octopush(&ws.id).unwrap_or(false);
        if created_branch {
            let _ = crate::git_ops::delete_branch(repo, &ws.branch);
        }
        let _ = self.db().lock().delete_workspace(&ws.id);
    }

    /// Map a condition evaluation to an optional skip reason (`None` ⇒ Met, fire
    /// on). Logs the fail-safe error path.
    fn condition_skip(&self, r: &RoutineRow, eval: ConditionEval) -> Option<SkipReason> {
        match eval {
            ConditionEval::Met => None,
            ConditionEval::NotMet => Some(SkipReason::ConditionNotMet),
            ConditionEval::Error(msg) => {
                tracing::warn!(routine = %r.id, error = %msg, "routine fire condition could not be evaluated — skipping");
                Some(SkipReason::ConditionError(msg))
            }
        }
    }

    /// Create the draft run, stamp it on the routine, and launch through the one
    /// shared guarded path (quota / parallel / lease / detached). A launch
    /// refusal deletes the never-started draft and skips.
    async fn dispatch_run(self: &Arc<Self>, r: &RoutineRow, workspace_id: &str) -> crate::error::AppResult<FireOutcome> {
        self.emit_phase(r, PHASE_LAUNCHING);
        let overrides = parse_stage_overrides(r.stage_overrides.as_deref());
        let run_id = self.db().lock().create_run(
            workspace_id,
            &r.pipeline_id,
            &r.task,
            r.reference_model.as_deref(),
            None,
            &overrides,
        )?;

        self.db()
            .lock()
            .stamp_routine_run(&r.id, &run_id, &Utc::now().to_rfc3339())?;

        if let Err(e) = launch::launch_run(self, self.db(), &run_id, r.budget_usd).await {
            tracing::warn!(routine = %r.id, run = %run_id, error = %e, "routine run refused at launch");
            // Delete the never-started draft (NOT abort — an aborted run counts
            // in the monthly meter and shows as a settled card; this one never ran).
            let _ = self.db().lock().delete_run(&run_id);
            // Carry the refusal's real reason (quota / budget / parallel-runs /
            // lease) — NOT a misleading "workspace busy" on an idle workspace.
            let reason = e.to_string();
            let first_line = reason.lines().next().unwrap_or("launch refused").trim().to_string();
            return Ok(FireOutcome::Skipped(SkipReason::LaunchRefused(first_line)));
        }
        Ok(FireOutcome::Dispatched)
    }

    /// Resolve + guard a fixed routine's workspace: auto-disable on a deleted
    /// workspace, skip on busy / off-disk, else return the id + worktree path.
    /// Runs BEFORE the condition gate so the command never executes inside a
    /// deleted/busy worktree.
    fn resolve_fixed_workspace(&self, r: &RoutineRow) -> crate::error::AppResult<FixedResolve> {
        let Some(ws_id) = r.fixed_workspace_id.clone() else {
            return Err(crate::error::AppError::Other(
                "routine has no fixed workspace configured".into(),
            ));
        };
        // Read the workspace once (drop the guard before any re-lock below —
        // the mutex is non-reentrant).
        let (exists, busy, worktree) = {
            let db = self.db().lock();
            match db.get_workspace(&ws_id)? {
                None => (false, false, None),
                Some(ws) => (true, db.workspace_has_active_run(&ws_id)?, ws.worktree_path),
            }
        };
        // The target workspace was DELETED — the routine can never run again.
        // Auto-disable it (surfaces as paused in the UI) rather than skipping
        // every window forever with no signal.
        if !exists {
            tracing::warn!(routine = %r.id, workspace = %ws_id, "routine's fixed workspace no longer exists — disabling the routine");
            self.db()
                .lock()
                .set_routine_enabled(&r.id, false, r.next_due_at.as_deref())?;
            return Ok(FixedResolve::Skip(SkipReason::WorkspaceUnavailable));
        }
        // Busy is transient (a previous run is still going) — just skip.
        if busy {
            return Ok(FixedResolve::Skip(SkipReason::Busy));
        }
        // Worktree deleted off disk but the row survives — skip (firing into a
        // missing directory would hard-fail); don't disable, it may be restored.
        if let Some(path) = &worktree {
            if !std::path::Path::new(path).is_dir() {
                tracing::warn!(routine = %r.id, workspace = %ws_id, "routine's fixed worktree is missing on disk — skipping");
                return Ok(FixedResolve::Skip(SkipReason::WorkspaceUnavailable));
            }
        }
        Ok(FixedResolve::Ready { id: ws_id, worktree })
    }

    /// Create a fresh worktree for this fire, on a UNIQUE branch (the routine's
    /// prefix + a timestamp + a short id) so `workspace::create`'s
    /// idempotency-on-branch yields a genuinely clean tree each time. The git
    /// checkout runs on a blocking thread so a large-repo fire can't stall the
    /// async runtime (the DB mutex is not held across it). Returns the
    /// `CreateOutcome` too: only a `Created` worktree may be discarded.
    async fn create_fresh_routine_workspace(
        &self,
        r: &RoutineRow,
        project_path: &str,
        setup_script: &str,
    ) -> crate::error::AppResult<(crate::db::WorkspaceRow, crate::workspace::CreateOutcome)> {
        let project_path = project_path.to_string();
        let setup_script = setup_script.to_string();
        let stamp = Local::now().format("%Y%m%d-%H%M%S");
        let short = uuid::Uuid::new_v4().to_string();
        let short = short[..6].to_string();
        let prefix = r
            .branch_prefix
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .unwrap_or("routine")
            .to_string();
        let branch = format!("{prefix}/{stamp}-{short}");
        let name = format!("{} · {stamp}", r.name);
        let base = r.base_branch.as_deref().unwrap_or("").to_string();
        let db = self.db().clone();
        let project_id = r.project_id.clone();
        let task = r.task.clone();
        let ws = tokio::task::spawn_blocking(move || {
            crate::workspace::create(
                &db,
                &project_id,
                Path::new(&project_path),
                &name,
                &task,
                &branch,
                &base,
                &setup_script,
            )
        })
        .await
        .map_err(|e| crate::error::AppError::Other(format!("worktree task panicked: {e}")))?;
        ws
    }
}

/// Parse the stored `[[position, model], …]` JSON overrides into the shape
/// `create_run` wants. A malformed blob degrades to no overrides.
fn parse_stage_overrides(json: Option<&str>) -> Vec<(i64, String)> {
    let Some(json) = json else { return Vec::new() };
    serde_json::from_str::<Vec<(i64, String)>>(json).unwrap_or_default()
}
