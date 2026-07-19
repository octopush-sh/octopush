# The Octo in TALK — Watcher & Player Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the two TALK personality acts from `docs/superpowers/specs/2026-07-19-octo-talk-personality-design.md`: the mouse-following, fidgeting Watcher in the empty state, and the pinned seven-role Player that replaces the scroll-away Thinking/Generating indicators.

**Architecture:** Extract a geometry-only `OctoRig` from `OctoMark` (public API unchanged). `OctoWatcher` composes the rig with a rAF gaze engine + an idle gesture scheduler. `OctoStatus` composes the rig with a pure `roleForActivity` mapper driven by store signals ChatCanvas already selects (`streaming`, `streamBuffer`, `liveTools`, approvals). New role/gesture CSS lives in the existing mascot section of `styles.css`.

**Tech Stack:** React 19 + TypeScript, CSS keyframes (no new deps), Vitest + @testing-library/react (jsdom, fake timers).

## Global Constraints

- Tokens only in app code: brass `var(--color-octo-brass)`, back arms `var(--brass-line)`, eyes `var(--octo-eye, var(--color-octo-bg))`; label `--color-octo-sage`, wait-label `--color-octo-brass`.
- Motion: amplitudes ≤ 2.4 canonical units; loops `ease-in-out` (reading saccade `linear`); moments `var(--ease-octo)`; label crossfade 220ms; everything under the existing `prefers-reduced-motion` regime; no gradients-as-lines (the bottom wash is a surface, sanctioned by design-system §3/§5).
- The Player never moves horizontally — stacked layout, single axis (spec v5).
- UI copy in English. `npm run typecheck` + `npm test` green at every commit. Branch: `octo-talk-personality` (already on origin/main v0.4.36+).
- Gaze mousemove listens on the chat scroll container (not `document`); gesture idle-timer resets on **window keydown** (proxy for composer typing — the composer is the only text surface in Talk).

---

### Task 1: `OctoRig` extraction (no visual change)

**Files:**
- Modify: `src/components/icons/OctoMark.tsx`
- Test: `src/components/icons/OctoMark.test.tsx` (existing must stay green; add rig test)

**Interfaces:**
- Produces: `export function OctoRig({ eyeR, showBack, withHappy = false }: { eyeR: number; showBack: boolean; withHappy?: boolean }): JSX.Element` — SVG *contents* only (no `<svg>` wrapper): back arms (`.octo-m-b1..b4`, `fill var(--brass-line)`), flat-bottom body path, front arms (`.octo-m-f1..f4`), eyes group `.octo-m-eyes` with two `.octo-m-eye` ellipses, and (when `withHappy`) the `.octo-m-happy` arcs. Consumers wrap it in their own `<svg viewBox="0 0 64 66">`.

- [ ] **Step 1: Add a failing test for the rig**

Append to `OctoMark.test.tsx`:

```tsx
import { OctoRig } from "./OctoMark";

describe("OctoRig", () => {
  it("renders the bare rig (arms + eyes group) without an svg wrapper", () => {
    const { container } = render(
      <svg viewBox="0 0 64 66"><OctoRig eyeR={3.6} showBack={false} /></svg>,
    );
    expect(container.querySelector(".octo-m-eyes")).not.toBeNull();
    expect(container.querySelector(".octo-m-f1")).not.toBeNull();
    expect(container.querySelector(".octo-m-b1")).toBeNull();
    expect(container.querySelectorAll("svg").length).toBe(1);
  });
});
```

Run: `npx vitest run src/components/icons/OctoMark.test.tsx` → FAIL (`OctoRig` not exported).

- [ ] **Step 2: Extract the rig**

In `OctoMark.tsx`, add above `OctoMark`:

```tsx
/** Geometry-only rig — the animated mark's SVG contents without the <svg>
 *  wrapper, so the Watcher/Player (chat mascots) can compose the same
 *  canonical creature and drive it with their own classes/refs. */
export function OctoRig({
  eyeR,
  showBack,
  withHappy = false,
}: {
  eyeR: number;
  showBack: boolean;
  withHappy?: boolean;
}) {
  const eyeFill = "var(--octo-eye, var(--color-octo-bg))";
  return (
    <>
      {showBack && (
        <g fill="var(--brass-line)">
          <circle className="octo-m-b1" cx="10" cy="48.5" r="5" />
          <circle className="octo-m-b2" cx="21" cy="50" r="5" />
          <circle className="octo-m-b3" cx="43" cy="50" r="5" />
          <circle className="octo-m-b4" cx="54" cy="48.5" r="5" />
        </g>
      )}
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
      <g className="octo-m-eyes">
        <ellipse className="octo-m-eye" cx="25" cy="27" rx={eyeR} ry={eyeR} fill={eyeFill} />
        <ellipse className="octo-m-eye" cx="39" cy="27" rx={eyeR} ry={eyeR} fill={eyeFill} />
      </g>
      {withHappy && (
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
      )}
    </>
  );
}
```

