# Phase 5 — Entry Flows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the three "entry" surfaces (Welcome screen, New Project flow, Workspace creator) with ceremonial Atelier-in-Onyx-&-Brass wizards. The current screens are functional but feel like generic dev-tool setup dialogs — the user explicitly called out the onboarding flow as "demasiado parecido a Superset". After this phase, the first contact with the app is unmistakably Octopus: brass ampersand, italic-serif phrases, roman numerals, brass-rule decorations.

**Architecture:** Each of the three components is rewritten end-to-end (full file replacement) using Phase 1 design tokens (Onyx & Brass palette, Spectral italic display, system sans body, JetBrains Mono meta) and Phase 4 design patterns (italic-serif headlines, brass-rule decoration, monogram glyphs, mono uppercase eyebrows). The business logic and props contracts are preserved — only the JSX and styling change. The two wizards (`NewProjectFlow`, `WorkspaceCreator`) adopt a 2-pane layout: left index with step numerals in brass mono, right pane with the current step's content.

**Tech stack:** React 19, Tailwind v4 + design tokens, Spectral italic via Google Fonts (Phase 1), existing project/workspace Zustand stores.

---

## Spec reference

Source of truth: `docs/superpowers/specs/2026-05-16-octopus-ux-redesign-design.md` §4.1 (Welcome), §4.2 (New Project flow), §4.6 (New Workspace flow), §6 (signature moments — ampersand, roman numerals, italic-serif CTAs, brass rule).

Cheatsheet: `docs/design-system.md` — component recipes used below.

---

## File structure

**Modified (full rewrite, contracts preserved)**

| Path | Why |
|------|-----|
| `src/components/WelcomeScreen.tsx` | Replace plain "Open / New / Recent" layout with brass-mark + italic-serif "Octopus & you" + ceremonial CTA + recent-projects list with brass monograms. |
| `src/components/NewProjectFlow.tsx` | Replace single-form layout with a 2-pane wizard: left index (`I. Name & path`, `II. Type`), right pane with current-step content. Italic-serif question per step. Roman numeral step indicator. Brass-rule decoration. |
| `src/components/WorkspaceCreator.tsx` | Same 2-pane wizard pattern with 2 steps: `I. Task & intent`, `II. Setup script`. Preserve the existing data flow (task → branch slug → `create(projectId, …, "main", setupScript)`). |

**No new files.** No type changes. No store changes. Existing onClick/onCreated/onCancel prop contracts unchanged.

**Not touched in Phase 5**

- `WelcomeScreen`'s drag-and-drop file handler — kept as-is (it's data flow, not presentation).
- `WorkspaceCreator` currently hard-codes `fromBranch = "main"`. Making this selectable is out of scope; deferred to a possible future phase or to user request.
- The optional 3rd "Open with…" step from the spec mockup. Out of scope — the underlying API only takes task/setupScript/branch; adding a third step requires either a new field or a dummy step. Defer.
- Animation polish (brass-rule grow on entry, fade-in cascade). The static brass-rule decoration lands here; the grow animation is Phase 7 motion polish.

---

## Design patterns (used across all 3 components)

These are the visual primitives all three screens share. Code in each task copies these patterns rather than extracting helpers — they're 5-line snippets and DRYing them would create over-abstraction for three call sites.

### Eyebrow label (mono brass uppercase)
```tsx
<div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
  STEP I · OF II
</div>
```

### Italic-serif headline
```tsx
<h1 className="mt-3 font-serif italic text-[28px] leading-[1.05] tracking-[-0.01em] text-octo-ivory">
  Name your new study.
</h1>
```

### Descriptive paragraph (sage body)
```tsx
<p className="mt-3 max-w-[44ch] text-[13px] leading-[1.6] text-octo-sage">
  A project is the home for your codebase. Each project can hold many workspaces.
</p>
```

### Brass rule decoration (static — animation in Phase 7)
```tsx
<div
  aria-hidden
  className="my-5 h-px w-7"
  style={{ background: "linear-gradient(90deg, var(--color-octo-brass), transparent)" }}
/>
```

### Primary CTA (italic serif on brass ghost)
```tsx
<button
  type="button"
  onClick={handle}
  className="rounded-md px-4 py-2 font-serif italic text-[13px] text-octo-brass"
  style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
>
  Continue
</button>
```

