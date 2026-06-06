# Rail Foundations & Reach-on-Disk — Implementation Plan (Plan 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the left Rail's context menus genuinely useful (reveal/copy/open on disk), replace the `—` hyphen with a faceted-hex project mark, remove the redundant "Skip Jira" action, and fix four low-risk correctness bugs — without touching the data model.

**Architecture:** Frontend-first. Two new Rust commands (`open_in_terminal`, `open_in_editor`) plus an editor autodetect command reuse the existing `std::process::Command` + `~/.octopush/settings.json` patterns. The two context-menu components are rewritten around a shared `useMenuChrome` hook (viewport clamping + keyboard nav + dismissal). No DB migrations in this plan.

**Tech Stack:** React 19 + TypeScript, Zustand, Tailwind v4 (theme tokens), lucide-react icons, Tauri 2 / Rust, Vitest, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-06-05-rail-robustness-design.md` — this plan covers §4.1 (project icon), §5 (context menus, minus rename/archive/pin), §6.1–§6.2 (reach-on-disk + open in editor/terminal), §8 (remove Skip Jira / B2), and correctness fixes C1, C4, C6, C7.

**Deferred to later plans (noted so nothing is lost):** soft-close/reopen + Recently-closed drawer + per-project collapse + empty states (Plan 2), git pulse + status dots + C5 detectIssueKey prefix-gating + C8 prune (Plan 3), pin/reorder + archive + rename workspace + quick filter (Plan 4).

---

## File Structure

**New files**
- `src/components/icons/ProjectMark.tsx` — faceted-hex SVG project mark (brass linework).
- `src/lib/useMenuChrome.ts` — shared hook: viewport clamping, focus-on-open, ↑/↓ keyboard nav, Escape + outside-click dismissal.
- `src/lib/detectIssueKey.test.ts` — *not in this plan* (moved to Plan 3).
- `src/stores/workspaceStore.test.ts` — unit test for the customization-desync fix (C1).

**Modified — frontend**
- `src/components/WorkspaceRail.tsx` — use `ProjectMark` instead of `— `; fix hooks-after-return (C4).
- `src/components/WorkspaceContextMenu.tsx` — reorganized; reach-on-disk actions; remove Skip (B2); hide Delete for main (C6); use `useMenuChrome`.
- `src/components/ProjectContextMenu.tsx` — reorganized; reach-on-disk actions; drop "coming soon" stubs; danger band; use `useMenuChrome`.
- `src/lib/issueTrackerSelectors.ts` — `LinkageState` drops `"dismissed"` (B2).
- `src/stores/workspaceStore.ts` — `updateCustomization` also patches `workspacesByProjectId` (C1).
- `src/lib/ipc.ts` — wire `openInTerminal`, `openInEditor`, `detectEditors`.
- `src/lib/types.ts` — add `AppSettings.editorCommand` + `EditorChoice`.
- `src/components/Settings.tsx` — "Editor command" field in GeneralPane.
- `src/App.tsx` — new menu handlers (reveal/copy/open), two-state linkage, hide-delete-for-main, project-menu render-guard fallback (C7).

**Modified — backend**
- `src-tauri/src/commands.rs` — `open_in_terminal`, `open_in_editor`, `detect_editors` + helpers.
- `src-tauri/src/settings.rs` — `editor_command` field.
- `src-tauri/src/lib.rs` — register the three new commands.
- `src-tauri/src/tests.rs` — tests for `binary_on_path` + `split_editor_command`.

---

## Task 1: Fix customization desync in the workspace store (C1)

**Why:** `updateCustomization` patches `workspaces` but the rail renders from `workspacesByProjectId`, so a customized monogram/tint stays stale until a project switch.

**Files:**
- Modify: `src/stores/workspaceStore.ts:181-190`
- Test: `src/stores/workspaceStore.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/stores/workspaceStore.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  ipc: {
    updateWorkspaceCustomization: vi.fn().mockResolvedValue(undefined),
  },
}));

import { useWorkspaceStore } from "./workspaceStore";
import type { Workspace } from "../lib/types";

function ws(id: string, projectId: string): Workspace {
  return {
    id, projectId, name: id, task: "", branch: "main",
    worktreePath: `/p/${id}`, setupScript: "", status: "active",
    createdAt: "", lastActive: "", glyph: null, tint: null,
    linkedIssueKey: null, issueLinkDismissed: false,
  };
}

