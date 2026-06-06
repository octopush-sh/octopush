# Gap-Closing 4 — Drag-to-Reorder Projects — Plan 8

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Let users drag project headers to reorder the rail (persisting `sort_order`), complementing the existing accessible Move up/down menu actions — using `@dnd-kit` for a smooth, keyboard-accessible sortable.

**Architecture:** De-risked in two stages. **Stage A (Task 1):** a *faithful, behavior-preserving extraction* of the per-project rendering from the inline `.map` into a `SortableProjectGroup` component in the same file — NO drag yet — so the full test suite proves nothing regressed (pulse, dots, collapse, filter, drawer, menus). **Stage B (Task 2):** wrap the list in `DndContext` + `SortableContext`, make `SortableProjectGroup` use `useSortable` with a drag handle, and persist on drop via the existing `setOrder` store action. Drag is disabled while filtering or when the rail is icon-collapsed.

**Tech Stack:** React 19 + TS, `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities` (installed), Zustand, Tailwind tokens, Vitest.

**Scope:** projects only (workspace reordering is out of scope per spec §9). Pinned still sort first server-side; dragging an unpinned project across the pin boundary clamps to the top of the unpinned group (documented — same semantics as Move up/down). `@dnd-kit` already added to package.json. Spec §9 (drag reorder — the deferred half of Plan 4).

---

## Task 1: Faithful extraction — `SortableProjectGroup` (NO drag yet)

**Why:** The per-project JSX (header pulse/PR/chevron, collapse, filtered workspaces, empty state) is inline in the `.map`. `useSortable` (Task 2) must live in a component. Extract it FIRST with zero behavior change, and confirm the suite stays green — this isolates refactor risk from drag risk.

**Files:**
- Modify: `src/components/WorkspaceRail.tsx`

- [ ] **Step 1: Create the component (same file, above or below `WorkspaceRail`)**

Add a `SortableProjectGroup` function component that renders EXACTLY the current per-project body. It receives everything the body reads as props. Compute `nameMatch`/`visibleWs`/`projectExpanded` inside it (from `q` + `collapsedProjects`). The body JSX is moved verbatim from the current `.map` return (lines ~118-247) — the outer `<div key=...>` down through the "No workspaces yet" block — with `project`, `projectIndex`, etc. now coming from props.

```tsx
interface SortableProjectGroupProps {
  project: ProjectGroup;
  projectIndex: number;
  projectCount: number;
  isCollapsed: boolean;
  q: string;
  collapsedProjects: Record<string, boolean>;
  toggleProjectCollapsed: (projectId: string) => void;
  activeWorkspaceId: string | null;
  gitSummaryByWs?: Record<string, WorkspaceGitSummary>;
  prByWs?: Record<string, Pr | null>;
  onSelect: (id: string) => void;
  onCustomize: (id: string) => void;
  onContextMenu?: (workspaceId: string, x: number, y: number) => void;
  onNewWorkspaceForProject?: (projectId: string) => void;
  onProjectContextMenu?: (projectId: string, x: number, y: number) => void;
}

function SortableProjectGroup({
  project,
  projectIndex,
  projectCount,
  isCollapsed,
  q,
  collapsedProjects,
  toggleProjectCollapsed,
  activeWorkspaceId,
  gitSummaryByWs,
  prByWs,
  onSelect,
  onCustomize,
  onContextMenu,
  onNewWorkspaceForProject,
  onProjectContextMenu,
}: SortableProjectGroupProps) {
  const nameMatch = q === "" || (project?.name ?? "").toLowerCase().includes(q);
  const visibleWs =
    q === "" || nameMatch
      ? (project?.workspaces || [])
      : (project?.workspaces || []).filter((w) => (w?.name ?? "").toLowerCase().includes(q));
  const projectExpanded = q !== "" ? true : !collapsedProjects[project.id];

  return (
    <div
      className={`flex flex-col ${isCollapsed ? "gap-1" : "gap-1"}`}
      style={{ marginBottom: isCollapsed && projectIndex < projectCount - 1 ? "0.5rem" : !isCollapsed && projectIndex < projectCount - 1 ? "0.75rem" : "0" }}
    >
      {/* ... EXACT current header IIFE, separator, workspaces map, empty state ... */}
    </div>
  );
}
```

