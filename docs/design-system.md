# Octopush Design System — Cheatsheet

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
- `--brass-line:  rgba(212, 165, 116, 0.55)` — solid traversed/active connector ink (Direct run-track, builder review-loop edges). Lines are drawn solid or hairline — never a gradient.
- `--brass-quiet: rgba(212, 165, 116, 0.22)` — reserved for a quieter "done, long settled" dot shade (`StageDots`); not yet wired into a consumer as of the fleet redesign.

**Surgical brass norm:** in any screen, brass should occupy ≤ 5% of pixels. If you're using brass on more than 2–3 elements at once, you're using it too much. (Not to be confused with the "brass rule" divider component, which is fully retired — see §3.)

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
- **Brass rule: fully deleted (2026-07-11).** The 28px gradient divider (`linear-gradient(90deg, var(--brass), transparent)`), `.animate-brass-grow`, and `@keyframes brassgrow` are **removed from the codebase**, not just retired-for-new-surfaces — there is no legacy allowance left; `grep -rn "linear-gradient" src` returns only non-divider uses (a repeating-stripe running-bar texture, a scrim fade behind tool output, and `mask-image` edge-fades — none of them a rule/line). Use `--hairline` borders or spacing for visual separation; use the solid `--brass-line` token where an *active* connector is needed (see §6, §8).

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
  <span className="flex items-center gap-1.5 font-mono text-[9px] tracking-[0.2em] uppercase text-octo-brass">
    <Eye size={12} strokeWidth={1.75} title="Read" /> READ
  </span>
  <span className="font-mono text-[11px] text-octo-sage ml-auto">
    auth/middleware.ts
  </span>
</div>
```
The `§` prefix is retired — the tool identity is a `lucide-react` icon from `src/lib/roleIcons.ts` (`iconForTool`), always with a `title`. Same recipe for Direct focus-pane journal lines and role eyebrows (`iconForRole`).

### Input with italic-serif placeholder
```tsx
<input
  className="border border-octo-hairline rounded-lg px-3 py-2 bg-octo-onyx
             text-octo-ivory focus:border-octo-brass-dim
             placeholder:font-serif placeholder:italic placeholder:text-octo-mute"
  placeholder="Ask Octopush anything…"
/>
```

### Solid connector line (traversed vs. pending)
```tsx
<span
  className={`h-px w-7 transition-colors duration-[280ms] ${
    traversed ? "bg-[var(--brass-line)]" : "bg-octo-hairline"
  }`}
