# Live Orchestration View — Plan V2 (frontend: focus-pane work journal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Render the structured live activity (the `run://log` `entry` payloads V1 emits) as a **work journal** in the focus pane — the model's narration as prose and each tool call as a `§ TOOL · hint` card with its result — so a running stage is no longer a "working…" black box. This is the **visible payoff** of the live-orchestration view.

**Architecture:** `ipc.ts` gains a `LiveEntry` discriminated union matching the Rust payload. `runsStore` replaces its string-line buffer (`liveLogByStage: string[]`) with a structured one (`liveByStage: LiveEntry[]`) and the `run://log` listener pushes `entry` objects. `StageFocus` groups each `tool` with its following `tool_result` into one card and renders the journal (text/notice as prose, tools as `§` cards) while a stage runs; done stages keep the settled artifact+diff view.

**Tech Stack:** React 19 + TypeScript + Zustand + Tailwind (Atelier tokens). Vitest.

**Spec:** `docs/superpowers/specs/2026-06-09-direct-live-orchestration-view-design.md` (§2 event model, §4.1–4.2). Builds on V1 (same branch / PR). V3 (track liveness) is a separate plan on the same branch.

**Design rules (from CLAUDE.md):** NO italics; English copy; design tokens only (no hex); reuse motion classes; the `§` glyph in brass.

---

## File map
- **Modify** `src/lib/ipc.ts` — add the `LiveEntry` union type (the run://log entry contract).
- **Modify** `src/stores/runsStore.ts` — `liveByStage: Record<string, LiveEntry[]>`, `appendEntry`, listener; remove the string-line `liveLogByStage`/`appendLog`/`getLiveLog`.
- **Modify** `src/stores/runsStore.test.ts` — update the live-log tests to entries.
- **Modify** `src/components/StageFocus.tsx` — render the journal (§ cards) from `liveByStage`.
- **Create** `src/components/StageFocus.test.tsx` — journal rendering tests.

---

### Task 1: `LiveEntry` type in the IPC contract

**Files:** Modify `src/lib/ipc.ts`. Verify with `npm run typecheck`.

- [ ] **Step 1 — Add the type.** In `src/lib/ipc.ts`, near the other Direct types (after `RunStage`/`RunDetail`, before the `ipc` object), add:
```ts
/** One live-activity entry streamed on `run://log` (see RUN_EVENTS.log). */
export type LiveEntry =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string; hint: string }
  | { kind: "tool_result"; ok: boolean; detail: string }
  | { kind: "notice"; text: string };
```
- [ ] **Step 2 — Update the `RUN_EVENTS.log` doc comment** to reflect the structured payload. Replace the comment above `log: "run://log",` with:
```ts
  /** Live per-stage activity, streamed by both substrates. Payload:
   *  `{ runId, stageId, entry: LiveEntry }` or `{ runId, stageId, reset: true }`. */
```
- [ ] **Step 3 — Verify:** `npm run typecheck` (clean — additive). Commit:
```bash
git add src/lib/ipc.ts
git commit -m "feat(direct/live-v2): LiveEntry type in the IPC contract"
```

---

### Task 2: runsStore — structured `liveByStage` buffer

**Files:** Modify `src/stores/runsStore.ts`, `src/stores/runsStore.test.ts`.

Context (current code): `runsStore.ts` has `const EMPTY_LOG: string[] = []`, `const MAX_LOG_LINES = 200`, `liveLogByStage: Record<string, string[]>`, `getLiveLog`, `appendLog(stageId, line)`, `clearLog(stageId)`, and a `run://log` listener that does `if (ev.payload.reset) clearLog else if (ev.payload.line != null) appendLog`.

