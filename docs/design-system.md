# Octopus Design System — Cheatsheet

One‑page reference for **Atelier in Onyx & Brass**. For the full design, motion, and rollout, see [`superpowers/specs/2026-05-16-octopus-ux-redesign-design.md`](superpowers/specs/2026-05-16-octopus-ux-redesign-design.md).

---

## 1. Color tokens

```css
/* in src/styles.css → @theme block */
--color-octo-onyx:      #0c0a08;  /* app bg, warm black */
--color-octo-panel:     #14110d;  /* rail, header, companion */
--color-octo-panel-2:   #1a160f;  /* active input, hover */
--color-octo-hairline:  #2a2419;  /* 1px borders */
--color-octo-brass:     #d4a574;  /* THE accent */
--color-octo-brass-hi:  #e8c39a;  /* hover/pressed brass */
--color-octo-ivory:     #f4ecdb;  /* high-emphasis text */
--color-octo-sage:      #95897a;  /* body text */
--color-octo-mute:      #6d6354;  /* labels, meta */
--color-octo-verdigris: #8fc9a8;  /* success / diff adds */
--color-octo-rouge:     #d18b8b;  /* error / diff dels */
--color-octo-warning:   #dfae4a;  /* amber — warning/caution, never the accent */
```

**Alpha utilities:**
- `--brass-dim:   rgba(212, 165, 116, 0.4)` — borders on active fills
- `--brass-ghost: rgba(212, 165, 116, 0.08)` — subtle active backgrounds

**Surgical brass rule:** in any screen, brass should occupy ≤ 5% of pixels. If you're using brass on more than 2–3 elements at once, you're using it too much.

---

## 2. Typography

```css
--font-serif: "Spectral", "Iowan Old Style", "Times New Roman", serif;
--font-sans:  -apple-system, "Helvetica Neue", sans-serif;
--font-mono:  "JetBrains Mono", "SF Mono", monospace;
```

| Role          | Family | Size | Weight | Style  | Tracking |
|---------------|--------|------|--------|--------|----------|
| Display       | Serif  | 28px | 400    | italic | −0.01em  |
| H1 Page       | Serif  | 22px | 400    | italic | −0.005em |
| H2 Section    | Sans   | 16px | 600    | normal | −0.005em |
| Body          | Sans   | 13px | 400    | normal | normal   |
| Small / Meta  | Sans   | 11px | 400    | normal | normal   |
| Eyebrow       | Mono   | 10px | 400    | upper  | 0.25em   |
| Code / Mono   | Mono   | 12px | 400    | normal | normal   |

**Where each voice goes:**
- **Spectral italic** — display, "the key phrase" of model responses, ceremonial CTAs, input placeholders.
- **Sans** — bulk reading text, settings, body of messages.
- **Mono** — eyebrows (`— Claude`, `WORKSPACE`), code, kbd, file paths, terminal.

---

## 3. Spacing · Radii · Borders

- **Spacing scale (base 4):** `4 · 8 · 12 · 16 · 24 · 32 · 48`. Default gaps: 12 / 16 / 24. Premium breath: 24 / 32.
- **Radii:** `sm: 6px` (buttons, pills), `md: 10px` (panels, inputs), `lg: 14px` (large canvases). **No pill-shaped controls by default.**
- **Hairline:** 1px in `--hairline`. Brass hairline: 1px in `--brass-dim` for active borders.
- **Brass rule:** 28px gradient `linear-gradient(90deg, var(--brass), transparent)` — the signature divider for moments. **RETIRED for new surfaces (2026-06-16).** Existing uses in legacy surfaces remain; do not add this pattern to any new UI. Use `--hairline` borders or spacing for visual separation instead.

---

## 4. Component recipes (copy‑paste)

### Primary CTA — ceremonial
```tsx
<button className="rounded-lg border border-octo-brass-dim bg-octo-brass-ghost
                   px-4 py-2 font-serif italic text-octo-brass text-sm">
  Begin a new study
</button>
```

### Ghost button — default action
```tsx
<button className="rounded-lg border border-octo-hairline px-3 py-2 text-sm
                   text-octo-sage hover:text-octo-ivory">
  Cancel
</button>
```

### Eyebrow label
```tsx
<span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
  — Claude
</span>
```