Move the existing body (header IIFE, separator, `(isCollapsed || projectExpanded) && visibleWs.map(...WorkspaceRow...)`, and the "No workspaces yet" block) into this component VERBATIM. The only substitutions: `projects.length` → `projectCount`; everything else (`project`, `projectIndex`, `isCollapsed`, `collapsedProjects`, `toggleProjectCollapsed`, `gitSummaryByWs`, `prByWs`, `activeWorkspaceId`, `onSelect`, `onCustomize`, `onContextMenu`, `onNewWorkspaceForProject`, `onProjectContextMenu`, `detectIssueKeyForProject`, `TINTS`, `ProjectMark`, `ChevronDown`, `WorkspaceRow`) is already in module scope or now a prop.

- [ ] **Step 2: Replace the inline map**

In `WorkspaceRail`, replace the `{(projects || []).map((project, projectIndex) => { ... })}` block with a version that keeps the filter early-return and delegates the body:

```tsx
        {(projects || []).map((project, projectIndex) => {
          // Hide projects with no filter hit (header name or any workspace).
          if (q !== "") {
            const nameMatch = (project?.name ?? "").toLowerCase().includes(q);
            const anyWs = (project?.workspaces || []).some((w) =>
              (w?.name ?? "").toLowerCase().includes(q),
            );
            if (!nameMatch && !anyWs) return null;
          }
          return (
            <SortableProjectGroup
              key={project?.id || `project-${projectIndex}`}
              project={project}
              projectIndex={projectIndex}
              projectCount={projects.length}
              isCollapsed={isCollapsed}
              q={q}
              collapsedProjects={collapsedProjects}
              toggleProjectCollapsed={toggleProjectCollapsed}
              activeWorkspaceId={activeWorkspaceId}
              gitSummaryByWs={gitSummaryByWs}
              prByWs={prByWs}
              onSelect={onSelect}
              onCustomize={onCustomize}
              onContextMenu={onContextMenu}
              onNewWorkspaceForProject={onNewWorkspaceForProject}
              onProjectContextMenu={onProjectContextMenu}
            />
          );
        })}
```