- [ ] **Step 1 — Update tests first** (`src/stores/runsStore.test.ts`). The `beforeEach` resets `liveLogByStage: {}` → change to `liveByStage: {}`. Replace the `appendLog`/`clearLog` tests with entry-based versions:
```ts
  it("appendEntry accumulates structured entries per stage and caps the buffer", () => {
    const s = useRunsStore.getState();
    s.appendEntry("st1", { kind: "text", text: "first" });
    s.appendEntry("st1", { kind: "tool", tool: "Edit", hint: "src/x.rs" });
    const e = useRunsStore.getState().getLiveEntries("st1");
    expect(e).toEqual([
      { kind: "text", text: "first" },
      { kind: "tool", tool: "Edit", hint: "src/x.rs" },
    ]);
    // a different stage keeps its own buffer
    s.appendEntry("st2", { kind: "notice", text: "other" });
    expect(useRunsStore.getState().getLiveEntries("st2")).toHaveLength(1);
    // bounded to the most recent 200
    for (let i = 0; i < 250; i++) useRunsStore.getState().appendEntry("st1", { kind: "text", text: `L${i}` });
    const capped = useRunsStore.getState().getLiveEntries("st1");
    expect(capped.length).toBe(200);
    expect(capped[capped.length - 1]).toEqual({ kind: "text", text: "L249" });
  });

  it("clearLog drops a stage's buffer so a re-run starts fresh", () => {
    const s = useRunsStore.getState();
    s.appendEntry("st1", { kind: "text", text: "old" });
    s.clearLog("st1");
    expect(useRunsStore.getState().getLiveEntries("st1")).toEqual([]);
  });
```
- [ ] **Step 2 — Run, confirm FAIL:** `npx vitest run src/stores/runsStore 2>&1 | tail -20` (from worktree root).
- [ ] **Step 3 — Migrate the store.** In `src/stores/runsStore.ts`:
  - Import the type: add `LiveEntry` to the existing `import { … } from "../lib/ipc"`.
  - Replace `const EMPTY_LOG: string[] = [];` with `const EMPTY_ENTRIES: LiveEntry[] = [];` (keep `MAX_LOG_LINES = 200`).
  - In the `RunsState` interface: replace `liveLogByStage: Record<string, string[]>;` with `liveByStage: Record<string, LiveEntry[]>;`; replace `getLiveLog: (stageId: string) => string;` and `appendLog: (stageId: string, line: string) => void;` with `getLiveEntries: (stageId: string) => LiveEntry[];` and `appendEntry: (stageId: string, entry: LiveEntry) => void;`. Keep `clearLog`.
  - In the store body: replace `liveLogByStage: {},` with `liveByStage: {},`; replace `getLiveLog` with `getLiveEntries: (stageId) => get().liveByStage[stageId] ?? EMPTY_ENTRIES,`; replace `appendLog` with:
```ts
  appendEntry: (stageId, entry) =>
    set((s) => {
      const prev = s.liveByStage[stageId] ?? EMPTY_ENTRIES;
      const next =
        prev.length >= MAX_LOG_LINES
          ? [...prev.slice(prev.length - MAX_LOG_LINES + 1), entry]
          : [...prev, entry];
      return { liveByStage: { ...s.liveByStage, [stageId]: next } };
    }),
```
  - Update `clearLog` to operate on `liveByStage` (rename the field references).
  - Update the `run://log` listener:
```ts
void listen<{ runId: string; stageId: string; entry?: LiveEntry; reset?: boolean }>(
  RUN_EVENTS.log,
  (ev) => {
    const store = useRunsStore.getState();
    if (ev.payload.reset) store.clearLog(ev.payload.stageId);
    else if (ev.payload.entry) store.appendEntry(ev.payload.stageId, ev.payload.entry);
  },
);
```
- [ ] **Step 4 — Run tests, confirm PASS:** `npx vitest run src/stores/runsStore 2>&1 | tail -8`. Then `npm run typecheck` — this will FAIL in `StageFocus.tsx` (still references `liveLogByStage`/`getLiveLog`); that's expected and fixed in Task 3. To keep this commit green on its own, do Task 3 before committing OR temporarily it's acceptable that typecheck fails only in StageFocus — **commit Task 2 + Task 3 together if typecheck must stay green**. (Recommended: implement Task 3, then run typecheck, then make the two commits.)
- [ ] **Step 5 — Commit:**
```bash
git add src/stores/runsStore.ts src/stores/runsStore.test.ts
git commit -m "feat(direct/live-v2): structured liveByStage entry buffer in runsStore"
```

---

### Task 3: StageFocus — the work journal (§ TOOL cards)

**Files:** Modify `src/components/StageFocus.tsx`; create `src/components/StageFocus.test.tsx`.

