# Octopus UX Redesign — Atelier in Onyx & Brass

**Date:** 2026-05-16
**Status:** Design approved, pending implementation
**Scope:** Full UX overhaul of the Octopus desktop app (Tauri 2 + React 19 + TypeScript)

---

## 1. Summary

Replace Octopus's generic "AI dev tool" aesthetic (dark zinc + purple accent + Cursor/Linear-adjacent layout) with a **distinctive premium identity** built on three commitments:

1. **Aesthetic:** *Nocturne Luxe · Onyx & Brass* — warm onyx black (#0c0a08), a single brass accent (#d4a574), Spectral italic serif for display, system sans for body, JetBrains Mono for meta. Premium and tactile, not utilitarian.
2. **Architecture:** *Atelier* — kills the duplicate workspace sidebar + workspace bar of the current app. Replaces it with a slim icon rail, a floating context header, three intent-based **modes (Talk / Run / Review)** that replace tabs, and a permanent **Companion** panel on the right with live context.
3. **Personality:** Editorial signature details — italic-serif CTAs, brass rules that grow on key moments, `§` glyphs for tool calls, roman numerals in wizards, the brass `⟶` for prompts.

The result should feel closer to a beautifully bound notebook than to a productivity tool. The user has explicitly said the current onboarding feels too similar to Superset; this redesign aims to be unmistakably itself.

### Goals

- Eliminate the duplicate navigation (project sidebar + 2-level workspace bar).
- Give the chat surface its own visual voice — distinct from Cursor / Linear / generic chat UIs.
- Integrate side information (tokens, history, files, git status) into a permanent companion instead of disconnected overlays.
- Make every entry/creation flow feel ceremonial rather than mechanical.
- Lock a coherent design system (tokens, type, motion) so future surfaces stay on-brand.

### Non-goals

- No backend rewrite. `chat_engine`, `provider_router`, `pty_manager`, `git_ops`, etc. stay as-is. This is purely a frontend redesign with light theme-system adjustments.
- No new features beyond what's already in the app. We're recomposing existing functionality, not adding capabilities.
- No light theme in scope. The current app is dark-only; we stay dark-only with the Nocturne palette. A future light variant is possible but out of scope.
- No backwards compatibility for the existing theme JSON. The Onyx & Brass palette becomes the canonical default; user themes can still override via the existing `themeStore` mechanism.

### Constraints

- Must work within the existing Tauri 2 + React 19 + Tailwind v4 + Zustand architecture.
- Must not regress the recent fixes to ChatView/ToolCallCard visibility (the area had 11+ fix commits — this redesign owns that surface and cleans up the residual `debug:` artifacts).
- Spectral font must be self-hosted or loaded via Google Fonts; no other font dependency.

---

## 2. Foundations

### 2.1 Color tokens

11 tokens. Brass is **the only accent** and should appear quirurgically — in eyebrow labels, active states, and "the one important thing" per screen. If everything is brass, nothing is brass.

| Token        | Hex       | Role |
|--------------|-----------|------|
| `--onyx`     | `#0c0a08` | App background — warm black, brown undertone |
| `--panel`    | `#14110d` | Surfaces: rail, header, companion, popovers |
| `--panel-2`  | `#1a160f` | Active inputs, hover surfaces |
| `--hairline` | `#2a2419` | 1px borders, separators |
| `--brass`    | `#d4a574` | The single accent — active states, key labels |
| `--brass-hi` | `#e8c39a` | Hover / pressed brass |
| `--ivory`    | `#f4ecdb` | High-emphasis text, display serifs |
| `--sage`     | `#95897a` | Body text — calmer than zinc-300 |
| `--mute`     | `#6d6354` | Labels, placeholders, meta |
| `--verdigris`| `#8fc9a8` | Success, diff additions (reserved) |
| `--rouge`    | `#d18b8b` | Error, diff deletions (reserved) |

Also: `--brass-dim: rgba(212, 165, 116, 0.4)` for hairline accents and `--brass-ghost: rgba(212, 165, 116, 0.08)` for active fills.

### 2.2 Typography

Three families, six roles.

| Role           | Family               | Size / Weight / Style                        | Use |
|----------------|----------------------|-----------------------------------------------|-----|
| Serif Display  | Spectral             | 28px / 400 / italic / tracking −0.01em        | Welcome title, "the key phrase" of a response |
| H1 Page        | Spectral             | 22px / 400 / italic / tracking −0.005em       | Workspace name, wizard step headlines |
| H2 Section     | System sans          | 16px / 600 / tracking −0.005em                | Settings sections, panel titles |
| Body           | System sans          | 13px / 400 / line-height 1.55                 | Default reading text |
| Small / Meta   | System sans          | 11px / 400 / line-height 1.5                  | Companion rows, captions |
| Eyebrow        | JetBrains Mono       | 10px / uppercase / tracking 0.25em            | Labels: "— Claude", "WORKSPACE", "CONTEXT" |
| Mono           | JetBrains Mono       | 12px                                          | Code, terminal, kbd, file paths |

**Principle:** Spectral italic marks *moments* (display, key phrase, ceremonial CTAs). Sans handles volume. Mono is for meta and code. Three voices, never more. CTA labels are written as **italic-serif phrases** ("Begin a new study", "Inscribe your next thought…"), not imperative labels.

### 2.3 Spacing, borders, radii

- **Spacing scale (base 4):** 4 · 8 · 12 · 16 · 24 · 32 · 48. Standard gaps are 12/16/24. "Premium breath" lives at 24 and 32 around displays and key modules.
- **Radii:** `sm: 6px` (buttons, pills), `md: 10px` (panels, inputs), `lg: 14px` (large canvases). No pill-shaped controls by default — corners are noble, not playful.
- **Borders:** 1px hairlines in `--hairline`. Brass hairlines (`--brass-dim`) for active accents. The **brass rule** — a 28px line with a `linear-gradient(90deg, brass, transparent)` — is the signature divider; it separates ceremonial moments (welcome, wizards, response sections).

### 2.4 Components

| Component | Treatment |
|-----------|-----------|
| Primary button | Italic-serif label, `--brass-ghost` fill, `--brass-dim` border. Reserved for ceremonial CTAs. |
| Ghost button | Sans label, hairline border, transparent fill. Default for any action. |
| Input | Hairline border (→ `--brass-dim` on focus). Placeholders in italic-serif. |
| Pills | Mono uppercase, dot icon instead of glyphs. Verdigris for active/success, brass-ghost for idle. |
| Toast | 2px left border in brass, no icons. Heading in italic-serif, body in sans. |
| Tool card | Border-left brass-dim, brass-ghost fill, label as `§ TOOL_NAME` in mono. |

---

## 3. Architecture — Atelier

### 3.1 The five surfaces

The application surface is decomposed into five fixed regions:

```
┌────┬─────────────────────────────────┬───────────────────┐
│    │ [ContextHeader]      [Modes]    │                   │
│ R  ├─────────────────────────────────┤                   │
│ a  │                                 │   Companion       │
│ i  │   Canvas                        │   (per-mode)      │
│ l  │   (Talk | Run | Review)         │                   │
│    │                                 │                   │
│    ├─────────────────────────────────┤                   │
│    │ [Input bar]                     │                   │
└────┴─────────────────────────────────┴───────────────────┘
```
The Rail spans full height on the left (48px). The Companion spans full height on the right (280px). The ContextHeader, Canvas, and Input bar are stacked between them.

| Surface          | Width | Content |
|------------------|-------|---------|
| **Rail**         | 48px  | Workspace monograms (italic-serif initial in brass-ghost square). Always visible. Single column. |
| **ContextHeader**| flex  | Floating card. Shows workspace name (italic serif), branch, git status. The "you are here" anchor. |
| **Modes**        | auto  | Top-right. Three pills: Talk / Run / Review. Switches the **Canvas** without disturbing rest. |
| **Canvas**       | flex  | The active mode's content. Talk = chat. Run = terminal. Review = diff. |
| **Companion**    | 280px | Right side, permanent. Content per mode: context+history (Talk), terminals+shortcuts (Run), changed files (Review). |
| **Input bar**    | flex  | Below canvas. Italic-serif placeholder. ⌘K affordance. |

### 3.2 Mode semantics

Modes are **not tabs** — tabs imply parallel documents; modes are intents on the same workspace.

- **Talk mode** — conversational interaction with the agent. Canvas = chat timeline. Companion = `Context` (tokens, files in flight, tool calls) + `History` (past threads in this workspace).
- **Run mode** — terminal-centric. Canvas = active terminal in a hairline-bordered card. Companion = `Terminals` (list of running shells) + `Quick` (kbd shortcuts for common commands).
- **Review mode** — git diff. Canvas = file diff with line numbers. Companion = `Changed · N` (file list with +/− stats) + commit actions. Input bar prompts: *"Write a commit message"*.

Switching modes glides the brass indicator pill 320ms ease-in-out and cross-fades the canvas. The header and companion shift content but don't re-mount.

### 3.3 What's replaced

| Current (deleted)      | Replacement                                  |
|------------------------|----------------------------------------------|
| `ProjectSidebar.tsx`   | `WorkspaceRail.tsx` (icon-only, monograms)   |
| `WorkspaceBar.tsx`     | `ContextHeader.tsx` + `ModeSwitcher.tsx`     |
| Two-level tabs (`activeView` + `WorkspaceTab[]`) | Single `mode` state per workspace |
| `TokenDashboard.tsx` overlay | Content lives in `Companion` (Talk mode) |
| `SettingsDialog.tsx` (modal) | `Settings.tsx` (full-screen section)  |

The existing `TerminalPane.tsx`, `ChangesPanel.tsx`, `ChatView.tsx`, `CommandPalette.tsx`, `WorkspaceCreator.tsx`, `NewProjectFlow.tsx`, `WelcomeScreen.tsx`, `ToolCallCard.tsx`, `ChatMessage.tsx` are **kept and restyled** — their logic is intact; their visual shell is redrawn.

### 3.4 New components

- `WorkspaceRail.tsx` — vertical rail with monogram icons per workspace, brass vertical indicator marking active. See §3.5 for monogram semantics.
- `ContextHeader.tsx` — floating card displaying workspace name, branch, git status. Reads from `workspaceStore` and `git_ops`.
- `ModeSwitcher.tsx` — three-pill toggle with gliding brass indicator.
- `Companion.tsx` — right-side panel container. Composes per-mode sub-panels (`CompanionContext`, `CompanionHistory`, `CompanionTerminals`, `CompanionChanged`).
- `WorkspaceCustomizeMenu.tsx` — popover invoked by right-click on a rail icon. Lets the user override the workspace's monogram glyph and tint.

Multi-chat-tabs (multiple conversations per workspace) move into `Companion · History` rather than top-level tabs. Multi-terminal-tabs move into `Companion · Terminals`. This collapses two parallel navigation systems into one.

### 3.5 Workspace monograms and tints

Each workspace surfaces in the rail as a 26px square with a monogram. By default:

- **Glyph:** the first character of the workspace name, in Spectral italic.
- **Tint:** brass — square has `--brass-ghost` background with `--brass-dim` border, glyph in `--brass`.

Users can override both via right-click on the rail icon (`WorkspaceCustomizeMenu`). Choices are intentionally **curated**, not free-form — random user-chosen colors break the Nocturne palette.

**Glyph options:**
- Default (first letter of workspace name).
- Any single character the user types (letter, digit, or a single unicode glyph like `§`, `※`, `❦`, `λ`, `★`). Limited to 1 codepoint, rendered in Spectral italic.

**Tint options (presets, palette-aligned):**
1. `Brass` — default. `#d4a574` accent.
2. `Verdigris` — `#8fc9a8` accent on `rgba(143,201,168,0.08)`.
3. `Rouge` — `#d18b8b` accent on `rgba(209,139,139,0.08)`.
4. `Indigo` — `#8a93c9` accent on `rgba(138,147,201,0.08)`.
5. `Lavender` — `#b59ac9` accent on `rgba(181,154,201,0.08)`.
6. `Smoke` — `#a8a8a8` accent on `rgba(168,168,168,0.06)`.
7. `Bone` — `#d8c9a8` accent on `rgba(216,201,168,0.07)`.

Each preset shifts only the icon's border, background, and glyph color. **It does not change the active mode pill, brass rule, or any other brass usage in the app.** The brass identity of Octopus stays intact; the workspace tint is a personal accent for distinguishing workspaces at a glance.

The active workspace's rail indicator (the vertical bar at the rail's left edge) is **always brass**, regardless of workspace tint — it's part of the app's identity, not the workspace's.

