# The Octo — Logo & Mascot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the retired `§` logomark with The Octo — an animated brass octopus mark/mascot — across all 11 brand surfaces, per `docs/superpowers/specs/2026-07-11-octopush-logo-brand-design.md`.

**Architecture:** One `OctoMark` React component renders both a static artwork and an animated rig driven purely by CSS classes (`octo-mascot--{state}`) defined in `src/styles.css`. A `useMascotState` hook derives the top-bar live state from existing Zustand stores. The app icon and favicon are standalone SVG assets regenerated via `tauri icon`.

**Tech Stack:** React 19 + TypeScript, Tailwind v4 tokens, Vitest + @testing-library/react (jsdom), Tauri 2 CLI for icons, Fraunces variable font vendored as woff2.

## Global Constraints

- **Tokens, never literals, in app code**: body `var(--color-octo-brass)`, back arms `var(--brass-line)`, eyes `var(--octo-eye, var(--color-octo-bg))`. Hex allowed only inside `src-tauri/icons/source.svg` and `public/favicon.svg`.
- **No gradients anywhere** (including the regenerated app icon). No italics (`font-style: normal` everywhere). No bounce/spring motion; loops use `ease-in-out`, moments use `var(--ease-octo)`; amplitudes ≤ 2.5px.
- All animation respects `prefers-reduced-motion` (global neutralizer already exists at `src/styles.css:317-324`; the mascot section adds its own belt-and-suspenders rule).
- Canonical geometry is `viewBox="0 0 64 66"`; never redraw coordinates by eye — copy them from this plan.
- Back-arm row hidden when rendered `size < 20`. Eyes are never dropped.
- UI copy in English. `npm run typecheck` and `npm test` must pass at every commit.
- Working branch: `redesign-octopush-logo` (already an isolated worktree).

---

### Task 1: `OctoMark` component + mascot motion CSS

**Files:**
- Create: `src/components/icons/OctoMark.tsx`
- Create: `src/components/icons/OctoMark.test.tsx`
- Modify: `src/styles.css` (append a new motion section after the `octo-flash` block, i.e. after line ~315)

**Interfaces:**
- Produces: `export type OctoState = "static" | "idle" | "working" | "pushed" | "blocked"` and `export function OctoMark({ size?: number, state?: OctoState, className?: string })`. Later tasks import both from `"./icons/OctoMark"` (or relative path).

- [ ] **Step 1: Write the failing test**

`src/components/icons/OctoMark.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { OctoMark } from "./OctoMark";

describe("OctoMark", () => {
  it("renders the static artwork with no animation classes", () => {
    const { container } = render(<OctoMark size={48} />);
    expect(container.querySelector(".octo-mascot")).toBeNull();
    expect(container.querySelector("svg path")).not.toBeNull();
  });

  it("applies the state class on animated rigs", () => {
    const { container } = render(<OctoMark size={48} state="working" />);
    expect(container.querySelector("svg.octo-mascot.octo-mascot--working")).not.toBeNull();
  });

  it("hides the back-arm row below 20px and shows it at 20px+", () => {
    const { container: small } = render(<OctoMark size={16} state="idle" />);
    expect(small.querySelector(".octo-m-b1")).toBeNull();
    const { container: big } = render(<OctoMark size={20} state="idle" />);
    expect(big.querySelector(".octo-m-b1")).not.toBeNull();
  });

  it("renders the halo ring only in the pushed state", () => {
    const { container: pushed } = render(<OctoMark size={48} state="pushed" />);
    expect(pushed.querySelector(".octo-m-ring")).not.toBeNull();
    const { container: idle } = render(<OctoMark size={48} state="idle" />);
    expect(idle.querySelector(".octo-m-ring")).toBeNull();
  });

  it("is decorative by default (aria-hidden)", () => {
    const { container } = render(<OctoMark />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/icons/OctoMark.test.tsx`
Expected: FAIL — "Cannot find module './OctoMark'" (or equivalent resolve error).

- [ ] **Step 3: Write the component**

`src/components/icons/OctoMark.tsx`:

```tsx
export type OctoState = "static" | "idle" | "working" | "pushed" | "blocked";

interface OctoMarkProps {
  /** Rendered width in px; height keeps the 64:66 canonical ratio. */
  size?: number;
  /** "static" renders the plain artwork; the rest are CSS-animated rigs. */
  state?: OctoState;
  className?: string;
}

/** The Octo — Octopush's mark and mascot (spec:
 *  docs/superpowers/specs/2026-07-11-octopush-logo-brand-design.md).
 *  Solid brass creature on the surface behind it: dome head, two
 *  negative-space eyes, four front arms, four muted back arms.
 *  Body language mirrors app state: idle floats, working paddles and
 *  scans, pushed rises once with a brass halo, blocked freezes.
 *  Below 20px the back-arm row is dropped; the eyes never are. */
export function OctoMark({ size = 20, state = "static", className }: OctoMarkProps) {
  const height = Math.round((size * 66) / 64);
  const showBack = size >= 20;
  const eyeR = size < 24 ? 3.6 : 3;
  const eyeFill = "var(--octo-eye, var(--color-octo-bg))";

  const backArms = showBack ? (
    <g fill="var(--brass-line)">
      <circle className="octo-m-b1" cx="10" cy="48.5" r="5" />
      <circle className="octo-m-b2" cx="21" cy="50" r="5" />
      <circle className="octo-m-b3" cx="43" cy="50" r="5" />
      <circle className="octo-m-b4" cx="54" cy="48.5" r="5" />
    </g>
  ) : null;

  if (state === "static") {
    return (
      <svg
        width={size}
        height={height}
        viewBox="0 0 64 66"
        aria-hidden="true"
        focusable="false"
        className={className}
      >
        {backArms}
        <path
          fill="var(--color-octo-brass)"
          d="M10 30 C10 17.8 19.8 8 32 8 C44.2 8 54 17.8 54 30 L54 47 A5.5 5.5 0 0 1 43 47 A5.5 5.5 0 0 1 32 47 A5.5 5.5 0 0 1 21 47 A5.5 5.5 0 0 1 10 47 Z"
        />
        <circle cx="25" cy="27" r={eyeR} fill={eyeFill} />
        <circle cx="39" cy="27" r={eyeR} fill={eyeFill} />
      </svg>
    );
  }

  return (
    <svg
      width={size}
      height={height}
      viewBox="0 0 64 66"
      aria-hidden="true"
      focusable="false"
      className={`octo-mascot octo-mascot--${state}${className ? ` ${className}` : ""}`}
    >
      {state === "pushed" && (
        <circle
          className="octo-m-ring"
          cx="32"
          cy="30"
          r="13"
          fill="none"
          stroke="var(--color-octo-brass)"
          strokeWidth="1.5"
          opacity="0"
        />
      )}
      <g className="octo-m-body">
        {backArms}
        <path
          fill="var(--color-octo-brass)"
          d="M10 30 C10 17.8 19.8 8 32 8 C44.2 8 54 17.8 54 30 L54 47 L10 47 Z"
        />
        <g fill="var(--color-octo-brass)">
          <ellipse className="octo-m-f1" cx="15.5" cy="47" rx="5.5" ry="5.2" />
          <ellipse className="octo-m-f2" cx="26.5" cy="47" rx="5.5" ry="5.2" />
          <ellipse className="octo-m-f3" cx="37.5" cy="47" rx="5.5" ry="5.2" />
          <ellipse className="octo-m-f4" cx="48.5" cy="47" rx="5.5" ry="5.2" />
        </g>
        <ellipse className="octo-m-eye" cx="25" cy="27" rx={eyeR} ry={eyeR} fill={eyeFill} />
        <ellipse className="octo-m-eye" cx="39" cy="27" rx={eyeR} ry={eyeR} fill={eyeFill} />
        <g
          className="octo-m-happy"
          stroke={eyeFill}
          strokeWidth="2.4"
          strokeLinecap="round"
          fill="none"
        >
          <path d="M21.8 28 Q25 24.8 28.2 28" />
          <path d="M35.8 28 Q39 24.8 42.2 28" />
        </g>
      </g>
    </svg>
  );
}
```

- [ ] **Step 4: Append the mascot motion section to `src/styles.css`**

Insert after the `octo-flash` block (after the `.octo-flash` rule, before the global reduced-motion neutralizer if it follows; otherwise at the end of the motion sections):

