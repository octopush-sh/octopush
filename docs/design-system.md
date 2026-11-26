# Octopush Design System — Cheatsheet

One‑page reference for **Atelier in Onyx & Brass**. For the full design, motion, and rollout, see [`superpowers/specs/2026-05-16-octopus-ux-redesign-design.md`](superpowers/specs/2026-05-16-octopus-ux-redesign-design.md).

---

## 1. Color tokens

```css
/* in src/styles.css → @theme block */
--color-octo-onyx:      #0c0a08;  /* app bg, warm black */
--color-octo-panel:     #14110d;  /* rail, header, companion */
--color-octo-panel-2:   #1a160f;  /* active input, hover */
--color-octo-hairline:  #2a2419;  /* 1px borders — decorative panel dividers */
--color-octo-border-strong: #786747; /* interactive boundaries: inputs, control edges, focus ring */
--color-octo-brass:     #d4a574;  /* THE accent */
--color-octo-brass-hi:  #e8c39a;  /* hover/pressed brass */
--color-octo-ivory:     #f4ecdb;  /* high-emphasis text */
--color-octo-sage:      #95897a;  /* body text */
--color-octo-mute:      #8c7f6c;  /* labels, meta — AA on all three surfaces */
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

**Two border tiers, and they are not interchangeable.** `--color-octo-hairline` divides panels; it is decorative and deliberately quiet. `--color-octo-border-strong` bounds anything a user operates — input outlines, control edges, the focus ring — and clears **3:1 on every surface** because WCAG 1.4.11 applies to controls. Reaching for the hairline on a control is an accessibility bug; reaching for the strong border on a panel divider draws a hard box around every surface in the app. **Enforced, with a stated boundary.** `themePalette.drift.test.ts` fails the build if a control rests on the hairline, covering: native `<input>`/`<textarea>`/`<select>`; elements that *declare* a control role (`role="switch"`, `"combobox"`, `"radiogroup"`, `"tablist"`); and surfaces handed down through a `triggerClassName` prop — resolving shared class constants **and default parameter bindings** in each case, plus inline `style`. Three things sit deliberately outside it: variant-prefixed classes (`hover:`, `focus:`), since a field that is borderless at rest has no resting boundary to govern; *single-side* borders like `border-b`, which are dividers rather than control outlines; and bare text-labelled `<button>`s, where 1.4.11's application is genuinely arguable and guessing would make the gate noisy.

### 1.1 Light mode is its own set of decisions (2026-08-08)

The `vellum` theme is not atelier inverted. Seven rules govern it, and they generalise to any light palette added later:

1. **Solve against the worst surface, not the canvas.** Every theme paints on three grounds — `bg`, `panel`, `panel_2`. `panel_2` is the hover/popover ground and is the strictest of the three in a light theme. The palette this replaced passed on `bg` and failed on hover.
2. **Darken *and* saturate.** On onyx an ink earns contrast by lightening, which desaturates it. On cream the move reverses. Darkening alone leaves the palette muddy, so accents gain saturation as they lose lightness.
3. **`accent_dim` inverts.** On onyx it is the *brighter* sibling used for emphasis; on cream emphasis runs the other way and it becomes the *deeper* chestnut.
4. **The hairline gets stronger, not fainter.** Vellum's reads at 1.63:1 against its canvas where atelier's reads 1.28:1 against onyx. This is the same principle as the next point: structure that dark mode carries with brightness, light mode carries with line.
5. **Elevation inverts too.** Dark mode raises a surface by lightening it; a light theme has no headroom above `panel` before it hits paper-white. So `panel_2` **recesses**, and lift comes from border + shadow. Borders carry structure that brightness used to.
6. **Never `#000` on `#fff`.** 21:1 halates for astigmatic readers and fatigues everyone across a full-screen IDE. Off-black on off-white, ~13:1.
7. **Amber is the token that fails.** A warning yellow essentially never clears AA on a light ground. Darken it to bronze, or put it in a chip with its own fill — and pair it with a glyph regardless, since WCAG 1.4.1 forbids carrying state in hue alone.

**Every alpha is solved, never fixed.** A ratio is a function of two luminances, so the same alpha reads differently per palette. `themeStore` solves the search-match wash (`solveMatchWashAlpha`) and the diff-row tints (`solveTintAlpha` + `DIFF_TINT_TARGET`) against each theme's own background. Adding a new tint means adding a target, not a magic number.

**`text_muted` now clears AA in every theme but one (2026-08-09).** It carries labels, meta and code comments, and used to fail everywhere — atelier 3.06:1, midnight 1.96:1, porcelain-indigo 2.64:1. Each was lifted along its own hue to just over 4.5:1 on the worst surface, which is why the tone barely shifts while the legibility does. The gate also asserts the ramp stays *ordered* (`text_muted ≤ text_dim ≤ text`): clearing a threshold is not enough if a token ends up louder than the tier above it.

**The one exclusion: `solarized-dark`.** Solarized is a published, named palette whose dark variant does not carry an AA-capable text ramp. On *upstream's own* surfaces, body text (base0) is 4.75:1 on base03 but 4.11:1 on base02, and the comment tone (base01) is 2.79:1 / 2.42:1 — below AA wherever it sits. Lifting `text_muted` alone would invert the hierarchy; lifting the whole ramp would mean it is no longer Solarized. It stays verbatim and `NOT_AA_CAPABLE` names it rather than leaving a silent hole. The exclusion covers the text ramp only — `border_strong` is an Octopush token with no upstream counterpart, so every theme without exception must clear 3:1 on it.

### 1.2 Syntax palette (2026-11-04, issue #436)

Code highlighting uses palette inks only, no syntax-only hues. One table, `src/lib/syntaxPalette.ts`, maps every highlighting tag to a kind; the editor (`atelierTheme.ts`) and the Review diff (`.tok-*` in `styles.css`) both read it.

| Kind | Ink | Diff class |
|---|---|---|
| Keywords, modifiers, `this` | brass (the one accent, kept surgical) | `tok-kw` |
| Types, classes, tags | `--color-octo-state-blue` | `tok-type` |
| Function and method names, call and definition | `--color-octo-state-purple` | `tok-fn` |
| Strings | `--color-octo-verdigris` | `tok-str` |
| Numbers and constants | sage | `tok-num` |
| Annotations, decorators, macros | `--color-octo-warning` (amber; rare, so it still reads as an exception) | `tok-meta` |
| Properties, plain text | ivory | `tok-prop` · `tok-var` |
| Comments, punctuation | mute, upright, never italic | `tok-cmt` · `tok-punct` |

State-blue and state-purple have no `ThemeConfig` field, so `themeStore` switches them with the ground: the Onyx values on a dark theme, `vellumInks` from `tokens.ts` on a light one (`#2f5a7e` / `#6a4682`, AA on every Vellum surface). Verdigris and amber are ThemeConfig inks already. `contrast.test.ts` holds both themes' syntax inks to 4.5:1, and `syntaxPalette.coverage.test.ts` fails if a supported language emits a tag with no rule.

