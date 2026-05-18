# Companion File Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the duplicative `CompanionChanged` panel in Review mode with an IDE-style lazy-expanding directory tree of the worktree root, rendered in the Atelier Onyx & Brass design language.

**Architecture:** A new `read_directory` Tauri command (using the `ignore` crate to respect `.gitignore`) feeds a new `CompanionFileTree` React component with lazy one-level-at-a-time expansion, cached per path in local state. `Companion.tsx` receives a `fileTree` prop that replaces `changedProps` in review mode; `App.tsx` computes it from existing `gitStatus` state — no new IPC polling. `CompanionChanged.tsx` is deleted.

**Tech Stack:** Rust (`ignore = "0.4"` crate, `serde`), Tauri 2 IPC, React 19 + TypeScript, Tailwind v4 tokens, Vitest + @testing-library/react.

---

## File map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src-tauri/Cargo.toml` | Add `ignore = "0.4"` dependency |
| Modify | `src-tauri/src/commands.rs` | Add `read_directory` command + `DirectoryEntry` struct |
| Modify | `src-tauri/src/lib.rs` | Register `commands::read_directory` in `generate_handler!` |
| Modify | `src-tauri/src/tests.rs` | Add `read_directory` integration test |
| Modify | `src/lib/types.ts` | Add `DirectoryEntry` interface |
| Modify | `src/lib/ipc.ts` | Add `readDirectory` wrapper |
| Create | `src/components/CompanionFileTree.tsx` | The tree component |
| Create | `src/components/CompanionFileTree.test.tsx` | Vitest tests for the tree |
| Modify | `src/components/Companion.tsx` | Replace `changedProps`/`CompanionChanged` with `fileTree`/`CompanionFileTree` |
| Modify | `src/components/Companion.test.tsx` | Update tests to match new `fileTree` prop |
| Modify | `src/App.tsx` | Compute `fileTreeProps` from `gitStatus`; pass to `<Companion>` |
| Delete | `src/components/CompanionChanged.tsx` | No longer used |

---

### Task 1: Add `ignore` crate to Cargo.toml

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add dependency**

Open `src-tauri/Cargo.toml`. After the `regex = "1"` line in `[dependencies]`, add:

```toml
ignore = "0.4"
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh/src-tauri && cargo check 2>&1 | tail -5
```

Expected: `Finished` with no errors (will download `ignore` crate on first run).

- [ ] **Step 3: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore(deps): add ignore crate for .gitignore-aware directory listing"
```

---

### Task 2: `read_directory` Rust command

**Files:**
- Modify: `src-tauri/src/commands.rs` (append before `// ─── Helpers` section at line ~878)

- [ ] **Step 1: Write the failing test first**

Open `src-tauri/src/tests.rs`. Append this new test module after the last `}` in the file:

```rust
#[cfg(test)]
mod read_directory_tests {
    use crate::commands::read_directory;
    use std::fs;
    use tempfile::TempDir;

    #[tokio::test]
    async fn lists_entries_respecting_gitignore() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();

        // Create subdir, a normal file, an ignored file, and a .gitignore.
        fs::create_dir(tmp.path().join("subdir")).unwrap();
        fs::write(tmp.path().join("file.txt"), "hello").unwrap();
        fs::write(tmp.path().join("ignored.txt"), "nope").unwrap();
        fs::write(tmp.path().join(".gitignore"), "ignored.txt\n").unwrap();

        let entries = read_directory(root).await.expect("should succeed");

        // Should NOT include ignored.txt or .git
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(!names.contains(&"ignored.txt"), "ignored.txt must be filtered");
        assert!(!names.contains(&".git"), ".git must be filtered");

        // Should include subdir, file.txt, .gitignore
        assert!(names.contains(&"subdir"), "subdir must appear");
        assert!(names.contains(&"file.txt"), "file.txt must appear");

        // Dirs sort before files
        let first = &entries[0];
        assert!(first.is_dir, "first entry must be a directory");

        // Within files, alphabetical
        let files: Vec<&str> = entries.iter().filter(|e| !e.is_dir).map(|e| e.name.as_str()).collect();
        let mut sorted = files.clone();
        sorted.sort_by_key(|s| s.to_lowercase());
        assert_eq!(files, sorted, "files must be sorted alphabetically");
    }

    #[tokio::test]
    async fn returns_error_for_nonexistent_path() {
        let result = read_directory("/nonexistent/path/abc123".to_string()).await;
        assert!(result.is_err(), "should return error for missing directory");
    }

    #[tokio::test]
    async fn one_level_only() {
        let tmp = TempDir::new().unwrap();
        let nested = tmp.path().join("a").join("b");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("deep.txt"), "x").unwrap();

        let entries = read_directory(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();

        // Should only see "a", not "a/b" or "a/b/deep.txt"
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "a");
    }
}
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh/src-tauri && cargo test read_directory 2>&1 | tail -20
```

