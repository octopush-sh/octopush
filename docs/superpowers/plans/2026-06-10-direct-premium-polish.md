# Direct Premium Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recompose every DIRECT-mode surface (launcher, builder, run view, checkpoint bar, cost meter, companion) on a new layer of stability primitives and Atelier form controls so the mode feels premium, fluid, and jitter-free — frontend only, zero behavior/IPC/store-contract changes.

**Architecture:** Spec: `docs/superpowers/specs/2026-06-10-direct-premium-polish-design.md`. Four waves: (P0) CSS tokens/utilities + `FadeSwap`/`Reveal` primitives + controls library (`SegmentedControl`, `TogglePill`, `Stepper`, `Listbox`, `IconButton`); (P1) run experience (RunTrack fixed-slot cards, StageFocus journal, CheckpointBar docked in a Reveal, RunLedger savings-first strip with completion moment, DirectCanvas crossfade choreography); (P2) launcher + builder recomposition; (P3) companion + identity/copy sweep + checklist. The **stability doctrine S1–S6** from spec §3 is binding: fixed-slot live text, tabular numerals, no abrupt subtree swaps, animated height changes, no motion on live tickers, smooth scrolling.

**Tech Stack:** React 19 + TypeScript, Tailwind v4 (`octo-*` theme tokens in `src/styles.css`), Zustand stores (untouched), Vitest + @testing-library/react (setup: `src/test-setup.ts`), lucide-react icons.

**Standing overrides:** NO italics anywhere (serif phrases are upright). All UI copy in English. Brass is surgical. Run `npm run typecheck` before claiming any task complete. Work on branch `feat/direct-premium-polish`.

---

### Task 1: CSS tokens & utilities + ModelPicker tokenization

**Files:**
- Modify: `src/styles.css` (after the `.octo-stage-pulse` block, ~line 210; provider tokens next to the `--brass-*` alpha utilities — find them with `grep -n "brass-dim" src/styles.css`)
- Modify: `src/components/ModelPicker.tsx:35-43`

- [ ] **Step 1: Add CSS utilities and tokens**

In `src/styles.css`, after the `.octo-stage-pulse` reduced-motion block (~line 210), add:

```css
/* ── Direct premium polish · stability utilities ─────────────────
   S2: every live numeric value renders tabular so digits never shift width. */
.octo-tabular { font-variant-numeric: tabular-nums; }

/* S3 exit half of FadeSwap (see src/components/primitives/FadeSwap.tsx). */
@keyframes octo-exit-fade {
  from { opacity: 1; }
  to   { opacity: 0; }
}
.octo-fade-out { animation: octo-exit-fade 120ms var(--ease-octo) both; }

/* One-shot brass sweep — the Direct run-completion moment (ledger strip). */
@keyframes octo-sweep {
  from { width: 0; }
  to   { width: 100%; }
}
.octo-sweep { animation: octo-sweep var(--dur-reveal) var(--ease-octo) both; }
```

Then locate where `--brass-dim` / `--brass-ghost` are defined (a `:root` block) and add beside them:

```css
  /* Provider identity dots — decorative, ModelPicker + Direct only. */
  --provider-anthropic: #cc785c;
  --provider-openai:    #74aa9c;
  --provider-deepseek:  #5c8acc;
  --provider-ollama:    #a8a8a8;
```

- [ ] **Step 2: Tokenize ModelPicker provider colors**

In `src/components/ModelPicker.tsx`, replace the `PROVIDER_COLORS` map values (lines 35–40) with the tokens:

```typescript
const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "var(--provider-anthropic)",
  openai: "var(--provider-openai)",
  deepseek: "var(--provider-deepseek)",
  ollama: "var(--provider-ollama)",
};
```

(The fallback on line ~43 already returns `var(--color-octo-sage)` — leave it.)

- [ ] **Step 3: Verify**

Run: `npm run typecheck` → clean. Run: `grep -rn "#[0-9a-fA-F]\{6\}" src/components/ModelPicker.tsx` → no matches.

- [ ] **Step 4: Commit**

```bash
git add src/styles.css src/components/ModelPicker.tsx
git commit -m "feat(direct/polish): octo-tabular + fade-out + sweep utilities, provider color tokens"
```

---

### Task 2: Primitives — `Reveal` and `FadeSwap`

**Files:**
- Create: `src/components/primitives/Reveal.tsx`
- Create: `src/components/primitives/FadeSwap.tsx`
- Create: `src/components/primitives/primitives.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/primitives/primitives.test.tsx
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Reveal } from "./Reveal";
import { FadeSwap } from "./FadeSwap";

describe("Reveal", () => {
  it("renders children and reflects open state via grid-template-rows + aria-hidden", () => {
    const { rerender, container } = render(<Reveal open={false}><p>hidden content</p></Reveal>);
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.style.gridTemplateRows).toBe("0fr");
    expect(outer.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("hidden content")).toBeInTheDocument(); // stays mounted
    rerender(<Reveal open><p>hidden content</p></Reveal>);
    expect(outer.style.gridTemplateRows).toBe("1fr");
    expect(outer.getAttribute("aria-hidden")).toBe("false");
  });

  it("makes closed content inert", () => {
    const { container } = render(<Reveal open={false}><button>act</button></Reveal>);
    const inner = container.querySelector("div > div") as HTMLElement;
    expect(inner.hasAttribute("inert")).toBe(true);
  });
});

describe("FadeSwap", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("renders children straight through for a stable key", () => {
    const { rerender } = render(<FadeSwap swapKey="a"><p>one</p></FadeSwap>);
    rerender(<FadeSwap swapKey="a"><p>two</p></FadeSwap>);
    expect(screen.getByText("two")).toBeInTheDocument(); // live content passes through
  });

  it("holds the old subtree during exit, then mounts the new one", () => {
    const { rerender, container } = render(<FadeSwap swapKey="a"><p>old view</p></FadeSwap>);
    rerender(<FadeSwap swapKey="b"><p>new view</p></FadeSwap>);
    // exit phase: old content still visible, fade-out class applied
    expect(screen.getByText("old view")).toBeInTheDocument();
    expect(screen.queryByText("new view")).not.toBeInTheDocument();
    expect((container.firstElementChild as HTMLElement).className).toContain("octo-fade-out");
    act(() => { vi.advanceTimersByTime(130); });
    expect(screen.getByText("new view")).toBeInTheDocument();
    expect(screen.queryByText("old view")).not.toBeInTheDocument();
    expect((container.firstElementChild as HTMLElement).className).toContain("octo-fade-in");
  });

  it("settles on the latest key when keys change rapidly", () => {
    const { rerender } = render(<FadeSwap swapKey="a"><p>A</p></FadeSwap>);
    rerender(<FadeSwap swapKey="b"><p>B</p></FadeSwap>);
    rerender(<FadeSwap swapKey="c"><p>C</p></FadeSwap>);
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.getByText("C")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/primitives/primitives.test.tsx`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement `Reveal`**

```tsx
// src/components/primitives/Reveal.tsx
import type { ReactNode } from "react";

interface Props {
  open: boolean;
  className?: string;
  children: ReactNode;
}

/** Stability rule S4 — height changes are animated. Expand/collapse on the
 *  sanctioned grid-rows 0fr↔1fr idiom (design-system §6). Content stays
 *  mounted; the closed state is inert so nothing inside is interactive. */
export function Reveal({ open, className = "", children }: Props) {
  return (
    <div
      aria-hidden={!open}
      className={`grid ${className}`}
      style={{
        gridTemplateRows: open ? "1fr" : "0fr",
        opacity: open ? 1 : 0,
        transition:
          "grid-template-rows var(--dur-standard) var(--ease-octo), opacity var(--dur-standard) var(--ease-octo)",
      }}
    >
      <div className="min-h-0 overflow-hidden" inert={!open}>
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Implement `FadeSwap`**

```tsx
// src/components/primitives/FadeSwap.tsx
import { useEffect, useRef, useState, type ReactNode } from "react";

const EXIT_MS = 120;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

interface Props {
  swapKey: string;
  className?: string;
  children: ReactNode;
}

/** Stability rule S3 — no abrupt subtree swaps. Crossfades mutually exclusive
 *  views keyed by `swapKey`: the outgoing subtree fades out (120ms), then the
 *  incoming one mounts with .octo-fade-in. Same-key renders pass children
 *  straight through, so live content inside a view never re-animates. */
