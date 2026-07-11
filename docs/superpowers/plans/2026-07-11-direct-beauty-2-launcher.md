# Direct Beauty Redesign — Plan 2 of 4: The Launcher ("The Commission")

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-wizard the Direct launcher: serif brief card with linked-issue chip + ⌘⏎, depth-of-field ensemble tickets on StageDots, the crew as a quiet line with a Reveal editor, a run-grammar ledger foot, and the beacon landing on "Begin the run" only when ready.

**Architecture:** Presentation-layer only, built on Plan 1's foundations (`beaconAnchor` launcherReady arm, `StageDots`, `roleIcons`, tokens). Spec §6 of `docs/superpowers/specs/2026-07-11-direct-beauty-redesign-design.md`. Branch stacks on Plan 1 (`worktree-direct-beauty-1`, PR #129).

**Tech Stack:** React 19 + TS, Tailwind v4 tokens, Zustand, Vitest + @testing-library/react, lucide-react.

**Worktree/branch:** work in `/Users/jonathan/TYPEFY/octopus/octopus-sh/.claude/worktrees/direct-beauty-1`; Task 0 creates `worktree-direct-beauty-2` off the Plan-1 HEAD. PR base: `direct-beauty-1` (or `main` if #129 merged first).

**Binding norms:** no italics · no romans · no `§` · no gradient lines · no `⟶` ornament (structural `⟜` gate mark stays) · tokens never literals · icons always carry `title` · motion via primitives.

**NOT in this plan:** deleting `.animate-brass-grow`/`BrassRule` from CSS — `BrassRule` is still consumed by NewProjectFlow/WelcomeScreen/WorkspaceCreator/ChatCanvas; the app-wide sweep is Plan 4. This plan only removes the launcher's own gradient-rule usage.

---

## File structure

| File | Role |
|---|---|
| `src/components/direct/StageDots.tsx` | + `tone: "status" \| "shape"` prop (modify) |
| `src/components/direct/StageDots.test.tsx` | + shape-tone test (modify) |
| `src/components/direct/PipelineTicket.tsx` | shape line → StageDots; Edit text → pencil icon (modify) |
| `src/components/direct/StageFlow.tsx` | REWRITE — quiet crew line + Reveal crew editor |
| `src/components/direct/StageFlow.test.tsx` | REWRITE |
| `src/components/PipelineSetup.tsx` | REWRITE — de-wizarded Commission |
| `src/components/PipelineSetup.test.tsx` | targeted assertion updates + 2 new tests |
| `src/components/DirectCanvas.tsx` | pass `linkedIssueKey` + `launcherBeacon` gating (modify, 1 hunk) |
| `src/components/DirectRunsMeter.tsx` | DELETE (folds into the ledger line) |
| `docs/FEATURES.md` | launcher bullets |

---

### Task 0: Branch

- [ ] `git checkout -b worktree-direct-beauty-2` (from the Plan-1 HEAD in the worktree). Verify `npm run typecheck` green before starting.

---

### Task 1: StageDots gains the `shape` tone

**Files:** Modify `src/components/direct/StageDots.tsx`, `src/components/direct/StageDots.test.tsx`

- [ ] **Step 1: Failing test** — append to the describe block in `StageDots.test.tsx`:

```tsx
  it("shape tone renders neutral sage dots regardless of status, keeping gate rings", () => {
    const { container } = render(
      <StageDots
        tone="shape"
        stages={[{ status: "pending" }, { status: "pending", checkpoint: true }]}
      />,
    );
    const dots = container.querySelectorAll("span[data-dot]");
    expect(dots[0].className).toContain("bg-octo-sage");
    expect(dots[1].className).toContain("bg-octo-sage");
    expect(dots[1].className).toContain("ring-1");
    expect(dots[1].getAttribute("title")).toBe("Pauses for your approval");
  });
```

Run `npx vitest run src/components/direct/StageDots.test.tsx` → FAIL (unknown prop / wrong classes).

- [ ] **Step 2: Implement** — in `StageDots.tsx`, change the signature and the color/title lines:

```tsx
export function StageDots({
  stages,
  className = "",
  tone = "status",
}: {
  stages: DotStage[];
  className?: string;
  /** "status" colours by run state; "shape" is the launcher-ticket neutral —
   *  every dot sage, only the gate ring carries meaning. */
  tone?: "status" | "shape";
}) {
```

and inside the map:

```tsx
        const color =
          tone === "shape" ? "bg-octo-sage" : stalled ? "bg-octo-warning" : (DOT[s.status] ?? DOT.pending);
        const title =
          tone === "shape"
            ? s.checkpoint
              ? "Pauses for your approval"
              : undefined
            : s.title
              ? `${s.title} — ${word}`
              : word;
```

and use `title={title}` on the dot span (the `word` computation stays for the status tone).

- [ ] **Step 3: Test → PASS. Step 4: Commit**

```bash
git add src/components/direct/StageDots.tsx src/components/direct/StageDots.test.tsx
git commit -m "feat(direct): StageDots shape tone for launcher tickets"
```

---

### Task 2: PipelineTicket — StageDots shape line + pencil edit

**Files:** Modify `src/components/direct/PipelineTicket.tsx` (its test needs no change — verify)

- [ ] **Step 1: Imports** — add:

```tsx
import { Pencil } from "lucide-react";
import { StageDots } from "./StageDots";
```

- [ ] **Step 2: Replace the bespoke shape line** (the whole `{/* Shape line: … */}` `<div className="flex items-center gap-1 font-mono text-[10px] text-octo-mute">…</div>` block) with:

```tsx
        {/* Shape line — the universal micro-track in its neutral tone; the dot
            run clips while the stage count always stays legible. */}
        <div className="flex items-center gap-1 font-mono text-[10px] text-octo-mute">
          <StageDots
            tone="shape"
            stages={stages.map((s) => ({ status: "pending", checkpoint: s.checkpoint }))}
            className="min-w-0 flex-1 overflow-hidden"
          />
          <span className="ml-1 shrink-0 whitespace-nowrap">{stages.length} {stages.length === 1 ? "stage" : "stages"}</span>
        </div>
```

- [ ] **Step 3: Pencil edit affordance** — replace the absolute "Edit" text button's CONTENT and classes (keep `aria-label={\`Edit ${name}\`}` and `title="Edit pipeline"` exactly — the test queries by that name):

```tsx
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${name}`}
        title="Edit pipeline"
        className="absolute right-2 top-2 flex items-center justify-center rounded p-1 text-octo-mute opacity-0 transition-opacity duration-[180ms] hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass group-hover:opacity-100"
      >
        <Pencil size={11} strokeWidth={1.75} />
      </button>