/>
```
This replaces the retired brass-rule/gradient recipe everywhere a "flow has passed through here" signal is needed (Direct run-track, builder review-loop edges). No gradient, no grow animation — the color itself is the state; width transitions on the connector's own color property.

---

## 5. Signature details — structural glyphs and active patterns

> **Decorative flourish retirement (2026-06-16), extended by the Direct beauty redesign (2026-07-11):** the brass *rule* divider, the `✦` flourish, `§` as a typographic mark, and Roman numerals are **gone app-wide** — not just retired-for-new-surfaces. `⟶` is retired as both ornament *and* as the Direct run-track/Mission-Control connector glyph; it survives only at three sanctioned structural sites (below). See §9 (Minimalism doctrine) for the replacement principles.

| Detail        | Status | Where to use                                                        |
|---------------|--------|---------------------------------------------------------------------|
| `&` in brass  | Active | One brass typographic accent (e.g. "Onyx & Brass") — typographic only; the product mark is **The Octo** (see "The Octo — mark & mascot" below), which replaced the interim `&` Welcome logomark |
| `⟜` in brass — structural | Active | Direct run-track / builder checkpoint gate — pauses the pipeline for human approval. Renders on the gate card's own header, not on a connector line. |
| `⟲` in brass — structural | Active | Loop badge (`⟲ {iter}/{max}`) on a looping run-track card, and the builder's review-loop edge pill. |
| `§`           | **RETIRED (app-wide, 2026-07-11)** | Was: tool call cards (`§ READ`), Direct focus-pane role headers (`§ PLANNER`), the Welcome logomark, Markdown export tool headings, the Composer/SlashMenu skill chip, the CommandPalette settings glyph, `@path` mention fences, EditorBinaryPane. All replaced by a `lucide-react` icon (`src/lib/roleIcons.ts` `iconForRole`/`iconForTool`, or a one-off like `FileWarning`/`Slash`) with a `title`, or dropped outright where the surrounding fence/label already carried the meaning. `grep -rn "§ " src` should only match doc comments citing a spec section number (`§4.1`), never a rendered string. |
| Roman numerals | **RETIRED (app-wide, 2026-07-11)** | Was: multi-step wizards (`I · II`), Direct run-track stage numbers, Mission Control's micro-track. All wizards (`NewProjectFlow`, `WorkspaceCreator`, `AddProviderDialog`) now render plain arabic (`STEP 1 OF 2`, `1 · 2`); run-track/Mission-Control position numbers are arabic in the mono meta line (`3 · sonnet · api`); the miniature run shape is `StageDots` (below), not numerals at all. |
| `⟶`           | **RETIRED as ornament and as the Direct connector/Mission-Control micro-track glyph.** Sanctioned structural survivors (exactly three, nowhere else): Composer's send-button glyph, `InlineTicketPicker`'s input prompt, `HunkRail`'s focus marker. | Do not add anywhere else. Flow between stages is now drawn as a **solid 1px line** (`--brass-line` traversed / `--hairline` pending) — see §6, §8. |
| Gradient lines | **BANNED — solid ink only.** Any `linear-gradient` used *as a rule, divider, or connector* is forbidden, full stop (not just "retired for new surfaces"). `.animate-brass-grow`/`@keyframes brassgrow` are deleted; the completion sweep (`.octo-sweep`) is a solid brass line, not a gradient streak. Radial/mask washes (`OverlayRoom`, `WelcomeScreen` background, `WorkContextPanel` edge-fades) are surfaces, not lines — untouched. | n/a |
| `StageDots` + the single beacon | **Active — the new signature mechanics.** `StageDots` (`src/components/direct/StageDots.tsx`) is the universal micro-track (5px dots, one per stage) replacing every bespoke shape line and the roman-numeral track. Exactly one brass-pulsing element per attention scope at a time (`lib/beacon.ts`'s `beaconAnchor`; fleet scope = the longest-waiting needs-you card, FIFO by `statusSince`) — see §6. | Launcher tickets, Companion, Mission Control. |
| Italic phrases| Active — **upright only** | CTAs and placeholders use upright serif phrases (italics banned app-wide; see §9) |
| `⟳` in **amber** (`--color-octo-warning`) | Active | Direct mode transient halt — awaits **Resume**. Amber = caution, never brass. |
| Substrate pills | Active | Direct mode only — `API` in `--color-octo-state-blue`, `CLI` in `--color-octo-state-purple` |
| `✦` flourish  | **RETIRED** | Never use. Not in any existing surface; do not introduce. |

---

## The Octo — mark & mascot

The brand mark is **The Octo**: a solid-brass octopus creature (dome head, two
negative-space eyes, four front arms, four muted back arms) defined canonically
in `src/components/icons/OctoMark.tsx` (`viewBox 0 0 64 66`). Spec:
`docs/superpowers/specs/2026-07-11-octopush-logo-brand-design.md`.

- **Colors:** body `--color-octo-brass`, back arms `--brass-line`, eyes
  `--octo-eye` (defaults to `--color-octo-bg`). Never recolor, add gradients,
  outline, rotate, or drop the eyes.
- **Adaptive detail:** below 20px the back-arm row is dropped automatically.
- **States** (`<OctoMark state=…>`): `static` (icon placements), `idle`
  (floats/paddles/blinks), `working` (double tempo + eye scan), `pushed`
  (one-shot rise + brass halo, happy eyes), `blocked` (freezes, eyes at
  half-mast — stillness is the signal). All motion ≤2.5px, reduced-motion safe
  (`octo-m-*` keyframes, §6).
- **Placements:** app icon (`src-tauri/icons/source.svg`), Welcome hero (idle),
  top-bar live mascot (`useMascotState`: blocked > working > idle), Project
  empty state (idle), run-ledger completion moment (pushed),
  Settings/About/legacy-sidebar (static), dev favicon.
- **TALK-only behaviors:** the empty-state **Watcher** (gaze-follow ±2.4u + fidget cycle
  look/scratch/peek after 15s idle — `chat/OctoWatcher.tsx`) and the pinned **Player**
  (`chat/OctoStatus.tsx`): role classes `octo-mascot--write/read/search/run` +
  `octo-mascot--pushed-beat`, driven by `roleForActivity`. Keep new roles to eye/arm
  tempo changes on the same six rig pieces — never add elements to the rig.
- **Wordmark:** "Octopush" in Fraunces via `.brand-wordmark` — brand surfaces
  only (welcome, settings header, about). Spectral remains the UI serif; body,
  sans, and mono roles are unchanged.
- The `§` glyph and the interim `&` logomark are fully retired as logos.

---

## 6. Motion

```css
--ease-octo:    cubic-bezier(0.2, 0.8, 0.3, 1);
--dur-quick:    220ms;
--dur-standard: 280ms;
--dur-slow:     320ms;
--dur-reveal:   600ms;   /* one-shot ceremonies: completion sweep, etc. */
--stagger-step: 45ms;    /* shared list-entrance stagger step (RunFlow, StageFlow cards) */
```

| Use case                  | Duration / easing                            |
|---------------------------|----------------------------------------------|
| Key phrase fade-in        | 280ms ease-out, staggered (eyebrow → key → body → tool) |
| Mode glide (Talk/Run/Review) | 320ms ease-in-out                         |
| Completion sweep (`.octo-sweep`) | 600ms cubic-bezier(.2,.8,.3,1) — solid brass line, no gradient |
| Workspace switch          | 260ms ease-in-out                            |
| Hover lift                | 180ms ease-out, `translateY(-1px)`           |
| Depth-of-field opacity (essence↔hover, band ink) | 180ms ease-out (`duration-[180ms]`) |

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
| `.octo-sweep` | one-shot **solid** brass line sweep (Direct run-completion moment only; no gradient) | width 0→100% · --dur-reveal |

### Stability doctrine (binding for live surfaces; born in Direct)

- **S1 — Fixed-slot live text.** Text that changes while something runs lives in a fixed-height truncating slot that exists in every state — content changes never resize the container.
- **S2 — Tabular numerals.** Every live numeric value uses `.octo-tabular`; timers get a `ch`-based fixed width.
- **S3 — No abrupt subtree swaps.** Mutually exclusive views transition through `<FadeSwap>`.
- **S4 — Height changes are animated.** Anything that expands/collapses goes through `<Reveal>`.
- **S5 — No motion on live tickers.** Streaming values update in place; motion is reserved for state *transitions*.
- **S6 — Smooth, calm scrolling.** Autoscroll uses `scrollTo({behavior:"smooth"})`; entries enter with `.octo-rise-in`.

Collapsible regions use the **grid-rows `0fr↔1fr`** idiom (see `WorkContextPanel`, the rail project collapse, the Recently-closed drawer). All entrance/collapse motion respects `prefers-reduced-motion`.

### The single beacon (Direct beauty redesign, binding for live surfaces)

At any moment there is **exactly one** brass-accented *live* element per attention scope — never two pulses at once. `src/lib/beacon.ts`'s `beaconAnchor()` is the pure priority selector (decision strip CTA → running stage card → ready launcher CTA → calm/`null`); components only ask "am I the anchor?" via the id it returns. Fleet scope (Mission Control / the `RunsTray` chip) has its own rule: only the **longest-waiting** needs-you card pulses (FIFO by `statusSince`), and the top-bar chip pulses only when at least one run needs the director.

- The pulse itself is `.octo-stage-pulse` — a 2.4s looping `box-shadow` keyframe (`0%,100% → 0 0 0 0 transparent`, `50% → 0 0 0 3px var(--brass-ghost)`), never `infinite`-scaling or springy.
- **Under `prefers-reduced-motion`:** the pulse animation is disabled and replaced with a **static halo** — a permanent `0 0 0 1px var(--brass-dim)` box-shadow — so the anchor is still legible without motion.
- PRM handling lives at the CSS layer (the class's own `@media (prefers-reduced-motion: reduce)` block), not in `beacon.ts` — the selector is presentation-agnostic; only the visual expression of "this is the anchor" changes under PRM.

### Entrance keyframes are from-only — do not add a `to{}` block

`octo-enter-fade` / `octo-enter-pop` / `octo-enter-rise` (backing `.octo-fade-in` / `.octo-pop-in` / `.octo-rise-in` / `.octo-overlay-enter` / `.octo-modal-enter` / `.octo-menu-enter`) declare **only a `from{}` block** — no `to{}`. This is a fixed bug, not a stylistic choice: a `to{}` block combined with `animation-fill-mode: both` pins the element's opacity/transform at the animation's end state *forever*, silently overriding whatever utility opacity the element should settle into (e.g. an essence card's `opacity-[0.38]` or a settled row's `opacity-45`) — the depth-of-field dimming never actually rendered while the bug was in place. From-only keyframes animate *to the element's own underlying computed style* and then hand control back to it, so `0 → 0.38` (or whatever the resting opacity is) applies correctly and hover/focus opacity bumps keep working. `animation-fill-mode: both` still back-fills the `from` state during a stagger `animation-delay`, so there's no flash-of-unstyled-content.

**Exception:** genuine one-shot animations with a defined terminal state — `octo-exit-fade` (fades **to** 0, an exit), `octo-sweep` (width **to** 100%, a ceremony), `octo-flash` (a flash-and-settle) — legitimately keep both `from{}` and `to{}`. The from-only rule applies specifically to *entrance* keyframes that hand off into a resting, possibly-dimmed state.

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

**Atelier form controls** (`src/components/controls/`) — `SegmentedControl`, `TogglePill`, `Stepper`, `Listbox` (portal + fixed positioning; **keyboard-navigable — a full native-`<select>` replacement**: type-ahead, arrow/Home/End roving highlight via `aria-activedescendant`, Enter/Space select, Escape/Tab close, `triggerClassName` to match a form's sibling inputs), `IconButton`. **No production surface uses a native `<select>`, checkbox, or number spinner** — `grep -rn "<select" src --include='*.tsx' | grep -v .test.` returns nothing; new form UI must reach for these controls first.

**Run track (`RunFlow`)** — the horizontal stage list across the canvas top, governed by Law 1 (depth of field) and Law 2 (single beacon).

- Each stage is a **two-geometry card**: the **subject** (running / awaiting-checkpoint / failed / selected) renders at full ink, 210px wide — gate mark (if any) + role icon (`iconForRole`) + serif title + status glyph, then status word + a fixed-width `5ch` tabular timer, one fixed-height live line (running activity / done verdict / idle tokens, S1), and a meta line (arabic position · model · substrate pill), plus a loop badge (`⟲ {iter}/{max}`, brass) when the stage loops back. Every other stage recedes to a dimmed **essence** — 150px, `opacity-[0.38]` rising to `opacity-70` on hover/focus (180ms) — role icon + title + status glyph + arabic position · cost · tokens only. Nothing is dropped; full detail is one click away in the focus pane.
- Stages connect left-to-right with **solid 1px drawn lines**, not glyphs: `--brass-line` (55% alpha brass) once the stage to the left is done, `--hairline` ahead — progress visibly fills in as solid ink, never a gradient. The `⟜` gate mark renders on the gated card's own header, not on the connector.
- Only the card matching the single beacon (`beaconStageId`, from `lib/beacon.ts`) carries `octo-stage-pulse`; a card's own status color (running verdigris border, awaiting brass, failed rouge, stalled amber) is independent of whether it currently holds the beacon.
- The track scrolls horizontally (`RunFlowNav` chevrons appear only on overflow); the focus pane below is always visible.

**Focus pane (`StageFocus`)** — the lower half of the Direct canvas.

- Shows the selected stage's artifact: a markdown plan, a code diff, or a test result.
- Header: role icon (`iconForRole`, with `title`) + mono uppercase role eyebrow (e.g. `IMPLEMENTER`) in brass — no `§`, no dash. Model, iteration-history navigator, director controls, and tokens/cost share the row; stage title sits below in serif ivory.
- Journal entries are flat icon lines — tool icon (`iconForTool`) + tool name + hint + ✓/✕ + truncated result detail, sitting behind a single left hairline (no nested/boxed tool cards).
- For code stages, the worktree diff is embedded beneath the artifact using the same diff styling as Review mode (`--verdigris` adds / `--rouge` dels).

**Checkpoint decision strip** — docked at the canvas bottom when the run pauses at a `⟜` gate; it *unfolds* through `<Reveal>` and folds away on resolve (never mounts abruptly).

- Button hierarchy (surgical brass): **Approve & continue** is the only solid-brass button and carries the beacon; **Send back with notes** is brass-outlined serif; Re-run/Reject and Abort are ghost (Abort gets a rouge hover). Serif phrases stay upright, no arrow suffix.
- The loop meter (`review loop · 2 of 3 used`) renders in a fixed slot with tabular numerals and turns brass at the cap.
- A failed stage swaps the accent to rouge with a `✕ stage halted` eyebrow; a transient halt is amber and offers **Resume** (which takes the beacon).

**Ledger strip (`RunLedger`)** — a single calm line at the canvas bottom, **savings-first** (the differentiator leads).

- Format: `saved $0.089 · 86% under all-premium · spent $0.014 · budget $0.50` — verdigris saved value, brass spent value, mute labels, all `.octo-tabular`. No baseline ⇒ `baseline unavailable` (the slot never disappears).
- A 2px progress inset beneath (solid brass fill = cost as % of baseline) glides with `--dur-standard`; clicking the strip unfolds the per-stage breakdown via `<Reveal>`.
- **Completion moment:** when a run completes, a one-shot **solid** brass line (`.octo-sweep`, no gradient) crosses the strip and a serif phrase restates the savings. The one ceremony in Direct; failed/aborted runs get none.

**The launcher ("The Commission", `PipelineSetup`)** — a composition surface, not a wizard: no step numbering anywhere (the old `I · The brief / II · The ensemble` framing is gone). Reading order is ceremony header (serif "Direct the work" + one sans line) → **the brief** (Spectral serif, 15px/1.5, on `--panel` inside a hairline card, linked-issue chip + `⌘⏎ to begin` hint in its footer) → **the ensemble** (`PipelineTicket` cards under Law 1: selected = full ink + `--brass-dim` border + `StageDots`; others `opacity-[0.38]`→`0.70` hover; a "Compose a new one" dashed ticket opens the builder) → the selected ticket's crew line (`StageFlow`: role icon + name + model in mute, solid hairline connectors, `⟜` before a gated role, pencil-icon edit) → **the foot**, the same ledger grammar as the run (`est. saves ~$0.31 · 78% under all-premium · N runs left` — the retired standalone `DirectRunsMeter` folds its quota fragment into this line — + a budget input + **Begin the run**, ghost until brief + quota + concurrency are satisfied, then solid brass carrying the beacon).

**The builder (`PipelineBuilder` + `builder/*`)** — nodes are essence cards (role icon + name + status glyph, meta `n · model · substrate`; gate nodes carry `⟜` before the icon; a looping node's meta line carries `⟲ ×N` in brass); the selected node takes subject styling. **No beacon in the builder** — nothing needs the user in an editor, brass marks selection only. Edges: normal flow is a solid hairline with a minimal arrowhead; a review-loop edge is a **dashed** `--brass-line` arc with an `⟲ ×N` pill (dashed is structure, not a gradient). The palette groups role rows under mono eyebrows; the inspector header is role icon + mono eyebrow (no `§`); validation is one quiet header line (`✓ VALID` verdigris, or the first concrete error in rouge) — no jumping panels.

### Full-screen rooms (Settings · Mission Control)

A **room** is a transient, full-screen overlay for an **app-scoped** concern —
something that belongs to the whole app, not to one workspace, and therefore
cannot live in Canvas or Companion. It is NOT a dialog (no ModalShell): it
frames a destination, not an interruption. Rules:

- Use **`<OverlayRoom>`** (`src/components/primitives/OverlayRoom.tsx`) — it owns
  the container (`absolute inset-0 z-40`, onyx + `--brass-faint` radial wash,
  `octo-fade-in`) and the capture-phase Escape handling (defers to ModalShell
  dialogs stacked on top at z-50; never hijacks Escape from a focused field).
  `<RoomClose>` is the canonical `ESC · CLOSE` affordance.
- Header: the Settings recipe — mono eyebrow + serif title (or app-scoped live
  meta) + right-aligned quiet actions + RoomClose.
- A room is **entered from existing chrome** (top bar, shortcut) and never
  persistent — it adds zero standing pixels. One room per concept (§9).
- Current residents: **Settings** (`⌘,`) and **Mission Control** (`⌘⇧M`) — the
  fleet cockpit: every active Direct run across all workspaces as live crew
  cards in triage bands (Needs you / In flight / Settled) with Law 1 ink
  grading (needs-you full ink, in-flight `opacity-75`, settled `opacity-45`
  rising to `0.85` on hover/focus), each card carrying `StageDots` (not
  numerals — the roman-numeral micro-track is retired) plus a fixed-width
  time-in-state slot (`mm:ss` rolling to `Hh MMm`, S1/S2 — there is no
  `WAITING {n} MIN` eyebrow), a fixed-slot live ticker (S1/S5: activity /
  "{stage} holds the gate" / halt reason / settled epitaph), and the
  savings-first fleet ledger. Law 2's fleet scope: only the **longest-waiting**
  needs-you card pulses (FIFO by `statusSince`); every other needs-you card
  keeps a static brass border. The header shows a combined live-cost figure
  (`saved $X · Y% under all-premium · spent $Z`) over active runs only — this
  figure is Mission-Control-only; the top-bar `RunsTray` chip dropped it (see
  §9/FEATURES for the chip's own vocabulary).

### Status bar (bottom)

A single full-width strip at the very bottom of the window (~22px), beneath
both the rail and the main column. It is the one sanctioned piece of bottom
chrome. Rules:

- `bg-octo-panel`, top `border-octo-hairline`, JetBrains Mono `text-[11px]`.
- Labels in `text-octo-mute`/`text-octo-sage`; live values in `text-octo-brass`.
- Calm: no motion, no spring. It informs, it doesn't perform.
- Current resident: the performance monitor (RAM + CPU). Future bottom-bar
  content must keep this quiet, single-line character.