Storage: extend the `Workspace` type with optional `glyph?: string` and `tint?: 'brass' | 'verdigris' | 'rouge' | 'indigo' | 'lavender' | 'smoke' | 'bone'`. Default `undefined` for both, which the rail interprets as "first letter + brass". Persisted via existing `workspaceStore`/SQLite.

### 3.6 Keyboard shortcuts

| Shortcut       | Action                                             | Notes |
|----------------|----------------------------------------------------|-------|
| `⌘1` … `⌘9`    | Switch to workspace N in the rail                  | Replaces the current per-view shortcuts. |
| `⌘⇧1`          | Switch to **Talk** mode                            | New in this redesign. |
| `⌘⇧2`          | Switch to **Run** mode                             | |
| `⌘⇧3`          | Switch to **Review** mode                          | |
| `⌘N`           | Create new workspace                               | Unchanged. |
| `⌘K`           | Open command palette                               | Unchanged. |
| `⌘,`           | Open Settings                                      | New (replaces opening the dialog). |
| `⌘⇧T`          | Open Settings · Usage (token dashboard archive)    | Repurposed from "toggle TokenDashboard overlay". |
| `⌘\`           | Toggle Companion panel visibility                  | Replaces "toggle sidebar". |
| `Esc`          | Close palette / customize menu / wizard           | Standard. |

---

## 4. Screens

### 4.1 Welcome (no project open)

- Full-bleed onyx with a soft radial brass glow at top.
- Centered card: 56px circular mark with italic-serif "O" in brass; below it "Octopus & you" in 28px italic serif with the ampersand alone in brass; subtitle "eight arms · one mind" in mono uppercase / 0.35em tracking.
- A 28px gradient brass rule under the subtitle.
- A single primary CTA: *"Begin a new study"* (italic-serif inside a brass-ghost button).
- Below: "or — Drop a folder, or **open one from disk**".
- Recent projects appear at the bottom as inline rows with brass monograms (only when there are recents).

### 4.2 New Project flow

Two-step wizard:
- **Step I — Name your new study.** Project name + path inputs. Italic-serif heading.
- **Step II — Initial settings.** Default model, template choice (existing template system).
- Mono step indicator: `STEP I · OF II`.
- Brass dots progress in bottom-right.
- Primary CTA: italic-serif *"Continue"*.

### 4.3 Workspace · Talk (hero)

The reference application of the Atelier architecture.

- **Rail** at left with the active workspace's brass monogram outlined; others muted.
- **ContextHeader** floating top-left of main: `WORKSPACE` (mono brass eyebrow) + workspace name (italic serif) + branch info on the right with a verdigris dot.
- **Modes** top-right: brass-ghost pill on Talk.
- **Canvas** in the center hosts the conversation timeline. Each model turn renders as:
  - Eyebrow: `— Claude · Opus 4.7` (mono brass uppercase).
  - **Key phrase**: the first complete sentence of the natural-language response, rendered in **22px Spectral italic** with `code` spans inline in brass mono. If the response begins with a tool call instead of prose, the key phrase is the first sentence of the prose that follows the tool result. If the entire response is a single tool call with no prose, no key phrase is rendered.
  - Body: rest of the response in sans 13px.
  - Tool calls: as cards with `§ READ` / `§ WRITE` / `§ RUN` mono labels and the argument (e.g., file path) on the right. Border-left brass-dim, brass-ghost fill.
- **Companion** on the right shows two stacked sections:
  - `Context`: tokens (`42k / 200k` with a 3px brass meter), files in flight, tool calls.
  - `History`: past threads in this workspace as italic-serif titles with mono date meta.
- **Input bar** at the bottom: italic-serif placeholder *"Ask Octopus anything…"*, ⌘K kbd hint on the right.

### 4.4 Workspace · Run

- Same chrome (rail / header / modes / companion / input).
- Canvas = a hairline-bordered card containing the xterm output. Terminal header in mono brass with verdigris dot.
- Prompt glyph is `⟶` in brass (replaces `$` and `>` everywhere — terminal, command palette, input hints).
- Companion shows `Terminals · N` (each running shell as a row with status) and `Quick` (kbd shortcuts: `npm dev ⌘↵`, `npm build ⌘B`).
- Input bar text: *"Type a command, or ⌘K to switch back to chat…"*.

### 4.5 Workspace · Review

- Same chrome.
- Canvas = a hairline-bordered card showing a unified diff. File header in mono brass with stats on the right. Line numbers in `--mute`. Adds in `--verdigris` over `rgba(143,201,168,0.05)`. Dels in `--rouge` over `rgba(209,139,139,0.04)`.
- Companion shows `Changed · N` (each file as a row, `+x −y` stats in mute) + commit shortcut row.
- Input bar text: *"Write a commit message"*.

### 4.6 New Workspace flow

Two-pane layout (separate from the Atelier shell — this is a focused creation flow):
- Left pane (220px, panel bg): step index. Three steps: `I. Name & intent`, `II. Branch from…`, `III. Open with…`. Active step in italic serif + brass numeral.
- Right pane: current step's question in italic serif (e.g., *"Where do we branch from?"*) + descriptive paragraph + field(s) with mono labels. Primary CTA bottom-left. Keyboard hint *"← BACK · ↵ CONTINUE"* bottom-right.

### 4.7 Settings (full-screen section, not modal)

- Title bar at top with mono brass `PREFERENCES` eyebrow + workspace name in italic serif.
- Left nav: `General`, `Models & Providers`, `Appearance`, `Workspaces`, `Shortcuts`, `Privacy`. Active item in italic serif + brass-ghost background.
- Right pane: section header in mono brass uppercase, then field rows separated by dashed hairlines. Each provider row shows status in brass for "Connected", mute for "Add key".

### 4.8 Command Palette (⌘K)

- Floating panel centered, ~60% width, brass-dim border with a subtle 6px brass glow (`box-shadow: 0 0 0 6px rgba(212,165,116,0.04)`).
- Search row at top: mono brass `⌘K` prompt + italic-serif query text + mono `ESC` kbd on the right.
- Results in groups labeled with mono uppercase eyebrows (`WORKSPACES`, `ACTIONS`, `SESSIONS`).
- Each item: a small monogram-or-glyph square (brass on active), label in sans, mono kbd hint on the right.
- Background chrome is dimmed (opacity ~0.3) — the palette becomes the focal point.

---

## 5. Motion

### 5.1 Principles

1. **Calm, not fast.** Durations 220–320ms. Easing `cubic-bezier(0.2, 0.8, 0.3, 1)` — soft entry, gentle settle.
2. **No bouncing, no glitter.** Zero spring physics, confetti, or jittering icons. Movements are geometric and deliberate: fades, short slides, opacity, subtle blur.
3. **Brass marks the moment.** A brass rule growing from 0 to 28px is the signature gesture, reserved for important reveals (tool calls, response sections, wizard transitions).

### 5.2 Signature animations

| Moment              | Detail                                                                                                                                            | Duration / Easing             |
|---------------------|---------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------|
| **Key phrase fade** | Streaming response: eyebrow appears instantly, italic-serif key phrase fades in with `translateY(6px) → 0` + opacity, then body, then tool cards.  | 280ms · ease-out, staggered    |
| **Mode glide**      | Switching Talk/Run/Review: brass indicator pill glides between mode buttons. Canvas cross-fades. Header and companion don't move.                  | 320ms · ease-in-out            |
| **Brass rule reveal** | Brass divider grows from width 0 to 28px. Used on wizard step entry, welcome card, response section dividers.                                    | 600ms · cubic-bezier(.2,.8,.3,1) |
| **Workspace switch**| Click rail icon: brass vertical indicator moves; active monogram brightens; context header name cross-fades. No spinner, no reload.                | 260ms · ease-in-out            |

### 5.3 Performance guard

- Target 60fps on Tauri's webview. Use `transform` and `opacity` only — no animation of `width`/`height`/`top`/`left` except where unavoidable (the brass-rule width grow, which is small).
- Heavy panels (companion, canvas) must use `will-change: transform` only during active transitions, then remove.
- No motion during xterm streaming or token meter updates (those are functional indicators, not transitions).

---

## 6. Signature moments

Five details that should be unmistakably *Octopus*:

1. **The brass ampersand.** "Octopus & you" — the ampersand alone in brass. Small, ceremonial, repeatable across about/welcome surfaces.
2. **The brass `⟶`.** Replaces the shell `$` and chat prompt glyphs everywhere — terminal, command palette, input bar nudges. Tiny but consistent.
3. **`§` tool cards.** Every tool call appears prefixed with a brass `§` and a mono label (`§ READ`, `§ WRITE`, `§ RUN`). A marginalia note, not a button.
4. **Roman numerals in wizards.** All multi-step flows numbered `I · II · III` in brass mono. Feels like a manuscript, not a form.
5. **Italic-serif CTAs.** *"Begin a new study"*, *"Inscribe your next thought…"*, *"Where do we branch from?"*, *"Write a commit message"* — CTAs are phrases, not imperative labels. Each action has voice.

---

## 7. Rollout — 7 phases

Each phase is shippable on its own and reversible. Total estimate ~14 days of development, 7 incremental PRs.

### Phase 1 — Foundations (~1 day)
**Touch:** `src/styles.css`, `src/stores/themeStore.ts`, `src-tauri/src/theme.rs`
- Load Spectral via Google Fonts (preconnect + `<link>` for `Spectral:ital,wght@1,400`). Self-hosting is a future optimization; Google Fonts is acceptable for Phase 1.
- Rewrite `@theme` in `styles.css` with the 11 Onyx & Brass tokens.
- Update the Tauri-side default theme in `theme.rs` to match.
- Update `themeStore` to use new tokens as base.
- **Ships:** Entire app re-skins immediately, even with no structural changes.

### Phase 2 — Atelier shell (~3 days)
**New:** `WorkspaceRail.tsx`, `ContextHeader.tsx`, `Companion.tsx`, `ModeSwitcher.tsx`, `WorkspaceCustomizeMenu.tsx`
**Delete:** `ProjectSidebar.tsx`, `WorkspaceBar.tsx`
**Touch:** `App.tsx` (kill `tabsPerWorkspace`, `activeView`, `viewPerWorkspace` state in favor of single `mode` per workspace), `src/lib/types.ts` (add `glyph?` and `tint?` to `Workspace`), `src/stores/workspaceStore.ts` (persist customization), `src-tauri/src/commands.rs` (workspace update command if not already present)
- Build the new layout grammar.
- Migrate multi-chat-tab state into `Companion · History`.
- Migrate multi-terminal-tab state into `Companion · Terminals`.
- Implement monogram + tint customization (right-click rail icon → 7 presets + glyph input).
- **Ships:** Duplicate navigation eliminated. Workspaces distinguishable at a glance. New spatial grammar.

### Phase 3 — Modes (~2 days)
**Touch:** `App.tsx`, `ChatView.tsx`, `TerminalPane.tsx`, `ChangesPanel.tsx`, `Companion.tsx`
- Replace `activeView` tabs with `Talk | Run | Review` modes wired through `ModeSwitcher`.
- Companion content swaps per mode (`CompanionContext` / `CompanionTerminals` / `CompanionChanged`).
- Keyboard shortcuts per §3.6: `⌘1`…`⌘9` switch workspaces (Phase 2 already wired this); `⌘⇧1/2/3` switch modes; `⌘\` toggles Companion.
- **Ships:** The 3 modes coexist with cohesive chrome.

### Phase 4 — Chat soul (~2 days)
**Touch:** `ChatMessage.tsx`, `ToolCallCard.tsx`, `ChatView.tsx`
- Refactor `ChatMessage` so model responses parse into "key phrase" (first sentence → Spectral italic) + "body" (rest → sans).
- Redesign `ToolCallCard` with brass-dim left border, `§ TOOL_NAME` mono label, argument on the right.
- Implement key-phrase fade-in animation during streaming.
- Clean up the residual `debug:` console logs and visible debug counters from the previous fix cycle.
- **Ships:** Chat stops looking like generic Cursor and has editorial voice.

### Phase 5 — Entry flows (~2 days)
**Touch:** `WelcomeScreen.tsx`, `NewProjectFlow.tsx`, `WorkspaceCreator.tsx`
- Welcome rebuilt with brass mark + italic-serif logo + dropzone + single ceremonial CTA.
- `NewProjectFlow` rebuilt as 2-step wizard with roman numerals.
- `WorkspaceCreator` rebuilt as 2-pane / 3-step wizard.
- Apply brass-rule-reveal animation on step entry.
- **Ships:** Onboarding no longer feels like Superset — it's ceremonial.

### Phase 6 — Side surfaces (~2 days)
**Touch:** `SettingsDialog.tsx` → `Settings.tsx`, `CommandPalette.tsx`, delete `TokenDashboard.tsx`
- Convert Settings from modal dialog to full-screen section with side nav.
- Redesign CommandPalette with grouped results, brass monograms, brass glow.
- Remove `TokenDashboard` component (its residential content already migrated to `Companion · Context` in Phase 2).
- Repurpose `⌘⇧T` to open `Settings · Usage` (full-screen usage dashboard with historical charts, the data previously in `TokenDashboard`). Removes the orphaned `showTokens` state from `App.tsx`.
- **Ships:** Side surfaces stop being disconnected overlays.

### Phase 7 — Motion & polish (~2 days)
**Touch:** Per-component animation hooks, `src/styles.css` (motion variables)
- Implement and tune the 4 signature animations.
- Standardize easing curves as CSS custom properties.
- 60fps profile pass on Tauri webview.
- Visual QA against the design mockups.
- **Ships:** Octopus feels alive, deliberate, premium.

### Phase ordering rationale

Phases 1 and 2 are the biggest visual wins per day of work. If we stop after Phase 2 the app already looks transformed. Phases 3–6 are the structural overhaul. Phase 7 is purely polish.

---

## 8. Risks & open questions

### Risks

| Risk | Mitigation |
|------|------------|
| Killing tabs breaks existing user workflows (people had multiple chats per workspace). | Migrate the data into `Companion · History`. Verify multi-conversation persistence still works after Phase 3. |
| The xterm + Tauri webview may not render at 60fps with heavy motion. | Phase 7 includes a performance guard; if needed, disable mode-glide animation in xterm-active states. |
| User custom themes (existing `themeStore` data) will look broken under the new component design. | Document the breaking change; provide a one-time migration that resets users to the new default Onyx & Brass theme on first launch after the update. |
| Spectral font loading delay causes a FOUT on Welcome. | Preload Spectral italic in `index.html`. Fall back gracefully to `serif` while loading. |
| Removing two-level tabs may confuse users mid-conversation. | Conversation IDs in `Companion · History` preserve all existing chats; nothing is lost, just reorganized. |

### Resolved decisions (2026-05-16)

1. **Workspace monograms** — Default to first letter of the workspace name. Users can override the glyph (any single character) and tint (one of 7 curated presets) via right-click on the rail icon. Details in §3.5. The brass identity of the app itself stays untouched — only the workspace's own icon is recolored.
2. **Mode keyboard shortcuts** — `⌘1`…`⌘9` are reserved for **workspace switching** (preserves the existing mental model). Mode switching uses `⌘⇧1` (Talk), `⌘⇧2` (Run), `⌘⇧3` (Review). Full shortcut table in §3.6.
3. **Light theme** — Out of scope, no near-term plans. Token names stay poetic (`--onyx`, `--brass`, `--ivory`, etc.). If a light variant becomes a goal in the future, this will be a deliberate rename pass, not a quick toggle.

---

## 9. Definition of done

The redesign is complete when:

- All 7 phases have shipped to `main`.
- The current `ProjectSidebar`, `WorkspaceBar`, `TokenDashboard` components are deleted.
- `App.tsx` no longer carries `tabsPerWorkspace`, `viewPerWorkspace`, or `activeView` state.
- A new user opening Octopus for the first time sees: Welcome → New Project wizard → New Workspace wizard → Workspace · Talk mode — all in Onyx & Brass with italic-serif voice.
- The 8 reference screens (Welcome, New Project, Workspace · Talk/Run/Review, New Workspace flow, Settings, Command Palette) match the approved mockups within reasonable fidelity.
- `npm run typecheck` and `cargo test` pass.
- No `console.log` or `debug:` artifacts remain in the modified components.

---

*Design approved through brainstorming session 2026-05-16. Next step: implementation plan for Phase 1 via `writing-plans` skill.*