(The duplicate filter check is fine — the authoritative `visibleWs` lives in the component. Keep the early-return so non-matching projects don't render at all.)

- [ ] **Step 3: Verify behavior is identical**

Run: `npm run typecheck` → clean. `npm test` → green; the WorkspaceRail tests (`WorkspaceRail.test.tsx`, `WorkspaceRail.integration.test.tsx`) MUST pass unchanged — this is the proof the extraction preserved behavior. `git diff -- src | grep -nE "#[0-9a-fA-F]{3,8}"` → empty.

If any rail test fails, the extraction changed behavior — fix the extraction to match the original exactly (do NOT change the test). Report any test that needed investigation.

- [ ] **Step 4: Commit**

```bash
git add src/components/WorkspaceRail.tsx
git commit -m "refactor(rail): extract SortableProjectGroup (no behavior change)"
```

---

## Task 2: Wire dnd-kit drag-reorder

**Why:** With the group extracted, add the sortable. Drag a project header (via a grip handle) to reorder; persist on drop. Keyboard-accessible (dnd-kit KeyboardSensor). Disabled while filtering / collapsed.

**Files:**
- Modify: `src/components/WorkspaceRail.tsx`
- (No App change — `onReorder` is a new optional prop, or reuse: see Step 3.)

- [ ] **Step 1: imports + a reorder prop**

Add to `WorkspaceRail.tsx`:
```tsx
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
```
Add an optional prop to `Props`:
```tsx
  /** Persist a new project order (ids top→bottom). */
  onReorderProjects?: (ids: string[]) => void;
```
and destructure `onReorderProjects,`.

- [ ] **Step 2: DndContext + SortableContext around the project list**

In `WorkspaceRail`, set up sensors and wrap the `.map`. Drag is enabled only when NOT collapsed and NOT filtering:
```tsx
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const dragEnabled = !isCollapsed && q === "" && !!onReorderProjects;

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = (projects || []).map((p) => p.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onReorderProjects?.(next);
  };
```
Wrap the project list:
```tsx
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={(projects || []).map((p) => p.id)} strategy={verticalListSortingStrategy}>
            {(projects || []).map((project, projectIndex) => {
              ... filter early-return ...
              return (
                <SortableProjectGroup
                  ...existing props...
                  dragEnabled={dragEnabled}
                />
              );
            })}
          </SortableContext>
        </DndContext>
```
(Keep the filter input as a sibling BEFORE the DndContext, not inside SortableContext.)

- [ ] **Step 3: make `SortableProjectGroup` sortable + add the grip handle**

Add `dragEnabled: boolean` to `SortableProjectGroupProps`. Inside the component, call `useSortable` and apply ref/transform to the outer `<div>`:
```tsx
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: project.id, disabled: !dragEnabled });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : undefined,
  };
```
Apply to the outer div: `ref={setNodeRef} style={{ ...existing marginBottom, ...style }}`.
Add a grip handle as the FIRST child of the header's right-side `<div className="flex items-center gap-1">` (only when `dragEnabled`):
```tsx
                  {dragEnabled && (
                    <button
                      type="button"
                      ref={setActivatorNodeRef}
                      {...attributes}
                      {...listeners}
                      aria-label={`Reorder ${project.name}`}
                      title="Drag to reorder"
                      className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center h-5 w-5 cursor-grab text-octo-mute hover:text-octo-brass"
                    >
                      <GripVertical size={12} aria-hidden="true" />
                    </button>
                  )}
```
(The grip is keyboard-focusable — dnd-kit's KeyboardSensor lets the user reorder with Space + arrows on the handle.)

Note: the outer div's `style` currently is `{ marginBottom: ... }`. Merge: compute `marginBottom` as before, then `style={{ marginBottom, transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : undefined }}`.

- [ ] **Step 4: wire `onReorderProjects` in App.tsx**

In `src/App.tsx`, pass the new prop to `<WorkspaceRail>` using the existing `setProjectOrderAction` (from Plan 4):
```tsx
        onReorderProjects={(ids) => void setProjectOrderAction(ids)}
```
(`setProjectOrderAction = useProjectStore((s) => s.setOrder)` already exists from Plan 4 Task 8. Confirm; if not present, add the selector.)

- [ ] **Step 5: verify**

- `npm run typecheck` → clean.
- `npm test` → green. If a rail test renders `WorkspaceRail` without a DndContext-compatible environment and breaks, investigate: `@dnd-kit` works in jsdom; `useSortable` inside `SortableContext` should be fine. If a test fails because it now needs the new optional prop, it's optional so it shouldn't. Report any test touched.
- `git diff -- src | grep -nE "#[0-9a-fA-F]{3,8}"` → empty.

- [ ] **Step 6: commit**

```bash
git add src/components/WorkspaceRail.tsx src/App.tsx
git commit -m "feat(rail): drag-to-reorder projects via @dnd-kit (§9)"
```

---

## Task 3: Full verification

- [ ] `npm run typecheck && npm test && (cd src-tauri && cargo test)` — all green.
- [ ] `git diff main -- src | grep -nE "#[0-9a-fA-F]{3,8}" || echo clean`.
- [ ] Manual (`npm run tauri:dev`): hover a project header → grip appears; drag to reorder → order persists across restart. Keyboard: focus the grip, Space to lift, ↑/↓ to move, Space to drop. Drag is absent when the rail is icon-collapsed or while the filter has text. Move up/down menu actions still work. Pinned projects stay on top (dragging an unpinned above a pinned clamps to the top of the unpinned group).

---

## Self-Review (during planning)

- **Coverage:** §9 drag reorder via @dnd-kit (T2), persisting through the existing `setOrder` (no new backend). Extraction (T1) de-risks by proving behavior-preservation before drag. Projects-only (workspaces out of scope per spec). Drag disabled while filtering/collapsed.
- **Placeholders:** none — T1 moves the body verbatim (the "EXACT current ... " markers are move instructions, the literal source is in the file). T1 is a pure refactor gated on the suite staying green.
- **Type consistency:** `onReorderProjects?(ids: string[])` ↔ App `setProjectOrderAction(ids)` (Plan 4 `setOrder` → `set_project_order`). `SortableProjectGroupProps` lists every value the moved body reads. `useSortable({id: project.id})` matches `SortableContext items={project ids}`.
- **Calm/a11y/perf:** grip is hover-revealed + keyboard-focusable (dnd-kit KeyboardSensor → accessible drag); PointerSensor distance:5 avoids accidental drags on click; `verticalListSortingStrategy` for a vertical list; drag disabled during filter/collapse avoids reordering a partial list. Pinned-boundary clamp documented. No new colors (grip uses mute→brass like the +/chevron).
- **Risk note:** the extraction is the main risk; the WorkspaceRail test suite (incl. integration test) is the safety net and must stay green at T1 before T2 adds drag.
