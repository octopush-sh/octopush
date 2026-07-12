# Octopush · AI assistant guidelines

This file is read automatically by Claude Code (and is mirrored in `AGENTS.md` for other AI tools). It captures the non-negotiable rules for working in this repo.

**Octopush** is a Tauri 2 desktop app (React 19 + TypeScript frontend, Rust backend) — "The IDE for Agentic Developers". Workspaces are git worktrees. The backend lives in `src-tauri/src/`, the frontend in `src/`.

---

## Feature map — the source of truth for what Octopush does

[`docs/FEATURES.md`](docs/FEATURES.md) is the canonical, exhaustive catalogue of **every** Octopush feature and **how** it is implemented (Tauri commands, Zustand stores, components, mechanisms, data model). Read it to learn what already exists before you add or change behaviour — it is the fastest way to understand the product surface end-to-end.

**Binding rule — keep it up to date.** Any change that adds, removes, or meaningfully alters a user-facing feature **must** update `docs/FEATURES.md` in the same change. A PR that ships or changes a feature without updating the map is **incomplete**. This applies to backend and frontend alike, down to the smallest toggle, context-menu item, keyboard shortcut, empty state, or command. When you add a new surface, add its entries; when you delete one, delete its entries. Treat the map as part of the change, not an afterthought.

---

## Design system — read this before touching any UI

Octopush has a deliberate visual identity called **Atelier in Onyx & Brass**. The source of truth is:

- **Canonical spec:** [`docs/superpowers/specs/2026-05-16-octopus-ux-redesign-design.md`](docs/superpowers/specs/2026-05-16-octopus-ux-redesign-design.md) — full design, motion, rollout phases.
- **Quick reference:** [`docs/design-system.md`](docs/design-system.md) — tokens, type roles, signature patterns, copy-paste snippets.

If you're adding or modifying a frontend surface, **read at least the cheatsheet** before writing code. Pattern‑drift is the #1 way a redesign rots.

### Non‑negotiable design rules

1. **Use design tokens. Never hardcode colors, fonts, or spacing literals.** Tokens live as CSS variables (`var(--brass)`) and TypeScript constants (`tokens.brass` from `src/lib/tokens.ts` once it exists). If a token is missing, add it to both places — don't invent inline.
2. **Brass is quirurgical.** One accent, used for active states, eyebrow labels, signature details. Most of any screen is Onyx/Panel/Sage/Mute. If everything is brass, nothing is.
3. **Three type families, three voices:** Spectral italic serif for *moments* (display, key phrases, ceremonial CTAs); system sans for body; JetBrains Mono for meta and code. No fourth font.
4. **CTAs are italic‑serif phrases, not imperative labels.** `"Begin a new study"`, not `"+ Create Project"`. Each action has voice.
5. **Atelier layout is the law.** Rail (left) · ContextHeader · ModeSwitcher (Talk/Run/Review) · Canvas · Companion (right) · Input bar. Don't introduce new top-level chrome. Don't bring back tabs.
6. **No bouncing, no spring, no glitter.** Motion is calm. 220–320ms, `cubic‑bezier(0.2, 0.8, 0.3, 1)`. Brass rules *grow*; they don't *appear*. **Nothing appears or disappears abruptly:** overlay/dialog backdrops use `.octo-overlay-enter` and their dialogs use `.octo-modal-enter`; context menus use `.octo-menu-enter`; collapsible regions use the grid-rows `0fr↔1fr` idiom; tab/mode content crossfades with `.octo-fade-in`; status indicators reveal with `.octo-pop-in`; list rows with `.octo-rise-in`. Don't hand-roll one-off animations — reuse the primitives in `src/styles.css` (documented in `docs/design-system.md` §6). All motion respects `prefers-reduced-motion`. **For centered/top dialogs, use `<ModalShell>` (`src/components/ModalShell.tsx`)** — it bundles the canonical scrim, entrance motion, Escape, and optional click-outside; never hand-roll a dialog backdrop.
7. **No new colors without spec update.** If a feature needs a hue not in the palette, propose updating the spec first — don't slip new accents in via a PR.
8. **UI copy is English. Always. No exceptions.** Every visible string (labels, buttons, placeholders, helper text, empty states, error messages, aria-labels, tooltips, eyebrow text, modal titles) is English regardless of the developer's chat language. Mixing languages is a bug. The one exception is **user data** displayed verbatim from third-party APIs (e.g. Jira's `statusName` is whatever Jira returns in the user's account locale — we never translate it; if the user wants English statuses, they change their Jira profile language).

### Signature details and decorative retirement (2026-06-16; extended app-wide by the Direct beauty redesign, 2026-07-11)

> **Retired app-wide — not just for new surfaces:** the brass *rule* divider (28px gradient, `.animate-brass-grow`), `§` as a typographic mark, Roman numerals, the `✦` flourish, and `⟶` used as ornament or as the Direct run-track/Mission-Control connector glyph are **gone from the codebase**. There is no legacy allowance left for these five — `grep -rn "§ \|Roman numeral\|brass rule\|⟶" docs CLAUDE.md` should only surface retirement statements or the sanctioned-site list below. Any gradient used as a rule/divider/connector is banned outright; radial/mask washes (backgrounds, edge-fades) are unaffected.

**Structural glyphs — keep these (the only survivors):**
- **`⟜` in brass** — Direct/builder checkpoint gate. Renders on the gate card's own header, never on a connector line.
- **`⟲` in brass** — loop badge (`⟲ {iter}/{max}`) on a looping run-track card; the builder's review-loop edge pill (`⟲ ×N`).
- **`⟶`** — retired everywhere except three sanctioned structural sites: Composer's send-button glyph, `InlineTicketPicker`'s input prompt, `HunkRail`'s focus marker. Do not add a fourth.