### Ghost / secondary button (sans, hairline border)
```tsx
<button
  type="button"
  onClick={cancel}
  className="rounded-md px-3 py-2 text-[12px] text-octo-mute hover:text-octo-sage"
>
  Cancel
</button>
```

### Field (input with italic-serif placeholder)
```tsx
<label className="block">
  <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute mb-2">
    PROJECT NAME
  </div>
  <input
    autoFocus
    value={value}
    onChange={(e) => setValue(e.target.value)}
    placeholder="Hyperion"
    className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-sans text-[14px] text-octo-ivory outline-none placeholder:font-serif placeholder:italic placeholder:text-octo-mute focus:border-octo-brass"
  />
</label>
```

### 2-pane wizard shell
```tsx
<div className="flex h-full w-full bg-octo-bg" data-tauri-drag-region>
  <aside className="w-[220px] shrink-0 border-r border-octo-hairline bg-octo-panel px-6 py-10">
    {/* Step index */}
  </aside>
  <main className="flex flex-1 flex-col justify-center px-12 py-10">
    {/* Current step content */}
  </main>
</div>
```

### Step index row (left pane)
```tsx
<div className="flex items-baseline gap-3 py-2">
  <span className="w-6 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-brass">
    II
  </span>
  <span className={active
    ? "font-serif italic text-[15px] text-octo-ivory"
    : "font-sans text-[12px] text-octo-mute"}
  >
    Branch from…
  </span>
</div>
```

---

## Tasks

### Task 1: WelcomeScreen redesign

**Files:** Modify `src/components/WelcomeScreen.tsx` (full rewrite).

**Goal:** Replace the current drop-zone-with-recent-list with the ceremonial Welcome from the spec §4.1: brass `O` mark, italic-serif "Octopus & you" with brass ampersand, mono subtitle, brass-rule decoration, ceremonial CTA, recent projects with brass monograms.

The component's existing props contract is `onNewProject: () => void`. The data flow uses `useProjectStore` (`open`, `loadRecent`, `recent`, `loading`, `error`). The drag-and-drop handlers keep working.

- [ ] **Step 1: Read the current file**

Read `src/components/WelcomeScreen.tsx`. Note: existing data flow (loadRecent on mount, open via path, drag-and-drop file path detection, error display). Preserve all of it.

- [ ] **Step 2: Replace the file**

Use Write to fully replace `src/components/WelcomeScreen.tsx` with the new ceremonial version. Below is the complete new file content. Copy verbatim — the design tokens, the brass `O` mark, the italic-serif logo with the brass ampersand, the recent-projects list with brass monograms, and the keyboard/drop handlers are all wired exactly:

