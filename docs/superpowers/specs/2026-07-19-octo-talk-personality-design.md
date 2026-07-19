# The Octo in TALK — the Watcher & the Player

**Date:** 2026-07-19 · **Status:** approved via live companion session (5 interactive prototypes) · **Builds on:** `2026-07-11-octopush-logo-brand-design.md`

## 1. Summary

The Octo becomes the protagonist of TALK mode in two acts:

1. **The Watcher** — in the Talk empty state, the octopus follows the user's mouse with its eyes and performs idle fidget gestures (look around, scratch its head, peek at the composer) while waiting for the first prompt.
2. **The Player** — once a turn is running, a **naked, stacked status figure** (octopus above, one-word label below) sits pinned bottom-center of the chat canvas, always visible regardless of journal scroll, and **acts out what is actually happening** — seven roles driven by real store signals. It replaces the two scroll-away indicators that exist today (inline `ThinkingIndicator` and the "Generating" mini-dot under the streaming bubble).

Companion decisions locked: naked (no box/border) over boxed; stacked layout (v5) over side-by-side centered (v1, octopus drifts with label width) and side-anchored (v4-B, rejected); full seven-role repertoire approved.

## 2. Shared foundation — `OctoRig`

Extract the mark's SVG internals into a low-level `OctoRig` component in `src/components/icons/OctoMark.tsx` (same file; exported): geometry only — back arms, body, four front-arm ellipses, eyes group (`.octo-m-eyes`), happy arcs — with `className` pass-throughs and an optional `eyesRef` (a ref to the eyes `<g>`). `OctoMark` keeps its exact public API and rendering (it becomes a thin wrapper over `OctoRig`); the Watcher and the Player compose `OctoRig` directly. No visual change anywhere the mark is already used.

## 3. The Watcher — Talk empty state

**Component:** `OctoWatcher` (`src/components/chat/OctoWatcher.tsx`). Replaces the current `<OctoMark size={28} state="idle">` in `ChatCanvas` `EmptyState`; rendered at **72px**, above the `Talk` eyebrow (rest of the empty state unchanged).

**Gaze engine** (rAF loop, in-component):
- `mousemove` listener on the chat canvas container (nearest positioned ancestor passed via ref/prop — not `document`), computing a vector from the mark's eye-center (42% height) to the cursor.
- Eye offset = `min(1, distance/240px) · 2.4` canonical units in the cursor's direction; applied as an SVG `transform` on the eyes group; lerp factor 0.14 per frame (calm inertia, never twitchy).
- Body keeps the standard idle CSS loop (float + staggered paddle + blink) — gaze only touches the eyes group, blink stays on the individual eyes (separate elements, no transform conflict).

**Fidget gestures** — after **15s without composer keystrokes**, run the next gesture in the cycle `look → scratch → peek`, then re-arm the timer. Any keystroke resets the timer. Gaze-follow suspends during a gesture and resumes after.
- **Look around** (JS eye targets): left (−2.4, 0) 700ms → right (+2.4, 0) 700ms → up-center 400ms.
- **Scratch head** (CSS class `octo-g-scratch`, 2.8s, one-shot): back-arm `b4` translates to the dome's top-right (−4, −31) and rubs three times (±3.5 unit oscillation); eyes squint (`scaleY 0.55`) and glance toward the arm (+1.8, −1.2).
- **Peek at the composer** (JS): eyes down (0, +2.6) 1100ms, back 300ms — the quiet "shall we write?" nudge.

**Reduced motion:** no gaze-follow, no gestures — the Watcher renders as the static idle pose (existing global neutralizer already freezes the body loops).

**Lifecycle:** the Watcher exists only while the thread is empty. On first send it unmounts (empty state disappears as today); the Player takes over.

## 4. The Player — pinned status while a turn runs

**Component:** `OctoStatus` (`src/components/chat/OctoStatus.tsx`), rendered by `ChatCanvas` as an absolutely-positioned overlay **bottom-center of the scroll container** (`bottom: 12px`), above the journal, below nothing — it never scrolls.

**Layout (v5, locked):** vertical stack, single shared axis: `OctoRig` at **22px** on top, label below (5px gap, serif 12px, `--color-octo-sage`, nowrap). Naked — no background, no border. Legibility comes from a **bottom exit wash** on the scroll container (`linear-gradient(transparent → --color-octo-bg)`, ~110px tall, `pointer-events: none`) — a surface wash, not a line; sanctioned. The journal's bottom padding grows to ~118px so no trace hides under the figure.

**Label changes** crossfade 220ms (`--ease-octo`); the octopus never moves — text grows symmetrically on the shared axis.

**The seven roles** — derived from real signals, priority top-down:

| Role | Signal | Body language (CSS class) |
|---|---|---|
| **Waiting for you** | pending approval request for this workspace | frozen, eyes half-mast; label in **brass** (`octo-mascot--wait` ≙ blocked pose) |
| **Reading…** | newest live tool ∈ {Read, LS, Glob, NotebookRead, …} | reading saccades: eyes sweep left→right, drop a line (`octo-m-readline`, 1.5s linear) |
| **Searching…** | newest live tool ∈ {Grep, Find, Search, WebSearch} | gaze darts corner to corner (`octo-m-darty`, 2.6s) |
| **Editing…** | newest live tool ∈ {Edit, Write, NotebookEdit} | typing arms (below), label says Editing |
| **Running…** | newest live tool ∈ {Bash, Terminal} | arms stop dead, eyes wide (`scale 1.18`), slow blink — watching the command |
| **Writing…** | `streamBuffer` non-empty (text flowing) | arms type: fast alternating taps (`octo-m-typy`, 0.46s, 4 offsets), eyes down (+1.9) |
| **Thinking…** | streaming, no buffer, no live tools | the existing `working` body: calm paddle + eye scan |

Unknown tools fall back to **Working…** with the Thinking body. Tool→role mapping lives in a pure exported function (`roleForActivity(...)` in `OctoStatus.tsx`) so it is unit-testable.

**Turn end:** when streaming flips off with no error, the figure plays the ✓ beat — happy-eye arcs for ~500ms — then fades out (`octo-fade-out`). On error it simply fades (the error block already speaks). Reduced motion: no beat, plain fade.

**Removals:** the inline `ThinkingIndicator` and the "Generating" pulsing-dot marker under the streaming bubble are deleted — `OctoStatus` is the single, always-visible activity voice of TALK. The in-bubble `▊` caret stays.

**New CSS** (styles.css, mascot section): keyframes `octo-m-typy`, `octo-m-readline`, `octo-m-darty` + role classes `octo-mascot--write/read/search/run` (think = existing working; wait = existing blocked). All inside the existing reduced-motion regime; amplitudes ≤ 2.4 units.

## 5. Out of scope

Top-bar mascot, Direct/Run surfaces, Welcome watcher (the welcome Octo stays plain idle), sounds, and any journal re-layout beyond bottom padding + wash.

## 6. Docs & tests

- `docs/FEATURES.md`: update Talk empty state entry (Watcher), replace the "Thinking… indicator" entry with the pinned Player (roles table), note removal of the Generating marker.
- `docs/design-system.md` mascot section: add the Watcher and the role repertoire.
- Tests (Vitest): `roleForActivity` mapping (each tool family, buffer, approval, fallback); `OctoStatus` renders the right class+label per props and swaps labels; Watcher gesture scheduler with fake timers (fires after 15s idle, resets on keystroke); existing suites stay green.
