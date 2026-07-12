# Direct Beauty Redesign — Plan 1 of 4: Foundations + the Heart of the Run

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the redesign's shared foundations (tokens, icon vocabulary, StageDots, beacon selector) and rebuild the active-run canvas (RunFlow, StageFocus, RunControlBar, RunLedger, DirectCanvas header) under the two laws: depth of field + the single brass beacon.

**Architecture:** Presentation-layer only — zero Rust/IPC/store-logic changes. New pure modules (`roleIcons`, `beacon`, `StageDots`) are unit-tested; the run-canvas components are restyled around them. Spec: `docs/superpowers/specs/2026-07-11-direct-beauty-redesign-design.md` (§2 laws, §3 retirements, §4 vocabulary, §5 heart).

**Tech Stack:** React 19 + TypeScript, Tailwind v4 tokens (`--color-octo-*`), Zustand, Vitest + @testing-library/react, lucide-react.

**The initiative is 4 plans.** This is Plan 1. Plans 2 (launcher), 3 (builder), 4 (fleet + app-wide retirement sweep of `§`/romans/gradients + design-system/CLAUDE/FEATURES doc rewrite) are written when reached. Each plan ships working, typechecked, tested software.

**Worktree:** Execute in an isolated worktree (superpowers:using-git-worktrees) on a branch named `direct-beauty-1`. Rebase on `main` before PR (parallel agents share this repo). ~5 PTY sandbox test failures in the suite are known noise — ignore exactly those.

**Binding user norms (memory):** no italics; no Roman numerals; no `§`; no gradient lines anywhere; no arrows as ornament; tokens, never literals.

---

## File structure

| File | Role |
|---|---|
| `src/styles.css` | + `--brass-line`, `--brass-quiet`, `--stagger-step` tokens (modify) |
| `src/lib/tokens.ts` | Typed mirror of the two new brass alphas (modify) |
| `src/lib/roleIcons.ts` | NEW — the single role→icon and tool→icon vocabulary |
| `src/lib/roleIcons.test.ts` | NEW |
| `src/lib/beacon.ts` | NEW — pure `beaconAnchor()` selector (Law 2) |
| `src/lib/beacon.test.ts` | NEW |
| `src/components/direct/StageDots.tsx` | NEW — universal micro-track (consumed by Plans 2/4; built + tested here as a foundation) |
| `src/components/direct/StageDots.test.tsx` | NEW |
| `src/components/RunFlow.tsx` | REWRITE — drawn connectors, essence/subject cards, beacon prop |
| `src/components/RunFlow.test.tsx` | NEW |
| `src/components/RunControlBar.tsx` | Modify — RunningBar removed, beacon on primary CTAs |
| `src/components/DirectCanvas.tsx` | Modify — beacon wiring, run controls into the header |
| `src/components/DirectCanvas.test.tsx` | Modify — RUNNINGBAR assertions → header-control assertions |
| `src/components/StageFocus.tsx` | Modify — icon+eyebrow+serif header, flat journal tool lines, de-`§` drawer |
| `src/components/StageFocus.test.tsx` | Modify — one test title |
| `src/components/RunLedger.tsx` | Modify — solid sweep line |
| `docs/FEATURES.md` | Modify — heart-surface bullets |

Baseline check before Task 1: `npm run typecheck && npx vitest run` must be green (modulo the known PTY noise).

---

### Task 1: Tokens — `--brass-line`, `--brass-quiet`, `--stagger-step`

**Files:**
- Modify: `src/styles.css:62-69` (alpha utilities block) and `:104-108` (motion tokens block)
- Modify: `src/lib/tokens.ts:20-21`

- [ ] **Step 1: Add the CSS tokens**

In `src/styles.css`, the alpha block currently reads (lines 62-69):

```css
  --brass-dim:      rgba(212, 165, 116, 0.4);
  --brass-ghost:    rgba(212, 165, 116, 0.08);
  --brass-faint:    rgba(212, 165, 116, 0.04);
```

Insert after `--brass-dim`:

```css
  /* Solid traversed-connector ink (no gradients — lines are solid or hairline). */
  --brass-line:     rgba(212, 165, 116, 0.55);
  /* "Done, long settled" quiet dot in StageDots. */
  --brass-quiet:    rgba(212, 165, 116, 0.22);
```

In the motion block (after `--dur-reveal: 600ms;`, line 108) insert:

```css
  /* Shared list-entrance stagger step (was a magic 45ms in RunFlow/StageFlow). */
  --stagger-step: 45ms;
```

- [ ] **Step 2: Mirror in tokens.ts**

In `src/lib/tokens.ts` after `brassGhost` (line 21) add:

```ts
  brassLine: "rgba(212, 165, 116, 0.55)",
  brassQuiet: "rgba(212, 165, 116, 0.22)",
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/styles.css src/lib/tokens.ts
git commit -m "feat(direct): brass-line/brass-quiet/stagger tokens for the beauty redesign"
```

---

### Task 2: `roleIcons.ts` — the icon vocabulary (replaces `§` and the artifact-icon-only map)

**Files:**
- Create: `src/lib/roleIcons.ts`
- Test: `src/lib/roleIcons.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/roleIcons.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { CircleDashed, Eye, Pencil, Search, SquareTerminal, Wrench } from "lucide-react";
import { iconForRole, iconForTool } from "./roleIcons";

describe("iconForRole", () => {
  it("maps every built-in archetype to a real icon", () => {
    const builtIns = [
      "plan", "plan_review", "architect", "implement", "code_review", "test",
      "repro", "fix", "verify", "critique", "refine", "security_review",
      "pull_request", "merge", "release",
    ];
    for (const role of builtIns) expect(iconForRole(role)).not.toBe(CircleDashed);
  });

  it("implement uses the wrench", () => {
    expect(iconForRole("implement")).toBe(Wrench);
  });

  it("falls back to CircleDashed for custom roles", () => {
    expect(iconForRole("my_custom_role")).toBe(CircleDashed);
  });
});

describe("iconForTool", () => {
  it("matches the tool verb case-insensitively", () => {
    expect(iconForTool("Read")).toBe(Eye);
    expect(iconForTool("EDIT")).toBe(Pencil);
    expect(iconForTool("Bash")).toBe(SquareTerminal);
    expect(iconForTool("Grep")).toBe(Search);
    expect(iconForTool("WebFetch")).toBe(iconForTool("web_search"));
  });

  it("falls back for unknown tools", () => {
    expect(iconForTool("Wizardry")).toBe(CircleDashed);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/lib/roleIcons.test.ts`