### Key phrase (model response lead sentence)
```tsx
<p className="font-serif italic text-[22px] leading-[1.15] tracking-[-0.005em] text-octo-ivory">
  Because <code className="font-mono not-italic text-octo-brass">skipRefreshCheck</code> is true.
</p>
```

### Tool call card
```tsx
<div className="border-l border-octo-brass-dim bg-octo-brass-ghost
                rounded-r-md px-3 py-2 flex items-center gap-3">
  <span className="font-mono text-[9px] tracking-[0.2em] uppercase text-octo-brass">
    § READ
  </span>
  <span className="font-mono text-[11px] text-octo-sage ml-auto">
    auth/middleware.ts
  </span>
</div>
```

### Input with italic-serif placeholder
```tsx
<input
  className="border border-octo-hairline rounded-lg px-3 py-2 bg-octo-onyx
             text-octo-ivory focus:border-octo-brass-dim
             placeholder:font-serif placeholder:italic placeholder:text-octo-mute"
  placeholder="Ask Octopus anything…"
/>
```

### Brass rule (animated reveal)
```tsx
<div
  className="h-px bg-gradient-to-r from-octo-brass to-transparent
             animate-[brassgrow_600ms_cubic-bezier(.2,.8,.3,1)_forwards]"
  style={{ width: 28 }}
/>
```

```css
@keyframes brassgrow { from { width: 0 } to { width: 28px } }
```

---

## 5. Signature details — structural glyphs and active patterns

> **Decorative flourish retirement (2026-06-16):** The brass *rule* divider (§3), the `⟶` glyph used as **ornament** (prompt decoration, input nudges, button accents), and the `✦` flourish are **retired for all new surfaces**. Do not introduce them in new components. See §9 (Minimalism doctrine) for the replacement principles. What remains of `⟶` is its **structural/functional** role in Direct mode (see below) — that is not retired.

| Detail        | Status | Where to use                                                        |
|---------------|--------|---------------------------------------------------------------------|
| `&` in brass  | Active | One brass typographic accent (e.g. "Onyx & Brass"), used sparingly  |
| `⟶` in brass — **structural only** | Active (structural); **RETIRED as ornament** | **KEEP:** Direct run-track stage connector; Direct checkpoint gate flow. **DO NOT add** as prompt glyph, input nudge, or button decoration on any new surface. |
| `⟜` in brass | Active | Direct run-track checkpoint gate — pauses the pipeline for human approval |
| `§` in brass  | Active | Tool call cards — `§ READ`, `§ WRITE`, `§ RUN`; Direct focus-pane role headers — `§ PLANNER`, `§ IMPLEMENTER`. This prefix is structural; do not retire it. |
| Roman numerals| Active | Multi-step wizards: `STEP I · OF II`, `I.`, `II.`, etc.; Direct run-track stage numbers |
| Italic phrases| Active — **upright only** | CTAs and placeholders use upright serif phrases (italics banned app-wide; see §9) |
| `⟳` in **amber** (`--color-octo-warning`) | Active | Direct mode transient halt — awaits **Resume**. Amber = caution, never brass. |
| Substrate pills | Active | Direct mode only — `API` in `--color-octo-state-blue`, `CLI` in `--color-octo-state-purple` |
| `✦` flourish  | **RETIRED** | Never use. Not in any existing surface; do not introduce. |

---

## 6. Motion

```css
--ease-octo:    cubic-bezier(0.2, 0.8, 0.3, 1);
--dur-quick:    220ms;
--dur-standard: 280ms;
--dur-slow:     320ms;
--dur-reveal:   600ms;   /* brass rule grow */
```

| Use case                  | Duration / easing                            |
|---------------------------|----------------------------------------------|
| Key phrase fade-in        | 280ms ease-out, staggered (eyebrow → key → body → tool) |
| Mode glide (Talk/Run/Review) | 320ms ease-in-out                         |
| Brass rule reveal         | 600ms cubic-bezier(.2,.8,.3,1)               |
| Workspace switch          | 260ms ease-in-out                            |
| Hover lift                | 180ms ease-out, `translateY(-1px)`           |

**Forbidden:** spring physics, bouncing, confetti, jittering icons, scale > 1.05, rotation animations.

### Reusable entrance primitives (use these — don't hand-roll)