**Active branding details:**
- **`&` in brass** — the ampersand is the one brass typographic accent (e.g. *"Onyx & Brass"*), used sparingly; it is also the Welcome-screen logomark (replacing the retired `§` mark). The *"Octopus & you"* tagline is **retired** (too consumer-y for a developer tool).
- **`StageDots` + the single beacon** — the new signature mechanics for anything that used to be a roman-numeral micro-track or a bespoke pulse: `StageDots` (`src/components/direct/StageDots.tsx`) is the universal 5px-dot micro-track (Direct canvas, launcher tickets, Companion, Mission Control, HistorySheet); `src/lib/beacon.ts`'s `beaconAnchor()` guarantees exactly one brass-pulsing element per attention scope (fleet scope = the longest-waiting needs-you card, FIFO). See `docs/design-system.md` §6/§8 for the full mechanics and the PRM (static-halo) fallback.
- **Arabic numerals** — every wizard and stage-position label now uses plain arabic (`STEP 1 OF 2`, `1 · 2`, `3 · sonnet · api`). No surface numbers steps in Roman.
- **Upright-serif phrases** — CTAs and placeholders use upright serif phrases (no italics anywhere; `em, i { font-style: normal }` enforced globally).

### Minimalism principles (binding)

These complement the design rules above and govern all new surfaces:

- **Theme-agnostic via tokens. Never hardcode.** Colors, fonts, and spacing go through `--color-octo-*` CSS variables and Tailwind token classes. No hex literals, no raw font strings outside `styles.css`.
- **No decorative flourishes, anywhere.** The brass rule divider, `⟶` as ornament (or as a connector glyph), `§`, Roman numerals, and `✦` are retired app-wide, not just for new surfaces — see above.
- **Icons over text where possible, with `title` tooltips.** Use a `lucide-react` icon + `title` attribute instead of a text label wherever the icon is unambiguous. Never ship an icon without a tooltip.
- **Smooth, token-driven transitions.** Every element that mounts/unmounts uses the motion primitives in `src/styles.css` (§6 of the cheatsheet). Do not hand-roll or mount abruptly.
- **Intuitive and professional.** Controls behave exactly as a developer expects. No surprising gestures, no undiscoverable interactions, no status requiring decoding.
- **Minimal visual noise.** Every element earns its place. No redundant labels, no nested borders, no decorative chrome that isn't functional.

---

## Code conventions

### Frontend (`src/`)

- Tailwind v4 with the `@theme` block in `src/styles.css`. Use Tailwind classes that reference theme tokens (`bg-octo-bg`, `text-octo-brass`, etc.) — these resolve to the CSS variables.
- State lives in Zustand stores under `src/stores/`. Don't introduce React Context or Redux for new features.
- IPC to Rust goes through `src/lib/ipc.ts`. Don't call `@tauri-apps/api` directly from components.
- Components are functional + hooks. No class components.

### Backend (`src-tauri/src/`)

- Commands exposed to the frontend live in `commands.rs` and are listed in `lib.rs`'s invoke handler.
- State is held in `state.rs` (Tauri-managed). Database access through `db.rs`.
- Errors propagate via `error.rs`'s `Result<T, AppError>` pattern.

### Tests

- Frontend: Vitest, files alongside source as `*.test.ts`. Run with `npm test`.
- Backend: built-in `#[test]` in `src-tauri/src/tests.rs`. Run with `cargo test` from `src-tauri/`.
- Always run `npm run typecheck` before claiming a frontend change is complete.

---

## Before you submit a frontend change — checklist

- [ ] Tokens, not literals. Grep your diff for hex colors (`#[0-9a-fA-F]{3,8}`) — should be empty.
- [ ] Fonts via tokens. No `font-family: ...` strings except in `styles.css` itself.
- [ ] CTAs written as phrases in italic serif where applicable.
- [ ] No new layout chrome that breaks the Atelier surface contract.
- [ ] No abrupt mount/unmount of overlays, menus, or panels — used the motion primitives (`.octo-modal-enter` / `.octo-menu-enter` / `.octo-fade-in` / grid-rows). Motion respects `prefers-reduced-motion`.
- [ ] If you added a visual pattern not in the spec/cheatsheet, either reuse an existing one or propose extending the design system first.
- [ ] **Updated [`docs/FEATURES.md`](docs/FEATURES.md)** if this change adds, removes, or alters any user-facing feature (backend or frontend).
- [ ] `npm run typecheck` passes.

---

## Useful commands

| Command                       | What it does |
|-------------------------------|--------------|
| `npm run dev`                 | Vite dev server (frontend only) |
| `npm run tauri:dev`           | Full Tauri app in dev mode |
| `npm run build`               | Typecheck + vite build |
| `npm run typecheck`           | TypeScript check only |
| `npm test`                    | Vitest |
| `cd src-tauri && cargo test`  | Rust tests |

---

## Memory & ongoing initiatives

- The full UX redesign (Atelier in Onyx & Brass) is being rolled out in 7 incremental phases. Phase 1 is "Foundations" (tokens + fonts + theme). See the spec for the rollout plan.
- The user prefers bold, distinctive choices over generic AI-tool aesthetics. Treat similarity to Cursor, Linear, Superset, etc. as a negative signal — Octopush should feel like itself.
