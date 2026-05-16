//! Theme configuration — load/save/list themes.
//!
//! Themes are stored as `~/.octopus-sh/theme.json`. If absent, defaults
//! to the built-in "atelier" theme.

use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThemeConfig {
    pub name: String,
    pub bg: String,
    pub panel: String,
    pub border: String,
    pub accent: String,
    pub accent_dim: String,
    pub success: String,
    pub warning: String,
    pub danger: String,
    pub text: String,
    pub text_dim: String,
    pub text_muted: String,
    /// xterm.js terminal background (may differ from panel bg).
    pub terminal_bg: String,
}

pub fn builtin_themes() -> Vec<ThemeConfig> {
    vec![
        ThemeConfig {
            name: "atelier".into(),
            bg: "#0c0a08".into(),
            panel: "#14110d".into(),
            border: "#2a2419".into(),
            accent: "#d4a574".into(),
            accent_dim: "#e8c39a".into(),
            success: "#8fc9a8".into(),
            warning: "#d4a574".into(),
            danger: "#d18b8b".into(),
            text: "#f4ecdb".into(),
            text_dim: "#95897a".into(),
            text_muted: "#6d6354".into(),
            terminal_bg: "#0c0a08".into(),
        },
        ThemeConfig {
            name: "dark".into(),
            bg: "#0a0a0b".into(),
            panel: "#101013".into(),
            border: "#1f1f25".into(),
            accent: "#a78bfa".into(),
            accent_dim: "#7c6dd8".into(),
            success: "#34d399".into(),
            warning: "#fbbf24".into(),
            danger: "#f87171".into(),
            text: "#e4e4e7".into(),
            text_dim: "#a1a1aa".into(),
            text_muted: "#52525b".into(),
            terminal_bg: "#0a0a0b".into(),
        },
        ThemeConfig {
            name: "midnight".into(),
            bg: "#0d1117".into(),
            panel: "#161b22".into(),
            border: "#21262d".into(),
            accent: "#58a6ff".into(),
            accent_dim: "#388bfd".into(),
            success: "#3fb950".into(),
            warning: "#d29922".into(),
            danger: "#f85149".into(),
            text: "#c9d1d9".into(),
            text_dim: "#8b949e".into(),
            text_muted: "#484f58".into(),
            terminal_bg: "#0d1117".into(),
        },
        ThemeConfig {
            name: "solarized-dark".into(),
            bg: "#002b36".into(),
            panel: "#073642".into(),
            border: "#586e75".into(),
            accent: "#268bd2".into(),
            accent_dim: "#2176b8".into(),
            success: "#859900".into(),
            warning: "#b58900".into(),
            danger: "#dc322f".into(),
            text: "#839496".into(),
            text_dim: "#657b83".into(),
            text_muted: "#586e75".into(),
            terminal_bg: "#002b36".into(),
        },
    ]
}

fn config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".octopus-sh")
        .join("theme.json")
}

pub fn load_theme() -> AppResult<ThemeConfig> {
    let path = config_path();
    if path.exists() {
        let content = std::fs::read_to_string(&path)?;
        Ok(serde_json::from_str(&content)?)
    } else {
        Ok(builtin_themes().into_iter().next().unwrap())
    }
}

pub fn save_theme(theme: &ThemeConfig) -> AppResult<()> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(theme)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_themes_includes_atelier_as_default() {
        let themes = builtin_themes();
        assert!(themes.len() >= 4, "should have at least 4 built-in themes");
        assert_eq!(
            themes[0].name, "atelier",
            "atelier must be first so it's the default for new installs"
        );
        assert_eq!(themes[0].bg, "#0c0a08", "atelier bg must be onyx");
        assert_eq!(themes[0].accent, "#d4a574", "atelier accent must be brass");
        assert_eq!(themes[0].text, "#f4ecdb", "atelier text must be ivory");
        assert_eq!(themes[0].success, "#8fc9a8", "atelier success must be verdigris");
        assert_eq!(themes[0].danger, "#d18b8b", "atelier danger must be rouge");
    }

    #[test]
    fn legacy_themes_remain_available() {
        let themes = builtin_themes();
        let names: Vec<&str> = themes.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"dark"), "legacy dark theme must still exist");
        assert!(names.contains(&"midnight"), "midnight must still exist");
        assert!(names.contains(&"solarized-dark"), "solarized-dark must still exist");
    }

    #[test]
    fn theme_serde_roundtrip() {
        let theme = &builtin_themes()[0];
        let json = serde_json::to_string(theme).unwrap();
        let back: ThemeConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.name, "atelier");
        assert_eq!(back.accent, "#d4a574");
    }
}
