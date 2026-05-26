# Project Management Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement project-level management (rename, tint, close, delete) with UI in WorkspaceRail and right-click context menus.

**Architecture:** Three new components (ProjectContextMenu, ProjectCustomizeMenu, enhanced ConfirmDialog) + modifications to WorkspaceRail and App.tsx. Backend: 3 new IPC methods for project operations. Data: localStorage caching + backend DB persistence.

**Tech Stack:** React 19, Zustand (existing stores), Tailwind CSS, TypeScript, Tauri IPC (backend)

---

## File Structure

**New Components:**
- `src/components/ProjectContextMenu.tsx` - Right-click menu for projects
- `src/components/ProjectCustomizeMenu.tsx` - Modal for rename/tint
- Updates to `src/components/ConfirmDialog.tsx` - Add input validation for delete confirmation

**Modified Components:**
- `src/components/WorkspaceRail.tsx` - Add "◉ Add project" button, right-click handlers
- `src/App.tsx` - State for project customization, handlers, pass to rail

**Backend:**
- `src-tauri/src/commands.rs` - Add `update_project_customization`, `close_project`, `delete_project`
- `src-tauri/src/db.rs` or similar - Persistence layer (depends on existing architecture)

**Tests:**
- `src/components/ProjectContextMenu.test.tsx` - Menu rendering, options
- `src/components/ProjectCustomizeMenu.test.tsx` - Form, save/cancel
- Integration tests in App or existing test structure

---

## Tasks

### Task 1: Extend ConfirmDialog with input validation

**Files:**
- Modify: `src/components/ConfirmDialog.tsx`

- [ ] **Step 1: Read existing ConfirmDialog to understand structure**

Run: `cat src/components/ConfirmDialog.tsx | head -100`

Understand: Props interface, render structure, button logic

- [ ] **Step 2: Add new optional props to ConfirmDialog interface**

In the Props interface, add:
```typescript
interface Props {
  // ... existing props ...
  requireInput?: string; // Text user must type to enable confirm button
  onConfirm?: () => void;
  onCancel?: () => void;
}
```

- [ ] **Step 3: Add input state and validation logic**

Add inside ConfirmDialog component:
```typescript
const [inputValue, setInputValue] = useState("");

const isConfirmDisabled = requireInput ? inputValue !== requireInput : false;
```

- [ ] **Step 4: Add input field to render (only if requireInput is set)**

Add before the button section:
```typescript
{requireInput && (
  <div className="mt-4">
    <label className="block text-sm text-octo-mute mb-2">
      Type "{requireInput}" to confirm:
    </label>
    <input
      type="text"
      value={inputValue}
      onChange={(e) => setInputValue(e.target.value)}
      className="w-full px-3 py-2 border border-octo-hairline rounded bg-octo-panel text-octo-ivory font-mono text-sm"
      placeholder={requireInput}
      autoFocus
    />
  </div>
)}
```

- [ ] **Step 5: Update confirm button to use isConfirmDisabled**

Change confirm button from `disabled={false}` to:
```typescript
disabled={isConfirmDisabled}
```

- [ ] **Step 6: Run typecheck**

```bash
npm run typecheck
```

Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/components/ConfirmDialog.tsx
git commit -m "feat(confirm-dialog): add input validation for destructive actions"
```

---

### Task 2: Create ProjectContextMenu component

**Files:**
- Create: `src/components/ProjectContextMenu.tsx`

- [ ] **Step 1: Write component skeleton with TypeScript**

```typescript
import type { ProjectInfo } from "../lib/types";

interface Props {
  projectId: string;
  projectName: string;
  x: number;
  y: number;
  onRename: () => void;
  onChangeTint: () => void;
  onClose: () => void;
  onDelete: () => void;
  onDismiss: () => void;
}

