# Settings, reimagined — a complete redesign

**Date:** 2026-06-17
**Status:** Design approved (autonomous mandate) → implementation
**Surface:** `src/components/Settings.tsx` and everything it renders
**Design system:** Atelier in Onyx & Brass (see `docs/design-system.md`)

---

## 1. Why

Settings has rotted into a 2366-line monolith with eight flat tabs. Three problems, in the
user's own words: it **mixes topics**, it **isn't well structured**, and it **isn't intuitive**.
The worst offender is **Models & Providers** — one long vertical scroll where every provider is
permanently expanded with its API key, base URL, full model list, and inline add/edit forms all
visible at once. Nested boxes, native form controls, and an always-present global "Save changes"
button make it feel like a config file, not a product.

The goal: make Settings **friendly, clean, intuitive, premium** — the same quirurgical-brass
Atelier identity as the rest of Octopush — without losing a single capability. Simplify
presentation, never capability (Minimalism doctrine §9).

## 2. Non-goals

- No backend changes. Every IPC command, settings.json shape, and persistence path is unchanged.
  This is a pure frontend restructure + redesign, which keeps the blast radius small and the
  release safe.
- No new colors, fonts, or accents. Tokens only.
- Not redesigning the *content* of reference panes (Shortcuts, Privacy) — only their grouping.

## 3. Architecture — decompose the monolith

`Settings.tsx` becomes a thin **shell** at its current path (preserving the `./components/Settings`
import that `App.tsx` depends on). Everything else moves under `src/components/settings/`:

```
src/components/
  Settings.tsx                 ← shell only: header, grouped nav, pane router (≈90 lines)
  settings/
    shared.tsx                 ← PaneHeader, SectionLabel, ToggleRow, Stat, Row, formatTokens, useChartColors
    GeneralPane.tsx            ← Attention (sound) + future app-wide prefs
    EditorPane.tsx             ← word wrap, font size, tab width, line numbers, editor command
    ModelsPane.tsx             ← master-detail orchestrator + ProviderList + ProviderDetail
    ModelDialog.tsx            ← add/edit a model (ModalShell)
    AddProviderDialog.tsx      ← add a provider wizard (ModalShell, I · II)
    AppearancePane.tsx         ← theme picker
    UsagePane.tsx              ← budgets + stats + charts + export (token-clean charts)
    ShortcutsPane.tsx
    PrivacyPane.tsx
    IntegrationsPane.tsx       ← Jira + project mappings + Coding Agents (MCP)
    AboutPane.tsx              ← version + updates
```

`src/lib/settingsTabs.ts` is extended to carry **groups** (the structural fix).

Each unit has one job, a clear interface (props), and can be understood and tested in isolation.

## 4. Information architecture — grouped navigation

Replace the flat 8-item sidebar with a **grouped sidebar**: category eyebrows (mono, brass,
0.3em tracking) over their items. General is split into **General** (behavior) and **Editor**
(editor prefs) — they were unrelated concerns crammed together.

```
SETUP
  General          attention / app-wide behavior
  Editor           wrap · font size · tab width · line numbers · editor command
INTELLIGENCE
  Models           providers, keys, model catalog, pricing  (master-detail)
  Usage            budgets · spend · trends · export
CONNECTIONS
  Integrations     Jira · project mappings · coding agents (MCP)
APP
  Appearance       theme
  Shortcuts        keybinding reference
  Privacy          where data lives
  About            version · updates
```

Nav item: quiet by default (`text-octo-sage`, sans), active = brass-ghost fill + brass-dim border
with the label in serif brass — the existing TabButton language, now under group headers. The
active pane crossfades on switch (`.octo-fade-in`, already in place).

`SettingsTab` gains `"editor"`; `general` stays the default (⌘, unchanged). A `SETTINGS_GROUPS`
array drives the nav. Keyboard shortcut for Usage (⌘⇧T) is unchanged.

## 5. The headline — Models, master-detail

Replace the long scroll with a **two-column master-detail** inside the pane:

```
┌─ PROVIDERS ───────────┬─ Anthropic ──────────────────── cloud ─┐
│ ● Anthropic     4   › │  Claude models — console.anthropic.com  │
│ ● OpenAI        3     │                                         │
│ ● DeepSeek      2     │  API KEY   [••••••••••••]        show    │
│ ○ Ollama    1  local  │  BASE URL  [https://api.anthropic.com]  │
│ ● my-gateway    0     │                                         │
│                       │  MODELS · 4              + Add model     │
│  Begin a provider     │  ┌────────────────────────────────────┐ │
│                       │  │ claude-sonnet-4-6  $3/$15 · 200k ✎✕│ │
│  ─────────────        │  │ claude-opus-4-1    $15/$75 · 200k ✎✕│ │
│  Pricing · 2h ago  ↻  │  └────────────────────────────────────┘ │
└───────────────────────┴─────────────────────────────────────────┘
        ▸ unsaved-changes save bar slides in here only when dirty
```

**Provider list (master), ~220px.** Each provider is a selectable row: an identity **dot**
(`--provider-anthropic/-openai/-deepseek/-ollama`; generic mute for custom), the name in serif,
and a mono model count. `local` providers carry a tiny `local` tag instead of a count emphasis.
Active row = brass-ghost + brass-dim border. First provider auto-selected on load. "Begin a
provider" CTA (upright serif phrase) opens the add-provider dialog. A quiet footer line holds the
**pricing refresh** (last-refreshed relative time + an IconButton ↻), moved out of the content flow.

