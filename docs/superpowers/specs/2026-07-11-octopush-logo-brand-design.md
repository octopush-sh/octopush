# Octopush logo & brand identity — "The Octo"

**Date:** 2026-07-11 · **Status:** approved via live companion session · **Supersedes:** the `§` logomark (retired from the design language 2026-07-11)

---

## 1. Summary

Octopush gets a real identity: **The Octo** — a minimal geometric octopus creature in solid brass on onyx. Dome head, two negative-space eyes, four front arms as a scalloped hem, four back arms peeking behind in muted brass. It is a mark, a mascot, and a **live status indicator**: the creature's body language (idle / working / pushed / blocked) mirrors the real state of the app.

Decision history (companion session): line-art/diagram marks rejected → radial solid marks rejected → octagon monograms rejected → **abstract creature with personality approved** (A4), de-ghosting variants rejected in favor of the original silhouette, **eight arms via 4+4 depth approved** (E2), animation system approved, **Fraunces wordmark approved** (F2) over Spectral/sans/mono alternatives.

## 2. The mark — canonical geometry

One artwork, `viewBox="0 0 64 66"`. All coordinates are canonical; do not redraw by eye.

```svg
<!-- Back arms (muted brass — token --brass-line; hidden below 20px) -->
<g fill="rgba(212,165,116,0.55)">
  <circle cx="10" cy="48.5" r="5"/>
  <circle cx="21" cy="50"   r="5"/>
  <circle cx="43" cy="50"   r="5"/>
  <circle cx="54" cy="48.5" r="5"/>
</g>
<!-- Body: dome + 4 front-arm scallops (solid brass — token --color-octo-brass) -->
<path fill="#d4a574" d="M10 30 C10 17.8 19.8 8 32 8 C44.2 8 54 17.8 54 30 L54 47
  A5.5 5.5 0 0 1 43 47 A5.5 5.5 0 0 1 32 47
  A5.5 5.5 0 0 1 21 47 A5.5 5.5 0 0 1 10 47 Z"/>
<!-- Eyes: negative space (the surface behind the mark, nominally onyx) -->
<circle cx="25" cy="27" r="3" fill="#0e0c0a"/>
<circle cx="39" cy="27" r="3" fill="#0e0c0a"/>
```

**Animated variant** (see §5) replaces the hem arcs with a flat bottom (`L54 47 L10 47 Z`) plus four separate front-arm ellipses (`cx 15.5/26.5/37.5/48.5, cy 47, rx 5.5, ry 5.2`) so arms can paddle independently. Static and animated variants are pixel-identical at rest.

Anatomy rules:

- **Colors are tokens, never literals, in app code**: body `var(--color-octo-brass)`, back arms `var(--brass-line)`, eyes `var(--octo-eye, var(--color-octo-bg))` — a local CSS variable so surfaces sitting on panel backgrounds can override the eye color to match what's behind the mark. Hex literals are permitted only inside standalone icon assets (`src-tauri/icons/source.svg`, favicon).
- **Adaptive detail:** below 20 px rendered size, drop the back-arm row (it muddies). Eyes scale up slightly at small sizes (r 3 → 3.6 at 16 px). Never drop the eyes — they are the last thing to survive.
- **No gradients, no strokes on the silhouette, no italics anywhere.** The current `source.svg` gradients are retired debt; the new icon is flat.
- Clear space around the mark: ½ head-width (≈ 22 canonical units) on all sides in lockups.

## 3. Wordmark & lockups

- **Face:** Fraunces (variable, `opsz` ≈ 60, weight ≈ 560), upright, tracking −0.02em, color `--color-octo-ivory`-equivalent (`#ece5d8` family token). Chosen because its soft terminals and generous bowls share DNA with the creature; Spectral remains the app's ceremonial UI voice — **Fraunces is brand-only**.
- **Vendoring:** woff2 in `src/assets/fonts/` (pattern: existing Spectral files + OFL license note); obtain via `@fontsource-variable/fraunces` (copy the woff2 + license, keep the dependency dev-only or drop it after copying) or an equivalent subset download. Loaded via `@font-face` in `styles.css`, used **only** by a `.brand-wordmark` class on brand surfaces (welcome, settings header, about). It is not a fourth UI font; body/mono/serif roles are unchanged.
- **Lockups:**
  - *Stacked* (welcome, splash, og-image): mark ≈ 116 px → 18 px gap → "Octopush" Fraunces ≈ 34 px → tagline JetBrains Mono 9.5px, uppercase, tracking 0.35em, `--color-octo-mute`.
  - *Horizontal* (headers, README): mark at cap-height ×1.6, 18 px gap, name at 22–30 px.
- **Tagline:** "an atelier for agentic developers" (unchanged).
- Terminal/ASCII twins (docs & fun surfaces only): multiline `,----. / ( o  o ) / `uuuu'` sketch; single-char fallback `ö`.

## 4. Where the brand lives — surface map

