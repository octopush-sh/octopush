//! The menu bar Octo (#718): a macOS status item for the crews that need you.
//!
//! The icon is The Octo as a monochrome **template** image (macOS inks it to
//! match a light or dark menu bar, so there is no colour and no brass in the
//! system chrome), in three still poses of its rig: idle, working and blocked
//! (needs you), rendered by `scripts/tray-icons.py`. It never animates, so it
//! never competes with the app's one beacon. Beside it, the needs-you count
//! (the Dock badge's number), only when it is above 0.
//!
//! The menu is native (no second web surface): the count, then the crews
//! that need you and the Talk conversations whose approval card waits on
//! you, longest-waiting first like Mission Control's needs-you band, each
//! opening that crew's Direct surface or that conversation in Talk; then
//! Open Octopush and Quit Octopush.
//!
//! One source of truth: [`crate::fleet_status::refresh`] reads the active
//! runs once, on the run events it already listens to, and hands them here,
//! so the icon, the menu and the Dock badge can't disagree. Everything that
//! decides what the menu says is pure ([`model`], [`waiting`], [`reason`],
//! [`track_since`]); the Tauri calls below them only draw it. Showing it is a
//! setting (Settings › General › Attention › "Show in menu bar", on unless
//! saved `false`), and only macOS draws it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;

use parking_lot::Mutex;
use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{ParkedStage, ParkedStageRow, RunRow};
use crate::fleet_status::FleetStatus;
use crate::state::AppState;

pub const TRAY_ID: &str = "fleet";
/// Emitted to `main` when a crew is chosen in the menu: [`OpenRunPayload`].
pub const OPEN_RUN_EVENT: &str = "octo://open-run";
/// Emitted to `main` when a Talk conversation is chosen: [`OpenTalkPayload`].
pub const OPEN_TALK_EVENT: &str = "octo://open-talk";

const RUN_PREFIX: &str = "menu-bar:run:";
const TALK_PREFIX: &str = "menu-bar:talk:";
const OPEN_ID: &str = "menu-bar:open";
const HEADER_ID: &str = "menu-bar:count";
const MORE_ID: &str = "menu-bar:more";
/// Crews listed by name; the rest are counted in one line.
pub const MAX_ITEMS: usize = 10;
const NAME_MAX_CHARS: usize = 32;
const STAGE_MAX_CHARS: usize = 24;

/// The setting: on unless saved `false`.
pub fn enabled(settings: &crate::settings::AppSettings) -> bool {
    settings.menu_bar_enabled.unwrap_or(true)
}

// ─── The model (pure) ──────────────────────────────────────────────

/// The Octo's body language, as `useMascotState` maps it: something needs
/// you (blocked) > a crew is working > idle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayState {
    Idle,
    Working,
    Blocked,
}

/// Why a crew needs you, read off its blocked stages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    /// A stage stopped on a transient fault that Resume answers (a rate
    /// limit, an overload, a dropped connection, the relaunch's
    /// `interrupted` stamp): Mission Control's `stalled`.
    Stalled,
    /// A stage failed on a standing fault and halted the run.
    Halted,
    /// A Claude plan limit stopped a stage and it waits for the director.
    PlanLimit,
    /// A stage asked the director questions.
    Asked,
    /// The secret guard holds a stage before it starts.
    SecretHold,
    /// Spend reached the run's budget before the next stage.
    Budget,
    /// A stage's hand-off waits at its checkpoint gate.
    Gate,
    /// Paused before a stage: the director's own pause, or a spending limit
    /// outside the run.
    Paused,
}

impl Reason {
    pub fn word(self) -> &'static str {
        match self {
            Reason::Stalled => "stalled",
            Reason::Halted => "halted",
            Reason::PlanLimit => "plan limit",
            Reason::Asked => "asked you",
            Reason::SecretHold => "possible secret",
            Reason::Budget => "budget reached",
            Reason::Gate => "at the gate",
            Reason::Paused => "paused",
        }
    }
}