Expected: FAIL — "Cannot find module './roleIcons'".

- [ ] **Step 3: Implement**

`src/lib/roleIcons.ts`:

```ts
// The single icon vocabulary for Direct (and, from Plan 4, the Talk tool
// cards): one lucide glyph per role archetype and per tool verb. Replaces the
// retired `§` prefix — an icon + `title` tooltip instead of a typographic mark.
// Spec: docs/superpowers/specs/2026-07-11-direct-beauty-redesign-design.md §4.3

import {
  BadgeCheck, CircleDashed, ClipboardList, Compass, Eye, FlaskConical,
  GitMerge, GitPullRequest, Globe, Hammer, PenLine, Pencil, Rocket, Search,
  Shield, SquareTerminal, Wrench, type LucideIcon,
} from "lucide-react";

const ROLE_ICON: Record<string, LucideIcon> = {
  plan: ClipboardList,
  plan_review: PenLine,
  architect: Compass,
  implement: Wrench,
  code_review: Search,
  test: FlaskConical,
  repro: FlaskConical,
  fix: Hammer,
  verify: BadgeCheck,
  critique: PenLine,
  refine: PenLine,
  security_review: Shield,
  pull_request: GitPullRequest,
  merge: GitMerge,
  release: Rocket,
};

/** Icon for a stage role. Custom roles fall back to a neutral dashed circle. */
export function iconForRole(role: string): LucideIcon {
  return ROLE_ICON[role] ?? CircleDashed;
}

/** Icon for a live-journal tool verb. Substring match on the lowercased name
 *  so "Read", "read_file", and "READ" all resolve the same way. */
export function iconForTool(tool: string): LucideIcon {
  const t = tool.toLowerCase();
  if (t.includes("read") || t.includes("view") || t.includes("cat")) return Eye;
  if (t.includes("edit") || t.includes("write") || t.includes("patch")) return Pencil;
  if (t.includes("bash") || t.includes("run") || t.includes("exec") || t.includes("command") || t.includes("terminal")) return SquareTerminal;
  if (t.includes("grep") || t.includes("glob") || t.includes("search") || t.includes("find")) return Search;
  if (t.includes("web") || t.includes("fetch") || t.includes("http")) return Globe;
  return CircleDashed;
}
```

- [ ] **Step 4: Run the test — PASS expected**

Run: `npx vitest run src/lib/roleIcons.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/lib/roleIcons.ts src/lib/roleIcons.test.ts
git commit -m "feat(direct): role/tool icon vocabulary replacing the retired § prefix"
```

---

### Task 3: `StageDots` — the universal micro-track

**Files:**
- Create: `src/components/direct/StageDots.tsx`
- Test: `src/components/direct/StageDots.test.tsx`

- [ ] **Step 1: Write the failing test**

`src/components/direct/StageDots.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StageDots } from "./StageDots";

describe("StageDots — the universal micro-track", () => {
  it("renders one dot per stage in the status colour family", () => {
    const { container } = render(
      <StageDots
        stages={[
          { status: "done" },
          { status: "running" },
          { status: "failed", error: "rate limit exceeded" }, // transient → amber
          { status: "failed", error: "assertion failed" },    // hard → rouge
          { status: "pending", checkpoint: true },            // gate → ring
        ]}
      />,
    );
    const dots = container.querySelectorAll("span[data-dot]");
    expect(dots).toHaveLength(5);
    expect(dots[0].className).toContain("bg-octo-verdigris");
    expect(dots[1].className).toContain("bg-octo-brass");
    expect(dots[2].className).toContain("bg-octo-warning");
    expect(dots[3].className).toContain("bg-octo-rouge");
    expect(dots[4].className).toContain("bg-octo-hairline");
    expect(dots[4].className).toContain("ring-1");
  });

  it("titles each dot with its stage word when a title is given", () => {
    const { container } = render(<StageDots stages={[{ status: "running", title: "implementer" }]} />);
    expect(container.querySelector("span[data-dot]")!.getAttribute("title")).toBe("implementer — running");
  });
});
```

- [ ] **Step 2: Run it — FAIL expected** (`Cannot find module './StageDots'`)

Run: `npx vitest run src/components/direct/StageDots.test.tsx`

- [ ] **Step 3: Implement**

`src/components/direct/StageDots.tsx`:

```tsx
import { isTransientHalt, stageStatusWord } from "../../lib/runStatus";

export interface DotStage {
  status: string;
  checkpoint?: boolean;
  error?: string | null;
  /** Optional per-dot tooltip subject (role name). */
  title?: string;
}

const DOT: Record<string, string> = {
  done: "bg-octo-verdigris",
  running: "bg-octo-brass",
  awaiting_checkpoint: "bg-octo-brass",
  failed: "bg-octo-rouge",
  pending: "bg-octo-hairline",
};

/** The universal micro-track — one 5px dot per stage, the same status colour
 *  family everywhere a run is miniaturised (Companion, Mission Control cards,
 *  launcher tickets, history rows). Replaces the retired roman micro-track.
 *  Spec §4.1. */
export function StageDots({ stages, className = "" }: { stages: DotStage[]; className?: string }) {
  return (
    <span className={`flex items-center gap-1 ${className}`}>
      {stages.map((s, i) => {
        const stalled = s.status === "failed" && isTransientHalt(s.error ?? null);
        const word = stalled ? "stalled" : stageStatusWord(s.status);
        const color = stalled ? "bg-octo-warning" : (DOT[s.status] ?? DOT.pending);
        return (
          <span
            key={i}
            data-dot
            title={s.title ? `${s.title} — ${word}` : word}
            className={`h-[5px] w-[5px] shrink-0 rounded-full ${color} ${
              s.checkpoint ? "ring-1 ring-[var(--brass-dim)]" : ""
            }`}
          />
        );
      })}
    </span>
  );
}
```

