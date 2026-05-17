# Mini-Phase 3 — Mode Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close out the mode system with three pieces of polish: a sliding brass indicator in the `ModeSwitcher` instead of a static per-button background, restored canvas persistence so the xterm terminal doesn't lose state on every mode switch (regression introduced in Phase 2), and empty-state CTAs for Run/Review modes.

**Architecture:** Three small, independent tasks. The first is a self-contained component change. The second is a layout pattern: render all 3 canvas panes always, toggle visibility via `display: none` (same trick the old code used for multi-terminal preservation, scoped to mode). The third adds friendly empty states in the canvas.

**Tech stack:** Existing — React 19, Tailwind v4 with Onyx & Brass tokens, Spectral italic via Google Fonts.

---

## Spec reference

Source of truth: `docs/superpowers/specs/2026-05-16-octopus-ux-redesign-design.md` §5 (motion principles, ~280–320ms ease-in-out, brass marks the moment).

This mini-phase doesn't ship a new vision — it cleans up two known regressions and adds the lightest polish from the broader Phase 7 motion goals.

---

## File structure

**Modified**

- `src/components/ModeSwitcher.tsx` — replace per-button brass background with a single absolutely-positioned indicator that glides via CSS transform between mode positions.
- `src/components/ModeSwitcher.test.tsx` — update tests where they assert specific background classes (likely unchanged since the existing tests check `aria-pressed`, not visual state).
- `src/App.tsx` — render the 3 canvas panes (ChatView, TerminalPane, ChangesPanel) always when a workspace is active, and use `style={{ display: ... }}` for visibility. Add small empty-state CTAs for Run (no terminal session yet) and Review (no changes).

**No new files.**

---

## Tasks

### Task 1: ModeSwitcher gliding indicator

**Files:**
- Modify: `src/components/ModeSwitcher.tsx`

The current implementation gives each mode button its own conditional brass-ghost background when active. Replace with a single absolutely-positioned indicator that translates horizontally between mode positions on mode change.

- [ ] **Step 1: Read the current component**

Read `src/components/ModeSwitcher.tsx` to understand its current structure. The 3 buttons live inside a `<div role="group">` with `inline-flex items-center gap-1 ... p-1`.

- [ ] **Step 2: Replace the component implementation**

Replace the file contents with:

```tsx
import { clsx } from "clsx";
import { MODES, MODE_LABELS, MODE_SHORTCUTS, type WorkspaceMode } from "../lib/modes";

interface Props {
  mode: WorkspaceMode;
  onChange: (next: WorkspaceMode) => void;
}

export function ModeSwitcher({ mode, onChange }: Props) {
  const activeIndex = MODES.indexOf(mode);

  return (
    <div
      role="group"
      aria-label="Workspace mode"
      className="relative m-4 inline-flex items-center rounded-lg border border-octo-hairline bg-octo-panel p-1"
    >
      {/* Gliding brass indicator. Each button is the same width (set below);
          indicator translates by activeIndex * buttonWidth. */}
      <div
        aria-hidden
        className="absolute top-1 bottom-1 w-[68px] rounded-md transition-transform duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.3,1)]"
        style={{
          left: "4px",
          transform: `translateX(${activeIndex * 68}px)`,
          background: "var(--brass-ghost)",
          border: "1px solid var(--brass-dim)",
        }}
      />
      {MODES.map((m) => {
        const active = m === mode;
        return (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            aria-pressed={active}
            title={`${MODE_LABELS[m]} (${MODE_SHORTCUTS[m]})`}
            className={clsx(
              "relative z-10 w-[68px] rounded-md px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors",
              active ? "text-octo-brass" : "text-octo-mute hover:text-octo-sage",
            )}
          >
            {MODE_LABELS[m]}
          </button>
        );
      })}
    </div>
  );
}
```

