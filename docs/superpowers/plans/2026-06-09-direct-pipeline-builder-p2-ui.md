# Pipeline Builder — Plan P2 (builder UI + wiring) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The user-visible builder: a full-canvas `PipelineBuilder` (stage cards with role/model/substrate/checkpoint + the §3.7 loop controls, ↑/↓ reorder, add/remove, fork-aware Save), entered from the launcher ("Edit" per card + `⟶ Compose a new pipeline`), persisted through P1's `save_pipeline`/`delete_pipeline`.

**Architecture:** `pipelineStore` gains `save`/`remove` (re-`load` after writes). `DirectCanvas` gets a local `builder` state (third canvas state: launcher → builder → run view). `PipelineBuilder` edits a local draft whose loop targets are tracked **by stage identity** (local keys), normalized on every mutation (reorder/remove/role-change clears invalid loops with a notice), and serialized to positions on save — the backend re-validates. Builtins fork via the backend; the UI only adjusts the label ("Save as my copy ⟶") and pre-fills "{name} (custom)".

**Tech Stack:** React 19 + TypeScript + Zustand + Tailwind (Atelier tokens). Vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-06-09-direct-pipeline-builder-design.md` §3. Builds on P1 (same branch). **Design rules:** NO italics; English; tokens only (no hex); `⟶` brass; roman numerals; serif-phrase CTAs upright.

---

## File map
- **Modify** `src/stores/pipelineStore.ts` (+ test `src/stores/pipelineStore.test.ts`) — `save`/`remove`.
- **Modify** `src/components/RunTrack.tsx` — export the existing `ROMAN` const (reuse, don't duplicate).
- **Create** `src/components/PipelineBuilder.tsx` (+ test `src/components/PipelineBuilder.test.tsx`) — the editor.
- **Modify** `src/components/PipelineSetup.tsx` — Edit affordance + Compose CTA (`onEditPipeline` prop).
- **Modify** `src/components/DirectCanvas.tsx` (+ extend `src/components/DirectCanvas.test.tsx`) — `builder` state + precedence.

---

### Task 1: `pipelineStore.save` / `remove`

**Files:** Modify `src/stores/pipelineStore.ts`; modify `src/stores/pipelineStore.test.ts`.

- [ ] **Step 1 — Write the failing tests.** Read `src/stores/pipelineStore.test.ts` first and extend it following its existing mock pattern (it mocks `../lib/ipc`). Add:
```ts
  it("save calls savePipeline and reloads the list", async () => {
    (ipc.savePipeline as any) = vi.fn().mockResolvedValue("new-id");
    (ipc.listPipelines as any).mockResolvedValue([]);
    const draft = { pipelineId: null, name: "Mine", description: "d", stages: [] as any[] };
    const id = await usePipelineStore.getState().save(draft as any);
    expect(id).toBe("new-id");
    expect(ipc.savePipeline).toHaveBeenCalledWith(draft);
    expect(ipc.listPipelines).toHaveBeenCalled(); // reloaded
  });

  it("remove calls deletePipeline and reloads the list", async () => {
    (ipc.deletePipeline as any) = vi.fn().mockResolvedValue(undefined);
    (ipc.listPipelines as any).mockResolvedValue([]);
    await usePipelineStore.getState().remove("p1");
    expect(ipc.deletePipeline).toHaveBeenCalledWith("p1");
    expect(ipc.listPipelines).toHaveBeenCalled();
  });
```
  (If the existing mock object doesn't include `savePipeline`/`deletePipeline`, add them as `vi.fn()` to the `vi.mock("../lib/ipc", …)` factory.)
- [ ] **Step 2 — Run, confirm FAIL:** `npx vitest run src/stores/pipelineStore 2>&1 | tail -15` (from worktree root).
- [ ] **Step 3 — Implement.** In `src/stores/pipelineStore.ts`:
```ts
import { create } from "zustand";
import { ipc, type PipelineDraft, type PipelineWithStages } from "../lib/ipc";