- [ ] **Step 4: Run the test — PASS expected**

- [ ] **Step 5: Commit**

```bash
git add src/components/direct/StageDots.tsx src/components/direct/StageDots.test.tsx
git commit -m "feat(direct): StageDots universal micro-track"
```

---

### Task 4: `beacon.ts` — Law 2 as a pure selector

**Files:**
- Create: `src/lib/beacon.ts`
- Test: `src/lib/beacon.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/beacon.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { beaconAnchor } from "./beacon";

const running = { status: "running" } as any;

describe("beaconAnchor — exactly one brass beacon", () => {
  it("a pending decision outranks the running stage", () => {
    expect(
      beaconAnchor({ run: running, blockedStage: { id: "g" } as any, runningStage: { id: "s" } as any, launcherReady: true }),
    ).toEqual({ kind: "decision" });
  });

  it("a draft run's launch CTA is the decision", () => {
    expect(
      beaconAnchor({ run: { status: "draft" } as any, blockedStage: null, runningStage: null, launcherReady: false }),
    ).toEqual({ kind: "decision" });
  });

  it("with no decision pending, the running stage carries the beacon", () => {
    expect(
      beaconAnchor({ run: running, blockedStage: null, runningStage: { id: "s2" } as any, launcherReady: false }),
    ).toEqual({ kind: "stage", stageId: "s2" });
  });

  it("a terminal run is calm even with a failed stage row", () => {
    expect(
      beaconAnchor({ run: { status: "failed" } as any, blockedStage: { id: "x" } as any, runningStage: null, launcherReady: false }),
    ).toBeNull();
  });

  it("no run: the launcher CTA pulses only when ready", () => {
    expect(beaconAnchor({ run: null, blockedStage: null, runningStage: null, launcherReady: true })).toEqual({ kind: "launcher" });
    expect(beaconAnchor({ run: null, blockedStage: null, runningStage: null, launcherReady: false })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — FAIL expected**

Run: `npx vitest run src/lib/beacon.test.ts`

- [ ] **Step 3: Implement**

`src/lib/beacon.ts`:

```ts
// Law 2 of the Direct beauty redesign: at any moment there is exactly ONE
// brass-accented live element per attention scope — the answer to "where do
// I look?". This pure selector owns the priority; components only ask
// whether they are the anchor. Spec §2.
//
// Priority: pending decision (checkpoint / halt / draft launch) → running
// stage card → ready launcher CTA → calm (null).

export type BeaconAnchor =
  | { kind: "decision" }
  | { kind: "stage"; stageId: string }
  | { kind: "launcher" }
  | null;

const TERMINAL: ReadonlySet<string> = new Set(["completed", "aborted", "failed"]);

export function beaconAnchor(opts: {
  run: { status: string } | null;
  blockedStage: { id: string } | null;
  runningStage: { id: string } | null;
  launcherReady: boolean;
}): BeaconAnchor {
  const { run, blockedStage, runningStage, launcherReady } = opts;
  if (run && !TERMINAL.has(run.status) && (blockedStage || run.status === "draft")) {
    return { kind: "decision" };
  }
  if (run && !TERMINAL.has(run.status) && runningStage) {
    return { kind: "stage", stageId: runningStage.id };
  }
  if (!run && launcherReady) return { kind: "launcher" };
  return null;
}
```

- [ ] **Step 4: Run the test — PASS expected**

- [ ] **Step 5: Commit**

```bash
git add src/lib/beacon.ts src/lib/beacon.test.ts
git commit -m "feat(direct): beaconAnchor selector — the single brass beacon (Law 2)"
```

---

### Task 5: RunLedger — the completion sweep goes solid

**Files:**
- Modify: `src/components/RunLedger.tsx:96`

- [ ] **Step 1: Replace the gradient sweep**

Line 96 currently:

```tsx
          <div className="octo-sweep mb-2 h-px bg-gradient-to-r from-octo-brass to-transparent" />
```

Replace with:

```tsx
          <div className="octo-sweep mb-2 h-px bg-octo-brass" />
```

- [ ] **Step 2: Verify + commit**

Run: `npm run typecheck` — PASS. Then:

```bash
git add src/components/RunLedger.tsx
git commit -m "style(direct): solid completion sweep — gradient lines retired"
```

---

### Task 6: RunFlow — drawn connectors, essence/subject cards, the beacon

**Files:**
- Rewrite: `src/components/RunFlow.tsx`
- Test: `src/components/RunFlow.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