Expected: compile error — `read_directory` not yet defined.

- [ ] **Step 3: Add `DirectoryEntry` struct and `read_directory` command to commands.rs**

Open `src-tauri/src/commands.rs`. Find the line `// ─── Helpers ─────────────────────────────────────────────────────────────────` (near line 878). Insert BEFORE it:

```rust
// ─── Directory listing ────────────────────────────────────────────

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// Read one level of a directory, respecting `.gitignore`.
/// Directories are returned first (alphabetical), then files (alphabetical).
/// `.git` is always excluded.
#[tauri::command]
pub async fn read_directory(path: String) -> AppResult<Vec<DirectoryEntry>> {
    let path = expand_tilde(&path);
    let base = std::path::Path::new(&path);

    if !base.exists() {
        return Err(AppError::Other(format!("Path does not exist: {}", path)));
    }
    if !base.is_dir() {
        return Err(AppError::Other(format!("Not a directory: {}", path)));
    }

    let mut dirs: Vec<DirectoryEntry> = Vec::new();
    let mut files: Vec<DirectoryEntry> = Vec::new();

    // WalkBuilder with max_depth(1) gives us the root entry + its direct children.
    // standard_filters(true) enables .gitignore, .ignore, hidden-file filtering.
    // We add_custom_ignore_filename(".gitignore") is already included in standard_filters.
    let walker = ignore::WalkBuilder::new(base)
        .max_depth(Some(1))
        .standard_filters(true)
        .hidden(false) // include dot-files like .gitignore itself; gitignore rules handle exclusions
        .build();

    for result in walker {
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };

        // Skip the root itself (depth 0).
        if entry.depth() == 0 {
            continue;
        }

        let entry_path = entry.path();
        let name = entry_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();

        // Always skip .git directory.
        if name == ".git" {
            continue;
        }

        let abs_path = entry_path.to_string_lossy().into_owned();
        let is_dir = entry_path.is_dir();

        let de = DirectoryEntry {
            name,
            path: abs_path,
            is_dir,
        };

        if is_dir {
            dirs.push(de);
        } else {
            files.push(de);
        }
    }

    // Sort each group alphabetically, case-insensitive.
    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    dirs.extend(files);
    Ok(dirs)
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh/src-tauri && cargo test read_directory 2>&1 | tail -20
```

Expected: all 3 tests pass.

- [ ] **Step 5: Register command in lib.rs**

Open `src-tauri/src/lib.rs`. Find the `// Terminals` block inside `generate_handler!`. After `commands::delete_terminal,`, add:

```rust
            // Directory listing
            commands::read_directory,
```

- [ ] **Step 6: Verify full cargo test still passes**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh/src-tauri && cargo test 2>&1 | tail -10
```

Expected: no failures.

- [ ] **Step 7: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/tests.rs
git commit -m "feat(backend): read_directory command with .gitignore support"
```

---

### Task 3: Frontend types + IPC wrapper

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/ipc.ts`

- [ ] **Step 1: Add `DirectoryEntry` to types.ts**

Open `src/lib/types.ts`. After the `FileChange` interface (around line 185), add:

```typescript
export interface DirectoryEntry {
  name: string;
  path: string;
  isDir: boolean;
}
```

- [ ] **Step 2: Add `readDirectory` to ipc.ts**

Open `src/lib/ipc.ts`. Add `DirectoryEntry` to the import list at the top:

```typescript
import type {
  // ... existing imports ...
  DirectoryEntry,
} from "./types";
```

Then in the `ipc` object, after `revealInFinder`, add:

```typescript
  // ─── Directory listing ─────────────────────────────────────────
  readDirectory: (path: string) => invoke<DirectoryEntry[]>("read_directory", { path }),
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm run typecheck 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src/lib/types.ts src/lib/ipc.ts
git commit -m "feat(types): DirectoryEntry type + readDirectory IPC wrapper"
```

---

### Task 4: `CompanionFileTree` component — write tests first

**Files:**
- Create: `src/components/CompanionFileTree.test.tsx`

- [ ] **Step 1: Write tests**

Create `src/components/CompanionFileTree.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock IPC before importing the component.
const mockReadDirectory = vi.fn();
vi.mock("../lib/ipc", () => ({
  ipc: { readDirectory: mockReadDirectory },
}));