interface PipelineState {
  pipelines: PipelineWithStages[];
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  /** Create / fork / update via save_pipeline; reloads the list. Returns the saved id. */
  save: (draft: PipelineDraft) => Promise<string>;
  /** Delete a custom pipeline; reloads the list. */
  remove: (pipelineId: string) => Promise<void>;
}

export const usePipelineStore = create<PipelineState>((set, get) => ({
  pipelines: [],
  loaded: false,
  error: null,
  load: async () => {
    try {
      const pipelines = await ipc.listPipelines();
      set({ pipelines, loaded: true, error: null });
    } catch (e) {
      set({ loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },
  save: async (draft) => {
    const id = await ipc.savePipeline(draft);
    await get().load();
    return id;
  },
  remove: async (pipelineId) => {
    await ipc.deletePipeline(pipelineId);
    await get().load();
  },
}));
```
- [ ] **Step 4 — Run, confirm PASS:** `npx vitest run src/stores/pipelineStore 2>&1 | tail -8`; `npm run typecheck` clean.
- [ ] **Step 5 — Commit:**
```bash
git add src/stores/pipelineStore.ts src/stores/pipelineStore.test.ts
git commit -m "feat(direct/builder-p2): pipelineStore.save/remove"
```

---

### Task 2: `PipelineBuilder` component

**Files:** Modify `src/components/RunTrack.tsx` (export `ROMAN`); create `src/components/PipelineBuilder.tsx`, `src/components/PipelineBuilder.test.tsx`.

- [ ] **Step 1 — Export `ROMAN`.** In `RunTrack.tsx` change `const ROMAN = […]` to `export const ROMAN = […]` (no other change).
- [ ] **Step 2 — Write the failing tests** (`src/components/PipelineBuilder.test.tsx`):
```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("./ModelPicker", () => ({
  ModelPicker: ({ activeModel }: any) => <div data-testid="model">{activeModel}</div>,
}));
const saveMock = vi.fn().mockResolvedValue("saved-id");
const removeMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../stores/pipelineStore", () => ({
  usePipelineStore: (sel: any) => sel({ save: saveMock, remove: removeMock }),
}));

const { PipelineBuilder } = await import("./PipelineBuilder");

const stage = (over: Record<string, unknown>) => ({
  id: "s", pipelineId: "p1", position: 0, role: "plan", agentModel: "claude-haiku-4-5",
  substrate: "api", checkpoint: false,
  loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, ...over,
});
const builtin = {
  pipeline: { id: "p1", name: "Feature Factory", description: "d", isBuiltin: true, createdAt: "t" },
  stages: [
    stage({ id: "s0", position: 0, role: "implement" }),
    stage({ id: "s1", position: 1, role: "code_review", loopTargetPosition: 0, loopMaxIterations: 2, loopMode: "gated" }),
  ],
} as any;
const custom = {
  pipeline: { id: "p2", name: "Mine", description: "d", isBuiltin: false, createdAt: "t" },
  stages: [stage({ id: "s0", position: 0, role: "plan" })],
} as any;