```tsx
import { useEffect, useState } from "react";
import { useProjectStore } from "../stores/projectStore";
import type { ProjectInfo } from "../lib/types";

interface Props {
  onNewProject: () => void;
}

export function WelcomeScreen({ onNewProject }: Props) {
  const { open, loadRecent, recent, loading, error } = useProjectStore();
  const [showPathInput, setShowPathInput] = useState(false);
  const [pathValue, setPathValue] = useState("");
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  function handleOpenClick() {
    setShowPathInput(true);
    setPathValue("");
  }

  function handleConfirmPath() {
    const trimmed = pathValue.trim();
    if (!trimmed) return;
    open(trimmed);
  }

  function handlePathKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleConfirmPath();
    if (e.key === "Escape") {
      setShowPathInput(false);
      setPathValue("");
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave() {
    setDragOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const items = Array.from(e.dataTransfer.items);
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          const path = (file as File & { path?: string }).path;
          if (path) {
            open(path);
            return;
          }
        }
      }
    }
    setShowPathInput(true);
  }

  return (
    <div
      data-tauri-drag-region
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="relative flex h-full w-full flex-col items-center justify-center bg-octo-bg px-6"
      style={{
        background:
          "radial-gradient(ellipse at center top, rgba(212,165,116,0.06), transparent 55%), var(--color-octo-onyx)",
      }}
    >
      {/* Mark */}
      <div
        aria-hidden
        className="relative flex h-14 w-14 items-center justify-center rounded-full font-serif italic text-[26px] text-octo-brass"
        style={{ border: "1px solid var(--brass-dim)" }}
      >
        O
        <span
          className="absolute -inset-2 rounded-full"
          style={{ border: "1px solid rgba(212, 165, 116, 0.15)" }}
        />
      </div>

      {/* Logo */}
      <h1 className="mt-6 font-serif italic text-[32px] leading-[1.05] tracking-[-0.01em] text-octo-ivory">
        Octopus<span className="px-1.5 text-octo-brass">&amp;</span>you
      </h1>

      {/* Tagline */}
      <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.35em] text-octo-mute">
        eight arms · one mind
      </div>

      {/* Brass rule */}
      <div
        aria-hidden
        className="my-6 h-px w-7"
        style={{ background: "linear-gradient(90deg, var(--color-octo-brass), transparent)" }}
      />

      {/* Primary CTA */}
      <button
        type="button"
        onClick={onNewProject}
        className="rounded-md px-5 py-2.5 font-serif italic text-[14px] text-octo-brass transition"
        style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
      >
        Begin a new study
      </button>

      {/* Or — open existing */}
      <div className="mt-4 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">
        or
      </div>

      {/* Drop / open path */}
      {!showPathInput ? (
        <div className="mt-3 text-center text-[12px] leading-[1.6] text-octo-sage">
          <span>Drop a folder, or </span>
          <button
            type="button"
            onClick={handleOpenClick}
            className="font-serif italic text-octo-ivory underline decoration-octo-brass/40 underline-offset-2 hover:decoration-octo-brass"
          >
            open one from disk
          </button>
        </div>
      ) : (
        <div className="mt-3 flex w-72 items-center gap-2">
          <input
            autoFocus
            value={pathValue}
            onChange={(e) => setPathValue(e.target.value)}
            onKeyDown={handlePathKeyDown}
            placeholder="/path/to/project"
            className="min-w-0 flex-1 rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
          />
          <button
            type="button"
            onClick={handleConfirmPath}
            disabled={!pathValue.trim() || loading}
            className="rounded-md px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-brass disabled:opacity-40"
            style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
          >
            Open
          </button>
          <button
            type="button"
            onClick={() => { setShowPathInput(false); setPathValue(""); }}
            className="px-2 py-2 text-[12px] text-octo-mute hover:text-octo-sage"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          className="mt-4 max-w-md rounded-md px-3 py-2 text-[12px] text-octo-rouge"
          style={{ borderLeft: "1px solid var(--color-octo-rouge)", background: "rgba(209, 139, 139, 0.08)" }}
        >
          {error}
        </div>
      )}

      {/* Dropzone hint when dragging */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-8 rounded-2xl"
          style={{ border: "1px dashed var(--brass-dim)", background: "rgba(212, 165, 116, 0.04)" }}
        />
      )}

      {/* Recent projects */}
      {recent.length > 0 && (
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2">
          <div className="mb-3 text-center font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">
            Recent
          </div>
          <ul className="flex items-stretch gap-3">
            {recent.slice(0, 5).map((project: ProjectInfo) => (
              <li key={project.id}>
                <button
                  type="button"
                  onClick={() => open(project.path)}
                  className="flex items-center gap-2.5 rounded-md px-3 py-2 transition hover:bg-octo-panel"
                  title={project.path}
                >
                  <span
                    className="flex h-7 w-7 items-center justify-center rounded-md font-serif italic text-[14px] text-octo-brass"
                    style={{
                      background: "var(--brass-ghost)",
                      border: "1px solid var(--brass-dim)",
                    }}
                  >
                    {project.name.charAt(0).toUpperCase() || "?"}
                  </span>
                  <span className="font-serif italic text-[13px] text-octo-ivory">
                    {project.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

Key changes vs. the old Welcome:
- Brass `O` mark with a double-ring decoration (the inner border is `--brass-dim`, the outer ring is 15% brass — gives the mark a planetary feel).
- `Octopus & you` in 32px italic serif with the ampersand alone in brass (the signature `&` moment).
- "eight arms · one mind" mono uppercase tagline.
- Brass-rule divider (28px gradient brass → transparent).
- Ceremonial CTA "Begin a new study" in italic serif brass on brass-ghost.
- "or — Drop a folder, or open one from disk" with the inline "open one from disk" as a tasteful italic-serif underlined link.
- Recent projects as a horizontal strip at the bottom, each with a brass monogram + italic-serif project name.
- Error block uses rouge left border (matches ChatView's ErrorBlock from Phase 4).
- Drag-over state: a brass-dim dashed border overlay around the entire screen.

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm run typecheck
```