**Provider detail.** Header: provider name (serif) + a `cloud`/`local` tag. Then API key (password
input + show/hide, hidden for local providers), base URL, and the **models list**. Each model row
shows id (mono), display name when distinct, `$in/$out · {k} ctx`, and edit/remove **IconButtons**.
`+ Add model` opens the model dialog.

**Dialogs, not nested boxes.** Add/edit model and add provider move into **`ModalShell`** dialogs.
This kills the "boxes don't nest" violation and the always-expanded inline forms. The add-provider
dialog is a two-step ceremony (`I · II` roman numerals): identity (name, protocol via **Listbox**,
local via **TogglePill**) → endpoint (base URL). Model dialog: id, display name, cost in/out,
context — labeled inputs, validation inline ("Model id is required").

**Save model.** Keep the exact IPC contract (`saveProviders` then merge-and-`saveSettings`), but
surface it as an **unsaved-changes bar** that reveals (`<Reveal>`) only when the working copy
diverges from the loaded catalog/keys/baseUrls: `Unsaved changes — Save · Discard`. No permanent
button; the surface is calm until you've changed something. Save/validation errors still toast.

## 6. Appearance — a palette you can see

Drop the noisy `accent #d4a574` mono caption (the swatch already *is* the accent — Minimalism §9:
"a state shown by a colored dot does not also get a text label"). Each theme card renders a **live
multi-swatch** from the real `ThemeConfig` (bg · panel · accent · sage), the name in serif, and a
brass `✓` (`.octo-pop-in`) on the active theme. Hover lift (180ms, translateY(-1px)). The card *is*
the preview.

## 7. Token compliance — charts go theme-reactive

The Usage charts hardcode `#d4a574`, `#14110d`, `#2a2419`, `#f4ecdb`, `#6d6354`, `#95897a`, and a
`BRASS_PALETTE` of seven literal hexes — a Minimalism bug and the reason charts don't follow theme
switches. Add a **`useChartColors()`** hook in `shared.tsx` that reads the live tokens via
`getComputedStyle(document.documentElement)` and recomputes when the active theme changes
(subscribe to `useThemeStore`/the `octo:theme` event). Recharts needs concrete colors; this gives
them, theme-aware. The series palette derives from `accent · verdigris · state-blue · state-purple
· rouge · mute` — all tokens.

## 8. Atelier controls

Replace native form controls everywhere they appear in Settings with the `controls/` primitives:
- `<select>` → **Listbox** (add-provider protocol; add-budget scope & period).
- `<input type=checkbox>` → **TogglePill** (provider `local`).
- tab-width chips → **SegmentedControl**.
- font-size ± → **Stepper** (min 10, max 24, the existing bounds).
- ✎ / ✕ actions → **IconButton**.

Native `<input type=text|password|number|date>` for free-form values (keys, URLs, costs, dates)
stays — those have no Atelier equivalent and are already token-styled.

## 9. Motion & stability

Reuse primitives only (design-system §6): nav crossfade `.octo-fade-in`; dialogs via `ModalShell`
(`.octo-overlay-enter` + `.octo-modal-enter`); the save bar and any expand/collapse via `<Reveal>`;
model/provider rows enter with `.octo-rise-in`; status ticks `.octo-pop-in`; live numerics carry
`.octo-tabular`. All respect `prefers-reduced-motion`. Nothing mounts or unmounts abruptly.

## 10. Testing

- **Editor** (`Settings.editorprefs.test.tsx`): retarget to `initialTab="editor"`; update tab-width
  assertions to SegmentedControl semantics (`role=radio` / `aria-checked`) and font-size to the
  Stepper, preserving the same store-write coverage.
- **Models** (`Settings.modelspane.test.tsx`): rewrite for the master-detail flow — first provider
  auto-selected; add/edit/remove model and add/remove provider via dialogs; **same IPC assertions**
  (`saveProviders` + `saveSettings` called once each with the new model in the providers arg;
  validation errors; confirm-dialog removal; reset-to-defaults).
- **Issue tracker** (`Settings.issuetracker.test.tsx`): retarget to `initialTab="integrations"`;
  behavior unchanged.
- New: a small **nav/group** test (groups render, item switches pane) and a **theme-card** render
  test (no hardcoded hex caption; active ✓ present).
- Gates: `npm run typecheck` and `npm test` green; a Rust build is unaffected (no backend change).

## 11. Risks & mitigations

- **Large move diff.** Decomposition is mostly mechanical relocation; logic is preserved verbatim
  where not explicitly redesigned. Fresh-context subagents review for side effects and bugs.
- **Test churn.** Expected and owned: the redesign changes interactions, so tests are rewritten to
  the new UX while holding the IPC/behavior contracts constant.
- **Save-bar dirty detection.** Compare working copy against the loaded snapshot with a stable
  serialization; guard against false-dirty from object identity.

## 12. Definition of done

Grouped nav; General/Editor split; Models master-detail with dialog-based add/edit and an
unsaved-changes bar; premium theme cards; token-clean theme-reactive charts; Atelier controls
throughout; monolith decomposed; typecheck + tests green; code-reviewed by fresh-context subagents
with all findings fixed; PR → review → merge → release.