describe("PipelineBuilder", () => {
  beforeEach(() => { saveMock.mockClear(); removeMock.mockClear(); });

  it("a builtin opens with the fork label and a pre-filled copy name", () => {
    render(<PipelineBuilder pipeline={builtin} onClose={vi.fn()} />);
    expect(screen.getByDisplayValue("Feature Factory (custom)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save as my copy/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete$/ })).not.toBeInTheDocument(); // no delete on builtins
  });

  it("a custom opens with its own name, Save label, and Delete", () => {
    render(<PipelineBuilder pipeline={custom} onClose={vi.fn()} />);
    expect(screen.getByDisplayValue("Mine")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save pipeline/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Delete$/ })).toBeInTheDocument();
  });

  it("compose-new starts with one default stage and Save label", () => {
    render(<PipelineBuilder pipeline={null} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Save pipeline/ })).toBeInTheDocument();
    expect(screen.getAllByTestId("model").length).toBe(1); // one default stage
  });

  it("moving the loop target below its review clears the loop with a notice", () => {
    render(<PipelineBuilder pipeline={builtin} onClose={vi.fn()} />);
    // implement (0) ↓ → becomes index 1, after the review → loop must clear
    fireEvent.click(screen.getAllByRole("button", { name: "↓" })[0]);
    expect(screen.getByText(/Loop target removed/)).toBeInTheDocument();
  });

  it("save serializes loop targets to positions and calls store.save", async () => {
    render(<PipelineBuilder pipeline={builtin} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Save as my copy/ }));
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalled());
    const draft = saveMock.mock.calls[0][0];
    expect(draft.pipelineId).toBe("p1"); // backend decides the fork
    expect(draft.name).toBe("Feature Factory (custom)");
    expect(draft.stages[1].loopTargetPosition).toBe(0);
    expect(draft.stages[1].loopMode).toBe("gated");
  });

  it("add stage appends a card", () => {
    render(<PipelineBuilder pipeline={custom} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Add a stage/ }));
    expect(screen.getAllByTestId("model").length).toBe(2);
  });
});
```
- [ ] **Step 3 — Run, confirm FAIL:** `npx vitest run src/components/PipelineBuilder 2>&1 | tail -15`.
- [ ] **Step 4 — Implement `src/components/PipelineBuilder.tsx`:**
```tsx
import { useMemo, useState } from "react";
import type { PipelineWithStages, StageDraft } from "../lib/ipc";
import { usePipelineStore } from "../stores/pipelineStore";
import { ModelPicker } from "./ModelPicker";
import { labelForRole, ROMAN } from "./RunTrack";

const ALL_ROLES = [
  "plan", "plan_review", "implement", "code_review", "test",
  "repro", "fix", "verify", "critique", "refine",
];
const REVIEW_ROLES = new Set(["plan_review", "code_review", "critique", "verify"]);
const DEFAULT_STAGE = { role: "implement", agentModel: "claude-sonnet-4-6", substrate: "api" as const, checkpoint: false };

/** Builder-local stage: loop target tracked by stage IDENTITY (key), not position. */
interface DraftStage {
  key: string;
  role: string;
  agentModel: string;
  substrate: "api" | "cli";
  checkpoint: boolean;
  loopTargetKey: string | null;
  loopMaxIterations: number;
  loopMode: "gated" | "auto" | null;
  loopCleared: boolean; // show the one-line notice after a normalize cleared the loop
}

function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

function draftsFrom(pipeline: PipelineWithStages | null): DraftStage[] {
  if (!pipeline) {
    return [{ key: newKey(), ...DEFAULT_STAGE, loopTargetKey: null, loopMaxIterations: 0, loopMode: null, loopCleared: false }];
  }
  const sorted = [...pipeline.stages].sort((a, b) => a.position - b.position);
  const keys = sorted.map(() => newKey());
  return sorted.map((s, i) => ({
    key: keys[i],
    role: s.role,
    agentModel: s.agentModel,
    substrate: s.substrate as "api" | "cli",
    checkpoint: s.checkpoint,
    loopTargetKey:
      s.loopTargetPosition !== null
        ? keys[sorted.findIndex((t) => t.position === s.loopTargetPosition)] ?? null
        : null,
    loopMaxIterations: s.loopMaxIterations,
    loopMode: s.loopMode,
    loopCleared: false,
  }));
}

/** Clear loops whose target no longer exists, isn't strictly earlier, or whose
 *  stage is no longer a review role. Marks cleared stages for the notice. */
function normalizeLoops(stages: DraftStage[]): DraftStage[] {
  return stages.map((s, i) => {
    if (!s.loopTargetKey) return s;
    const targetIdx = stages.findIndex((t) => t.key === s.loopTargetKey);
    const valid = REVIEW_ROLES.has(s.role) && targetIdx !== -1 && targetIdx < i;
    return valid
      ? s
      : { ...s, loopTargetKey: null, loopMaxIterations: 0, loopMode: null, loopCleared: true };
  });
}

function toStageDrafts(stages: DraftStage[]): StageDraft[] {
  return stages.map((s) => {
    const targetIdx = s.loopTargetKey ? stages.findIndex((t) => t.key === s.loopTargetKey) : -1;
    const hasLoop = targetIdx !== -1;
    return {
      role: s.role,
      agentModel: s.agentModel,
      substrate: s.substrate,
      checkpoint: s.checkpoint,
      loopTargetPosition: hasLoop ? targetIdx : null,
      loopMaxIterations: hasLoop ? s.loopMaxIterations : 0,
      loopMode: hasLoop ? s.loopMode : null,
    };
  });
}