describe("workspaceStore.updateCustomization", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      workspaces: [ws("a", "p1")],
      workspacesByProjectId: { p1: [ws("a", "p1")] },
      activeId: null,
    });
  });

  it("updates the rail map (workspacesByProjectId), not just workspaces", async () => {
    await useWorkspaceStore.getState().updateCustomization("a", "★", "verdigris");
    const fromMap = useWorkspaceStore.getState().workspacesByProjectId.p1[0];
    expect(fromMap.glyph).toBe("★");
    expect(fromMap.tint).toBe("verdigris");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/stores/workspaceStore.test.ts`
Expected: FAIL — `fromMap.glyph` is `null` (map not patched).

- [ ] **Step 3: Implement the fix**

In `src/stores/workspaceStore.ts`, replace the `updateCustomization` body (lines 181-190) with:

```ts
  updateCustomization: async (workspaceId, glyph, tint) => {
    await ipc.updateWorkspaceCustomization(workspaceId, glyph, tint as any);
    set((s) => {
      const patch = (w: Workspace) =>
        w.id === workspaceId
          ? { ...w, glyph: glyph as any, tint: tint as any }
          : w;
      const nextByProject: Record<string, Workspace[]> = {};
      for (const [pid, list] of Object.entries(s.workspacesByProjectId)) {
        nextByProject[pid] = list.map(patch);
      }
      return {
        workspaces: s.workspaces.map(patch),
        workspacesByProjectId: nextByProject,
      };
    });
  },
```

Confirm `Workspace` is imported at the top of the file (it is used elsewhere in the store; if not, add `import type { Workspace } from "../lib/types";`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/stores/workspaceStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stores/workspaceStore.ts src/stores/workspaceStore.test.ts
git commit -m "fix(rail): refresh workspace customization in rail map (C1)"
```

---

## Task 2: Fix hooks-after-return in WorkspaceRow (C4)

**Why:** `useAttentionStore`, `useState`, `useRef`, `useEffect` are called *after* two `return null` paths. If `resolveMonogram` throws on one render and not the next, the hook count changes → React crash.

**Files:**
- Modify: `src/components/WorkspaceRail.tsx:138-194`

- [ ] **Step 1: Move all hooks above the early returns**

Replace the function body from line 138 (`function WorkspaceRow({`) down to the end of `handleMouseLeave`/`handleContextMenu` definitions so hooks run unconditionally. The new top of `WorkspaceRow` reads:

```tsx
function WorkspaceRow({
  workspace,
  active,
  isCollapsed,
  onSelect,
  onCustomize,
  onContextMenu,
}: WorkspaceRowProps) {
  // Hooks must run unconditionally — before any early return (C4).
  const attentionFlag = useAttentionStore(
    (s) => s.flagsByWs?.[workspace?.id ?? ""],
  );
  const [showFadeOut, setShowFadeOut] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  if (!workspace) return null;

  let mono: ReturnType<typeof resolveMonogram>;
  let tint: any;
  try {
    mono = resolveMonogram(workspace);
    tint = TINTS[mono.tint];
  } catch (e) {
    console.error("Error resolving monogram for workspace:", workspace.id, e);
    return null;
  }

  const showPulse = !!attentionFlag && !active;

  const handleMouseEnter = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setShowFadeOut(true);
    }, 500);
  };

  const handleMouseLeave = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setShowFadeOut(false);
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (onContextMenu) {
      onContextMenu(e.clientX, e.clientY);
    } else {
      onCustomize();
    }
  };
```

Leave everything from `if (isCollapsed) {` onward unchanged.

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/WorkspaceRail.tsx
git commit -m "fix(rail): call WorkspaceRow hooks before early returns (C4)"
```

---

## Task 3: Faceted-hex project mark (spec §4.1)

**Files:**
- Create: `src/components/icons/ProjectMark.tsx`
- Modify: `src/components/WorkspaceRail.tsx:2` (import) and `:65-70` (header)

- [ ] **Step 1: Create the icon component**

`src/components/icons/ProjectMark.tsx`:

```tsx
interface ProjectMarkProps {
  size?: number;
  className?: string;
}

/** Faceted-hexagon project mark — brass linework (outline, not filled).
 *  A project reads as a container; its workspaces keep filled tinted
 *  monograms, creating the rail's outline-vs-fill hierarchy. */
export function ProjectMark({ size = 15, className }: ProjectMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <polygon
        points="10,2.5 16.5,6.25 16.5,13.75 10,17.5 3.5,13.75 3.5,6.25"
        stroke="var(--color-octo-brass)"
        strokeWidth="1.3"
      />
      <circle cx="10" cy="10" r="1.6" fill="var(--color-octo-brass)" />
    </svg>
  );
}
```

- [ ] **Step 2: Import it in WorkspaceRail**

In `src/components/WorkspaceRail.tsx`, add after line 1 imports:

```tsx
import { ProjectMark } from "./icons/ProjectMark";
```

- [ ] **Step 3: Replace the hyphen in the project header**

Replace the project-name `<div>` (lines 65-70):

```tsx
                <div
                  className="font-mono text-[10px] uppercase tracking-[0.25em]"
                  style={{ color: tint.accent }}
                >
                  — {project.name}
                </div>
```

with:

```tsx
                <div
                  className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em]"
                  style={{ color: tint.accent }}
                >
                  <ProjectMark size={15} className="shrink-0" />
                  {project.name}
                </div>
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: no errors. (Visual check happens at the end-of-plan manual review.)

- [ ] **Step 5: Commit**

