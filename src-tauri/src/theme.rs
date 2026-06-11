//! Theme configuration — load/save/list themes.
//!
//! Themes are stored as `~/.octopush/theme.json`. If absent, defaults
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
    /// "Raised" surface for row hover, popovers, active selections. For
    /// dark themes this is a step brighter than `panel`; for light
    /// themes a step darker. Field is non-optional so themes that
    /// predate this addition will fail to deserialize until migrated —
    /// that's intentional: a missing panel_2 falls back to the static
    /// styles.css value, which is the brass-tinted onyx and looks broken
    /// under any non-atelier theme.
    #[serde(default = "default_panel_2")]
    pub panel_2: String,
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

fn default_panel_2() -> String {
    "#1a160f".into()
}

pub fn builtin_themes() -> Vec<ThemeConfig> {
    vec![
        // ─── Brand default ───────────────────────────────────────────
        ThemeConfig {
            name: "atelier".into(),
            bg: "#0c0a08".into(),
            panel: "#14110d".into(),
            panel_2: "#1a160f".into(),
            border: "#2a2419".into(),
            accent: "#d4a574".into(),
            accent_dim: "#e8c39a".into(),
            success: "#8fc9a8".into(),
            // Amber — distinct from brass: warning/caution, never the accent.
            // Mirrors --color-octo-warning in src/styles.css.
            warning: "#dfae4a".into(),
            danger: "#d18b8b".into(),
            text: "#f4ecdb".into(),
            text_dim: "#95897a".into(),
            text_muted: "#6d6354".into(),
            terminal_bg: "#0c0a08".into(),
        },

        // ─── Premium family — 4 new moods ────────────────────────────

        // Vellum: the brand in daylight. Cream parchment, chestnut ink,
        // gilded edges. The only light theme — meant for users who want
        // Octopush at a sunlit workbench.
        ThemeConfig {
            name: "vellum".into(),
            bg: "#f0e7d2".into(),
            panel: "#f8efd9".into(),
            panel_2: "#e5dabf".into(),
            border: "#c4b390".into(),
            accent: "#8b5a3c".into(),
            accent_dim: "#b07952".into(),
            success: "#3d7a59".into(),
            warning: "#b8801d".into(),
            danger: "#a8392f".into(),
            text: "#2a201a".into(),
            text_dim: "#6b5e4d".into(),
            text_muted: "#9b8b72".into(),
            terminal_bg: "#f0e7d2".into(),
        },

        // Mossbank: deep evergreen and warm amber. Forest atelier.
        ThemeConfig {
            name: "mossbank".into(),
            bg: "#0a120c".into(),
            panel: "#121b14".into(),
            panel_2: "#1a261c".into(),
            border: "#233028".into(),
            accent: "#c89669".into(),
            accent_dim: "#dbac82".into(),
            success: "#8fc9a8".into(),
            warning: "#c89669".into(),
            danger: "#d18b8b".into(),
            text: "#e8e5da".into(),
            text_dim: "#95a098".into(),
            text_muted: "#5e6b62".into(),
            terminal_bg: "#0a120c".into(),
        },

        // Porcelain & Indigo: deep indigo lacquer, porcelain inlay, soft
        // rose seal. Premium evening.
        ThemeConfig {
            name: "porcelain-indigo".into(),
            bg: "#0a0e1c".into(),
            panel: "#121830".into(),
            panel_2: "#1a223d".into(),
            border: "#2a3252".into(),
            accent: "#d4a5b8".into(),
            accent_dim: "#e6c3d2".into(),
            success: "#8fc8b4".into(),
            warning: "#d4b074".into(),
            danger: "#d18888".into(),
            text: "#e8e8ee".into(),
            text_dim: "#999fb5".into(),
            text_muted: "#5e6378".into(),
            terminal_bg: "#0a0e1c".into(),
        },

        // Ember: forge after dark, ember orange against warm charred panel.
        ThemeConfig {
            name: "ember".into(),
            bg: "#100806".into(),
            panel: "#1a0e0a".into(),
            panel_2: "#251510".into(),
            border: "#2d1d15".into(),
            accent: "#d4805c".into(),
            accent_dim: "#e09975".into(),
            success: "#9bc89d".into(),
            warning: "#d4805c".into(),
            danger: "#c86060".into(),
            text: "#f0e0d0".into(),
            text_dim: "#a09080".into(),
            text_muted: "#6d5e50".into(),
            terminal_bg: "#100806".into(),
        },

        // ─── Legacy themes ───────────────────────────────────────────
        ThemeConfig {
            name: "dark".into(),
            bg: "#0a0a0b".into(),
            panel: "#101013".into(),
            panel_2: "#16161c".into(),
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
            panel_2: "#1a212a".into(),
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
            panel_2: "#0a4351".into(),
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
        .join(".octopush")
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
        assert_eq!(themes[0].panel_2, "#1a160f", "atelier panel_2 must be the brass-tinted onyx");
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
    fn premium_family_themes_are_present() {
        let themes = builtin_themes();
        let names: Vec<&str> = themes.iter().map(|t| t.name.as_str()).collect();
        for n in ["vellum", "mossbank", "porcelain-indigo", "ember"] {
            assert!(names.contains(&n), "premium theme {n} must be present");
        }
    }

    #[test]
    fn vellum_is_the_only_light_theme() {
        // Heuristic: a "light" theme has a bg lightness > 0.5. Confirms
        // we shipped exactly one light theme — the user's explicit ask.
        let themes = builtin_themes();
        let lights: Vec<String> = themes
            .iter()
            .filter(|t| hex_lightness(&t.bg) > 0.5)
            .map(|t| t.name.clone())
            .collect();
        assert_eq!(lights, vec!["vellum".to_string()], "vellum must be the sole light theme");
    }

    #[test]
    fn every_theme_specifies_panel_2() {
        for t in builtin_themes() {
            assert!(!t.panel_2.is_empty(), "{} is missing panel_2", t.name);
            assert!(t.panel_2.starts_with('#'), "{} panel_2 must be hex", t.name);
        }
    }

    /// Approximate the perceived lightness of a `#rrggbb` color in [0, 1].
    /// Used by the light-vs-dark theme sanity check; not exact.
    fn hex_lightness(hex: &str) -> f32 {
        let s = hex.trim_start_matches('#');
        if s.len() != 6 { return 0.0; }
        let r = u8::from_str_radix(&s[0..2], 16).unwrap_or(0) as f32 / 255.0;
        let g = u8::from_str_radix(&s[2..4], 16).unwrap_or(0) as f32 / 255.0;
        let b = u8::from_str_radix(&s[4..6], 16).unwrap_or(0) as f32 / 255.0;
        // Rec. 709 luma — good enough for distinguishing light from dark.
        0.2126 * r + 0.7152 * g + 0.0722 * b
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