/// What a paused run waits on, and the stage it waits at. Precedence as in
/// Mission Control's card: a stopped stage first (`stalled` when its fault is
/// transient, `fleet_status::is_transient_halt`, else `halted`), then a
/// question, then a gate. `stages` are its blocked stages in stage order;
/// `budget_spent` is the drive's own budget gate (`plan_wait::budget_spent`).
pub fn reason(stages: &[&ParkedStage], budget_spent: bool) -> (Reason, Option<String>) {
    fn title(s: &ParkedStage) -> Option<String> {
        Some(s.title.clone()).filter(|t| !t.trim().is_empty())
    }
    if let Some(s) = stages.iter().find(|s| s.status == "failed" && !s.plan_limited) {
        let transient = crate::fleet_status::is_transient_halt(s.error.as_deref());
        return (if transient { Reason::Stalled } else { Reason::Halted }, title(s));
    }
    if let Some(s) = stages.iter().find(|s| s.status == "failed") {
        return (Reason::PlanLimit, title(s));
    }
    let at_gate = || stages.iter().filter(|s| s.status == "awaiting_checkpoint");
    if let Some(s) = at_gate().find(|s| s.asked) {
        return (Reason::Asked, title(s));
    }
    if let Some(s) = at_gate().find(|s| s.secret_held) {
        return (Reason::SecretHold, title(s));
    }
    match at_gate().next() {
        Some(s) if s.started => (Reason::Gate, title(s)),
        Some(s) if budget_spent => (Reason::Budget, title(s)),
        Some(s) => (Reason::Paused, title(s)),
        None => (Reason::Paused, None),
    }
}

/// A crew that needs you, as the menu lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct Waiting {
    pub run_id: String,
    /// The workspace's name, else the start of the task.
    pub name: String,
    pub stage: Option<String>,
    pub reason: Reason,
    /// When it started waiting (ms): the FIFO key.
    pub since_ms: i64,
}

/// A Talk conversation whose approval card waits on you, as the menu lists
/// it: its oldest card ([`crate::fleet_status::talk_conversations`]). What
/// kind of thing waits, never the command or its arguments.
#[derive(Clone, Debug, PartialEq)]
pub struct TalkWaiting {
    pub thread_id: String,
    /// The workspace's name, else "a workspace".
    pub name: String,
    /// The secret guard's card (a commit or push), not a flagged command.
    pub secret: bool,
    /// What the card asks about when it isn't a command (#1147).
    pub kind: Option<crate::talk_guard::CardKind>,
    /// When the card was raised (ms): the FIFO key, shared with the crews.
    pub since_ms: i64,
}

impl TalkWaiting {
    pub fn new(wait: &crate::chat_engine::ApprovalWait, workspace_name: Option<String>) -> Self {
        TalkWaiting {
            thread_id: wait.thread_id.clone(),
            name: workspace_name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "a workspace".to_string()),
            secret: wait.secret,
            kind: wait.kind,
            since_ms: wait.since_ms,
        }
    }
}

/// A run's status and when this session saw it change.
#[derive(Clone, Debug, PartialEq)]
pub struct Seen {
    pub status: String,
    pub since_ms: Option<i64>,
}

/// Time in state, as Mission Control keeps it (`runsStore.statusSince`): a
/// status change seen by this session is stamped `now`; a run first seen
/// already in its status has no stamp, and waits since it was created. Runs
/// no longer active are dropped.
pub fn track_since<'a>(
    prev: &HashMap<String, Seen>,
    runs: impl IntoIterator<Item = (&'a str, &'a str)>,
    now_ms: i64,
) -> HashMap<String, Seen> {
    runs.into_iter()
        .map(|(id, status)| {
            let since_ms = match prev.get(id) {
                Some(seen) if seen.status == status => seen.since_ms,
                Some(_) => Some(now_ms),
                None => None,
            };
            (id.to_string(), Seen { status: status.to_string(), since_ms })
        })
        .collect()
}

fn created_ms(created_at: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(created_at).map(|d| d.timestamp_millis()).unwrap_or(0)
}

/// The crews that need you, in no particular order ([`model`] sorts them):
/// the runs the Dock badge counts ([`crate::fleet_status::needs_you`]), with
/// what each waits on from `parked` ([`crate::db::Db::list_parked_stages`]).
pub fn waiting(runs: &[RunRow], parked: &[ParkedStageRow], seen: &HashMap<String, Seen>) -> Vec<Waiting> {
    runs.iter()
        .filter(|r| crate::fleet_status::needs_you(&r.status, crate::fleet_status::plan_waiting(r)))
        .map(|r| {
            let rows: Vec<&ParkedStageRow> = parked.iter().filter(|p| p.run_id == r.id).collect();
            let stages: Vec<&ParkedStage> = rows.iter().filter_map(|p| p.stage.as_ref()).collect();
            let (reason, stage) = reason(&stages, crate::orchestrator::plan_wait::budget_spent(r));
            let name = rows
                .iter()
                .find_map(|p| p.workspace_name.clone())
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| r.task.lines().next().unwrap_or_default().to_string());
            let since_ms = seen.get(&r.id).and_then(|s| s.since_ms).unwrap_or_else(|| created_ms(&r.created_at));
            Waiting { run_id: r.id.clone(), name, stage, reason, since_ms }
        })
        .collect()
}

/// One menu entry: its id and its text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub label: String,
}

