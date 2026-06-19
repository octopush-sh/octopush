//! Shared application state — held by Tauri as a managed `State<AppState>`.

use crate::chat_engine::ChatEngine;
use crate::db::Db;
use crate::error::AppResult;
use crate::provider_router::ProviderRouter;
use crate::pty_client::DaemonClient;
use crate::pty_manager::PtyManager;
use crate::token_engine::TokenEngine;
use parking_lot::Mutex;
use std::sync::Arc;

pub struct AppState {
    pub db: Arc<Mutex<Db>>,
    pub pty: Mutex<PtyManager>,
    pub tokens: Arc<TokenEngine>,
    pub router: Mutex<ProviderRouter>,
    pub chat: ChatEngine,
    /// The shared daemon client — kept alive for the app lifetime.
    pub daemon_client: Option<Arc<DaemonClient>>,
}

impl AppState {
    /// Initialise state.  If `daemon_client` is `None` (daemon unavailable),
    /// `PtyManager` is built with a no-op stub that returns errors on every
    /// call — this keeps Octopush launchable even without a daemon.
    pub fn init(daemon_client: Option<Arc<DaemonClient>>) -> AppResult<Self> {
        let db = Arc::new(Mutex::new(Db::open(&Db::default_path())?));
        let tokens = Arc::new(TokenEngine::new(Arc::clone(&db)));
        let chat = ChatEngine::new(Arc::clone(&db), daemon_client.clone());
        let router = ProviderRouter::load()?;

        let pty = match daemon_client.as_ref() {
            Some(client) => PtyManager::new(Arc::clone(client)),
            None => {
                // Build a stub client that immediately errors on every call.
                // This happens when the daemon binary is absent — the app still
                // starts, but terminal creation will return a clear error.
                let stub = DaemonClient::stub();
                PtyManager::new(stub)
            }
        };

        Ok(Self {
            db,
            pty: Mutex::new(pty),
            tokens,
            router: Mutex::new(router),
            chat,
            daemon_client,
        })
    }
}