// Import after mock is set up.
import { CompanionFileTree } from "./CompanionFileTree";

const ROOT = "/repo";
const CHANGED = new Set(["/repo/src/Main.java"]);

const ROOT_CHILDREN = [
  { name: "src", path: "/repo/src", isDir: true },
  { name: "docs", path: "/repo/docs", isDir: true },
  { name: "pom.xml", path: "/repo/pom.xml", isDir: false },
];

const SRC_CHILDREN = [
  { name: "Main.java", path: "/repo/src/Main.java", isDir: false },
  { name: "Helper.java", path: "/repo/src/Helper.java", isDir: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  // Default: root children resolve immediately.
  mockReadDirectory.mockImplementation((path: string) => {
    if (path === ROOT) return Promise.resolve(ROOT_CHILDREN);
    if (path === "/repo/src") return Promise.resolve(SRC_CHILDREN);
    return Promise.resolve([]);
  });
});

describe("CompanionFileTree", () => {
  it("renders FILES eyebrow header", async () => {
    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("FILES")).toBeInTheDocument());
  });

  it("renders root label in italic serif", async () => {
    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => {
      const label = screen.getByText("my-project");
      expect(label).toBeInTheDocument();
    });
  });

  it("root starts expanded — shows root children", async () => {
    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => {
      expect(screen.getByText("src")).toBeInTheDocument();
      expect(screen.getByText("pom.xml")).toBeInTheDocument();
    });
  });

  it("expanding src/ calls readDirectory and shows children", async () => {
    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());

    await userEvent.click(screen.getByText("src"));

    await waitFor(() => {
      expect(mockReadDirectory).toHaveBeenCalledWith("/repo/src");
      expect(screen.getByText("Main.java")).toBeInTheDocument();
      expect(screen.getByText("Helper.java")).toBeInTheDocument();
    });
  });

  it("does NOT re-fetch when a folder is collapsed and re-expanded", async () => {
    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());

    await userEvent.click(screen.getByText("src"));
    await waitFor(() => expect(screen.getByText("Main.java")).toBeInTheDocument());

    // Collapse
    await userEvent.click(screen.getByText("src"));
    await waitFor(() => expect(screen.queryByText("Main.java")).not.toBeInTheDocument());

    // Re-expand — should NOT fire another readDirectory call
    await userEvent.click(screen.getByText("src"));
    await waitFor(() => expect(screen.getByText("Main.java")).toBeInTheDocument());

    // readDirectory for /repo/src was called only once (plus once for ROOT on mount)
    expect(mockReadDirectory).toHaveBeenCalledTimes(2); // ROOT + src once each
  });

  it("shows brass dot for changed files", async () => {
    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());

    await userEvent.click(screen.getByText("src"));
    await waitFor(() => expect(screen.getByText("Main.java")).toBeInTheDocument());

    // Main.java is in CHANGED — its row should contain ●
    const mainRow = screen.getByTestId("file-row-/repo/src/Main.java");
    expect(mainRow.textContent).toContain("●");

    // Helper.java is NOT in CHANGED — its row should contain ◦ (or no ●)
    const helperRow = screen.getByTestId("file-row-/repo/src/Helper.java");
    expect(helperRow.textContent).not.toContain("●");
  });

  it("shows loading indicator while a folder fetch is in progress", async () => {
    let resolve!: (v: typeof SRC_CHILDREN) => void;
    mockReadDirectory.mockImplementationOnce(() => Promise.resolve(ROOT_CHILDREN));
    mockReadDirectory.mockImplementationOnce(
      () => new Promise((res) => { resolve = res; })
    );

    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());

    await userEvent.click(screen.getByText("src"));
    // Loading row should appear
    expect(screen.getByText("loading…")).toBeInTheDocument();

    // Resolve the fetch
    resolve(SRC_CHILDREN);
    await waitFor(() => expect(screen.queryByText("loading…")).not.toBeInTheDocument());
    expect(screen.getByText("Main.java")).toBeInTheDocument();
  });

  it("shows empty indicator for an empty folder", async () => {
    mockReadDirectory.mockImplementation((path: string) => {
      if (path === ROOT) return Promise.resolve([{ name: "empty-dir", path: "/repo/empty-dir", isDir: true }]);
      return Promise.resolve([]);
    });

    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={new Set()} />);
    await waitFor(() => expect(screen.getByText("empty-dir")).toBeInTheDocument());

    await userEvent.click(screen.getByText("empty-dir"));
    await waitFor(() => expect(screen.getByText("empty.")).toBeInTheDocument());
  });

  it("collapsing root hides all children", async () => {
    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());

    // Click root label to collapse
    await userEvent.click(screen.getByText("my-project"));
    await waitFor(() => expect(screen.queryByText("src")).not.toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm test -- CompanionFileTree 2>&1 | tail -20
```

Expected: all tests fail — module not found.

---

### Task 5: `CompanionFileTree` component — implementation

**Files:**
- Create: `src/components/CompanionFileTree.tsx`

- [ ] **Step 1: Implement the component**

Create `src/components/CompanionFileTree.tsx`:

```typescript
import { useState, useEffect, useCallback } from "react";
import { ipc } from "../lib/ipc";
import type { DirectoryEntry } from "../lib/types";

interface Props {
  rootPath: string;
  rootLabel: string;
  changedPaths: Set<string>;
}

type ChildState = DirectoryEntry[] | "loading" | "error";

export function CompanionFileTree({ rootPath, rootLabel, changedPaths }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set([rootPath]));
  const [children, setChildren] = useState<Record<string, ChildState>>({});

  const fetchChildren = useCallback(
    async (path: string) => {
      if (children[path] && children[path] !== "error") return; // already cached
      setChildren((prev) => ({ ...prev, [path]: "loading" }));
      try {
        const entries = await ipc.readDirectory(path);
        setChildren((prev) => ({ ...prev, [path]: entries }));
      } catch {
        setChildren((prev) => ({ ...prev, [path]: "error" }));
      }
    },
    [children],
  );

  // Eagerly load root on mount.
  useEffect(() => {
    fetchChildren(rootPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath]);

  const toggleExpand = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          fetchChildren(path);
        }
        return next;
      });
    },
    [fetchChildren],
  );

  return (
    <section>
      {/* Eyebrow header */}
      <h3 className="border-b border-octo-hairline pb-2 font-mono text-[8px] uppercase tracking-[0.3em] text-octo-brass">
        Files
      </h3>

      <div className="mt-2 overflow-y-auto">
        <TreeNode
          path={rootPath}
          label={rootLabel}
          isDir={true}
          depth={0}
          isRoot={true}
          expanded={expanded}
          children={children}
          changedPaths={changedPaths}
          onToggle={toggleExpand}
        />
      </div>
    </section>
  );
}

