//! When the stored claude.ai sign-in ends: the latest `credential_expires_at`
//! a CLI stage's `result` event reported (Claude Code 2.1.318+), kept in
//! `app_meta` (`claude_login:expiry`) with the moment it was seen.
//!
//! No outbound traffic and no credential reads: the date is what Claude Code
//! already streams to the stage. Older CLIs never send it, so nothing is
//! stored and every reader keeps its old behaviour.

use crate::db::Db;
use crate::error::AppResult;
use serde::{Deserialize, Serialize};

/// Event name: a stage reported the sign-in end (mirrors `LOGIN_EVENT` in
/// `src/lib/claudeLogin.ts`). Payload `{ expiresAt: number }` (epoch seconds).
pub const LOGIN_EVENT: &str = "claude-login://updated";

const KEY: &str = "claude_login:expiry";

/// Within this many days of the end, Readiness and the notes turn amber.
pub const WARN_DAYS: i64 = 10;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoginExpiry {
    /// When the sign-in ends, epoch seconds.
    pub expires_at: i64,
    /// When a stage reported it, RFC3339 UTC.
    pub seen_at: String,
}

/// Where the sign-in stands at `now` (epoch seconds).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoginState {
    /// More than [`WARN_DAYS`] away.
    Ok,
    /// Within [`WARN_DAYS`].
    EndingSoon,
    Ended,
}

pub fn state(expires_at: i64, now: i64) -> LoginState {
    if expires_at <= now {
        LoginState::Ended
    } else if expires_at - now <= WARN_DAYS * 86_400 {
        LoginState::EndingSoon
    } else {
        LoginState::Ok
    }
}

/// Store the latest reported end, stamped `seen_at`. The latest report wins:
/// signing in again moves the date forward.
pub fn record(db: &Db, expires_at: i64, seen_at: &str) -> AppResult<()> {
    let v = LoginExpiry { expires_at, seen_at: seen_at.to_string() };
    db.meta_set(KEY, &serde_json::to_string(&v)?)
}

/// Forget the stored end: a Claude Code stage ran as an API-key session, so
/// stages no longer use the sign-in and none will report a new date.
pub fn clear(db: &Db) -> AppResult<()> {
    db.meta_delete(KEY)
}

/// The stored end; `None` until a stage reported one (or if unreadable).
pub fn load(db: &Db) -> AppResult<Option<LoginExpiry>> {
    Ok(db.meta_get(KEY)?.and_then(|v| serde_json::from_str(&v).ok()))
}

/// What `get_claude_login` returns: the stored end, key or not (see
/// [`has_anthropic_key`]).
pub fn shown(db: &Db) -> AppResult<Option<LoginExpiry>> {
    load(db)
}

/// An Anthropic key (settings or `ANTHROPIC_API_KEY`) is set; Readiness then
/// reports "API key" unless a sign-in end is stored. The key never hides the
/// end: Claude Code stages don't get the Settings key (`cli_runner`), so a
/// stored end means they run on the claude.ai sign-in.
pub fn has_anthropic_key() -> bool {
    #[cfg(test)]
    if let Some(v) = test_key_override::get() {
        return v;
    }
    crate::settings::get_anthropic_key().is_some_and(|k| !k.trim().is_empty())
}

/// Per-thread stand-in for the settings key, so tests never read `~/.octopush`.
#[cfg(test)]
pub mod test_key_override {
    use std::cell::Cell;
    thread_local! {
        static KEY_SET: Cell<Option<bool>> = const { Cell::new(None) };
    }
    pub fn get() -> Option<bool> {
        KEY_SET.with(|c| c.get())
    }
    pub fn set(v: Option<bool>) {
        KEY_SET.with(|c| c.set(v));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_turns_amber_within_ten_days_and_rouge_once_passed() {
        let now = 1_800_000_000;
        assert_eq!(state(now + 11 * 86_400, now), LoginState::Ok);
        assert_eq!(state(now + 10 * 86_400, now), LoginState::EndingSoon);
        assert_eq!(state(now + 60, now), LoginState::EndingSoon);
        assert_eq!(state(now, now), LoginState::Ended);
        assert_eq!(state(now - 86_400, now), LoginState::Ended);
    }

    #[test]
    fn the_latest_report_is_kept() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Db::open(tmp.path()).unwrap();
        assert_eq!(load(&db).unwrap(), None);
        record(&db, 100, "2026-11-01T00:00:00Z").unwrap();
        record(&db, 900, "2026-11-02T00:00:00Z").unwrap();
        assert_eq!(load(&db).unwrap(), Some(LoginExpiry { expires_at: 900, seen_at: "2026-11-02T00:00:00Z".into() }));
        clear(&db).unwrap();
        assert_eq!(load(&db).unwrap(), None);
        clear(&db).unwrap();
    }

    #[test]
    fn get_claude_login_returns_the_stored_end_when_a_key_is_set() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Db::open(tmp.path()).unwrap();
        record(&db, 900, "2026-11-02T00:00:00Z").unwrap();
        test_key_override::set(Some(true));
        assert!(has_anthropic_key());
        let got = shown(&db).unwrap();
        test_key_override::set(None);
        assert_eq!(got, Some(LoginExpiry { expires_at: 900, seen_at: "2026-11-02T00:00:00Z".into() }));
    }
}