`src/components/RunFlow.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render } from "@testing-library/react";

vi.mock("../stores/runsStore", () => ({
  useRunsStore: (sel: any) => sel({ liveByStage: {} }),
}));
vi.mock("../stores/rolesStore", () => ({
  useRolesStore: { getState: () => ({ roles: [] }) },
}));
vi.mock("../hooks/useElapsed", () => ({ useElapsed: () => "00:00" }));
vi.mock("./RunFlowNav", () => ({ RunFlowNav: () => null }));

const { RunFlow } = await import("./RunFlow");

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

const mk = (over: Record<string, unknown>) =>
  ({
    id: "x", runId: "r", position: 0, role: "implement", agentModel: "sonnet",
    substrate: "api", checkpoint: false, status: "pending", inputTokens: 0,
    outputTokens: 0, costUsd: 0, artifact: null, feedback: null, error: null,
    startedAt: null, finishedAt: null, loopTargetPosition: null,
    loopMaxIterations: 0, loopMode: null, loopIterations: 0, maxIterations: 25,
    diffSnapshot: null, ...over,
  }) as any;

const stages = [
  mk({ id: "a", position: 0, status: "done", costUsd: 0.01 }),
  mk({ id: "b", position: 1, status: "running", startedAt: 1 }),
  mk({ id: "c", position: 2, status: "pending", checkpoint: true }),
];

describe("RunFlow — depth of field & the single beacon", () => {
  it("pulses exactly one element: the beacon stage", () => {
    const { container } = render(
      <RunFlow stages={stages} selectedStageId="b" beaconStageId="b" onSelectStage={() => {}} />,
    );
    expect(container.querySelectorAll(".octo-stage-pulse")).toHaveLength(1);
  });

  it("never pulses without a beacon, even while running", () => {
    const { container } = render(
      <RunFlow stages={stages} selectedStageId="b" beaconStageId={null} onSelectStage={() => {}} />,
    );
    expect(container.querySelectorAll(".octo-stage-pulse")).toHaveLength(0);
  });

  it("recedes non-subject cards to a dimmed essence", () => {
    const { container } = render(
      <RunFlow stages={stages} selectedStageId="b" beaconStageId="b" onSelectStage={() => {}} />,
    );
    // done + pending recede; the running subject keeps full ink
    expect(container.querySelectorAll(".opacity-\\[0\\.38\\]")).toHaveLength(2);
  });

  it("draws connectors as lines — no arrows, no romans", () => {
    const { container } = render(
      <RunFlow stages={stages} selectedStageId={null} beaconStageId={null} onSelectStage={() => {}} />,
    );
    expect(container.textContent).not.toContain("⟶");
    expect(container.textContent).not.toMatch(/\b(II|III|IV|V|VI)\b/);
    // the gate mark lives on the gated card, not the connector
    expect(container.textContent).toContain("⟜");
  });
});
```

