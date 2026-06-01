# Active Ticket Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Active Ticket presentation from the Companion sidebar to the top header (replacing project/workspace identity that the Rail already covers), and remove the now-redundant ProjectSwitcher modal.

**Architecture:** `ContextHeader.tsx` gains a binary render branch: when `useActiveIssue(activeKey)` returns a non-null issue, the left side shows `◈ KEY · STATUS · summary` in a single row; otherwise it degrades to the existing `WORKSPACE name` block. The Companion drops its `ActiveTicketPanel` render. The `ProjectSwitcher` modal and its single header entry-point are deleted entirely. `EmptyProjectState` drops its "Switch project" button.

**Tech Stack:** React 19 + TypeScript + Vitest + Tailwind v4. Existing Zustand stores (`useIssuesStore`, `useParentIssuesStore`) and pure selector module (`src/lib/issueTrackerSelectors.ts`) reused.

**Authoritative spec:** `docs/superpowers/specs/2026-06-01-active-ticket-header-design.md`

**Branch:** Create `feat/active-ticket-header` from `main` before T1. Commit on it; do NOT push between tasks.

---

## Task 1: Refactor `ContextHeader` to ticket + degraded branches

**Files:**
- Modify: `src/components/ContextHeader.tsx` (full rewrite below)
- Modify: `src/components/ContextHeader.test.tsx` (drop `projectName` / `onOpenProjectSwitcher` from existing test render calls; add 5 new tests)
- Modify: `src/App.tsx` — the `<ContextHeader …>` render call (around line 1112-1130; drop `projectName={project.name}` and `onOpenProjectSwitcher={…}` from the prop block)

- [ ] **Step 1: Update the existing test file to drop the removed props**

In `src/components/ContextHeader.test.tsx`, find every `renderHeader({ … })` (or whichever helper renders `<ContextHeader />`) call and **remove** the `projectName` and `onOpenProjectSwitcher` props from the call sites. Keep all other props. Also delete from the helper signature if those props are part of it. Existing assertions stay.

