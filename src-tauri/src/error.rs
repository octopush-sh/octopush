use serde::Serialize;
use thiserror::Error;

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
}