```css
/* ── Motion · The Octo mascot ─────────────────────────────────────────
   Body language, not badges: idle floats+paddles, working paddles fast
   and scans, pushed rises once with a brass halo, blocked freezes.
   Spec: docs/superpowers/specs/2026-07-11-octopush-logo-brand-design.md §5.
   All transforms ≤2.5px; loops ease-in-out, moments var(--ease-octo). */
.octo-mascot .octo-m-eye,
.octo-mascot .octo-m-f1, .octo-mascot .octo-m-f2,
.octo-mascot .octo-m-f3, .octo-mascot .octo-m-f4,
.octo-mascot .octo-m-b1, .octo-mascot .octo-m-b2,
.octo-mascot .octo-m-b3, .octo-mascot .octo-m-b4 {
  transform-box: fill-box;
  transform-origin: center;
}
.octo-mascot .octo-m-happy { opacity: 0; }

@keyframes octo-m-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-1.6px); } }
@keyframes octo-m-blink { 0%, 91.5%, 95.5%, 100% { transform: scaleY(1); } 93.5% { transform: scaleY(0.07); } }
@keyframes octo-m-slowblink { 0%, 88%, 100% { transform: scaleY(0.45) translateY(0.6px); } 92% { transform: scaleY(0.07) translateY(0.6px); } }
@keyframes octo-m-scan {
  0%, 12% { transform: translateX(0); }
  20%, 42% { transform: translateX(-2.4px); }
  52%, 78% { transform: translateX(2.4px); }
  88%, 100% { transform: translateX(0); }
}
@keyframes octo-m-rise { 0% { transform: translateY(0); } 30% { transform: translateY(-2.4px); } 100% { transform: translateY(0); } }
@keyframes octo-m-halo {
  0% { r: 13px; opacity: 0; }
  20% { r: 15px; opacity: 0.45; }
  100% { r: 30px; opacity: 0; }
}

/* idle — slow float, paddling wave; back row half a cycle behind */
.octo-mascot--idle .octo-m-body { animation: octo-m-float 6s ease-in-out infinite; }
.octo-mascot--idle .octo-m-f1 { animation: octo-m-float 3.4s ease-in-out infinite; }
.octo-mascot--idle .octo-m-f2 { animation: octo-m-float 3.4s ease-in-out 0.45s infinite; }
.octo-mascot--idle .octo-m-f3 { animation: octo-m-float 3.4s ease-in-out 0.9s infinite; }
.octo-mascot--idle .octo-m-f4 { animation: octo-m-float 3.4s ease-in-out 1.35s infinite; }
.octo-mascot--idle .octo-m-b1 { animation: octo-m-float 3.4s ease-in-out 1.7s infinite; }
.octo-mascot--idle .octo-m-b2 { animation: octo-m-float 3.4s ease-in-out 2.15s infinite; }
.octo-mascot--idle .octo-m-b3 { animation: octo-m-float 3.4s ease-in-out 2.6s infinite; }
.octo-mascot--idle .octo-m-b4 { animation: octo-m-float 3.4s ease-in-out 3.05s infinite; }
.octo-mascot--idle .octo-m-eye { animation: octo-m-blink 5.6s infinite; }

/* working — double tempo, eyes scanning */
.octo-mascot--working .octo-m-body { animation: octo-m-float 4.2s ease-in-out infinite; }
.octo-mascot--working .octo-m-f1 { animation: octo-m-float 1.7s ease-in-out infinite; }
.octo-mascot--working .octo-m-f2 { animation: octo-m-float 1.7s ease-in-out 0.22s infinite; }
.octo-mascot--working .octo-m-f3 { animation: octo-m-float 1.7s ease-in-out 0.44s infinite; }
.octo-mascot--working .octo-m-f4 { animation: octo-m-float 1.7s ease-in-out 0.66s infinite; }
.octo-mascot--working .octo-m-b1 { animation: octo-m-float 1.7s ease-in-out 0.85s infinite; }
.octo-mascot--working .octo-m-b2 { animation: octo-m-float 1.7s ease-in-out 1.07s infinite; }
.octo-mascot--working .octo-m-b3 { animation: octo-m-float 1.7s ease-in-out 1.29s infinite; }
.octo-mascot--working .octo-m-b4 { animation: octo-m-float 1.7s ease-in-out 1.51s infinite; }
.octo-mascot--working .octo-m-eye { animation: octo-m-scan 4.8s ease-in-out infinite, octo-m-blink 7s infinite; }

/* pushed — one-shot rise + halo, happy eyes (no loop) */
.octo-mascot--pushed .octo-m-body { animation: octo-m-rise 900ms var(--ease-octo) 1; }
.octo-mascot--pushed .octo-m-eye { opacity: 0; }
.octo-mascot--pushed .octo-m-happy { opacity: 1; }
.octo-mascot--pushed .octo-m-ring { animation: octo-m-halo 1200ms var(--ease-octo) 1 forwards; }

/* blocked — stillness IS the signal; eyes at half-mast */
.octo-mascot--blocked .octo-m-eye { animation: octo-m-slowblink 7s infinite; }

@media (prefers-reduced-motion: reduce) {
  .octo-mascot .octo-m-body, .octo-mascot .octo-m-eye,
  .octo-mascot .octo-m-f1, .octo-mascot .octo-m-f2, .octo-mascot .octo-m-f3, .octo-mascot .octo-m-f4,
  .octo-mascot .octo-m-b1, .octo-mascot .octo-m-b2, .octo-mascot .octo-m-b3, .octo-mascot .octo-m-b4,
  .octo-mascot .octo-m-ring {
    animation: none !important;
  }
  /* state still readable from the eyes alone */
  .octo-mascot--blocked .octo-m-eye { transform: scaleY(0.45) translateY(0.6px); }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/components/icons/OctoMark.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/components/icons/OctoMark.tsx src/components/icons/OctoMark.test.tsx src/styles.css
git commit -m "feat(brand): OctoMark component + mascot motion system"
```

