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
    /// Boundary colour for **interactive** chrome — input outlines, button
    /// edges, the focus ring. WCAG 1.4.11 asks 3:1 of any control boundary,
    /// which `border` deliberately does not meet: `border` is the decorative
    /// hairline that separates panels, and pushing it to 3:1 would draw a hard
    /// line around every surface in the app.
    ///
    /// Defaulted for serde so a `~/.octopush/theme.json` written before this
    /// field existed still loads. The fallback is atelier's value, which is
    /// wrong for a hand-written light theme — but a stale config keeping a
    /// slightly-off control border is a far better failure than refusing to
    /// start.
    #[serde(default = "default_border_strong")]
    pub border_strong: String,
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

fn default_border_strong() -> String {
    "#786747".into()
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
            border_strong: "#786747".into(),
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
        //
        // Every ink here is SOLVED, not eyeballed, and the arithmetic is
        // enforced by `vellum_clears_wcag_aa_on_every_surface` below. Three
        // decisions distinguish it from a naive inversion of atelier:
        //
        //  1. Ratios are checked against the WORST of the three surfaces —
        //     `panel_2`, the hover/popover ground — because a token that
        //     passes on the canvas and fails on hover has still failed.
        //  2. Inks darken along their own hue while GAINING saturation. On
        //     onyx an accent earns contrast by lightening, which desaturates
        //     it; on cream the move reverses, and darkening alone would leave
        //     the palette muddy.
        //  3. `accent_dim` inverts its meaning. On onyx it is the *brighter*
        //     sibling used for emphasis; on cream emphasis runs the other way,
        //     so vellum's is a deeper chestnut (7.54:1) for hover/pressed.
        //
        // The ground is off-white and the ink off-black on purpose: pure
        // #000-on-#fff is 21:1, which halates for astigmatic readers and
        // fatigues everyone across a full-screen IDE. This pairing lands at
        // 13.5:1 — well past AA, well short of glare.
        ThemeConfig {
            name: "vellum".into(),
            bg: "#f2ece0".into(),
            panel: "#faf6ec".into(),
            // Light-mode elevation inverts: there is no headroom above `panel`
            // before it becomes paper-white, so the "raised" surface RECESSES
            // instead, and lift is carried by border + shadow.
            panel_2: "#ece4d4".into(),
            // Stronger than atelier's hairline reads on onyx (1.63:1 vs 1.28:1)
            // and on purpose: a light theme cannot lift a surface by brightening
            // it, so its borders carry structure the dark theme gets for free.
            border: "#c9ba95".into(),
            border_strong: "#8a7a5f".into(),
            accent: "#91522c".into(),
            accent_dim: "#6d3710".into(),
            success: "#246f47".into(),
            // Amber is the token that fails light mode most reliably — the
            // shipped #b8801d sat at 2.46:1. Bronze keeps the caution read
            // while clearing AA as body text.
            warning: "#7f5300".into(),
            danger: "#b33024".into(),
            text: "#2a201a".into(),
            text_dim: "#6d5e4b".into(),
            text_muted: "#6f5f4a".into(),
            terminal_bg: "#f2ece0".into(),
        },

        // Mossbank: deep evergreen and warm amber. Forest atelier.
        ThemeConfig {
            name: "mossbank".into(),
            bg: "#0a120c".into(),
            panel: "#121b14".into(),
            panel_2: "#1a261c".into(),
            border: "#233028".into(),
            border_strong: "#597a66".into(),
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
            border_strong: "#606fad".into(),
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
            border_strong: "#915e44".into(),
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
            border_strong: "#67677a".into(),
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
            border_strong: "#627185".into(),
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
            border_strong: "#779199".into(),
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

/// The theme the user explicitly chose, or `None` when they never have.
///
/// This used to fall back to `atelier` on a missing file, which silently
/// erased the distinction between "chose the dark theme" and "has not chosen".
/// The frontend needs that distinction: with no stored choice it seeds from
/// `prefers-color-scheme` and keeps following the OS, so a light-desktop user
/// gets vellum on first launch instead of onyx.
pub fn load_stored_theme() -> AppResult<Option<ThemeConfig>> {
    let path = config_path();
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path)?;
    Ok(Some(serde_json::from_str(&content)?))
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

    #[test]
    fn every_theme_specifies_border_strong() {
        for t in builtin_themes() {
            assert!(
                t.border_strong.starts_with('#') && t.border_strong.len() == 7,
                "{} border_strong must be a #rrggbb hex",
                t.name
            );
        }
    }

    // ── WCAG gates ──────────────────────────────────────────────────
    //
    // These exist so a palette regression breaks `cargo test` rather than a
    // design review. The mirror of this arithmetic lives in
    // `src/lib/contrast.ts`; both implement WCAG 2.1 relative luminance.

    /// Linearise one sRGB channel, per WCAG 2.1.
    fn channel_luminance(c: u8) -> f64 {
        let s = c as f64 / 255.0;
        if s <= 0.03928 {
            s / 12.92
        } else {
            ((s + 0.055) / 1.055).powf(2.4)
        }
    }

    fn luminance(hex: &str) -> f64 {
        let s = hex.trim_start_matches('#');
        let ch = |i: usize| u8::from_str_radix(&s[i..i + 2], 16).unwrap_or(0);
        0.2126 * channel_luminance(ch(0))
            + 0.7152 * channel_luminance(ch(2))
            + 0.0722 * channel_luminance(ch(4))
    }

    /// WCAG contrast ratio between two opaque `#rrggbb` colours, in [1, 21].
    fn contrast_ratio(a: &str, b: &str) -> f64 {
        let (x, y) = (luminance(a), luminance(b));
        let (hi, lo) = if x > y { (x, y) } else { (y, x) };
        (hi + 0.05) / (lo + 0.05)
    }

    /// Worst ratio of `ink` across a theme's three painted surfaces. Checking
    /// only `bg` is the trap that produced the original vellum: `panel_2` is
    /// the hover/popover ground, and an ink that passes on the canvas but
    /// fails on hover has still failed the user.
    fn worst_surface_ratio(t: &ThemeConfig, ink: &str) -> f64 {
        [&t.bg, &t.panel, &t.panel_2]
            .iter()
            .map(|s| contrast_ratio(ink, s))
            .fold(f64::INFINITY, f64::min)
    }

    #[test]
    fn contrast_ratio_matches_known_wcag_values() {
        // Anchors from the WCAG definition itself, so a refactor of the maths
        // above can't quietly drift.
        assert!((contrast_ratio("#000000", "#ffffff") - 21.0).abs() < 0.01);
        assert!((contrast_ratio("#ffffff", "#ffffff") - 1.0).abs() < 0.001);
        // Order must not matter.
        assert!(
            (contrast_ratio("#0c0a08", "#d4a574") - contrast_ratio("#d4a574", "#0c0a08")).abs()
                < 1e-9
        );
    }

    #[test]
    fn vellum_clears_wcag_aa_on_every_surface() {
        let vellum = builtin_themes()
            .into_iter()
            .find(|t| t.name == "vellum")
            .expect("vellum must exist");

        // Every ink vellum can paint text with, against the worst surface.
        // 4.5:1 is AA for body text — the size most of these actually render at.
        for (label, ink) in [
            ("text", &vellum.text),
            ("text_dim", &vellum.text_dim),
            ("text_muted", &vellum.text_muted),
            ("accent", &vellum.accent),
            ("accent_dim", &vellum.accent_dim),
            ("success", &vellum.success),
            ("warning", &vellum.warning),
            ("danger", &vellum.danger),
        ] {
            let r = worst_surface_ratio(&vellum, ink);
            assert!(
                r >= 4.5,
                "vellum {label} ({ink}) is {r:.2}:1 on its worst surface, needs 4.5:1"
            );
        }

        // Interactive boundaries and the focus ring: WCAG 1.4.11, 3:1.
        // The focus ring reuses `accent`, already asserted above at 4.5.
        let border = worst_surface_ratio(&vellum, &vellum.border_strong);
        assert!(
            border >= 3.0,
            "vellum border_strong ({}) is {border:.2}:1, needs 3.0:1",
            vellum.border_strong
        );
    }

    #[test]
    fn vellum_avoids_the_halation_extremes() {
        let vellum = builtin_themes()
            .into_iter()
            .find(|t| t.name == "vellum")
            .expect("vellum must exist");

        // Pure #000 on #fff is 21:1 and smears for astigmatic readers across a
        // full-screen IDE. Off-black on off-white keeps AA with room to spare
        // while staying clear of that ceiling.
        let ink = contrast_ratio(&vellum.text, &vellum.bg);
        assert!(
            (10.0..=16.0).contains(&ink),
            "vellum text-on-bg is {ink:.2}:1; expected 10–16 (AA without glare)"
        );
        assert!(
            contrast_ratio(&vellum.panel, "#ffffff") > 1.02,
            "vellum's lightest surface must be off-white, not paper-white"
        );
    }

    #[test]
    fn every_designed_theme_clears_aa_for_text_and_accent() {
        // Scope note: this gate covers the themes we actively design. The three
        // LEGACY themes (dark, midnight, solarized-dark) predate the design
        // system and are kept only so existing configs keep working —
        // solarized-dark's own text sits at 3.43:1, which is inherent to the
        // upstream Solarized palette and not ours to restyle.
        //
        // `text_muted` is deliberately absent here: it clears AA in vellum but
        // fails in EVERY dark theme (atelier 3.06:1, midnight 1.96:1). That is a
        // real, pre-existing accessibility debt across the dark palettes, and
        // fixing it means changing how the flagship looks — a brand decision,
        // not a light-mode one. Tracked in docs/design-system.md.
        const LEGACY: [&str; 3] = ["dark", "midnight", "solarized-dark"];

        for t in builtin_themes() {
            if LEGACY.contains(&t.name.as_str()) {
                continue;
            }
            for (label, ink) in [("text", &t.text), ("accent", &t.accent)] {
                let r = worst_surface_ratio(&t, ink);
                assert!(
                    r >= 4.5,
                    "{} {label} ({ink}) is {r:.2}:1 on its worst surface, needs 4.5:1",
                    t.name
                );
            }
            let b = worst_surface_ratio(&t, &t.border_strong);
            assert!(
                b >= 3.0,
                "{} border_strong ({}) is {b:.2}:1, needs 3.0:1",
                t.name,
                t.border_strong
            );
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