Then replace the animated branch's SVG children in `OctoMark` (everything inside `<g className="octo-m-body">…</g>` after the optional ring) with:

```tsx
      <g className="octo-m-body">
        <OctoRig eyeR={eyeR} showBack={showBack} withHappy />
      </g>
```

The static branch stays exactly as it is (hem-path artwork).

- [ ] **Step 3: Verify no behavior change**

Run: `npx vitest run src/components/icons/OctoMark.test.tsx && npm run typecheck`
Expected: all tests PASS (including the 5 existing) — the animated DOM is identical.

- [ ] **Step 4: Commit**

```bash
git add src/components/icons/OctoMark.tsx src/components/icons/OctoMark.test.tsx
git commit -m "refactor(brand): extract OctoRig — geometry-only rig for chat mascots"
```

---

### Task 2: `roleForActivity` + `OctoStatus` (the Player) + role CSS

**Files:**
- Create: `src/components/chat/OctoStatus.tsx`
- Create: `src/components/chat/OctoStatus.test.tsx`
- Modify: `src/styles.css` (mascot section — after the `octo-mascot--blocked` rule)

**Interfaces:**
- Consumes: `OctoRig` (Task 1); `LiveTool` type from `../../stores/chatStore`.
- Produces:
  - `export type OctoRole = { key: "wait" | "read" | "search" | "edit" | "run" | "write" | "think" | "work"; label: string; bodyClass: string }`
  - `export function roleForActivity(args: { approvals: number; liveTools: LiveTool[]; streamBuffer: string }): OctoRole`
  - `export function OctoStatus({ streaming, hasError, streamBuffer, liveTools, approvals }: { streaming: boolean; hasError: boolean; streamBuffer: string; liveTools: LiveTool[]; approvals: number }): JSX.Element | null` — self-managing exit (✓ beat 500ms + fade 220ms); returns `null` when idle.

- [ ] **Step 1: Write the failing tests**

`src/components/chat/OctoStatus.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { OctoStatus, roleForActivity } from "./OctoStatus";
import type { LiveTool } from "../../stores/chatStore";

const tool = (toolName: string, done = false): LiveTool =>
  ({ callId: "c1", toolName, toolInput: {}, startedAt: "", done }) as LiveTool;

describe("roleForActivity", () => {
  it("approval beats everything", () => {
    const r = roleForActivity({ approvals: 1, liveTools: [tool("Bash")], streamBuffer: "x" });
    expect(r.key).toBe("wait");
    expect(r.label).toBe("Waiting for you");
  });
  it("maps tool families", () => {
    expect(roleForActivity({ approvals: 0, liveTools: [tool("Read")], streamBuffer: "" }).key).toBe("read");
    expect(roleForActivity({ approvals: 0, liveTools: [tool("Grep")], streamBuffer: "" }).key).toBe("search");
    expect(roleForActivity({ approvals: 0, liveTools: [tool("Edit")], streamBuffer: "" }).key).toBe("edit");
    expect(roleForActivity({ approvals: 0, liveTools: [tool("Bash")], streamBuffer: "" }).key).toBe("run");
  });
  it("uses the newest not-done tool; done tools are ignored", () => {
    const r = roleForActivity({
      approvals: 0,
      liveTools: [tool("Read"), tool("Bash", true)],
      streamBuffer: "",
    });
    expect(r.key).toBe("read");
  });
  it("unknown tools fall back to Working… with the think body", () => {
    const r = roleForActivity({ approvals: 0, liveTools: [tool("FrobnicateX")], streamBuffer: "" });
    expect(r.key).toBe("work");
    expect(r.label).toBe("Working…");
    expect(r.bodyClass).toBe("octo-mascot--working");
  });
  it("buffer → write; nothing → think", () => {
    expect(roleForActivity({ approvals: 0, liveTools: [], streamBuffer: "hola" }).key).toBe("write");
    expect(roleForActivity({ approvals: 0, liveTools: [], streamBuffer: "" }).key).toBe("think");
  });
});

describe("OctoStatus", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("renders nothing when idle", () => {
    const { container } = render(
      <OctoStatus streaming={false} hasError={false} streamBuffer="" liveTools={[]} approvals={0} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows the role label and body class while streaming", () => {
    const { container, getByText } = render(
      <OctoStatus streaming hasError={false} streamBuffer="" liveTools={[tool("Grep")]} approvals={0} />,
    );
    expect(getByText("Searching…")).toBeTruthy();
    expect(container.querySelector(".octo-mascot--search")).not.toBeNull();
  });

  it("waiting label renders in brass", () => {
    const { getByText } = render(
      <OctoStatus streaming hasError={false} streamBuffer="" liveTools={[]} approvals={2} />,
    );
    expect(getByText("Waiting for you").className).toContain("text-octo-brass");
  });

  it("plays the ✓ beat then unmounts when streaming ends cleanly", () => {
    const { container, rerender } = render(
      <OctoStatus streaming hasError={false} streamBuffer="x" liveTools={[]} approvals={0} />,
    );
    rerender(
      <OctoStatus streaming={false} hasError={false} streamBuffer="" liveTools={[]} approvals={0} />,
    );
    expect(container.querySelector(".octo-mascot--pushed-beat")).not.toBeNull();
    act(() => vi.advanceTimersByTime(800));
    expect(container.firstChild).toBeNull();
  });

  it("skips the beat on error — just leaves", () => {
    const { container, rerender } = render(
      <OctoStatus streaming hasError={false} streamBuffer="x" liveTools={[]} approvals={0} />,
    );
    rerender(
      <OctoStatus streaming={false} hasError streamBuffer="" liveTools={[]} approvals={0} />,
    );
    expect(container.querySelector(".octo-mascot--pushed-beat")).toBeNull();
    act(() => vi.advanceTimersByTime(400));
    expect(container.firstChild).toBeNull();
  });
});
```