- [ ] **Step 2: Run it — FAIL expected** (`beaconStageId` prop doesn't exist yet; arrows present)

Run: `npx vitest run src/components/RunFlow.test.tsx`

- [ ] **Step 3: Replace `src/components/RunFlow.tsx` with this full file**

```tsx
import { useEffect, useRef } from "react";
import type { LiveEntry, RunStage } from "../lib/ipc";
import { stageStatusGlyph, stageStatusWord, isTransientHalt } from "../lib/runStatus";
import { stageTitle, fmtTokens } from "../lib/stageMeta";
import { lastActivity, lastNotice } from "../lib/liveLine";
import { iconForRole } from "../lib/roleIcons";
import { useRunsStore } from "../stores/runsStore";
import { useElapsed } from "../hooks/useElapsed";
import { prefersReducedMotion } from "../lib/motion";
import { RunFlowNav } from "./RunFlowNav";

interface Props {
  stages: RunStage[];
  selectedStageId: string | null;
  /** Law 2 — the one stage allowed to pulse (beaconAnchor kind "stage"). */
  beaconStageId: string | null;
  onSelectStage: (id: string) => void;
}

const EMPTY_ENTRIES: LiveEntry[] = [];

/** The living pipeline as ONE horizontal scrolling rail, governed by the two
 *  redesign laws. Depth of field: the subject (running / awaiting / halted /
 *  selected) keeps full ink at full width; every other stage recedes to a
 *  dimmed essence card. The single beacon: only `beaconStageId` may pulse.
 *  Connectors are drawn solid lines — brass once work has flowed through,
 *  hairline ahead (gradients and the ⟶ glyph are retired); the ⟜ gate mark
 *  lives on the gated card itself. */
export function RunFlow({ stages, selectedStageId, beaconStageId, onSelectStage }: Props) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Focus follows the action: `selectedStageId` is already the shown-stage id
  // computed upstream (explicit selection, else the active stage).
  useEffect(() => {
    if (!selectedStageId) return;
    const el = cardRefs.current.get(selectedStageId);
    if (!el) return;
    el.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      inline: "center",
      block: "nearest",
    });
  }, [selectedStageId]);

  return (
    <div className="flex items-stretch gap-2">
      <div
        ref={railRef}
        className="octo-no-scrollbar flex min-w-0 flex-1 snap-x snap-proximity flex-nowrap items-stretch overflow-x-auto py-1 scroll-smooth"
      >
        {stages.map((s, i) => {
          const prev = stages[i - 1];
          const solid = prev && prev.status === "done";
          return (
            <div key={s.id} className="flex shrink-0 items-stretch">
              {i > 0 && (
                <span className="flex w-7 shrink-0 items-center" aria-hidden="true">
                  <span
                    className={`h-px w-full transition-colors duration-[280ms] ${
                      solid ? "bg-[var(--brass-line)]" : "bg-octo-hairline"
                    }`}
                  />
                </span>
              )}
              <div
                ref={(el) => {
                  if (el) cardRefs.current.set(s.id, el);
                  else cardRefs.current.delete(s.id);
                }}
                className="flex snap-start"
              >
                <StageCard
                  stage={s}
                  index={i}
                  stages={stages}
                  selected={s.id === selectedStageId}
                  beacon={s.id === beaconStageId}
                  onSelect={() => onSelectStage(s.id)}
                />
              </div>
            </div>
          );
        })}
      </div>
      <RunFlowNav containerRef={railRef} stageCount={stages.length} />
    </div>
  );
}

function StageCard({
  stage: s,
  index,
  stages,
  selected,
  beacon,
  onSelect,
}: {
  stage: RunStage;
  index: number;
  stages: RunStage[];
  selected: boolean;
  beacon: boolean;
  onSelect: () => void;
}) {
  const entries = useRunsStore((st) => st.liveByStage[s.id] ?? EMPTY_ENTRIES);
  const elapsed = useElapsed(s.status === "running" ? s.startedAt : null);
  const running = s.status === "running";
  const awaiting = s.status === "awaiting_checkpoint";
  const failed = s.status === "failed";
  const transientHalt = failed && isTransientHalt(s.error);

  // Depth of field (Law 1): the subject keeps full ink; everything else
  // recedes to its essence — 38% ink, rising on hover. Nothing is removed:
  // the full detail lives in the focus pane one click away.
  const subject = running || awaiting || failed || selected;

  const base = stageStatusGlyph(s.status);
  const glyph = transientHalt ? "⟳" : base.label;
  const glyphCls = transientHalt ? "text-octo-warning" : base.className;
  const word = transientHalt ? "stalled" : stageStatusWord(s.status);
  const Icon = iconForRole(s.role);
  const cliManaged = s.substrate === "cli";

  // ONE fixed-height live/meta line on the subject; content picked by status.
  const verdict = s.status === "done" ? lastNotice(entries) : "";
  const live: { node: React.ReactNode; cls: string } = running
    ? { node: lastActivity(entries), cls: "text-octo-sage" }
    : verdict
      ? { node: verdict, cls: "text-octo-verdigris" }
      : { node: <MetaTokens stage={s} />, cls: "text-octo-mute" };

  const looping = s.loopTargetPosition !== null;
  const target = looping ? stages.find((t) => t.position === s.loopTargetPosition) : undefined;

  // Status keeps its own colour family (running verdigris, needs-you brass,
  // stall amber, hard fail rouge) — but the PULSE belongs to the beacon alone.
  const skin = transientHalt
    ? "border-[var(--warning-border)] bg-octo-panel-2 hover:border-octo-warning"
    : failed
      ? "border-[var(--rouge-border)] bg-octo-panel-2 hover:border-octo-rouge"
      : running
        ? "border-octo-verdigris bg-octo-panel-2"
        : awaiting
          ? "border-octo-brass bg-octo-panel-2"
          : selected
            ? "border-[var(--brass-dim)] bg-[var(--brass-ghost)]"
            : "border-octo-hairline bg-octo-panel-2";

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{ animationDelay: `calc(${Math.min(index, 8)} * var(--stagger-step))` }}
      className={`octo-rise-in flex shrink-0 flex-col gap-2 rounded-lg border px-3.5 py-3 text-left transition-[width,opacity,border-color] duration-[280ms] ${
        subject ? "w-[210px]" : "w-[150px] opacity-[0.38] hover:opacity-70"
      } ${beacon ? "octo-stage-pulse " : ""}${skin}`}
    >
      {/* Header — gate mark · role icon · title · status glyph. */}
      <div className="flex items-center gap-2">
        {s.checkpoint && (
          <span
            className="shrink-0 font-mono text-[12px] text-octo-brass"
            title="Checkpoint — pauses for your approval"
          >
            ⟜
          </span>
        )}
        <span className={subject ? "text-octo-brass" : "text-octo-sage"}>
          <Icon size={13} strokeWidth={1.75} />
        </span>
        <span
          className={`min-w-0 flex-1 truncate font-serif text-[13px] ${subject ? "text-octo-ivory" : "text-octo-sage"}`}
          title={stageTitle(s)}
        >
          {stageTitle(s)}
        </span>
        <span key={`${s.status}-${transientHalt}`} className={`octo-pop-in font-mono text-[10px] ${glyphCls}`} title={word}>
          {glyph}
        </span>
      </div>

      {subject ? (
        <>
          {/* Status word + fixed-width timer (S1/S2). */}
          <span className="flex h-4 items-center gap-1.5 font-mono text-[10px]">
            <span className="truncate uppercase tracking-[0.25em] text-octo-mute">{word}</span>
            <span className="octo-tabular ml-auto w-[5ch] shrink-0 text-right text-octo-verdigris">
              {running ? elapsed : ""}
            </span>
          </span>

          {/* Live activity / verdict / tokens — fixed height, status-picked. */}
          <span
            key={`${s.status}-live`}
            className={`octo-fade-in block h-4 truncate font-mono text-[10px] leading-4 ${live.cls}`}
          >
            {live.node}
          </span>

          {/* Meta — discreet position · model · substrate pill. */}
          <span className="flex h-4 items-center gap-2 font-mono text-[10px] text-octo-mute">
            <span className="octo-tabular shrink-0">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate">{s.agentModel}</span>
            <span
              className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[8px] uppercase tracking-[0.18em] ${
                cliManaged
                  ? "bg-[var(--state-purple-ghost)] text-octo-state-purple"
                  : "bg-[var(--state-blue-ghost)] text-octo-state-blue"
              }`}
            >
              {s.substrate}
            </span>
          </span>

          {/* Loop badge — arabic target, no pulse (the beacon is singular). */}
          {looping && (
            <span
              className="flex h-4 items-center font-mono text-[10px] text-octo-brass"
              title={
                target
                  ? `Loops back to ${stageTitle(target)} (${s.loopIterations} of max ${s.loopMaxIterations})`
                  : `Loops back (${s.loopIterations} of max ${s.loopMaxIterations})`
              }
            >
              <span className="octo-tabular">
                ⟲ {s.loopIterations}/{s.loopMaxIterations}
              </span>
              {s.loopTargetPosition !== null && (
                <span className="ml-1">back to {s.loopTargetPosition + 1}</span>
              )}
            </span>
          )}
        </>
      ) : (
        /* Essence meta — discreet position · cost · tokens. */
        <span className="flex h-4 items-center gap-2 font-mono text-[10px] text-octo-mute">
          <span className="octo-tabular shrink-0">{index + 1}</span>
          {s.costUsd > 0 && <span className="octo-tabular text-octo-brass">${s.costUsd.toFixed(2)}</span>}
          {(s.inputTokens > 0 || s.outputTokens > 0) && (
            <span className="octo-tabular truncate" title="input / output tokens">
              ↑{fmtTokens(s.inputTokens)} ↓{fmtTokens(s.outputTokens)}
            </span>
          )}
        </span>
      )}
    </button>
  );
}