```bash
git add src/components/icons/ProjectMark.tsx src/components/WorkspaceRail.tsx
git commit -m "feat(rail): faceted-hex project mark, replacing the hyphen"
```

---

## Task 4: Backend — open in terminal / editor + autodetect

**Files:**
- Modify: `src-tauri/src/settings.rs` (add field)
- Modify: `src-tauri/src/commands.rs` (after `reveal_in_finder`, ~line 666)
- Modify: `src-tauri/src/lib.rs:162` (register commands)
- Test: `src-tauri/src/tests.rs`

- [ ] **Step 1: Add the setting field**

In `src-tauri/src/settings.rs`, inside `struct AppSettings`, add (after the `issue_tracker` field):

```rust
    /// Optional override command for "Open in editor" (e.g. "code", "cursor").
    /// When empty/None, the app autodetects an installed editor.
    #[serde(default)]
    pub editor_command: Option<String>,
```

- [ ] **Step 2: Add the commands + helpers to commands.rs**

Add directly after the `reveal_in_finder` command (after its closing `}` near line 666):

```rust
/// One detected editor available on the user's PATH.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorChoice {
    pub id: String,
    pub name: String,
    pub command: String,
}

/// (id, display name, CLI binary) for editors we know how to launch.
const KNOWN_EDITORS: &[(&str, &str, &str)] = &[
    ("vscode", "VS Code", "code"),
    ("cursor", "Cursor", "cursor"),
    ("zed", "Zed", "zed"),
    ("sublime", "Sublime Text", "subl"),
    ("intellij", "IntelliJ IDEA", "idea"),
];

/// True if `bin` is an executable found on PATH.
fn binary_on_path(bin: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    for dir in std::env::split_paths(&paths) {
        if dir.join(bin).is_file() {
            return true;
        }
        #[cfg(target_os = "windows")]
        for ext in ["exe", "cmd", "bat"] {
            if dir.join(format!("{bin}.{ext}")).is_file() {
                return true;
            }
        }
    }
    false
}

/// Split an editor command string into (program, args). Returns None if empty.
fn split_editor_command(cmd: &str) -> Option<(String, Vec<String>)> {
    let mut parts = cmd.split_whitespace();
    let program = parts.next()?.to_string();
    let args = parts.map(|s| s.to_string()).collect();
    Some((program, args))
}

/// Resolve which editor command to run: the configured override, else the
/// first autodetected editor.
fn resolve_editor_command() -> Option<String> {
    if let Ok(settings) = crate::settings::load_settings() {
        if let Some(cmd) = settings.editor_command {
            let trimmed = cmd.trim().to_string();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    KNOWN_EDITORS
        .iter()
        .find(|(_, _, cmd)| binary_on_path(cmd))
        .map(|(_, _, cmd)| cmd.to_string())
}

#[tauri::command]
pub async fn detect_editors() -> AppResult<Vec<EditorChoice>> {
    Ok(KNOWN_EDITORS
        .iter()
        .filter(|(_, _, cmd)| binary_on_path(cmd))
        .map(|(id, name, cmd)| EditorChoice {
            id: id.to_string(),
            name: name.to_string(),
            command: cmd.to_string(),
        })
        .collect())
}

#[tauri::command]
pub async fn open_in_editor(path: String) -> AppResult<()> {
    let path = expand_tilde(&path);
    if let Some(cmd) = resolve_editor_command() {
        if let Some((program, args)) = split_editor_command(&cmd) {
            std::process::Command::new(&program)
                .args(&args)
                .arg(&path)
                .spawn()
                .map_err(|e| AppError::Other(format!("Failed to open editor: {e}")))?;
            return Ok(());
        }
    }
    // No editor configured or detected — fall back to the OS default.
    open_file_in_system(path).await
}

#[tauri::command]
pub async fn open_in_terminal(path: String) -> AppResult<()> {
    let path = expand_tilde(&path);
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-a")
            .arg("Terminal")
            .arg(&path)
            .spawn()
            .map_err(|e| AppError::Other(format!("Failed to open terminal: {e}")))?;
    }
    #[cfg(target_os = "linux")]
    {
        let mut candidates: Vec<String> = Vec::new();
        if let Ok(t) = std::env::var("TERMINAL") {
            if !t.is_empty() {
                candidates.push(t);
            }
        }
        for t in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
            candidates.push(t.to_string());
        }
        let mut spawned = false;
        for t in candidates {
            if std::process::Command::new(&t)
                .current_dir(&path)
                .spawn()
                .is_ok()
            {
                spawned = true;
                break;
            }
        }
        if !spawned {
            return Err(AppError::Other("No terminal emulator found".into()));
        }
    }
    Ok(())
}
```

(If `AppError` / `expand_tilde` are not already in scope at that point in `commands.rs`, they are — both are used by the adjacent `open_file_in_system`/`reveal_in_finder`.)

- [ ] **Step 3: Register the commands**

In `src-tauri/src/lib.rs`, after line 162 (`commands::reveal_in_finder,`) add:

```rust
            commands::open_in_terminal,
            commands::open_in_editor,
            commands::detect_editors,
```

- [ ] **Step 4: Write the failing Rust tests**

In `src-tauri/src/tests.rs`, add:

```rust
#[test]
fn split_editor_command_parses_program_and_args() {
    use crate::commands::split_editor_command;
    assert_eq!(
        split_editor_command("code"),
        Some(("code".to_string(), vec![]))
    );
    assert_eq!(
        split_editor_command("code -n"),
        Some(("code".to_string(), vec!["-n".to_string()]))
    );
    assert_eq!(split_editor_command("   "), None);
}

#[test]
fn binary_on_path_finds_a_known_shell() {
    use crate::commands::binary_on_path;
    // `sh` exists on every unix CI runner.
    #[cfg(unix)]
    assert!(binary_on_path("sh"));
    assert!(!binary_on_path("definitely-not-a-real-binary-xyz"));
}
```

Make `split_editor_command` and `binary_on_path` reachable from tests: change their definitions in `commands.rs` from `fn` to `pub(crate) fn`.

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri && cargo test split_editor_command binary_on_path`
Expected: both PASS. Then `cargo test` (full) and `cargo build` to confirm registration compiles.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/settings.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/tests.rs
git commit -m "feat(backend): open_in_editor/open_in_terminal + editor autodetect"
```

---

## Task 5: IPC + types + Settings field for the editor command

**Files:**
- Modify: `src/lib/types.ts:277-288` (AppSettings) + add `EditorChoice`
- Modify: `src/lib/ipc.ts` (after line 181)
- Modify: `src/components/Settings.tsx` (GeneralPane)

- [ ] **Step 1: Add types**

In `src/lib/types.ts`, add `editorCommand` to `AppSettings` (after `gitCredentials`):

```ts
  /** Optional "Open in editor" command override; empty/undefined → autodetect. */
  editorCommand?: string | null;
```

And add a new interface (anywhere sensible, e.g. just below `AppSettings`):

```ts
export interface EditorChoice {
  id: string;
  name: string;
  command: string;
}
```

- [ ] **Step 2: Wire IPC**

In `src/lib/ipc.ts`, add after line 181 (`revealInFinder: ...`):

```ts
  openInTerminal: (path: string) => invoke<void>("open_in_terminal", { path }),
  openInEditor: (path: string) => invoke<void>("open_in_editor", { path }),
  detectEditors: () => invoke<EditorChoice[]>("detect_editors"),
```

Ensure `EditorChoice` is imported in `ipc.ts` (it imports types from `./types`; add `EditorChoice` to that import list).

- [ ] **Step 3: Add the Settings field**

In `src/components/Settings.tsx`, add `EditorChoice` to the `./types` import and ensure `ipc` is imported (ModelsPane already uses it). Then replace the `GeneralPane` body's `<div className="max-w-[640px] space-y-4">` block (lines ~190-198) with:

```tsx
      <div className="max-w-[640px] space-y-4">
        <SectionLabel>Attention</SectionLabel>
        <ToggleRow
          label="Play sound when an agent or terminal needs attention"
          description="A short chime plays when a chat finishes a response or a terminal rings the bell in a workspace you're not currently looking at."
          checked={soundEnabled}
          onChange={setSoundEnabled}
        />

        <SectionLabel>Editor</SectionLabel>
        <EditorCommandRow />
      </div>
```

Add the `EditorCommandRow` component directly below `GeneralPane`:

```tsx
function EditorCommandRow() {
  const [cmd, setCmd] = useState("");
  const [detected, setDetected] = useState<EditorChoice[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    ipc.getSettings().then((s) => setCmd(s.editorCommand ?? "")).catch(() => {});
    ipc.detectEditors().then(setDetected).catch(() => {});
  }, []);

  async function persist() {
    const s = await ipc.getSettings();
    await ipc.saveSettings({ ...s, editorCommand: cmd.trim() || null });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div
      className="rounded-lg px-4 py-3"
      style={{
        border: "1px solid var(--color-octo-hairline)",
        background: "var(--color-octo-panel)",
      }}
    >
      <div className="font-serif text-[14px] leading-tight text-octo-ivory">
        Editor command
      </div>
      <div className="mt-1 text-[12px] leading-[1.55] text-octo-sage">
        Used by “Open in editor” in the rail. Leave empty to auto-detect.
        {detected.length > 0 && ` Detected: ${detected.map((e) => e.name).join(", ")}.`}
      </div>
      <input
        value={cmd}
        onChange={(e) => setCmd(e.target.value)}
        onBlur={persist}
        placeholder={detected[0]?.command ?? "code"}
        spellCheck={false}
        className="mt-2 w-full rounded-md px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none"
        style={{
          background: "var(--color-octo-onyx)",
          border: "1px solid var(--color-octo-hairline)",
        }}
      />
      {saved && (
        <div className="mt-1 font-mono text-[10px] text-octo-verdigris">Saved</div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/ipc.ts src/components/Settings.tsx
git commit -m "feat(settings): editor command field + reach-on-disk IPC"
```