/// Everything the status item shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MenuModel {
    pub state: TrayState,
    /// Beside the icon: the needs-you count, only above 0.
    pub title: Option<String>,
    pub tooltip: String,
    /// The first line of the menu (disabled).
    pub header: String,
    pub items: Vec<Entry>,
    /// "and 3 more", past [`MAX_ITEMS`] (disabled).
    pub more: Option<String>,
}

fn crews(k: usize) -> String {
    if k == 1 { "1 crew".to_string() } else { format!("{k} crews") }
}

fn conversations(k: usize) -> String {
    if k == 1 { "1 conversation".to_string() } else { format!("{k} conversations") }
}

/// "1 crew needs you", "2 conversations need you", "1 crew and 1
/// conversation need you"; `None` when nothing does.
fn needs_you_phrase(crew_count: usize, talk_count: usize) -> Option<String> {
    let verb = |n: usize| if n == 1 { "needs you" } else { "need you" };
    match (crew_count, talk_count) {
        (0, 0) => None,
        (c, 0) => Some(format!("{} {}", crews(c), verb(c))),
        (0, t) => Some(format!("{} {}", conversations(t), verb(t))),
        (c, t) => Some(format!("{} and {} need you", crews(c), conversations(t))),
    }
}

/// The status item for `fleet`, with `running` crews at work, `waiting` the
/// crews that need you and `talk` the Talk conversations whose approval card
/// waits on you. Listed longest-waiting first, crews and conversations
/// together (ties by id, so the order is stable).
pub fn model(fleet: FleetStatus, running: usize, waiting: Vec<Waiting>, talk: Vec<TalkWaiting>) -> MenuModel {
    let mut entries: Vec<(i64, Entry)> = waiting
        .iter()
        .map(|w| (w.since_ms, Entry { id: format!("{RUN_PREFIX}{}", w.run_id), label: label(w) }))
        .chain(
            talk.iter()
                .map(|t| (t.since_ms, Entry { id: format!("{TALK_PREFIX}{}", t.thread_id), label: talk_label(t) })),
        )
        .collect();
    entries.sort_by(|(a, ea), (b, eb)| a.cmp(b).then_with(|| ea.id.cmp(&eb.id)));
    let n = fleet.waiting() as usize;
    let phrase = needs_you_phrase(fleet.needs_you as usize, fleet.talk as usize);
    let (state, tooltip) = if let Some(p) = &phrase {
        (TrayState::Blocked, format!("Octopush — {p}"))
    } else if running > 0 {
        (TrayState::Working, format!("Octopush — {} working", crews(running)))
    } else {
        (TrayState::Idle, "Octopush — idle".to_string())
    };
    let header = phrase.unwrap_or_else(|| "No crew needs you".to_string());
    let more = (entries.len() > MAX_ITEMS).then(|| format!("and {} more", entries.len() - MAX_ITEMS));
    let items = entries.into_iter().take(MAX_ITEMS).map(|(_, e)| e).collect();
    MenuModel { state, title: (n > 0).then(|| n.to_string()), tooltip, header, items, more }
}

/// `{workspace} · {stage} — {reason}`, or `{workspace} — {reason}` with no
/// stage, each name cut to fit.
pub fn label(w: &Waiting) -> String {
    let name = clip(w.name.trim(), NAME_MAX_CHARS);
    match &w.stage {
        Some(stage) => format!("{name} · {} — {}", clip(stage.trim(), STAGE_MAX_CHARS), w.reason.word()),
        None => format!("{name} — {}", w.reason.word()),
    }
}

/// `{workspace} · Talk — a command wants approval` (or `— a commit or push
/// wants approval` for the secret guard's card, `— an MCP tool call wants
/// approval`, `— a file outside the workspace wants approval`): the kind of
/// thing, never its arguments or its path.
pub fn talk_label(t: &TalkWaiting) -> String {
    use crate::talk_guard::CardKind;
    let what = match (t.secret, t.kind) {
        (true, _) => "a commit or push wants approval",
        (false, Some(CardKind::Mcp)) => "an MCP tool call wants approval",
        (false, Some(CardKind::Read | CardKind::Write)) => "a file outside the workspace wants approval",
        (false, None) => "a command wants approval",
    };
    format!("{} · Talk — {what}", clip(t.name.trim(), NAME_MAX_CHARS))
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max - 1).collect();
    format!("{}…", head.trim_end())
}

/// Menu text treats `&` as a mnemonic marker; `&&` shows one.
pub fn menu_text(s: &str) -> String {
    s.replace('&', "&&")
}

/// The run a menu item opens.
pub fn run_of(menu_id: &str) -> Option<&str> {
    menu_id.strip_prefix(RUN_PREFIX).filter(|id| !id.is_empty())
}