Strings are verdigris rather than sage because sage (the theme's `textDim`) and mute are near twins: on Vellum `#6d5e4b` against `#6f5f4a`. Strings and comments sit side by side constantly, so they need inks that read apart; sage goes to numbers and constants instead.

**Accepted, by design (#525): on Vellum, numbers and constants (sage) and comments (mute) are near twins.** They read almost the same, and that is not a bug to fix: it is the price of strings and comments reading apart, the pair that sits side by side far more often. Don't move numbers or comments to another ink to "fix" it without updating this section.

A changed word in the diff (`.wd-add` / `.wd-del`) is painted in the text ink, not its syntax ink: on the word fill the syntax inks fall under AA (verdigris, the string ink, falls below 4.5:1 on Vellum), the text ink doesn't. Search matches follow the same rule.

---

## 2. Typography

```css
--font-serif: "Spectral", "Iowan Old Style", "Times New Roman", serif;
--font-sans:  -apple-system, "Helvetica Neue", sans-serif;
--font-mono:  "JetBrains Mono", "SF Mono", monospace;
```

| Role          | Family | Size | Weight | Style  | Tracking |
|---------------|--------|------|--------|--------|----------|
| Display       | Serif  | 28px | 400    | upright | −0.01em  |
| H1 Page       | Serif  | 22px | 400    | upright | −0.005em |
| H2 Section    | Sans   | 16px | 600    | normal | −0.005em |
| Body          | Sans   | 13px | 400    | normal | normal   |
| Small / Meta  | Sans   | 11px | 400    | normal | normal   |
| Eyebrow       | Mono   | 10px | 400    | upper  | 0.25em   |
| Code / Mono   | Mono   | 12px | 400    | normal | normal   |

**Where each voice goes:**
- **Spectral (upright)** — display, "the key phrase" of model responses, ceremonial CTAs, input placeholders. Never italic (§9).
- **Sans** — bulk reading text, settings, body of messages.
- **Mono** — eyebrows (`— Claude`, `WORKSPACE`), code, kbd, file paths, terminal.

---

## 3. Spacing · Radii · Borders

- **Spacing scale (base 4):** `4 · 8 · 12 · 16 · 24 · 32 · 48`. Default gaps: 12 / 16 / 24. Premium breath: 24 / 32.
- **Radii:** `sm: 6px` (buttons, pills), `md: 10px` (panels, inputs), `lg: 14px` (large canvases). **No pill-shaped controls by default.**
- **Layout minimums (Talk's terminal seat):** `--talk-chat-min: 44rem` (the conversation keeps the composer at its natural width), `--talk-seat-min: 21rem` (about 40 terminal columns), `--talk-chat-floor: 18rem` (the narrowest the conversation goes, its composer bar wrapped). Mirrored in `tokens.ts` as `talkSeat`.
- **Shell spacing (2026-11-18):** `--shell-gutter: 8px` (`<main>`'s inset from the rail and from the Companion), `--shell-stack: 8px` (above the ContextHeader, header to mode band, mode band to canvas), `--shell-foot: 8px` (the canvas column's bottom padding). Mirrored in `tokens.ts` as `shell`. The gaps between the app's standing surfaces go through these three, never through a spacing class of their own. See section 8, "Shell spacing".
- **Settings content column (2026-11-24, #1018):** `--settings-content: 720px`, the one max width every Settings pane renders in. Mirrored in `tokens.ts` as `settingsContent`. See section 8, "Full-screen rooms".
- **Hairline:** 1px in `--hairline`. Brass hairline: 1px in `--brass-dim` for active borders.
- **Brass rule: fully deleted (2026-07-11).** The 28px gradient divider (`linear-gradient(90deg, var(--brass), transparent)`), `.animate-brass-grow`, and `@keyframes brassgrow` are **removed from the codebase**, not just retired-for-new-surfaces — there is no legacy allowance left; `grep -rn "linear-gradient" src` returns only non-divider uses (a repeating-stripe running-bar texture, a scrim fade behind tool output, and `mask-image` edge-fades — none of them a rule/line). Use `--hairline` borders or spacing for visual separation; use the solid `--brass-line` token where an *active* connector is needed (see §6, §8).

---

## 4. Component recipes (copy‑paste)

### Primary CTA — ceremonial
```tsx
<button className="rounded-lg border border-octo-brass-dim bg-octo-brass-ghost
                   px-4 py-2 font-serif text-octo-brass text-sm">
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
<p className="font-serif text-[22px] leading-[1.15] tracking-[-0.005em] text-octo-ivory">
  Because <code className="font-mono text-octo-brass">skipRefreshCheck</code> is true.
</p>
```

### Talk turns: the ask, the work, the answer (2026-11-24)

A long Talk thread reads in three registers, so whose turn is whose shows at a glance:

| Register | Treatment | Brass |
|---|---|---|
| **The ask** (the director's turn) | `panel` inset, hairline border, 6px radius; header = eyebrow, hover/focus actions, time | the `— You` eyebrow, nothing else |
| **The work** (narration + tool calls) | one hairline on the left; narration lines and one ledger row per call hang from it; a round of more than five calls folds into one summary row | none |
| **The answer** | flush on the canvas; mute eyebrow, serif key phrase, sage body, mute usage footer | inline code only, as in any prose |

The ask is the one filled surface in the thread that isn't code. Brass goes to the director's eyebrow because the human directs (VISION §3.1); the model's eyebrow is meta, so it is mute.

```tsx
{/* The ask — ChatMessage, user branch */}
<article data-role="user" aria-label="You, 14:02"
         className="rounded-md border border-octo-hairline bg-octo-panel px-4 pb-3 pt-2">
  <div className="mb-1 flex h-6 items-center gap-2">
    <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">— You</span>
    <div className="ml-auto flex items-center">{/* RowActions, opacity-0 until hover/focus */}</div>
    {/* turnTime / turnTimeFull: English and 24-hour, never the system locale */}
    <time dateTime={iso} title={turnTimeFull(iso)}
          className="octo-tabular font-mono text-[9px] tracking-[0.15em] text-octo-mute">14:02</time>
  </div>
  <div className="whitespace-pre-wrap break-words text-[14px] leading-[1.55] text-octo-ivory">{text}</div>
</article>

{/* The thread is <section aria-label="Conversation">; each turn is an <article>.
    An answer's actions sit last inside its own article. */}
{/* The work — chat/WorkBlock.tsx */}
<article aria-label="Work, 3 tool calls" className="flex flex-col gap-0.5 border-l border-octo-hairline pl-3">
  <div className="py-1 text-[12.5px] leading-[1.55] text-octo-sage">Let me find where …</div>
  <div role="group" aria-label="3 tool calls">
    {/* one ToolCallCard ledger row per call */}
  </div>
</article>
```

### Tool call (a ledger row)
A resolved call is a row, never a card: no border, no fill, 24px high, on the work block's hairline. The chevron is always the last column, so a round's chevrons line up.
```tsx
<div className="octo-ledger flex h-6 items-center gap-1 rounded px-1.5 -ml-1.5">
  <div role="button" aria-expanded={open} aria-label="READ auth/middleware.ts"
       className="octo-ledger-head flex min-w-0 flex-1 items-center gap-2.5">
    <Eye size={12} strokeWidth={1.75} className="text-octo-mute" />            {/* iconForTool, with a title */}
    <span className="min-w-12 font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">READ</span>
    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-octo-sage">auth/middleware.ts</span>
  </div>
  <span className="octo-ledger-actions">{/* 12px icons with a title, shown on row hover/focus */}</span>
  <ChevronRight size={11} aria-hidden className="text-octo-mute" />
</div>
```
`ToolCallCard` writes this with inline styles (it renders beside react-markdown, where Tailwind's cascade leaked once), and they hold tokens only: `var(--color-octo-*)` and `var(--font-mono)` / `var(--font-sans)`, never a literal. The whole-row hover wash, the actions' reveal and the inset focus rings live in `styles.css` (`.octo-ledger`, `.octo-ledger-head`, `.octo-ledger-actions`, `.octo-ledger-action`). The row's actions (Send to terminal, Open in editor, Reveal in Finder) are titled icons that keep their room while hidden, so nothing moves; they turn brass on hover. A **running** call (`LiveToolCard`) is the same row with a 6px verdigris status dot sitting on the hairline, pulsing on `.octo-stage-pulse` + `.octo-stage-pulse-running` (static halo under reduced motion; running work is never brass), placed exactly where its resolved row will land, so it settles in place. A resolved call that **failed** keeps that dot, rouge, and adds a rouge mono meta after the summary (`exit 1`, `timed out`) with a `title` in words; a **denied** one gets the same two marks in mute (`denied`); a pass gets neither, so twenty good calls carry no noise. A folded round's count says what its rows can't: `6 tool calls · 1 failed` (rouge) `· 1 denied` (mute). Status colours only: never brass for a verdict. A round of more than five calls folds into one summary row once its turn has ended, never while it streams, and always as one tree (the rows stay under the same `Reveal`). The `§` prefix is retired: the tool identity is a `lucide-react` icon from `src/lib/roleIcons.ts` (`iconForTool`), always with a `title`. Same icon recipe for Direct focus-pane journal lines and role eyebrows (`iconForRole`).

### Input with serif placeholder
```tsx
<input
  className="border border-octo-hairline rounded-lg px-3 py-2 bg-octo-onyx
             text-octo-ivory focus:border-octo-brass-dim
             placeholder:font-serif placeholder:text-octo-mute"
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

### Found-match wash & inverted seal (search hits in text)

For marking occurrences inside a body of text — editor find-in-file today, and the pattern to reuse for any future "N hits, you're on this one" surface.

```css
/* every hit */
background: var(--octo-match);                        /* accent, alpha solved per theme */
box-shadow: inset 0 0 0 1px var(--octo-match-ring);
border-radius: 2px;
color: var(--octo-match-ink);                         /* also on descendants */

/* the one you're on — an inverted seal, not a stronger wash */
background: var(--octo-match-current);                /* solid accent */
color: var(--octo-match-current-ink);                 /* the theme's own background */
box-shadow: none;
```

Three rules make this work, and they generalise:

1. **Separate the current item by weight, not by alpha.** A wash and a slightly-stronger wash are indistinguishable. A wash versus a solid inverted chip is unmistakable, and it survives any palette because the ink is the theme's own background.
2. **The wash alpha is solved, never picked.** Contrast is a ratio of luminances, so one alpha is not one appearance: the same 23.5% is a 1.50 contrast step on atelier's onyx and only 1.35 on vellum's cream. `solveMatchWashAlpha()` in `lib/contrast.ts` returns the smallest alpha clearing a 1.50 step against the active background — 23.5% atelier through 31% vellum. **Any future translucent overlay whose job is to be *noticed* should be solved the same way rather than hardcoded.**
3. **A wash must own its foreground.** Laying a wash over text costs whatever sits on it ~34% of its contrast. Body text absorbs that (16.82 → 11.18); deliberately dim text does not (comments: 3.35 → 2.23, i.e. *worse than not highlighting at all*). So the mark sets `color` explicitly — on itself **and its descendants**, since a syntax span can nest inside it and `color` inherits.

Tokens live in `styles.css` (atelier fallbacks) and are written per theme by `themeStore`. They are the only **opaque** colours derived there, so they are the only ones gated on the theme's hex actually parsing — a malformed value would be a solid slab over the content rather than a faint tint.

### Ambient occurrence wash (the symbol under the caret)

The quiet sibling of the found-match wash above, and the rule it teaches is when *not* to reach for the accent. A search hit was asked for; an occurrence highlight paints itself every time the caret lands on a word. A layer that appears unbidden gets a **neutral** wash derived from the theme's text colour, no ring, and no foreground repaint — the reader is still reading this code, and syntax colour is worth more than a guaranteed step against a 10% tint.

```css
/* every use of the symbol under the caret */
background: var(--octo-symbol);                       /* text colour @ 10% — neutral */
border-radius: 2px;

/* the one that is its definition — at most one per file, so brass is earned */
background: var(--octo-symbol-def);                   /* accent @ 10% */
box-shadow: inset 0 -1px 0 0 var(--octo-symbol-def-ring);

/* ⌘/Ctrl-hover target for go-to-definition */
text-decoration: underline var(--octo-symbol-link);   /* accent */
text-underline-offset: 2px;
cursor: pointer;
```

1. **Frequency decides the palette.** Brass is surgical because it is rare. An accent spent on something that fires on every cursor move stops reading as an accent everywhere else in the app. Spend it on the *one* occurrence that is the definition instead.
2. **Unbidden layers don't repaint text.** The rule above ("a wash must own its foreground") applies to a wash the user asked for. This one is pinned low enough — a fixed 10%, deliberately *not* solved — that the syntax colour underneath survives it intact.
3. **Two ambient layers never share a screen.** The occurrence highlighter stands down whenever a find query is live, because two washes over the same text read as one broken one.


### Margin marker (a rendered block pointing back at its source)

For any surface where a *derived* view needs to point at the *authored* thing behind it — today the REVIEW Markdown preview naming the source line of the block under the pointer. One marker exists per pane, not one per block: a single absolutely-positioned button, moved to the hovered element's offset inside the document wrapper.

```tsx
// top = block.getBoundingClientRect().top - body.getBoundingClientRect().top
<div ref={body} className="relative …">   {/* content, not the scroller */}
  {rendered}
  <button
    className={`absolute -left-8 z-10 rounded-[4px] border px-1.5 py-0.5 font-mono
                text-[9px] leading-none tabular-nums text-octo-brass
                ${shown ? "opacity-100" : "pointer-events-none opacity-0"}`}
    style={{
      top,
      background: "var(--brass-ghost)",
      borderColor: "var(--brass-quiet)",
      transition: "opacity 220ms cubic-bezier(0.2,0.8,0.3,1)",
    }}
  >{line}</button>
</div>
```

Four rules:

1. **Reserve the gutter on the scroller, not the block.** The pane pads `pl-11`; the marker sits at `-left-8`. A negative offset inside an `overflow-x` box (a `<pre>`, a table wrapper) gets clipped — so the jump attribute goes on a plain wrapper, never on the scrolling element itself. Measure with `getBoundingClientRect()` against the wrapper, **not `offsetTop`**: a `<tr>`/`<td>`'s `offsetParent` is its `<table>`, so `offsetTop` would be the row's position inside the table.
2. **One marker, kept mounted — and reachable.** It fades rather than unmounting, so it never appears or disappears abruptly (§6), and hovering across blocks moves one element instead of mounting dozens. **The gutter it sits in belongs to the pane, not to any block**, so the pointer must cross non-block space to reach it: dismiss only on the pane's `mouseleave`, never on "the pointer isn't over a block". A hidden marker is inert, so dismissing early makes it impossible to click. Hide it whenever the document reflows — on a content change *and* via a `ResizeObserver`, since a pane animating between layouts, a window resize or a late-loading image all move the blocks while the pointer sits still and no `mouseover` comes to re-measure.
3. **The quiet path is a modifier, the discoverable path is the marker.** The marker teaches the gesture on hover; `⌘`/`Ctrl`-click is the same action for someone who already knows. Never spend an unmodified click or a double-click on navigation inside selectable prose — those belong to selection and links.
4. **Numerals, not glyphs.** The marker is the line number in brass mono. No arrow, no connector — both are retired (§5).

### Selectable content islands

`<body>` is `user-select: none` (a native desktop feel). Any surface whose text a user legitimately wants to copy — chat, editor, run journals, the Markdown preview — opts back in with **`.octo-selectable`**. Do not re-derive this per component, and do not ship a read-only text surface without it: prose a user cannot copy reads as a bug, not as chrome.

### Tour spotlight (guided tours — `TourOverlay`, 2026-10-30)

The one way to point at a piece of the real UI (What's new → **Show me**, and the clip recorder). Source: `src/components/TourOverlay.tsx`, `.octo-tour-spot` in `src/styles.css`, runner in `src/lib/tour/runner.ts`.

- **Scrim with a cut-out, one element.** `.octo-tour-spot` is a fixed box over the target (4px padding, 8px radius) whose `box-shadow: 0 0 0 200vmax` spread *is* the scrim — the same onyx/80 wash as `ModalShell` — so the target shows through untouched. Its edge is a **1px `--brass-dim` outline**: hairline brass, no glow, no pulse (the single-beacon rule stands — a tour adds no beacon).
- **Glide, don't jump.** Moving between steps animates `top/left/width/height` on `--dur-standard` + `--ease-octo`; the overlay enters with `.octo-overlay-enter`, each caption crossfades with `.octo-fade-in`. Reduced motion: the global neutralizer collapses all of it to an instant move.
- **Caption bubble** — panel + hairline border, 300px, body sans 13px ivory, mono `2 / 4` counter, ghost **Back**, brass-ghost **Next**/**Done** (upright serif), a quiet `X` icon button with `title`. Anchored below the target, flips above when it would overflow, clamped 12px inside the viewport (`placeBubble`).
- **Look, don't touch.** A transparent click-catcher sits over the app; the interactive tour never performs a step's `action` (only the recorder does). Escape closes (captured, so the surface underneath doesn't also close), ←/→ page, focus is trapped in the bubble and handed back when the tour ends.
- Record mode (`window.__octoTour`, dev or `?octo-record=1`) shows the caption and counter only — no controls in the clip.

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
| `StageDots` + the single beacon | **Active — the new signature mechanics.** `StageDots` (`src/components/direct/StageDots.tsx`) is the universal micro-track (5px dots, one per stage) replacing every bespoke shape line and the roman-numeral track. Dot colours: done verdigris, running verdigris + faint `--verdigris-strong` halo, awaiting gate brass, failed rouge, stalled amber, pending hairline — a running stage is never brass, so five busy crews put no brass on screen. `tone="shape"` (launcher tickets) paints every dot sage; `tone="pager"` (What's new modal page indicator, statuses `seen` / `current` / `upcoming`) paints seen pages verdigris, the current page brass (the active mark) and upcoming pages hairline — never pass a run status to mark a page. Exactly one pulsing element per attention scope at a time (brass for needs-you anchors, amber on an amber halt's Resume, verdigris while a stage runs) (`lib/beacon.ts`'s `beaconAnchor`; fleet scope = the longest-waiting needs-you card, FIFO by `statusSince`) — see §6. | Launcher tickets, Companion, Mission Control, run history, Talk crew cards, What's new pager. |
| Italic phrases| Active — **upright only** | CTAs and placeholders use upright serif phrases (italics banned app-wide; see §9) |
| `⟳` in **amber** (`--color-octo-warning`) | Active | Direct mode transient halt — awaits **Resume**. Amber = caution, never brass — its Resume pulses amber when it holds the beacon (`.octo-stage-pulse-warning`, §6). |
| Substrate pills | Active | Direct mode only — `API` in `--color-octo-state-blue`, `CLI` in `--color-octo-state-purple` |
| `✦` flourish  | **RETIRED** | Never use. Not in any existing surface; do not introduce. |
| `◈`           | **RETIRED (2026-08-21)** | Was: the ContextHeader's active-ticket marker. Dropped with the eyebrow-and-name redesign — the type-tinted ticket key already marks the ticket, so the diamond was a second badge for one fact. `grep -rn "◈" src` should only match tests asserting its absence. |

---

## The Octo — mark & mascot

The brand mark is **The Octo**: a solid-brass octopus creature (dome head, two
negative-space eyes, four front arms, four muted back arms) defined canonically
in `src/components/icons/OctoMark.tsx` (`viewBox 0 0 64 66`). Spec:
`docs/superpowers/specs/2026-07-11-octopush-logo-brand-design.md`.

- **Colors:** body `--color-octo-brass`, back arms `--brass-line`, eyes
  `--octo-eye` (defaults to `--color-octo-bg`). Never recolor, add gradients,
  outline, rotate, or drop the eyes. The one exception is the macOS menu bar,
  which is system chrome: there The Octo is a monochrome **template** image
  (shape in alpha only, inked by macOS for a light or dark bar), with no brass.
- **Adaptive detail:** below 20px the back-arm row is dropped automatically.
- **States** (`<OctoMark state=…>`): `static` (icon placements), `idle`
  (floats/paddles/blinks), `working` (double tempo + eye scan), `pushed`
  (one-shot rise + brass halo, happy eyes), `blocked` (freezes, eyes at
  half-mast — stillness is the signal). All motion ≤2.5px, reduced-motion safe
  (`octo-m-*` keyframes, §6).
- **Placements:** app icon (`src-tauri/icons/source.svg`), Welcome hero (idle),
  top-bar live mascot (`useMascotState`: blocked > working > idle), Project
  empty state (idle), run-ledger completion moment (pushed),
  Settings/About/legacy-sidebar (static), dev favicon, and the **menu bar
  status item** (#718, `src-tauri/icons/tray/`): still poses of the rig, never
  animated — `idle` at rest, `working` with the eyes at the end of their scan
  and the first and third arms raised a full stroke (2.4u), `blocked` (needs
  you) with the eyes at half-mast — rendered by `scripts/tray-icons.py`.
  Being still, it never competes with the app's one beacon.
- **Canvas behaviors:** the TALK empty-state **Watcher** (gaze-follow ±2.4u + fidget
  cycle look/scratch/peek after 15s idle — `chat/OctoWatcher.tsx`) and the pinned
  **Player** (`OctoPlayer.tsx` — the shared phase machine + figure): role classes
  `octo-mascot--write/read/search/run` + `octo-mascot--pushed-beat`. Two adapters
  feed it: TALK (`chat/OctoStatus.tsx`, `roleForActivity` over streaming/liveTools/
  approvals, identity = workspace) and DIRECT (`direct/StageOctoStatus.tsx`,
  `roleForStage` over the stage's live journal + status, identity = stage;
  `done` beats, `failed` leaves quietly). Keep new roles to eye/arm tempo changes
  on the same six rig pieces — never add elements to the rig.
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
| `<MidTruncate text tail lead?>` | identifiers whose head AND tail disambiguate (branch names, paths) | CSS `.octo-midtrunc` — head ellipsizes, tail pinned, `…` seated flush by one shared observer; optional `lead` glyph inside the box (`src/components/primitives/MidTruncate.tsx`) |
| `.octo-demote*` / `.octo-status-*` | the demotion ladder — shedding meta as a band narrows | `@container` + animated `max-width`/`opacity` |
| `.octo-prov-pop` | hover/focus disclosure anchored to a chip (branch provenance) | fade+scale, kept mounted, `:focus-within` |
| `.octo-tabular` | every live numeric value (cost, %, mm:ss, counters) | `font-variant-numeric: tabular-nums` |
| `.octo-sweep` | one-shot **solid** brass line sweep (Direct run-completion moment only; no gradient) | width 0→100% · --dur-reveal |

### Elision doctrine — middle truncation and the demotion ladder (2026-08-21; born in ContextHeader)

Two mechanics for any band that mixes elastic text with atoms that must stay whole. Reach for them before inventing a one-off.

**E1 — Middle truncation for identifiers.** `truncate` keeps the head and throws away exactly the part that tells two similar strings apart: `…-per-shard-copy` and `…-per-shard-guard` both render as `intermittent-component-not-…`. `<MidTruncate>` keeps both ends and elides the middle instead. CSS does the layout (`.octo-midtrunc`, `white-space: nowrap`) — the head ellipsizes into whatever room is left and the tail is pinned — and one measured pass then seats the `…` flush against the tail (`seatEllipsis`, #750): once the head overflows it is cut at the last grapheme boundary that fits beside the `…` (trailing whitespace dropped; when the whole head fits there is no cut and no `…`), and the head's `max-width` becomes those glyphs plus the `…`'s measured width (+0.5px against layout rounding), so the head's **own** `text-overflow: ellipsis` lands right after the last kept glyph and the box ends with it. The head is never held at `clip` once cut (#864): a clipped head beside a separately drawn `…` is, to WebKit and the visual audit's `text-cut` check, text cut with no ellipsis. Nor is it held there after a pass that fails (#865): a box whose measurement throws keeps the plain CSS ellipsis, and every other box in the shared pass is still released and cut. The `…` is measured on a ruler, `<span class="octo-midtrunc-ell" aria-hidden="true">…</span>`, laid out in the box's font but zero-width, invisible and unselectable — never shown. The read holds the head at `text-overflow: clip` for that frame only (#833): WebKit clips Range rects at its own ellipsis point, so measuring under `ellipsis` would cap the search at the engine's cut, trailing space included. The hold is the head's **own inline style**, set and cleared in the same pass, never a stylesheet rule keyed on the box (#872): with `.octo-midtrunc[data-measuring] .octo-midtrunc-head`, releasing the hold restyled the head only once the box's attribute change reached it, and Safari left the Review file header's `src-tauri` head cut with no ellipsis. `data-measuring` on the box only marks the pass; no rule in `styles.css` clips the head. The accessible name and a copy stay the full string, which never leaves the DOM. The pass re-runs when the **nearest ancestor with a definite width** resizes (`widthAnchor` skips any parent sized by its own content, which shrinks with the cut and would never grow back), through **one** shared `ResizeObserver` and one animation frame for every instance — reset all, read all, write all — and a resize under 1px from the width of the last re-cut doesn't re-cut (sub-pixel steps still add up). Right-to-left text keeps the plain CSS ellipsis. A line break, tab, form feed, vertical tab or Unicode line/paragraph separator (U+2028/U+2029) in the string renders as a space (the caller's `title` keeps the original); the `lead` is tracked by presence, not identity, so an inline `lead={<GitBranch/>}` doesn't re-cut on every render; a space at the head/tail seam starts the tail, which alone is `white-space: pre`, since `nowrap` would collapse it at the head's edge — it stays a plain space, so a copy and the accessible name are the string exactly. **Always pair it with a `title`.** Use it for branch names, file paths, run ids; NOT for prose, where the head is the meaning and plain `truncate` is right.

Two traps, both paid for once already:

- **A bare string inside a flex box is an anonymous flex item, and it wraps.** The short-name path renders through `.octo-midtrunc-whole` — a plain block with `white-space: nowrap` and a real `text-overflow: ellipsis` — never the flex box the split path uses. When the short path shared `.octo-midtrunc`, `check-in` broke at its hyphen into two lines inside a 14px row, and `main`, having no break opportunity at all, was hard-cut to `mai`.
- **Give the box a definite width, never a percentage `max-width`.** Inside a shrink-to-fit chain a percentage is a cyclic reference, and it resolved *below the text's own width* with 1200px of room to spare. Sizing the box from its own text is no better: WebKit then hard-cuts it with no ellipsis (the ContextHeader branch lost its tail with 130px of the band still empty, #400). The shape that works, proven in the rail and now in the ContextHeader: every wrapper between the band and the `.octo-midtrunc` box is `flex-1 min-w-0`, so the box elides into the room the band leaves. The wrapper that directly holds the box must itself be a **flex** container (`flex min-w-0 flex-1`), not a block: inside a block the inline-flex box is sized from its own unbreakable text, spills past its column and is hard-cut by whatever sits beside it (Settings → Project links ran under the key input, #757). When those grown wrappers are interactive, make them `pointer-events-none` with no wash or ring of their own and put the wash, hover colour and focus ring (`group-focus-visible:ring-1`) on the MidTruncate box, which opts back in with `pointer-events-auto` — blank space then does nothing and the wash stays the size of the text. A glyph that belongs to the chip goes in through `lead`, so it sits inside that box. Atoms that used to follow the chip (the base branch) move to the band's right end, outside the grown box. `ContextHeader.test.tsx` fails if a percentage `max-width` comes back anywhere in the chain.

**E2 — Truncation is not enough; shed on a stated ladder.** Below a certain width the *fixed* atoms stop fitting and start overlapping — no amount of truncating the elastic ones saves the row. So declare an order in which meta is shed, and animate each step's width instead of unmounting it (§6: nothing appears or disappears abruptly). The ContextHeader's ladder, and the shape to copy:

| Rung | Sheds | Where it survives |
|------|-------|-------------------|
| ≤ 900px | base branch (`from main`) | branch tooltip + provenance popover |
| ≤ 780px | parent/grandparent ticket chain | one click away in the tracker |
| ≤ 640px | the status **name** → the category **dot** it already implies | the element's `title` |
| floor | *nothing* — the active ticket key and the name line never demote | — |

Four rules generalise:

1. **The band is its own `@container`**, never a media query. The window's width says nothing about how much room a column between a rail and a companion actually has.
2. **Nothing is deleted at any rung.** Every shed item stays reachable — a tooltip, the popover, the tracker. A ladder that loses information is just a smaller bug.
3. **A rung is `flex: none`.** It is either fully present or collapsed by the ladder — never squeezed into an unreadable stub. All of the deficit goes to the one deliberately elastic atom in the band.
4. **Declare the floor.** Name the thing that never demotes (here: the identity — the key and the name). Without a floor, every atom is negotiable and the row eventually clips something load-bearing.

The dot-for-label swap at the last rung is §9's "a state shown by a dot does not also get a label" applied to width rather than to taste: both are mounted, and the ladder animates their widths so exactly one is visible.

**Shedding controls into "More" (2026-11-01; born in the Review toolbar).** When the shed atoms are *controls* rather than meta, a tooltip can't hold them — so the rung that sheds them is paired with an inverse rung: a `MoreHorizontal` button that grows in (same animated width) only once they are gone, opening a `.octo-menu-enter` menu with the same controls. The Review toolbar (`.octo-reviewbar`) sheds Inline/Side-by-side, ±WS and Tests together at ≤ 600px; its floor is Diff/Editor, AI and Accept all. Popovers belonging to shed controls anchor to the band, never to the rung, whose `overflow: hidden` would clip them.

**Shedding by measured width (2026-11-03; born in the Review status tail).** A fixed container breakpoint only works when the rungs have fixed widths. The Review tail's rungs hold counts ("changed", then "· +2 −1"; floor "2 files"), so `ReviewTail.tsx` measures each rung's natural width against the track's and sheds through `.octo-demote-shed` (`rungsToShed`). The motion is the same. This only works when the measured box is sized by its parent (a grid track) and never by the content it sheds, so shedding can't feed back into the measurement.

**The mode band's ladder (2026-11-18; born with Run's session line).** The band (`.octo-modeband`, `ModeBand.tsx`) is its own `@container`. Its switcher is centred and its tail sits in the right track, so on a narrow canvas the two want the same pixels, and what gives way is declared:

| Rung | Sheds | Where it survives |
|------|-------|-------------------|
| ≤ 720px, in every mode | the **inactive** modes' labels → their icon | each segment's `title` (`Review (⌘⇧3)`) and accessible name |
| ≤ 334px | a control tail's floor: its track keeps only the last rung (`tailLastMin`; Run: the session line's `⌘⌥K` list button alone, `LINE_LAST_PX`), and the control sheds down to it, so nothing is clipped | the list button: `⌘⌥K` switches, opens and closes sessions |
| floor | *nothing more* — the switcher, and the **active** mode's label: the band never stops naming where you are | — |

A redundant word goes before a session's cell does: the labels buy Run's session line about 73px, six cells instead of a fold. The rung is the same in every mode on purpose. If Talk, Review and Direct kept their labels longer than Run, the switcher would change width as the mode changed, and the segment under the pointer would become another mode mid-click. The label is a rung inside a button (`.octo-demote-mode-label`): no gap or focus-ring room of its own, a negative margin that eats the button's icon gap, and a `max-width` cap near its own width (`calc(7 * (1ch + 0.2em))`, not the generic 40ch), because a collapse tweens from the cap and a far one makes it lag. The switcher's indicator re-measures as the segments resize.

The right track also has a **floor of its own** when the tail is a control: `ModeBand`'s `tailMin` (the session line's `LINE_FLOOR_PX`, 119px: the fold button, the focused session's cell, `+`, the hairline and the layout button). The grid is `minmax(0,1fr) auto minmax(tailMin,1fr)`, so when room runs short the empty left track gives up its share first and the switcher slides off centre rather than the control losing a button. At 334px and under the floor gives way to `tailLastMin` (`--modeband-tail-last`): reserving 119px for a line that can't show would only push the switcher. The container (`.octo-modeband`) wraps the grid (`.octo-modeband-grid`) for this, since a container query styles only what is inside the container. A read-out tail (Talk, Review, Direct) has no floor and truncates in its track as before, with more room than it had.

### Stability doctrine (binding for live surfaces; born in Direct)

- **S1 — Fixed-slot live text.** Text that changes while something runs lives in a fixed-height truncating slot that exists in every state — content changes never resize the container.
- **S2 — Tabular numerals.** Every live numeric value uses `.octo-tabular`; timers get a `ch`-based fixed width.
- **S3 — No abrupt subtree swaps.** Mutually exclusive views transition through `<FadeSwap>`.
- **S4 — Height changes are animated.** Anything that expands/collapses goes through `<Reveal>`.
- **S5 — No motion on live tickers.** Streaming values update in place; motion is reserved for state *transitions*.
- **S6 — Smooth, calm scrolling.** Autoscroll uses `scrollTo({behavior:"smooth"})`; entries enter with `.octo-rise-in`.

Collapsible regions use the **grid-rows `0fr↔1fr`** idiom (see `WorkContextPanel`, the rail project collapse, the Recently-closed drawer). All entrance/collapse motion respects `prefers-reduced-motion`.

### The single beacon (Direct beauty redesign, binding for live surfaces)

At any moment there is **exactly one** pulsing *live* element per attention scope — never two pulses at once. Its colour says why it holds the beacon: **brass** for a needs-you anchor (a decision strip CTA — gate, halt, draft launch — or the ready launcher CTA), **amber** when that CTA is an amber halt's Resume (a transient fault or a Claude plan limit), **verdigris** while the anchor is a running stage. `src/lib/beacon.ts`'s `beaconAnchor()` is the pure priority selector (decision strip CTA → running stage card → ready launcher CTA → calm/`null`); components only ask "am I the anchor?" via the id it returns. Fleet scope (Mission Control / the `RunsTray` chip) has its own rule: only the **longest-waiting** needs-you card pulses (FIFO by `statusSince`), and the top-bar chip pulses only when at least one run needs the director.

- The pulse itself is `.octo-stage-pulse` — a 2.4s looping `box-shadow` keyframe (`0%,100% → 0 0 0 0 transparent`, `50% → 0 0 0 3px var(--pulse-ink, var(--brass-ghost))`), never `infinite`-scaling or springy. Two custom properties carry its colour: `--pulse-ink` (the animated ring, brass-ghost by default) and `--pulse-halo` (the reduced-motion halo, brass-dim by default).
- **A running stage is never brass, even as the beacon.** When the anchor is a running run-track card, `RunFlow` adds `.octo-stage-pulse-running`, which swaps the pulse ink to `--verdigris-ghost` and the reduced-motion halo to `--verdigris-strong`. Without it the PRM halo drew a 1px brass ring on top of the verdigris border, and a working card read exactly like an awaiting-gate one (#749). Brass pulses stay with *needs-you* anchors (gates, halts, ready CTAs).
- **An amber halt is never brass, even as the beacon.** The amber "Resume the stage" of a transient halt (`⟳ awaiting retry`) and of a Claude plan-limit wait carries `.octo-stage-pulse-warning` beside the pulse (`RunControlBar`'s `AMBER_BEACON`), which swaps the ink to `--warning-ghost` and the reduced-motion halo to `--warning-border`, so the pulse matches the button's amber border (#818).
- The workspace rail's beacon is its own older primitive, `.animate-attention-pulse` (a 1.4s ring on the monogram), governed by the same law: `resolveAttention()` in `WorkspaceRail.tsx` lets exactly one row pulse and dots the rest.
- **Under `prefers-reduced-motion`:** the pulse animation is disabled and replaced with a **static halo** — a permanent `0 0 0 1px var(--pulse-halo, var(--brass-dim))` box-shadow — so the anchor is still legible without motion. The halo follows `--pulse-halo`: brass-dim for a needs-you anchor, `--warning-border` on an amber halt (`.octo-stage-pulse-warning`), `--verdigris-strong` on a running stage (`.octo-stage-pulse-running`).
- PRM handling lives at the CSS layer (the class's own `@media (prefers-reduced-motion: reduce)` block), not in `beacon.ts` — the selector is presentation-agnostic; only the visual expression of "this is the anchor" changes under PRM.

### Entrance keyframes are from-only — do not add a `to{}` block

`octo-enter-fade` / `octo-enter-pop` / `octo-enter-rise` (backing `.octo-fade-in` / `.octo-pop-in` / `.octo-rise-in` / `.octo-overlay-enter` / `.octo-modal-enter` / `.octo-menu-enter`) declare **only a `from{}` block** — no `to{}`. This is a fixed bug, not a stylistic choice: a `to{}` block combined with `animation-fill-mode: both` pins the element's opacity/transform at the animation's end state *forever*, silently overriding whatever utility opacity the element should settle into (e.g. an essence card's `opacity-[0.38]` or a settled row's `opacity-45`) — the depth-of-field dimming never actually rendered while the bug was in place. From-only keyframes animate *to the element's own underlying computed style* and then hand control back to it, so `0 → 0.38` (or whatever the resting opacity is) applies correctly and hover/focus opacity bumps keep working. `animation-fill-mode: both` still back-fills the `from` state during a stagger `animation-delay`, so there's no flash-of-unstyled-content. The one exception is `.octo-rise-in`, which fills `backwards` only: its forward fill is a visual no-op, but an animation still in effect on `transform` makes the row the containing block for its `fixed` descendants (the flyout of Run's former session rail landed under the terminal because of it), and `backwards` keeps the stagger back-fill.

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
│    │ ContextHeader                   │                   │
│ R  │        Modes       status tail  │                   │
│ a  │   Canvas                        │   Companion       │
│ i  │   (Talk | Run | Review | Direct)│   (per-mode)      │
│ l  │                                 │                   │
│    │   Input bar                     │                   │
└────┴─────────────────────────────────┴───────────────────┘
```

| Surface       | Width | Notes |
|---------------|-------|-------|
| Rail          | 280px / 44px | **The index** — one surface, serif project lines, bare tinted glyphs, unboxed mono meta, a 2px state-only edge (brass active / marching), the single beacon; collapsed it is the slim rail (44px, 32px cells). See "Workspace rail — the index" below. Groups (project sections and mission folders) are in the rail: see "Rail groups" below. |
| ContextHeader | flex  | Floating card, and its own `@container`. One grammar in both states: a mono **eyebrow** carrying every piece of meta (intent · sandbox · ticket chain · status · branch chip · base) over a serif **name** line — the ticket summary, or the workspace name when no ticket resolves. The name owns the full width, so a 160-character branch can never squeeze it out; the branch is middle-truncated with its full provenance in a popover, and the demotion ladder (E2 above) sheds meta as the column narrows. Identity only — never the modes. Pads 12px inline and 6px block; `--shell-stack` above and below it. |
| ModeBand      | flex  | Its own line between the ContextHeader and the canvas, spanning the canvas column only (never over the Companion). `1fr/auto/1fr` grid: switcher centred on the canvas, the active mode's status tail (mono caps, mute) in the right track; `--shell-stack` below it. In Run that track holds a control, the **session line** (see "Run mode — session navigation"), and keeps a floor for it. The band is its own `@container` and ladder: narrow, the switcher's inactive modes shed their labels (see "The mode band's ladder" under the elision doctrine). |
| ModeSwitcher  | auto  | A segmented control: pill on onyx bounded by `border-strong` (a control edge, not a panel divider — see §1), **lucide icon + mono/caps label** per segment, brass-ghost fill on the active mode with a brass indicator that glides *and* resizes to each segment. Four modes: Run (`SquareTerminal`) / Talk (`MessageSquare`) / Review (`GitCompare`) / Direct (`Waypoints`). Icons go on **all four** — iconising only one segment reads as a special case rather than a mode — and the labels stay, because mode navigation is where a wrong guess costs the most; only a narrow band sheds them, and only on the inactive modes, which keep icon, tooltip and name. |
| Canvas        | flex  | Active mode content (chat / terminal panes, each under its caption / diff / pipeline track+focus pane). Ends `--shell-foot` above the status bar. |
| Companion     | 280px | Per-mode panels, under one grammar (see "Companion grammar" below): Context+History · Context · Changes · Mission · Changed+commit · Runs+Jira. |
| Input bar     | flex  | Serif placeholder, ⌘K kbd hint. |

**Mode canvases at a glance:**
- **Talk** — chat timeline. Companion: Context + History.
- **Run** — terminal panes, each under its caption; the band's right track is the session line. Companion: context · changes · mission.
- **Review** — unified diff. Companion: how the change was built + branch & publish.
- **Direct** — horizontal assembly-line track + focus pane. Companion: runs + logbook. The 4th mode is per-workspace and optional; the trinity is always present.

Don't add chrome outside these surfaces. If a feature needs something new, propose extending the grammar in the spec — don't add it ad-hoc.

### Shell spacing (2026-11-18)

The air between the standing surfaces is three tokens (section 3), all 8px, on the 4px scale. Spec: `docs/superpowers/specs/2026-11-18-run-mode-and-rail-groups-design.md`, Part 5.

| Gap | Token | Where it is applied |
|-----|-------|---------------------|
| Rail to `<main>`, `<main>` to Companion | `--shell-gutter` | `<main>` in `App.tsx` (`mx-[var(--shell-gutter)]`) |
| Above the ContextHeader, header to mode band | `--shell-stack` | `ContextHeader.tsx` (`my-[var(--shell-stack)]`) |
| Mode band to canvas | `--shell-stack` | `ModeBand.tsx` (`mb-[var(--shell-stack)]`) |
| Canvas foot, above the status bar | `--shell-foot` | the canvas column in `App.tsx` (`pb-[var(--shell-foot)]`) |

Three rules:

1. **The shell is shared.** The same gaps hold in Run, Talk, Review and Direct, and with the rail or the Companion folded. A mode never adds its own outer margin to the canvas. If one mode needs air, it pads inside its own canvas.
2. **Change the token, not the class.** A surface that sits in the shell reads these tokens; it doesn't restate `8px` or reach for `mx-4`. `shellSpacing.test.ts` checks that the CSS and TypeScript values agree and that these four elements read the tokens.
3. **Inner spacing is the surface's own.** The tokens govern the gaps *between* surfaces. The rail's rows, the ContextHeader's padding (12px inline, 6px block) and the Companion's sections keep their own scale values.

### Workspace rail — the index (2026-09-20)

The left rail lists projects and their missions as a **typeset index**, not a
file explorer. Spec: `docs/superpowers/specs/2026-09-20-workspace-rail-index-redesign-design.md`.
Seven rules, each a direct consequence of §1, §6 and §9 (rail groups, below, add their own):

1. **One surface.** No project cards, no bordered monograms, no chips. The rail
   is `panel` with one right hairline; hierarchy is carried by type (a 28px
   Spectral project line over 32px sans rows) and space (12px between projects).
   A mission group adds one more cue of the same kind, an indent beside a 1px
   guide (see "Rail groups" below): a line beside the rows, never a box
   around them. A project group adds a hairline across the rail above its
   eyebrow, and a loose project right after a group takes one to close it: a
   line between blocks, never a card around them.
2. **The edge speaks of state, never identity.** A reserved 2px slot at the
   row's left: brass on the active row, `.rail-bar-running` marching segments
   while the workspace works (brass on the active row, **sage** elsewhere —
   §7's "no status in brass"), transparent at rest. The workspace tint never
   colours the edge.
3. **The glyph is the one carrier of the tint.** A bare 20px Spectral glyph in
   the tint accent — no border, no fill. Customisation (glyph + tint) gains
   visibility because nothing else on the row is coloured. A mission group's
   tint sits on the group's own two marks (its chevron and its guide), beside
   the rows and never on one: a member's glyph keeps its own tint.
4. **Meta is unboxed mono.** Ticket in sage, `↑N`/`↓N` in mute, PR in
   verdigris, uncommitted changes as a glyph; `.octo-tabular`; every glyph with
   a `title`. Header aggregates (`N missions · dirty · PRs`) appear only while
   the project is **folded** — a count visible in the list is never repeated in
   its header.
5. **The project line is quiet.** Hexagon mark in mute (the project's tint only
   when the user chose one, so N projects never mean N brass hexagons; in a
   tinted project group an untinted project's hexagon takes the group's tint), name in
   Spectral 13 (ivory for the project holding the active workspace), actions
   revealed on hover/focus (new mission · grip · chevron).
6. **One beacon.** `resolveAttention()` gives the pulse to the flagged workspace
   waiting longest (`flag.since`, the first ping of the current wait — never the
   latest `at`) and a static 5px brass dot to every other; the active
   workspace and a running one never signal (the marching edge owns that row).
   `.animate-attention-pulse` falls back to a static `--brass-dim` halo under
   `prefers-reduced-motion`. When a fold hides the flagged workspace, the
   signal walks up to its **nearest visible ancestor**
   (`nearestVisibleAncestor` in `lib/beacon.ts`, `resolveAttentionCarriers`):
   the project group's header when that group is folded (its chevron pulses),
   else the project line when the project is folded (its mark pulses), else
   the mission-group header (its chevron pulses). A container hiding several
   signals shows the strongest: the pulse, otherwise one static dot. Still
   exactly one beacon.
7. **Collapsed, it is the slim rail.** 44px (the geometry of Review's
   collapsed navigator), 32px cells, the same reserved edge, one cluster per
   project headed by its mark (a project group's clusters stand together
   between two hairlines that span the rail), and a `fixed`
   hover/focus flyout in the MenuSurface chrome (project · name · status ·
   `⌘N`; the eyebrow names the groups too, outermost first:
   `project group · project · mission group`) instead of a native
   title.

The search line is the rail's only chrome: a borderless `Search` icon with an
upright-serif placeholder whose bottom hairline turns brass on focus, and the
one `+` icon button (Add project) beside it. Hits are washed with the
found-match tokens (§4). Nothing else in the rail carries a border around
anything: a mission group's guide is a 1px line beside its rows, and a
project group's hairline is a 1px line between blocks.

#### Rail groups (2026-11-18 · mission groups, project groups and groups everywhere else shipped)

Spec: `docs/superpowers/specs/2026-11-18-run-mode-and-rail-groups-design.md`,
Part 1. **Both are in the rail**: mission groups (`RailMissionGroup.tsx`) and
project groups (`RailProjectSection.tsx`; in the code a project group is a
"section", because `ProjectGroup` already names a project with its missions).
Beyond the rail they show in ⌘K, Mission Control and the archived-workspaces
modal, and the rail adds `⌘⌥G` **Move to group…** and a multi-selection of
missions: see "Groups beyond the rail, as built" below.

A **group** is a named, optionally tinted, foldable run of items: one
membership per item, no nesting, and it survives being emptied (it reads
`empty` until the user removes it). It adds two row types, so the rail has
four levels with **one signature each**:

| Level | Signature |
|-------|-----------|
| Project group (a section) · *shipped* | A hairline above, then a caps eyebrow: 26px, mono 9px, tracking 0.25em, mute. Its projects are not indented. Fold chevron on hover, focus or while folded. |
| Project | Hexagon + serif name (rule 5, unchanged). |
| Mission group (a folder) · *shipped* | A 28px header: an always-visible chevron in the monogram column, the name in mono 11px, normal case, sage. Its members are indented 14px beside a 1px guide that stops at the last member. |
| Mission | Glyph + sans name (rule 3, unchanged). |

Each cue means one thing: a hairline with an eyebrow is always a section of
projects; indentation with a guide is always one group of missions. Neither
is used for anything else in the rail.

**The tint rule.** A group's tint is drawn on its own two marks only: its
chevron and its guide (the guide at 50% opacity). **Monograms are never
recoloured**, so rule 3 stands. A project's hexagon may take its
section's tint, and only when the project has no tint of its own. The palette
is the seven `TINTS` of `lib/monogram.ts` plus None; no new hues, and brass
is never a group's default. The name always carries the meaning; the tint is
a secondary cue (WCAG 1.4.1).

**The mission group, as built.** Keep these when touching it:

- **Geometry.** The chevron is a 12px lucide `ChevronDown` centred in the
  20px monogram column (so it stands exactly over the guide), in the group's
  tint, mute when untinted; it rotates −90° when folded and is never hidden.
  Members are the normal 32px rows with `pl-7` instead of `pl-3.5` (14px in).
  The guide is 1px at 24px from the rail's edge, from the top of the first
  member to 5px above the foot of the last, in the tint at 50% opacity
  (`--color-octo-border-strong` when untinted), drawn over the rows' hover and
  active grounds. 2px above the group and 6px below it.
- **The edge stays outside.** Member rows keep their full width, so the brass
  active bar and the marching edge (rule 2) remain at the rail's left edge,
  left of the guide.
- **Counts under rule 4.** The header shows its member count, a verdigris PR
  glyph and the attention dot **only while folded**. `empty` (mute) is the one
  exception: an empty group has no list to read it from. A folded header never
  marches; state stays on rows.
- **Folded over the active mission**, the name reads in ivory, the cue the
  project line gives (rule 5). Open, it stays sage: the active row is in
  sight and says it. No new colour, and never brass.
- **One tab stop.** The header is a button with `aria-expanded`: click folds,
  `←`/`→` fold and unfold, double-click or `F2` renames in place, `⇧F10` or
  the context-menu key opens its menu. Its hover `+` is not a tab stop (the
  menu carries the same action for the keyboard).
- **Folds** use the grid-rows idiom and persist in localStorage
  (`railGroupCollapsed`), like the project fold; a live filter unfolds
  everything without touching the stored state.
- **Placement.** A group stands where its first member stands; loose missions
  never move for it (`layoutMissions` in `lib/railGroups.ts`).
- **Collapsed (44px).** The guide stays as a 1px tinted line beside the
  group's monograms, under a 12px tinted chevron titled with the group's name
  that folds it; 6px of air above and below the group.
- **Drag.** A mission dropped on a group joins it; dropped on the project's
  loose area it leaves; a header dropped on a sibling takes its place. The
  accepting header takes a `--brass-ghost` wash, the one new use of brass here
  and an active state by §7.

**The project group, as built.** Keep these when touching it:

- **Geometry.** A 1px `--color-octo-hairline` across the rail, 6px of air,
  then a 26px header padded like a project line (`pl-3.5 pr-2`). The name is
  the eyebrow: mono 9px caps, tracking 0.25em, mute, sage on hover. Its
  projects are the normal project lines at the outer alignment: no indent, no
  guide. A group that opens the rail has no hairline above it. 10px separate
  a loose project's last row from the hairline of a group below it.
- **Where it ends.** A section has no closing mark of its own. The next
  group's hairline ends it, or the hairline a **loose project takes when it
  comes right after a group** (2px, the hairline, 10px, then its line). A
  bare hairline therefore always reads "a group ended here"; nothing else in
  the rail draws one.
- **The chevron** is a 12px `ChevronDown` at the right end of the header, in
  the group's tint (mute when untinted). It shows on hover, on focus and
  while folded, where it rotates −90°. It is `aria-hidden` pointer
  decoration; the eyebrow button is the one tab stop (`aria-expanded`), with
  the mission group's keys: `←`/`→`, `F2`, `⇧F10` or the context-menu key.
- **Tint.** On the chevron, and on the hexagon of each project that has no
  tint of its own (`projectMarkColor`). No guide, so no tinted line. A
  mission's monogram is never recoloured.
- **Counts under rule 4.** `N projects` and the attention dot only while
  folded; `empty` always. Folded over the active mission the eyebrow reads in
  ivory, the project line's cue; never brass.
- **Placement, and pinned projects.** `layoutProjects` never reorders
  projects (pinned first, then the manual order). A group stands where its
  first project stands and gathers the rest under it. **A pinned project
  stays in its group**, leads it, and brings the group up into the pinned run;
  pinning takes no project out of its group and moves no other group. The
  groups' own `sortOrder` is not a law between them here (projects have a
  manual order, missions don't): it only orders the empty groups, which stand
  last.
- **Drag.** The pointer says which container a dragged project is over; the
  block's centre only picks a place inside it (a block is tall and is held by
  a grip at its top, so its centre is far from where the user points). Over
  another group, anywhere on it, the project **joins as that group's last
  project**, always, and that group's header takes the `--brass-ghost` wash.
  Over its own group it is reordered. Anywhere else it is on the ungrouped
  top level and leaves its group: beside the nearest top-level block, or last
  when dropped on the ungrouped area under the rail's last block, which draws
  nothing. A group dragged by its header moves as one unit, by the sortable
  list's own transform: **no `<DragOverlay>`** for a project or a group (it
  would stop the dragged block following the pointer).
- **The drop cue is on the dragged block,** where the eye is: the opaque
  block covers the target's eyebrow, so its wash alone can go unseen. While
  a project drag would change membership, the block's top line shows,
  right-aligned in the eyebrow type, `Into {group}` in brass (the drop would
  join that group: an active state) or `Out of {group}` in mute (it would
  leave its group). Nothing for a reorder, nothing for a group dragged as a
  whole. It sits over the line's end on the block's own ground, so the block
  never resizes; a long name ends in an ellipsis; it crossfades with
  `octo-fade-in` when the target changes. The cue, the target's wash and the
  drop are one resolution (`resolveTopDropWithCue`), so the label cannot
  disagree with the result. The target eyebrow keeps its wash.
- **A dragged block is a lifted surface.** The block itself moves (there
  is no overlay), across other blocks and other groups' eyebrows, so while
  it is dragged it wears `DRAGGED_BLOCK` (`lib/railDnd.ts`): the menus' own
  ground and lift (`LIFTED_GROUND` in `lib/menuStyles.ts`: `bg-octo-panel`
  and their shadow), a hairline ring (so it keeps its size), `rounded-md`,
  and `z-10`. It is opaque and its content keeps full opacity: the thing
  under the pointer is never dimmed. The ground is `panel`, never `panel_2`,
  because `panel_2` recesses in Vellum (§1.1, rule 5) and would read as a
  slab. A group holding its own dragged project is raised to `z-10` as
  well: its filled `octo-fade-in` entrance makes it a stacking context,
  which would otherwise trap the project under every later block.
- **A dragged block is moved, never scaled.** Only the translation of
  dnd-kit's transform is written (`blockShift` in `lib/railDnd.ts`); written
  whole, it scales the block to the size of what it is over and pulls it off
  the pointer. Over a target outside its own list the block follows the
  pointer by the drag's delta (`useFollowPointer`), so it never snaps back
  mid-drag; a group lifts its fold's clipping while one of its own projects
  is dragged, so the block never vanishes at the group's edge; the list's
  scroll is held to its own room for the length of the drag. Keyboard: a
  project's grip steps through projects in any group; a group moves with its
  menu's **Move up** / **Move down**, each offered only when the step would
  show (never one the pinned-first order would undo). An empty group has no
  project to drag: its **Move up** / **Move down** trade places with its
  neighbour among the empty groups at the foot, and it never steps above a
  group with projects (`stepEmptySection`).
- **A move draws once.** A project's new group and its new place reach the
  rail in one update, before the backend answers: the group never jumps to
  an in-between layout. A refused move puts both back with one toast,
  `Couldn't move {project}` / `Your rail is back as it was.`; nothing fails
  silently.
- **One meaning for "New group" per menu.** In a project's menu the group
  action is **Move to group ›**, about project groups, and its **New group…**
  makes a group that already holds the project. The mission-group action in
  that menu reads **New mission group** (`FolderPlus`) and sits with the
  project's missions, a block away. A group made from an item never starts
  empty.
- **Escape takes a new group back.** A group made from a project, a mission
  or a selection opens with its name in edit; Escape there deletes it and
  returns each member to where it was, so the gesture leaves no trace. Once
  that first name is in, Escape on a rename only keeps the old name.
- **Collapsed (44px).** A sub-cluster: the group's project clusters between
  two hairlines that span the rail (`w-full`), where the hairline between two
  projects is 20px. No name, no fold and no header control at this width; a
  project's mark is titled `group · project` and the flyout's eyebrow starts
  with the group. Hexagons keep the inherited tint.

**Groups beyond the rail, as built.** Keep these when touching them:

- **⌘K, a Groups section.** One row per group, in the rail's reading order
  (`paletteGroups`). The glyph box holds the group's own mark, the 12px
  chevron in its tint (mute untinted): the palette borrows the rail's sign
  for "this holds things and folds" rather than inventing a glyph. Name over
  a mono meta line (`acme-api · 3 missions`, `2 projects`, `empty`), the
  Workspaces row's two-line recipe. Choosing it **reveals** the group:
  every fold above it opens, a filter that hides it is cleared, the slim
  rail opens, and the header takes the focus. The palette is navigation
  only; it has no sub-steps or text entry, so renaming and moving stay with
  the header's own keys and menus. A mission row's meta reads
  `project · group · branch`, outermost first like the slim rail's flyout.
- **Mission Control, `group · workspace`.** The card's workspace atom gains
  the mission group's name before it, in the same mute mono with a `·`; the
  group truncates first (`shrink-[100]`). Nothing when ungrouped. No tint
  (the tint lives on the rail's chevron and guide), no chip, no new band.
- **The archived-workspaces modal** names a mission's group before its
  branch (mute mono, `Fixes ·`). Restoring returns the mission to that group
  if it still exists, else it comes back loose; a group that is gone shows
  nothing, so the modal never promises a return it cannot make.
- **The keyboard's Move to group (`⌘⌥G`).** Rail-scoped: the rail's own
  `keydown` hears it only on a focused mission row or project line. The
  editor's and the scratchpad's `⌘⌥G` (go to line) are CodeMirror keymaps
  that only hear keys pressed in them, so the chord means one thing wherever
  the focus is, and no global binding is spent. It opens the submenu's
  choices as a menu of their own at the row (`MoveToGroupMenu`, MenuSurface
  chrome, `octo-menu-enter`; `⌘⌥G` on a Mac only, never Ctrl+Option, which
  is VoiceOver's; Ctrl+Alt+G elsewhere), with a mono header `Move to group` (`Move N missions to group` for a selection), the
  current group focused first and type-ahead on the group names. A mission
  row now also answers `⇧F10` and the context-menu key, like a project line
  and a group header, so every rail row has a keyboard path to its menu.
- **The selected row.** A multi-selection of missions (`⌘`-click on a Mac,
  Ctrl-click elsewhere; `⇧`-click; one project) has no colour of its own.
  A selected row that is neither active nor working takes a **static 2px
  sage bar in the identity edge's reserved slot** (`IdentityEdge`'s
  `selected`), and holds the hover ground (`bg-octo-panel-2`) and an ivory
  name. The edge is what tells it apart from a hovered row, which changes
  only its ground and name: in Onyx `panel_2` on the rail is about 1.06:1,
  too close to read alone. Sage, because the edge already speaks sage for
  "working" elsewhere in the rail and never brass for a status (§7); static,
  because marching is the working edge's. The active row keeps its brass
  edge and brass-ghost ground even when selected, and a working row keeps
  its marching edge, so brass still marks the one place you are. The
  selection holds only rows the rail draws: a row archived or deleted away,
  or folded out of sight (its group, project or project group), leaves it,
  so the menu's count always matches what is on screen.
  The selection's menu (`Group N missions…`, `Move N missions to group ›`,
  `Clear selection`) is plain MenuSurface rows. Missions only: projects have
  no multi-select.

### Run mode — session navigation (shipped 2026-11-18)

Spec: `docs/superpowers/specs/2026-11-18-run-mode-and-rail-groups-design.md`,
Parts 2 and 3. Terminal navigation lives in the mode band, never in the
Companion: the Companion collapses, and a collapse must not remove the only
way to change session. Two surfaces, each with one job:

- **The session line switches.** The band's right track holds one 24px cell per
  session, in session order, then `+`, a hairline and the layout button. It
  costs no chrome of its own. (It replaced a 44px rail on the canvas's left
  and a one-session anchor in the band.)
- **The pane caption is the session's one home.** Name, rename, what it is
  doing, the waiting state, the Restored badge, its `⌘⌥N` and its actions are
  on the caption of the pane that shows it, and nowhere else. Every pane has
  one, a lone pane too. A fact with two homes drifts.

The rules, reusable wherever a set of live things needs a compact switcher:

- **The icon is the identity; the number is the address.** A 24px cell holds
  one glyph well and two badly, so it carries the session's **role icon** at
  rest and flips to its `⌘⌥N` number while **⌥** is held (`useModifierPeek` —
  ⌥ only, or every plain ⌘ shortcut would flash the line on its way past).
  The hint arrives when the hand is already on the modifier — and nothing lives
  only behind the gesture: the number is also in the instant label, on the pane
  caption and in the `⌘⌥K` switcher.
- **An icon must encode difference.** A terminal glyph on every session says
  "this is a terminal" once per session — information the user already has. The
  session icon names what is *running* instead (`lib/sessionRole.ts` →
  `iconForSessionRole`): shell `ChevronRight` · dev `Globe` · build `Hammer` ·
  test `FlaskConical` · deps `Package` · git `GitBranch` · agent `Sparkles` ·
  editor `PenLine` · unclassified `Terminal`. Roles are **sticky** — only a
  placeable command replaces one — so identity survives the quiet between
  rebuilds (S1: slots hold their meaning while things run).
- **One channel per fact.** Two facts on one channel fight: a focused session
  that was busy could only show one of them. So:
  - the icon's **ink is presence** — ivory in a pane, mute off screen. Never
    brass: five busy sessions must not put five brass icons on screen (§7,
    "no status in brass");
  - the underline's **colour is focus** — a reserved 2px slot under the icon,
    brass on the focused pane's session and nowhere else;
  - the underline's **motion is work** — it marches while a command runs
    (`.rail-bar-running-x`, the workspace rail's idiom laid horizontally): sage,
    or brass on the focused session, which is focus and work at once. Reduced
    motion shows a solid bar.
  - a **static 5px brass dot** is attention, which the app already spends brass
    on: the session rang, or Claude Code waits on the user there, while it is
    not the one in focus. Static, not a second pulse, because the mode
    switcher's pulse owns that signal at the scope above (Law 2).
- **The label is instant and has no actions.** Hovering a cell, or focusing it
  from the keyboard, opens a label under it with no delay: the name in sans,
  then what the session is doing and its `⌘⌥N` in mono. It is the name the
  icon alone can't give — a native `title` takes about a second, and six of
  eight sessions can share one glyph. It carries nothing to click (actions
  have one home, the caption), it is `aria-hidden` (the cell's accessible name
  is the same text), and it enters and leaves with `.octo-fade-in` /
  `.octo-fade-out`.
- **A pane has no `×`.** Taking a pane off screen keeps its session running,
  and `×` reads as "close" everywhere else: a session that looks closed while
  its agent keeps spending is the worst outcome here. Leaving the view is a
  **minus** (*Leave the view · the session keeps running*), in a split view
  only; Talk's terminal seat closes with the same minus. Closing is by name, in the caption's `⋯` menu, sage until hovered
  (`MENU_ITEM_ROUGE`).
- **The layout button shows the layout.** Its glyph is the panes on screen
  (`PaneLayoutIcon`: one frame and its dividers, a single family for one to
  four panes). Pane count and orientation are chosen there, not in a pane's
  menu: they belong to the view, not to a session.
- **Narrow, it sheds whole atoms, down to a floor** (E2). The cells fold from
  the left into one `N sessions` button that opens `⌘⌥K`; narrower still that
  button is a list icon. The fold button, the focused session's cell, `+` and
  the layout button are the floor and never go: the mode band reserves their
  width (`tailMin`) and sheds the switcher's inactive labels to make room
  (see "The mode band's ladder" under the elision doctrine). Past eight
  sessions the last cell reads `+N`.
- **A menu's button toggles it, and gets the focus back.** A press on `⋯` or
  on the layout button while its menu is open closes it and does not open it
  again; when the menu closes (Escape, a press elsewhere, a pick), keyboard
  focus returns to the button (`useAnchoredMenu`). A destructive row is rouge
  on keyboard focus as well as on hover.
- **Closing asks only when something would be lost mid-flight.** An idle
  session closes at once. A busy one (an agent or a command running in it)
  opens a confirm on `ModalShell`, like the Abort confirm: a short question,
  *Keep the session* focused, an upright-serif rouge *Close the session*,
  Escape keeps it. The menu row carries its ellipsis only in that case, and
  `⌘⌥K`'s `⌫` follows the same rule (`useCloseSession`).
- **The focus line needs something to tell apart.** The `border-strong` line
  under the focused pane's caption is drawn only in a split view; alone, a
  caption keeps its hairline.

The band's status tail may become a **control** when the mode has one worth
having — in Run it is the session line (`ModeBand` takes a `ReactNode`). A
keyboard-only switcher is a switcher nobody finds.

**Where the shipped work differs from the spec**, each because of what the
code can do today:

- **Close has no Undo.** A closed session's shell and scrollback are gone
  (`delete_terminal` removes the row and kills the PTY), so there is nothing
  to restore and no toast to offer it. Instead a busy session asks before it
  closes, and an idle one closes at once, as it always did.
- **Cells can't be dragged to reorder.** `terminals.position` is stored, but
  no command changes it. Reordering needs that command first.
- **`+` names no shortcut.** No key is bound to "new session". (`⌘T` was only
  a hint in the command palette, never a binding; the hint is gone.)
- **The attention dot keeps the rule it had:** a session that rang, or waits,
  and is *not the one in focus* (the spec says "off screen"). A session put on
  screen in an unfocused pane keeps its dot until it is answered.
- **The layout menu has one more row.** With two or three panes it adds
  *Automatic orientation*: the way back to the 72-column rule once a two-pane
  row has set an override. A layout that needs more panes than the workspace
  has sessions (plus the one empty seat) is disabled rather than filled with
  several empty seats, and a smaller layout never takes the focused session's
  pane off screen.
- **The floor costs the switcher its centre and its inactive labels.** The
  spec's floor (the focused cell, `+` and the layout button always stay) did
  not fit a small window with the rail and the Companion both open while the
  switcher stayed centred and fully labelled. The band's ladder pays for it:
  the labels shed, and below that the switcher slides left.

### Companion grammar (2026-11-18)

Three rules for the Companion in every mode. Talk, Review and Direct already
follow rules 1 and 2; new Companion work follows all three.

1. **The Companion never repeats the canvas.** It shows what surrounds the
   work on the canvas: what the canvas can't say about itself.
2. **It follows the focus.** Its content describes the focused thing (the open
   chat, the focused pane, the selected run), and says which one when more
   than one is on screen.
3. **A section that doesn't apply is not drawn.** When a section has no
   meaning for the focused thing (a context meter for a plain shell), it folds
   away through the grid-rows idiom; nothing is invented to fill it. A section
   that applies but is empty keeps its one calm line ("No runs yet", "The
   working tree is clean."); those empty states stay.

| Mode | Canvas | The Companion answers |
|------|--------|-----------------------|
| Talk | The conversation | Which chats; how full the context is and what it cost |
| Review | The diff | How the change was built; where the branch stands |
| Direct | The run | The runs and the logbook |
| Run | Terminals | **Context** (the focused pane's Claude Code session: context meter, spend, cache share and model; not drawn for anything else in the pane, or when Octopush can't tell the figures are that pane's current session's) · **Changes** (the workspace's uncommitted files, each row opening Review) · **Mission** (the mission's worked time, spend and savings) |

Run's three sections (`CompanionRun`) follow the spec
`docs/superpowers/specs/2026-11-18-run-mode-and-rail-groups-design.md`, Part 4.
What they share, for any Companion section built after them:

- **One chrome.** Sections hang on `CompanionSection`: one eyebrow each, one
  hairline between them, no framed cards inside the panel. A section that
  folds away as a whole carries the hairline below it, so the rule leaves
  with it and never doubles under the panel header.
- **The eyebrow's `meta` says which one.** A section about one thing (a
  session) or one figure (`3 files · +84 −12`) puts it at the right of its
  eyebrow: mute, in its own case, and the part that truncates.
- **Figures stay with their owner.** A section that follows the focus is
  cleared when the focus moves and shows the newly focused thing's figures
  only once its own answer arrives; an empty or failed read clears it too.
  While it folds away it keeps what it showed until it has left. Where the
  owner can't be established (Run's Context: see `docs/FEATURES.md`,
  "Session usage"), the section is not drawn.
- **Label and value rows** are a mono grid: a caps mute label, a sage value.
- **Brass is spent twice in Run:** the context meter's fill and the serif
  link into Review. A file path keeps its file name whole (`MidTruncate`,
  the tail pinned to the name).

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
- Only the card matching the single beacon (`beaconStageId`, from `lib/beacon.ts`) carries `octo-stage-pulse`; a card's own status color (running verdigris border, awaiting brass, failed rouge, stalled amber) is independent of whether it currently holds the beacon — and the pulse follows that color: a running beacon pulses verdigris (`.octo-stage-pulse-running`), never brass.
- The track scrolls horizontally (`RunFlowNav` chevrons appear only on overflow: "Earlier stages" at the track's left edge, "Later stages" at its right, each beside the stages it brings back); the focus pane below is always visible. An edge that hides stages fades out with a 32px `mask-image` edge-fade (`railEdgeFade`), so a connector whose stage is scrolled away never reads as a broken line.

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

- Format: `saved $0.089 · 86% under all-premium · spent $0.014 · budget $0.50` — verdigris saved value, ivory spent value (a cost is data, never brass), mute labels, all `.octo-tabular`. No baseline ⇒ `baseline unavailable` (the slot never disappears).
- No progress bar beneath: the printed `N% under all-premium` is the one encoding of the savings share (a bar's width restating a printed percentage reads as a second, opposite number, and would put a metric in brass). Clicking the strip unfolds the per-stage breakdown via `<Reveal>`.
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
- Settings panes share one content column: `Settings.tsx` renders every pane
  inside `max-w-[var(--settings-content)]`, so cards and notes end at the same
  x on every tab. A pane never sets a width of its own; one that needs two
  columns (Models, Integrations' issue tracking) splits inside the column.
  `settings/contentWidth.test.ts` fails if a pane brings back a pixel
  `max-w-[…]` (a ModalShell panel is not pane content and is exempt).
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
  (`saved $X · Y% under all-premium · spent $Z`; saved verdigris, spent ivory)
  over active runs only — this
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
