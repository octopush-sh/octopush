//! Opening files handed to Octopush by the operating system.
//!
//! Three delivery paths converge here:
//! - **macOS** — Finder's "Open With" / double-click sends an Apple Event that
//!   Tauri surfaces as `RunEvent::Opened { urls }` (cold start *and* warm).
//! - **Windows / Linux, cold start** — the path arrives in `argv`.
//! - **Windows / Linux, warm** — a second launch is intercepted by
//!   `tauri-plugin-single-instance`, which forwards its `argv` + `cwd` here.
//!
//! Every file opens in a **Quick View** window: a lightweight, standalone
//! viewer/editor (`src/quickview/`) that does not load the Atelier shell. When
//! the file lives inside a known workspace, Quick View offers to open it there.
//!
//! The main window starts hidden (`visible: false` in `tauri.conf.json`) so a
//! file-launch shows only the Quick View. `RunEvent::Ready` arms a short grace
//! timer; if no file arrived by then, the main window is shown as usual.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// Label prefix of every Quick View window (also matched by the capability).
pub const QUICKVIEW_PREFIX: &str = "quickview-";
/// How long to wait after `Ready` for a launch-time file before showing main.
pub const MAIN_GRACE_MS: u64 = 400;

/// Tauri-managed registry: which file each Quick View window shows.
#[derive(Default)]
pub struct QuickViews {
    by_label: Mutex<HashMap<String, PathBuf>>,
    next_id: AtomicU64,
    /// Set once any file was opened — suppresses the main-window grace show.
    opened_any: AtomicBool,
}

impl QuickViews {
    fn label_for(&self, path: &Path) -> Option<String> {
        self.by_label
            .lock()
            .iter()
            .find(|(_, p)| p.as_path() == path)
            .map(|(l, _)| l.clone())
    }

    pub fn opened_any(&self) -> bool {
        self.opened_any.load(Ordering::SeqCst)
    }

    pub fn forget(&self, label: &str) {
        self.by_label.lock().remove(label);
    }

    pub fn is_empty(&self) -> bool {
        self.by_label.lock().is_empty()
    }
}

/// Pick the file paths out of a process's argv (skipping argv[0] and flags).
/// Relative paths resolve against `cwd`; `file://` URLs are accepted. Only
/// paths that exist as regular files survive — a directory or a typo never
/// opens an empty viewer.
pub fn file_args<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .filter_map(|a| {
            let p = match a.strip_prefix("file://") {
                Some(rest) => PathBuf::from(percent_decode(rest)),
                None => PathBuf::from(&a),
            };
            let p = if p.is_absolute() { p } else { cwd.join(p) };
            p.is_file().then(|| std::fs::canonicalize(&p).unwrap_or(p))
        })
        .collect()
}

/// Minimal `%XX` decoder for `file://` argv entries (Linux desktop launchers).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 3 <= bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A workspace root a file may belong to.
#[derive(Debug, Clone)]
pub struct WorkspaceRoot {
    pub project_id: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub root: PathBuf,
}

/// The workspace whose root most specifically contains `path` (longest
/// matching root wins, so a worktree nested under its project root beats the
/// project's default workspace).
pub fn match_workspace<'a>(path: &Path, roots: &'a [WorkspaceRoot]) -> Option<&'a WorkspaceRoot> {
    roots
        .iter()
        .filter(|r| !r.root.as_os_str().is_empty() && path.starts_with(&r.root))
        .max_by_key(|r| r.root.components().count())
}

fn workspace_roots(state: &AppState) -> AppResult<Vec<WorkspaceRoot>> {
    let db = state.db.lock();
    let mut out = Vec::new();
    for (project_id, _name, project_path, ..) in db.list_projects()? {
        for ws in db.list_workspaces(&project_id)? {
            let root = ws
                .worktree_path
                .clone()
                .filter(|p| !p.is_empty())
                .unwrap_or_else(|| project_path.clone());
            let root = std::fs::canonicalize(&root).unwrap_or_else(|_| PathBuf::from(&root));
            out.push(WorkspaceRoot {
                project_id: project_id.clone(),
                workspace_id: ws.id,
                workspace_name: ws.name,
                root,
            });
        }
    }
    Ok(out)
}

/// Open `path` in a Quick View window, focusing the existing one if that file
/// is already showing.
pub fn open_quickview(app: &AppHandle, path: PathBuf) -> AppResult<()> {
    let path = std::fs::canonicalize(&path).unwrap_or(path);
    let views = app.state::<QuickViews>();
    views.opened_any.store(true, Ordering::SeqCst);

    if let Some(label) = views.label_for(&path) {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
            return Ok(());
        }
        views.forget(&label);
    }

    let label = format!("{QUICKVIEW_PREFIX}{}", views.next_id.fetch_add(1, Ordering::SeqCst));
    views.by_label.lock().insert(label.clone(), path.clone());

    let title = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Quick View".to_string());

    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(&title)
        .inner_size(960.0, 720.0)
        .min_inner_size(520.0, 360.0)
        .resizable(true);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    if let Err(e) = builder.build() {
        views.forget(&label);
        return Err(AppError::Other(format!("open quick view: {e}")));
    }
    Ok(())
}