Expected: clean.

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: all 64 tests still pass. (No WelcomeScreen test exists; nothing should regress.)

- [ ] **Step 5: Commit**

```bash
git add src/components/WelcomeScreen.tsx
git commit -m "feat: ceremonial Welcome — brass mark + italic-serif 'Octopus & you'"
```

---

### Task 2: NewProjectFlow redesign

**Files:** Modify `src/components/NewProjectFlow.tsx` (full rewrite).

**Goal:** 2-pane wizard with roman numerals (I. Name, II. Type). Italic-serif question per step. Brass-rule decoration. Preserve the existing data flow (`useProjectStore.create(location, name)`).

The existing component lets the user pick a location, a project type, and a repo name, then calls `create(location, repoName)`. The "Clone" and "Template" types are visible but disabled. We keep the data shape identical.

For the wizard split:
- **Step I — Name & path**: project repo name (autoFocused) + location.
- **Step II — Type**: the three type cards. "Empty" is the only enabled option. The Create button lives here.

- [ ] **Step 1: Read the current file**

`src/components/NewProjectFlow.tsx` — review the existing props (`onBack`), state (`location`, `repoName`, `projectType`), and the `useProjectStore.create` call signature.

- [ ] **Step 2: Replace the file**

Overwrite `src/components/NewProjectFlow.tsx` with:

```tsx
import { useState } from "react";
import { useProjectStore } from "../stores/projectStore";

interface Props {
  onBack: () => void;
}

type ProjectType = "empty" | "clone" | "template";
type Step = 1 | 2;

export function NewProjectFlow({ onBack }: Props) {
  const { create, loading, error } = useProjectStore();
  const [step, setStep] = useState<Step>(1);
  const [location, setLocation] = useState("~/.octopus-sh/projects");
  const [repoName, setRepoName] = useState("");
  const [projectType, setProjectType] = useState<ProjectType>("empty");

  const nameValid = repoName.trim().length > 0;

  async function handleCreate() {
    const trimmedLocation = location.trim();
    const trimmedName = repoName.trim();
    if (!trimmedName) return;
    await create(trimmedLocation, trimmedName);
  }

  function handleStep1KeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && nameValid) setStep(2);
  }

  return (
    <div
      data-tauri-drag-region
      className="flex h-full w-full bg-octo-bg"
      style={{
        background:
          "radial-gradient(ellipse at 30% 25%, rgba(212,165,116,0.05), transparent 50%), var(--color-octo-onyx)",
      }}
    >
      {/* Left index pane */}
      <aside className="w-[220px] shrink-0 border-r border-octo-hairline bg-octo-panel px-6 py-10">
        <button
          type="button"
          onClick={onBack}
          className="mb-10 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute hover:text-octo-sage"
        >
          ← Back
        </button>

        <div className="font-serif italic text-[18px] text-octo-ivory">
          A new project
        </div>

        <div className="mt-6 space-y-1">
          <StepIndex active={step === 1} numeral="I" label="Name & path" onClick={() => setStep(1)} />
          <StepIndex active={step === 2} numeral="II" label="Type" onClick={() => nameValid && setStep(2)} disabled={!nameValid && step !== 2} />
        </div>

        <div
          aria-hidden
          className="mt-10 h-px w-7"
          style={{ background: "linear-gradient(90deg, var(--color-octo-brass), transparent)" }}
        />
      </aside>

      {/* Right content pane */}
      <main className="flex flex-1 flex-col justify-center px-14 py-10">
        {step === 1 ? (
          <>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
              STEP I · OF II
            </div>
            <h1 className="mt-3 font-serif italic text-[26px] leading-[1.05] tracking-[-0.005em] text-octo-ivory">
              Name your new study.
            </h1>
            <p className="mt-3 max-w-[48ch] text-[13px] leading-[1.6] text-octo-sage">
              A project is the home for your codebase. Each project can hold many workspaces — one per branch you're working on.
            </p>

            <div className="mt-8 max-w-[520px] space-y-5">
              <Field label="PROJECT NAME">
                <input
                  autoFocus
                  value={repoName}
                  onChange={(e) => setRepoName(e.target.value)}
                  onKeyDown={handleStep1KeyDown}
                  placeholder="Hyperion"
                  className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-sans text-[14px] text-octo-ivory outline-none placeholder:font-serif placeholder:italic placeholder:text-octo-mute focus:border-octo-brass"
                />
              </Field>

              <Field label="LOCATION">
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="~/.octopus-sh/projects"
                  className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
                />
              </Field>
            </div>

            <div className="mt-10 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setStep(2)}
                disabled={!nameValid}
                className="rounded-md px-4 py-2 font-serif italic text-[13px] text-octo-brass transition disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
              >
                Continue
              </button>
              <button
                type="button"
                onClick={onBack}
                className="rounded-md px-3 py-2 text-[12px] text-octo-mute hover:text-octo-sage"
              >
                Cancel
              </button>
              <div className="ml-auto font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
                ↵ to continue
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
              STEP II · OF II
            </div>
            <h1 className="mt-3 font-serif italic text-[26px] leading-[1.05] tracking-[-0.005em] text-octo-ivory">
              Where does it begin?
            </h1>
            <p className="mt-3 max-w-[48ch] text-[13px] leading-[1.6] text-octo-sage">
              Start with an empty repository, clone an existing one, or scaffold from a template. Only "Empty" is available today.
            </p>

            <div className="mt-8 grid max-w-[640px] grid-cols-3 gap-3">
              <TypeCard
                glyph="∅"
                label="Empty"
                description="A fresh git repository."
                selected={projectType === "empty"}
                disabled={false}
                onClick={() => setProjectType("empty")}
              />
              <TypeCard
                glyph="⎘"
                label="Clone"
                description="From a remote URL."
                selected={projectType === "clone"}
                disabled
                onClick={() => setProjectType("clone")}
              />
              <TypeCard
                glyph="❦"
                label="Template"
                description="Coming soon."
                selected={projectType === "template"}
                disabled
                onClick={() => setProjectType("template")}
              />
            </div>

            {error && (
              <div
                className="mt-6 max-w-[520px] rounded-md px-3 py-2 text-[12px] text-octo-rouge"
                style={{ borderLeft: "1px solid var(--color-octo-rouge)", background: "rgba(209, 139, 139, 0.08)" }}
              >
                {error}
              </div>
            )}

            <div className="mt-10 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="rounded-md px-3 py-2 text-[12px] text-octo-mute hover:text-octo-sage"
              >
                ← Back
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={!nameValid || loading || projectType !== "empty"}
                className="rounded-md px-4 py-2 font-serif italic text-[13px] text-octo-brass transition disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
              >
                {loading ? "Creating…" : "Bring it to life"}
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function StepIndex({
  active,
  numeral,
  label,
  onClick,
  disabled = false,
}: {
  active: boolean;
  numeral: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-baseline gap-3 py-1.5 text-left disabled:cursor-not-allowed"
    >
      <span
        className={`w-6 font-mono text-[10px] uppercase tracking-[0.2em] ${
          active ? "text-octo-brass" : "text-octo-mute"
        }`}
      >
        {numeral}
      </span>
      <span
        className={
          active
            ? "font-serif italic text-[14px] text-octo-ivory"
            : "font-sans text-[12px] text-octo-mute"
        }
      >
        {label}
      </span>
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">
        {label}
      </div>
      {children}
    </label>
  );
}

function TypeCard({
  glyph,
  label,
  description,
  selected,
  disabled,
  onClick,
}: {
  glyph: string;
  label: string;
  description: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex flex-col items-start gap-3 rounded-md p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        border: selected ? "1px solid var(--brass-dim)" : "1px solid var(--color-octo-hairline)",
        background: selected ? "var(--brass-ghost)" : "transparent",
      }}
    >
      <span
        className="font-serif italic text-[20px]"
        style={{ color: selected ? "var(--color-octo-brass)" : "var(--color-octo-sage)" }}
      >
        {glyph}
      </span>
      <div>
        <div
          className="font-mono text-[10px] uppercase tracking-[0.2em]"
          style={{ color: selected ? "var(--color-octo-brass)" : "var(--color-octo-ivory)" }}
        >
          {label}
        </div>
        <div className="mt-1 font-serif italic text-[12px] text-octo-sage">
          {description}
        </div>
      </div>
    </button>
  );
}
```