The journal groups each `tool` entry with the `tool_result` that immediately follows it into one card.

- [ ] **Step 1 — Write the failing test.** Create `src/components/StageFocus.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../lib/ipc", () => ({ ipc: { getGitDiff: vi.fn().mockResolvedValue("") } }));

const { StageFocus } = await import("./StageFocus");
const { useRunsStore } = await import("../stores/runsStore");

const baseStage = {
  id: "st1", runId: "r1", position: 0, role: "code_review", agentModel: "haiku",
  substrate: "api", checkpoint: false, status: "running", inputTokens: 0, outputTokens: 0,
  costUsd: 0, artifact: null, feedback: null, error: null, startedAt: null, finishedAt: null,
  loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, loopIterations: 0,
} as any;

describe("StageFocus live journal", () => {
  beforeEach(() => { useRunsStore.setState({ liveByStage: {} }); });

  it("renders text as prose and a tool+result as one § card", () => {
    useRunsStore.setState({ liveByStage: { st1: [
      { kind: "text", text: "Inspecting the changes." },
      { kind: "tool", tool: "Read", hint: "src/auth.rs" },
      { kind: "tool_result", ok: true, detail: "142 lines" },
    ] } });
    render(<StageFocus stage={baseStage} workspacePath="/tmp" />);
    expect(screen.getByText("Inspecting the changes.")).toBeInTheDocument();
    expect(screen.getByText("Read")).toBeInTheDocument();          // tool name
    expect(screen.getByText("src/auth.rs")).toBeInTheDocument();   // hint
    expect(screen.getByText(/142 lines/)).toBeInTheDocument();     // result detail
    expect(screen.getByText(/working/)).toBeInTheDocument();       // running pulse
  });

  it("shows the empty 'working…' state when there are no entries yet", () => {
    render(<StageFocus stage={baseStage} workspacePath="/tmp" />);
    expect(screen.getByText(/working/)).toBeInTheDocument();
  });
});
```
- [ ] **Step 2 — Run, confirm FAIL:** `npx vitest run src/components/StageFocus 2>&1 | tail -20`.
- [ ] **Step 3 — Rewrite the live rendering in `StageFocus.tsx`.** Replace the `liveLines`/`liveLog` selector + the `liveLog`-string usages with a structured journal:
  - Replace `const EMPTY_LINES: string[] = [];` with `import type { LiveEntry } from "../lib/ipc";` (add to the existing type import) and `const EMPTY_ENTRIES: LiveEntry[] = [];`.
  - Replace the selector:
```tsx
  const liveEntries = useRunsStore((s) => s.liveByStage[stage?.id ?? ""] ?? EMPTY_ENTRIES);
```
  - Remove the `liveLog` `useMemo` (string join). Update the autoscroll effect dep from `[liveLog, stage?.status]` to `[liveEntries, stage?.status]`.
  - Add a journal renderer (above the `return`, inside the component or as a module helper). Group tool+tool_result:
```tsx
  const journal = useMemo(() => {
    const items: JSX.Element[] = [];
    for (let i = 0; i < liveEntries.length; i++) {
      const e = liveEntries[i];
      if (e.kind === "text") {
        items.push(<div key={i} className="text-octo-sage">{e.text}</div>);
      } else if (e.kind === "notice") {
        items.push(<div key={i} className="font-mono text-[10px] uppercase tracking-[0.12em] text-octo-brass">{e.text}</div>);
      } else if (e.kind === "tool") {
        const next = liveEntries[i + 1];
        const res = next && next.kind === "tool_result" ? next : null;
        if (res) i++; // consume the paired result
        items.push(
          <div key={i} className="rounded-md border border-octo-hairline bg-octo-panel-2 px-3 py-2">
            <div className="flex items-center gap-2 font-mono text-[12px]">
              <span className="text-octo-brass">§</span>
              <span className="text-octo-ivory">{e.tool}</span>
              {e.hint && <span className="text-octo-sage">· {e.hint}</span>}
            </div>
            {res && (
              <div className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-octo-mute">
                <span className={res.ok ? "text-octo-verdigris" : "text-octo-rouge"}>{res.ok ? "✓" : "✕"}</span>
                <span>{res.detail}</span>
              </div>
            )}
          </div>,
        );
      } else if (e.kind === "tool_result") {
        // orphan result (no preceding tool in buffer) — render compactly
        items.push(
          <div key={i} className="flex items-center gap-1.5 font-mono text-[11px] text-octo-mute">
            <span className={e.ok ? "text-octo-verdigris" : "text-octo-rouge"}>{e.ok ? "✓" : "✕"}</span>
            <span>{e.detail}</span>
          </div>,
        );
      }
    }
    return items;
  }, [liveEntries]);
```
  - In the scroll container, drop `whitespace-pre-wrap` (the journal is structured) and render the branches: **failed** → error (rouge) + (if `journal.length`) the journal below; **artifact** (done) → unchanged (artifact text + diff); **running** → the journal items + a `working…` pulse:
```tsx
      <div ref={scrollRef} className="chat-selectable flex flex-1 flex-col gap-2 overflow-auto px-4 py-3 font-mono text-[12px] leading-relaxed text-octo-sage">
        {stage.status === "failed" && stage.error ? (
          <>
            <span className="text-octo-rouge">{stage.error}</span>
            {journal.length > 0 && <div className="mt-2 flex flex-col gap-2 opacity-70">{journal}</div>}
          </>
        ) : artifact ? (
          <div className="whitespace-pre-wrap">
            {artifact.text || "(no output text)"}
            {artifact.refsWorktree &&
              (diffLoading ? (
                <div className="p-4 font-mono text-xs text-octo-mute">Loading diff…</div>
              ) : (
                <DiffViewer diff={diff} />
              ))}
          </div>
        ) : stage.status === "running" ? (
          <>
            {journal}
            <div className="flex items-center gap-2 text-octo-brass"><span>working…</span></div>
          </>
        ) : (
          <span className="text-octo-mute">No artifact yet.</span>
        )}
      </div>
```
- [ ] **Step 4 — Run StageFocus tests + typecheck:** `npx vitest run src/components/StageFocus 2>&1 | tail -10` then `npm run typecheck` (now clean — StageFocus no longer references the removed `liveLogByStage`/`getLiveLog`).
- [ ] **Step 5 — Full frontend test sweep:** `npx vitest run 2>&1 | grep -E "Test Files|Tests "` — all pass (any other consumer of the old store fields would surface here; there are none beyond StageFocus + runsStore.test).
- [ ] **Step 6 — Commit:**
```bash
git add src/components/StageFocus.tsx src/components/StageFocus.test.tsx
git commit -m "feat(direct/live-v2): focus-pane work journal with § TOOL cards"
```

---

## Self-review (against spec §2, §4.1–4.2)

- **`LiveEntry` type matching the Rust payload** → Task 1. ✓
- **runsStore structured buffer + listener pushes `entry`** → Task 2. ✓
- **Focus pane work journal: text/notice prose + `§ TOOL · hint` cards with `✓/✕ detail`** → Task 3. ✓
- **Migrate off the string-line buffer** (no `liveLogByStage`/`appendLog`/`getLiveLog` left) → Tasks 2/3. ✓
- **Done stages keep artifact+diff; failed shows error + journal; running shows journal + working pulse** → Task 3. ✓
- **Autoscroll preserved; `chat-selectable` preserved** → Task 3. ✓
- **Design rules:** tokens only, no hex, no italics, `§` in brass, English copy → Task 3. ✓
- **Out of scope:** track liveness (V3), live cost. ✓

**Type consistency:** `LiveEntry` union (`ipc.ts`) used by `liveByStage`/`appendEntry`/`getLiveEntries` (runsStore) and the StageFocus selector + journal `useMemo`. Listener payload `{ runId, stageId, entry?: LiveEntry, reset?: boolean }`. The `tool`+`tool_result` pairing assumes the result immediately follows its tool (which V1's emission guarantees: per tool_use, `tool` then `tool_result`).

**Commit-green note (Task 2 Step 4):** removing `liveLogByStage` breaks `StageFocus` typecheck until Task 3. Implement Task 3 before running the final typecheck; if strictly committing per task, expect the Task 2 commit's typecheck to fail only in StageFocus and go green after Task 3 — acceptable within one PR, but cleaner to stage both edits then make the two commits back-to-back.