Run: `npx vitest run src/components/chat/OctoStatus.test.tsx` → FAIL (module not found).

- [ ] **Step 2: Implement `OctoStatus.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { OctoRig } from "../icons/OctoMark";
import type { LiveTool } from "../../stores/chatStore";

export type OctoRole = {
  key: "wait" | "read" | "search" | "edit" | "run" | "write" | "think" | "work";
  label: string;
  bodyClass: string;
};

const ROLE: Record<OctoRole["key"], OctoRole> = {
  wait: { key: "wait", label: "Waiting for you", bodyClass: "octo-mascot--blocked" },
  read: { key: "read", label: "Reading…", bodyClass: "octo-mascot--read" },
  search: { key: "search", label: "Searching…", bodyClass: "octo-mascot--search" },
  edit: { key: "edit", label: "Editing…", bodyClass: "octo-mascot--write" },
  run: { key: "run", label: "Running…", bodyClass: "octo-mascot--run" },
  write: { key: "write", label: "Writing…", bodyClass: "octo-mascot--write" },
  think: { key: "think", label: "Thinking…", bodyClass: "octo-mascot--working" },
  work: { key: "work", label: "Working…", bodyClass: "octo-mascot--working" },
};

const TOOL_FAMILIES: Array<[RegExp, OctoRole["key"]]> = [
  [/^(read|ls|glob|notebookread|cat)/i, "read"],
  [/^(grep|find|search|websearch|webfetch)/i, "search"],
  [/^(edit|write|notebookedit)/i, "edit"],
  [/^(bash|terminal|shell)/i, "run"],
];

/** The Player's script: what is the turn actually doing right now?
 *  Priority: someone must answer (wait) > a live tool > text flowing > thought. */
export function roleForActivity(args: {
  approvals: number;
  liveTools: LiveTool[];
  streamBuffer: string;
}): OctoRole {
  if (args.approvals > 0) return ROLE.wait;
  const live = [...args.liveTools].reverse().find((t) => !t.done);
  if (live) {
    for (const [re, key] of TOOL_FAMILIES) if (re.test(live.toolName)) return ROLE[key];
    return ROLE.work;
  }
  if (args.streamBuffer) return ROLE.write;
  return ROLE.think;
}

interface Props {
  streaming: boolean;
  hasError: boolean;
  streamBuffer: string;
  liveTools: LiveTool[];
  approvals: number;
}

/** The Player — the pinned bottom-center figure that acts out the turn
 *  (spec §4). Stacked on one axis so the label's width can never move the
 *  octopus. Manages its own exit: ✓ beat (500ms) then fade (220ms). */
export function OctoStatus({ streaming, hasError, streamBuffer, liveTools, approvals }: Props) {
  const active = streaming || approvals > 0;
  const [phase, setPhase] = useState<"hidden" | "live" | "beat" | "fading">(
    active ? "live" : "hidden",
  );
  const prevActive = useRef(active);
  const [label, setLabel] = useState("");
  const [labelSwap, setLabelSwap] = useState(false);

  const role = roleForActivity({ approvals, liveTools, streamBuffer });

  // Enter / exit choreography.
  useEffect(() => {
    if (active && phase !== "live") setPhase("live");
    if (!active && prevActive.current && (phase === "live")) {
      if (hasError) {
        setPhase("fading");
        const t = setTimeout(() => setPhase("hidden"), 220);
        return () => clearTimeout(t);
      }
      setPhase("beat");
      const t1 = setTimeout(() => setPhase("fading"), 500);
      const t2 = setTimeout(() => setPhase("hidden"), 720);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
    prevActive.current = active;
  }, [active, hasError, phase]);
  useEffect(() => { prevActive.current = active; }, [active]);

  // 220ms label crossfade on change.
  useEffect(() => {
    if (phase !== "live") return;
    if (role.label === label) return;
    if (!label) { setLabel(role.label); return; }
    setLabelSwap(true);
    const t = setTimeout(() => { setLabel(role.label); setLabelSwap(false); }, 200);
    return () => clearTimeout(t);
  }, [role.label, label, phase]);

  if (phase === "hidden") return null;

  const beat = phase === "beat";
  const bodyClass = beat ? "octo-mascot--pushed-beat" : role.bodyClass;
  const shownLabel = beat ? "" : label || role.label;

  return (
    <div
      aria-live="polite"
      className={`pointer-events-none absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-[5px] ${
        phase === "fading" ? "octo-fade-out" : "octo-rise-in"
      }`}
    >
      <svg
        width="22"
        height="23"
        viewBox="0 0 64 66"
        aria-hidden="true"
        focusable="false"
        className={`octo-mascot ${bodyClass}`}
      >
        <OctoRig eyeR={3.6} showBack={false} withHappy />
      </svg>
      {shownLabel && (
        <span
          className={`whitespace-nowrap font-serif text-[12px] transition-opacity duration-[220ms] ${
            labelSwap ? "opacity-0" : "opacity-100"
          } ${role.key === "wait" ? "text-octo-brass" : "text-octo-sage"}`}
        >
          {shownLabel}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add role CSS to `src/styles.css`**

After the `/* blocked — stillness IS the signal */` rule block, insert:

```css
/* Player roles — the pinned TALK figure acts out the live tool
   (spec 2026-07-19 §4). Same six rig pieces, different tempos. */