| Class | Use for | Built from |
|-------|---------|------------|
| `.octo-overlay-enter` | modal/dialog backdrops (scrim fade) | fade · --dur-quick |
| `.octo-modal-enter` | dialogs, popovers, sheets | fade+scale 0.97→1 · --dur-standard |
| `.octo-menu-enter` | context menus | fade+scale 0.97→1 · --dur-quick |
| `.octo-fade-in` | tab/mode content crossfade | fade · --dur-quick |
| `.octo-pop-in` | status dots / small badges appearing | fade+scale · --dur-quick |
| `.octo-rise-in` | list rows appearing | fade+rise 4px · --dur-standard |
| `<FadeSwap swapKey>` | mutually exclusive view swaps (canvas states, pane modes) | exit fade 120ms → `.octo-fade-in` (`src/components/primitives/FadeSwap.tsx`) |
| `<Reveal open>` | expanding/collapsing regions (decision strips, sub-panels) | grid-rows 0fr↔1fr · --dur-standard (`src/components/primitives/Reveal.tsx`) |
| `.octo-tabular` | every live numeric value (cost, %, mm:ss, counters) | `font-variant-numeric: tabular-nums` |
| `.octo-sweep` | one-shot brass rule sweep (Direct run-completion moment only) | width 0→100% · --dur-reveal |

### Stability doctrine (binding for live surfaces; born in Direct)

- **S1 — Fixed-slot live text.** Text that changes while something runs lives in a fixed-height truncating slot that exists in every state — content changes never resize the container.
- **S2 — Tabular numerals.** Every live numeric value uses `.octo-tabular`; timers get a `ch`-based fixed width.
- **S3 — No abrupt subtree swaps.** Mutually exclusive views transition through `<FadeSwap>`.
- **S4 — Height changes are animated.** Anything that expands/collapses goes through `<Reveal>`.
- **S5 — No motion on live tickers.** Streaming values update in place; motion is reserved for state *transitions*.
- **S6 — Smooth, calm scrolling.** Autoscroll uses `scrollTo({behavior:"smooth"})`; entries enter with `.octo-rise-in`.

Collapsible regions use the **grid-rows `0fr↔1fr`** idiom (see `WorkContextPanel`, the rail project collapse, the Recently-closed drawer). All entrance/collapse motion respects `prefers-reduced-motion`.

**Centered/top dialogs → use `<ModalShell>` (`src/components/ModalShell.tsx`).** Don't hand-roll a backdrop. It bundles the canonical scrim (`bg-octo-onyx/80`), `.octo-overlay-enter` + `.octo-modal-enter`, Escape-to-close, optional click-outside (`closeOnBackdrop` — set `false` for confirm/alert dialogs), and `align="top"` for command palettes. Pass only the panel content as children. Left-anchored popovers (e.g. the rail customizer menus) are NOT dialogs — they keep their lightweight anchored backdrop.

---

## 7. Common mistakes — DO NOT

- ❌ `text-violet-400` or any Tailwind palette color from outside the `--color-octo-*` namespace.
- ❌ Hardcoded hex (`#a78bfa`, `bg-[#101013]`). Tokens or nothing.
- ❌ `text-2xl font-bold` for a "page title" — use the upright `font-serif` H1 spec (italics are retired, see §9).
- ❌ `"+ New Project"` CTA — phrase CTAs are upright serif (`"Begin a new study"`), **never italic**; in compact chrome (panel headers) prefer the canonical icon button (§9) over a text CTA.
- ❌ Adding a new tab system anywhere.
- ❌ A 4th font. A 12th color. A new accent. (Update the spec instead.)
- ❌ `transition: all` — be specific about what's animated.
- ❌ Icons from outside `lucide-react` (we standardized).
- ❌ Italics anywhere — buttons especially. `em, i { font-style: normal }` in styles.css enforces it; don't write `italic` classes that depend on the override.
- ❌ Status/severity in brass. Brass marks *the active thing*; danger is rouge, caution is warning, quiet is mute.

---

## 9. Minimalism doctrine (2026-06-10; extended 2026-06-16)

Binding norm: **reduce visual noise; give a sense of control and cleanliness — without losing features.** Simplify presentation, never capability. Octopush must feel professional and intentional — not like a generic AI tool.

