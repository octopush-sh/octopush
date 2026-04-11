use serde::Serialize;
use thiserror::Error;

/// Application-wide error type. Implements `Serialize` so Tauri commands
/// can return it directly to the JS side as a string.
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
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Other(e.to_string())
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