---

## Task 6: Shared `useMenuChrome` hook (clamping + keyboard + dismissal) — B8/B9/B10

**Files:**
- Create: `src/lib/useMenuChrome.ts`

- [ ] **Step 1: Create the hook**

```ts
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Shared chrome for the rail context menus:
 *  - clamps the menu into the viewport after measuring it (B9),
 *  - focuses the first menu item on open and supports ↑/↓ nav (B10),
 *  - dismisses on Escape and on outside-click, ignoring right-click (B8).
 */
export function useMenuChrome(x: number, y: number, onDismiss: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(x, window.innerWidth - width - margin));
    const top = Math.max(margin, Math.min(y, window.innerHeight - height - margin));
    setPos({ left, top });
  }, [x, y]);

  useLayoutEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>(
      '[role="menuitem"]:not([disabled])',
    );
    first?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = Array.from(
          el.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'),
        );
        if (items.length === 0) return;
        const idx = items.indexOf(document.activeElement as HTMLElement);
        const next =
          e.key === "ArrowDown"
            ? items[(idx + 1) % items.length]
            : items[(idx - 1 + items.length) % items.length];
        next?.focus();
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 2) return; // let right-click re-open elsewhere
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown, true);
    };
  }, [onDismiss]);

  return { ref, pos };
}
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/useMenuChrome.ts
git commit -m "feat(rail): shared context-menu chrome hook (clamp/keyboard/dismiss)"
```

---

## Task 7: Rewrite WorkspaceContextMenu (reach-on-disk, remove Skip, hide Delete for main)

**Files:**
- Modify: `src/lib/issueTrackerSelectors.ts:4-21`
- Rewrite: `src/components/WorkspaceContextMenu.tsx`
- Modify: `src/App.tsx:1538-1589` (render + handlers)

- [ ] **Step 1: Drop the `dismissed` linkage state (B2)**

In `src/lib/issueTrackerSelectors.ts`, change the type and resolver:

```ts
export type LinkageState =
  | { kind: "linked"; key: string; source: "manual" | "detected" }
  | { kind: "unlinked" };

export function resolveLinkage(ws: Workspace, branch: string): LinkageState {
  if (ws.linkedIssueKey) {
    return { kind: "linked", key: ws.linkedIssueKey, source: "manual" };
  }
  const detected = detectIssueKey(branch);
  if (detected) {
    return { kind: "linked", key: detected, source: "detected" };
  }
  return { kind: "unlinked" };
}
```

(`issueLinkDismissed` stays on the `Workspace` type — harmless, removed in a later cleanup.)

- [ ] **Step 2: Rewrite the component**

Replace the entire contents of `src/components/WorkspaceContextMenu.tsx`:

```tsx
import {
  FolderOpen,
  Copy,
  GitBranch,
  PanelsTopLeft,
  SquareTerminal,
  Pencil,
  Link2,
  Link2Off,
  Trash2,
} from "lucide-react";
import { useMenuChrome } from "../lib/useMenuChrome";

interface Props {
  x: number;
  y: number;
  workspaceName: string;
  ticketKey?: string | null;
  /** True for the project's main worktree — Delete is hidden (C6). */
  isMain: boolean;
  onRevealInFinder: () => void;
  onCopyPath: () => void;
  onCopyBranch: () => void;
  onOpenInEditor: () => void;
  onOpenInTerminal: () => void;
  onCustomize: () => void;
  onDelete: () => void;
  /** Dismiss the menu. */
  onClose: () => void;
  linkageKind?: "linked" | "unlinked";
  onLinkJira?: () => void;
  onChangeJira?: () => void;
  onUnlinkJira?: () => void;
}

const ITEM =
  "flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass";
const DANGER =
  "flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-rouge transition hover:bg-[var(--rouge-ghost,rgba(209,139,139,0.08))] hover:text-octo-rouge";
const SEP = "h-px bg-octo-hairline";

export function WorkspaceContextMenu({
  x,
  y,
  workspaceName,
  ticketKey,
  isMain,
  onRevealInFinder,
  onCopyPath,
  onCopyBranch,
  onOpenInEditor,
  onOpenInTerminal,
  onCustomize,
  onDelete,
  onClose,
  linkageKind,
  onLinkJira,
  onChangeJira,
  onUnlinkJira,
}: Props) {
  const { ref, pos } = useMenuChrome(x, y, onClose);
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Workspace actions"
      className="absolute z-50 w-[230px] rounded-md border border-octo-hairline bg-octo-panel py-1 shadow-2xl"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="truncate px-3 pb-1 pt-1 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute">
        {workspaceName}
        {ticketKey ? ` · ${ticketKey}` : ""}
      </div>

      <button type="button" role="menuitem" className={ITEM} onClick={run(onRevealInFinder)}>
        <FolderOpen size={12} className="shrink-0" /> Reveal in Finder
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={run(onCopyPath)}>
        <Copy size={12} className="shrink-0" /> Copy path
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={run(onCopyBranch)}>
        <GitBranch size={12} className="shrink-0" /> Copy branch name
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={run(onOpenInEditor)}>
        <PanelsTopLeft size={12} className="shrink-0" /> Open in editor
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={run(onOpenInTerminal)}>
        <SquareTerminal size={12} className="shrink-0" /> Open in terminal
      </button>

      <div className={SEP} />

      <button type="button" role="menuitem" className={ITEM} onClick={run(onCustomize)}>
        <Pencil size={12} className="shrink-0" /> Customize…
      </button>

      {linkageKind && (
        <>
          <div className={SEP} />
          {linkageKind === "unlinked" && onLinkJira && (
            <button type="button" role="menuitem" className={ITEM} onClick={run(onLinkJira)}>
              <Link2 size={12} className="shrink-0" /> Link Jira ticket…
            </button>
          )}
          {linkageKind === "linked" && onChangeJira && (
            <button type="button" role="menuitem" className={ITEM} onClick={run(onChangeJira)}>
              <Link2 size={12} className="shrink-0" /> Change Jira ticket…
            </button>
          )}
          {linkageKind === "linked" && onUnlinkJira && (
            <button type="button" role="menuitem" className={ITEM} onClick={run(onUnlinkJira)}>
              <Link2Off size={12} className="shrink-0" /> Unlink Jira ticket
            </button>
          )}
        </>
      )}

      {!isMain && (
        <>
          <div className={SEP} />
          <button type="button" role="menuitem" className={DANGER} onClick={run(onDelete)}>
            <Trash2 size={12} className="shrink-0" /> Delete workspace…
          </button>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Update the render + add handlers in App.tsx**

Replace the `contextMenu` render block (`src/App.tsx:1538-1589`) with:

```tsx
      {contextMenu && (() => {
        let ws = null;
        for (const projectWs of Object.values(workspacesByProjectId)) {
          ws = projectWs.find((w) => w.id === contextMenu.workspaceId);
          if (ws) break;
        }
        if (!ws) return null;
        const wsBranch = ws.branch ?? "";
        const wsLinkage = resolveLinkage(ws, wsBranch);
        const ticketKey = wsLinkage.kind === "linked" ? wsLinkage.key : null;
        const proj =
          recentProjects.find((p) => p.id === ws!.projectId) ??
          (project?.id === ws.projectId ? project : null);
        const wsPath = ws.worktreePath ?? proj?.path ?? "";
        const isMain = !ws.worktreePath || (!!proj && ws.worktreePath === proj.path);
        const copy = async (text: string, label: string) => {
          setContextMenu(null);
          try {
            await navigator.clipboard.writeText(text);
            pushToast({ level: "success", title: label });
          } catch (err) {
            pushToast({ level: "error", title: "Copy failed", body: String(err) });
          }
        };
        return (
          <WorkspaceContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            workspaceName={ws.name}
            ticketKey={ticketKey}
            isMain={isMain}
            onRevealInFinder={() => {
              setContextMenu(null);
              void ipc.revealInFinder(wsPath).catch((err) =>
                pushToast({ level: "error", title: "Reveal failed", body: String(err) }),
              );
            }}
            onCopyPath={() => void copy(wsPath, "Path copied")}
            onCopyBranch={() => void copy(wsBranch, "Branch copied")}
            onOpenInEditor={() => {
              setContextMenu(null);
              void ipc.openInEditor(wsPath).catch((err) =>
                pushToast({ level: "error", title: "Open in editor failed", body: String(err) }),
              );
            }}
            onOpenInTerminal={() => {
              setContextMenu(null);
              void ipc.openInTerminal(wsPath).catch((err) =>
                pushToast({ level: "error", title: "Open in terminal failed", body: String(err) }),
              );
            }}
            onCustomize={() => {
              setContextMenu(null);
              setCustomizingWorkspaceId(contextMenu.workspaceId);
            }}
            onDelete={() => {
              setContextMenu(null);
              setDeletingWorkspaceId(contextMenu.workspaceId);
            }}
            onClose={() => setContextMenu(null)}
            linkageKind={wsLinkage.kind === "linked" ? "linked" : "unlinked"}
            onLinkJira={() => {
              setJiraTicketPickerOpen({ workspaceId: contextMenu.workspaceId, mode: "link" });
              setContextMenu(null);
            }}
            onChangeJira={() => {
              setJiraTicketPickerOpen({ workspaceId: contextMenu.workspaceId, mode: "change" });
              setContextMenu(null);
            }}
            onUnlinkJira={async () => {
              await ipc.updateWorkspaceLink(contextMenu.workspaceId, null, false);
              await useWorkspaceStore.getState().load(ws!.projectId);
              setContextMenu(null);
            }}
          />
        );
      })()}