Key changes vs. the old NewProjectFlow:
- 2-pane wizard layout (left 220px index, right content).
- Roman numeral step indicator in left pane (clickable, but step 2 requires a valid name).
- Italic-serif questions ("Name your new study.", "Where does it begin?").
- Sage descriptive paragraphs.
- Type cards redesigned: italic-serif unicode glyph (`∅` for empty, `⎘` for clone, `❦` for template) + mono uppercase label + italic-serif description. Brass-dim border + brass-ghost background on selected.
- "Bring it to life" italic-serif CTA on Step 2 (replaces "Create").
- Brass-rule decoration at the bottom of the left pane.
- Lucide icons removed entirely — replaced by unicode glyphs in italic serif.

- [ ] **Step 3: Typecheck and tests**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm run typecheck
npm test
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/NewProjectFlow.tsx
git commit -m "feat: NewProjectFlow as 2-pane ceremonial wizard with roman numerals"
```

---

### Task 3: WorkspaceCreator redesign

**Files:** Modify `src/components/WorkspaceCreator.tsx` (full rewrite).

**Goal:** 2-pane wizard pattern matching NewProjectFlow. Two steps: `I. Task & intent` (task input → branch slug preview), `II. Setup script`. Preserves the existing data flow (`create(projectId, projectPath, name, task, branch, "main", setupScript)`).

- [ ] **Step 1: Read the current file**

`src/components/WorkspaceCreator.tsx` — note the props (`projectId, projectPath, onCreated, onCancel`), state (`step`, `task`, `setupScript`, `creating`, `error`), and the `useWorkspaceStore.create(...)` signature.

- [ ] **Step 2: Replace the file**

Overwrite `src/components/WorkspaceCreator.tsx` with:

```tsx
import { useState } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";

interface Props {
  projectId: string;
  projectPath: string;
  onCreated: () => void;
  onCancel: () => void;
}

