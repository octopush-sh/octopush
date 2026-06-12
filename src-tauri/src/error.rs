use serde::Serialize;
use thiserror::Error;

/// How a provider call failed, coarse enough to drive a retry decision.
///
/// The split that matters is [`ProviderErrorKind::is_transient`]: a rate limit,
/// an overloaded model, a 5xx, or a dropped connection are momentary — the work
/// isn't wrong, the substrate was briefly unavailable, so the right response is
/// to wait and try the SAME call again. Everything else (auth, bad request) is a
/// standing fault that retrying can't fix.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderErrorKind {
    /// HTTP 429 — the org's tokens/requests-per-minute budget is exhausted.
    RateLimit,
    /// HTTP 529 — the model is temporarily overloaded upstream.
    Overloaded,
    /// HTTP 5xx (other than 529) — a transient server-side fault.
    ServerError,
    /// The request never completed (connection reset, DNS, timeout).
    Network,
    /// HTTP 401/403 — missing or invalid credentials.
    Auth,
    /// HTTP 400/404/422 — a malformed or unacceptable request.
    BadRequest,
    /// Any other non-success status.
    Other,
}

impl ProviderErrorKind {
    /// True when waiting and re-issuing the identical request can plausibly
    /// succeed. Drives both in-loop auto-retry and the "Resume" recovery path.
    pub fn is_transient(self) -> bool {
        matches!(
            self,
            Self::RateLimit | Self::Overloaded | Self::ServerError | Self::Network
        )
    }

    /// Classify an HTTP status code into a coarse provider-error kind.
    pub fn from_http_status(status: u16) -> Self {
        match status {
            429 => Self::RateLimit,
            529 => Self::Overloaded,
            500..=599 => Self::ServerError,
            401 | 403 => Self::Auth,
            400 | 404 | 422 => Self::BadRequest,
            _ => Self::Other,
        }
    }

    /// A short, human phrase for journal narration ("rate limit reached — …").
    pub fn label(self) -> &'static str {
        match self {
            Self::RateLimit => "rate limit reached",
            Self::Overloaded => "model overloaded",
            Self::ServerError => "provider server error",
            Self::Network => "network error",
            Self::Auth => "authentication failed",
            Self::BadRequest => "request rejected",
            Self::Other => "provider error",
        }
    }
}

/// Application-wide error type. Implements `Serialize` so Tauri commands
/// can return it directly to the JS side as a string (or structured object
/// for variants the frontend needs to pattern-match).
#[derive(Error, Debug)]
pub enum AppError {
    #[error("pty error: {0}")]
    Pty(String),

    #[error("session not found: {0}")]
    SessionNotFound(String),

    #[error("db error: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("other: {0}")]
    Other(String),

    /// A provider (LLM) call failed with a classified cause. The `message`
    /// preserves the full provider response (status + body) so the existing
    /// string-based UI and journals keep working; `kind`/`retry_after` let the
    /// retry layer decide whether — and how long — to wait before re-issuing.
    #[error("{message}")]
    Provider {
        kind: ProviderErrorKind,
        /// Server-advised wait (seconds) parsed from a `retry-after` header.
        retry_after: Option<u64>,
        message: String,
    },

    /// Returned when a git clone fails with HTTP 401/403.
    /// The frontend detects `kind == "AuthRequired"` to show the credential panel.
    #[error("Authentication required for {host}")]
    AuthRequired { host: String },

    /// Returned when an SSH clone fails because no key is available in the agent.
    /// The frontend detects `kind == "SshKeyMissing"` to show the SSH help panel.
    #[error("SSH key not found in agent for {host}")]
    SshKeyMissing { host: String },
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Other(e.to_string())
    }
}

impl AppError {
    /// When this is a *transient* provider failure, return its kind and any
    /// server-advised retry delay; otherwise `None`. The retry layer uses this
    /// to distinguish "wait and try again" from "give up and surface it".
    pub fn transient_retry(&self) -> Option<(ProviderErrorKind, Option<u64>)> {
        match self {
            AppError::Provider {
                kind,
                retry_after,
                ..
            } if kind.is_transient() => Some((*kind, *retry_after)),
            _ => None,
        }
    }
}