```

- [ ] **Step 4: Verify** — `npx vitest run src/components/direct/PipelineTicket.test.tsx` → 3/3 PASS (unchanged file). `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/direct/PipelineTicket.tsx
git commit -m "feat(direct): ticket shape line on StageDots + pencil edit (⟶ retired)"
```

---

### Task 3: StageFlow — the quiet crew line + Reveal editor

**Files:** Rewrite `src/components/direct/StageFlow.tsx` and `src/components/direct/StageFlow.test.tsx`

- [ ] **Step 1: Replace `StageFlow.test.tsx` with:**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../ModelPicker", () => ({
  ModelPicker: ({ activeModel, onSelectModel }: { activeModel: string; onSelectModel: (m: string) => void }) => (
    <button onClick={() => onSelectModel("new-model")}>model:{activeModel}</button>
  ),
}));

const { StageFlow } = await import("./StageFlow");

const stages = [
  {
    id: "s0", pipelineId: "p", position: 0, role: "plan", agentModel: "m0", substrate: "api",
    checkpoint: false, loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, maxIterations: 25,
    posX: null, posY: null, parents: [], tools: null, customName: null, instructions: null,
  },
  {
    id: "s1", pipelineId: "p", position: 1, role: "code_review", agentModel: "m1", substrate: "cli",
    checkpoint: true, loopTargetPosition: 0, loopMaxIterations: 2, loopMode: "gated", maxIterations: 25,
    posX: null, posY: null, parents: [0], tools: null, customName: null, instructions: null,
  },
] as any;

describe("StageFlow — quiet crew line", () => {
  it("renders one line: role names, the ⟜ gate mark, the loop badge — no romans, no arrows", () => {
    render(<StageFlow stages={stages} overrides={{}} onOverride={vi.fn()} />);
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText("Code review")).toBeInTheDocument();
    expect(screen.getByText("⟜")).toBeInTheDocument();          // gate mark on the gated stage
    expect(screen.getByText("⟲ ×2")).toBeInTheDocument();       // loop badge
    expect(screen.queryByText("⟶")).not.toBeInTheDocument();
    expect(screen.queryByText("I")).not.toBeInTheDocument();
    expect(screen.queryByText("II")).not.toBeInTheDocument();
    // the crew editor is folded — no model chips at rest
    expect(screen.queryByText(/^model:/)).not.toBeInTheDocument();
  });

  it("shows the overridden model in mute on the line", () => {
    render(<StageFlow stages={stages} overrides={{ 0: "override-0" }} onOverride={vi.fn()} />);
    expect(screen.getByText("· override-0")).toBeInTheDocument();
  });

  it("unfolds the crew editor from the pencil and wires overrides", () => {
    const onOverride = vi.fn();
    render(<StageFlow stages={stages} overrides={{ 0: "override-0" }} onOverride={onOverride} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit the crew" }));
    expect(screen.getByText("model:override-0")).toBeInTheDocument(); // stage 0 uses the override
    expect(screen.getByText("model:m1")).toBeInTheDocument();         // stage 1 keeps its default
    fireEvent.click(screen.getByText("model:m1"));
    expect(onOverride).toHaveBeenCalledWith(1, "new-model");
    expect(screen.getByText("⟜ gate")).toBeInTheDocument();           // gate badge inside the editor card
  });
});
```