- **Theme-agnostic via design tokens. Never hardcode.** All colors, fonts, and spacing go through `--color-octo-*` CSS variables and Tailwind token classes. A component that hardcodes a hex value, a font string, or a pixel color is a bug. When a token is missing, add it to `src/styles.css` (and `src/lib/tokens.ts` when it exists) — never inline it.
- **Zero italics, buttons especially.** Upright serif phrases are allowed for *moments*; controls never slant. `em, i { font-style: normal }` in `styles.css` enforces this globally.
- **No decorative flourishes on new surfaces.** The brass *rule* divider, the `⟶` glyph used as ornament, and the `✦` character are retired (2026-06-16). Existing uses in legacy surfaces may remain; do not add to new components. Structural/functional glyphs (`⟶` as Direct run-track connector, `⟜` checkpoint gate, `§` tool-call prefix) are explicitly preserved — see §5.
- **Every element earns its place.** A state shown by a colored dot does not also get a text label (the dot gets a `title`). A count visible in a list is not repeated in its header. A percentage encoded by a bar's width is not printed next to it.
- **One canonical chrome per concept.** Section header = the eyebrow bar (`flex h-11 shrink-0 items-center justify-between border-b border-octo-hairline px-4 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass`). Quiet action = the icon button (`flex items-center justify-center rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass`, 12px lucide icon, always with `title`). Don't invent a third.
- **Icons over text where an icon + `title` tooltip says the same.** Prefer a `lucide-react` icon with a `title` attribute over a text label for any action where the icon is unambiguous in context. Truncated or elided text always carries `title`. Never ship an icon without a tooltip.
- **Smooth, token-driven enter/exit transitions.** Every element that appears or disappears uses the motion primitives in §6 (`.octo-modal-enter`, `.octo-menu-enter`, `.octo-fade-in`, `<Reveal>`, `<FadeSwap>`, `.octo-rise-in`). Do not hand-roll transitions; do not mount/unmount abruptly.
- **Boxes don't nest.** No border-inside-border-inside-border; if a container is already bounded, its children don't bring their own frame.
- **Nothing appears or disappears abruptly.** Mode/state swaps use `FadeSwap`; rows enter with `octo-rise-in`; collapses use grid-rows; async content prefers stale-while-revalidate over blank-and-reload. Reserve layout slots (border/glyph widths) so state changes never shift content.
- **Progressive disclosure over removal.** Secondary panels may default collapsed (persist the user's choice); features stay one click away.
- **Intuitive, not clever.** UI should be self-evident. Controls behave exactly as a professional developer expects. Avoid surprising interactions, undiscoverable gestures, or status that requires decoding.

---

## 8. Atelier layout grammar

```
┌────┬─────────────────────────────────┬───────────────────┐
│    │ ContextHeader        Modes      │                   │
│ R  │                                 │                   │
│ a  │   Canvas                        │   Companion       │
│ i  │   (Talk | Run | Review)         │   (per-mode)      │
│ l  │                                 │                   │
│    │   Input bar                     │                   │
└────┴─────────────────────────────────┴───────────────────┘
```

| Surface       | Width | Notes |
|---------------|-------|-------|
| Rail          | 48px  | Workspace monograms (italic serif, brass on active), brass vertical indicator. |
| ContextHeader | flex  | Floating card. Workspace name in italic serif + branch in mono. |
| ModeSwitcher  | auto  | Top right. Brass-ghost pill on active mode, brass indicator glides. Four modes: Talk / Run / Review / Direct. |
| Canvas        | flex  | Active mode content (chat / terminal / diff / pipeline track+focus pane). |
| Companion     | 280px | Per-mode panels: Context+History · Terminals+Quick · Changed+commit · Runs+Jira. |
| Input bar     | flex  | Italic-serif placeholder, ⌘K kbd hint. |

**Mode canvases at a glance:**
- **Talk** — chat timeline. Companion: Context + History.
- **Run** — terminal card. Companion: Terminals + Quick.
- **Review** — unified diff. Companion: Changed + commit.
- **Direct** — horizontal assembly-line track + focus pane. Companion: Runs + Jira. The 4th mode is per-workspace and optional; the trinity is always present.

Don't add chrome outside these surfaces. If a feature needs something new, propose extending the grammar in the spec — don't add it ad-hoc.

### Direct mode — canvas patterns

Direct introduces a set of new visual patterns. Use them only in Direct mode; don't migrate them into other surfaces.

**Substrate pills** — identify the execution substrate of each pipeline stage.

| Pill label | Color token | Use |
|------------|-------------|-----|
| `API`      | `--color-octo-state-blue` | Stage runs via the Claude API directly |
| `CLI`      | `--color-octo-state-purple` | Stage runs via Claude Code CLI in the worktree |

Pills share the same geometry as the existing status pills (mono uppercase, `sm` radius, fixed width, dot icon omitted here — substrate is the identity). Never use these two colors outside Direct mode substrate pills.

**Provider dot tokens** — `--provider-anthropic / -openai / -deepseek / -ollama` exist for the decorative identity dots in the ModelPicker (and Direct surfaces that embed it). Decorative only; never for text or borders.

**Atelier form controls** (`src/components/controls/`) — `SegmentedControl`, `TogglePill`, `Stepper`, `Listbox` (portal + fixed positioning), `IconButton`. Direct surfaces never use native `<select>`, checkboxes, or number spinners; new form UI should reach for these first.

**Run track** — the horizontal stage list across the canvas top.

- Each stage is a **fixed-geometry card** (S1): roman numeral + status glyph + status word, role in serif, model + substrate pill, and one reserved live line that shows activity (running), verdict (done), or cost (idle) — geometry never changes while a run executes.
- Stages connect left-to-right with `⟶` in brass (connector) or `⟜` in brass (checkpoint gate — pauses for human approval). Connectors render at 40% opacity until the stage on their left is done — progress visibly fills the line.
- A running stage pulses (`octo-stage-pulse`) with a verdigris dot and a `5ch` tabular timer. Done = verdigris `✓`. Failed = rouge accent.
- The track scrolls horizontally when stages overflow the canvas width; the focus pane below is always visible.

**Focus pane** — the lower half of the Direct canvas.

- Shows the selected stage's artifact: a markdown plan, a code diff, or a test result.
- Header: `§ ROLE` (e.g., `§ PLANNER`, `§ IMPLEMENTER`) in brass mono — the same `§` signature as tool call cards.
- For code stages, the worktree diff is embedded beneath the artifact using the same diff styling as Review mode (`--verdigris` adds / `--rouge` dels).

**Checkpoint decision strip** — docked at the canvas bottom when the run pauses at a `⟜` gate; it *unfolds* through `<Reveal>` and folds away on resolve (never mounts abruptly).

- Button hierarchy (surgical brass): **Approve & continue** is the only solid-brass button; **Send back to {role} ⟜** is brass-outlined serif; Reject/Re-run and Abort are ghost (Abort gets a rouge hover). Serif phrases stay upright.
- The loop meter (`review loop · 2 of 3 used`) renders in a fixed slot with tabular numerals and turns brass at the cap.
- A failed stage swaps the accent to rouge with a `✕ stage halted` eyebrow.

**Ledger strip** (cost meter) — a single calm line at the canvas bottom, **savings-first** (the differentiator leads).

- Format: `saved $0.089 · 86% under all-premium  ·  spent $0.014` — verdigris saved value, brass spent value, mute labels, all `.octo-tabular`. No baseline ⇒ `baseline unavailable` (the slot never disappears).
- A 2px progress inset beneath (brass fill = cost as % of baseline) glides with `--dur-standard`; clicking the strip unfolds the per-stage breakdown via `<Reveal>`.
- **Completion moment:** when a run completes, a one-shot brass sweep (`.octo-sweep`) crosses the strip and a serif phrase restates the savings. The one ceremony in Direct; failed/aborted runs get none.

### Status bar (bottom)

A single full-width strip at the very bottom of the window (~22px), beneath
both the rail and the main column. It is the one sanctioned piece of bottom
chrome. Rules:

- `bg-octo-panel`, top `border-octo-hairline`, JetBrains Mono `text-[11px]`.
- Labels in `text-octo-mute`/`text-octo-sage`; live values in `text-octo-brass`.
- Calm: no motion, no spring. It informs, it doesn't perform.
- Current resident: the performance monitor (RAM + CPU). Future bottom-bar
  content must keep this quiet, single-line character.