/// The Talk conversation a menu item opens.
pub fn talk_of(menu_id: &str) -> Option<&str> {
    menu_id.strip_prefix(TALK_PREFIX).filter(|id| !id.is_empty())
}

// ─── Drawing it (thin Tauri layer) ─────────────────────────────────

/// Whether the setting wants the item (read at launch, then kept by
/// `save_settings`).
static ENABLED: AtomicBool = AtomicBool::new(true);
/// What the item shows now; `None` while it is hidden or not built yet.
/// Held while drawing, so draws never interleave. Locked only off the main
/// thread: tray calls wait for the main thread while it is held.
static SHOWN: LazyLock<Mutex<Option<MenuModel>>> = LazyLock::new(|| Mutex::new(None));
/// Time in state per active run (see [`track_since`]).
static SEEN: LazyLock<Mutex<HashMap<String, Seen>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// A drawing failure is logged once.
static ERROR_LOGGED: AtomicBool = AtomicBool::new(false);

/// The pose's image. Only `@2x` exists: tray-icon draws the image 18pt tall,
/// so a 36px image is sharp on Retina and macOS scales it for 1x screens.
fn icon(state: TrayState) -> Image<'static> {
    match state {
        TrayState::Idle => tauri::include_image!("icons/tray/idleTemplate@2x.png"),
        TrayState::Working => tauri::include_image!("icons/tray/workingTemplate@2x.png"),
        TrayState::Blocked => tauri::include_image!("icons/tray/blockedTemplate@2x.png"),
    }
}

/// At launch: read the setting. The launch refresh builds the item with what
/// it should show, so it never appears empty.
pub fn setup() {
    let on = crate::settings::load_settings().map(|s| enabled(&s)).unwrap_or(true);
    ENABLED.store(on, Ordering::Release);
}

/// `save_settings` saw the setting: when it changed, redraw at once (off the
/// main thread), which shows the item with fresh content or hides it.
pub fn apply_setting(app: &AppHandle, on: bool) {
    if ENABLED.swap(on, Ordering::AcqRel) != on {
        crate::fleet_status::refresh(app);
    }
}

/// Whether the next refresh should read what the crews wait on.
pub fn wants_detail() -> bool {
    cfg!(target_os = "macos") && ENABLED.load(Ordering::Acquire)
}

fn build(app: &AppHandle, m: &MenuModel) -> tauri::Result<TrayIcon> {
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon(m.state))
        .icon_as_template(true)
        .tooltip(&m.tooltip)
        .menu(&menu(app, m)?)
        .show_menu_on_left_click(true)
        .on_menu_event(on_menu_event);
    if let Some(title) = &m.title {
        builder = builder.title(title);
    }
    builder.build(app)
}

fn menu(app: &AppHandle, m: &MenuModel) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, HEADER_ID, menu_text(&m.header), false, None::<&str>)?)?;
    for e in &m.items {
        menu.append(&MenuItem::with_id(app, e.id.as_str(), menu_text(&e.label), true, None::<&str>)?)?;
    }
    if let Some(more) = &m.more {
        menu.append(&MenuItem::with_id(app, MORE_ID, menu_text(more), false, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, OPEN_ID, "Open Octopush", true, None::<&str>)?)?;
    // The system Quit, the same as ⌘Q (unsaved Quick View edits still ask).
    menu.append(&PredefinedMenuItem::quit(app, Some("Quit Octopush"))?)?;
    Ok(menu)
}

/// Called by [`crate::fleet_status::refresh`] (off the main thread) with the
/// runs it read. `parked` is empty unless [`wants_detail`] said otherwise.
/// The item is built the first time it is wanted (its menu handler is
/// registered once) and afterwards only redrawn, shown or hidden; it is
/// always drawn before it is shown, so it never flashes what it last showed.
pub fn update(app: &AppHandle, fleet: FleetStatus, runs: &[RunRow], parked: &[ParkedStageRow], talk: Vec<TalkWaiting>) {
    let seen = {
        let mut seen = SEEN.lock();
        let now = chrono::Utc::now().timestamp_millis();
        *seen = track_since(&seen, runs.iter().map(|r| (r.id.as_str(), r.status.as_str())), now);
        (*seen).clone()
    };
    if !cfg!(target_os = "macos") {
        return;
    }
    let mut shown = SHOWN.lock();
    let tray = app.tray_by_id(TRAY_ID);
    if !ENABLED.load(Ordering::Acquire) {
        if let Some(tray) = tray.filter(|_| shown.is_some()) {
            match tray.set_visible(false) {
                Ok(()) => *shown = None,
                Err(e) => log_once(&e),
            }
        }
        return;
    }
    let running = runs.iter().filter(|r| r.status == "running").count();
    let next = model(fleet, running, waiting(runs, parked, &seen), talk);
    let result = match (tray, Option::as_ref(&*shown)) {
        (None, _) => build(app, &next).map(|_| ()),
        (Some(_), Some(current)) if *current == next => return,
        // Hidden: draw everything, then show it.
        (Some(tray), None) => draw(app, &tray, None, &next).and_then(|()| tray.set_visible(true)),
        (Some(tray), Some(current)) => draw(app, &tray, Some(current), &next),
    };
    match result {
        Ok(()) => *shown = Some(next),
        Err(e) => log_once(&e),
    }
}