/// Open every path, logging (not failing) individual errors.
pub fn open_all(app: &AppHandle, paths: Vec<PathBuf>) {
    for p in paths {
        if let Err(e) = open_quickview(app, p) {
            tracing::warn!(error = %e, "failed to open file in quick view");
        }
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

pub fn main_visible(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

// ─── Commands ─────────────────────────────────────────────────────

/// The file the calling Quick View window was opened for.
#[tauri::command]
pub async fn quickview_path(
    window: tauri::WebviewWindow,
    views: State<'_, QuickViews>,
) -> AppResult<Option<String>> {
    Ok(views
        .by_label
        .lock()
        .get(window.label())
        .map(|p| p.to_string_lossy().into_owned()))
}

/// Open a file in Quick View from inside the app.
#[tauri::command]
pub async fn open_quickview_window(app: AppHandle, path: String) -> AppResult<()> {
    open_quickview(&app, PathBuf::from(crate::commands::expand_tilde(&path)))
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMatch {
    pub project_id: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub root: String,
}

/// The workspace (if any) whose worktree contains `path`.
#[tauri::command]
pub async fn workspace_for_path(
    state: State<'_, AppState>,
    path: String,
) -> AppResult<Option<WorkspaceMatch>> {
    let p = PathBuf::from(&path);
    let p = std::fs::canonicalize(&p).unwrap_or(p);
    let roots = workspace_roots(&state)?;
    Ok(match_workspace(&p, &roots).map(|r| WorkspaceMatch {
        project_id: r.project_id.clone(),
        workspace_id: r.workspace_id.clone(),
        workspace_name: r.workspace_name.clone(),
        root: r.root.to_string_lossy().into_owned(),
    }))
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInWorkspacePayload {
    pub project_id: String,
    pub workspace_id: String,
    /// Path relative to the workspace root, so the main window resolves it
    /// against its own (possibly non-canonical) worktree path.
    pub relative_path: String,
}

/// Bring the main window forward and ask it to open `path` in the editor of
/// the workspace that contains it.
#[tauri::command]
pub async fn open_path_in_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> AppResult<bool> {
    let Some(m) = workspace_for_path(state, path.clone()).await? else {
        return Ok(false);
    };
    let p = PathBuf::from(&path);
    let p = std::fs::canonicalize(&p).unwrap_or(p);
    let relative_path = p
        .strip_prefix(&m.root)
        .map(|r| r.to_string_lossy().into_owned())
        .unwrap_or(path);
    show_main(&app);
    app.emit_to(
        "main",
        "octo://open-in-workspace",
        OpenInWorkspacePayload {
            project_id: m.project_id,
            workspace_id: m.workspace_id,
            relative_path,
        },
    )
    .map_err(|e| AppError::Other(format!("emit open-in-workspace: {e}")))?;
    Ok(true)
}

/// Show (and focus) the main Octopush window.
#[tauri::command]
pub async fn show_main_window(app: AppHandle) -> AppResult<()> {
    show_main(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(ws: &str, p: &str) -> WorkspaceRoot {
        WorkspaceRoot {
            project_id: "p".into(),
            workspace_id: ws.into(),
            workspace_name: ws.into(),
            root: PathBuf::from(p),
        }
    }

    #[test]
    fn match_workspace_prefers_longest_root() {
        let roots = vec![root("default", "/code/app"), root("wt", "/code/app/.worktrees/feat")];
        let m = match_workspace(Path::new("/code/app/.worktrees/feat/src/a.ts"), &roots).unwrap();
        assert_eq!(m.workspace_id, "wt");
        let m = match_workspace(Path::new("/code/app/src/a.ts"), &roots).unwrap();
        assert_eq!(m.workspace_id, "default");
    }

    #[test]
    fn match_workspace_respects_component_boundaries() {
        let roots = vec![root("default", "/code/app")];
        assert!(match_workspace(Path::new("/code/application/x.md"), &roots).is_none());
        assert!(match_workspace(Path::new("/elsewhere/x.md"), &roots).is_none());
    }

    #[test]
    fn file_args_keeps_existing_files_only() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("notes.md");
        std::fs::write(&f, "# hi").unwrap();
        let args = vec![
            "octopush".to_string(),
            "--flag".to_string(),
            "notes.md".to_string(),
            "missing.md".to_string(),
            dir.path().to_string_lossy().into_owned(),
        ];
        let got = file_args(args, dir.path());
        assert_eq!(got, vec![std::fs::canonicalize(&f).unwrap()]);
    }

    #[test]
    fn file_args_decodes_file_urls() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("my notes.md");
        std::fs::write(&f, "x").unwrap();
        let url = format!("file://{}", f.to_string_lossy().replace(' ', "%20"));
        let got = file_args(vec!["octopush".to_string(), url], dir.path());
        assert_eq!(got, vec![std::fs::canonicalize(&f).unwrap()]);
    }
}