Run → FAIL (old component).

- [ ] **Step 2: Replace `StageFlow.tsx` entirely with:**

```tsx
import { useState } from "react";
import { Pencil } from "lucide-react";
import type { PipelineStage } from "../../lib/ipc";
import { TOOLS } from "../builder/graph";
import { iconForRole } from "../../lib/roleIcons";
import { stageTitle } from "../../lib/stageMeta";
import { ModelPicker } from "../ModelPicker";
import { Reveal } from "../primitives/Reveal";
import { IconButton } from "../controls/IconButton";

interface Props {
  stages: PipelineStage[];
  /** position → overridden model id (the crew override map). */
  overrides: Record<number, string>;
  onOverride: (position: number, model: string) => void;
}

/** The selected ensemble's crew at two altitudes. At rest: ONE quiet line —
 *  role icon + name (+ the overridden model in mute), hairline connectors, the
 *  ⟜ gate mark on the stage that pauses for approval, ⟲ ×N on a looping
 *  review. The pencil unfolds the crew editor (Reveal): wrapping stage cards
 *  whose ModelPicker overrides that stage in place. Progressive disclosure
 *  over a standing table (§9); nothing lost, one click away. */
export function StageFlow({ stages, overrides, onOverride }: Props) {
  const sorted = [...stages].sort((a, b) => a.position - b.position);
  const [editing, setEditing] = useState(false);

  return (
    <div>
      <div className="flex items-center gap-2 rounded-lg border border-octo-hairline bg-octo-panel-2 px-3.5 py-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-y-2">
          {sorted.map((s, i) => {
            const Icon = iconForRole(s.role);
            const override = overrides[s.position];
            const looping = s.loopTargetPosition !== null;
            return (
              <span key={s.id} className="flex items-center">
                {i > 0 && <span className="mx-2 h-px w-[22px] shrink-0 bg-octo-hairline" aria-hidden="true" />}
                {s.checkpoint && (
                  <span className="mr-1 font-mono text-[12px] text-octo-brass" title="Pauses for your approval">
                    ⟜
                  </span>
                )}
                <span className="text-octo-sage" title={s.role.replace(/_/g, " ")}>
                  <Icon size={11} strokeWidth={1.75} />
                </span>
                <span className="ml-1.5 text-[12px] text-octo-sage" title={stageTitle(s)}>
                  {stageTitle(s)}
                </span>
                {override && (
                  <span className="ml-1.5 font-mono text-[10px] text-octo-mute" title="Model override for this run">
                    · {override}
                  </span>
                )}
                {looping && (
                  <span
                    className="ml-1.5 font-mono text-[10px] text-octo-brass"
                    title={`Loops back up to ×${s.loopMaxIterations}`}
                  >
                    ⟲ ×{s.loopMaxIterations}
                  </span>
                )}
              </span>
            );
          })}
        </div>
        <IconButton label={editing ? "Close the crew editor" : "Edit the crew"} onClick={() => setEditing((v) => !v)}>
          <Pencil size={12} strokeWidth={1.75} />
        </IconButton>
      </div>

      <Reveal open={editing}>
        <div className="flex flex-wrap gap-3 pt-3">
          {sorted.map((s, i) => (
            <CrewCard
              key={s.id}
              stage={s}
              index={i}
              model={overrides[s.position] ?? s.agentModel}
              onModel={(m) => onOverride(s.position, m)}
            />
          ))}
        </div>
      </Reveal>
    </div>
  );
}

function CrewCard({
  stage,
  index,
  model,
  onModel,
}: {
  stage: PipelineStage;
  index: number;
  model: string;
  onModel: (m: string) => void;
}) {
  const Icon = iconForRole(stage.role);
  const cliManaged = stage.substrate === "cli";
  // `!stage.tools` covers both null (archetype default = all) and a legacy row
  // that never carried the column.
  const granted = (toolId: string) => cliManaged || !stage.tools || stage.tools.includes(toolId);
  const looping = stage.loopTargetPosition !== null;

  return (
    <div
      className="octo-rise-in flex w-[210px] shrink-0 flex-col gap-2.5 rounded-lg border border-octo-hairline bg-octo-panel-2 px-3.5 py-3"
      style={{ animationDelay: `calc(${Math.min(index, 8)} * var(--stagger-step))` }}
    >
      <div className="flex items-center gap-2">
        <span className="text-octo-sage" title={stage.role.replace(/_/g, " ")}>
          <Icon size={14} strokeWidth={1.75} />
        </span>
        <span className="min-w-0 flex-1 truncate font-serif text-[14px] text-octo-ivory" title={stageTitle(stage)}>
          {stageTitle(stage)}
        </span>
        <span className="font-mono text-[10px] text-octo-mute">{index + 1}</span>
      </div>

      {/* Model chip — clicking it tunes the crew right on the pipeline. */}
      <ModelPicker
        activeModel={model}
        onSelectModel={onModel}
        allowedProviders={cliManaged ? ["anthropic"] : undefined}
      />

      <div className="flex items-center gap-2">
        <span
          className={`rounded-sm px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] ${
            cliManaged
              ? "bg-[var(--state-purple-ghost)] text-octo-state-purple"
              : "bg-[var(--state-blue-ghost)] text-octo-state-blue"
          }`}
        >
          {stage.substrate}
        </span>
        <span
          className="flex items-center gap-1"
          title={cliManaged ? "Managed by the CLI agent" : `Tools: ${TOOLS.filter((t) => granted(t.id)).map((t) => t.label).join(" · ") || "none"}`}
        >
          {TOOLS.map((t) => (
            <span
              key={t.id}
              className={`h-1.5 w-1.5 rounded-full ${granted(t.id) ? "bg-octo-sage" : "border border-octo-hairline"}`}
            />
          ))}
        </span>
        <span className="ml-auto flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.18em]">
          {stage.checkpoint && (
            <span className="text-octo-brass" title="Pauses for your approval">⟜ gate</span>
          )}
          {looping && (
            <span className="text-octo-brass" title={`Loops back up to ×${stage.loopMaxIterations}`}>
              ⟲ ×{stage.loopMaxIterations}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 3:** `npx vitest run src/components/direct/StageFlow.test.tsx` → 3/3 PASS. Typecheck may flag `PipelineSetup.test.tsx`'s old numeral assertions only at Task 4 — component typecheck itself must be clean.

- [ ] **Step 4: Commit**

```bash
git add src/components/direct/StageFlow.tsx src/components/direct/StageFlow.test.tsx
git commit -m "feat(direct): crew line + Reveal editor replace the StageFlow card wall"
```

---

### Task 4: PipelineSetup — the de-wizarded Commission

**Files:** Rewrite `src/components/PipelineSetup.tsx`; modify `src/components/PipelineSetup.test.tsx`; DELETE `src/components/DirectRunsMeter.tsx`

- [ ] **Step 1: Confirm DirectRunsMeter has exactly one consumer**

Run: `grep -rn "DirectRunsMeter" src --include="*.tsx" | grep -v "DirectRunsMeter.tsx"`
Expected: only the `PipelineSetup.tsx` import + usage. If anything else appears, STOP and report.

- [ ] **Step 2: Replace `src/components/PipelineSetup.tsx` entirely with:**

```tsx
import { useEffect, useRef, useState } from "react";
import { ipc, type PipelineWithStages } from "../lib/ipc";
import { usePipelineStore } from "../stores/pipelineStore";
import { useRunsStore } from "../stores/runsStore";
import { savingsVsBaseline } from "../lib/runStatus";
import { beaconAnchor } from "../lib/beacon";
import { useEntitlement } from "../hooks/useEntitlement";
import { PipelineTicket } from "./direct/PipelineTicket";
import { StageFlow } from "./direct/StageFlow";