@keyframes octo-m-typy { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2.2px); } }
@keyframes octo-m-readline {
  0% { transform: translate(-2.2px, -0.6px); }
  62% { transform: translate(2.2px, -0.6px); }
  70%, 100% { transform: translate(-2.2px, 0.9px); }
}
@keyframes octo-m-darty {
  0%, 14% { transform: translate(-2.2px, -1.2px); }
  18%, 34% { transform: translate(2.2px, -1px); }
  38%, 56% { transform: translate(-1.6px, 1.4px); }
  60%, 78% { transform: translate(2px, 1.2px); }
  82%, 100% { transform: translate(0, 0); }
}

/* write / edit — typing arms, eyes down at the text */
.octo-mascot--write .octo-m-f1 { animation: octo-m-typy 0.46s ease-in-out infinite; }
.octo-mascot--write .octo-m-f2 { animation: octo-m-typy 0.46s ease-in-out 0.23s infinite; }
.octo-mascot--write .octo-m-f3 { animation: octo-m-typy 0.46s ease-in-out 0.11s infinite; }
.octo-mascot--write .octo-m-f4 { animation: octo-m-typy 0.46s ease-in-out 0.34s infinite; }
.octo-mascot--write .octo-m-eyes { transform: translateY(1.9px); }

/* read — reading saccades: sweep the line, drop to the next */
.octo-mascot--read .octo-m-f1 { animation: octo-m-float 3.4s ease-in-out infinite; }
.octo-mascot--read .octo-m-f2 { animation: octo-m-float 3.4s ease-in-out 0.45s infinite; }
.octo-mascot--read .octo-m-f3 { animation: octo-m-float 3.4s ease-in-out 0.9s infinite; }
.octo-mascot--read .octo-m-f4 { animation: octo-m-float 3.4s ease-in-out 1.35s infinite; }
.octo-mascot--read .octo-m-eyes { animation: octo-m-readline 1.5s linear infinite; }