export function ProjectContextMenu({
  projectId,
  projectName,
  x,
  y,
  onRename,
  onChangeTint,
  onClose,
  onDelete,
  onDismiss,
}: Props) {
  return (
    <div
      className="fixed z-50 bg-octo-panel border border-octo-hairline rounded-md shadow-lg"
      style={{ top: y, left: x }}
      onMouseLeave={onDismiss}
    >
      {/* Menu items */}
    </div>
  );
}
```

- [ ] **Step 2: Add menu items (active and disabled)**

Replace `{/* Menu items */}` with:
```typescript
<button
  type="button"
  onClick={() => {
    onRename();
    onDismiss();
  }}
  className="block w-full text-left px-4 py-2 text-sm text-octo-sage hover:bg-octo-panel-2 transition"
>
  Rename project
</button>

<button
  type="button"
  onClick={() => {
    onChangeTint();
    onDismiss();
  }}
  className="block w-full text-left px-4 py-2 text-sm text-octo-sage hover:bg-octo-panel-2 transition"
>
  Change tint
</button>

{/* Disabled items */}
<button
  type="button"
  disabled
  title="Coming soon"
  className="block w-full text-left px-4 py-2 text-sm text-octo-mute opacity-50 cursor-not-allowed"
>
  Project settings
</button>

<button
  type="button"
  disabled
  title="Coming soon"
  className="block w-full text-left px-4 py-2 text-sm text-octo-mute opacity-50 cursor-not-allowed"
>
  Default agent model
</button>

<button
  type="button"
  disabled
  title="Coming soon"
  className="block w-full text-left px-4 py-2 text-sm text-octo-mute opacity-50 cursor-not-allowed"
>
  Tool permissions
</button>

<button
  type="button"
  disabled
  title="Coming soon"
  className="block w-full text-left px-4 py-2 text-sm text-octo-mute opacity-50 cursor-not-allowed"
>
  Workspace presets
</button>

{/* Separator */}
<div className="border-t border-octo-hairline my-1"></div>

{/* Close / Delete */}
<button
  type="button"
  onClick={() => {
    onClose();
    onDismiss();
  }}
  className="block w-full text-left px-4 py-2 text-sm text-octo-sage hover:bg-octo-panel-2 transition"
>
  Close project
</button>

<button
  type="button"
  onClick={() => {
    onDelete();
    onDismiss();
  }}
  className="block w-full text-left px-4 py-2 text-sm text-octo-rouge hover:bg-octo-rouge/10 transition"
>
  Delete project from disk
</button>
```

- [ ] **Step 3: Add tooltip handler for disabled items**

Add useEffect:
```typescript
useEffect(() => {
  const disabledButtons = document.querySelectorAll("[title='Coming soon']");
  disabledButtons.forEach((btn) => {
    btn.addEventListener("mouseenter", (e) => {
      // Tooltip already in title attribute, browser will show it
    });
  });
}, []);
```

Actually, browser native title attribute handles this. Skip this step.

- [ ] **Step 4: Test rendering with a simple test**

Create test file `src/components/ProjectContextMenu.test.tsx`:

```typescript
import { render, screen } from "@testing-library/react";
import { ProjectContextMenu } from "./ProjectContextMenu";

describe("ProjectContextMenu", () => {
  it("renders active menu items", () => {
    render(
      <ProjectContextMenu
        projectId="test-id"
        projectName="Test Project"
        x={100}
        y={100}
        onRename={() => {}}
        onChangeTint={() => {}}
        onClose={() => {}}
        onDelete={() => {}}
        onDismiss={() => {}}
      />
    );

    expect(screen.getByText("Rename project")).toBeInTheDocument();
    expect(screen.getByText("Change tint")).toBeInTheDocument();
    expect(screen.getByText("Close project")).toBeInTheDocument();
    expect(screen.getByText("Delete project from disk")).toBeInTheDocument();
  });

  it("renders disabled items with Coming soon", () => {
    render(
      <ProjectContextMenu
        projectId="test-id"
        projectName="Test Project"
        x={100}
        y={100}
        onRename={() => {}}
        onChangeTint={() => {}}
        onClose={() => {}}
        onDelete={() => {}}
        onDismiss={() => {}}
      />
    );

    const disabledButton = screen.getByText("Project settings");
    expect(disabledButton).toBeDisabled();
    expect(disabledButton).toHaveAttribute("title", "Coming soon");
  });
});
```

- [ ] **Step 5: Run tests**

```bash
npm test -- src/components/ProjectContextMenu.test.tsx
```

Expected: Both tests pass

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/components/ProjectContextMenu.tsx src/components/ProjectContextMenu.test.tsx
git commit -m "feat(components): add ProjectContextMenu for project-level actions"
```