interface Props {
  defaultTask: string;
  linkedIssueKey?: string | null;
  onBegin: (
    pipelineId: string,
    task: string,
    stageOverrides: [number, string][],
    budgetUsd: number | null,
  ) => void;
  executingRun: boolean;
  onEditPipeline: (pipelineId: string | null) => void;
}

/** A budget is a positive finite dollar amount; anything else means "no budget". */
function parseBudget(text: string): number | null {
  const v = Number.parseFloat(text);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Tint for the runs-left fragment: sage while comfortable, amber past 80% of
 *  a cap, rouge at the cap. Uncapped stays mute. (Folded in from the retired
 *  DirectRunsMeter — the count now lives inside the ledger line.) */
function runsTone(used: number, limit: number | null): string {
  if (limit == null || limit <= 0) return "text-octo-mute";
  const ratio = used / limit;
  if (ratio >= 1) return "text-octo-rouge";
  if (ratio >= 0.8) return "text-octo-warning";
  return "text-octo-sage";
}

/**
 * The Direct launcher — "The Commission". One composition surface, not a
 * wizard (the roman step framing is retired): the brief composed in serif on
 * panel, the ensemble tickets under depth-of-field optics, the crew as a
 * quiet line, and a run-grammar ledger foot. The single brass beacon (Law 2)
 * lands on "Begin the run" only when brief + ensemble + quota + concurrency
 * are all satisfied; until then the CTA is a ghost.
 */
export function PipelineSetup({ defaultTask, linkedIssueKey = null, onBegin, executingRun, onEditPipeline }: Props) {
  const pipelines = usePipelineStore((s) => s.pipelines);
  const loaded = usePipelineStore((s) => s.loaded);
  const load = usePipelineStore((s) => s.load);
  const error = usePipelineStore((s) => s.error);
  const { usage } = useEntitlement();

  const [task, setTask] = useState(defaultTask);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<number, string>>({});
  const [budgetText, setBudgetText] = useState("");
  const [estimate, setEstimate] = useState<{ estimateUsd: number; baselineUsd: number } | null>(null);

  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);
  useEffect(() => {
    const exists = selectedId && pipelines.some((p) => p.pipeline.id === selectedId);
    if (!exists && pipelines.length > 0) {
      setSelectedId(pipelines[0].pipeline.id);
      // The selection is being REPLACED (first load, or the selected pipeline
      // was deleted externally) — position-keyed overrides must not carry
      // onto a different pipeline's stages.
      setOverrides({});
    }
  }, [pipelines, selectedId]);
  // "Run it again" (R3): consume the one-shot launcher prefill once the pipeline
  // list is in, so the existence check is meaningful. The task always applies;
  // pipeline + crew only when that pipeline still exists.
  const consumeLauncherPrefill = useRunsStore((s) => s.consumeLauncherPrefill);
  useEffect(() => {
    if (!loaded) return;
    const prefill = consumeLauncherPrefill();
    if (!prefill) return;
    setTask(prefill.task);
    if (pipelines.some((p) => p.pipeline.id === prefill.pipelineId)) {
      setSelectedId(prefill.pipelineId);
      setOverrides(Object.fromEntries(prefill.overrides));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- consume exactly once, when loaded
  }, [loaded]);
  useEffect(() => {
    if (!selectedId) return;
    const tuples: [number, string][] = Object.entries(overrides)
      .map(([pos, model]) => [Number(pos), model] as [number, string]);
    let cancelled = false;
    ipc.estimateRunCost(selectedId, tuples.length > 0 ? tuples : undefined)
      .then((e) => { if (!cancelled) setEstimate(e); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedId, overrides]);

  const selected: PipelineWithStages | undefined = pipelines.find((p) => p.pipeline.id === selectedId);

  // Model overrides are keyed by stage POSITION. If the selected pipeline is
  // restructured under us — e.g. octopush-mcp's `update_pipeline` while the
  // window was unfocused, surfaced by the focus refresh — a kept override
  // would silently retarget onto whatever stage now sits at that position.
  // Reset overrides when the SAME selection's stage structure changes; a
  // selection change keeps its own existing semantics (incl. prefill).
  const stageSig = selected
    ? selected.stages.map((s) => `${s.position}:${s.role}`).join("|")
    : null;
  const prevSig = useRef<{ id: string | null; sig: string | null }>({ id: null, sig: null });
  useEffect(() => {
    const prev = prevSig.current;
    if (prev.id === selectedId && prev.sig !== null && stageSig !== null && prev.sig !== stageSig) {
      setOverrides({});
    }
    prevSig.current = { id: selectedId, sig: stageSig };
  }, [selectedId, stageSig]);
  const { saved, pct: savedPct } = estimate
    ? savingsVsBaseline(estimate.estimateUsd, estimate.baselineUsd)
    : { saved: 0, pct: 0 };

  const overrideTuples = (): [number, string][] =>
    selected
      ? selected.stages
          .filter((s) => overrides[s.position] && overrides[s.position] !== s.agentModel)
          .map((s) => [s.position, overrides[s.position]] as [number, string])
      : [];

  // Law 2 — the launcher is ready when brief + ensemble + concurrency + quota
  // all hold; only then does the beacon land on the CTA.
  const quotaExhausted = !!usage && usage.limit != null && usage.used >= usage.limit;
  const ready = !!selected && task.trim().length > 0 && !executingRun && !quotaExhausted;
  const beacon =
    beaconAnchor({ run: null, blockedStage: null, runningStage: null, launcherReady: ready })?.kind === "launcher";

  const beginNow = () => {
    if (!ready || !selected) return;
    onBegin(selected.pipeline.id, task.trim(), overrideTuples(), parseBudget(budgetText));
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto px-8 py-7 octo-fade-in">
      <div className="mx-auto max-w-[940px]">
        {/* Ceremony — serif title + one sans line. No eyebrow, no rule. */}
        <h1 className="m-0 font-serif text-[22px] tracking-[-0.005em] text-octo-ivory">Direct the work</h1>
        <p className="mb-7 mt-1 text-[12px] text-octo-sage">A crew of agents, your brief, one run.</p>

        {/* The brief — the noblest object: serif on panel. ⌘⏎ begins. */}
        <div className="mb-8 rounded-lg border border-octo-hairline bg-octo-panel px-4 py-3 transition-colors duration-[180ms] focus-within:border-[var(--brass-dim)]">
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                beginNow();
              }
            }}
            placeholder="What should the ensemble take on?"
            aria-label="The brief"
            className="h-20 w-full resize-none bg-transparent font-serif text-[15px] leading-[1.5] text-octo-ivory outline-none placeholder:font-serif placeholder:text-octo-mute"
          />
          <div className="mt-2 flex h-5 items-center gap-2">
            {linkedIssueKey && (
              <span
                className="rounded-[5px] border border-octo-hairline px-1.5 py-px font-mono text-[9px] text-octo-mute"
                title="Linked issue — attached to this run"
              >
                {linkedIssueKey}
              </span>
            )}
            <span className="ml-auto font-mono text-[9px] text-octo-mute">⌘⏎ to begin</span>
          </div>
        </div>

        {/* The ensemble. */}
        <p className="mb-3 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">ensemble</p>
        {!loaded ? (
          <div className="mb-10 flex gap-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="octo-fade-in h-24 w-[184px] shrink-0 rounded-md border border-octo-hairline bg-octo-panel-2" />
            ))}
          </div>
        ) : pipelines.length === 0 ? (
          error ? (
            <div className="mb-10 rounded-lg border border-octo-hairline bg-octo-panel-2 px-4 py-5 text-center">
              <p className="mb-3 font-mono text-xs text-octo-rouge">Couldn't load pipelines: {error}</p>
              <button type="button" onClick={() => void load()}
                className="rounded-md border border-octo-brass px-3 py-1.5 font-mono text-xs text-octo-brass">
                Retry
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => onEditPipeline(null)}
              className="mb-10 block w-full rounded-lg border border-octo-hairline bg-octo-panel-2 px-4 py-7 text-center font-serif text-sm text-octo-brass transition-colors duration-[180ms] hover:border-[var(--brass-dim)]">
              No ensembles yet — compose your first
            </button>
          )
        ) : (
          <div className="mb-6">
            {/* Selector rail — depth of field: the chosen ticket at full ink,
                the rest receding (the tickets own their selected styling; the
                rail dims the unselected ones). */}
            <div className="flex gap-2 overflow-x-auto pb-2">
              {pipelines.map((p) => (
                <div
                  key={p.pipeline.id}
                  className={
                    p.pipeline.id === selectedId
                      ? undefined
                      : "opacity-[0.38] transition-opacity duration-[180ms] focus-within:opacity-70 hover:opacity-70"
                  }
                >
                  <PipelineTicket
                    pipeline={p}
                    selected={p.pipeline.id === selectedId}
                    onSelect={() => { setSelectedId(p.pipeline.id); setOverrides({}); }}
                    onEdit={() => onEditPipeline(p.pipeline.id)}
                  />
                </div>
              ))}
              {/* Compose ticket — the way into the builder. */}
              <button
                type="button"
                onClick={() => onEditPipeline(null)}
                className="flex w-[184px] shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-octo-hairline px-3.5 py-3 font-serif text-[13px] text-octo-brass opacity-[0.38] transition-opacity duration-[180ms] hover:opacity-100 focus-visible:opacity-100"
              >
                <span className="font-mono text-base">＋</span>
                Compose a new one
              </button>
            </div>

            {selected && (
              <div className="mt-5">
                {selected.pipeline.description && (
                  <p className="mb-3 font-serif text-[13px] text-octo-sage">{selected.pipeline.description}</p>
                )}
                <StageFlow
                  stages={selected.stages}
                  overrides={overrides}
                  onOverride={(position, model) => setOverrides((prev) => ({ ...prev, [position]: model }))}
                />
              </div>
            )}
          </div>
        )}

        {/* The foot — the same ledger grammar as the run's strip. */}
        {selected && (
          <>
            <div className="my-6 h-px bg-octo-hairline" />
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div className="flex h-5 min-w-0 items-center gap-2 font-mono text-[11px]">
                {estimate ? (
                  <>
                    <span className="octo-tabular text-octo-verdigris">est. saves ~${saved.toFixed(2)}</span>
                    <span className="octo-tabular text-octo-mute">· {savedPct}% under all-premium</span>
                    <span className="octo-tabular text-octo-mute">
                      · runs at <span className="text-octo-brass">~${estimate.estimateUsd.toFixed(2)}</span>
                    </span>
                  </>
                ) : (
                  <span className="text-octo-mute">estimating…</span>
                )}
                {usage && (
                  <span className={`octo-tabular ${runsTone(usage.used, usage.limit)}`} title="Direct runs this month">
                    · {usage.limit != null
                      ? `${Math.max(0, usage.limit - usage.used)} runs left`
                      : `${usage.used} run${usage.used === 1 ? "" : "s"} this month`}
                  </span>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <label htmlFor="run-budget" className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">
                  budget
                </label>
                <div className="flex h-8 items-center gap-1 rounded-md border border-octo-hairline bg-octo-onyx px-2 transition-colors duration-[180ms] focus-within:border-[var(--brass-dim)]">
                  <span className="font-mono text-xs text-octo-mute">$</span>
                  <input
                    id="run-budget"
                    type="text"
                    inputMode="decimal"
                    value={budgetText}
                    onChange={(e) => setBudgetText(e.target.value)}
                    placeholder="no budget"
                    className="octo-tabular w-20 bg-transparent font-mono text-xs text-octo-ivory outline-none placeholder:font-serif placeholder:text-octo-mute"
                  />
                </div>
              </div>

              <div className="ml-auto flex flex-col items-end gap-1.5">
                <button
                  type="button"
                  disabled={!ready}
                  onClick={beginNow}
                  className={`rounded-lg border px-6 py-2.5 font-serif text-base transition-colors duration-[180ms] ${
                    beacon
                      ? "octo-stage-pulse border-octo-brass bg-octo-brass text-octo-onyx hover:bg-octo-brass-hi"
                      : "border-octo-hairline bg-transparent text-octo-sage opacity-60"
                  }`}
                >
                  Begin the run
                </button>
                <p className="m-0 h-4 font-mono text-[10px] text-octo-mute">
                  {executingRun
                    ? "A run is in progress — finish or abort it before starting another."
                    : quotaExhausted
                      ? "Monthly Direct runs are used up."
                      : ""}
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Delete the meter**

```bash
git rm src/components/DirectRunsMeter.tsx
```

- [ ] **Step 4: Update `src/components/PipelineSetup.test.tsx`** (targeted edits — the file's mocks and most tests stay):

Add next to the other mocks (the real hook reaches Tauri IPC):

```tsx
const entitlementState = vi.hoisted(() => ({ usage: { used: 4, limit: 25 } as { used: number; limit: number | null } | null }));
vi.mock("../hooks/useEntitlement", () => ({
  useEntitlement: () => ({ usage: entitlementState.usage }),
}));
```

(a) Ceremony test — replace the `— direct` assertion:

```tsx
    expect(screen.getByRole("heading", { name: "Direct the work" })).toBeInTheDocument();
    expect(screen.getByText("A crew of agents, your brief, one run.")).toBeInTheDocument();
```

(b) Replace the whole `"draws the selected pipeline as a stage flow (Roman numerals + connector)"` test with:

```tsx
  it("draws the crew as a quiet line — no numerals, no arrows", () => {
    render(<PipelineSetup defaultTask="" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />);
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText("Implement")).toBeInTheDocument();
    expect(screen.queryByText("⟶")).not.toBeInTheDocument();
    expect(screen.queryByText("I")).not.toBeInTheDocument();
    expect(screen.queryByText("II")).not.toBeInTheDocument();
  });
```

(c) `"leads the estimate with savings"` — the query strings still match (`est. saves ~$0.35` contains `saves ~$0.35`; `runs at` unchanged); only the class assertion target is now a mono span — keep `expect(saves.className).toContain("text-octo-verdigris");` as-is. Verify it passes; do not rewrite unless it fails.

(d) Append two new tests at the end of the `"PipelineSetup designed states"` describe:

```tsx
  it("the beacon lands on Begin only when ready (Law 2)", () => {
    const { container, rerender } = render(
      <PipelineSetup defaultTask="build it" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />,
    );
    expect(container.querySelectorAll(".octo-stage-pulse")).toHaveLength(1); // the CTA
    rerender(<PipelineSetup defaultTask="build it" onBegin={vi.fn()} executingRun onEditPipeline={vi.fn()} />);
    expect(container.querySelectorAll(".octo-stage-pulse")).toHaveLength(0); // executing → ghost, calm
  });

  it("⌘⏎ in the brief begins the run when ready — and only then", () => {
    const onBegin = vi.fn();
    render(<PipelineSetup defaultTask="build it" onBegin={onBegin} executingRun={false} onEditPipeline={vi.fn()} />);
    fireEvent.keyDown(screen.getByLabelText("The brief"), { key: "Enter", metaKey: true });
    expect(onBegin).toHaveBeenCalledWith("p1", "build it", [], null);
    onBegin.mockClear();
    fireEvent.change(screen.getByLabelText("The brief"), { target: { value: "   " } });
    fireEvent.keyDown(screen.getByLabelText("The brief"), { key: "Enter", metaKey: true });
    expect(onBegin).not.toHaveBeenCalled(); // blank brief → not ready
  });
```

- [ ] **Step 5: Run** `npx vitest run src/components/PipelineSetup.test.tsx` → all pass (14 tests: the original 12 with two rewritten, plus the two new ones). `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add -A src/components/PipelineSetup.tsx src/components/PipelineSetup.test.tsx src/components/DirectRunsMeter.tsx
git commit -m "feat(direct): the Commission de-wizarded — serif brief, ticket optics, ledger foot, launcher beacon"
```

---

### Task 5: DirectCanvas passes the linked issue

**Files:** Modify `src/components/DirectCanvas.tsx` (one hunk)

- [ ] **Step 1:** In the launcher branch, the `<PipelineSetup` call gains one prop:

```tsx
      <PipelineSetup
        defaultTask={defaultTask}
        linkedIssueKey={linkedIssueKey}
```

(the rest of the call is unchanged).

- [ ] **Step 2:** `npm run typecheck` → clean. `npx vitest run src/components/DirectCanvas.test.tsx` → all pass (mocked PipelineSetup, unaffected).

- [ ] **Step 3: Commit**

```bash
git add src/components/DirectCanvas.tsx
git commit -m "feat(direct): brief card shows the linked issue chip"
```

---

### Task 6: FEATURES.md — launcher truth

**Files:** Modify `docs/FEATURES.md` (section 4 launcher bullets)

- [ ] **Step 1:** Grep section 4 for the launcher entries (`The Commission`, `PipelineSetup`, `StageFlow`, `PipelineTicket`, `DirectRunsMeter`, `I · The brief`, brass rule wording) and rewrite only the stale bullets to describe: the de-wizarded single surface (no roman steps, no brass rule, serif title + sans subtitle); the serif brief card on panel with linked-issue chip and the new ⌘⏎-to-begin shortcut; ticket rail depth-of-field optics with `StageDots` shape lines and pencil edit; the crew as a quiet line (role icons, hairline connectors, ⟜ on gated stages, ⟲ ×N) with the Reveal crew editor (ModelPicker per stage, unchanged capability); the run-grammar ledger foot (`est. saves ~$X · N% under all-premium · runs at ~$Y · runs-left fragment` — DirectRunsMeter retired, its quota tinting folded into the fragment); and the ghost→beacon "Begin the run" CTA (Law 2 `launcherReady`). Leave builder/fleet entries alone.

- [ ] **Step 2: Commit**

```bash
git add docs/FEATURES.md
git commit -m "docs(features): the Commission after the beauty redesign"
```

---

### Task 7: Final verification + PR

- [ ] `npm run typecheck` → PASS. `npx vitest run` → full suite green (same 33 pre-existing harness errors only).
- [ ] Retired-language grep over `git diff <task-0-base>..HEAD` added lines: no `ROMAN`, no `§`, no `⟶`, no `gradient`, no hex literals, no `DirectRunsMeter` references left anywhere (`grep -rn "DirectRunsMeter" src docs` → only FEATURES.md history notes if any).
- [ ] Manual visual pass (`npm run tauri:dev`): launcher empty → ghost CTA, no pulse; type a brief → beacon lands on Begin; tickets dim/rise; crew line unfolds the editor smoothly; ⌘⏎ begins; linked-issue chip when the workspace has one; reduced-motion → static halo on the CTA. Flag anything off.
- [ ] Push and PR: `git push -u origin worktree-direct-beauty-2:direct-beauty-2`, then `gh pr create --base direct-beauty-1` (or `--base main` if PR #129 already merged), body summarizing the above + the owed visual pass. NO release.