```

(The `onSkipJira` prop and its `updateWorkspaceLink(..., true)` handler are removed entirely.)

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: no errors. Confirm `pushToast`, `recentProjects`, `project`, `useWorkspaceStore` are already in scope in `App.tsx` (they are, per existing handlers).

- [ ] **Step 5: Commit**

```bash
git add src/components/WorkspaceContextMenu.tsx src/lib/issueTrackerSelectors.ts src/App.tsx
git commit -m "feat(rail): workspace menu reach-on-disk actions; remove Skip Jira (B2); hide Delete for main (C6)"
```

---

## Task 8: Rewrite ProjectContextMenu + render-guard fallback (C7)

**Files:**
- Rewrite: `src/components/ProjectContextMenu.tsx`
- Modify: `src/App.tsx:1467-1490` (render + handlers + C7 guard)

- [ ] **Step 1: Rewrite the component**

Replace the entire contents of `src/components/ProjectContextMenu.tsx`:

```tsx
import {
  FolderOpen,
  Copy,
  PanelsTopLeft,
  SquareTerminal,
  Pencil,
  Palette,
  Link2,
  Archive,
  Trash2,
} from "lucide-react";
import { useMenuChrome } from "../lib/useMenuChrome";

interface Props {
  projectId: string;
  projectName: string;
  x: number;
  y: number;
  onRevealInFinder: () => void;
  onCopyPath: () => void;
  onOpenInEditor: () => void;
  onOpenInTerminal: () => void;
  onRename: () => void;
  onChangeTint: () => void;
  onSetJiraProjectKey?: () => void;
  onClose: () => void;
  onDelete: () => void;
  onDismiss: () => void;
}

const ITEM =
  "flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass";
const DANGER =
  "flex w-full items-start gap-2 px-3 py-2 font-mono text-[11px] text-octo-rouge transition hover:bg-[var(--rouge-ghost,rgba(209,139,139,0.08))] hover:text-octo-rouge";
const SEP = "h-px bg-octo-hairline";

export function ProjectContextMenu({
  projectId: _projectId,
  projectName,
  x,
  y,
  onRevealInFinder,
  onCopyPath,
  onOpenInEditor,
  onOpenInTerminal,
  onRename,
  onChangeTint,
  onSetJiraProjectKey,
  onClose,
  onDelete,
  onDismiss,
}: Props) {
  const { ref, pos } = useMenuChrome(x, y, onDismiss);
  const run = (fn: () => void) => () => {
    fn();
    onDismiss();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Project actions"
      className="absolute z-50 w-[244px] rounded-md border border-octo-hairline bg-octo-panel py-1 shadow-2xl"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="truncate px-3 pb-1 pt-1 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute">
        {projectName}
      </div>

      <button type="button" role="menuitem" className={ITEM} onClick={run(onRevealInFinder)}>
        <FolderOpen size={12} className="shrink-0" /> Reveal in Finder
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={run(onCopyPath)}>
        <Copy size={12} className="shrink-0" /> Copy path
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={run(onOpenInEditor)}>
        <PanelsTopLeft size={12} className="shrink-0" /> Open in editor
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={run(onOpenInTerminal)}>
        <SquareTerminal size={12} className="shrink-0" /> Open in terminal
      </button>

      <div className={SEP} />

      <button type="button" role="menuitem" className={ITEM} onClick={run(onRename)}>
        <Pencil size={12} className="shrink-0" /> Rename project
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={run(onChangeTint)}>
        <Palette size={12} className="shrink-0" /> Change tint
      </button>
      {onSetJiraProjectKey && (
        <button type="button" role="menuitem" className={ITEM} onClick={run(onSetJiraProjectKey)}>
          <Link2 size={12} className="shrink-0" /> Set Jira project key…
        </button>
      )}

      <div className={SEP} />

      <button type="button" role="menuitem" className={DANGER} onClick={run(onClose)}>
        <Archive size={12} className="mt-0.5 shrink-0" />
        <span className="flex flex-col text-left">
          <span>Close project</span>
          <span className="text-octo-mute">Hides it — restore from Recently closed</span>
        </span>
      </button>
      <button type="button" role="menuitem" className={DANGER} onClick={run(onDelete)}>
        <Trash2 size={12} className="mt-0.5 shrink-0" />
        <span className="flex flex-col text-left">
          <span>Delete from disk…</span>
          <span className="text-octo-mute">Removes the folder permanently</span>
        </span>
      </button>
    </div>
  );
}
```

Note: the subtitle ("restore from Recently closed") describes Plan 2 behavior. Until Plan 2 lands, `onClose` still calls the existing (destructive) `handleCloseProject`; the copy is forward-looking and acceptable for this increment. **If executing this plan standalone before Plan 2, change the subtitle to "Removes it from the rail" to avoid over-promising.**

- [ ] **Step 2: Update the render in App.tsx (incl. C7 fallback)**

Replace the `projectContextMenu` render block (`src/App.tsx:1467-1490`) with:

```tsx
      {projectContextMenu && (() => {
        const proj =
          recentProjects.find((p) => p.id === projectContextMenu.projectId) ??
          (project?.id === projectContextMenu.projectId ? project : null);
        if (!proj) return null;
        const projPath = proj.path;
        const copyPath = async () => {
          setProjectContextMenu(null);
          try {
            await navigator.clipboard.writeText(projPath);
            pushToast({ level: "success", title: "Path copied" });
          } catch (err) {
            pushToast({ level: "error", title: "Copy failed", body: String(err) });
          }
        };
        return (
          <ProjectContextMenu
            projectId={projectContextMenu.projectId}
            projectName={proj.name}
            x={projectContextMenu.x}
            y={projectContextMenu.y}
            onRevealInFinder={() => {
              setProjectContextMenu(null);
              void ipc.revealInFinder(projPath).catch((err) =>
                pushToast({ level: "error", title: "Reveal failed", body: String(err) }),
              );
            }}
            onCopyPath={() => void copyPath()}
            onOpenInEditor={() => {
              setProjectContextMenu(null);
              void ipc.openInEditor(projPath).catch((err) =>
                pushToast({ level: "error", title: "Open in editor failed", body: String(err) }),
              );
            }}
            onOpenInTerminal={() => {
              setProjectContextMenu(null);
              void ipc.openInTerminal(projPath).catch((err) =>
                pushToast({ level: "error", title: "Open in terminal failed", body: String(err) }),
              );
            }}
            onRename={() => handleRenameProject(projectContextMenu.projectId)}
            onChangeTint={() => {
              setCustomizingProjectId(projectContextMenu.projectId);
              setShowProjectCustomizer(true);
              setProjectContextMenu(null);
            }}
            onSetJiraProjectKey={
              issueTrackerConfigured
                ? () => {
                    setJiraProjectKeyEditorOpen({ projectId: projectContextMenu.projectId });
                    setProjectContextMenu(null);
                  }
                : undefined
            }
            onClose={() => handleCloseProject(projectContextMenu.projectId)}
            onDelete={() => handleDeleteProject(projectContextMenu.projectId)}
            onDismiss={() => setProjectContextMenu(null)}
          />
        );
      })()}