---

### Task 3: Create ProjectCustomizeMenu component

**Files:**
- Create: `src/components/ProjectCustomizeMenu.tsx`

- [ ] **Step 1: Review WorkspaceCustomizeMenu for pattern**

```bash
head -150 src/components/WorkspaceCustomizeMenu.tsx
```

Understand: Props, state (glyph/tint), save handler

- [ ] **Step 2: Create ProjectCustomizeMenu with rename + tint fields**

```typescript
import { useState } from "react";
import { TINTS } from "../lib/monogram";
import { ipc } from "../lib/ipc";

interface Props {
  projectId: string;
  currentName: string;
  currentTint: string;
  onCustomized: (name: string, tint: string) => void;
  onCancel: () => void;
}

export function ProjectCustomizeMenu({
  projectId,
  currentName,
  currentTint,
  onCustomized,
  onCancel,
}: Props) {
  const [name, setName] = useState(currentName);
  const [tint, setTint] = useState(currentTint);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await ipc.updateProjectCustomization(projectId, name, tint);
      onCustomized(name, tint);
    } catch (err) {
      console.error("Failed to save project customization:", err);
      // Toast error
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-octo-bg/70 backdrop-blur-sm">
      <div className="bg-octo-panel border border-octo-hairline rounded-lg p-6 w-full max-w-[400px]">
        <h2 className="font-serif text-lg text-octo-ivory mb-4">
          Customize Project
        </h2>

        {/* Name input */}
        <div className="mb-4">
          <label className="block text-sm text-octo-mute mb-2">Name:</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 border border-octo-hairline rounded bg-octo-bg text-octo-ivory font-mono text-sm"
            placeholder="Project name"
          />
        </div>

        {/* Tint picker */}
        <div className="mb-6">
          <label className="block text-sm text-octo-mute mb-3">Tint:</label>
          <div className="grid grid-cols-3 gap-2">
            {Object.entries(TINTS).map(([tintKey, tintValue]) => (
              <button
                key={tintKey}
                onClick={() => setTint(tintKey)}
                className={`h-8 rounded border-2 transition ${
                  tint === tintKey
                    ? "border-octo-brass"
                    : "border-transparent hover:border-octo-hairline"
                }`}
                style={{
                  backgroundColor: tintValue.bg,
                  color: tintValue.accent,
                }}
                title={tintKey}
              >
                &
              </button>
            ))}
          </div>
        </div>

        {/* Buttons */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 px-4 py-2 border border-octo-hairline rounded text-octo-sage hover:text-octo-ivory transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="flex-1 px-4 py-2 bg-octo-brass text-octo-bg rounded font-serif transition hover:bg-octo-brass-hi disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write test for save handler**

```typescript
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProjectCustomizeMenu } from "./ProjectCustomizeMenu";
import * as ipc from "../lib/ipc";

jest.mock("../lib/ipc");