/* search — the gaze darts corner to corner */
.octo-mascot--search .octo-m-f1 { animation: octo-m-float 2.4s ease-in-out infinite; }
.octo-mascot--search .octo-m-f2 { animation: octo-m-float 2.4s ease-in-out 0.3s infinite; }
.octo-mascot--search .octo-m-f3 { animation: octo-m-float 2.4s ease-in-out 0.6s infinite; }
.octo-mascot--search .octo-m-f4 { animation: octo-m-float 2.4s ease-in-out 0.9s infinite; }
.octo-mascot--search .octo-m-eyes { animation: octo-m-darty 2.6s infinite; }

/* run — dead still, eyes wide: watching the command */
.octo-mascot--run .octo-m-eyes { transform: scale(1.18); }
.octo-mascot--run .octo-m-eye { animation: octo-m-blink 3.2s infinite; }

/* the ✓ beat — happy eyes for half a second as the turn closes */
.octo-mascot--pushed-beat .octo-m-eye { opacity: 0; animation: none; }
.octo-mascot--pushed-beat .octo-m-happy { opacity: 1; }
```

(`octo-m-float` / `octo-m-blink` already exist; `--run` has no arm rule on purpose — no animation = stillness. All of it is neutralized by the app-wide reduced-motion rule.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/components/chat/OctoStatus.test.tsx && npm run typecheck`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/OctoStatus.tsx src/components/chat/OctoStatus.test.tsx src/styles.css
git commit -m "feat(talk): OctoStatus — the pinned seven-role Player + role CSS"
```

---

### Task 3: Wire the Player into `ChatCanvas`; remove the scroll-away indicators

**Files:**
- Modify: `src/components/chat/ChatCanvas.tsx` (render tree ~146-245, `ThinkingIndicator` at ~438)

**Interfaces:**
- Consumes: `OctoStatus` (Task 2). ChatCanvas already has `streaming`, `streamBuffer`, `liveTools`, `approvalsForThread`, `error` in scope.

- [ ] **Step 1: Mount the overlay + wash inside the `relative` wrapper**

In the return, the outer wrapper is `<div className="relative flex min-h-0 flex-1 flex-col">`. Immediately **after** the scroll `<div ref={scrollRef} …>…</div>` closes (sibling, still inside the relative wrapper), add:

```tsx
      {/* Bottom exit wash — keeps the pinned Player legible over the journal.
          A surface, not a line (design-system §3). */}
      {!isEmpty && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[110px]"
          style={{ background: "linear-gradient(transparent, var(--color-octo-bg) 76%)" }}
        />
      )}

      {/* The Player — always-visible activity figure (spec 2026-07-19 §4). */}
      <OctoStatus
        streaming={streaming}
        hasError={Boolean(error)}
        streamBuffer={streamBuffer}
        liveTools={liveTools}
        approvals={approvalsForThread.length}
      />
```

Add the import: `import { OctoStatus } from "./OctoStatus";`

- [ ] **Step 2: Reserve room and remove the old indicators**

1. Scroll container class: change `px-8 py-6` → `px-8 pt-6 pb-[118px]` (line ~153).
2. Delete the `{streaming && !streamBuffer && liveTools.length === 0 && <ThinkingIndicator />}` line and the whole `ThinkingIndicator` function (~438-449), plus the now-unused `OctoMark` import **if** nothing else in the file uses it (EmptyState still does until Task 4 — check before removing).
3. In the streaming block, delete the "Generating" marker `<div className="mt-1.5 flex items-center gap-1.5">…Generating…</div>` (keep the `▊` caret in the message content).

- [ ] **Step 3: Run the chat suites**

Run: `npx vitest run src/components/chat src/components/ChatView.test.tsx && npm run typecheck`
Expected: PASS. If a test asserted on "Thinking…" inline rendering, it now finds the same text inside `OctoStatus` (still rendered while streaming with no buffer/tools) — update selectors only if they asserted DOM position.

- [ ] **Step 4: Commit**

```bash
git add src/components/chat/ChatCanvas.tsx
git commit -m "feat(talk): pin the Player bottom-center; retire scroll-away indicators"
```

---

### Task 4: `OctoWatcher` — gaze + fidget gestures in the empty state

**Files:**
- Create: `src/components/chat/OctoWatcher.tsx`
- Create: `src/components/chat/OctoWatcher.test.tsx`
- Modify: `src/components/chat/ChatCanvas.tsx` (EmptyState, ~line 420; pass `scrollRef`)
- Modify: `src/styles.css` (scratch keyframes, mascot section)

**Interfaces:**
- Consumes: `OctoRig` (Task 1).
- Produces: `export function OctoWatcher({ size = 72, areaRef }: { size?: number; areaRef: React.RefObject<HTMLElement | null> }): JSX.Element`; `export function gazeOffset(cx: number, cy: number, mx: number, my: number): { x: number; y: number }` (pure, testable).

- [ ] **Step 1: Write the failing tests**

`src/components/chat/OctoWatcher.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { createRef } from "react";
import { OctoWatcher, gazeOffset } from "./OctoWatcher";