---

### Task 2: `useMascotState` hook (top-bar live state)

**Files:**
- Create: `src/hooks/useMascotState.ts`
- Create: `src/hooks/useMascotState.test.ts`

**Interfaces:**
- Consumes: `OctoState` from Task 1; existing stores `useAttentionStore` (`flagsByWs: Record<string, AttentionFlag>`), `useChatStore` (`streamingByWs: Record<string, boolean>`), `useRunsStore` (`runsByWs: Record<string, Run[]>`, run statuses `"running" | "paused"` count as active).
- Produces: `export function useMascotState(): { state: OctoState; label: string }` — priority blocked > working > idle.

- [ ] **Step 1: Write the failing test**

`src/hooks/useMascotState.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useMascotState } from "./useMascotState";
import { useAttentionStore } from "../stores/attentionStore";
import { useChatStore } from "../stores/chatStore";
import { useRunsStore } from "../stores/runsStore";

describe("useMascotState", () => {
  beforeEach(() => {
    useAttentionStore.setState({ flagsByWs: {} });
    useChatStore.setState({ streamingByWs: {} });
    useRunsStore.setState({ runsByWs: {} });
  });

  it("is idle when nothing is happening", () => {
    const { result } = renderHook(() => useMascotState());
    expect(result.current.state).toBe("idle");
  });

  it("is working when a chat is streaming", () => {
    useChatStore.setState({ streamingByWs: { ws1: true } });
    const { result } = renderHook(() => useMascotState());
    expect(result.current.state).toBe("working");
    expect(result.current.label).toContain("working");
  });

  it("is working when a Direct run is active", () => {
    useRunsStore.setState({
      runsByWs: { ws1: [{ status: "running" } as never] },
    });
    const { result } = renderHook(() => useMascotState());
    expect(result.current.state).toBe("working");
  });

  it("blocked (needs you) beats working", () => {
    useChatStore.setState({ streamingByWs: { ws1: true } });
    useAttentionStore.setState({
      flagsByWs: { ws2: { kind: "chat", at: Date.now() } },
    });
    const { result } = renderHook(() => useMascotState());
    expect(result.current.state).toBe("blocked");
    expect(result.current.label).toContain("need");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useMascotState.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

`src/hooks/useMascotState.ts`:

```ts
import { useAttentionStore } from "../stores/attentionStore";
import { useChatStore } from "../stores/chatStore";
import { useRunsStore } from "../stores/runsStore";
import type { OctoState } from "../components/icons/OctoMark";

/** Derives the top-bar mascot's body language from real app state.
 *  Priority: something needs you (blocked) > agents working > idle. */
