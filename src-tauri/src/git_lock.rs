//! Per-workspace serialization for mutating git operations. Two commands on the
//! same worktree must not interleave (e.g. a pull racing a commit). Each path
//! gets its own async mutex; commands hold the guard for their duration.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::Mutex as AsyncMutex;

static LOCKS: OnceLock<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>> = OnceLock::new();

/// Get-or-insert the async mutex for `path` (does not lock it). Exposed for tests.
pub fn lock_for(path: &str) -> Arc<AsyncMutex<()>> {
    let mut map = LOCKS.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap();
    map.entry(path.to_string())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

/// Acquire the per-workspace git lock; hold the returned guard across the operation.
pub async fn git_lock(path: &str) -> tokio::sync::OwnedMutexGuard<()> {
    lock_for(path).lock_owned().await
}