/** Token transparency for an at-rest subject card's live line. */
function MetaTokens({ stage: s }: { stage: RunStage }) {
  const hasTokens = s.inputTokens > 0 || s.outputTokens > 0;
  return (
    <span className="flex items-center gap-2">
      <span className="octo-tabular text-octo-brass">${s.costUsd.toFixed(2)}</span>
      {hasTokens && (
        <span className="octo-tabular text-octo-mute" title="input / output tokens">
          ↑{fmtTokens(s.inputTokens)} ↓{fmtTokens(s.outputTokens)}
        </span>
      )}
    </span>
  );
}
```

Notes: the old `ROMAN`/`archetypeFor`/`ARTIFACT_ICON` imports are gone (role icon comes from `roleIcons`); the connector-pulse is gone (Law 2); `MetaLine` was renamed `MetaTokens` because it no longer carries the whole meta row.

- [ ] **Step 4: Run the tests — PASS expected**

Run: `npx vitest run src/components/RunFlow.test.tsx`
Then: `npm run typecheck` — Expected: ONE error in `DirectCanvas.tsx` (missing `beaconStageId` prop). That is Task 8's job; do not fix it here if executing tasks strictly in order — Tasks 6-8 land as one type-green commit at the end of Task 8. If your executor requires every task to typecheck, fold Tasks 6-8 into one working set and commit at Task 8.

- [ ] **Step 5: Commit (with Tasks 7-8 if needed for a green typecheck)**

```bash
git add src/components/RunFlow.tsx src/components/RunFlow.test.tsx
git commit -m "feat(direct): RunFlow under depth-of-field + single-beacon laws"
```

---

### Task 7: RunControlBar — running controls leave the foot; the beacon lands on primary CTAs

**Files:**
- Modify: `src/components/RunControlBar.tsx`

- [ ] **Step 1: Slim the imports (line 2)**

```tsx
import { Ban, RotateCcw, ChevronRight } from "lucide-react";
```

(`Pause` and `CircleStop` move to DirectCanvas in Task 8.)

- [ ] **Step 2: Add the beacon prop**

In `interface Props` (after `loopState`, line 23) add:

```tsx
  /** True when the beaconAnchor is this bar's primary CTA (Law 2). */
  beacon?: boolean;