Key changes:
- Removed `gap-1` — now buttons are flush against each other and the indicator covers exactly one button width
- Each button is fixed `w-[68px]` so the indicator math is predictable
- The indicator is `absolute`, `top-1 bottom-1 w-[68px]`, with `left: 4px` (matching `p-1` padding) and `transform: translateX(${activeIndex * 68}px)`
- Indicator uses `transition-transform duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.3,1)]` (spec's standard duration + easing)
- Buttons use `transition-colors` only — the indicator handles the glide
- Buttons have `z-10` so they render above the indicator

- [ ] **Step 3: Run the existing tests**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm test -- src/components/ModeSwitcher.test.tsx
```

Expected: 3/3 still pass. The tests check `aria-pressed` and that `onChange` fires — both still work.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/ModeSwitcher.tsx
git commit -m "feat: ModeSwitcher gliding brass indicator"
```

---

### Task 2: Persistent canvas panes (terminal regression fix + smooth mode swap)

**Files:**
- Modify: `src/App.tsx`

Phase 2's App.tsx renders the canvas panes conditionally (`{activeMode === "talk" && <ChatView />}`). When the mode changes, the non-active components unmount. For ChatView/ChangesPanel that's mostly fine (state lives in stores). For TerminalPane it's a regression: the xterm DOM instance is destroyed and re-created, losing visible output until new bytes arrive. The OLD WorkspaceBar code used `display: none` to keep terminals mounted.

We restore that pattern, and also wrap each pane in a CSS-transitioned wrapper for a 220ms fade. The canvas swap stops feeling instantaneous without making it feel slow.

- [ ] **Step 1: Read the current canvas section in App.tsx**

Locate the section that renders the canvas (currently around the comment "Render: workspace shell" or similar). It looks like:

```tsx
{!showCreator && activeMode === "talk" && (
  <ChatView ... />
)}
{!showCreator && activeMode === "run" && (
  <>
    {!activeTerminal?.sessionId && (
      <div className="flex h-full items-center justify-center text-sm text-octo-mute">
        Starting terminal...
      </div>
    )}
    {activeTerminal?.sessionId && (
      <TerminalPane ... />
    )}
  </>
)}
{!showCreator && activeMode === "review" && (
  <ChangesPanel projectPath={...} />
)}
```

- [ ] **Step 2: Replace with always-mounted panes**

Replace the conditional block with this layered version. All three panes mount when a workspace is active; only the matching one is visible:

```tsx
{!showCreator && (
  <>
    <div
      className="absolute inset-0 transition-opacity duration-200 ease-out"
      style={{
        opacity: activeMode === "talk" ? 1 : 0,
        pointerEvents: activeMode === "talk" ? "auto" : "none",
        visibility: activeMode === "talk" ? "visible" : "hidden",
      }}
    >
      <ChatView
        workspaceId={activeChatId!}
        workspacePath={activeWorkspace.worktreePath || project.path}
        onOpenSettings={() => setShowSettings(true)}
      />
    </div>

    <div
      className="absolute inset-0 transition-opacity duration-200 ease-out"
      style={{
        opacity: activeMode === "run" ? 1 : 0,
        pointerEvents: activeMode === "run" ? "auto" : "none",
        visibility: activeMode === "run" ? "visible" : "hidden",
      }}
    >
      {activeTerminal?.sessionId ? (
        <TerminalPane
          sessionId={activeTerminal.sessionId}
          visible={activeMode === "run"}
          layoutVersion={layoutVersion}
        />
      ) : (
        <RunEmptyState onStart={ensureTerminal} />
      )}
    </div>

    <div
      className="absolute inset-0 transition-opacity duration-200 ease-out"
      style={{
        opacity: activeMode === "review" ? 1 : 0,
        pointerEvents: activeMode === "review" ? "auto" : "none",
        visibility: activeMode === "review" ? "visible" : "hidden",
      }}
    >
      <ChangesPanel projectPath={activeWorkspace.worktreePath || project.path} />
    </div>
  </>
)}
```

The wrapper containing this block must already be `position: relative` so the `absolute inset-0` panes fill it. The current code has `<div className="relative min-w-0 flex-1 overflow-hidden">` as the parent — verify and adjust if needed.

The new `RunEmptyState` component is defined inline at the bottom of `App.tsx` (see Step 3). It replaces the bare "Starting terminal..." text with a friendlier CTA.

**Important:** the `visibility` toggle is critical alongside `opacity`. With opacity 0 the element is still in the tab order and receives clicks. `visibility: hidden` removes it from accessibility tree and pointer events. With `pointerEvents: "none"` we get the same for clicks even before visibility kicks in.

- [ ] **Step 3: Add the `RunEmptyState` helper component**

At the very bottom of `src/App.tsx`, just above `export default App;`, add:

```tsx
function RunEmptyState({ onStart }: { onStart: () => Promise<void> | void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-mute">
        Run
      </div>
      <div className="font-serif italic text-[20px] leading-tight tracking-[-0.005em] text-octo-ivory">
        Start a new terminal.
      </div>
      <p className="max-w-md text-[12px] leading-[1.6] text-octo-sage">
        A terminal opens in the workspace's worktree directory. You can keep multiple terminals open and switch via the Companion panel.
      </p>
      <button
        type="button"
        onClick={() => onStart()}
        className="mt-2 rounded-md px-4 py-2 font-serif italic text-[13px] text-octo-brass transition"
        style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
      >
        Open terminal
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Verify `ensureTerminal` is accessible to `RunEmptyState`**

`ensureTerminal` is already declared inside the `App` function via `useCallback`. Pass it down as the `onStart` prop. The JSX in Step 2 already references `<RunEmptyState onStart={ensureTerminal} />`, so just make sure `ensureTerminal` exists in scope where `RunEmptyState` is invoked (it does, inside the `App` function body).

- [ ] **Step 5: Run typecheck and tests**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm run typecheck
npm test
```

Expected: clean + all tests pass. There's no App.tsx-specific test, but the broader suite should still pass since component contracts are unchanged.

- [ ] **Step 6: Boot the dev server**

```bash
timeout 25 npm run dev 2>&1 | head -30
```

Confirm Vite ready, no errors.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "fix: persist canvas panes across mode switch (terminal regression) + opacity fade"
```

---

### Task 3: Review mode empty state

**Files:**
- Modify: `src/App.tsx` (small addition — inline empty state for review mode)
- OR Modify: `src/components/ChangesPanel.tsx` (if a deeper empty state is desired)

The Review mode renders `<ChangesPanel>`. If the workspace has no unstaged changes, ChangesPanel may show nothing visually. We add a friendly empty state that says "No changes to review yet" when there's no diff. The simplest way is to gate the render in App.tsx based on `gitStatus.changedFiles.length`.

- [ ] **Step 1: Adapt the Review pane to show an empty state**

In `src/App.tsx`, find the Review pane wrapper from Task 2 (the third `<div ...>` containing `<ChangesPanel>`). Modify the inside so the panel renders only when there ARE changes:

```tsx
<div
  className="absolute inset-0 transition-opacity duration-200 ease-out"
  style={{
    opacity: activeMode === "review" ? 1 : 0,
    pointerEvents: activeMode === "review" ? "auto" : "none",
    visibility: activeMode === "review" ? "visible" : "hidden",
  }}
>
  {(gitStatus?.changedFiles.length ?? 0) > 0 ? (
    <ChangesPanel projectPath={activeWorkspace.worktreePath || project.path} />
  ) : (
    <ReviewEmptyState />
  )}
</div>
```

- [ ] **Step 2: Add the `ReviewEmptyState` helper**

At the bottom of `src/App.tsx`, near `RunEmptyState`, add:

```tsx
function ReviewEmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-mute">
        Review
      </div>
      <div className="font-serif italic text-[20px] leading-tight tracking-[-0.005em] text-octo-ivory">
        Nothing to review yet.
      </div>
      <p className="max-w-md text-[12px] leading-[1.6] text-octo-sage">
        When the workspace has uncommitted changes, the diff appears here.
      </p>
      <div
        aria-hidden
        className="mt-2 h-px w-7"
        style={{ background: "linear-gradient(90deg, var(--color-octo-brass), transparent)" }}
      />
    </div>
  );
}
```

The little brass-rule decoration at the bottom is a small signature moment (the "brass rule" pattern from §5.2 of the spec — used here statically, no growth animation yet).

- [ ] **Step 3: Run typecheck and tests**

```bash
npm run typecheck
npm test
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat: empty states for Run + Review modes"
```

---

### Task 4: End-to-end verification

**Files:** none

- [ ] **Step 1: Run all tests**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm run typecheck && npm test
cd src-tauri && cargo test
```