```

Verify against the existing code which condition gated `onSetJiraProjectKey` (the original passed it unconditionally with the same `setJiraProjectKeyEditorOpen` call — keep whatever boolean the original used; `issueTrackerConfigured` is shown here as the likely gate. If the original passed it unconditionally, drop the ternary and pass it directly.)

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/ProjectContextMenu.tsx src/App.tsx
git commit -m "feat(rail): project menu reach-on-disk actions, danger band, render-guard fallback (C7)"
```

---

## Task 9: Full-plan verification

- [ ] **Step 1: Typecheck + tests + Rust**

Run, expecting all green:
```bash
npm run typecheck
npm test
cd src-tauri && cargo test && cd ..
```

- [ ] **Step 2: Manual smoke test (`npm run tauri:dev`)**

Verify:
- Project headers show the faceted-hex mark, no hyphen.
- Right-click a workspace: Reveal/Copy path/Copy branch/Open in editor/Open in terminal all work; **no "Skip Jira here"**; the **main** workspace shows **no Delete**.
- Right-click a project: reach-on-disk actions work; Close/Delete sit in the rouge danger band.
- Open a menu near the bottom/right screen edge — it clamps fully on-screen.
- Arrow keys move between items; Escape closes; the menu no longer closes when the cursor merely leaves it.
- Customize a workspace's glyph/tint — the rail updates immediately (C1).
- Settings → General → "Editor command": detected editors are listed; setting a value changes which editor "Open in editor" launches.

- [ ] **Step 3: Design-system check**

Grep the diff for hardcoded hex colors (should be empty):
```bash
git diff main -- src | grep -nE "#[0-9a-fA-F]{3,8}" || echo "clean"
```
(`ProjectMark.tsx` uses `var(--color-octo-brass)`, not hex — confirm.)

---

## Self-Review (completed during planning)

- **Spec coverage:** §4.1 ✓ (T3), §5 menus minus rename/archive/pin ✓ (T6–T8), §6.1 reach-on-disk ✓ (T4/T5/T7/T8), §6.2 open-in-editor ✓ (T4/T5), §8 remove Skip ✓ (T7), C1 ✓ (T1), C4 ✓ (T2), C6 ✓ (T7), C7 ✓ (T8), B8/B9/B10 ✓ (T6). Deferred items explicitly listed in the header.
- **Placeholder scan:** none — every step has concrete code/commands. The two forward-looking notes (Close subtitle; `onSetJiraProjectKey` gate) are flagged as verify-against-source, not blanks.
- **Type consistency:** `EditorChoice` shape identical in Rust (`commands.rs`), `types.ts`, and `ipc.ts`. `LinkageState` two-state used consistently in `issueTrackerSelectors.ts` and the `WorkspaceContextMenu` prop. `useMenuChrome(x, y, onDismiss)` signature matches both call sites (workspace passes `onClose`, project passes `onDismiss`).