interface TreeNodeProps {
  path: string;
  label: string;
  isDir: boolean;
  depth: number;
  isRoot: boolean;
  expanded: Set<string>;
  children: Record<string, ChildState>;
  changedPaths: Set<string>;
  onToggle: (path: string) => void;
}

function TreeNode({
  path,
  label,
  isDir,
  depth,
  isRoot,
  expanded,
  children,
  changedPaths,
  onToggle,
}: TreeNodeProps) {
  const isExpanded = expanded.has(path);
  const isChanged = !isDir && changedPaths.has(path);

  return (
    <div>
      {/* Row */}
      <div
        className="group relative flex cursor-pointer items-center gap-1 rounded-sm py-[2px] pr-1 transition-colors duration-[220ms]"
        style={{
          paddingLeft: `${depth * 14 + 4}px`,
          background: "transparent",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background = "var(--brass-ghost)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
        onClick={() => {
          if (isDir) onToggle(path);
        }}
        data-testid={!isDir ? `file-row-${path}` : undefined}
      >
        {/* Indent guides — one 1px hairline per depth level */}
        {depth > 0 && (
          <IndentGuides depth={depth} />
        )}

        {/* Chevron or dot indicator */}
        {isDir ? (
          <span
            className="shrink-0 font-mono text-[9px] transition-colors duration-[220ms]"
            style={{
              color: isExpanded || isRoot ? "var(--color-octo-brass)" : "var(--color-octo-sage)",
              transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
              display: "inline-block",
              transition: "transform 220ms cubic-bezier(0.2,0.8,0.3,1), color 220ms",
            }}
          >
            ▶
          </span>
        ) : (
          <span
            className="shrink-0 font-mono text-[10px]"
            style={{
              color: isChanged ? "var(--color-octo-brass)" : "var(--color-octo-mute)",
            }}
          >
            {isChanged ? "●" : "◦"}
          </span>
        )}

        {/* Label */}
        {isRoot ? (
          <span
            className="min-w-0 truncate font-serif italic text-[13px] text-octo-ivory"
          >
            {label}
          </span>
        ) : (
          <span
            className="min-w-0 truncate font-mono text-[11px]"
            style={{
              color: isChanged ? "var(--color-octo-ivory)" : "var(--color-octo-sage)",
            }}
          >
            {label}
          </span>
        )}
      </div>

      {/* Children (only if dir + expanded) */}
      {isDir && isExpanded && (
        <div>
          {(() => {
            const state = children[path];
            if (!state || state === "loading") {
              return (
                <div
                  className="py-[2px] font-serif italic text-[11px] text-octo-mute"
                  style={{ paddingLeft: `${(depth + 1) * 14 + 4}px` }}
                >
                  loading…
                </div>
              );
            }
            if (state === "error") {
              return (
                <div
                  className="py-[2px] font-serif italic text-[11px] text-octo-rouge"
                  style={{ paddingLeft: `${(depth + 1) * 14 + 4}px` }}
                >
                  error reading directory.
                </div>
              );
            }
            if (state.length === 0) {
              return (
                <div
                  className="py-[2px] font-serif italic text-[11px] text-octo-mute"
                  style={{ paddingLeft: `${(depth + 1) * 14 + 4}px` }}
                >
                  empty.
                </div>
              );
            }
            return state.map((entry) => (
              <TreeNode
                key={entry.path}
                path={entry.path}
                label={entry.name}
                isDir={entry.isDir}
                depth={depth + 1}
                isRoot={false}
                expanded={expanded}
                children={children}
                changedPaths={changedPaths}
                onToggle={onToggle}
              />
            ));
          })()}
        </div>
      )}
    </div>
  );
}

function IndentGuides({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="pointer-events-none absolute top-0 bottom-0 border-l"
          style={{
            left: `${i * 14 + 10}px`,
            borderColor: "rgba(212, 165, 116, 0.4)", // --brass-dim
          }}
        />
      ))}
    </>
  );
}
```

- [ ] **Step 2: Run tests**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm test -- CompanionFileTree 2>&1 | tail -30
```

