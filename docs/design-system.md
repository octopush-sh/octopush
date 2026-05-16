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
- **Brass rule:** 28px gradient `linear-gradient(90deg, var(--brass), transparent)` — the signature divider for moments.

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

## 5. Five signature details — preserve always

| Detail        | Where to use                                                        |
|---------------|---------------------------------------------------------------------|
| `&` in brass  | "Octopus & you" branding moments (welcome, about)                   |
| `⟶` in brass | Terminal prompt, command palette prompt, input nudges               |
| `§` in brass  | Tool call cards — `§ READ`, `§ WRITE`, `§ RUN`                     |
| Roman numerals| Multi-step wizards: `STEP I · OF II`, `I.`, `II.`, etc.            |
| Italic phrases| CTAs and placeholders are **phrases in Spectral italic**, not labels|

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

---

## 7. Common mistakes — DO NOT

- ❌ `text-violet-400` or any Tailwind palette color from outside the `--color-octo-*` namespace.
- ❌ Hardcoded hex (`#a78bfa`, `bg-[#101013]`). Tokens or nothing.
- ❌ `text-2xl font-bold` for a "page title" — use `font-serif italic` H1 spec.
- ❌ `"+ New Project"` CTA — should be `"Begin a new study"` or similar italic-serif phrase.
- ❌ Adding a new tab system anywhere.
- ❌ A 4th font. A 12th color. A new accent. (Update the spec instead.)
- ❌ `transition: all` — be specific about what's animated.
- ❌ Icons from outside `lucide-react` (we standardized).

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
| ModeSwitcher  | auto  | Top right. Brass-ghost pill on active mode, brass indicator glides. |
| Canvas        | flex  | Active mode content (chat / terminal / diff). |
| Companion     | 280px | Per-mode panels: Context+History · Terminals+Quick · Changed+commit. |
| Input bar     | flex  | Italic-serif placeholder, ⌘K kbd hint. |

Don't add chrome outside these surfaces. If a feature needs something new, propose extending the grammar in the spec — don't add it ad-hoc.