Expected: all green.

- [ ] **Step 2: Boot dev server**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
timeout 25 npm run dev 2>&1 | head -30
```

Expected: ready in <2s, no errors.

- [ ] **Step 3: Note for user (no commit unless a fix was required)**

User will visually verify by booting `npm run tauri:dev`:
- Mode pills: the brass indicator slides between Talk/Run/Review (~280ms ease)
- Mode swap: canvas fades briefly (~200ms) between panes
- Terminal: switch away to Talk, scroll up in terminal output, come back to Run — output persists (terminal didn't remount)
- Run mode with no terminal: shows "Start a new terminal." with brass CTA
- Review mode with no changes: shows "Nothing to review yet." with little brass rule

---

## Self-review notes

**Spec coverage:**
- Mode polish from §5.2 (mode glide) — Task 1 ✓
- Empty states for Run/Review (informal — closes a UX gap) — Task 3 ✓
- Canvas persistence (regression fix introduced by Phase 2's conditional render) — Task 2 ✓

**Risks:**
- Always-mounting the 3 canvas panes means a fresh workspace with no terminal session still spawns `ChatView` AND `ChangesPanel` immediately. ChangesPanel does a `getGitStatus` ipc call on mount — slightly more eager than before. Acceptable; status was already being fetched in `App.tsx`'s `gitStatus` effect.
- ChatView and ChangesPanel keep React state alive when not visible. For long sessions this means a small memory footprint per workspace. Worth monitoring but trivial vs. xterm preservation.
- The gliding indicator math assumes 3 buttons of fixed 68px width. If `MODE_LABELS` are translated or longer strings are added later, the width may need adjustment. Add a one-line comment near the constant.

**Total commits:** 3 implementation + 1 verification = 3 commits to ship.