Run: `npx vitest run src/components/ContextHeader.test.tsx 2>&1 | tail -8`
Expected: existing tests still pass (the assertions don't depend on the removed props).

- [ ] **Step 2: Write the 5 new failing tests**

Append inside the existing `describe("ContextHeader", () => { … })` block in `src/components/ContextHeader.test.tsx`:

```tsx
  it("with activeIssue, renders the ticket layout (KEY, status, summary, ◈) and no WORKSPACE block", async () => {
    const workspace = {
      id: "w1", projectId: "p1", name: "ws-name", task: "",
      branch: "feat/CLPNSNS-92",
      worktreePath: null, setupScript: "", status: "active",
      createdAt: "", lastActive: "", glyph: null, tint: null, testCommand: null,
      linkedIssueKey: null, issueLinkDismissed: false,
    };
    useIssuesStore.setState({
      issues: [
        {
          key: "CLPNSNS-92", summary: "Consumir notificaciones",
          statusName: "In Progress", statusCategory: "inProgress",
          issueType: "Story", priority: "High",
          url: "https://x/browse/CLPNSNS-92", parentKey: null,
        },
      ],
      loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    renderHeader({ workspace, issueTrackerConfigured: true });

    expect(await screen.findByText("CLPNSNS-92")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText("Consumir notificaciones")).toBeInTheDocument();
    expect(screen.queryByText(/^Workspace$/i)).not.toBeInTheDocument();
    expect(screen.queryByText("ws-name")).not.toBeInTheDocument();
  });

  it("with linkage=linked but activeIssue null (still loading), renders the degraded WORKSPACE block", () => {
    const workspace = {
      id: "w1", projectId: "p1", name: "ws-degraded", task: "",
      branch: "feat/CLPNSNS-92",
      worktreePath: null, setupScript: "", status: "active",
      createdAt: "", lastActive: "", glyph: null, tint: null, testCommand: null,
      linkedIssueKey: null, issueLinkDismissed: false,
    };
    useIssuesStore.setState({
      issues: null, loading: true, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    renderHeader({ workspace, issueTrackerConfigured: true });

    expect(screen.getByText(/^Workspace$/i)).toBeInTheDocument();
    expect(screen.getByText("ws-degraded")).toBeInTheDocument();
    expect(screen.queryByText(/◈/)).not.toBeInTheDocument();
  });

  it("with linkage=unlinked, renders the degraded WORKSPACE block", () => {
    const workspace = {
      id: "w1", projectId: "p1", name: "ws-main", task: "",
      branch: "main",
      worktreePath: null, setupScript: "", status: "active",
      createdAt: "", lastActive: "", glyph: null, tint: null, testCommand: null,
      linkedIssueKey: null, issueLinkDismissed: false,
    };
    useIssuesStore.setState({
      issues: [], loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    renderHeader({ workspace, issueTrackerConfigured: true });

    expect(screen.getByText(/^Workspace$/i)).toBeInTheDocument();
    expect(screen.getByText("ws-main")).toBeInTheDocument();
    expect(screen.queryByText(/◈/)).not.toBeInTheDocument();
  });

  it("clicking the ticket area calls ipc.openFileInSystem with the issue url", async () => {
    const openFileInSystemMock = vi.mocked(ipc.openFileInSystem);
    openFileInSystemMock.mockResolvedValue(undefined);
    const workspace = {
      id: "w1", projectId: "p1", name: "ws", task: "",
      branch: "feat/CLPNSNS-92",
      worktreePath: null, setupScript: "", status: "active",
      createdAt: "", lastActive: "", glyph: null, tint: null, testCommand: null,
      linkedIssueKey: null, issueLinkDismissed: false,
    };
    useIssuesStore.setState({
      issues: [
        {
          key: "CLPNSNS-92", summary: "Consumir notificaciones",
          statusName: "In Progress", statusCategory: "inProgress",
          issueType: "Story", priority: null,
          url: "https://acme.atlassian.net/browse/CLPNSNS-92", parentKey: null,
        },
      ],
      loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    renderHeader({ workspace, issueTrackerConfigured: true });

    fireEvent.click(await screen.findByRole("button", { name: /open ticket/i }));
    expect(openFileInSystemMock).toHaveBeenCalledWith("https://acme.atlassian.net/browse/CLPNSNS-92");
  });

  it("status text uses the correct token per statusCategory", async () => {
    const workspace = {
      id: "w1", projectId: "p1", name: "ws", task: "",
      branch: "feat/CLPNSNS-92",
      worktreePath: null, setupScript: "", status: "active",
      createdAt: "", lastActive: "", glyph: null, tint: null, testCommand: null,
      linkedIssueKey: null, issueLinkDismissed: false,
    };
    const cases: Array<["todo" | "inProgress" | "done" | "unknown", string]> = [
      ["inProgress", "text-octo-brass"],
      ["todo", "text-octo-mute"],
      ["done", "text-octo-verdigris"],
      ["unknown", "text-octo-sage"],
    ];
    for (const [category, expectedClass] of cases) {
      useIssuesStore.setState({
        issues: [
          {
            key: "CLPNSNS-92", summary: "x",
            statusName: category === "inProgress" ? "In Progress" : category === "done" ? "Done" : category === "todo" ? "To Do" : "Unknown",
            statusCategory: category,
            issueType: "Story", priority: null,
            url: "https://x/CLPNSNS-92", parentKey: null,
          },
        ],
        loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
      });
      const { unmount } = renderHeader({ workspace, issueTrackerConfigured: true });
      const statusEl = await screen.findByText(
        category === "inProgress" ? "In Progress" : category === "done" ? "Done" : category === "todo" ? "To Do" : "Unknown",
      );
      expect(statusEl).toHaveClass(expectedClass);
      unmount();
    }
  });
```

The new tests rely on:
- `renderHeader` helper (existing in the file).
- The mocked `useIssuesStore` (existing setup).
- `fireEvent` and `screen` from `@testing-library/react`.

If `renderHeader` doesn't have a `workspace` prop knob today, extend it to accept the new props (signature: `(overrides: { workspace?: Workspace | null; issueTrackerConfigured?: boolean }) => ReturnType<typeof render>`). Mirror the existing chip-test wiring.

- [ ] **Step 3: Run tests to verify the 5 new tests FAIL**

Run: `npx vitest run src/components/ContextHeader.test.tsx 2>&1 | tail -10`
Expected: existing tests pass; the 5 new tests fail because the component doesn't yet have the ticket branch.

- [ ] **Step 4: Rewrite `ContextHeader.tsx` with the new branches**

Replace the entire contents of `src/components/ContextHeader.tsx` with:

```tsx
import { useEffect, useState } from "react";
import type { GitStatus, OpenPr, Issue, StatusCategory, Workspace } from "../lib/types";
import { ScratchpadIcon } from "./ScratchpadIcon";
import { useScratchpadStore } from "../stores/scratchpadStore";
import { useIssuesStore } from "../stores/issuesStore";
import { useParentIssuesStore } from "../stores/parentIssuesStore";
import { ipc } from "../lib/ipc";
import { resolveLinkage } from "../lib/issueTrackerSelectors";

/** Resolve an issue by key — prefers the store, falls back to getIssue() once
 *  per key change. Returns null until an issue is found or the lookup fails. */
function useActiveIssue(key: string | null): Issue | null {
  const storeIssues = useIssuesStore((s) => s.issues);
  const [fallback, setFallback] = useState<Issue | null>(null);
  useEffect(() => {
    setFallback(null);
    if (!key) return;
    const hit = (storeIssues ?? []).find((i) => i.key === key);
    if (hit) return;
    ipc.getIssue(key).then(setFallback).catch(() => setFallback(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!key) return null;
  return storeIssues?.find((i) => i.key === key) ?? fallback;
}

const STATUS_TOKEN: Record<StatusCategory, string> = {
  inProgress: "text-octo-brass",
  todo: "text-octo-mute",
  done: "text-octo-verdigris",
  unknown: "text-octo-sage",
};

interface Props {
  workspaceName: string;
  branch: string;
  gitStatus: GitStatus | null;
  openPr: OpenPr | null;
  /** Called with the PR's html_url when the chip is clicked. Typically
   *  routes through `ipc.openFileInSystem` to launch the browser. */
  onOpenPr?: (url: string) => void;
  /** The active workspace. Used to derive the ticket via resolveLinkage
   *  (manual link wins over branch detection). */
  workspace?: Workspace | null;
  /** Whether the issue tracker is configured. When false, no ticket is
   *  shown even if a key is present — the degraded WORKSPACE block renders. */
  issueTrackerConfigured?: boolean;
  rightSlot?: React.ReactNode;
}

export function ContextHeader({
  workspaceName,
  branch,
  gitStatus,
  openPr,
  onOpenPr,
  workspace = null,
  issueTrackerConfigured = false,
  rightSlot,
}: Props) {
  const unstaged = gitStatus?.changedFiles.length ?? 0;
  const toggleScratchpad = useScratchpadStore((s) => s.toggleOpen);
  const linkage = workspace ? resolveLinkage(workspace, branch) : { kind: "unlinked" as const };
  const activeKey =
    linkage.kind === "linked" && issueTrackerConfigured ? linkage.key : null;
  const activeIssue = useActiveIssue(activeKey);

  const parents = useParentIssuesStore((s) => s.parents);
  const loadParent = useParentIssuesStore((s) => s.loadParent);
  useEffect(() => {
    if (activeIssue?.parentKey) void loadParent(activeIssue.parentKey);
  }, [activeIssue?.parentKey, loadParent]);

  const parentSummary =
    activeIssue?.parentKey ? parents[activeIssue.parentKey]?.summary : undefined;

  return (
    <div className="m-4 flex items-center gap-4 rounded-xl border border-octo-hairline bg-octo-panel px-4 py-2">
      {activeIssue ? (
        <button
          type="button"
          aria-label="Open ticket in Jira"
          title={
            `${activeIssue.key} · ${activeIssue.issueType.toUpperCase()}` +
            (activeIssue.priority ? ` · ${activeIssue.priority.toUpperCase()}` : "") +
            (parentSummary ? ` · Epic: ${parentSummary}` : "") +
            ` · ${activeIssue.summary}`
          }
          onClick={() => { void ipc.openFileInSystem(activeIssue.url).catch(() => {}); }}
          className="-mx-1 flex min-w-0 flex-1 items-center gap-2.5 rounded px-1 transition hover:bg-[var(--brass-ghost)]"
        >
          <span className="text-octo-brass" aria-hidden style={{ fontSize: 16, lineHeight: 1 }}>◈</span>
          <span className="font-mono text-[12px] text-octo-brass">{activeIssue.key}</span>
          <span className={`font-mono text-[10px] uppercase tracking-[0.15em] ${STATUS_TOKEN[activeIssue.statusCategory]}`}>
            {activeIssue.statusName}
          </span>
          <span aria-hidden className="h-[14px] w-px bg-octo-hairline" />
          <span className="min-w-0 truncate font-serif text-[15px] leading-tight text-octo-ivory">
            {activeIssue.summary}
          </span>
        </button>
      ) : (
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
            Workspace
          </div>
          <div
            key={workspaceName}
            className="animate-name-in font-serif text-[15px] leading-tight tracking-[-0.005em] text-octo-ivory"
          >
            {workspaceName}
          </div>
        </div>
      )}

      <div className="ml-auto flex flex-shrink-0 items-center gap-4">
        <div className="flex items-center gap-2 font-mono text-[10px] text-octo-mute">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-octo-verdigris" aria-hidden />
          <span>↳ {branch}</span>
          {unstaged > 0 && <span>· {unstaged} unstaged</span>}
        </div>

        {openPr && (
          <button
            type="button"
            onClick={() => onOpenPr?.(openPr.url)}
            title={`${openPr.isDraft ? "Draft" : "Open"} pull request — ${openPr.title}`}
            className="flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-brass transition-colors"
            style={{
              background: "var(--brass-ghost)",
              border: "1px solid var(--brass-dim)",
            }}
          >
            <span aria-hidden style={{ fontSize: 11, lineHeight: 1 }}>
              {openPr.isDraft ? "◐" : "●"}
            </span>
            <span>PR · #{openPr.number}</span>
            <span aria-hidden style={{ fontSize: 9, opacity: 0.6 }}>
              ↗
            </span>
          </button>
        )}

        {rightSlot && (
          <>
            <span className="h-6 w-px bg-octo-hairline" aria-hidden />
            <div className="flex items-center gap-2">
              <ScratchpadIcon onClick={toggleScratchpad} />
              {rightSlot}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

Key things to note for the implementer:
- `useActiveIssue` is the same hook that existed pre-redesign — left in place, just moved out of any prior wrapping.
- `useParentIssuesStore` is the SAME store that `ActiveTicketPanel` used; we just call it from `ContextHeader` now.
- The right group (branch + PR + ScratchpadIcon + rightSlot) is unchanged from today's header.

- [ ] **Step 5: Update `App.tsx` to drop the removed props**

In `src/App.tsx`, locate the `<ContextHeader …>` render call (search for `<ContextHeader`). The block today reads roughly:

```tsx
<ContextHeader
  projectName={project.name}
  onOpenProjectSwitcher={() => {
    loadRecentProjects();
    setShowProjectSwitcher(true);
  }}
  workspaceName={activeWorkspace.name}
  branch={activeWorkspace.branch}
  gitStatus={gitStatus}
  openPr={openPrByWs[activeWorkspace.id] ?? null}
  onOpenPr={(url) => ipc.openFileInSystem(url)}
  workspace={activeWorkspace}
  issueTrackerConfigured={issueTrackerConfigured}
  rightSlot={ … }
/>
```

Remove the `projectName` and `onOpenProjectSwitcher` lines. The remainder stays. Don't touch `showProjectSwitcher` state yet — Task 4 removes it after the dead-code references are gone.

- [ ] **Step 6: Run tests to verify all pass + typecheck clean**

Run: `npx vitest run src/components/ContextHeader.test.tsx 2>&1 | tail -10`
Expected: all (existing + 5 new) pass.

Run: `npm run typecheck 2>&1 | tail -3`
Expected: clean. (Removing the `projectName` / `onOpenProjectSwitcher` props from the App.tsx call site is matched by the same removal from the Props interface — TypeScript should be happy.)

Run: `npx vitest run 2>&1 | tail -6`
Expected: full suite still passes (other tests don't reference the removed props).

- [ ] **Step 7: Commit**

```bash
git add src/components/ContextHeader.tsx src/components/ContextHeader.test.tsx src/App.tsx
git commit -m "feat(header): ticket-or-workspace render branches in ContextHeader"
```

---

## Task 2: Drop `ActiveTicketPanel` from Companion + delete the component

**Files:**
- Modify: `src/components/Companion.tsx` (remove ActiveTicketPanel import + render)
- Modify: `src/components/Companion.test.tsx` (drop the ActiveTicketPanel `data-testid` mock + assertions)
- Delete: `src/components/ActiveTicketPanel.tsx`
- Delete: `src/components/ActiveTicketPanel.test.tsx`

- [ ] **Step 1: Update the Companion test to drop ActiveTicketPanel assertions**

Open `src/components/Companion.test.tsx`. Locate the `vi.mock("./ActiveTicketPanel", …)` block — remove it. Locate the 3 cross-mode tests that assert `data-testid="active"` — remove ONLY those `expect(...).toBeInTheDocument()` lines for `active`. Keep the assertions for `backlog` and other elements.

Save. The tests should still pass against the current code (the assertion was just dropped, the render still includes ActiveTicketPanel until Step 2).

Run: `npx vitest run src/components/Companion.test.tsx 2>&1 | tail -6`
Expected: 3/3 pass.

- [ ] **Step 2: Remove the ActiveTicketPanel render from Companion**

In `src/components/Companion.tsx`, find the `import { ActiveTicketPanel } from "./ActiveTicketPanel";` line — remove it. Find the JSX render block that contains `<ActiveTicketPanel … />` — remove just that block. The BacklogPanel + ElsewhereFooter renders stay.

The block to remove looks like:

```tsx
          <ActiveTicketPanel
            state={linkage}
            activeIssue={activeIssue}
            issuesLoaded={issues !== null}
            candidates={issues ?? []}
            projectKey={projectKey}
            workspaceId={workspace.id}
            projectId={workspace.projectId}
          />
```

After removal, the `linkage` / `activeIssue` derivations in the same file are no longer used. Remove them too:

```tsx
  const linkage = workspace ? resolveLinkage(workspace, branch) : { kind: "unlinked" as const };
  const activeKey = linkage.kind === "linked" ? linkage.key : null;
  const activeIssue =
    activeKey ? (issues ?? []).find((i) => i.key === activeKey) ?? null : null;
```

And drop the now-unused `resolveLinkage` import. `resolveJiraProjectKey` and `selectElsewhereCount` stay (they feed BacklogPanel + ElsewhereFooter).

- [ ] **Step 3: Run Companion tests**

Run: `npx vitest run src/components/Companion.test.tsx 2>&1 | tail -6`
Expected: 3/3 pass.

- [ ] **Step 4: Delete `ActiveTicketPanel.tsx` + its test**

```bash
rm src/components/ActiveTicketPanel.tsx src/components/ActiveTicketPanel.test.tsx
```

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: clean. No other file imports `ActiveTicketPanel` after the Companion change.

Run: `npx vitest run 2>&1 | tail -5`
Expected: full suite passes. The deletion of the `ActiveTicketPanel.test.tsx` file reduces the suite count by its previous tests (≈10).

- [ ] **Step 6: Commit**

```bash
git add src/components/Companion.tsx src/components/Companion.test.tsx
git rm src/components/ActiveTicketPanel.tsx src/components/ActiveTicketPanel.test.tsx
git commit -m "feat(companion): drop ActiveTicketPanel (presentation moved to header)"
```

---

## Task 3: Update `EmptyProjectState` — drop the Switch button + add footer hint

**Files:**
- Modify: `src/components/EmptyProjectState.tsx`
- Modify: `src/components/EmptyProjectState.test.tsx` (if it exists; if not, create a minimal test)
- Modify: `src/App.tsx` — the `<EmptyProjectState …>` render call (drop the `onSwitchProject` prop pass-through)

- [ ] **Step 1: Read the current `EmptyProjectState.tsx`**

Open `src/components/EmptyProjectState.tsx`. Note the prop signature (likely `{ projectName: string; onCreateWorkspace: () => void; onSwitchProject: () => void }`) and the button JSX for "Switch project".

- [ ] **Step 2: Update or write the failing test**

If `src/components/EmptyProjectState.test.tsx` exists, ADD this test inside the existing `describe(…)`:

```tsx
  it("renders the 'pick another project from the rail' hint and no Switch project button", () => {
    render(<EmptyProjectState projectName="Test" onCreateWorkspace={vi.fn()} />);
    expect(screen.getByText(/pick another project from the rail/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /switch project/i })).not.toBeInTheDocument();
  });
