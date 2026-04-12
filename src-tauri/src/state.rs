//! Shared application state — held by Tauri as a managed `State<AppState>`.

use crate::db::Db;
use crate::error::AppResult;
use crate::provider_router::ProviderRouter;
use crate::pty_manager::PtyManager;
use crate::token_engine::TokenEngine;
use parking_lot::Mutex;
use std::sync::Arc;

pub struct AppState {
    pub db: Arc<Mutex<Db>>,
    pub pty: Mutex<PtyManager>,
    pub tokens: TokenEngine,
    pub router: Mutex<ProviderRouter>,
}

impl AppState {
    pub fn init() -> AppResult<Self> {
        let db = Arc::new(Mutex::new(Db::open(&Db::default_path())?));
        let tokens = TokenEngine::new(Arc::clone(&db));
        let router = ProviderRouter::load()?;
        Ok(Self {
            db,
            pty: Mutex::new(PtyManager::new()),
            tokens,
            router: Mutex::new(router),
        })
    }
}
