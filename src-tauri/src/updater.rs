//! In-app updater with release channels (Settings › About › Update channel).
//!
//! The check / download / install run here (not through the JS plugin) so the
//! endpoints can follow the user's channel:
//!
//! - **stable** — the endpoints configured in `tauri.conf.json`
//!   (`plugins.updater.endpoints`).
//! - **beta** — [`BETA_ENDPOINTS`]: every tagged build reaches it first
//!   (`docs/WHATS-NEW.md` §6).
//!
//! The signing pubkey always comes from the plugin config — `updater_builder()`
//! carries it — so a channel only changes *where* the manifest is read, never
//! *who* may sign it. The default version comparator (remote > installed)
//! stays in place, so going back to stable never downgrades: it just stops
//! offering betas.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// Beta manifest: host-indirected first, then the moving GitHub release.
pub const BETA_ENDPOINTS: [&str; 2] = [
    "https://octopush.sh/update/beta.json",
    "https://github.com/octopush-sh/octopush/releases/download/beta-channel/latest.json",
];

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    #[default]
    Stable,
    Beta,
}

impl UpdateChannel {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "stable" => Some(Self::Stable),
            "beta" => Some(Self::Beta),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
        }
    }
}

/// The endpoint override for a channel: `None` keeps the configured
/// (`tauri.conf.json`) endpoints, `Some` replaces them.
pub fn endpoint_override(channel: UpdateChannel) -> Option<Vec<&'static str>> {
    match channel {
        UpdateChannel::Stable => None,
        UpdateChannel::Beta => Some(BETA_ENDPOINTS.to_vec()),
    }
}

/// The endpoints a check on `channel` reads, given the configured ones.
pub fn endpoints_for(channel: UpdateChannel, configured: &[String]) -> Vec<String> {
    match endpoint_override(channel) {
        None => configured.to_vec(),
        Some(eps) => eps.into_iter().map(String::from).collect(),
    }
}

/// What the frontend learns about an available update.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    /// `pub_date` from the manifest, verbatim (RFC 3339).
    pub date: Option<String>,
    /// The manifest's `notes` (Markdown).
    pub body: Option<String>,
    pub channel: UpdateChannel,
}

/// Download progress, the same tagged shape the JS plugin used.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started { content_length: Option<u64> },
    #[serde(rename_all = "camelCase")]
    Progress { chunk_length: usize },
    Finished,
}

/// The update found by the last check, with the channel it came from, kept
/// for `updater_install`. Cleared whenever the channel changes, so a late
/// result from the previous channel can never be installed.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<(UpdateChannel, tauri_plugin_updater::Update)>>);

/// `pub_date` read straight from the manifest (avoids a date-format dep).
pub fn manifest_date(raw: &serde_json::Value) -> Option<String> {
    raw.get("pub_date")
        .and_then(|v| v.as_str())
        .map(String::from)
}
