# Octopus · AI assistant guidelines

This file is read automatically by Claude Code (and is mirrored in `AGENTS.md` for other AI tools). It captures the non-negotiable rules for working in this repo.

**Octopus** is a Tauri 2 desktop app (React 19 + TypeScript frontend, Rust backend) — "The IDE for Agentic Developers". Workspaces are git worktrees. The backend lives in `src-tauri/src/`, the frontend in `src/`.

---

## Design system — read this before touching any UI

Octopus has a deliberate visual identity called **Atelier in Onyx & Brass**. The source of truth is:

- **Canonical spec:** [`docs/superpowers/specs/2026-05-16-octopus-ux-redesign-design.md`](docs/superpowers/specs/2026-05-16-octopus-ux-redesign-design.md) — full design, motion, rollout phases.
- **Quick reference:** [`docs/design-system.md`](docs/design-system.md) — tokens, type roles, signature patterns, copy-paste snippets.

If you're adding or modifying a frontend surface, **read at least the cheatsheet** before writing code. Pattern‑drift is the #1 way a redesign rots.

### Non‑negotiable design rules

1. **Use design tokens. Never hardcode colors, fonts, or spacing literals.** Tokens live as CSS variables (`var(--brass)`) and TypeScript constants (`tokens.brass` from `src/lib/tokens.ts` once it exists). If a token is missing, add it to both places — don't invent inline.
2. **Brass is quirurgical.** One accent, used for active states, eyebrow labels, signature details. Most of any screen is Onyx/Panel/Sage/Mute. If everything is brass, nothing is.
3. **Three type families, three voices:** Spectral italic serif for *moments* (display, key phrases, ceremonial CTAs); system sans for body; JetBrains Mono for meta and code. No fourth font.
4. **CTAs are italic‑serif phrases, not imperative labels.** `"Begin a new study"`, not `"+ Create Project"`. Each action has voice.
5. **Atelier layout is the law.** Rail (left) · ContextHeader · ModeSwitcher (Talk/Run/Review) · Canvas · Companion (right) · Input bar. Don't introduce new top-level chrome. Don't bring back tabs.
6. **No bouncing, no spring, no glitter.** Motion is calm. 220–320ms, `cubic‑bezier(0.2, 0.8, 0.3, 1)`. Brass rules *grow*; they don't *appear*.
7. **No new colors without spec update.** If a feature needs a hue not in the palette, propose updating the spec first — don't slip new accents in via a PR.

### Five signature details — preserve these always

- **`&` in brass** — "Octopus & you" branding. The ampersand alone is brass.
- **`⟶` in brass** — the prompt glyph everywhere (terminal, palette, input nudges).
- **`§` in brass** — every tool call card is prefixed with `§ TOOL_NAME`.
- **Roman numerals** — multi-step wizards use `I · II · III` in brass mono.
- **Italic-serif placeholders** — input placeholders are phrases in Spectral italic.

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
- [ ] If you added a visual pattern not in the spec/cheatsheet, either reuse an existing one or propose extending the design system first.
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
- The user prefers bold, distinctive choices over generic AI-tool aesthetics. Treat similarity to Cursor, Linear, Superset, etc. as a negative signal — Octopus should feel like itself.