export function useMascotState(): { state: OctoState; label: string } {
  const attention = useAttentionStore((s) => Object.keys(s.flagsByWs).length);
  const streaming = useChatStore(
    (s) => Object.values(s.streamingByWs).filter(Boolean).length,
  );
  const activeRuns = useRunsStore(
    (s) =>
      Object.values(s.runsByWs)
        .flat()
        .filter((r) => r.status === "running" || r.status === "paused").length,
  );

  if (attention > 0) {
    return {
      state: "blocked",
      label: `Octopush — ${attention} workspace${attention > 1 ? "s" : ""} need${attention > 1 ? "" : "s"} you`,
    };
  }
  const working = streaming + activeRuns;
  if (working > 0) {
    return {
      state: "working",
      label: `Octopush — ${working} agent${working > 1 ? "s" : ""} working`,
    };
  }
  return { state: "idle", label: "Octopush — idle" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/hooks/useMascotState.test.ts`
Expected: PASS (4 tests). If a store's `setState` requires more fields, cast the partial with `as never` in the test rather than widening the hook.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useMascotState.ts src/hooks/useMascotState.test.ts
git commit -m "feat(brand): useMascotState — derive mascot body language from stores"
```

---

### Task 3: Fraunces wordmark font + `.brand-wordmark`

**Files:**
- Create: `src/assets/fonts/Fraunces-Variable.woff2` (copied from npm package)
- Create: `src/assets/fonts/OFL-Fraunces.txt`
- Modify: `src/styles.css` (font-face block at top, next to the Spectral ones; `.brand-wordmark` utility after the token blocks)

**Interfaces:**
- Produces: CSS class `.brand-wordmark` used by Tasks 4, 6, 7.

- [ ] **Step 1: Vendor the font**

```bash
npm install -D @fontsource-variable/fraunces
ls node_modules/@fontsource-variable/fraunces/files/ | grep latin
```

Copy the **full-axes latin** file (name like `fraunces-latin-full-normal.woff2`; if absent, use `fraunces-latin-opsz-normal.woff2`, which carries opsz+wght):

```bash
cp node_modules/@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2 src/assets/fonts/Fraunces-Variable.woff2
cp node_modules/@fontsource-variable/fraunces/LICENSE src/assets/fonts/OFL-Fraunces.txt
npm uninstall @fontsource-variable/fraunces
```

(The dependency is only a delivery vehicle; the woff2 is vendored like Spectral.)

- [ ] **Step 2: Register the face and the brand class in `src/styles.css`**

After the two Spectral `@font-face` blocks (top of file):

```css
/* Fraunces — brand-only face for the wordmark (never a UI font).
   Soft terminals + generous bowls: shares DNA with The Octo mark. */
@font-face {
  font-family: "Fraunces";
  src: url('./assets/fonts/Fraunces-Variable.woff2') format('woff2-variations');
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}
```

Then, near the other utility classes (e.g. right before the motion sections):

```css
/* The wordmark's voice — brand surfaces only (welcome, settings, about).
   Not a fourth UI font: body/serif/mono roles are unchanged. */
.brand-wordmark {
  font-family: "Fraunces", "Spectral", Georgia, serif;
  font-weight: 560;
  font-variation-settings: "opsz" 60;
  font-style: normal;
  letter-spacing: -0.02em;
}
```

- [ ] **Step 3: Verify build + commit**

```bash
npm run typecheck && npm run build
git add src/assets/fonts/Fraunces-Variable.woff2 src/assets/fonts/OFL-Fraunces.txt src/styles.css package.json package-lock.json
git commit -m "feat(brand): vendor Fraunces variable font + .brand-wordmark class"
```

Expected: build succeeds; the woff2 appears in the bundle output.

---

### Task 4: Welcome screen — hero lockup

**Files:**
- Modify: `src/components/WelcomeScreen.tsx:80-98` (the `§` mark block and the wordmark `h1`)

**Interfaces:**
- Consumes: `OctoMark` (Task 1), `.brand-wordmark` (Task 3).

- [ ] **Step 1: Replace the `&` logomark block**

(Post-v0.3.0, main replaced the retired `§` with an interim `&` logomark here.) In `WelcomeScreen.tsx`, add the import:

```tsx
import { OctoMark } from "./icons/OctoMark";
```

Replace the whole `&` mark `<div aria-hidden …>…</div>` block (lines ~79-93, including its comment and the `&amp;` glyph) with:

```tsx
      {/* Mark — The Octo, idling. Matches the app icon; rendered as SVG so
          it sharps at every DPI without a separate asset. */}
      <OctoMark size={116} state="idle" />
```

Replace the wordmark `h1` (keep text and spacing):

```tsx
      <h1 className="brand-wordmark mt-6 text-[32px] leading-[1.05] text-octo-ivory">
        Octopush
      </h1>
```

- [ ] **Step 2: Run existing tests + typecheck**

Run: `npx vitest run src/components --silent 2>&1 | tail -20` (WelcomeScreen has no dedicated test file; nearest suites must stay green) and `npm run typecheck`.
Expected: PASS / clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/WelcomeScreen.tsx
git commit -m "feat(brand): welcome hero — The Octo replaces the § logomark"
```

---

### Task 5: Top bar — the live mascot

**Files:**
- Modify: `src/components/AppTopBar.tsx` (imports + insert before `<RunsTray …/>` at line 45)

**Interfaces:**
- Consumes: `OctoMark` (Task 1), `useMascotState` (Task 2).

- [ ] **Step 1: Wire the mascot in**

Add imports:

```tsx
import { OctoMark } from "./icons/OctoMark";
import { useMascotState } from "../hooks/useMascotState";
```

Inside the component body:

```tsx
  const mascot = useMascotState();
```

Insert as the first child of the bar `<div>` (before `<RunsTray …/>`):

```tsx
      <span
        role="img"
        aria-label={mascot.label}
        title={mascot.label}
        className="mr-2 flex shrink-0 items-center"
      >
        <OctoMark size={20} state={mascot.state} />
      </span>
```

- [ ] **Step 2: Typecheck + run neighbouring tests**

Run: `npm run typecheck && npx vitest run src/hooks/useMascotState.test.ts src/components/PerfMonitorBar.test.tsx`
Expected: clean typecheck; both suites PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/AppTopBar.tsx
git commit -m "feat(brand): live mascot in the top bar — body language mirrors app state"
```

---

### Task 6: Chat canvas — thinking indicator + Talk empty state

**Files:**
- Modify: `src/components/chat/ChatCanvas.tsx` (EmptyState at ~420-435, ThinkingIndicator at ~438-449)

**Interfaces:**
- Consumes: `OctoMark` (Task 1). Import path from `chat/`: `import { OctoMark } from "../icons/OctoMark";`

- [ ] **Step 1: Update `EmptyState`**

Add the mark above the eyebrow (first child of the flex column):

```tsx
function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <OctoMark size={28} state="idle" className="opacity-80" />
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-mute">
        Talk
      </div>
      {/* …rest unchanged… */}
```

- [ ] **Step 2: Update `ThinkingIndicator`**

Replace the pulsing-dot `<span aria-hidden …/>` with the working mascot:

```tsx
function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 self-start">
      <OctoMark size={18} state="working" />
      <span className="font-serif text-[13px] text-octo-sage">Thinking…</span>
    </div>
  );
}
```

- [ ] **Step 3: Run the chat suites + typecheck**

Run: `npx vitest run src/components/chat src/components/ChatView.test.tsx && npm run typecheck`
Expected: PASS. If a test asserts on the old dot element, update the assertion to look for `Thinking…` text (behavior, not implementation).

- [ ] **Step 4: Commit**

```bash
git add src/components/chat/ChatCanvas.tsx
git commit -m "feat(brand): mascot in Talk empty state and thinking indicator"
```

---

### Task 7: Static placements — EmptyProjectState, Settings, About, SessionSidebar

**Files:**
- Modify: `src/components/EmptyProjectState.tsx:48` (above the "Project" eyebrow)
- Modify: `src/components/Settings.tsx:45` (header)
- Modify: `src/components/settings/AboutPane.tsx:33-37` (above `PaneHeader`)
- Modify: `src/components/SessionSidebar.tsx:48-49` (replace 🐙)

**Interfaces:**
- Consumes: `OctoMark` (Task 1), `.brand-wordmark` (Task 3).

- [ ] **Step 1: EmptyProjectState** — add `import { OctoMark } from "./icons/OctoMark";` and insert immediately before the eyebrow `<div className="font-mono …">Project</div>`:

```tsx
      <OctoMark size={28} state="idle" className="opacity-80" />
```

- [ ] **Step 2: Settings header** — add the same import; replace the `h1`:

```tsx
        <span className="flex items-center gap-2.5">
          <OctoMark size={18} />
          <h1 className="brand-wordmark text-[22px] text-octo-ivory">Octopush</h1>
        </span>
```

(The parent `<header>` is `items-baseline`; the wrapping span keeps mark and name optically aligned.)

- [ ] **Step 3: AboutPane** — add `import { OctoMark } from "../icons/OctoMark";` and insert directly above `<PaneHeader …/>`:

```tsx
      <div className="mb-4"><OctoMark size={48} /></div>
```

- [ ] **Step 4: SessionSidebar** — add the import and replace `<span className="text-lg">🐙</span>` with:

```tsx
          <OctoMark size={18} />
```

- [ ] **Step 5: Run suites + typecheck**

Run: `npx vitest run src/components/EmptyProjectState src/components/Settings src/components/settings && npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/EmptyProjectState.tsx src/components/Settings.tsx src/components/settings/AboutPane.tsx src/components/SessionSidebar.tsx
git commit -m "feat(brand): static Octo marks — empty project, settings, about, sidebar"
```

---

### Task 8: Run-completion moment — pushed mascot

**Files:**
- Modify: `src/components/RunLedger.tsx:94-99` (inside the `moment` Reveal)

**Interfaces:**
- Consumes: `OctoMark` (Task 1). `state="pushed"` plays its one-shot rise/halo on mount — the Reveal mounts this block when `moment` flips true, which is exactly the completion transition.

- [ ] **Step 1: Add the mark to the moment**

Import `{ OctoMark } from "./icons/OctoMark";`. Replace the moment block content:

```tsx
      <Reveal open={moment}>
        <div className="px-4 pb-3 pt-2">
          <div className="octo-sweep mb-2 h-px bg-octo-brass" />
          <div className="flex items-center gap-2.5">
            <OctoMark size={20} state="pushed" />
            <p className="m-0 font-serif text-sm text-octo-ivory">
              This run saved <span className="octo-tabular text-octo-verdigris">${saved.toFixed(2)}</span> against the all-premium baseline.
            </p>
          </div>
        </div>
      </Reveal>
```

- [ ] **Step 2: Run the suite + typecheck**

Run: `npx vitest run src/components/RunLedger.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/RunLedger.tsx
git commit -m "feat(brand): pushed-state mascot joins the run-completion moment"
```

---

### Task 9: App icon + favicon

**Files:**
- Modify: `src-tauri/icons/source.svg` (full rewrite — flat, no gradients)
- Regenerate: `src-tauri/icons/*.png|icns|ico` via tauri CLI
- Create: `public/favicon.svg`
- Modify: `index.html` (favicon link)

- [ ] **Step 1: Rewrite `src-tauri/icons/source.svg`**

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <!-- The Octo on an onyx field. Flat brass — no gradients (design rule). -->
  <rect x="0" y="0" width="1024" height="1024" rx="229" ry="229" fill="#0e0c0a" />
  <!-- Hairline interior border — the atelier frame. -->
  <rect x="32" y="32" width="960" height="960" rx="200" ry="200"
        fill="none" stroke="#2a2419" stroke-width="2" opacity="0.9" />
  <!-- Mark centered at ~62% field width (64u × 9.9 = 634px). -->
  <g transform="translate(512 512) scale(9.9) translate(-32 -33)">
    <g fill="#7b6044">
      <circle cx="10" cy="48.5" r="5"/>
      <circle cx="21" cy="50" r="5"/>
      <circle cx="43" cy="50" r="5"/>
      <circle cx="54" cy="48.5" r="5"/>
    </g>
    <path fill="#d4a574" d="M10 30 C10 17.8 19.8 8 32 8 C44.2 8 54 17.8 54 30 L54 47
      A5.5 5.5 0 0 1 43 47 A5.5 5.5 0 0 1 32 47
      A5.5 5.5 0 0 1 21 47 A5.5 5.5 0 0 1 10 47 Z"/>
    <circle cx="25" cy="27" r="3" fill="#0e0c0a"/>
    <circle cx="39" cy="27" r="3" fill="#0e0c0a"/>
  </g>
</svg>
```

(`#7b6044` is `--brass-line` composited on onyx — assets can't use CSS vars.)

- [ ] **Step 2: Regenerate the icon set**

```bash
npm run tauri -- icon src-tauri/icons/source.svg
ls -la src-tauri/icons/
```

Expected: `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, `icon.ico`, `icon.png` all regenerated (newer mtimes). Tauri may emit extra platform sizes — keep them; `tauri.conf.json:37-43` already points at the five it bundles. Visually inspect `icon.png` (open it) — eyes visible, mark centered.

- [ ] **Step 3: Favicon for dev**

Create `public/favicon.svg` (mark only, transparent background, back row omitted per the <20px rule — favicons render at 16-32px):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 66">
  <path fill="#d4a574" d="M10 30 C10 17.8 19.8 8 32 8 C44.2 8 54 17.8 54 30 L54 47
    A5.5 5.5 0 0 1 43 47 A5.5 5.5 0 0 1 32 47
    A5.5 5.5 0 0 1 21 47 A5.5 5.5 0 0 1 10 47 Z"/>
  <circle cx="25" cy="27" r="3.6" fill="#0e0c0a"/>
  <circle cx="39" cy="27" r="3.6" fill="#0e0c0a"/>
</svg>
```

In `index.html` `<head>`, after the `<title>`:

```html
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/icons/ public/favicon.svg index.html
git commit -m "feat(brand): The Octo app icon (flat, no gradients) + dev favicon"
```

---

### Task 10: Docs + final verification

**Files:**
- Modify: `docs/design-system.md` (new "Mark & mascot" section)
- Modify: `docs/FEATURES.md` (update touched surfaces; add live-mascot entry)
- Modify: `CLAUDE.md` (brand note in "Signature details")

- [ ] **Step 1: `docs/design-system.md`** — add a section (after the tokens/type sections; match surrounding heading style):

```markdown
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
  half-mast — stillness is the signal). All motion ≤2.5px, reduced-motion safe.
- **Wordmark:** "Octopush" in Fraunces via `.brand-wordmark` — brand surfaces
  only (welcome, settings header, about). Spectral remains the UI serif.
- The `§` glyph is fully retired as a logo.
```

- [ ] **Step 2: `docs/FEATURES.md`** — grep for the touched surfaces (`Welcome`, `Settings`, `About`, `Thinking`, `RunLedger`, `top bar`) and update their entries to mention the mark where they described `§`/emoji; add one new entry under the top-bar/chrome section:

```markdown
- **Live mascot (top bar)** — `OctoMark` in `AppTopBar` mirrors app state via
  `useMascotState` (`src/hooks/useMascotState.ts`): needs-attention → blocked
  (frozen, eyes half-mast), any chat streaming or Direct run active → working
  (paddling, eyes scanning), else idle. Tooltip reports the exact count.
```

- [ ] **Step 3: `CLAUDE.md`** — in "Active branding details": (a) edit the existing `&` bullet — remove the clause "it is also the Welcome-screen logomark (replacing the retired `§` mark)" (the ampersand stays as the typographic accent only); (b) add a new first bullet:

```markdown
- **The Octo mark** — the octopus creature (`OctoMark`, `src/components/icons/OctoMark.tsx`)
  is the product logo and mascot: app icon, welcome hero, top-bar live status,
  thinking indicator, empty states, about. Body language mirrors app state
  (idle / working / pushed / blocked). See `docs/design-system.md`
  "The Octo — mark & mascot".
```

- [ ] **Step 4: Full verification sweep**

```bash
npm run typecheck
npm test -- --run 2>&1 | tail -5
npm run build 2>&1 | tail -3
git diff main --stat | tail -3
git diff main -- src/ | grep -nE '#[0-9a-fA-F]{3,8}' || echo "no hex literals in src diff"
```

Expected: typecheck clean; full vitest suite green; build succeeds; hex-grep prints `no hex literals in src diff`.

- [ ] **Step 5: Commit**

```bash
git add docs/design-system.md docs/FEATURES.md CLAUDE.md
git commit -m "docs(brand): design-system mascot section, FEATURES map, CLAUDE.md note"
```