fn log_once(e: &tauri::Error) {
    if !ERROR_LOGGED.swap(true, Ordering::AcqRel) {
        tracing::warn!(error = %e, "menu bar: drawing the status item failed (logged once)");
    }
}

fn draw(app: &AppHandle, tray: &TrayIcon, shown: Option<&MenuModel>, next: &MenuModel) -> tauri::Result<()> {
    if shown.map(|s| s.state) != Some(next.state) {
        tray.set_icon_with_as_template(Some(icon(next.state)), true)?;
    }
    if shown.map(|s| &s.title) != Some(&next.title) {
        tray.set_title(next.title.as_deref())?;
    }
    if shown.map(|s| &s.tooltip) != Some(&next.tooltip) {
        tray.set_tooltip(Some(&next.tooltip))?;
    }
    if shown.map(|s| (&s.header, &s.items, &s.more)) != Some((&next.header, &next.items, &next.more)) {
        tray.set_menu(Some(menu(app, next)?))?;
    }
    Ok(())
}

/// Where a chosen crew lives, for the window to go there.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRunPayload {
    pub run_id: String,
    pub workspace_id: String,
    pub project_id: String,
    pub project_path: String,
}

/// Where a chosen Talk conversation lives, for the window to go there.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTalkPayload {
    pub thread_id: String,
    pub workspace_id: String,
    pub project_id: String,
    pub project_path: String,
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let id: &str = event.id().as_ref();
    if id == OPEN_ID {
        crate::file_open::show_main(app);
        return;
    }
    if let Some(thread_id) = talk_of(id) {
        crate::file_open::show_main(app);
        let (app, thread_id) = (app.clone(), thread_id.to_string());
        std::thread::spawn(move || open_talk(&app, &thread_id));
        return;
    }
    let Some(run_id) = run_of(id) else {
        return;
    };
    crate::file_open::show_main(app);
    // The lookup takes the db lock: never on the main thread.
    let (app, run_id) = (app.clone(), run_id.to_string());
    std::thread::spawn(move || open_run(&app, &run_id));
}

fn open_run(app: &AppHandle, run_id: &str) {
    let target = {
        let state = app.state::<AppState>();
        let db = state.db.lock();
        db.get_run(run_id).ok().flatten().and_then(|run| {
            let ws = db.get_workspace(&run.workspace_id).ok().flatten()?;
            let (project_id, _, project_path) = db.get_project_by_id(&ws.project_id).ok().flatten()?;
            Some(OpenRunPayload { run_id: run.id, workspace_id: ws.id, project_id, project_path })
        })
    };
    match target {
        Some(payload) => {
            if let Err(e) = app.emit_to("main", OPEN_RUN_EVENT, payload) {
                tracing::warn!(error = %e, "menu bar: opening the crew failed");
            }
        }
        // Deleted since the menu was drawn: the window is up, which is all
        // that is left to do.
        None => tracing::info!("menu bar: the chosen run is gone"),
    }
}