describe("ProjectCustomizeMenu", () => {
  it("calls ipc.updateProjectCustomization on save", async () => {
    const mockIpc = ipc as jest.Mocked<typeof ipc>;
    mockIpc.updateProjectCustomization.mockResolvedValue();

    const onCustomized = jest.fn();
    const onCancel = jest.fn();

    render(
      <ProjectCustomizeMenu
        projectId="proj-1"
        currentName="Old Name"
        currentTint="brass"
        onCustomized={onCustomized}
        onCancel={onCancel}
      />
    );

    // Change name
    const nameInput = screen.getByPlaceholderText("Project name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "New Name" } });

    // Click save
    const saveButton = screen.getByText("Save");
    fireEvent.click(saveButton);

    // Wait for IPC call
    await waitFor(() => {
      expect(mockIpc.updateProjectCustomization).toHaveBeenCalledWith(
        "proj-1",
        "New Name",
        "brass"
      );
    });

    // Verify callback
    await waitFor(() => {
      expect(onCustomized).toHaveBeenCalledWith("New Name", "brass");
    });
  });
});
```

- [ ] **Step 4: Run tests**

```bash
npm test -- src/components/ProjectCustomizeMenu.test.tsx
```

Expected: Tests pass

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/components/ProjectCustomizeMenu.tsx src/components/ProjectCustomizeMenu.test.tsx
git commit -m "feat(components): add ProjectCustomizeMenu for project customization"
```

---

### Task 4: Add "◉ Add project" button and context menu support to WorkspaceRail

**Files:**
- Modify: `src/components/WorkspaceRail.tsx`

- [ ] **Step 1: Update Props interface to include new callbacks**

Add to Props interface:
```typescript
interface Props {
  // ... existing props ...
  onAddProject?: () => void;
  onProjectContextMenu?: (projectId: string, x: number, y: number) => void;
}
```

- [ ] **Step 2: Add new props to component destructuring**

```typescript
export function WorkspaceRail({
  projects,
  activeWorkspaceId,
  onSelect,
  onCustomize,
  onContextMenu,
  onNewWorkspace,
  onAddProject,
  onProjectContextMenu,
}: Props) {
```

- [ ] **Step 3: Add right-click handler to project header**

In the project header section (around line 48), add:
```typescript
onContextMenu={(e) => {
  e.preventDefault();
  if (onProjectContextMenu) {
    onProjectContextMenu(project.id, e.clientX, e.clientY);
  }
}}
```

- [ ] **Step 4: Add "◉ Add project" button above collapse**

Before the collapse button, add:
```typescript
{/* Add project button */}
<button
  type="button"
  onClick={onAddProject}
  className={`w-full flex ${isCollapsed ? "justify-center" : ""} items-center gap-2 px-3 py-2 text-octo-mute hover:text-octo-brass transition font-mono text-sm`}
  title="Add project"
>
  ◉ {!isCollapsed && "Add project"}
</button>
```

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: No errors

- [ ] **Step 6: Test rendering**

Run existing tests:
```bash
npm test -- src/components/WorkspaceRail.test.tsx
```

Expected: Tests pass (may need to update mocks for new props)

- [ ] **Step 7: Commit**

```bash
git add src/components/WorkspaceRail.tsx
git commit -m "feat(rail): add project context menu support and Add project button"
```

---

### Task 5: Update App.tsx with project management state and handlers

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add new state for project customization and deletion**

Add after existing useState declarations:
```typescript
const [showProjectCustomizer, setShowProjectCustomizer] = useState(false);
const [customizingProjectId, setCustomizingProjectId] = useState<string | null>(null);
const [customizingMode, setCustomizingMode] = useState<'rename' | 'tint'>('rename');
const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
const [projectContextMenu, setProjectContextMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);
```

- [ ] **Step 2: Add handler for opening customizer**

```typescript
const handleProjectContextMenu = (projectId: string, x: number, y: number) => {
  setProjectContextMenu({ projectId, x, y });
};

const handleRenameProject = (projectId: string) => {
  setCustomizingProjectId(projectId);
  setCustomizingMode('rename');
  setShowProjectCustomizer(true);
  setProjectContextMenu(null);
};

const handleChangeTintProject = (projectId: string) => {
  setCustomizingProjectId(projectId);
  setCustomizingMode('tint');
  setShowProjectCustomizer(true);
  setProjectContextMenu(null);
};
```

- [ ] **Step 3: Add handler for saving project customization**

```typescript
const handleProjectCustomized = useCallback(
  async (projectId: string, name: string, tint: string) => {
    // Update localStorage
    const customizations = JSON.parse(
      localStorage.getItem("projectCustomizations") || "{}"
    );
    customizations[projectId] = { name, tint };
    localStorage.setItem("projectCustomizations", JSON.stringify(customizations));

    // Update store if needed (future: add to projectStore)
    setShowProjectCustomizer(false);
    setCustomizingProjectId(null);

    pushToast({
      level: "success",
      title: "Project updated",
    });
  },
  []
);
```

- [ ] **Step 4: Add handlers for close and delete**

```typescript
const handleCloseProject = useCallback(
  async (projectId: string) => {
    try {
      await ipc.closeProject(projectId);
      // Reload recent projects
      await loadRecentProjects();
      pushToast({
        level: "success",
        title: "Project closed",
      });
    } catch (err) {
      pushToast({
        level: "error",
        title: "Failed to close project",
        body: String(err),
      });
    }
    setProjectContextMenu(null);
  },
  [loadRecentProjects]
);

const handleDeleteProject = useCallback(
  async (projectId: string) => {
    const projectName = recentProjects.find(p => p.id === projectId)?.name || "Unknown";
    setDeletingProjectId(projectId);
    setProjectContextMenu(null);
  },
  [recentProjects]
);

const handleConfirmDeleteProject = useCallback(
  async (projectId: string) => {
    try {
      await ipc.deleteProject(projectId);
      // Reload recent projects
      await loadRecentProjects();
      // If current project was deleted, go to welcome
      if (project?.id === projectId) {
        useProjectStore.getState().close();
      }
      pushToast({
        level: "success",
        title: "Project deleted",
      });
    } catch (err) {
      pushToast({
        level: "error",
        title: "Failed to delete project",
        body: String(err),
      });
    } finally {
      setDeletingProjectId(null);
    }
  },
  [project?.id, loadRecentProjects]
);
```

- [ ] **Step 5: Add handlers for "Add project"**

The `onAddProject` should trigger the existing NewProjectFlow. Update the existing handler or add:
```typescript
const handleAddProjectFromRail = useCallback(() => {
  setShowAddProject(true);
}, []);
```

- [ ] **Step 6: Update WorkspaceRail props**

Find the WorkspaceRail component render and add:
```typescript
<WorkspaceRail
  projects={projectGroups}
  activeWorkspaceId={activeWorkspaceId}
  onSelect={(id) => selectWorkspace(id)}
  onCustomize={(id) => setCustomizingWorkspaceId(id)}
  onContextMenu={(workspaceId, x, y) => setContextMenu({ workspaceId, x, y })}
  onNewWorkspace={() => setShowCreator(true)}
  onNewWorkspaceForProject={(projectId) => {
    setCreatorProjectId(projectId);
    setShowCreator(true);
  }}
  onAddProject={handleAddProjectFromRail}
  onProjectContextMenu={handleProjectContextMenu}
/>
```

- [ ] **Step 7: Add ProjectContextMenu render**

Add before the WorkspaceCustomizeMenu section:
```typescript
{projectContextMenu && (
  <ProjectContextMenu
    projectId={projectContextMenu.projectId}
    projectName={recentProjects.find(p => p.id === projectContextMenu.projectId)?.name || "Unknown"}
    x={projectContextMenu.x}
    y={projectContextMenu.y}
    onRename={() => handleRenameProject(projectContextMenu.projectId)}
    onChangeTint={() => handleChangeTintProject(projectContextMenu.projectId)}
    onClose={() => handleCloseProject(projectContextMenu.projectId)}
    onDelete={() => handleDeleteProject(projectContextMenu.projectId)}
    onDismiss={() => setProjectContextMenu(null)}
  />
)}
```

- [ ] **Step 8: Add ProjectCustomizeMenu render**

Add after ProjectContextMenu:
```typescript
{showProjectCustomizer && customizingProjectId && (() => {
  const proj = recentProjects.find(p => p.id === customizingProjectId);
  if (!proj) return null;
  
  const customizations = JSON.parse(
    localStorage.getItem("projectCustomizations") || "{}"
  );
  const customized = customizations[customizingProjectId] || {};

  return (
    <ProjectCustomizeMenu
      projectId={customizingProjectId}
      currentName={customized.name || proj.name}
      currentTint={customized.tint || "brass"}
      onCustomized={handleProjectCustomized}
      onCancel={() => setShowProjectCustomizer(false)}
    />
  );
})()}
```

- [ ] **Step 9: Add delete confirmation dialog**

Add after ProjectCustomizeMenu:
```typescript
{deletingProjectId && (() => {
  const proj = recentProjects.find(p => p.id === deletingProjectId);
  if (!proj) return null;

  return (
    <ConfirmDialog
      title="Delete Project Permanently?"
      message={`This will permanently delete "${proj.name}" and ALL its workspaces from disk.`}
      confirmText="Delete"
      cancelText="Cancel"
      requireInput={proj.name}
      destructive
      onConfirm={() => handleConfirmDeleteProject(deletingProjectId)}
      onCancel={() => setDeletingProjectId(null)}
    />
  );
})()}
```

- [ ] **Step 10: Add imports**

At the top of App.tsx, add:
```typescript
import { ProjectContextMenu } from "./components/ProjectContextMenu";
import { ProjectCustomizeMenu } from "./components/ProjectCustomizeMenu";
```

- [ ] **Step 11: Run typecheck**

```bash
npm run typecheck
```

Expected: No errors

- [ ] **Step 12: Run tests**

```bash
npm test
```

Expected: All tests pass (may need to update existing tests for new state)

- [ ] **Step 13: Commit**

```bash
git add src/App.tsx
git commit -m "feat(app): add project management state, handlers, and components"
```

---

### Task 6: Create IPC methods and backend handlers (Rust)

**Files:**
- Modify: `src-tauri/src/commands.rs` or appropriate file
- Possibly modify: `src-tauri/src/db.rs` or project storage layer

- [ ] **Step 1: Review existing project handling in Rust code**

```bash
grep -n "list_recent_projects\|open_project" src-tauri/src/commands.rs | head -20
```

Understand: How projects are stored, how recent list is maintained

- [ ] **Step 2: Add `update_project_customization` command**

In commands.rs, add:
```rust
#[tauri::command]
pub async fn update_project_customization(
    state: State<'_, AppState>,
    project_id: String,
    name: Option<String>,
    tint: Option<String>,
) -> Result<(), String> {
    // Load projects from DB/storage
    // Find project by ID
    // Update name and/or tint
    // Save to DB/storage
    // Return success or error
    Ok(())
}
```

- [ ] **Step 3: Add `close_project` command**

```rust
#[tauri::command]
pub async fn close_project(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<(), String> {
    // Load recent projects list
    // Remove project_id from list
    // Save list
    // Return success or error
    Ok(())
}
```

- [ ] **Step 4: Add `delete_project` command (destructive)**

```rust
#[tauri::command]
pub async fn delete_project(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<(), String> {
    // Find project in DB
    // Get project directory path
    // Delete directory (recursively)
    // Remove from recent projects list
    // Remove from DB
    // Return success or error
    Err("Not yet implemented".to_string())
}
```

- [ ] **Step 5: Register commands in lib.rs invoke handler**

Update `lib.rs` to include the 3 new commands in the invoke handler:
```rust
commands::update_project_customization,
commands::close_project,
commands::delete_project,
```

- [ ] **Step 6: Create TypeScript type definitions for IPC methods**

In `src/lib/ipc.ts`, add:
```typescript
export const ipc = {
  // ... existing methods ...

  updateProjectCustomization: (projectId: string, name: string | null, tint: string | null) =>
    invoke<void>("update_project_customization", { project_id: projectId, name, tint }),

  closeProject: (projectId: string) =>
    invoke<void>("close_project", { project_id: projectId }),

  deleteProject: (projectId: string) =>
    invoke<void>("delete_project", { project_id: projectId }),
};
```

- [ ] **Step 7: Test IPC methods compile**

```bash
cd src-tauri && cargo check
```

Expected: No compilation errors

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/lib/ipc.ts
git commit -m "feat(backend): add project customization, close, and delete IPC methods"
```

---

### Task 7: Full integration test and bug fixes

**Files:**
- Modify: `src/App.tsx` (if needed for fixes)
- Add integration tests if needed

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: All tests pass. If not, note failures.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: No errors

- [ ] **Step 3: Build frontend**

```bash
npm run build
```

Expected: Build succeeds, no console errors

- [ ] **Step 4: Manual testing checklist**

- [ ] Add project from rail (◉ button) opens NewProjectFlow
- [ ] Right-click on project header shows context menu
- [ ] Context menu options:
  - [ ] "Rename project" opens modal
  - [ ] "Change tint" opens modal (tint picker)
  - [ ] Disabled items show "Coming soon" on hover
  - [ ] "Close project" removes from rail
  - [ ] "Delete project" shows confirmation with manual name entry
- [ ] Rename modal:
  - [ ] Pre-fills current name
  - [ ] Save updates rail and localStorage
- [ ] Tint modal:
  - [ ] Shows 9 colors
  - [ ] Selected tint is highlighted
  - [ ] Save updates rail and localStorage
- [ ] Delete confirmation:
  - [ ] Shows warning message
  - [ ] Input field with placeholder
  - [ ] "Delete" button disabled until exact name typed
  - [ ] Typing wrong name keeps button disabled
  - [ ] Typing correct name enables button
  - [ ] Cancel closes dialog without deleting
  - [ ] Delete removes project from disk and rail

- [ ] **Step 5: Commit integration fixes (if any)**

```bash
git add .
git commit -m "fix: integrate project management components and fix issues"
```

---

### Task 8: Polish and final testing

**Files:**
- Minimal changes; mostly testing and validation

- [ ] **Step 1: Test localStorage persistence**

- Rename project → close app → reopen → name should persist
- Change tint → close app → reopen → tint should persist

- [ ] **Step 2: Test error scenarios**

- IPC failure during save → should toast error and keep localStorage value
- Project not found → should toast error
- Permissions error on delete → should toast error with reason

- [ ] **Step 3: Test edge cases**

- Project name with special characters → should work
- Very long project name → should truncate in rail
- Collapse/expand with customized projects → should maintain values
- Switching projects and back → custom names/tints should persist

- [ ] **Step 4: Review design consistency**

- ProjectContextMenu styling matches WorkspaceContextMenu
- ProjectCustomizeMenu modal styling matches WorkspaceCustomizeMenu
- Color palette and spacing consistent with design system

- [ ] **Step 5: Final typecheck and build**

```bash
npm run typecheck && npm run build
```

Expected: No errors, no warnings

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat(project-management): complete implementation with testing and polish"
```

- [ ] **Step 7: Create summary for release notes**

Feature is complete and ready for v0.1.20 release.

Summary:
- ✅ Add projects from WorkspaceRail (◉ button)
- ✅ Customize projects (rename, tint) via right-click
- ✅ Close projects (remove from recent list)
- ✅ Delete projects from disk (with confirmation + manual name entry)
- ✅ Level 2/3 features stubbed as "Coming soon"
- ✅ Data persistence (localStorage + backend)
- ✅ Full test coverage

---

## Notes

- **localStorage schema:** `projectCustomizations: { projectId: { name, tint } }`
- **Backend persistence:** Implement in existing project storage layer (likely `db.rs` or similar)
- **Type consistency:** Ensure `projectId` is always `String` in Rust, not `&str` where possible
- **Error handling:** All IPC calls should return `Result<T, String>`; frontend toasts errors
- **Future expansion:** Level 2/3 menu items already in place, no UI restructuring needed when ready

