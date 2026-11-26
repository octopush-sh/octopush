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
//! that need you, longest-waiting first like Mission Control's needs-you
//! band, each opening that crew's Direct surface; then Open Octopush and
//! Quit Octopush.
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

const RUN_PREFIX: &str = "menu-bar:run:";
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
    /// A stage failed and halted the run.
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
/// Mission Control's card: a halt first, then a question, then a gate.
/// `stages` are its blocked stages in stage order; `budget_spent` is the
/// drive's own budget gate (`plan_wait::budget_spent`).
pub fn reason(stages: &[&ParkedStage], budget_spent: bool) -> (Reason, Option<String>) {
    fn title(s: &ParkedStage) -> Option<String> {
        Some(s.title.clone()).filter(|t| !t.trim().is_empty())
    }
    if let Some(s) = stages.iter().find(|s| s.status == "failed" && !s.plan_limited) {
        return (Reason::Halted, title(s));
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

/// The status item for `fleet`, with `running` crews at work and `waiting`
/// the crews that need you. Listed longest-waiting first (ties by run id, so
/// the order is stable).
pub fn model(fleet: FleetStatus, running: usize, mut waiting: Vec<Waiting>) -> MenuModel {
    waiting.sort_by(|a, b| a.since_ms.cmp(&b.since_ms).then_with(|| a.run_id.cmp(&b.run_id)));
    let n = fleet.needs_you as usize;
    let crews = |k: usize| if k == 1 { "1 crew".to_string() } else { format!("{k} crews") };
    let (state, tooltip) = if n > 0 {
        (TrayState::Blocked, format!("Octopush — {} {}", crews(n), if n == 1 { "needs you" } else { "need you" }))
    } else if running > 0 {
        (TrayState::Working, format!("Octopush — {} working", crews(running)))
    } else {
        (TrayState::Idle, "Octopush — idle".to_string())
    };
    let header = match n {
        0 => "No crew needs you".to_string(),
        1 => "1 crew needs you".to_string(),
        _ => format!("{n} crews need you"),
    };
    let items = waiting
        .iter()
        .take(MAX_ITEMS)
        .map(|w| Entry { id: format!("{RUN_PREFIX}{}", w.run_id), label: label(w) })
        .collect();
    let more = (waiting.len() > MAX_ITEMS).then(|| format!("and {} more", waiting.len() - MAX_ITEMS));
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

// ─── Drawing it (thin Tauri layer) ─────────────────────────────────

/// Whether the setting wants the item (read at launch, then kept by
/// `save_settings`).
static ENABLED: AtomicBool = AtomicBool::new(true);
/// What the item shows now (`None` = draw it afresh). Locked only off the
/// main thread: tray calls wait for the main thread while it is held.
static SHOWN: LazyLock<Mutex<Option<MenuModel>>> = LazyLock::new(|| Mutex::new(None));
/// Time in state per active run (see [`track_since`]).
static SEEN: LazyLock<Mutex<HashMap<String, Seen>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// A drawing failure is logged once.
static ERROR_LOGGED: AtomicBool = AtomicBool::new(false);

fn icon(state: TrayState) -> Image<'static> {
    match state {
        TrayState::Idle => tauri::include_image!("icons/tray/idleTemplate@2x.png"),
        TrayState::Working => tauri::include_image!("icons/tray/workingTemplate@2x.png"),
        TrayState::Blocked => tauri::include_image!("icons/tray/blockedTemplate@2x.png"),
    }
}

/// At launch: read the setting and put the item up. The first refresh fills it.
pub fn setup(app: &AppHandle) {
    let on = crate::settings::load_settings().map(|s| enabled(&s)).unwrap_or(true);
    ENABLED.store(on, Ordering::Release);
    ensure(app);
}

/// `save_settings` saw the setting: show or hide the item when it changed.
pub fn apply_setting(app: &AppHandle, on: bool) {
    if ENABLED.swap(on, Ordering::AcqRel) == on {
        return;
    }
    *SHOWN.lock() = None;
    ensure(app);
    if on {
        crate::fleet_status::refresh_later(app);
    }
}

/// Whether the next refresh should read what the crews wait on.
pub fn wants_detail() -> bool {
    cfg!(target_os = "macos") && ENABLED.load(Ordering::Acquire)
}

/// Build the item the first time it is wanted; after that only show or hide
/// it, so its menu handler is registered once.
fn ensure(app: &AppHandle) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let on = ENABLED.load(Ordering::Acquire);
    let result = match app.tray_by_id(TRAY_ID) {
        Some(tray) => tray.set_visible(on),
        None if on => build(app).map(|_| ()),
        None => Ok(()),
    };
    if let Err(e) = result {
        tracing::warn!(error = %e, "menu bar: showing the status item failed");
    }
}

fn build(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let idle = model(FleetStatus::default(), 0, Vec::new());
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon(idle.state))
        .icon_as_template(true)
        .tooltip(&idle.tooltip)
        .menu(&menu(app, &idle)?)
        .show_menu_on_left_click(true)
        .on_menu_event(on_menu_event)
        .build(app)
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
pub fn update(app: &AppHandle, fleet: FleetStatus, runs: &[RunRow], parked: &[ParkedStageRow]) {
    let seen = {
        let mut seen = SEEN.lock();
        let now = chrono::Utc::now().timestamp_millis();
        *seen = track_since(&seen, runs.iter().map(|r| (r.id.as_str(), r.status.as_str())), now);
        (*seen).clone()
    };
    if !wants_detail() {
        return;
    }
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let running = runs.iter().filter(|r| r.status == "running").count();
    let next = model(fleet, running, waiting(runs, parked, &seen));
    let mut shown = SHOWN.lock();
    if Option::as_ref(&*shown) == Some(&next) {
        return;
    }
    match draw(app, &tray, Option::as_ref(&*shown), &next) {
        Ok(()) => *shown = Some(next),
        Err(e) => {
            if !ERROR_LOGGED.swap(true, Ordering::AcqRel) {
                tracing::warn!(error = %e, "menu bar: updating the status item failed (logged once)");
            }
        }
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

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let id: &str = event.id().as_ref();
    if id == OPEN_ID {
        crate::file_open::show_main(app);
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
        FleetStatus { needs_you, in_flight }
    }

    #[test]
    fn crews_are_listed_longest_waiting_first() {
        let m = model(
            fleet(3, 0),
            0,
            vec![waiting_run("c", "billing", 300), waiting_run("a", "auth-flow", 100), waiting_run("b", "docs", 100)],
        );
        let ids: Vec<&str> = m.items.iter().map(|e| e.id.as_str()).collect();
        // Same wait: the run id keeps the order stable.
        assert_eq!(ids, ["menu-bar:run:a", "menu-bar:run:b", "menu-bar:run:c"]);
        assert_eq!(run_of(ids[0]), Some("a"));
        assert_eq!(run_of("menu-bar:open"), None);
        assert_eq!(run_of("menu-bar:run:"), None);
    }

    #[test]
    fn the_count_rides_beside_the_icon_only_above_zero() {
        let m = model(fleet(2, 1), 1, vec![waiting_run("a", "x", 1), waiting_run("b", "y", 2)]);
        assert_eq!(m.title.as_deref(), Some("2"));
        assert_eq!(m.header, "2 crews need you");
        assert_eq!(m.tooltip, "Octopush — 2 crews need you");
        assert_eq!(m.state, TrayState::Blocked);

        let m = model(fleet(1, 0), 0, vec![waiting_run("a", "x", 1)]);
        assert_eq!((m.header.as_str(), m.title.as_deref()), ("1 crew needs you", Some("1")));
        assert_eq!(m.tooltip, "Octopush — 1 crew needs you");

        let m = model(fleet(0, 2), 2, Vec::new());
        assert_eq!(m.title, None);
        assert_eq!(m.header, "No crew needs you");
        assert!(m.items.is_empty() && m.more.is_none());
        assert_eq!((m.state, m.tooltip.as_str()), (TrayState::Working, "Octopush — 2 crews working"));

        // A plan park that resumes on its own is in flight, not at work.
        let m = model(fleet(0, 1), 0, Vec::new());
        assert_eq!((m.state, m.tooltip.as_str()), (TrayState::Idle, "Octopush — idle"));
    }

    #[test]
    fn past_ten_crews_the_rest_are_counted() {
        let crews: Vec<Waiting> = (0..13).map(|i| waiting_run(&format!("r{i:02}"), "ws", i)).collect();
        let m = model(fleet(13, 0), 0, crews);
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
        let failed = stage("failed", "Tester");
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
        assert_eq!(words, ["halted", "plan limit", "asked you", "possible secret", "budget reached", "at the gate", "paused"]);
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
        let runs = vec![
            run("a", "paused", "2026-11-20T10:00:00+00:00"),
            run("b", "running", "2026-11-20T09:00:00+00:00"),
            run("c", "paused", "2026-11-20T08:00:00+00:00"),
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
        ];
        let fleet = crate::fleet_status::derive(runs.iter().map(|r| (r.status.as_str(), false)));
        let seen = track_since(&HashMap::new(), runs.iter().map(|r| (r.id.as_str(), r.status.as_str())), 0);
        let m = model(fleet, 1, waiting(&runs, &parked, &seen));
        assert_eq!(m.items.len() as u32, fleet.needs_you);
        assert_eq!(fleet.badge(), Some(2));
        // c was created first, so it has waited longest.
        let labels: Vec<&str> = m.items.iter().map(|e| e.label.as_str()).collect();
        assert_eq!(labels, ["Task c · Tester — budget reached", "auth-flow · Reviewer — at the gate"]);
    }
}