Expected: all 8 tests pass.

- [ ] **Step 3: Typecheck**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm run typecheck 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src/components/CompanionFileTree.tsx src/components/CompanionFileTree.test.tsx
git commit -m "feat(ui): CompanionFileTree — Atelier-styled lazy file tree"
```

---

### Task 6: Wire `CompanionFileTree` into `Companion.tsx`

**Files:**
- Modify: `src/components/Companion.tsx`
- Modify: `src/components/Companion.test.tsx`
- Delete: `src/components/CompanionChanged.tsx`

- [ ] **Step 1: Rewrite Companion.tsx**

Replace the full content of `src/components/Companion.tsx` with:

```typescript
import type { WorkspaceMode } from "../lib/modes";
import { CompanionContext } from "./CompanionContext";
import { CompanionHistory, type CompanionHistoryChat } from "./CompanionHistory";
import { CompanionTerminals } from "./CompanionTerminals";
import { CompanionFileTree } from "./CompanionFileTree";

interface ContextProps {
  tokensUsed: number;
  tokensLimit: number;
  filesInFlight: number;
  toolCalls: number;
}

interface HistoryProps {
  chats: CompanionHistoryChat[];
  activeChatId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
}

interface FileTreeProps {
  rootPath: string;
  rootLabel: string;
  changedPaths: Set<string>;
}

