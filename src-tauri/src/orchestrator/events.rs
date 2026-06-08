//! Event emission indirection so the orchestrator is testable without a Tauri AppHandle.

use serde_json::Value;

pub trait EventSink: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
}

/// Production sink — forwards to the Tauri frontend.
pub struct TauriEventSink {
    pub app: tauri::AppHandle,
}

impl EventSink for TauriEventSink {
    fn emit(&self, event: &str, payload: Value) {
        use tauri::Emitter;
        let _ = self.app.emit(event, payload);
    }
}