export function FadeSwap({ swapKey, className = "", children }: Props) {
  const [view, setView] = useState({ key: swapKey, exiting: false });
  const snapshot = useRef<ReactNode>(children);
  if (swapKey === view.key && !view.exiting) snapshot.current = children;

  useEffect(() => {
    if (swapKey === view.key) {
      setView((v) => (v.exiting ? { ...v, exiting: false } : v));
      return;
    }
    if (prefersReducedMotion()) {
      setView({ key: swapKey, exiting: false });
      return;
    }
    setView((v) => (v.exiting ? v : { ...v, exiting: true }));
    const id = setTimeout(() => setView({ key: swapKey, exiting: false }), EXIT_MS);
    return () => clearTimeout(id);
  }, [swapKey, view.key]);

  const stale = swapKey !== view.key || view.exiting;
  return (
    <div key={view.key} className={`${view.exiting ? "octo-fade-out" : "octo-fade-in"} ${className}`}>
      {stale ? snapshot.current : children}
    </div>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/components/primitives/primitives.test.tsx` → PASS. Also `npm run typecheck` → clean. (If TS complains about the `inert` prop, the project is on React 19 where it's a standard boolean prop — check `@types/react` version before working around it; do NOT cast to `any`.)

- [ ] **Step 6: Commit**

```bash
git add src/components/primitives/
git commit -m "feat(direct/polish): Reveal + FadeSwap stability primitives (S3/S4)"
```

---

### Task 3: Controls — `SegmentedControl`, `TogglePill`, `Stepper`, `IconButton`

**Files:**
- Create: `src/components/controls/SegmentedControl.tsx`
- Create: `src/components/controls/TogglePill.tsx`
- Create: `src/components/controls/Stepper.tsx`
- Create: `src/components/controls/IconButton.tsx`
- Create: `src/components/controls/controls.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/controls/controls.test.tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SegmentedControl } from "./SegmentedControl";
import { TogglePill } from "./TogglePill";
import { Stepper } from "./Stepper";
import { IconButton } from "./IconButton";

describe("SegmentedControl", () => {
  const opts = [
    { value: "api", label: "API" },
    { value: "cli", label: "CLI" },
  ];
  it("marks the active option and fires onChange", () => {
    const onChange = vi.fn();
    render(<SegmentedControl options={opts} value="api" onChange={onChange} ariaLabel="Substrate" />);
    expect(screen.getByRole("radio", { name: "API" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "CLI" })).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("radio", { name: "CLI" }));
    expect(onChange).toHaveBeenCalledWith("cli");
  });
});