describe("gazeOffset", () => {
  it("clamps to 2.4 units and points toward the cursor", () => {
    const far = gazeOffset(0, 0, 1000, 0);
    expect(far.x).toBeCloseTo(2.4, 3);
    expect(far.y).toBeCloseTo(0, 3);
    const near = gazeOffset(0, 0, 120, 0); // half the 240px normalization
    expect(near.x).toBeCloseTo(1.2, 3);
    const diag = gazeOffset(0, 0, -1000, -1000);
    expect(Math.hypot(diag.x, diag.y)).toBeCloseTo(2.4, 3);
    expect(diag.x).toBeLessThan(0);
  });
});

describe("OctoWatcher fidgets", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function mount() {
    const areaRef = createRef<HTMLDivElement>();
    const utils = render(
      <div ref={areaRef}>
        <OctoWatcher areaRef={areaRef} />
      </div>,
    );
    return { areaRef, ...utils };
  }

  it("fires the first gesture after 15s of keyboard silence", () => {
    const { container } = mount();
    expect(container.querySelector("svg")?.getAttribute("data-gesture")).toBe("none");
    act(() => vi.advanceTimersByTime(15_100));
    expect(container.querySelector("svg")?.getAttribute("data-gesture")).not.toBe("none");
  });

  it("a keystroke re-arms the timer", () => {
    const { container } = mount();
    act(() => vi.advanceTimersByTime(10_000));
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })); });
    act(() => vi.advanceTimersByTime(10_000));
    expect(container.querySelector("svg")?.getAttribute("data-gesture")).toBe("none");
    act(() => vi.advanceTimersByTime(5_200));
    expect(container.querySelector("svg")?.getAttribute("data-gesture")).not.toBe("none");
  });

  it("cycles look → scratch → peek", () => {
    const { container } = mount();
    const g = () => container.querySelector("svg")?.getAttribute("data-gesture");
    act(() => vi.advanceTimersByTime(15_100));
    expect(g()).toBe("look");
    act(() => vi.advanceTimersByTime(2_000));  // look ends (1.8s) → timer re-arms
    act(() => vi.advanceTimersByTime(15_100));
    expect(g()).toBe("scratch");
    act(() => vi.advanceTimersByTime(3_000));  // scratch ends (2.8s)
    act(() => vi.advanceTimersByTime(15_100));
    expect(g()).toBe("peek");
  });
});
```

Run: `npx vitest run src/components/chat/OctoWatcher.test.tsx` → FAIL (module not found).

- [ ] **Step 2: Implement `OctoWatcher.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { OctoRig } from "../icons/OctoMark";
import { prefersReducedMotion } from "../../lib/motion";

/** Max eye travel in canonical units; cursor influence saturates at 240px. */
const MAX_OFFSET = 2.4;
const SATURATION_PX = 240;
const IDLE_MS = 15_000;
const LERP = 0.14;

/** Pure gaze math: eye offset toward (mx,my) from the eye center (cx,cy). */
export function gazeOffset(cx: number, cy: number, mx: number, my: number) {
  const dx = mx - cx, dy = my - cy;
  const d = Math.hypot(dx, dy) || 1;
  const m = Math.min(1, d / SATURATION_PX) * MAX_OFFSET;
  return { x: (dx / d) * m, y: (dy / d) * m };
}

type Gesture = "none" | "look" | "scratch" | "peek";