/// Serialise `AppError` in a way the frontend can pattern-match.
///
/// Most variants produce a plain string (backwards-compatible).
/// `AuthRequired` produces `{"kind":"AuthRequired","host":"<host>"}`.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            AppError::AuthRequired { host } => {
                let mut map = ser.serialize_map(Some(2))?;
                map.serialize_entry("kind", "AuthRequired")?;
                map.serialize_entry("host", host)?;
                map.end()
            }
            AppError::SshKeyMissing { host } => {
                let mut map = ser.serialize_map(Some(2))?;
                map.serialize_entry("kind", "SshKeyMissing")?;
                map.serialize_entry("host", host)?;
                map.end()
            }
            other => ser.serialize_str(&other.to_string()),
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_required_serializes_correctly() {
        let err = AppError::AuthRequired {
            host: "github.com".to_string(),
        };
        let json = serde_json::to_string(&err).unwrap();
        let val: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(val["kind"], "AuthRequired");
        assert_eq!(val["host"], "github.com");
    }

    #[test]
    fn ssh_key_missing_serializes_correctly() {
        let err = AppError::SshKeyMissing { host: "github.com".into() };
        let json = serde_json::to_string(&err).unwrap();
        let val: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(val["kind"], "SshKeyMissing");
        assert_eq!(val["host"], "github.com");
    }

    #[test]
    fn other_error_serializes_as_string() {
        let err = AppError::Other("something went wrong".to_string());
        let json = serde_json::to_string(&err).unwrap();
        // Should be a JSON string, not an object
        assert!(json.starts_with('"'));
        assert!(json.contains("something went wrong"));
    }

    #[test]
    fn classifies_http_statuses() {
        use ProviderErrorKind::*;
        assert_eq!(ProviderErrorKind::from_http_status(429), RateLimit);
        assert_eq!(ProviderErrorKind::from_http_status(529), Overloaded);
        assert_eq!(ProviderErrorKind::from_http_status(500), ServerError);
        assert_eq!(ProviderErrorKind::from_http_status(503), ServerError);
        assert_eq!(ProviderErrorKind::from_http_status(401), Auth);
        assert_eq!(ProviderErrorKind::from_http_status(400), BadRequest);
        assert_eq!(ProviderErrorKind::from_http_status(418), Other);
    }

    #[test]
    fn only_transient_kinds_are_retryable() {
        use ProviderErrorKind::*;
        for k in [RateLimit, Overloaded, ServerError, Network] {
            assert!(k.is_transient(), "{k:?} should be transient");
        }
        for k in [Auth, BadRequest, Other] {
            assert!(!k.is_transient(), "{k:?} should not be transient");
        }
    }

    #[test]
    fn transient_retry_extracts_kind_and_delay() {
        let rate = AppError::Provider {
            kind: ProviderErrorKind::RateLimit,
            retry_after: Some(12),
            message: "Anthropic API error 429: too many requests".into(),
        };
        assert_eq!(
            rate.transient_retry(),
            Some((ProviderErrorKind::RateLimit, Some(12)))
        );

        let auth = AppError::Provider {
            kind: ProviderErrorKind::Auth,
            retry_after: None,
            message: "401".into(),
        };
        assert_eq!(auth.transient_retry(), None);
        assert_eq!(AppError::Other("x".into()).transient_retry(), None);
    }

    #[test]
    fn provider_error_serializes_as_its_message() {
        // The DB persists stage errors as strings; the Provider variant must
        // serialize to its human message (not a struct) for that path + the UI.
        let err = AppError::Provider {
            kind: ProviderErrorKind::RateLimit,
            retry_after: Some(5),
            message: "Anthropic API error 429 Too Many Requests: …".into(),
        };
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.starts_with('"'));
        assert!(json.contains("429"));
    }
}