describe("TogglePill", () => {
  it("is a switch reflecting its state and toggling", () => {
    const onChange = vi.fn();
    render(<TogglePill on={false} onChange={onChange} label="⟜ gate" />);
    const sw = screen.getByRole("switch", { name: "⟜ gate" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("Stepper", () => {
  it("clamps at min and steps value", () => {
    const onChange = vi.fn();
    render(<Stepper value={1} min={1} max={9} onChange={onChange} ariaLabel="Max loop-backs" />);
    expect(screen.getByRole("button", { name: "Decrease" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Increase" }));
    expect(onChange).toHaveBeenCalledWith(2);
    expect(screen.getByText("1")).toBeInTheDocument();
  });
});

describe("IconButton", () => {
  it("exposes its label and respects disabled", () => {
    const onClick = vi.fn();
    render(<IconButton label="Move up" onClick={onClick} disabled>x</IconButton>);
    const btn = screen.getByRole("button", { name: "Move up" });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/controls/controls.test.tsx` → FAIL (modules missing).

- [ ] **Step 3: Implement the four controls**

```tsx
// src/components/controls/SegmentedControl.tsx
export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Active-state classes override (e.g. substrate state colors). Default: brass. */
  activeClass?: string;
}

interface Props<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}

/** 2–4 mutually exclusive options in a hairline track. Brass (or the option's
 *  own accent) marks the active segment; inactive segments are quiet. */
export function SegmentedControl<T extends string>({ options, value, onChange, ariaLabel }: Props<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-octo-hairline bg-octo-onyx p-0.5"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={`rounded-sm px-2 py-1 font-mono text-[10px] uppercase tracking-[0.25em] transition-colors duration-[220ms] ${
              active ? (o.activeClass ?? "bg-[var(--brass-ghost)] text-octo-brass") : "text-octo-mute hover:text-octo-sage"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
```

```tsx
// src/components/controls/TogglePill.tsx
interface Props {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  ariaLabel?: string;
}

/** Labeled on/off pill. Off: hairline + mute. On: brass-dim border, brass-ghost
 *  fill, brass text. The premium replacement for a bare checkbox. */
export function TogglePill({ on, onChange, label, ariaLabel }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel ?? label}
      onClick={() => onChange(!on)}
      className={`shrink-0 rounded-sm border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.25em] transition-colors duration-[220ms] ${
        on
          ? "border-[var(--brass-dim)] bg-[var(--brass-ghost)] text-octo-brass"
          : "border-octo-hairline text-octo-mute hover:text-octo-sage"
      }`}
    >
      {label}
    </button>
  );
}
```

```tsx
// src/components/controls/Stepper.tsx
interface Props {
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
  ariaLabel: string;
}

/** `− n +` numeric stepper with tabular numeral — no native spinner. */
export function Stepper({ value, min = 1, max = 9, onChange, ariaLabel }: Props) {
  return (
    <div aria-label={ariaLabel} className="inline-flex shrink-0 items-center rounded-md border border-octo-hairline bg-octo-onyx">
      <button
        type="button"
        aria-label="Decrease"
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        className="px-2 py-1 font-mono text-xs text-octo-sage transition-colors duration-[180ms] hover:text-octo-ivory disabled:opacity-30"
      >
        −
      </button>
      <span className="octo-tabular w-6 text-center font-mono text-[11px] text-octo-ivory">{value}</span>
      <button
        type="button"
        aria-label="Increase"
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        className="px-2 py-1 font-mono text-xs text-octo-sage transition-colors duration-[180ms] hover:text-octo-ivory disabled:opacity-30"
      >
        +
      </button>
    </div>
  );
}
```

```tsx
// src/components/controls/IconButton.tsx
import type { ReactNode } from "react";

interface Props {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}

/** Square ghost button for lucide icons — replaces ASCII ↑ ↓ ✕ buttons. */
export function IconButton({ label, onClick, disabled = false, danger = false, children }: Props) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-octo-hairline text-octo-sage transition-colors duration-[180ms] hover:border-[var(--brass-dim)] disabled:opacity-30 ${
        danger ? "hover:text-octo-rouge" : "hover:text-octo-ivory"
      }`}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/controls/controls.test.tsx` → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/controls/
git commit -m "feat(direct/polish): Atelier controls — SegmentedControl, TogglePill, Stepper, IconButton"
```

---

### Task 4: Controls — `Listbox` (portal popover)

**Files:**
- Create: `src/components/controls/Listbox.tsx`
- Create: `src/components/controls/Listbox.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/controls/Listbox.test.tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Listbox } from "./Listbox";

const OPTIONS = [
  { value: "plan", label: "Plan", description: "Outline the approach" },
  { value: "implement", label: "Implement" },
];

describe("Listbox", () => {
  it("shows the current label, opens a portal listbox, selects, and closes", () => {
    const onChange = vi.fn();
    render(<Listbox value="plan" options={OPTIONS} onChange={onChange} ariaLabel="Stage role" />);
    const anchor = screen.getByRole("button", { name: "Stage role" });
    expect(anchor).toHaveTextContent("Plan");
    fireEvent.click(anchor);
    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeInTheDocument();
    expect(document.body.contains(listbox)).toBe(true); // portaled
    expect(screen.getByText("Outline the approach")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /Implement/ }));
    expect(onChange).toHaveBeenCalledWith("implement");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows the placeholder when value is null and closes on Escape", () => {
    render(<Listbox value={null} options={OPTIONS} onChange={() => {}} placeholder="— linear —" ariaLabel="Loop target" />);
    expect(screen.getByRole("button", { name: "Loop target" })).toHaveTextContent("— linear —");
    fireEvent.click(screen.getByRole("button", { name: "Loop target" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("marks the active option aria-selected", () => {
    render(<Listbox value="plan" options={OPTIONS} onChange={() => {}} ariaLabel="Stage role" />);
    fireEvent.click(screen.getByRole("button", { name: "Stage role" }));
    expect(screen.getByRole("option", { name: /Plan/ })).toHaveAttribute("aria-selected", "true");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/controls/Listbox.test.tsx` → FAIL.

- [ ] **Step 3: Implement `Listbox`**

```tsx
// src/components/controls/Listbox.tsx
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ListboxOption {
  value: string;
  label: string;
  description?: string;
}

interface Props {
  value: string | null;
  options: ListboxOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
}

const PANEL_MAX_H = 280;

/** Anchored popover listbox in the ModelPicker's visual language.
 *  Portal + position:fixed so overflow containers never clip it (PR #8 lesson). */
export function Listbox({ value, options, onChange, placeholder = "—", ariaLabel, className = "" }: Props) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const current = options.find((o) => o.value === value) ?? null;

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    const estimated = Math.min(PANEL_MAX_H, options.length * 34 + 8);
    const fitsBelow = window.innerHeight - r.bottom >= estimated + 8;
    setPos({ top: fitsBelow ? r.bottom + 4 : Math.max(8, r.top - 4 - estimated), left: r.left, width: Math.max(r.width, 200) });
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !anchorRef.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-2 rounded-md border border-octo-hairline bg-octo-onyx px-2.5 py-1.5 text-left transition-colors duration-[180ms] hover:border-[var(--brass-dim)] ${className}`}
      >
        <span className={`truncate font-serif text-sm ${current ? "text-octo-ivory" : "text-octo-mute"}`}>
          {current?.label ?? placeholder}
        </span>
        <span className="ml-auto font-mono text-[9px] text-octo-mute">▾</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            aria-label={ariaLabel}
            className="octo-menu-enter fixed z-50 overflow-auto rounded-md border border-octo-hairline bg-octo-panel py-1 shadow-xl"
            style={{ top: pos.top, left: pos.left, minWidth: pos.width, maxHeight: PANEL_MAX_H }}
          >
            {options.map((o) => {
              const active = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors duration-[120ms] hover:bg-octo-panel-2 ${
                    active ? "bg-[var(--brass-ghost)]" : ""
                  }`}
                >
                  <span className="flex w-full items-center gap-2">
                    <span className={`font-serif text-sm ${active ? "text-octo-brass" : "text-octo-ivory"}`}>{o.label}</span>
                    {active && <span className="ml-auto font-mono text-[10px] text-octo-brass">✓</span>}
                  </span>
                  {o.description && <span className="font-mono text-[10px] text-octo-mute">{o.description}</span>}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/controls/Listbox.test.tsx` → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/controls/Listbox.tsx src/components/controls/Listbox.test.tsx
git commit -m "feat(direct/polish): Listbox popover control (portal + fixed positioning)"
```

---

### Task 5: RunTrack — fixed-geometry stage cards

**Files:**
- Modify: `src/components/RunTrack.tsx` (full recomposition below; keep `ROMAN`, `labelForRole`, `lastActivity`, `lastNotice` exports/logic exactly as-is)
- Modify: `src/components/RunTrack.test.tsx` (update assertions to the new markup; keep all behavioral cases)

- [ ] **Step 1: Read the existing test file, then extend it**

Read `src/components/RunTrack.test.tsx` first. Update any assertion that targets removed markup (the old `stageStatusMeta` label inside the card, old `Meta` block). Add these new cases (adapt store/fixture helpers to whatever the file already uses):

```tsx
it("reserves the elapsed slot in every status (S1)", () => {
  // render a pending stage; the card must contain a w-[5ch] span even when empty
  // assert: card.querySelector("span.octo-tabular") !== null
});

it("renders cost in the live line for idle stages and activity for running ones", () => {
  // idle: live line shows $X.XX with octo-tabular
  // running with a tool entry in liveByStage: live line shows "§ TOOL …"
});

it("dims connectors after pending stages and brightens them after done stages", () => {
  // two stages, first pending → connector has opacity-40
  // first done → connector has opacity-100
});
```

- [ ] **Step 2: Run tests to verify the new cases fail**

Run: `npx vitest run src/components/RunTrack.test.tsx` → new cases FAIL.

- [ ] **Step 3: Recompose RunTrack**

Replace the body of `RunTrack`, `StageCard`, `Meta` (delete it), and `SubstratePill` with:

```tsx
export function RunTrack({ run: _run, stages, selectedStageId, onSelectStage }: Props) {
  const doneCount = stages.filter((s) => s.status === "done").length;

  return (
    <div className="border-b border-octo-hairline bg-octo-panel px-4 py-3">
      <div className="octo-fade-in mb-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">stage</div>
        <div className="octo-tabular font-mono text-sm text-octo-ivory">
          {Math.min(doneCount + 1, stages.length)} / {stages.length}
        </div>
      </div>
      <div className="flex items-stretch overflow-x-auto pb-1">
        {stages.map((s, i) => (
          <div key={s.id} className="flex min-w-0 items-stretch">
            {i > 0 && (
              <div
                className={`flex w-6 shrink-0 items-center justify-center text-octo-brass transition-opacity duration-[280ms] ${
                  stages[i - 1].status === "done" ? "opacity-100" : "opacity-40"
                }`}
              >
                {stages[i - 1].checkpoint ? "⟜" : "⟶"}
              </div>
            )}
            <StageCard stage={s} index={i} selected={s.id === selectedStageId} onSelect={() => onSelectStage(s.id)} />
          </div>
        ))}
      </div>
    </div>
  );
}

function statusGlyph(status: string): { glyph: string; cls: string } {
  switch (status) {
    case "running": return { glyph: "●", cls: "text-octo-verdigris" };
    case "done": return { glyph: "✓", cls: "text-octo-verdigris" };
    case "failed": return { glyph: "✕", cls: "text-octo-rouge" };
    case "awaiting_checkpoint": return { glyph: "◆", cls: "text-octo-brass" };
    default: return { glyph: "○", cls: "text-octo-mute" };
  }
}

function statusWord(status: string): string {
  switch (status) {
    case "running": return "running";
    case "done": return "done";
    case "failed": return "halted";
    case "awaiting_checkpoint": return "review";
    default: return "pending";
  }
}

function StageCard({ stage: s, index, selected, onSelect }: {
  stage: RunStage; index: number; selected: boolean; onSelect: () => void;
}) {
  const entries = useRunsStore((st) => st.liveByStage[s.id] ?? EMPTY_ENTRIES);
  const elapsed = useElapsed(s.status === "running" ? s.startedAt : null);
  const running = s.status === "running";
  const { glyph, cls } = statusGlyph(s.status);

  // S1: ONE fixed-height live line; content picked by status, geometry constant.
  const verdict = s.status === "done" ? lastNotice(entries) : "";
  const live = running
    ? { text: lastActivity(entries), cls: "text-octo-brass", tabular: false }
    : verdict
      ? { text: verdict, cls: "text-octo-verdigris", tabular: false }
      : { text: `$${s.costUsd.toFixed(2)}`, cls: "text-octo-mute", tabular: true };

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`octo-rise-in flex h-[96px] min-w-[170px] max-w-[230px] flex-1 basis-0 flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors ${
        running ? "octo-stage-pulse " : ""
      }${
        selected
          ? "border-octo-brass bg-[var(--brass-ghost)]"
          : s.status === "failed"
            ? "border-[var(--rouge-border)] bg-octo-panel-2 hover:border-octo-rouge"
            : "border-octo-hairline bg-octo-panel-2 hover:border-[var(--brass-dim)]"
      }`}
    >
      <span className="flex h-4 items-center gap-1.5 font-mono text-[10px]">
        <span className="text-octo-brass">{ROMAN[index] ?? index + 1}</span>
        <span key={s.status} className={`octo-pop-in ${cls}`}>{glyph}</span>
        <span className="truncate uppercase tracking-[0.25em] text-octo-mute">{statusWord(s.status)}</span>
        <span className="octo-tabular ml-auto w-[5ch] shrink-0 text-right text-octo-brass">{running ? elapsed : ""}</span>
      </span>
      <span className="h-5 truncate font-serif text-sm leading-5 text-octo-ivory">{labelForRole(s.role)}</span>
      <span className="flex h-4 items-center gap-2 font-mono text-[10px] text-octo-sage">
        <span className="truncate">{s.agentModel}</span>
        <SubstratePill substrate={s.substrate} />
      </span>
      <span
        key={`${s.status}-live`}
        className={`octo-fade-in mt-auto block h-4 truncate font-mono text-[10px] leading-4 ${live.cls} ${live.tabular ? "octo-tabular" : ""}`}
      >
        {live.text}
      </span>
    </button>
  );
}

function SubstratePill({ substrate }: { substrate: string }) {
  const cls =
    substrate === "cli"
      ? "text-octo-state-purple border-[var(--state-purple-dim)]"
      : "text-octo-state-blue border-[var(--state-blue-dim)]";
  return (
    <span className={`flex w-9 shrink-0 items-center justify-center rounded-sm border py-0.5 font-mono text-[8px] uppercase tracking-[0.1em] ${cls}`}>
      {substrate}
    </span>
  );
}
```

Remove the now-unused `stageStatusMeta` import. Keep `lastActivity`, `lastNotice`, `ROMAN`, `labelForRole`, `EMPTY_ENTRIES` untouched.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/components/RunTrack.test.tsx` → PASS (old cases updated, new cases green). `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/RunTrack.tsx src/components/RunTrack.test.tsx
git commit -m "feat(direct/polish): RunTrack fixed-slot stage cards, progress connectors, tabular numerals"
```

---

### Task 6: StageFocus — designed journal, error banner, role verbs

**Files:**
- Modify: `src/components/StageFocus.tsx`
- Modify: `src/components/StageFocus.test.tsx` (update + extend)

- [ ] **Step 1: Read existing tests, extend**

New cases to add (adapt to the file's fixtures):

```tsx
it("shows the role verb while running", () => { /* role: "plan" → screen.getByText("planning…") */ });
it("renders a designed error banner plus the journal at full opacity on failure", () => {
  /* status failed + error + entries → getByText("✕ stage halted"); no element with class opacity-70 */
});
it("uses the serif empty state", () => { /* stage null → getByText("Pick a stage above to see its work.") */ });
```

- [ ] **Step 2: Run to verify new cases fail**

`npx vitest run src/components/StageFocus.test.tsx` → new cases FAIL.

- [ ] **Step 3: Recompose**

Changes to `src/components/StageFocus.tsx` (keep artifact parsing, diff effect, and journal pairing logic):

1. Add imports: `import { FadeSwap } from "./primitives/FadeSwap";` and a role-verb map at module level:

```tsx
const ROLE_VERBS: Record<string, string> = {
  plan: "planning…", plan_review: "reviewing…", implement: "implementing…",
  code_review: "reviewing…", test: "testing…", repro: "reproducing…",
  fix: "fixing…", verify: "verifying…", critique: "critiquing…", refine: "refining…",
};
```

2. Autoscroll becomes smooth (S6) — replace the scroll effect body:

```tsx
useEffect(() => {
  if (stage?.status === "running" && scrollRef.current) {
    scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }
}, [liveEntries, stage?.status]);
```

3. Journal entries each get an entrance: add `octo-rise-in` to the className of all four entry shapes (text div, notice div, tool card div, orphan result div). Notice tracking fixes to `tracking-[0.25em]`.

4. Empty state (stage null):

```tsx
return (
  <div className="flex flex-1 items-center justify-center font-serif text-sm text-octo-mute">
    Pick a stage above to see its work.
  </div>
);
```

5. Header:

```tsx
<div className="flex items-center gap-3 border-b border-octo-hairline px-4 py-2.5">
  <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
    § {stage.role.replace(/_/g, " ").toUpperCase()}
  </span>
  <span className="font-serif text-sm text-octo-ivory">{labelForRole(stage.role)}</span>
  <span className="truncate font-mono text-[10px] text-octo-mute">{stage.agentModel}</span>
  <span className="octo-tabular ml-auto font-mono text-xs text-octo-brass">${stage.costUsd.toFixed(2)}</span>
</div>
```

6. Body — wrap the four modes in a `FadeSwap` keyed by stage + mode (S3). Structure:

```tsx
const mode =
  stage.status === "failed" && stage.error ? "failed"
  : artifact ? "artifact"
  : stage.status === "running" ? "running"
  : "idle";

return (
  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
    {/* header from step 5 */}
    <div
      ref={scrollRef}
      className="chat-selectable flex flex-1 flex-col gap-2 overflow-auto px-4 py-3 font-mono text-[12px] leading-relaxed text-octo-sage"
    >
      <FadeSwap swapKey={`${stage.id}:${mode}`} className="flex flex-col gap-2">
        {mode === "failed" ? (
          <>
            <div className="octo-rise-in rounded-md border-l-2 border-octo-rouge bg-[var(--rouge-ghost)] px-3 py-2">
              <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-rouge">✕ stage halted</div>
              <div className="whitespace-pre-wrap text-octo-rouge">{stage.error}</div>
            </div>
            {journal.length > 0 && <div className="flex flex-col gap-2">{journal}</div>}
          </>
        ) : mode === "artifact" ? (
          <div className="whitespace-pre-wrap">
            {artifact!.text || "(no output text)"}
            {artifact!.refsWorktree && (
              <FadeSwap swapKey={diffLoading ? "loading" : "diff"}>
                {diffLoading ? (
                  <div className="py-4 font-mono text-xs text-octo-mute">fetching the diff…</div>
                ) : (
                  <DiffViewer diff={diff} />
                )}
              </FadeSwap>
            )}
          </div>
        ) : mode === "running" ? (
          <>
            {journal}
            <div className="flex items-center gap-2 font-mono text-[11px] text-octo-brass">
              <span className="octo-stage-pulse inline-block h-1.5 w-1.5 rounded-full bg-octo-brass" />
              <span>{ROLE_VERBS[stage.role] ?? "working…"}</span>
            </div>
          </>
        ) : (
          <span className="text-octo-mute">Nothing produced yet.</span>
        )}
      </FadeSwap>
    </div>
  </div>
);
```

Note the failure journal is **no longer** wrapped in `opacity-70`.

- [ ] **Step 4: Run tests**

`npx vitest run src/components/StageFocus.test.tsx` → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/StageFocus.tsx src/components/StageFocus.test.tsx
git commit -m "feat(direct/polish): StageFocus — mode crossfade, designed error banner, role verbs, smooth journal"
```

---

### Task 7: CheckpointBar as docked decision strip + DirectCanvas choreography

**Files:**
- Modify: `src/components/CheckpointBar.tsx`
- Modify: `src/components/DirectCanvas.tsx`
- Modify: `src/components/CheckpointBar.test.tsx`, `src/components/DirectCanvas.test.tsx`

- [ ] **Step 1: Read existing tests, extend**

CheckpointBar new cases: loop meter renders `octo-tabular` numerals and turns brass at cap; the feedback editor replaces the decision row (existing flows likely already covered — update selectors). DirectCanvas: the checkpoint strip stays mounted inside a `Reveal` (assert `aria-hidden` flips instead of unmount when pausing/resuming, if the existing harness supports it; otherwise assert presence of the Reveal wrapper when paused).

- [ ] **Step 2: Run to see failures**, `npx vitest run src/components/CheckpointBar.test.tsx src/components/DirectCanvas.test.tsx`

- [ ] **Step 3: Recompose CheckpointBar**

Keep all props/state/handlers. Replace the JSX:

```tsx
const mode = rejecting ? "reject" : sendingBack ? "sendback" : "decide";

return (
  <div className={`border-t px-4 py-3 ${failed ? "border-octo-rouge bg-[var(--rouge-ghost)]" : "border-[var(--brass-dim)] bg-[var(--brass-faint)]"}`}>
    {loopState !== null && (
      <div className="mb-2 h-4 font-mono text-[10px] uppercase tracking-[0.25em]">
        {atCap ? (
          <span className="text-octo-brass">
            loop exhausted · <span className="octo-tabular">{loopState.iteration}/{loopState.max}</span> — approve or abort
          </span>
        ) : (
          <span className="text-octo-mute">
            review loop · <span className="octo-tabular">{loopState.iteration} of {loopState.max}</span> used
          </span>
        )}
      </div>
    )}

    <FadeSwap swapKey={mode}>
      {mode === "decide" ? (
        <div className="flex items-center gap-3">
          <span className={`font-mono text-[10px] uppercase tracking-[0.25em] ${failed ? "text-octo-rouge" : "text-octo-brass"}`}>
            {failed ? "✕ stage halted" : "⟜ checkpoint"}
          </span>
          <span className="flex-1 text-sm text-octo-sage">
            {failed ? (
              <>Stage <b className="text-octo-ivory">{labelForRole(blockedStage.role)}</b> halted. Re-run it or abort the run.</>
            ) : (
              <>Review <b className="text-octo-ivory">{labelForRole(blockedStage.role)}</b> and choose how to proceed.</>
            )}
          </span>
          {!failed && (
            <button type="button" onClick={onApprove}
              className="rounded-md bg-octo-brass px-3 py-1.5 font-serif text-sm text-octo-onyx transition-colors duration-[180ms] hover:bg-octo-brass-hi">
              Approve &amp; continue
            </button>
          )}
          {canSendBack && (
            <button type="button" onClick={() => setSendingBack(true)}
              className="rounded-md border border-octo-brass px-3 py-1.5 font-serif text-sm text-octo-brass transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)]">
              Send back to {loopTargetRole} ⟜
            </button>
          )}
          <button type="button" onClick={() => setRejecting(true)}
            className="rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-xs text-octo-sage transition-colors duration-[180ms] hover:text-octo-ivory">
            {failed ? "Re-run" : "Reject"}
          </button>
          <button type="button" onClick={onAbort}
            className="rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-xs text-octo-mute transition-colors duration-[180ms] hover:text-octo-rouge">
            Abort
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <textarea
            autoFocus
            value={mode === "reject" ? rejectFeedback : sendBackFeedback}
            onChange={(e) => (mode === "reject" ? setRejectFeedback(e.target.value) : setSendBackFeedback(e.target.value))}
            placeholder={mode === "reject" ? "Optional feedback for the re-run…" : "Optional feedback for the send-back…"}
            className="h-20 resize-none rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-xs text-octo-ivory placeholder:font-serif placeholder:text-octo-mute"
          />
          <div className="flex gap-2">
            <button type="button" onClick={mode === "reject" ? handleReject : handleSendBack}
              className="rounded-md bg-octo-brass px-3 py-1.5 font-serif text-sm text-octo-onyx transition-colors duration-[180ms] hover:bg-octo-brass-hi">
              {mode === "reject" ? "Re-run the stage ⟶" : "Send back ⟶"}
            </button>
            <button type="button"
              onClick={() => { setRejecting(false); setSendingBack(false); setRejectFeedback(""); setSendBackFeedback(""); }}
              className="rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-xs text-octo-mute">
              Cancel
            </button>
          </div>
        </div>
      )}
    </FadeSwap>
  </div>
);
```

Add `import { FadeSwap } from "./primitives/FadeSwap";`. Note: only **Approve** is solid brass; **Send back** is brass-outlined serif; the strip is full-width (no `m-4`, no dashed border) because the Reveal dock owns placement.

- [ ] **Step 4: Recompose DirectCanvas**

Replace the early-return structure with a single `FadeSwap` (S3) and dock the checkpoint strip in a `Reveal` (S4). Full new body after the hooks:

```tsx
// Hold the last blocked stage so the strip's content survives the fold-away animation.
const [lastBlocked, setLastBlocked] = useState<RunStage | null>(null);

const run = detail?.run;
const stages = detail?.stages ?? [];
const blockedStage = stages.find((s) => s.status === "awaiting_checkpoint" || s.status === "failed") ?? null;
useEffect(() => { if (blockedStage) setLastBlocked(blockedStage); }, [blockedStage]);

const canvasKey =
  builder !== undefined ? "builder" : !viewedId || !run ? "launcher" : `run:${viewedId}`;

let body: ReactElement;
if (builder !== undefined) {
  body = (
    <PipelineBuilder
      pipeline={builder ? pipelines.find((p) => p.pipeline.id === builder) ?? null : null}
      onClose={() => setBuilder(undefined)}
    />
  );
} else if (!viewedId || !run) {
  body = (
    <PipelineSetup
      defaultTask={defaultTask}
      onBegin={(pipelineId, task, stageOverrides) =>
        void begin(workspaceId, pipelineId, task, stageOverrides, linkedIssueKey ?? undefined)
      }
      executingRun={executingRun}
      onEditPipeline={(id) => setBuilder(id)}
    />
  );
} else {
  const activeStage =
    stages.find((s) => s.status === "running" || s.status === "awaiting_checkpoint" || s.status === "failed") ??
    [...stages].reverse().find((s) => s.status === "done") ??
    stages[0] ??
    null;
  const shownStageId = selectedStageId ?? activeStage?.id ?? null;
  const shownStage = stages.find((s) => s.id === shownStageId) ?? null;

  // Loop props (unchanged logic, but computed off blockedStage)
  let loopTargetRole: string | null = null;
  let loopState: { iteration: number; max: number } | null = null;
  if (blockedStage && blockedStage.loopMode === "gated" && blockedStage.loopTargetPosition !== null && blockedStage.status === "awaiting_checkpoint") {
    const targetStage = stages.find((s) => s.position === blockedStage.loopTargetPosition);
    if (targetStage) {
      loopTargetRole = labelForRole(targetStage.role);
      loopState = { iteration: blockedStage.loopIterations, max: blockedStage.loopMaxIterations };
    }
  }

  const checkpointOpen = run.status === "paused" && blockedStage !== null;
  const barStage = blockedStage ?? lastBlocked;

  body = (
    <div className="flex h-full min-h-0 flex-col">
      <RunTrack run={run} stages={stages} selectedStageId={shownStageId} onSelectStage={(id) => selectStage(run.id, id)} />
      <StageFocus stage={shownStage} workspacePath={workspacePath} />
      <RunLedger run={run} stages={stages} />
      <Reveal open={checkpointOpen}>
        {barStage && (
          <CheckpointBar
            blockedStage={barStage}
            onApprove={() => void resolve(run.id, "approve")}
            onReject={(feedback) => void resolve(run.id, "reject", feedback || undefined)}
            onAbort={() => void abort(run.id)}
            loopTargetRole={loopTargetRole}
            loopState={loopState}
            onSendBack={(fb) => void resolve(run.id, "send_back", fb || undefined)}
          />
        )}
      </Reveal>
    </div>
  );
}

return (
  <FadeSwap swapKey={canvasKey} className="flex h-full min-h-0 flex-col [&>*]:min-h-0 [&>*]:flex-1">
    {body}
  </FadeSwap>
);
```

Imports to add: `Reveal`, `FadeSwap`, `RunLedger` (Task 8 — temporarily keep `RunCostMeter` until Task 8 lands if executing strictly in order; if Tasks 7 and 8 are done by the same engineer in sequence, do Task 8 first or swap the import at the end), `type ReactElement` from react, `type RunStage` from `../lib/ipc`. **Sequencing note: implement Task 8 (RunLedger) before this step, or keep `<RunCostMeter …/>` here and swap it in Task 8.** Default: keep `RunCostMeter` in this task; Task 8 swaps it.

If `FadeSwap`'s child sizing fights the `[&>*]` arbitrary variant, simplify: give `FadeSwap` `className="h-full min-h-0"` and let each body root carry `h-full` (launcher/builder already `flex-1 overflow-auto`; give them `h-full overflow-auto` if needed). Verify visually with `npm run dev`.

- [ ] **Step 5: Run tests**

`npx vitest run src/components/CheckpointBar.test.tsx src/components/DirectCanvas.test.tsx` → PASS. `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/CheckpointBar.tsx src/components/DirectCanvas.tsx src/components/CheckpointBar.test.tsx src/components/DirectCanvas.test.tsx
git commit -m "feat(direct/polish): docked checkpoint decision strip in a Reveal + canvas FadeSwap choreography"
```

---

### Task 8: RunLedger — savings-first strip with completion moment

**Files:**
- Create: `src/components/RunLedger.tsx`
- Create: `src/components/RunLedger.test.tsx`
- Modify: `src/components/DirectCanvas.tsx` (swap `RunCostMeter` → `RunLedger`)
- Delete: `src/components/RunCostMeter.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/RunLedger.test.tsx
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RunLedger } from "./RunLedger";
import type { Run, RunStage } from "../lib/ipc";

const baseRun = {
  id: "r1", status: "running", costUsd: 0.014, baselineUsd: 0.1,
} as unknown as Run;
const stages = [
  { id: "s1", role: "plan", costUsd: 0.01 },
  { id: "s2", role: "implement", costUsd: 0 },
] as unknown as RunStage[];

describe("RunLedger", () => {
  it("leads with savings and renders spent with tabular numerals", () => {
    render(<RunLedger run={baseRun} stages={stages} />);
    expect(screen.getByText("$0.09")).toBeInTheDocument();   // saved
    expect(screen.getByText(/86% under all-premium/)).toBeInTheDocument();
    expect(screen.getByText("$0.01")).toBeInTheDocument();   // spent
  });

  it("shows 'baseline unavailable' instead of hiding the slot", () => {
    render(<RunLedger run={{ ...baseRun, baselineUsd: 0 } as Run} stages={stages} />);
    expect(screen.getByText("baseline unavailable")).toBeInTheDocument();
  });

  it("toggles the per-stage breakdown", () => {
    render(<RunLedger run={baseRun} stages={stages} />);
    const strip = screen.getByRole("button", { name: /saved/i });
    expect(strip).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(strip);
    expect(strip).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Plan")).toBeInTheDocument(); // only stages with cost > 0
    expect(screen.queryByText("Implement")).not.toBeInTheDocument();
  });

  it("reveals the completion moment when the run transitions to completed", () => {
    const { rerender } = render(<RunLedger run={baseRun} stages={stages} />);
    expect(screen.queryByText(/This run saved/)).not.toBeVisible();
    rerender(<RunLedger run={{ ...baseRun, status: "completed" } as Run} stages={stages} />);
    expect(screen.getByText(/This run saved/)).toBeVisible();
  });
});
```

(If `toBeVisible` is unreliable against the grid-rows Reveal in jsdom, assert on the Reveal wrapper's `aria-hidden` instead.)

- [ ] **Step 2: Run to verify failure**, `npx vitest run src/components/RunLedger.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

```tsx
// src/components/RunLedger.tsx
import { useEffect, useRef, useState } from "react";
import type { Run, RunStage } from "../lib/ipc";
import { savingsVsBaseline } from "../lib/runStatus";
import { labelForRole } from "./RunTrack";
import { Reveal } from "./primitives/Reveal";

interface Props {
  run: Run;
  stages: RunStage[];
}

/** The ledger strip — Direct's cost surface, savings-first (the differentiator
 *  leads). Single calm line + 2px progress inset; click to unfold the per-stage
 *  breakdown. On run completion, a one-shot brass sweep + serif phrase. */
export function RunLedger({ run, stages }: Props) {
  const { saved, pct } = savingsVsBaseline(run.costUsd, run.baselineUsd);
  const fillPct = run.baselineUsd > 0 ? Math.min(100, (run.costUsd / run.baselineUsd) * 100) : 0;
  const [expanded, setExpanded] = useState(false);
  const [moment, setMoment] = useState(false);
  const prevStatus = useRef(run.status);

  useEffect(() => {
    setMoment(false);
    setExpanded(false);
    prevStatus.current = run.status;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  useEffect(() => {
    if (prevStatus.current !== "completed" && run.status === "completed" && run.baselineUsd > 0) {
      setMoment(true);
    }
    prevStatus.current = run.status;
  }, [run.status, run.baselineUsd]);

  const billed = stages.filter((s) => s.costUsd > 0);

  return (
    <div className="border-t border-octo-hairline bg-octo-panel">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left font-mono text-[11px]"
      >
        <span className="text-octo-mute">saved</span>
        {run.baselineUsd > 0 ? (
          <>
            <span className="octo-tabular text-octo-verdigris">${saved.toFixed(2)}</span>
            <span className="octo-tabular text-octo-mute">· {pct}% under all-premium</span>
          </>
        ) : (
          <span className="text-octo-mute">baseline unavailable</span>
        )}
        <span className="ml-auto text-octo-mute">spent</span>
        <span className="octo-tabular text-octo-brass">${run.costUsd.toFixed(2)}</span>
        <span className="font-mono text-[9px] text-octo-mute">{expanded ? "▾" : "▸"}</span>
      </button>
      <div className="mx-4 h-0.5 overflow-hidden rounded-sm bg-octo-onyx">
        <div
          className="h-full rounded-sm bg-octo-brass transition-[width] duration-[280ms]"
          style={{ width: `${fillPct}%`, transitionTimingFunction: "var(--ease-octo)" }}
        />
      </div>
      <Reveal open={expanded}>
        <div className="flex flex-wrap gap-x-5 gap-y-1 px-4 py-2 font-mono text-[10px] text-octo-mute">
          {billed.map((s) => (
            <span key={s.id}>
              {labelForRole(s.role)} <span className="octo-tabular text-octo-sage">${s.costUsd.toFixed(2)}</span>
            </span>
          ))}
          {billed.length === 0 && <span>no billed stages yet</span>}
        </div>
      </Reveal>
      <Reveal open={moment}>
        <div className="px-4 pb-3 pt-2">
          <div className="octo-sweep mb-2 h-px bg-gradient-to-r from-octo-brass to-transparent" />
          <p className="m-0 font-serif text-sm text-octo-ivory">
            This run saved <span className="octo-tabular text-octo-verdigris">${saved.toFixed(2)}</span> against the all-premium baseline.
          </p>
        </div>
      </Reveal>
      <div className="pb-1.5" />
    </div>
  );
}
```

- [ ] **Step 4: Swap into DirectCanvas and delete the old meter**

In `DirectCanvas.tsx`: replace the `RunCostMeter` import + usage with `RunLedger`. Then `git rm src/components/RunCostMeter.tsx`. Grep: `grep -rn "RunCostMeter" src/` → no matches.

- [ ] **Step 5: Run tests**

`npx vitest run src/components/RunLedger.test.tsx src/components/DirectCanvas.test.tsx` → PASS. `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add -A src/components/
git commit -m "feat(direct/polish): RunLedger savings-first strip + completion moment; retire RunCostMeter"
```

---

### Task 9: PipelineSetup — ceremonial launcher

**Files:**
- Modify: `src/components/PipelineSetup.tsx`
- Modify: `src/components/PipelineSetup.test.tsx`

- [ ] **Step 1: Read existing tests, extend**

New cases:

```tsx
it("renders the ceremony header", () => { /* getByText("Direct the work"); eyebrow "DIRECT" present */ });
it("shows skeletons while pipelines load, not the error card", () => { /* loaded=false → no "Retry" button; 3 skeleton divs */ });
it("shows 'estimating…' until the estimate arrives", () => { /* estimate null + selected → getByText("estimating…"), no "$0.00" */ });
it("renders the pipeline mini-map on each card", () => { /* a card shows "I" and "II" with a connector between */ });
it("leads the estimate with savings", () => { /* with estimate → getByText(/saves/) appears before the spent figure in the panel */ });
```

- [ ] **Step 2: Run to verify failures**, `npx vitest run src/components/PipelineSetup.test.tsx`.

- [ ] **Step 3: Recompose the render** (state/effects/handlers untouched). Replace the returned JSX with:

```tsx
return (
  <div className="h-full flex-1 overflow-auto px-8 py-6 octo-fade-in">
    {/* Ceremony */}
    <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">direct</p>
    <h1 className="m-0 mb-2 font-serif text-[22px] tracking-[-0.005em] text-octo-ivory">Direct the work</h1>
    <div className="animate-brass-grow mb-8 h-px bg-gradient-to-r from-octo-brass to-transparent" style={{ width: 28 }} />

    <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">I · The brief</p>
    <textarea
      value={task}
      onChange={(e) => setTask(e.target.value)}
      placeholder="What should the team build?"
      className="mb-8 h-20 w-full resize-none rounded-md border border-octo-hairline bg-octo-panel-2 px-3 py-2 font-mono text-sm text-octo-ivory transition-colors duration-[180ms] placeholder:font-serif placeholder:text-octo-mute focus:border-[var(--brass-dim)]"
    />

    <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">II · The pipeline</p>
    {!loaded ? (
      <div className="mb-4 flex gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="octo-fade-in h-24 flex-1 rounded-lg border border-octo-hairline bg-octo-panel-2" />
        ))}
      </div>
    ) : pipelines.length === 0 ? (
      error ? (
        <div className="mb-4 rounded-lg border border-octo-hairline bg-octo-panel-2 px-4 py-5 text-center">
          <p className="mb-3 font-mono text-xs text-octo-rouge">Couldn't load pipelines: {error}</p>
          <button type="button" onClick={() => void load()}
            className="rounded-md border border-octo-brass px-3 py-1.5 font-mono text-xs text-octo-brass">
            Retry
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => onEditPipeline(null)}
          className="mb-4 block w-full rounded-lg border border-octo-hairline bg-octo-panel-2 px-4 py-6 text-center font-serif text-sm text-octo-brass transition-colors duration-[180ms] hover:border-[var(--brass-dim)]">
          No pipelines yet — compose your first ⟶
        </button>
      )
    ) : (
      <div className="mb-4 flex gap-3">
        {pipelines.map((p) => (
          <div key={p.pipeline.id} className="group relative min-w-0 flex-1">
            <button
              type="button"
              onClick={() => { setSelectedId(p.pipeline.id); setOverrides({}); }}
              className={`w-full rounded-lg border p-3 text-left transition-colors duration-[180ms] ${
                p.pipeline.id === selectedId
                  ? "border-octo-brass bg-[var(--brass-ghost)]"
                  : "border-octo-hairline bg-octo-panel-2 hover:border-[var(--brass-dim)]"
              }`}
            >
              <h3 className="mb-1 truncate pr-10 font-serif text-sm text-octo-ivory">{p.pipeline.name}</h3>
              <p className="m-0 mb-2 line-clamp-2 text-[11px] text-octo-sage">{p.pipeline.description}</p>
              <PipelineMiniMap stages={p.stages} />
            </button>
            <button
              type="button"
              onClick={() => onEditPipeline(p.pipeline.id)}
              className="absolute right-2 top-2 rounded-sm border border-transparent px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-octo-mute opacity-0 transition-opacity duration-[180ms] hover:border-octo-hairline hover:text-octo-brass focus:opacity-100 group-hover:opacity-100"
            >
              Edit
            </button>
          </div>
        ))}
      </div>
    )}
    <button type="button" onClick={() => onEditPipeline(null)}
      className="mb-8 font-serif text-[13px] text-octo-brass transition-colors duration-[180ms] hover:text-octo-ivory">
      ⟶ Compose a new pipeline
    </button>

    {selected && (
      <>
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">III · The team</p>
        <div className="mb-8 overflow-hidden rounded-lg border border-octo-hairline">
          {selected.stages.map((s) => (
            <div key={s.id} className="flex items-center gap-3 border-b border-octo-hairline bg-octo-panel-2 px-3 py-2.5 last:border-b-0">
              <span className="w-28 shrink-0 truncate font-serif text-sm text-octo-ivory">{labelForRole(s.role)}</span>
              <div className="min-w-0 flex-1">
                <ModelPicker
                  activeModel={overrides[s.position] ?? s.agentModel}
                  onSelectModel={(m) => setOverrides((prev) => ({ ...prev, [s.position]: m }))}
                  allowedProviders={s.substrate === "cli" ? ["anthropic"] : undefined}
                />
              </div>
              <span className="w-14 shrink-0 text-right font-mono text-[9px] uppercase tracking-[0.1em] text-octo-mute">
                {s.checkpoint ? "⟜ gate" : ""}
              </span>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-5 rounded-lg border border-octo-hairline bg-octo-panel-2 p-4">
          <div>
            <div className="mb-0.5 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">this pipeline</div>
            {estimate ? (
              <>
                <div className="octo-tabular font-serif text-2xl text-octo-verdigris">
                  saves ~${saved.toFixed(2)}
                  <span className="ml-2 font-mono text-xs text-octo-mute">{savedPct}%</span>
                </div>
                <div className="octo-tabular font-mono text-xs text-octo-mute">
                  runs at <span className="text-octo-brass">~${estimate.estimateUsd.toFixed(2)}</span> · all-premium ${estimate.baselineUsd.toFixed(2)}
                </div>
              </>
            ) : (
              <div className="h-12 font-mono text-xs text-octo-mute">estimating…</div>
            )}
          </div>
          <div className="ml-auto flex flex-col items-end gap-1.5">
            <button
              type="button"
              disabled={!task.trim() || executingRun}
              onClick={() => onBegin(selected.pipeline.id, task.trim(), overrideTuples())}
              className="rounded-lg bg-octo-brass px-5 py-2.5 font-serif text-base text-octo-onyx transition-colors duration-[180ms] hover:bg-octo-brass-hi disabled:opacity-40"
            >
              Begin the run ⟶
            </button>
            <p className="m-0 h-4 font-mono text-[10px] text-octo-mute">
              {executingRun ? "A run is in progress — finish or abort it before starting another." : ""}
            </p>
          </div>
        </div>
      </>
    )}
  </div>
);
```

And add the mini-map component at the bottom of the file (import `ROMAN` from `./RunTrack` — extend the existing `labelForRole` import):

```tsx
function PipelineMiniMap({ stages }: { stages: PipelineWithStages["stages"] }) {
  const sorted = [...stages].sort((a, b) => a.position - b.position);
  return (
    <div className="truncate font-mono text-[10px]">
      {sorted.map((s, i) => (
        <span key={s.id}>
          {i > 0 && <span className="text-octo-mute"> {sorted[i - 1].checkpoint ? "⟜" : "⟶"} </span>}
          <span className="text-octo-brass/80">{ROMAN[i] ?? i + 1}</span>
        </span>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run tests**, `npx vitest run src/components/PipelineSetup.test.tsx` → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/PipelineSetup.tsx src/components/PipelineSetup.test.tsx
git commit -m "feat(direct/polish): ceremonial launcher — header moment, mini-maps, savings-first estimate, designed states"
```

---

### Task 10: PipelineBuilder — composition, not configuration

**Files:**
- Modify: `src/components/PipelineBuilder.tsx`
- Modify: `src/components/PipelineBuilder.test.tsx`

**All logic stays byte-identical:** `DraftStage`, `newKey`, `draftsFrom`, `normalizeLoops`, `toStageDrafts`, `mutate`, `patch`, `move`, `addStage`, `onSave`, `onDelete`, fork-on-builtin naming. Only `removeStage` gains an exit fade, and the render is recomposed.

- [ ] **Step 1: Read existing tests, extend**

Existing serialization/normalization tests must keep passing untouched. Update interaction selectors (role select → Listbox button, checkbox → switch, number input → Stepper buttons, ↑/↓/✕ → `Move up`/`Move down`/`Remove stage` aria-labels). Add:

```tsx
it("renders the live preview rail with loop-back annotation", () => {
  /* edit a review stage to loop to stage I ×2 → rail shows "⟜ back to I · ×2" */
});
it("keeps loop sub-controls mounted but inert when linear (S1)", () => {
  /* review role, no target → Stepper buttons present; their wrapper has pointer-events-none opacity-30 */
});
it("two-step delete still works", () => { /* unchanged behavior, new markup */ });
```

- [ ] **Step 2: Run to verify failures**, `npx vitest run src/components/PipelineBuilder.test.tsx`.

- [ ] **Step 3: Recompose**

New imports:

```tsx
import { useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Listbox } from "./controls/Listbox";
import { SegmentedControl } from "./controls/SegmentedControl";
import { TogglePill } from "./controls/TogglePill";
import { Stepper } from "./controls/Stepper";
import { IconButton } from "./controls/IconButton";
import { Reveal } from "./primitives/Reveal";
```

Module-level option data (next to `ALL_ROLES`):

```tsx
// Keep in sync with KNOWN_ROLES in src-tauri/src/db.rs (authoritative validator).
const ROLE_DESCRIPTIONS: Record<string, string> = {
  plan: "Outline the approach before any code",
  plan_review: "Critique the plan — can loop back",
  implement: "Write the code in the worktree",
  code_review: "Review the diff — can loop back",
  test: "Write and run the tests",
  repro: "Reproduce the reported problem",
  fix: "Apply the fix",
  verify: "Confirm the fix holds — can loop back",
  critique: "Critique the artifact — can loop back",
  refine: "Polish from the critique",
};
const ROLE_OPTIONS = ALL_ROLES.map((r) => ({ value: r, label: labelForRole(r), description: ROLE_DESCRIPTIONS[r] }));
const SUBSTRATE_OPTIONS = [
  { value: "api" as const, label: "API", activeClass: "bg-[var(--state-blue-ghost)] text-octo-state-blue" },
  { value: "cli" as const, label: "CLI", activeClass: "bg-[var(--state-purple-ghost)] text-octo-state-purple" },
];
const MODE_OPTIONS = [
  { value: "gated" as const, label: "Gated" },
  { value: "auto" as const, label: "Auto" },
];
```

Exit-fade removal (replaces `removeStage`; keep `mutate`):

```tsx
const [exiting, setExiting] = useState<Set<string>>(new Set());
const removeStage = (key: string) => {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
    mutate((prev) => prev.filter((s) => s.key !== key));
    return;
  }
  setExiting((prev) => new Set(prev).add(key));
  setTimeout(() => {
    setExiting((prev) => { const n = new Set(prev); n.delete(key); return n; });
    mutate((prev) => prev.filter((s) => s.key !== key));
  }, 120);
};
```

Card refs for preview-rail jumps:

```tsx
const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
const jumpTo = (key: string) => cardRefs.current[key]?.scrollIntoView({ behavior: "smooth", block: "center" });
```

Preview rail component (bottom of file):

```tsx
function PreviewRail({ stages, onJump }: { stages: DraftStage[]; onJump: (key: string) => void }) {
  return (
    <div className="mb-8 flex items-start overflow-x-auto rounded-lg border border-octo-hairline bg-octo-panel-2 px-4 py-3">
      {stages.map((s, i) => {
        const targetIdx = s.loopTargetKey ? stages.findIndex((t) => t.key === s.loopTargetKey) : -1;
        const looping = targetIdx !== -1 && targetIdx < i;
        return (
          <div key={s.key} className="flex items-start">
            {i > 0 && (
              <span className="mx-2 mt-1 text-octo-brass opacity-60">{stages[i - 1].checkpoint ? "⟜" : "⟶"}</span>
            )}
            <button type="button" onClick={() => onJump(s.key)}
              className="flex flex-col items-start gap-0.5 rounded-sm px-1.5 py-0.5 text-left transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)]">
              <span className="font-mono text-[10px] text-octo-brass">{ROMAN[i] ?? i + 1}</span>
              <span className="whitespace-nowrap font-serif text-[13px] text-octo-ivory">{labelForRole(s.role)}</span>
              <span className="h-3.5 whitespace-nowrap font-mono text-[9px] text-octo-mute">
                {looping ? `⟜ back to ${ROMAN[targetIdx] ?? targetIdx + 1} · ×${s.loopMaxIterations}` : ""}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
```

The render:

```tsx
return (
  <div className="h-full flex-1 overflow-auto px-8 py-6 octo-fade-in">
    <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">direct · builder</p>
    <input
      value={name}
      onChange={(e) => setName(e.target.value)}
      placeholder="Name this pipeline"
      aria-label="Pipeline name"
      className="mb-1 w-full border-b border-transparent bg-transparent pb-1 font-serif text-[22px] tracking-[-0.005em] text-octo-ivory outline-none transition-colors duration-[180ms] placeholder:font-serif placeholder:text-octo-mute hover:border-octo-hairline focus:border-[var(--brass-dim)]"
    />
    <input
      value={description}
      onChange={(e) => setDescription(e.target.value)}
      placeholder="When should the team reach for it?"
      aria-label="Pipeline description"
      className="mb-6 w-full border-b border-transparent bg-transparent pb-1 font-mono text-xs text-octo-sage outline-none transition-colors duration-[180ms] placeholder:text-octo-mute hover:border-octo-hairline focus:border-[var(--brass-dim)]"
    />

    <PreviewRail stages={stages} onJump={jumpTo} />

    <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">II · Compose the stages</p>
    <div className="mb-4 flex flex-col gap-3">
      {stages.map((s, i) => (
        <div
          key={s.key}
          ref={(el) => { cardRefs.current[s.key] = el; }}
          className={`rounded-lg border border-octo-hairline bg-octo-panel-2 px-4 py-3 ${
            exiting.has(s.key) ? "octo-fade-out pointer-events-none" : "octo-rise-in"
          }`}
        >
          <div className="flex items-center gap-3">
            <span className="w-7 shrink-0 font-mono text-[11px] text-octo-brass">{ROMAN[i] ?? i + 1}</span>
            <Listbox value={s.role} options={ROLE_OPTIONS} onChange={(r) => patch(s.key, { role: r })} ariaLabel="Stage role" className="w-44 shrink-0" />
            <div className="min-w-0 flex-1">
              <ModelPicker
                activeModel={s.agentModel}
                onSelectModel={(m) => patch(s.key, { agentModel: m })}
                allowedProviders={s.substrate === "cli" ? ["anthropic"] : undefined}
              />
            </div>
            <SegmentedControl options={SUBSTRATE_OPTIONS} value={s.substrate} onChange={(v) => patch(s.key, { substrate: v })} ariaLabel="Execution substrate" />
            <TogglePill on={s.checkpoint} onChange={(v) => patch(s.key, { checkpoint: v })} label="⟜ gate" ariaLabel="Approval gate" />
            <div className="ml-auto flex items-center gap-1">
              <IconButton label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ChevronUp size={12} /></IconButton>
              <IconButton label="Move down" disabled={i === stages.length - 1} onClick={() => move(i, 1)}><ChevronDown size={12} /></IconButton>
              <IconButton label="Remove stage" danger disabled={stages.length === 1} onClick={() => removeStage(s.key)}><X size={12} /></IconButton>
            </div>
          </div>

          <Reveal open={REVIEW_ROLES.has(s.role)}>
            <div className="mt-3 border-t border-octo-hairline pt-3">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">⟜ loop</span>
                <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.1em] text-octo-mute">
                  return to
                  <Listbox
                    value={s.loopTargetKey}
                    options={[
                      { value: "", label: "— linear —" },
                      ...stages.slice(0, i).map((t, ti) => ({ value: t.key, label: `${ROMAN[ti] ?? ti + 1} · ${labelForRole(t.role)}` })),
                    ]}
                    onChange={(v) =>
                      patch(s.key, v
                        ? { loopTargetKey: v, loopMaxIterations: s.loopMaxIterations || 2, loopMode: s.loopMode ?? "gated" }
                        : { loopTargetKey: null, loopMaxIterations: 0, loopMode: null })
                    }
                    placeholder="— linear —"
                    ariaLabel="Loop target"
                    className="w-44"
                  />
                </label>
                {/* S1: sub-controls stay mounted — they dim instead of reflowing. */}
                <div className={`flex items-center gap-x-5 transition-opacity duration-[220ms] ${s.loopTargetKey ? "" : "pointer-events-none opacity-30"}`} aria-hidden={!s.loopTargetKey}>
                  <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.1em] text-octo-mute">
                    max loop-backs
                    <Stepper value={s.loopMaxIterations || 2} min={1} max={9} onChange={(v) => patch(s.key, { loopMaxIterations: v })} ariaLabel="Max loop-backs" />
                  </label>
                  <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.1em] text-octo-mute">
                    mode
                    <SegmentedControl options={MODE_OPTIONS} value={s.loopMode ?? "gated"} onChange={(v) => patch(s.key, { loopMode: v })} ariaLabel="Loop mode" />
                  </label>
                </div>
              </div>
              <div className="mt-1.5 h-4 font-mono text-[10px] text-octo-mute">
                {s.loopCleared
                  ? "Loop target removed — review is linear again."
                  : s.loopTargetKey && s.loopMode === "auto"
                    ? "Auto relies on a parseable verdict; it gates to you otherwise."
                    : ""}
              </div>
            </div>
          </Reveal>
          <Reveal open={s.loopCleared && !REVIEW_ROLES.has(s.role)}>
            <div className="mt-2 border-t border-octo-hairline pt-2 font-mono text-[10px] text-octo-mute">
              Loop target removed — review is linear again.
            </div>
          </Reveal>
        </div>
      ))}
    </div>
    <button type="button" onClick={addStage}
      className="mb-8 font-serif text-[13px] text-octo-brass transition-colors duration-[180ms] hover:text-octo-ivory">
      ⟶ Add another stage
    </button>

    <Reveal open={error !== null}>
      <div className="mb-3 rounded-md border-l-2 border-octo-rouge bg-[var(--rouge-ghost)] px-3 py-2 font-mono text-xs text-octo-rouge">
        {error}
      </div>
    </Reveal>

    <div className="sticky bottom-0 -mx-8 flex items-center gap-2 border-t border-octo-hairline bg-octo-panel px-8 py-3">
      <button type="button" disabled={saving || !name.trim()} onClick={() => void onSave()}
        className="rounded-lg bg-octo-brass px-5 py-2.5 font-serif text-base text-octo-onyx transition-colors duration-[180ms] hover:bg-octo-brass-hi disabled:opacity-40">
        {isBuiltin ? "Save as my copy ⟶" : "Save pipeline ⟶"}
      </button>
      <button type="button" onClick={onClose}
        className="rounded-md border border-octo-hairline px-3 py-2 font-mono text-xs text-octo-mute transition-colors duration-[180ms] hover:text-octo-sage">
        Cancel
      </button>
      {pipeline && !isBuiltin && (
        confirmingDelete ? (
          <button type="button" onClick={() => void onDelete()}
            className="ml-auto rounded-md border border-octo-rouge px-3 py-2 font-mono text-xs text-octo-rouge">
            Confirm delete?
          </button>
        ) : (
          <button type="button" onClick={() => setConfirmingDelete(true)}
            className="ml-auto rounded-md border border-octo-hairline px-3 py-2 font-mono text-xs text-octo-mute transition-colors duration-[180ms] hover:text-octo-rouge">
            Delete
          </button>
        )
      )}
    </div>
  </div>
);
```

Note on the loop-target `Listbox`: `value={s.loopTargetKey}` is `string | null`; picking `— linear —` calls `onChange("")` which the handler maps to the clear-patch (same semantics as the old `<select>`).

- [ ] **Step 4: Run tests**, `npx vitest run src/components/PipelineBuilder.test.tsx` → PASS (serialization tests untouched and green). `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/PipelineBuilder.tsx src/components/PipelineBuilder.test.tsx
git commit -m "feat(direct/polish): builder recomposition — preview rail, Atelier controls, inline title, sticky footer"
```

---

### Task 11: CompanionRuns — the runs ledger

**Files:**
- Modify: `src/components/CompanionRuns.tsx`
- Modify: `src/components/CompanionRuns.test.tsx`

- [ ] **Step 1: Extend tests**

```tsx
it("shows the cumulative savings ledger when baselines exist", () => {
  /* two runs with baselineUsd>0 → getByText(/across 2 runs/) and the tabular saved value */
});
it("reserves the executing-dot slot on every row (S1)", () => {
  /* a non-executing row still contains the w-2 dot span (text-transparent) */
});
it("uses the new empty-state copy", () => { /* "No runs yet — direct your first." */ });
```

- [ ] **Step 2: Run to verify failures.**

- [ ] **Step 3: Recompose**

```tsx
export function CompanionRuns({ workspaceId }: Props) {
  const loadRuns = useRunsStore((s) => s.loadRuns);
  const runs = useRunsStore((s) => s.getRuns(workspaceId));
  const viewedId = useRunsStore((s) => s.getViewedRunId(workspaceId));
  const selectRun = useRunsStore((s) => s.selectRun);

  useEffect(() => { void loadRuns(workspaceId); }, [workspaceId, loadRuns]);

  const totals = runs.reduce(
    (acc, r) => {
      if (r.baselineUsd > 0) {
        acc.saved += Math.max(0, r.baselineUsd - r.costUsd);
        acc.n += 1;
      }
      return acc;
    },
    { saved: 0, n: 0 },
  );

  return (
    <div className="border-b border-octo-hairline">
      <div className="flex items-center justify-between px-3.5 pb-1 pt-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
          Runs <span className="tracking-normal text-octo-mute">· {runs.length}</span>
        </span>
        <button type="button" onClick={() => selectRun(workspaceId, null)}
          className="font-serif text-[12px] text-octo-brass transition-colors duration-[180ms] hover:text-octo-ivory">
          ⟶ Begin a new run
        </button>
      </div>
      {totals.n > 0 && totals.saved > 0 && (
        <div className="px-3.5 pb-1.5 font-mono text-[10px] text-octo-mute">
          saved <span className="octo-tabular text-octo-verdigris">${totals.saved.toFixed(2)}</span> across {totals.n} run{totals.n === 1 ? "" : "s"}
        </div>
      )}
      {runs.length === 0 && (
        <div className="px-3.5 pb-3 font-serif text-[12px] text-octo-mute">No runs yet — direct your first.</div>
      )}
      {runs.map((r) => {
        const meta = runStatusMeta(r.status);
        const executing = r.status === "running" || r.status === "paused";
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => selectRun(workspaceId, r.id)}
            className={`octo-rise-in flex w-full flex-col gap-0.5 border-l-2 px-3.5 py-2 text-left transition-colors duration-[180ms] ${
              r.id === viewedId ? "border-octo-brass bg-[var(--brass-ghost)]" : "border-transparent hover:bg-octo-panel-2"
            }`}
          >
            <div className="truncate text-[13px] text-octo-ivory">{r.task || "(untitled run)"}</div>
            <div className="flex items-center gap-1.5 font-mono text-[10px] text-octo-sage">
              <span className={`w-2 shrink-0 text-center ${executing ? "text-octo-brass" : "text-transparent"}`}>●</span>
              <span className={meta.className}>{meta.label}</span>
              <span className="octo-tabular">· ${r.costUsd.toFixed(2)}</span>
              {r.linkedIssueKey && <span>· {r.linkedIssueKey}</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run tests**, `npx vitest run src/components/CompanionRuns.test.tsx` → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/CompanionRuns.tsx src/components/CompanionRuns.test.tsx
git commit -m "feat(direct/polish): companion runs ledger — cumulative savings, fixed dot slot, copy"
```

---

### Task 12: Identity checklist, docs, and full verification

**Files:**
- Modify: `docs/design-system.md`
- Modify: any Direct file the greps below still flag

- [ ] **Step 1: Run the identity greps and fix every hit**

```bash
# Eyebrow tracking drift in Direct surfaces (should be empty):
grep -rn "tracking-\[0.1[0-9]em\]" src/components/RunTrack.tsx src/components/StageFocus.tsx src/components/CheckpointBar.tsx src/components/PipelineSetup.tsx src/components/PipelineBuilder.tsx src/components/CompanionRuns.tsx src/components/RunLedger.tsx src/components/DirectCanvas.tsx
# (tracking-[0.1em] on tiny pills/labels ≤9px is sanctioned; 0.12–0.14em eyebrow drift is not)

# Raw hex outside styles.css (should be empty):
grep -rn "#[0-9a-fA-F]\{3,8\}" src/components/ src/hooks/ --include="*.tsx" --include="*.ts" | grep -v test

# Native form controls left in Direct surfaces (should be empty):
grep -rn "<select\|type=\"number\"\|type=\"checkbox\"" src/components/PipelineBuilder.tsx src/components/PipelineSetup.tsx src/components/RunTrack.tsx src/components/StageFocus.tsx src/components/CheckpointBar.tsx
```

- [ ] **Step 2: Document the new primitives in `docs/design-system.md`**

In §6, extend the primitives table:

```markdown
| `<FadeSwap swapKey>` | mutually exclusive view swaps (canvas states, pane modes) | exit fade 120ms → `.octo-fade-in` |
| `<Reveal open>` | expanding/collapsing regions (decision strips, sub-panels) | grid-rows 0fr↔1fr · --dur-standard |
| `.octo-tabular` | every live numeric value (cost, %, mm:ss, counters) | font-variant-numeric: tabular-nums |
| `.octo-sweep` | one-shot brass rule sweep (run-completion moment only) | width 0→100% · --dur-reveal |
```

And add the **stability doctrine** as a short subsection (S1–S6 from the spec, one line each). In the "Direct mode — canvas patterns" section, update: the cost meter is the **ledger strip** (single line, savings-first, expandable breakdown, completion sweep); the checkpoint bar is a **docked decision strip** inside a Reveal; stage cards are fixed-geometry with a reserved live line. Note the provider dot tokens.

- [ ] **Step 3: Full verification**

```bash
npm run typecheck        # clean
npx vitest run           # all green
npm run build            # clean
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs(design-system): stability doctrine, FadeSwap/Reveal/octo-tabular/sweep primitives, Direct pattern updates"
```

---

## Final wave (orchestrator, not subagents)

1. `/code-review` on the branch; fix ALL findings.
2. `git fetch origin main && git rebase origin/main` (other agents push to main — resolve conflicts).
3. Push, open PR, merge after review fixes.
4. Build the local `.app` for the user to verify (wipe `src-tauri/target/universal-apple-darwin/release/bundle` + `touch src-tauri/src/lib.rs` first — stale-embed gotcha). **Do NOT release without explicit user approval.**