/** The Watcher — the Talk empty-state Octo (spec 2026-07-19 §3):
 *  eyes follow the cursor across the chat canvas with calm inertia;
 *  after 15s of keyboard silence it fidgets (look → scratch → peek). */
export function OctoWatcher({
  size = 72,
  areaRef,
}: {
  size?: number;
  areaRef: React.RefObject<HTMLElement | null>;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const eyesEl = useRef<SVGGElement | null>(null);
  const cur = useRef({ x: 0, y: 0 });
  const target = useRef({ x: 0, y: 0 });
  const gestureRef = useRef<Gesture>("none");
  const [gesture, setGesture] = useState<Gesture>("none");
  const cycle = useRef(0);

  // Gaze: mousemove on the canvas + rAF lerp loop.
  // Spec §3: under prefers-reduced-motion there is NO gaze-follow and NO
  // fidgeting — the CSS neutralizer can't stop a JS engine, so guard here.
  useEffect(() => {
    if (prefersReducedMotion()) return;
    eyesEl.current = svgRef.current?.querySelector(".octo-m-eyes") ?? null;
    const area = areaRef.current;
    if (!area) return;
    const onMove = (e: MouseEvent) => {
      if (gestureRef.current !== "none") return;
      const r = svgRef.current?.getBoundingClientRect();
      if (!r) return;
      target.current = gazeOffset(r.left + r.width / 2, r.top + r.height * 0.42, e.clientX, e.clientY);
    };
    area.addEventListener("mousemove", onMove);
    let raf = 0;
    const loop = () => {
      cur.current.x += (target.current.x - cur.current.x) * LERP;
      cur.current.y += (target.current.y - cur.current.y) * LERP;
      eyesEl.current?.setAttribute(
        "transform",
        `translate(${cur.current.x.toFixed(2)} ${cur.current.y.toFixed(2)})`,
      );
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      area.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(raf);
    };
  }, [areaRef]);

  // Fidget scheduler: 15s of keyboard silence → next gesture in the cycle.
  useEffect(() => {
    if (prefersReducedMotion()) return;
    let idleTimer: ReturnType<typeof setTimeout>;
    let stepTimers: Array<ReturnType<typeof setTimeout>> = [];
    const setG = (g: Gesture) => { gestureRef.current = g; setGesture(g); };

    const runGesture = () => {
      const which = (["look", "scratch", "peek"] as const)[cycle.current % 3];
      cycle.current += 1;
      setG(which);
      const done = (after: number) =>
        stepTimers.push(setTimeout(() => { setG("none"); target.current = { x: 0, y: 0 }; arm(); }, after));
      if (which === "look") {
        target.current = { x: -2.4, y: 0 };
        stepTimers.push(setTimeout(() => { target.current = { x: 2.4, y: 0 }; }, 700));
        stepTimers.push(setTimeout(() => { target.current = { x: 0, y: -0.5 }; }, 1400));
        done(1800);
      } else if (which === "scratch") {
        target.current = { x: 1.8, y: -1.2 };
        done(2800);
      } else {
        target.current = { x: 0, y: 2.6 };
        done(1100);
      }
    };

    const arm = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(runGesture, IDLE_MS);
    };
    const onKey = () => { if (gestureRef.current === "none") arm(); };
    window.addEventListener("keydown", onKey);
    arm();
    return () => {
      clearTimeout(idleTimer);
      stepTimers.forEach(clearTimeout);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <svg
      ref={svgRef}
      width={size}
      height={Math.round((size * 66) / 64)}
      viewBox="0 0 64 66"
      aria-hidden="true"
      focusable="false"
      data-gesture={gesture}
      className={`octo-mascot octo-mascot--idle${gesture === "scratch" ? " octo-g-scratch" : ""}`}
    >
      <OctoRig eyeR={3} showBack />
    </svg>
  );
}
```

- [ ] **Step 3: Scratch CSS**

In `src/styles.css`, after the Player-roles block from Task 2, add:

```css
/* Watcher fidget — the back-right arm climbs to the dome and rubs;
   eyes squint while it happens (spec 2026-07-19 §3). */
@keyframes octo-m-scratch {
  0% { transform: translate(0, 0); }
  16% { transform: translate(-4px, -31px); }
  27% { transform: translate(-7.5px, -27.5px); }
  38% { transform: translate(-4px, -31px); }
  49% { transform: translate(-7.5px, -27.5px); }
  60% { transform: translate(-4px, -31px); }
  82%, 100% { transform: translate(0, 0); }
}
.octo-g-scratch .octo-m-b4 { animation: octo-m-scratch 2.8s ease-in-out 1 !important; }
.octo-g-scratch .octo-m-eye { animation: none; transform: scaleY(0.55); }
```

- [ ] **Step 4: Swap the EmptyState mark and pass the area ref**

In `ChatCanvas.tsx`: change `<EmptyState />` (line ~156) to `<EmptyState areaRef={scrollRef} />` and update the component:

```tsx
function EmptyState({ areaRef }: { areaRef: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <OctoWatcher size={72} areaRef={areaRef} />
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-mute">
        Talk
      </div>
      {/* …rest unchanged… */}
```

Add `import { OctoWatcher } from "./OctoWatcher";`; remove the `OctoMark` import if now unused in this file.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/components/chat && npm run typecheck`
Expected: PASS (Watcher suite + existing chat suites).

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/OctoWatcher.tsx src/components/chat/OctoWatcher.test.tsx src/components/chat/ChatCanvas.tsx src/styles.css
git commit -m "feat(talk): OctoWatcher — mouse-following gaze + idle fidget gestures"
```

---

### Task 5: Docs + full verification

**Files:**
- Modify: `docs/FEATURES.md` (Talk empty state entry; "Thinking… indicator" entry)
- Modify: `docs/design-system.md` ("The Octo — mark & mascot" section)

- [ ] **Step 1: `docs/FEATURES.md`** — replace the Talk-empty-state entry body with:

```markdown
- **Talk empty state — the Watcher** — The Octo at 72px whose eyes follow the mouse across the chat canvas (rAF lerp, ±2.4u, saturating at 240px); after 15s of keyboard silence it fidgets on a cycle — look around → scratch its head (back arm climbs the dome, eyes squint) → peek at the composer. Any keystroke re-arms the timer; reduced-motion renders the static idle pose. Above the `Talk` eyebrow, serif "Begin a conversation.", helper copy. _Support:_ `chat/OctoWatcher.tsx`; `ChatCanvas` `EmptyState`. _Entry:_ Talk mode, empty thread.
```

Replace the "Thinking… indicator" entry with:

```markdown
- **The Player (pinned activity figure)** — While a turn runs, a naked stacked figure (The Octo 22px above a one-word serif label) sits pinned bottom-center of the chat canvas — always visible regardless of journal scroll (bottom exit wash + 118px journal padding keep it legible). Seven roles from real signals, priority wait > tool > text > thought: Waiting for you (approval pending — frozen, half-mast eyes, brass label) · Reading… (READ/LS/GLOB — reading saccades) · Searching… (GREP/FIND — darting gaze) · Editing…/Writing… (EDIT/WRITE / stream text — typing arms, eyes down) · Running… (BASH — dead still, eyes wide) · Thinking…/Working… (paddle + eye scan). Labels crossfade 220ms; the octopus never moves (single-axis stack). Turn end: ✓ happy-eye beat 500ms, then fade; errors skip the beat. Replaces the old inline Thinking… indicator and the "Generating" dot (the `▊` caret stays). _Support:_ `chat/OctoStatus.tsx` (`roleForActivity`); `ChatCanvas`. _Entry:_ Talk mode, any running turn.
```

- [ ] **Step 2: `docs/design-system.md`** — in "The Octo — mark & mascot", extend the **States** bullet with:

```markdown
- **TALK-only behaviors:** the empty-state **Watcher** (gaze-follow ±2.4u + fidget cycle
  look/scratch/peek after 15s idle — `chat/OctoWatcher.tsx`) and the pinned **Player**
  (`chat/OctoStatus.tsx`): role classes `octo-mascot--write/read/search/run` +
  `octo-mascot--pushed-beat`, driven by `roleForActivity`. Keep new roles to eye/arm
  tempo changes on the same six rig pieces — never add elements to the rig.
```

- [ ] **Step 3: Full verification sweep**

```bash
npm run typecheck
npm test -- --run 2>&1 | tail -3
npm run build 2>&1 | tail -1
git diff origin/main -- src/ ':!src/assets' | grep -E '^\+' | grep -nE '#[0-9a-fA-F]{3,8}' || echo "no hex literals in src diff"
```

Expected: clean, all green, `no hex literals in src diff`.

- [ ] **Step 4: Commit**

```bash
git add docs/FEATURES.md docs/design-system.md
git commit -m "docs(talk): FEATURES + design-system — the Watcher and the Player"
```
