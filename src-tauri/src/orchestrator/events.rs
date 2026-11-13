//! Event emission indirection so the orchestrator is testable without a Tauri AppHandle.

use serde_json::Value;

pub trait EventSink: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
}

/// Production sink — forwards to the Tauri frontend, and keeps the Dock badge
/// current even while the window (and so the webview's listeners) is hidden.
pub struct TauriEventSink {
    pub app: tauri::AppHandle,
}

impl EventSink for TauriEventSink {
    fn emit(&self, event: &str, payload: Value) {
        use tauri::Emitter;
        if crate::fleet_status::affects_badge(event) {
            crate::fleet_status::refresh_later(&self.app);
        }
        let _ = self.app.emit(event, payload);
    }
}