type Step = 1 | 2;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function WorkspaceCreator({ projectId, projectPath, onCreated, onCancel }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [task, setTask] = useState("");
  const [setupScript, setSetupScript] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useWorkspaceStore((s) => s.create);

  const branch = slugify(task) || "new-workspace";
  const workspaceName = branch;
  const taskValid = task.trim().length > 0;

  async function handleCreate() {
    if (!taskValid) return;
    setCreating(true);
    setError(null);
    try {
      await create(projectId, projectPath, workspaceName, task.trim(), branch, "main", setupScript);
      onCreated();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div
      data-tauri-drag-region
      className="flex h-full w-full bg-octo-bg"
      style={{
        background:
          "radial-gradient(ellipse at 30% 25%, rgba(212,165,116,0.05), transparent 50%), var(--color-octo-onyx)",
      }}
    >
      {/* Left index pane */}
      <aside className="w-[220px] shrink-0 border-r border-octo-hairline bg-octo-panel px-6 py-10">
        <button
          type="button"
          onClick={onCancel}
          className="mb-10 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute hover:text-octo-sage"
        >
          ← Back
        </button>

        <div className="font-serif italic text-[18px] text-octo-ivory">
          A new workspace
        </div>

        <div className="mt-6 space-y-1">
          <StepIndex active={step === 1} numeral="I" label="Task & intent" onClick={() => setStep(1)} />
          <StepIndex
            active={step === 2}
            numeral="II"
            label="Setup script"
            onClick={() => taskValid && setStep(2)}
            disabled={!taskValid && step !== 2}
          />
        </div>

        <div
          aria-hidden
          className="mt-10 h-px w-7"
          style={{ background: "linear-gradient(90deg, var(--color-octo-brass), transparent)" }}
        />
      </aside>

      {/* Right content pane */}
      <main className="flex flex-1 flex-col justify-center px-14 py-10">
        {step === 1 ? (
          <>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
              STEP I · OF II
            </div>
            <h1 className="mt-3 font-serif italic text-[26px] leading-[1.05] tracking-[-0.005em] text-octo-ivory">
              What are you setting out to do?
            </h1>
            <p className="mt-3 max-w-[48ch] text-[13px] leading-[1.6] text-octo-sage">
              A workspace is an isolated task environment backed by a git worktree. The task name becomes the branch.
            </p>

            <div className="mt-8 max-w-[520px]">
              <Field label="TASK">
                <input
                  autoFocus
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && taskValid) setStep(2);
                  }}
                  placeholder="e.g. Add dark mode, Fix checkout bug"
                  className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-sans text-[14px] text-octo-ivory outline-none placeholder:font-serif placeholder:italic placeholder:text-octo-mute focus:border-octo-brass"
                />
              </Field>

              {/* Branch preview */}
              <div className="mt-4 flex items-baseline gap-2 font-mono text-[10px] uppercase tracking-[0.2em]">
                <span className="text-octo-mute">BRANCH</span>
                <span className="text-octo-brass">{branch}</span>
                <span className="text-octo-mute">from</span>
                <span className="text-octo-sage">main</span>
              </div>
            </div>

            <div className="mt-10 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setStep(2)}
                disabled={!taskValid}
                className="rounded-md px-4 py-2 font-serif italic text-[13px] text-octo-brass transition disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
              >
                Continue
              </button>
              <button
                type="button"
                onClick={onCancel}
                className="rounded-md px-3 py-2 text-[12px] text-octo-mute hover:text-octo-sage"
              >
                Cancel
              </button>
              <div className="ml-auto font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
                ↵ to continue
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
              STEP II · OF II
            </div>
            <h1 className="mt-3 font-serif italic text-[26px] leading-[1.05] tracking-[-0.005em] text-octo-ivory">
              How does it start?
            </h1>
            <p className="mt-3 max-w-[48ch] text-[13px] leading-[1.6] text-octo-sage">
              These commands run automatically when the workspace is created. Leave empty to skip.
            </p>

            <div className="mt-8 max-w-[640px]">
              <Field label="SETUP SCRIPT">
                <textarea
                  value={setupScript}
                  onChange={(e) => setSetupScript(e.target.value)}
                  placeholder="npm install"
                  rows={6}
                  className="w-full resize-y rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] leading-[1.6] text-octo-ivory outline-none placeholder:font-mono placeholder:not-italic placeholder:text-octo-mute focus:border-octo-brass"
                />
              </Field>

              <div className="mt-2 font-mono text-[10px] tracking-[0.05em] text-octo-mute">
                Runs inside the new worktree at <span className="text-octo-sage">{projectPath}/.octopus/{branch}</span>.
              </div>
            </div>

            {error && (
              <div
                className="mt-6 max-w-[520px] rounded-md px-3 py-2 text-[12px] text-octo-rouge"
                style={{ borderLeft: "1px solid var(--color-octo-rouge)", background: "rgba(209, 139, 139, 0.08)" }}
              >
                {error}
              </div>
            )}

            <div className="mt-10 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="rounded-md px-3 py-2 text-[12px] text-octo-mute hover:text-octo-sage"
              >
                ← Back
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={!taskValid || creating}
                className="rounded-md px-4 py-2 font-serif italic text-[13px] text-octo-brass transition disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
              >
                {creating ? "Creating…" : "Begin"}
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={creating}
                className="rounded-md px-3 py-2 text-[12px] text-octo-mute hover:text-octo-sage"
                title="Skip the setup script"
              >
                Skip & begin
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function StepIndex({
  active,
  numeral,
  label,
  onClick,
  disabled = false,
}: {
  active: boolean;
  numeral: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-baseline gap-3 py-1.5 text-left disabled:cursor-not-allowed"
    >
      <span
        className={`w-6 font-mono text-[10px] uppercase tracking-[0.2em] ${
          active ? "text-octo-brass" : "text-octo-mute"
        }`}
      >
        {numeral}
      </span>
      <span
        className={
          active
            ? "font-serif italic text-[14px] text-octo-ivory"
            : "font-sans text-[12px] text-octo-mute"
        }
      >
        {label}
      </span>
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">
        {label}
      </div>
      {children}
    </label>
  );
}
```

Key changes vs. the old WorkspaceCreator:
- 2-pane wizard layout matching NewProjectFlow.
- Italic-serif questions ("What are you setting out to do?", "How does it start?").
- Branch preview line ("BRANCH auth-refactor from main" in mono brass/sage) under the task input.
- Setup script field is a 6-row monospace textarea (still preserves the data flow).
- Path hint ("Runs inside the new worktree at …") in mono sage.
- "Begin" italic-serif CTA + ghost "Skip & begin" (functionally same as "Skip for now" → "Create workspace" + skip — both call `handleCreate`).
- All lucide-react icons removed.

- [ ] **Step 3: Typecheck and tests**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm run typecheck
npm test
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/WorkspaceCreator.tsx
git commit -m "feat: WorkspaceCreator as 2-pane ceremonial wizard"
```

---

### Task 4: E2E verification

**Files:** none — verification only.

- [ ] **Step 1: Full test sweep**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm run typecheck && npm test
cd src-tauri && cargo test 2>&1 | grep "test result.*passed" | head -3
```

Expected: typecheck clean, 64+ frontend tests pass, 39 Rust tests pass.

- [ ] **Step 2: Boot dev server briefly**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm run dev 2>&1 | head -10
```

Expected: Vite ready in <2s, no errors.

- [ ] **Step 3: Visual verification (user)**

User will boot `npm run tauri:dev` (or build) and inspect:

- **Welcome screen** (no project open): brass `O` mark in double ring, "Octopus & you" with brass ampersand, "eight arms · one mind" mono uppercase, brass rule, "Begin a new study" italic-serif CTA, drop hint with italic-serif "open one from disk" link, recent projects strip at the bottom with brass monograms.
- **New Project flow**: left 220px pane with "A new project" + numbered I/II step index, right pane shows step content. Step I asks "Name your new study.", step II asks "Where does it begin?" with the three type cards (Empty ∅ active, Clone ⎘ and Template ❦ disabled). Final CTA: "Bring it to life".
- **New Workspace flow**: left pane "A new workspace" + I/II index. Step I asks "What are you setting out to do?" with branch slug preview ("BRANCH auth-refactor from main" mono). Step II asks "How does it start?" with mono textarea for setup script. Final CTA: "Begin" + ghost "Skip & begin".

- [ ] **Step 4: Report any blockers**

If something looks off, fix in a follow-up commit:
```bash
git commit -m "fix: <surface> in Phase 5 entry flows"
```

---

## Self-review

**Spec coverage:**
- §4.1 Welcome — Task 1 ✓ (brass mark, ampersand, italic-serif logo, brass rule, ceremonial CTA, recent projects with monograms)
- §4.2 New Project — Task 2 ✓ (2-step wizard, roman numerals, italic-serif questions, ceremonial CTA)
- §4.6 New Workspace flow — Task 3 ✓ (2-pane layout, 2 steps with roman numerals — spec mentioned 3 steps but the underlying API supports 2 fields; deferring 3rd step)
- §6 Signature moments — preserved: brass `&` (Welcome), italic-serif phrases (all 3), brass rule (all 3), roman numerals (Project + Workspace wizards). Brass `⟶` is Phase 4's input bar. Brass `§` is Phase 4's tool cards.

**Type/contract consistency:**
- WelcomeScreen prop `onNewProject: () => void` unchanged.
- NewProjectFlow prop `onBack: () => void` unchanged. Internal data flow (`create(location, name)`) unchanged.
- WorkspaceCreator props `{ projectId, projectPath, onCreated, onCancel }` unchanged. `create(projectId, projectPath, workspaceName, task, branch, "main", setupScript)` call unchanged.

**Risks:**
- The Welcome's recent-projects strip displays up to 5 projects horizontally. If a user has many recents with long names, the strip could overflow. The buttons truncate via title attribute. Acceptable for Phase 5; if it's a real issue we collapse to a vertical list later.
- Type cards in NewProjectFlow use unicode glyphs (∅, ⎘, ❦). If Spectral italic doesn't render these (font subset doesn't include them), they fall back to serif. Acceptable.
- WorkspaceCreator's "Skip & begin" button calls `handleCreate` — same as "Begin" with whatever setupScript value is present. If the user clicks "Skip" without typing anything, the script is empty, which is the desired behavior.

**Phase 5 ships when:**
- 3 implementation commits land on the branch.
- typecheck + tests pass.
- Visual smoke (Task 4 Step 3) confirms all three entry flows feel ceremonial.
