//! Shared application state — held by Tauri as a managed `State<AppState>`.

use crate::db::Db;
use crate::error::AppResult;
use crate::pty_manager::PtyManager;
use parking_lot::Mutex;

pub struct AppState {
    pub db: Mutex<Db>,
    pub pty: Mutex<PtyManager>,
}

impl AppState {
    pub fn init() -> AppResult<Self> {
        let db = Db::open(&Db::default_path())?;
        Ok(Self {
            db: Mutex::new(db),
            pty: Mutex::new(PtyManager::new()),
        })
    }
}