interface Props {
  /** null = compose a new pipeline; a loaded pipeline = edit (builtins fork on save). */
  pipeline: PipelineWithStages | null;
  onClose: () => void;
}

export function PipelineBuilder({ pipeline, onClose }: Props) {
  const isBuiltin = pipeline?.pipeline.isBuiltin ?? false;
  const save = usePipelineStore((s) => s.save);
  const remove = usePipelineStore((s) => s.remove);

  const [name, setName] = useState(() =>
    pipeline ? (isBuiltin ? `${pipeline.pipeline.name} (custom)` : pipeline.pipeline.name) : "",
  );
  const [description, setDescription] = useState(pipeline?.pipeline.description ?? "");
  const [stages, setStages] = useState<DraftStage[]>(() => draftsFrom(pipeline));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const mutate = (fn: (prev: DraftStage[]) => DraftStage[]) =>
    setStages((prev) => normalizeLoops(fn(prev)));

  const patch = (key: string, p: Partial<DraftStage>) =>
    mutate((prev) => prev.map((s) => (s.key === key ? { ...s, ...p, ...(p.loopTargetKey !== undefined || p.role ? {} : {}), loopCleared: false, ...p } : s)));

  const move = (idx: number, delta: -1 | 1) =>
    mutate((prev) => {
      const next = [...prev];
      const j = idx + delta;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });

  const removeStage = (key: string) => mutate((prev) => prev.filter((s) => s.key !== key));
  const addStage = () =>
    mutate((prev) => [
      ...prev,
      { key: newKey(), ...DEFAULT_STAGE, loopTargetKey: null, loopMaxIterations: 0, loopMode: null, loopCleared: false },
    ]);

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await save({
        pipelineId: pipeline?.pipeline.id ?? null, // the backend forks builtins
        name: name.trim(),
        description: description.trim(),
        stages: toStageDrafts(stages),
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  const onDelete = async () => {
    if (!pipeline) return;
    try {
      await remove(pipeline.pipeline.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex-1 overflow-auto px-5 py-5 octo-fade-in">
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.14em] text-octo-brass">I · Name the pipeline</p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="What is this pipeline called?"
        className="mb-2 w-full rounded-lg border border-octo-hairline bg-octo-panel-2 px-3 py-2 font-serif text-lg text-octo-ivory placeholder:text-octo-mute"
      />
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="One line on when to reach for it"
        className="mb-6 w-full rounded-lg border border-octo-hairline bg-octo-panel-2 px-3 py-2 text-sm text-octo-sage placeholder:text-octo-mute"
      />

      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.14em] text-octo-brass">II · Assemble the stages</p>
      <div className="mb-4 flex flex-col gap-2.5">
        {stages.map((s, i) => (
          <div key={s.key} className="rounded-lg border border-octo-hairline bg-octo-panel-2 px-3 py-2.5 octo-rise-in">
            <div className="flex items-center gap-3">
              <span className="w-7 shrink-0 font-mono text-[11px] text-octo-brass">{ROMAN[i] ?? i + 1}</span>
              <select
                value={s.role}
                onChange={(e) => patch(s.key, { role: e.target.value })}
                aria-label="Stage role"
                className="rounded-md border border-octo-hairline bg-octo-onyx px-2 py-1.5 font-serif text-sm text-octo-ivory"
              >
                {ALL_ROLES.map((r) => (
                  <option key={r} value={r}>{labelForRole(r)}</option>
                ))}
              </select>
              <div className="min-w-0 flex-1">
                <ModelPicker
                  activeModel={s.agentModel}
                  onSelectModel={(m) => patch(s.key, { agentModel: m })}
                  allowedProviders={s.substrate === "cli" ? ["anthropic"] : undefined}
                />
              </div>
              <button
                type="button"
                onClick={() => patch(s.key, { substrate: s.substrate === "api" ? "cli" : "api" })}
                className="rounded border border-octo-hairline px-1.5 py-0.5 font-mono text-[9px] uppercase text-octo-sage hover:border-[var(--brass-dim)]"
              >
                {s.substrate}
              </button>
              <label className="flex items-center gap-1.5 font-mono text-[9px] uppercase text-octo-mute">
                <input
                  type="checkbox"
                  checked={s.checkpoint}
                  onChange={(e) => patch(s.key, { checkpoint: e.target.checked })}
                />
                checkpoint
              </label>
              <div className="ml-auto flex items-center gap-1">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0}
                  className="rounded border border-octo-hairline px-1.5 py-0.5 font-mono text-xs text-octo-sage disabled:opacity-30">↑</button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === stages.length - 1}
                  className="rounded border border-octo-hairline px-1.5 py-0.5 font-mono text-xs text-octo-sage disabled:opacity-30">↓</button>
                <button type="button" onClick={() => removeStage(s.key)} disabled={stages.length === 1}
                  aria-label="Remove stage"
                  className="rounded border border-octo-hairline px-1.5 py-0.5 font-mono text-xs text-octo-mute hover:text-octo-rouge disabled:opacity-30">✕</button>
              </div>
            </div>

            {REVIEW_ROLES.has(s.role) && (
              <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-octo-hairline pt-2 font-mono text-[11px] text-octo-sage">
                <span className="text-octo-brass">⟜ loop</span>
                <label className="flex items-center gap-1.5">
                  Return to
                  <select
                    value={s.loopTargetKey ?? ""}
                    onChange={(e) =>
                      patch(s.key, e.target.value
                        ? { loopTargetKey: e.target.value, loopMaxIterations: s.loopMaxIterations || 2, loopMode: s.loopMode ?? "gated" }
                        : { loopTargetKey: null, loopMaxIterations: 0, loopMode: null })
                    }
                    className="rounded border border-octo-hairline bg-octo-onyx px-1.5 py-1 text-octo-ivory"
                  >
                    <option value="">— linear —</option>
                    {stages.slice(0, i).map((t, ti) => (
                      <option key={t.key} value={t.key}>{ROMAN[ti] ?? ti + 1} · {labelForRole(t.role)}</option>
                    ))}
                  </select>
                </label>
                {s.loopTargetKey && (
                  <>
                    <label className="flex items-center gap-1.5">
                      Max loop-backs
                      <input
                        type="number" min={1} value={s.loopMaxIterations}
                        onChange={(e) => patch(s.key, { loopMaxIterations: Math.max(1, Number(e.target.value) || 1) })}
                        className="w-14 rounded border border-octo-hairline bg-octo-onyx px-1.5 py-1 text-octo-ivory"
                      />
                    </label>
                    <label className="flex items-center gap-1.5">
                      Mode
                      <select
                        value={s.loopMode ?? "gated"}
                        onChange={(e) => patch(s.key, { loopMode: e.target.value as "gated" | "auto" })}
                        className="rounded border border-octo-hairline bg-octo-onyx px-1.5 py-1 text-octo-ivory"
                      >
                        <option value="gated">gated</option>
                        <option value="auto">auto</option>
                      </select>
                    </label>
                    {s.loopMode === "auto" && (
                      <span className="text-octo-mute">Auto relies on a parseable verdict; it gates to you otherwise.</span>
                    )}
                  </>
                )}
                {s.loopCleared && (
                  <span className="text-octo-mute">Loop target removed — review is linear again.</span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={addStage}
        className="mb-6 rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-xs text-octo-sage hover:border-[var(--brass-dim)]"
      >
        + Add a stage
      </button>

      {error && <p className="mb-3 font-mono text-xs text-octo-rouge">{error}</p>}

      <div className="flex items-center gap-2 border-t border-octo-hairline pt-4">
        <button
          type="button"
          disabled={saving || !name.trim()}
          onClick={() => void onSave()}
          className="rounded-lg bg-octo-brass px-5 py-2.5 font-serif text-base text-octo-onyx disabled:opacity-40"
        >
          {isBuiltin ? "Save as my copy ⟶" : "Save pipeline ⟶"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-octo-hairline px-3 py-2 font-mono text-xs text-octo-mute"
        >
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
              className="ml-auto rounded-md border border-octo-hairline px-3 py-2 font-mono text-xs text-octo-mute hover:text-octo-rouge">
              Delete
            </button>
          )
        )}
      </div>
    </div>
  );
}
```
  **Implementation note on `patch`:** the one-liner above is tangled — implement it plainly instead:
```tsx
  const patch = (key: string, p: Partial<DraftStage>) =>
    mutate((prev) => prev.map((s) => (s.key === key ? { ...s, loopCleared: false, ...p } : s)));
```
  (resetting `loopCleared` before applying the patch so the notice clears on the next user edit; `normalizeLoops` re-sets it if still invalid).
- [ ] **Step 5 — Run, confirm PASS:** `npx vitest run src/components/PipelineBuilder 2>&1 | tail -10`; `npm run typecheck`.
- [ ] **Step 6 — Commit:**
```bash
git add src/components/PipelineBuilder.tsx src/components/PipelineBuilder.test.tsx src/components/RunTrack.tsx
git commit -m "feat(direct/builder-p2): PipelineBuilder — stage cards, loop controls by identity, fork-aware save"
```

---

### Task 3: Wiring — launcher entry points + canvas state

**Files:** Modify `src/components/PipelineSetup.tsx`, `src/components/DirectCanvas.tsx`; extend `src/components/DirectCanvas.test.tsx`.

- [ ] **Step 1 — Write the failing test** (extend `src/components/DirectCanvas.test.tsx`; it already mocks PipelineSetup/RunTrack/etc.). Update the `PipelineSetup` mock so it can trigger the builder, and add a `PipelineBuilder` mock:
```tsx
vi.mock("./PipelineSetup", () => ({
  PipelineSetup: ({ onEditPipeline }: any) => (
    <div>
      LAUNCHER
      <button onClick={() => onEditPipeline(null)}>compose</button>
    </div>
  ),
}));
vi.mock("./PipelineBuilder", () => ({ PipelineBuilder: () => <div>BUILDER</div> }));
```
  And the test:
```tsx
  it("opens the builder from the launcher and closes back", () => {
    useRunsStore.getState().selectRun("w1", null);
    render(<DirectCanvas active workspaceId="w1" defaultTask="" linkedIssueKey={null} workspacePath="/tmp" />);
    fireEvent.click(screen.getByText("compose"));
    expect(screen.getByText("BUILDER")).toBeInTheDocument();
    expect(screen.queryByText("LAUNCHER")).not.toBeInTheDocument();
  });
```
  (Add `fireEvent` to the testing-library import. The builder takes precedence over both launcher and run view.)
- [ ] **Step 2 — Run, confirm FAIL:** `npx vitest run src/components/DirectCanvas 2>&1 | tail -15`.
- [ ] **Step 3 — `PipelineSetup` entry points.** Add to its `Props`: `onEditPipeline: (pipelineId: string | null) => void;` (destructure it). The pipeline cards are `<button>`s — an Edit control cannot nest inside. Wrap each card in a relative container and overlay the Edit as a SIBLING:
```tsx
        <div className="mb-6 flex gap-2.5">
          {pipelines.map((p) => (
            <div key={p.pipeline.id} className="relative flex-1">
              <button
                type="button"
                onClick={() => { setSelectedId(p.pipeline.id); setOverrides({}); }}
                className={`w-full rounded-lg border p-3 text-left transition-colors ${
                  p.pipeline.id === selectedId
                    ? "border-octo-brass bg-[var(--brass-ghost)]"
                    : "border-octo-hairline bg-octo-panel-2 hover:border-[var(--brass-dim)]"
                }`}
              >
                <h3 className="mb-1 pr-10 font-serif text-[15px] text-octo-ivory">{p.pipeline.name}</h3>
                <p className="m-0 text-[11px] text-octo-sage">{p.pipeline.description}</p>
              </button>
              <button
                type="button"
                onClick={() => onEditPipeline(p.pipeline.id)}
                className="absolute right-2 top-2 rounded border border-transparent px-1.5 py-0.5 font-mono text-[9px] uppercase text-octo-mute hover:border-octo-hairline hover:text-octo-brass"
              >
                Edit
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => onEditPipeline(null)}
          className="mb-6 font-serif text-[13px] text-octo-brass hover:text-octo-ivory"
        >
          ⟶ Compose a new pipeline
        </button>
```
  (The Compose CTA sits right below the cards row, before section III. Keep the existing empty-state branch; place the CTA AFTER the `{loaded && pipelines.length === 0 ? … : …}` block so it shows in both cases.)
- [ ] **Step 4 — `DirectCanvas` builder state.** Add `useState`:
```tsx
  // Builder: undefined = closed; null = compose new; a pipelineId = edit that one.
  const [builder, setBuilder] = useState<undefined | null | string>(undefined);
  const pipelines = usePipelineStore((s) => s.pipelines);
```
  (import `useState` from react, `usePipelineStore` from `../stores/pipelineStore`, and `PipelineBuilder` from `./PipelineBuilder`). Render precedence — FIRST branch, before the launcher guard:
```tsx
  if (builder !== undefined) {
    return (
      <PipelineBuilder
        pipeline={builder ? pipelines.find((p) => p.pipeline.id === builder) ?? null : null}
        onClose={() => setBuilder(undefined)}
      />
    );
  }
```
  And pass `onEditPipeline={(id) => setBuilder(id)}` to `<PipelineSetup …>`.
- [ ] **Step 5 — Run tests + typecheck + full sweep:** `npx vitest run src/components/DirectCanvas src/components/PipelineSetup src/components/PipelineBuilder 2>&1 | tail -8`; `npm run typecheck`; `npx vitest run 2>&1 | grep -E "Test Files|Tests "`. Note: `PipelineSetup.test.tsx` renders `<PipelineSetup …>` without the new required prop → add `onEditPipeline={vi.fn()}` to its renders.
- [ ] **Step 6 — Commit:**
```bash
git add src/components/PipelineSetup.tsx src/components/PipelineSetup.test.tsx src/components/DirectCanvas.tsx src/components/DirectCanvas.test.tsx
git commit -m "feat(direct/builder-p2): launcher entry points + builder canvas state"
```

---

## Self-review (against spec §3)

- **`pipelineStore.save/remove` (reload after writes)** → Task 1. ✓
- **Builder: name/description; stage cards (role select via `labelForRole`, `ModelPicker` reused w/ cli restriction, substrate + checkpoint toggles); §3.7 loop controls only on review roles (Return-to of EARLIER stages, max ≥1, gated/auto + auto hint)** → Task 2. ✓
- **Loop targets by identity; normalize on every mutation; cleared-loop notice; serialize ids→positions on save** → Task 2 (`normalizeLoops`/`toStageDrafts`, tested via the reorder test). ✓
- **Fork UX: "Save as my copy ⟶" + "{name} (custom)" prefill; Delete only on customs (inline confirm); backend decides the fork (`pipelineId` passed as-is)** → Task 2. ✓
- **Entry points: Edit per card (sibling overlay, valid HTML) + `⟶ Compose a new pipeline`; canvas precedence builder → launcher/run** → Task 3. ✓
- **Save errors shown in rouge; min 1 stage (✕ disabled at one)** → Task 2. ✓
- **Design rules:** tokens, no hex, no italics, English, `⟶`/`⟜` brass, roman numerals (exported `ROMAN`), `octo-fade-in`/`octo-rise-in` motion. ✓

**Type consistency:** `PipelineDraft`/`StageDraft` from `ipc.ts` (P1). `PipelineBuilder` Props `{ pipeline: PipelineWithStages | null, onClose }`. `pipelineStore.save(draft) -> Promise<string>` / `remove(id)`. `PipelineSetup` Props += `onEditPipeline: (id: string | null) => void`. `DirectCanvas` `builder: undefined | null | string`. `ROMAN` + `labelForRole` exported from `RunTrack`.

**Known tradeoffs (per spec):** unsaved draft discarded on mode switch (local state); no drag-and-drop (↑/↓).