```

If the test file does NOT exist, create `src/components/EmptyProjectState.test.tsx` with:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyProjectState } from "./EmptyProjectState";

describe("EmptyProjectState", () => {
  it("renders the 'pick another project from the rail' hint and no Switch project button", () => {
    render(<EmptyProjectState projectName="Test" onCreateWorkspace={vi.fn()} />);
    expect(screen.getByText(/pick another project from the rail/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /switch project/i })).not.toBeInTheDocument();
  });
});
```

Run: `npx vitest run src/components/EmptyProjectState.test.tsx 2>&1 | tail -6`
Expected: FAIL (the hint string isn't in the component yet; the Switch button is still there).

- [ ] **Step 3: Update `EmptyProjectState.tsx`**

In `src/components/EmptyProjectState.tsx`:
- Remove the `onSwitchProject` prop from the `Props` interface and from the destructured argument list.
- Remove the `<button … onClick={onSwitchProject}>Switch project</button>` JSX.
- Below the existing `Create workspace` button (or wherever the bottom of the empty-state body sits), add:

```tsx
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute">
          Or pick another project from the rail
        </p>
```

Match the existing layout's spacing and class conventions; if the surrounding code uses a different mute-mono pattern, mirror that exactly.

- [ ] **Step 4: Run tests to verify the new assertion passes**

Run: `npx vitest run src/components/EmptyProjectState.test.tsx 2>&1 | tail -6`
Expected: PASS.

- [ ] **Step 5: Update `App.tsx` `<EmptyProjectState>` call**

In `src/App.tsx`, locate the `<EmptyProjectState …>` render call (search `<EmptyProjectState`). Remove the `onSwitchProject={…}` prop line. Keep `projectName` and `onCreateWorkspace`.

- [ ] **Step 6: Typecheck + full suite**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: clean.

Run: `npx vitest run 2>&1 | tail -5`
Expected: all suites pass.

- [ ] **Step 7: Commit**

```bash
git add src/components/EmptyProjectState.tsx src/components/EmptyProjectState.test.tsx src/App.tsx
git commit -m "feat(empty-project): drop Switch project button; hint rail"
```

---

## Task 4: Delete `ProjectSwitcher` + final `App.tsx` cleanup

**Files:**
- Delete: `src/components/ProjectSwitcher.tsx`
- Delete: `src/components/ProjectSwitcher.test.tsx`
- Modify: `src/App.tsx` — remove the `ProjectSwitcher` import + state hook + render block

- [ ] **Step 1: Confirm there are no other callers**

Run: `grep -rn "ProjectSwitcher" src/ --include="*.tsx" --include="*.ts"`
Expected: matches only in `App.tsx` (import + state + render) and the two `ProjectSwitcher.*` files themselves. If any other file references it, stop and report — the spec assumes a single caller.

- [ ] **Step 2: Remove the `ProjectSwitcher` references in `App.tsx`**

In `src/App.tsx`:
1. Find and remove `import { ProjectSwitcher } from "./components/ProjectSwitcher";`.
2. Find and remove `const [showProjectSwitcher, setShowProjectSwitcher] = useState(false);`.
3. Find and remove the `{showProjectSwitcher && project && (<ProjectSwitcher … />)}` render block.
4. Find any remaining `setShowProjectSwitcher(true)` and `setShowProjectSwitcher(false)` calls — they should be zero after Tasks 1 + 3 (the header's `onOpenProjectSwitcher` setter and the EmptyProjectState's `onSwitchProject` setter were removed). If grep still finds any, remove them too.
5. Find and remove `loadRecentProjects()` calls that were ONLY there to populate the switcher list before opening it. Look for the pattern `loadRecentProjects(); setShowProjectSwitcher(true);` — both lines go.

- [ ] **Step 3: Delete the component files**

```bash
git rm src/components/ProjectSwitcher.tsx src/components/ProjectSwitcher.test.tsx
```

- [ ] **Step 4: Typecheck + full suite**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: clean.

Run: `npx vitest run 2>&1 | tail -5`
Expected: all suites pass. Test count drops by the previous `ProjectSwitcher.test.tsx` count.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat(rail): drop ProjectSwitcher modal (Rail covers project switching)"
```

---

## Task 5: Holistic review + visual verification

**Files:** none modified.

- [ ] **Step 1: Run the full backend + frontend suites**

```bash
npm run typecheck
npx vitest run
cd src-tauri && cargo build && cd ..
```

Expected: typecheck clean, all vitest pass, cargo build clean (backend untouched but worth confirming).

- [ ] **Step 2: Manual smoke test on a real workspace**

Build with `npm run tauri:build` (using the cache-busting recipe: `rm -rf src-tauri/target/release/bundle && touch src-tauri/src/lib.rs && npm run tauri:build`).

Launch and verify:
- Workspace with a Jira-keyed branch (e.g. `feat/CLPNSNS-92-foo`) → header shows `◈ CLPNSNS-92 · STATUS · summary` on the left; Companion no longer has the Active Ticket section.
- Workspace with a non-keyed branch (e.g. `main`) → header shows `WORKSPACE workspace-name` block; Companion no longer has the Active Ticket section.
- Workspace with `linkedIssueKey` set but the issue still loading on first paint → header briefly degrades to the workspace block (no error flash).
- Status color of the ticket varies with category: brass for In Progress, mute for To Do, verdigris for Done, sage for Unknown.
- Clicking the ticket area opens Jira in the browser.
- Hovering the ticket area shows the brass-ghost background.
- Tooltip on the ticket area shows `KEY · TYPE · PRIORITY · Epic: <…> · summary`.
- The Rail's project section header (or any other entry-point) is the only path to switch projects.
- `EmptyProjectState` (open a project with no workspaces) shows the `Create workspace` CTA + the mute footer line `Or pick another project from the rail`.

- [ ] **Step 3: Use `superpowers:finishing-a-development-branch` to ship**

Merge / PR per project convention, bump to the next patch version, release via `npm run release -- <version>` (signing key at `~/.octopush-keys/updater_key`).