```

- [ ] **Step 3: Re-route the dispatch (lines 78-94)**

Replace the `RunControlBar` function body with:

```tsx
export function RunControlBar(props: Props) {
  const { run, blockedStage } = props;

  if (TERMINAL.has(run.status)) {
    return <TerminalBar run={run} onRunAgain={props.onRunAgain} />;
  }
  if (run.status === "draft") {
    return <DraftBar onStart={props.onStart} onDiscard={props.onAbort} beacon={props.beacon ?? false} />;
  }
  if (blockedStage) {
    return <DecisionBar {...props} blockedStage={blockedStage} />;
  }
  // While the run simply runs, the bar yields: pause / stop / abort live in
  // the run header (DirectCanvas) and the beacon is on the running card.
  return null;
}
```

- [ ] **Step 4: Delete the whole `RunningBar` function (lines 121-136).**

- [ ] **Step 5: DraftBar carries the beacon on its launch CTA**

Replace the `DraftBar` signature and its Begin button:

```tsx
function DraftBar({ onStart, onDiscard, beacon }: { onStart: () => void; onDiscard: () => void; beacon: boolean }) {
```

and on the "Begin this run" button change the className's first segment to:

```tsx
        className={`${beacon ? "octo-stage-pulse " : ""}flex items-center gap-1.5 rounded-md border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-3 py-1.5 font-serif text-[13px] text-octo-brass transition-colors duration-[180ms] hover:text-octo-brass-hi`}
```

- [ ] **Step 6: DecisionBar primary CTAs carry the beacon**

`DecisionBar` receives `beacon` via `{...props}`; destructure it (add `beacon = false` to the destructured props at line 157). Then add the pulse class to exactly the three primary CTAs (one per state — never more than one renders at a time):

1. Checkpoint "Approve & continue" (line 331):
```tsx
                <button type="button" onClick={onApprove}
                  className={`${beacon ? "octo-stage-pulse " : ""}rounded-md bg-octo-brass px-3 py-1.5 font-serif text-sm text-octo-onyx transition-colors duration-[180ms] hover:bg-octo-brass-hi`}>
                  Approve &amp; continue
                </button>
```
2. Transient "Resume the stage" (line 321): prepend `${beacon ? "octo-stage-pulse " : ""}` to its className the same way.
3. Failed-stage banner primary `Resume · N turns` / `Re-run · N turns` (line 232): prepend the same.

The failed-state "Accept & continue" (line 326) stays un-pulsed — in that state the banner's Resume/Re-run at line 232 is the primary.

- [ ] **Step 7: Verify**

`npm run typecheck` — expected: only the known `DirectCanvas.tsx` prop error remains until Task 8.

---

### Task 8: DirectCanvas — beacon wiring + run controls in the header

**Files:**
- Modify: `src/components/DirectCanvas.tsx`
- Modify: `src/components/DirectCanvas.test.tsx`

- [ ] **Step 1: Imports**

Line 2 becomes:

```tsx
import { Ban, CircleStop, Maximize2, Pause } from "lucide-react";
```

Add below the existing lib imports (after line 5):

```tsx
import { beaconAnchor } from "../lib/beacon";
import { IconButton } from "./controls/IconButton";
```

- [ ] **Step 2: Compute the anchor (inside the run branch, after `shownStage`, line 108)**

```tsx
    const runningStage = stages.find((s) => s.status === "running") ?? null;
    // Law 2 — one beacon per canvas: decision CTA → running card → calm.
    const anchor = beaconAnchor({ run, blockedStage, runningStage, launcherReady: false });
```

- [ ] **Step 3: Run controls into the header**

In the run-header `<div>` (line 139), after the brief `<button>` closes (line 158), insert:

```tsx
          {run.status === "running" && !blockedStage && (
            <span className="flex shrink-0 items-center gap-1.5">
              <IconButton label="Pause at the next stage" onClick={() => void pauseRun(run.id)}>
                <Pause size={12} strokeWidth={1.75} />
              </IconButton>
              <IconButton label="Stop the current stage" onClick={() => void stopStage(run.id)}>
                <CircleStop size={12} strokeWidth={1.75} />
              </IconButton>
              <IconButton label="Abort the run" onClick={() => void abort(run.id)} danger>
                <Ban size={12} strokeWidth={1.75} />
              </IconButton>
            </span>
          )}
```

- [ ] **Step 4: Pass the beacon down**

RunFlow call (line 162):

```tsx
          <RunFlow
            stages={stages}
            selectedStageId={shownStageId}
            beaconStageId={anchor?.kind === "stage" ? anchor.stageId : null}
            onSelectStage={(id) => selectStage(run.id, id)}
          />
```

RunControlBar call (line 173): add the prop

```tsx
            beacon={anchor?.kind === "decision"}
```

- [ ] **Step 5: Update DirectCanvas.test.tsx**

In the RunControlBar mock (line 24), delete the line:

```tsx
      {run.status === "running" && !blockedStage && <div>RUNNINGBAR</div>}
```

Replace the two assertions:
- Line 155: `expect(screen.queryByText("RUNNINGBAR")).not.toBeInTheDocument();` →
  `expect(screen.queryByTitle("Pause at the next stage")).not.toBeInTheDocument();`
- Line 164: `expect(screen.getByText("RUNNINGBAR")).toBeInTheDocument();` →
  `expect(screen.getByTitle("Pause at the next stage")).toBeInTheDocument();`

- [ ] **Step 6: Verify everything is green now**

Run: `npm run typecheck` — PASS (the Task 6/7 prop errors resolve here).
Run: `npx vitest run src/components/DirectCanvas.test.tsx src/components/RunFlow.test.tsx` — PASS.

- [ ] **Step 7: Commit Tasks 7+8 together**

```bash
git add src/components/RunControlBar.tsx src/components/DirectCanvas.tsx src/components/DirectCanvas.test.tsx
git commit -m "feat(direct): beacon wiring + run controls move to the header"
```

---

### Task 9: StageFocus — icon eyebrow header, flat journal lines, de-§ drawer

**Files:**
- Modify: `src/components/StageFocus.tsx`
- Modify: `src/components/StageFocus.test.tsx:41`

- [ ] **Step 1: Import the vocabulary (after line 7)**

```tsx
import { iconForRole, iconForTool } from "../lib/roleIcons";
```

- [ ] **Step 2: Replace the header (lines 344-405)**

The current single-row header starts `<div className="flex items-center gap-3 border-b …">` and opens with the `§ {role}` span. Replace from that opening `<div>` through its closing `</div>` (after the cost span, line 405) with a two-row block — row 1 keeps every existing control verbatim (iteration nav, gate pill, edit, re-run, tokens, cost), row 2 is the serif title:

```tsx
      <div className="flex flex-col gap-1 border-b border-octo-hairline px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          {(() => {
            const RoleIcon = iconForRole(stage.role);
            return (
              <span className="shrink-0 text-octo-brass" title={stage.role.replace(/_/g, " ")}>
                <RoleIcon size={12} strokeWidth={1.75} />
              </span>
            );
          })()}
          <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
            {stage.role.replace(/_/g, " ").toUpperCase()}
          </span>
          <span className="truncate font-mono text-[10px] text-octo-mute">{stage.agentModel}</span>
          {iterations.length > 0 && (
            <span className="flex shrink-0 items-center gap-1.5">
              <IconButton
                label="Previous attempt"
                onClick={() => setViewedAttempt(attemptN - 1)}
                disabled={attemptN <= 1}
              >
                <ChevronLeft size={12} />
              </IconButton>
              <span className="octo-tabular whitespace-nowrap font-mono text-[10px] text-octo-mute">
                attempt {attemptN} of {totalAttempts}
              </span>
              <IconButton
                label="Next attempt"
                onClick={() => setViewedAttempt(attemptN + 1 >= totalAttempts ? null : attemptN + 1)}
                disabled={attemptN >= totalAttempts}
              >
                <ChevronRight size={12} />
              </IconButton>
            </span>
          )}
          {(fieldsEditable || rerunnable) && (
            <span className="flex shrink-0 items-center gap-1.5">
              {gateTogglable && (
                <TogglePill
                  on={stage.checkpoint}
                  label="⟜ gate"
                  ariaLabel="Approval gate — pause before hand-off"
                  onChange={(v) => {
                    setDirectorError(null);
                    onUpdateStage?.({ checkpoint: v }).catch(reportDirectorError);
                  }}
                />
              )}
              <IconButton
                label={editRerunsStage ? "Edit & re-run stage" : "Edit stage"}
                onClick={openEdit}
              >
                <SlidersHorizontal size={12} />
              </IconButton>
              {rerunnable && (
                <IconButton label="Re-run from here" onClick={() => setConfirmRerun((v) => !v)}>
                  <RotateCcw size={12} />
                </IconButton>
              )}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2.5 font-mono">
            {(stage.inputTokens > 0 || stage.outputTokens > 0) && (
              <span className="octo-tabular text-[10px] text-octo-mute" title="input / output tokens">
                ↑{fmtTokens(stage.inputTokens)} ↓{fmtTokens(stage.outputTokens)}
              </span>
            )}
            <span className="octo-tabular text-xs text-octo-brass">${stage.costUsd.toFixed(2)}</span>
          </span>
        </div>
        <div className="truncate font-serif text-[15px] text-octo-ivory" title={stageTitle(stage)}>
          {stageTitle(stage)}
        </div>
      </div>
```

- [ ] **Step 3: Flatten the journal tool cards (in `buildJournalItems`, lines 66-84)**

Replace the `e.kind === "tool"` branch's `items.push(…)` (the boxed card) with a flat icon line — no nested border box (§9 minimalism: boxes don't nest):

```tsx
      const ToolIcon = iconForTool(e.tool);
      items.push(
        <div key={i} className="octo-rise-in flex items-baseline gap-2 font-mono text-[12px]">
          <span className="translate-y-[1px] shrink-0 text-octo-mute" title={e.tool}>
            <ToolIcon size={11} strokeWidth={1.75} />
          </span>
          <span className="shrink-0 text-octo-ivory">{e.tool}</span>
          {e.hint && (
            <span className="min-w-0 truncate text-octo-sage" title={e.hint}>
              {e.hint}
            </span>
          )}
          {res && (
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px]">
              <span className={res.ok ? "text-octo-verdigris" : "text-octo-rouge"}>{res.ok ? "✓" : "✕"}</span>
              <span className="max-w-[28ch] truncate text-octo-mute" title={res.detail}>
                {res.detail}
              </span>
            </span>
          )}
        </div>,
      );
```

(The `const next…/const res…/if (res) i++` lines above it stay exactly as they are. The `buildJournalItems` doc comment's "§ tool cards" phrase becomes "flat tool lines".)

- [ ] **Step 4: De-§ the JournalDrawer (line 631)**

Delete the line `<span className="text-octo-brass">§</span>` inside the drawer's toggle button. Nothing replaces it — the label "work journal · n" carries the affordance.

- [ ] **Step 5: Rename the outdated test title**

`src/components/StageFocus.test.tsx:41`: `"renders text as prose and a tool+result as one § card"` → `"renders text as prose and a tool+result as one flat line"`. Its assertions (tool name / hint / detail by text) already match the new DOM.

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npx vitest run src/components/StageFocus.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/StageFocus.tsx src/components/StageFocus.test.tsx
git commit -m "feat(direct): StageFocus icon eyebrow + flat journal lines (§ retired)"
```

---

### Task 10: FEATURES.md — the heart surfaces tell the truth again

**Files:**
- Modify: `docs/FEATURES.md` (section 4, "Live orchestration view" + "Runs lifecycle & control" areas, lines ~325-434)

- [ ] **Step 1: Update the stale descriptions**

Grep the Direct section for `Roman`, `§`, `⟶`, and `RunningBar`/`pause` wording and rewrite only the affected bullets so they describe:

- RunFlow stage cards: role lucide icon + serif title + status glyph; discreet arabic position in the mono meta line; subject cards (running/awaiting/halted/selected) at full ink and width, all others receding to a dimmed essence (38%, hover 70%); solid line connectors (brass once traversed, hairline ahead — no gradients, no ⟶ glyph); the ⟜ gate mark on the gated card; exactly one pulsing element — the beacon (decision CTA → running card).
- StageFocus header: role icon + mono uppercase eyebrow (no §) over the serif stage title; journal tool calls as flat icon lines, no boxed cards; the work-journal drawer label without the § prefix.
- Run controls: pause / stop-stage / abort are quiet icon buttons in the run header while driving; the control bar renders only when a decision exists (draft, checkpoint, halt, terminal), and its primary CTA carries the single brass beacon.
- Completion sweep: solid brass line (gradient retired).

- [ ] **Step 2: Commit**

```bash
git add docs/FEATURES.md
git commit -m "docs(features): heart-of-the-run surfaces after the beauty redesign"
```

---

### Task 11: Final verification

- [ ] **Step 1: Full frontend gate**

Run: `npm run typecheck` — PASS.
Run: `npx vitest run` — PASS (only the known ~5 PTY sandbox failures are tolerated, nothing new).

- [ ] **Step 2: Grep the diff for regressions of the retired language**

```bash
git diff main --unified=0 -- src/components/RunFlow.tsx src/components/StageFocus.tsx src/components/RunControlBar.tsx src/components/DirectCanvas.tsx src/components/RunLedger.tsx | grep "^+" | grep -nE "ROMAN|§|⟶|gradient|#[0-9a-fA-F]{3,8}" && echo "VIOLATIONS FOUND" || echo "clean"
```

Expected: `clean`.

- [ ] **Step 3: Manual visual pass (`npm run tauri:dev`)**

Drive a Direct run and check: (a) exactly one pulsing element at any time — running card, then the Approve CTA at a checkpoint, amber Resume on a transient halt; (b) essence cards dim/rise on hover and widen smoothly when they become the subject; (c) connectors fill solid brass as stages complete; (d) header pause/stop/abort work while driving and disappear at a decision; (e) completion sweep is a solid line; (f) with `prefers-reduced-motion`, no pulse and no entrance motion. Fix anything off before declaring done (superpowers:verification-before-completion).

- [ ] **Step 4: Rebase + hand off**

```bash
git fetch origin && git rebase origin/main
```

Then follow superpowers:finishing-a-development-branch (PR; do NOT release — user norm: no release without an explicit ask).

---

## Follow-up plans (authored when reached)

- **Plan 2 — The launcher:** PipelineSetup de-wizarded (serif brief card, ticket optics, ledger-grammar foot, beacon on "Begin the run" via `beaconAnchor(launcherReady)`), StageFlow icons + solid connectors, PipelineTicket StageDots; delete `.animate-brass-grow` + `@keyframes brassgrow` and `BrassRule` usage inside Direct.
- **Plan 3 — The builder:** StageNode as the essence card, palette icons, inspector eyebrow, solid/dashed edges, quiet validation line, MiniMap maskColor → `tokens.onyx`.
- **Plan 4 — Fleet + retirement sweep:** CompanionRuns/CompanionCurrentRun/RunsTray/MissionControl/HistorySheet on StageDots + fleet beacon; app-wide sweep of `§` (ToolCallCard, chat/LiveToolCard, WelcomeScreen, CommandPalette, WorkspaceRail, App, RecentlyClosedDrawer, RenameDialog, SlashMenu, EditorBinaryPane, Reveal, NewProjectFlow), Roman numerals (MissionControl micro-track, stageMeta.ROMAN removal, graph.ts display uses), and gradient lines (BrassRule.tsx deleted, ChatMessage:147, CompanionReview:65, markdownComponents hr, ToolCallCard:422 fade mask reviewed); design-system.md §3/§5/§6 + CLAUDE.md signature block + FEATURES.md final pass.