| # | Surface | File anchor | Treatment |
|---|---------|-------------|-----------|
| 1 | macOS app icon | `src-tauri/icons/source.svg` + regenerate via `npm run tauri icon -- src-tauri/icons/source.svg` | Onyx rounded-rect field (rx 229/1024, keep hairline inner border, **no gradients**), mark centered at ≈ 62% field width, back arms included |
| 2 | Dev favicon + title | `index.html` | Add SVG favicon (mark only, transparent bg) |
| 3 | Welcome screen | `src/components/WelcomeScreen.tsx:80-103` | Replace `§` circle with `<OctoMark size={116} state="idle" />` (animated); wordmark → `.brand-wordmark`; tagline unchanged; keep CTA |
| 4 | Top bar — live mascot | `src/components/AppTopBar.tsx:41` (left of RunsTray) | `<OctoMark size={20} state={derived} />` — **the personality hub**: state derived `blocked` if attentionStore non-empty, else `working` if any run/stream active, else `idle`. Tooltip states it plainly ("Octopush — 2 agents working"). No click behavior in v1 |
| 5 | Talk empty state | `src/components/chat/ChatCanvas.tsx:420-435` | Small idle mark (28 px) above the eyebrow |
| 6 | Thinking indicator | `src/components/chat/ChatCanvas.tsx:438-449` | Replace pulsing dot with `<OctoMark size={18} state="working" />` + "Thinking…" |
| 7 | Empty project state | `src/components/EmptyProjectState.tsx:48` | Small idle mark above eyebrow |
| 8 | Settings header | `src/components/Settings.tsx:45` | 18 px static mark before "Octopush" wordmark (`.brand-wordmark`) |
| 9 | About pane | `src/components/settings/AboutPane.tsx:35-37` | Stacked mini-lockup: 48 px static mark above "Octopush." |
| 10 | Session sidebar (legacy) | `src/components/SessionSidebar.tsx:48-49` | Replace 🐙 emoji with 18 px static mark |
| 11 | Run-completion moment | `src/components/RunLedger.tsx:94-99` | Add 20 px `state="pushed"` mark beside the savings line; plays once with the existing `octo-sweep` (not looped) |

**Non-goals (v1):** replacing structural `§ TOOL_NAME` tool-card chrome or Direct's `⟜`/`⟶` connectors (separate initiative); touching ApprovalCard's ShieldAlert (security semantics stay unambiguous); per-row rail monograms; marketing assets beyond og-image guidance.

## 5. Personality system — body language, not badges

One component, four states, all CSS transforms (translate/scale only, 6 animated nodes max). Amplitudes ≤ 2.5 px, easing `var(--ease-octo)` = `cubic-bezier(0.2, 0.8, 0.3, 1)` for moments, `ease-in-out` for loops.

| State | Body | Front arms | Back arms | Eyes |
|-------|------|-----------|-----------|------|
| `idle` | float ±1.6px, 6s | paddle wave 3.4s, stagger 0.45s | same wave, +half-cycle (counter-phase) | blink ~180ms every ~5.6s |
| `working` | float 4.2s | paddle 1.7s | counter-phase | scan ±2.4px side-to-side 4.8s + blink |
| `pushed` | one-shot rise 2.4px & settle | rest | rest | happy arcs (`Q` curves) crossfade; single brass ring (r 13→30, stroke 1.5, fade) — "brass grows", never bounces |
| `blocked` | **everything stops** | frozen | frozen | half-lidded (scaleY 0.45), slow blink 7s |

- Stillness is the blocked signal — the contrast against perpetual idle motion is the alarm.
- `prefers-reduced-motion`: all animation off; state reads from eyes alone (open / half-lidded / happy). Wire through the existing global neutralizer in `styles.css:317-324`.
- Keyframes live in `src/styles.css` under a new `/* Motion · Octo mascot */` section, following the existing `octo-*` primitive naming (`octo-float`, `octo-paddle`, `octo-blink`, `octo-scan`, `octo-rise`, `octo-halo`).

## 6. Component API

`src/components/icons/OctoMark.tsx` (pattern: `icons/ProjectMark.tsx`):

```ts
type OctoState = "static" | "idle" | "working" | "pushed" | "blocked";
function OctoMark({ size = 20, state = "static", className }: {
  size?: number; state?: OctoState; className?: string;
}): JSX.Element
```

- `static` renders the canonical hem-path artwork (no per-arm nodes, no animation classes) — used for icon-like placements.
- Animated states render the split-arm rig with state class `octo-mascot--{state}`.
- Back-arm row auto-hides when `size < 20`.
- `aria-hidden` by default; placements provide their own accessible text.
- Top-bar derived state is computed in `AppTopBar` from existing stores (attention > working > idle); `pushed` is only ever triggered locally (RunLedger moment), never by the top bar in v1.

## 7. Docs, tokens, and hygiene

- **No new color tokens.** Body = `--color-octo-brass`; back arms = `--brass-line`; eyes = surface color.
- **`docs/design-system.md`:** new "Mark & mascot" section — canonical SVG, adaptive-detail rule, state table, do/don't (no gradients, no drop shadows, don't rotate, don't recolor, eyes never dropped).
- **`docs/FEATURES.md`:** update Welcome/Settings/About/Chat entries; add "Live mascot status (top bar)" feature entry.
- **`CLAUDE.md`:** amend the "signature details" list — `§` fully retired as logo; The Octo is the mark.
- Old `source.svg` gradients removed (they violate the no-gradient rule anyway).

## 8. Testing & verification

- Vitest: `OctoMark.test.tsx` — renders static vs animated rigs; back-row hidden < 20px; state class applied; `aria-hidden`.
- Vitest: AppTopBar derived-state test (attention beats working beats idle).
- `npm run typecheck` + full `npm test` green.
- Icon regeneration verified by inspecting generated `icons/*` sizes; app build smoke (`npm run build`).
- Visual: welcome, top bar, thinking indicator, about — checked in dev.