interface Props {
  mode: WorkspaceMode;
  workspaceId: string | null;
  contextProps: ContextProps;
  historyProps: HistoryProps;
  fileTree?: FileTreeProps;
}

export function Companion({
  mode,
  workspaceId,
  contextProps,
  historyProps,
  fileTree,
}: Props) {
  return (
    <aside
      className="m-4 ml-0 flex w-[280px] flex-col gap-4 rounded-xl border border-octo-hairline bg-octo-panel p-4"
      aria-label="Companion"
    >
      {mode === "talk" && (
        <>
          <CompanionContext {...contextProps} />
          <CompanionHistory {...historyProps} />
        </>
      )}
      {mode === "run" && workspaceId && (
        <CompanionTerminals workspaceId={workspaceId} />
      )}
      {mode === "review" && fileTree && (
        <CompanionFileTree {...fileTree} />
      )}
    </aside>
  );
}
```

- [ ] **Step 2: Update Companion.test.tsx**

Replace the full content of `src/components/Companion.test.tsx` with:

```typescript
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Companion } from "./Companion";

// Mock child companions so they don't hit real store/IPC.
vi.mock("./CompanionTerminals", () => ({
  CompanionTerminals: ({ workspaceId }: { workspaceId: string }) => (
    <div>Terminals({workspaceId})</div>
  ),
}));

vi.mock("./CompanionFileTree", () => ({
  CompanionFileTree: ({ rootLabel }: { rootLabel: string }) => (
    <div>FileTree({rootLabel})</div>
  ),
}));

const defaultProps = {
  workspaceId: "ws-1",
  contextProps: { tokensUsed: 42000, tokensLimit: 200000, filesInFlight: 3, toolCalls: 7 },
  historyProps: { chats: [], activeChatId: null, onSelectChat: () => {}, onNewChat: () => {} },
};

const fileTree = {
  rootPath: "/repo",
  rootLabel: "my-project",
  changedPaths: new Set<string>(),
};