fn open_talk(app: &AppHandle, thread_id: &str) {
    let target = {
        let state = app.state::<AppState>();
        let db = state.db.lock();
        db.chat_thread_home(thread_id).ok().flatten().and_then(|(workspace_id, _)| {
            let ws = db.get_workspace(&workspace_id).ok().flatten()?;
            let (project_id, _, project_path) = db.get_project_by_id(&ws.project_id).ok().flatten()?;
            Some(OpenTalkPayload { thread_id: thread_id.to_string(), workspace_id: ws.id, project_id, project_path })
        })
    };
    match target {
        Some(payload) => {
            if let Err(e) = app.emit_to("main", OPEN_TALK_EVENT, payload) {
                tracing::warn!(error = %e, "menu bar: opening the conversation failed");
            }
        }
        None => tracing::info!("menu bar: the chosen conversation is gone"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stage(status: &str, title: &str) -> ParkedStage {
        ParkedStage { status: status.into(), title: title.into(), started: true, ..Default::default() }
    }

    fn waiting_run(id: &str, name: &str, since_ms: i64) -> Waiting {
        Waiting { run_id: id.into(), name: name.into(), stage: Some("Reviewer".into()), reason: Reason::Gate, since_ms }
    }

    fn fleet(needs_you: u32, in_flight: u32) -> FleetStatus {
        FleetStatus { needs_you, in_flight, talk: 0 }
    }

    #[test]
    fn crews_are_listed_longest_waiting_first() {
        let m = model(
            fleet(3, 0),
            0,
            vec![waiting_run("c", "billing", 300), waiting_run("b", "docs", 100), waiting_run("a", "auth-flow", 100)],
            Vec::new(),
        );
        let ids: Vec<&str> = m.items.iter().map(|e| e.id.as_str()).collect();
        // Same wait: the run id breaks the tie, whatever order they came in.
        assert_eq!(ids, ["menu-bar:run:a", "menu-bar:run:b", "menu-bar:run:c"]);
        assert_eq!(run_of(ids[0]), Some("a"));
        assert_eq!(run_of("menu-bar:open"), None);
        assert_eq!(run_of("menu-bar:run:"), None);
    }

    #[test]
    fn the_count_rides_beside_the_icon_only_above_zero() {
        let m = model(fleet(2, 1), 1, vec![waiting_run("a", "x", 1), waiting_run("b", "y", 2)], Vec::new());
        assert_eq!(m.title.as_deref(), Some("2"));
        assert_eq!(m.header, "2 crews need you");
        assert_eq!(m.tooltip, "Octopush — 2 crews need you");
        assert_eq!(m.state, TrayState::Blocked);

        let m = model(fleet(1, 0), 0, vec![waiting_run("a", "x", 1)], Vec::new());
        assert_eq!((m.header.as_str(), m.title.as_deref()), ("1 crew needs you", Some("1")));
        assert_eq!(m.tooltip, "Octopush — 1 crew needs you");

        let m = model(fleet(0, 2), 2, Vec::new(), Vec::new());
        assert_eq!(m.title, None);
        assert_eq!(m.header, "No crew needs you");
        assert!(m.items.is_empty() && m.more.is_none());
        assert_eq!((m.state, m.tooltip.as_str()), (TrayState::Working, "Octopush — 2 crews working"));

        // A plan park that resumes on its own is in flight, not at work.
        let m = model(fleet(0, 1), 0, Vec::new(), Vec::new());
        assert_eq!((m.state, m.tooltip.as_str()), (TrayState::Idle, "Octopush — idle"));
    }

    #[test]
    fn a_talk_approval_is_listed_with_the_crews_by_how_long_it_waited() {
        let wait = crate::chat_engine::ApprovalWait {
            workspace_id: "w".into(),
            thread_id: "th-1".into(),
            secret: false,
            kind: None,
            since_ms: 50,
        };
        let talk = TalkWaiting::new(&wait, Some("auth-flow".into()));
        let fleet = FleetStatus { needs_you: 1, in_flight: 0, talk: 1 };
        let m = model(fleet, 0, vec![waiting_run("r1", "billing", 100)], vec![talk]);
        let ids: Vec<&str> = m.items.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["menu-bar:talk:th-1", "menu-bar:run:r1"], "the conversation waited longer");
        assert_eq!(m.items[0].label, "auth-flow · Talk — a command wants approval");
        let secret = TalkWaiting::new(&crate::chat_engine::ApprovalWait { secret: true, ..wait.clone() }, Some("auth-flow".into()));
        assert_eq!(talk_label(&secret), "auth-flow · Talk — a commit or push wants approval");
        let kind = |k| talk_label(&TalkWaiting::new(&crate::chat_engine::ApprovalWait { kind: Some(k), ..wait.clone() }, Some("auth-flow".into())));
        assert_eq!(kind(crate::talk_guard::CardKind::Mcp), "auth-flow · Talk — an MCP tool call wants approval");
        assert_eq!(kind(crate::talk_guard::CardKind::Read), "auth-flow · Talk — a file outside the workspace wants approval");
        assert_eq!(talk_of(ids[0]), Some("th-1"));
        assert_eq!(run_of(ids[0]), None);
        assert_eq!(talk_of(ids[1]), None);
        assert_eq!(m.title.as_deref(), Some("2"));
        assert_eq!(m.header, "1 crew and 1 conversation need you");
        assert_eq!((m.state, m.tooltip.as_str()), (TrayState::Blocked, "Octopush — 1 crew and 1 conversation need you"));

        // Talk alone, and a workspace with no name.
        let alone = TalkWaiting::new(&wait, None);
        assert_eq!(alone.name, "a workspace");
        let m = model(FleetStatus { talk: 2, ..FleetStatus::default() }, 0, Vec::new(), vec![alone.clone(), alone]);
        assert_eq!(m.header, "2 conversations need you");
        assert_eq!(m.state, TrayState::Blocked);
        let m = model(FleetStatus { talk: 1, ..FleetStatus::default() }, 0, Vec::new(), Vec::new());
        assert_eq!(m.header, "1 conversation needs you");
        assert_eq!(talk_of("menu-bar:talk:"), None);
    }

    #[test]
    fn past_ten_crews_the_rest_are_counted() {
        let crews: Vec<Waiting> = (0..13).map(|i| waiting_run(&format!("r{i:02}"), "ws", i)).collect();
        let m = model(fleet(13, 0), 0, crews, Vec::new());
        assert_eq!(m.items.len(), MAX_ITEMS);
        assert_eq!(m.more.as_deref(), Some("and 3 more"));
        assert_eq!(m.header, "13 crews need you");
    }

    #[test]
    fn labels_name_the_crew_the_stage_and_why() {
        let mut w = waiting_run("a", "auth-flow", 0);
        assert_eq!(label(&w), "auth-flow · Reviewer — at the gate");
        w.stage = None;
        w.reason = Reason::Paused;
        assert_eq!(label(&w), "auth-flow — paused");
        w.name = "a-workspace-name-far-too-long-for-a-menu-bar".into();
        w.stage = Some("A custom stage name that runs on".into());
        w.reason = Reason::Budget;
        assert_eq!(label(&w), "a-workspace-name-far-too-long-f… · A custom stage name tha… — budget reached");
        assert_eq!(menu_text("R&D · Plan"), "R&&D · Plan");
    }

    #[test]
    fn each_park_says_why() {
        let failed = ParkedStage { error: Some("Anthropic API error 401: authentication_error".into()), ..stage("failed", "Tester") };
        let stalled = ParkedStage { error: Some("Anthropic API error 529: overloaded_error".into()), ..stage("failed", "Coder") };
        let interrupted = ParkedStage {
            error: Some("interrupted — Octopush closed while this stage was in flight".into()),
            ..stage("failed", "Coder")
        };
        let plan = ParkedStage { plan_limited: true, ..stage("failed", "Coder") };
        let asked = ParkedStage { asked: true, ..stage("awaiting_checkpoint", "Planner") };
        let gate = stage("awaiting_checkpoint", "Reviewer");
        let before = ParkedStage { started: false, ..stage("awaiting_checkpoint", "Tester") };
        let secret = ParkedStage { secret_held: true, ..before.clone() };
        let r = |stages: &[&ParkedStage], budget: bool| {
            let (why, stage) = reason(stages, budget);
            (why, stage.unwrap_or_default())
        };
        assert_eq!(r(&[&gate], false), (Reason::Gate, "Reviewer".into()));
        assert_eq!(r(&[&failed], false), (Reason::Halted, "Tester".into()));
        assert_eq!(r(&[&stalled], false), (Reason::Stalled, "Coder".into()));
        assert_eq!(r(&[&interrupted], false), (Reason::Stalled, "Coder".into()), "the relaunch stamp");
        assert_eq!(r(&[&gate, &asked, &stalled], false), (Reason::Stalled, "Coder".into()));
        assert_eq!(r(&[&asked], false), (Reason::Asked, "Planner".into()));
        assert_eq!(r(&[&before], true), (Reason::Budget, "Tester".into()));
        assert_eq!(r(&[&before], false), (Reason::Paused, "Tester".into()));
        assert_eq!(r(&[&secret], true), (Reason::SecretHold, "Tester".into()));
        assert_eq!(r(&[&plan], false), (Reason::PlanLimit, "Coder".into()));
        assert_eq!(r(&[], false), (Reason::Paused, String::new()));
        // A halt outranks a plan limit, a question and a gate beside it.
        assert_eq!(r(&[&gate, &asked, &plan, &failed], false), (Reason::Halted, "Tester".into()));
        assert_eq!(r(&[&gate, &asked], false), (Reason::Asked, "Planner".into()));
        let words: Vec<&str> = [
            Reason::Stalled,
            Reason::Halted,
            Reason::PlanLimit,
            Reason::Asked,
            Reason::SecretHold,
            Reason::Budget,
            Reason::Gate,
            Reason::Paused,
        ]
        .iter()
        .map(|r| r.word())
        .collect();
        assert_eq!(words, ["stalled", "halted", "plan limit", "asked you", "possible secret", "budget reached", "at the gate", "paused"]);
    }

    #[test]
    fn time_in_state_follows_mission_control() {
        let first = track_since(&HashMap::new(), [("a", "paused"), ("b", "running")], 1_000);
        // First sight: no stamp (the run waits since it was created).
        assert_eq!(first["a"].since_ms, None);
        let next = track_since(&first, [("a", "paused"), ("b", "paused"), ("c", "running")], 2_000);
        assert_eq!(next["a"].since_ms, None, "unchanged status keeps its time");
        assert_eq!(next["b"].since_ms, Some(2_000), "a change seen now is stamped now");
        assert_eq!(next["c"].since_ms, None);
        let last = track_since(&next, [("b", "paused")], 3_000);
        assert_eq!(last.len(), 1, "runs no longer active are dropped");
        assert_eq!(last["b"].since_ms, Some(2_000));
    }

    fn run(id: &str, status: &str, created_at: &str) -> RunRow {
        RunRow {
            id: id.into(),
            workspace_id: format!("ws-{id}"),
            pipeline_id: "p".into(),
            task: format!("Task {id}\nmore"),
            status: status.into(),
            cost_usd: 2.0,
            baseline_usd: 0.0,
            reference_model: None,
            linked_issue_key: None,
            created_at: created_at.into(),
            finished_at: None,
            budget_usd: Some(2.0),
            detached: false,
            plan_wait: None,
        }
    }

    #[test]
    fn the_menu_counts_what_the_dock_badge_counts() {
        let mut calm = run("d", "paused", "2026-11-20T07:00:00+00:00");
        // A plan park with its resume scheduled and nothing else waiting is in
        // flight: no badge, no menu item, though its run is `paused`.
        calm.plan_wait = Some(crate::db::PlanWait {
            window: "five_hour".into(),
            resets_at: 1_793_551_200,
            resume_at: Some(1_793_551_290),
            resume_count: 0,
            other_hold: false,
            stale_count: 0,
        });
        let runs = vec![
            run("a", "paused", "2026-11-20T10:00:00+00:00"),
            run("b", "running", "2026-11-20T09:00:00+00:00"),
            run("c", "paused", "2026-11-20T08:00:00+00:00"),
            calm,
        ];
        let parked = vec![
            ParkedStageRow {
                run_id: "a".into(),
                workspace_name: Some("auth-flow".into()),
                stage: Some(stage("awaiting_checkpoint", "Reviewer")),
            },
            // No workspace name: the task's first line stands in.
            ParkedStageRow {
                run_id: "c".into(),
                workspace_name: None,
                stage: Some(ParkedStage { started: false, ..stage("awaiting_checkpoint", "Tester") }),
            },
            ParkedStageRow {
                run_id: "d".into(),
                workspace_name: Some("night-crew".into()),
                stage: Some(ParkedStage {
                    plan_limited: true,
                    error: Some("Paused by your Claude plan\n(plan_limit)".into()),
                    ..stage("failed", "Coder")
                }),
            },
        ];
        let fleet =
            crate::fleet_status::derive(runs.iter().map(|r| (r.status.as_str(), crate::fleet_status::plan_waiting(r))));
        assert_eq!((fleet.needs_you, fleet.badge()), (2, Some(2)), "the calm plan park isn't counted");
        let seen = track_since(&HashMap::new(), runs.iter().map(|r| (r.id.as_str(), r.status.as_str())), 0);
        let m = model(fleet, 1, waiting(&runs, &parked, &seen), Vec::new());
        assert_eq!(m.items.len() as u32, fleet.needs_you);
        assert_eq!(m.title.as_deref(), Some("2"));
        // c was created first, so it has waited longest; d, older still, is in flight.
        let labels: Vec<&str> = m.items.iter().map(|e| e.label.as_str()).collect();
        assert_eq!(labels, ["Task c · Tester — budget reached", "auth-flow · Reviewer — at the gate"]);
    }

    #[test]
    fn a_change_seen_this_session_outranks_the_creation_time() {
        // x was created first, but this session saw it stop at 11:00, after y
        // (created 10:00, already waiting at launch): y has waited longer.
        let runs = vec![run("x", "paused", "2026-11-20T08:00:00+00:00"), run("y", "paused", "2026-11-20T10:00:00+00:00")];
        let stopped_at = created_ms("2026-11-20T11:00:00+00:00");
        let seen = HashMap::from([("x".to_string(), Seen { status: "paused".into(), since_ms: Some(stopped_at) })]);
        let crews = waiting(&runs, &[], &seen);
        let x = crews.iter().find(|w| w.run_id == "x").unwrap();
        assert_eq!(x.since_ms, stopped_at);
        let m = model(fleet(2, 0), 0, crews, Vec::new());
        let ids: Vec<&str> = m.items.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["menu-bar:run:y", "menu-bar:run:x"]);
    }
}