describe("Companion", () => {
  it("renders Context and History sections in talk mode", () => {
    render(<Companion mode="talk" {...defaultProps} />);
    expect(screen.getByText(/^context$/i)).toBeInTheDocument();
    expect(screen.getByText(/^history$/i)).toBeInTheDocument();
  });

  it("renders Terminals section in run mode", () => {
    render(<Companion mode="run" {...defaultProps} />);
    expect(screen.getByText(/Terminals/i)).toBeInTheDocument();
  });

  it("does not render Terminals when workspaceId is null in run mode", () => {
    render(<Companion mode="run" {...defaultProps} workspaceId={null} />);
    expect(screen.queryByText(/Terminals/i)).not.toBeInTheDocument();
  });

  it("renders FileTree in review mode when fileTree prop is provided", () => {
    render(<Companion mode="review" {...defaultProps} fileTree={fileTree} />);
    expect(screen.getByText(/FileTree\(my-project\)/i)).toBeInTheDocument();
  });

  it("renders nothing in review mode when fileTree prop is absent", () => {
    render(<Companion mode="review" {...defaultProps} />);
    // Should not render any content in the companion aside beyond the container
    expect(screen.queryByText(/FileTree/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Delete CompanionChanged.tsx**

```bash
rm /Users/jonathan/TYPEFY/octopus/octopus-sh/src/components/CompanionChanged.tsx
```

- [ ] **Step 4: Typecheck**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm run typecheck 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 5: Run tests**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm test -- Companion 2>&1 | tail -20
```

Expected: all Companion tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src/components/Companion.tsx src/components/Companion.test.tsx
git rm src/components/CompanionChanged.tsx
git commit -m "refactor(companion): replace CompanionChanged with CompanionFileTree in review mode"
```

---

### Task 7: Wire `fileTreeProps` in App.tsx

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Update App.tsx**

Open `src/App.tsx`. Find the `companionChangedProps` useMemo block (around line 306):

```typescript
  const companionChangedProps = useMemo(
    () => ({ changedFiles: gitStatus?.changedFiles ?? [] }),
    [gitStatus],
  );
```

Replace it with:

```typescript
  const fileTreeProps = useMemo(() => {
    if (!activeWorkspace) return undefined;
    const rootPath = activeWorkspace.worktreePath || project!.path;
    return {
      rootPath,
      rootLabel: activeWorkspace.name,
      changedPaths: new Set(
        (gitStatus?.changedFiles ?? []).map((f) => `${rootPath}/${f.path}`),
      ),
    };
  }, [activeWorkspace, project, gitStatus]);
```

- [ ] **Step 2: Update the Companion render call**

Find the `<Companion` render (around line 459):

```tsx
              <Companion
                mode={activeMode}
                workspaceId={activeWorkspaceId}
                contextProps={companionContextProps}
                historyProps={companionHistoryProps}
                changedProps={companionChangedProps}
              />
```

Replace with:

```tsx
              <Companion
                mode={activeMode}
                workspaceId={activeWorkspaceId}
                contextProps={companionContextProps}
                historyProps={companionHistoryProps}
                fileTree={fileTreeProps}
              />
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm run typecheck 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 4: Run all frontend tests**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm test 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 5: Run Rust tests**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh/src-tauri && cargo test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src/App.tsx
git commit -m "feat(app): wire fileTreeProps into Companion for review mode file tree"
```

---

### Task 8: Final verification + cleanup commit

- [ ] **Step 1: Full typecheck**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm run typecheck 2>&1
```

Expected: zero errors.

- [ ] **Step 2: Full test suite**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm test 2>&1 | tail -30
```

Expected: all tests pass, none skipped unexpectedly.

- [ ] **Step 3: Rust test suite**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh/src-tauri && cargo test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 4: Grep for hex literals in changed files (design constraint)**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && git diff main...HEAD -- src/components/CompanionFileTree.tsx | grep -E '#[0-9a-fA-F]{3,8}' || echo "clean — no hex literals"
```

Expected: only the `--brass-dim` rgba comment in the `IndentGuides` component (which references `var(--brass-dim)` semantically); no raw color values on UI elements.

Note: The `rgba(212, 165, 116, 0.4)` in `IndentGuides` for the border-color is a CSS variable value reproduction (`--brass-dim`). If this is flagged as a concern, replace it with an inline style `borderColor: "var(--brass-dim)"` — both resolve identically since `--brass-dim` is defined as that exact rgba in `styles.css`.

- [ ] **Step 5: Confirm CompanionChanged is gone**

```bash
ls /Users/jonathan/TYPEFY/octopus/octopus-sh/src/components/CompanionChanged.tsx 2>&1
```

Expected: `No such file or directory`.

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|-----------------|------|
| `read_directory` Rust command with `ignore` crate | Task 1 + 2 |
| `DirectoryEntry` type + IPC wrapper | Task 3 |
| `CompanionFileTree` with lazy expand, root expanded | Task 5 |
| Eyebrow header `FILES` in brass | Task 5 |
| Root row in Spectral italic ivory | Task 5 |
| Folder rows: JetBrains Mono sage | Task 5 |
| File rows: `●` brass if changed, `◦` mute otherwise | Task 5 |
| Indent guides: 1px brass-dim hairlines | Task 5 |
| Hover `bg-brass-ghost` | Task 5 |
| Loading state: italic-serif `loading…` | Task 5 |
| Empty folder: italic-serif `empty.` | Task 5 |
| Cache (no re-fetch on re-expand) | Task 5 |
| Replace `CompanionChanged` in Companion | Task 6 |
| Delete `CompanionChanged.tsx` | Task 6 |
| `fileTreeProps` from `gitStatus` in App.tsx | Task 7 |
| `changedPaths` built from existing `gitStatus` (no duplicate IPC) | Task 7 |
| Vitest tests: tree expand, brass dot, loading, empty, cache | Task 4 |
| Rust test: gitignore filtering, dirs-first, one-level | Task 2 |

**Placeholder scan:** None found — all steps have code.

**Type consistency:**
- `DirectoryEntry` defined in Task 3, used in Task 5 via import.
- `FileTreeProps` interface defined in Task 6 (Companion.tsx), matches `fileTreeProps` shape in Task 7.
- `changedPaths: Set<string>` consistently typed throughout.
