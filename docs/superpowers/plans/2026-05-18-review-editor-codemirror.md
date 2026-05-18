# Review Mode CodeMirror Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full CodeMirror 6 editor to Review mode — click a file in the right Companion tree → opens in the middle canvas → edit → ⌘S saves to disk → tabs for multiple open files → diff gutter markers for unstaged changes.

**Architecture:** The editor state lives in a new Zustand store (`editorStore`) following the exact per-workspace pattern of `terminalsStore` (stable `EMPTY_FILES` constant, per-workspace keys). CodeMirror 6 is wired imperatively via a `useEffect` in `EditorPane.tsx` (no React adapter). The unified diff already fetched by `ChangesPanel` is lifted to `App.tsx` state so both `ChangesPanel` and `EditorPane` share one poll without duplication.

**Tech Stack:** CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, language packages), Zustand, Tauri IPC (new `read_file`/`write_file` Rust commands), React 19, TypeScript, Vitest + Testing Library.

---

## File Map

### New files
| Path | Responsibility |
|------|---------------|
| `src/stores/editorStore.ts` | Per-workspace open-files state, `openFile`/`closeFile`/`saveActive` actions |
| `src/lib/editorLang.ts` | `langForExtension(path)` → CodeMirror language id string |
| `src/lib/diffParser.ts` | `parseDiffForFile(diff, relPath)` → `DiffLineMarker[]` |
| `src/components/editor/atelierTheme.ts` | CodeMirror `Extension` — Onyx & Brass theme + syntax highlighting |
| `src/components/editor/diffGutter.ts` | CodeMirror gutter extension from `DiffLineMarker[]` |
| `src/components/EditorPane.tsx` | Middle-canvas CodeMirror mount, ⌘S keybinding |
| `src/components/EditorTabs.tsx` | Tab strip above the editor |
| `src/stores/editorStore.test.ts` | Store unit tests |
| `src/lib/editorLang.test.ts` | Lang-detection unit tests |
| `src/lib/diffParser.test.ts` | Diff-parser unit tests |
| `src/components/EditorPane.test.tsx` | Component wrapper tests (no CM internals) |
| `src/components/EditorTabs.test.tsx` | Tab strip tests |

### Modified files
| Path | Change |
|------|--------|
| `src-tauri/src/commands.rs` | Add `read_file` and `write_file` commands |
| `src-tauri/src/lib.rs` | Register `read_file`/`write_file` in invoke handler |
| `src-tauri/src/tests.rs` | Add `file_io_tests` module |
| `src/lib/ipc.ts` | Add `readFile`/`writeFile` wrappers |
| `src/styles.css` | Add `--brass-faint` CSS variable to `:root` block |
| `src/components/CompanionFileTree.tsx` | Add optional `onFileClick` prop, wire to file row `onClick` |
| `src/components/CompanionFileTree.test.tsx` | Add `onFileClick` invocation test |
| `src/components/Companion.tsx` | Thread `onFileClick` through `FileTreeProps` |
| `src/App.tsx` | Lift `gitDiff` state, wire `EditorPane`/`EditorTabs`, pass `onFileClick` |

---

## Task 1: Rust — `read_file` and `write_file` commands

**Files:**
- Modify: `src-tauri/src/commands.rs` (after line 960, before the `expand_tilde` helper)
- Modify: `src-tauri/src/lib.rs` (in the `generate_handler!` list, under "Directory listing")
- Modify: `src-tauri/src/tests.rs` (add `file_io_tests` module at the end)

- [ ] **Step 1: Write the failing tests**

Add this module at the end of `src-tauri/src/tests.rs`, just before the final `}`:

```rust
#[cfg(test)]
mod file_io_tests {
    use crate::commands::{read_file, write_file};
    use std::fs;
    use tempfile::TempDir;

    #[tokio::test]
    async fn read_file_returns_content() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("hello.txt");
        fs::write(&path, "hello world").unwrap();

        let content = read_file(path.to_string_lossy().to_string())
            .await
            .expect("read_file should succeed");
        assert_eq!(content, "hello world");
    }

    #[tokio::test]
    async fn write_file_persists() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("out.txt");

        write_file(path.to_string_lossy().to_string(), "written".to_string())
            .await
            .expect("write_file should succeed");

        let on_disk = fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk, "written");
    }

    #[tokio::test]
    async fn read_file_errors_on_missing() {
        let result = read_file("/nonexistent/path/missing_abc123.txt".to_string()).await;
        assert!(result.is_err());
        let msg = format!("{:?}", result.unwrap_err());
        assert!(
            msg.contains("missing_abc123.txt"),
            "error message should mention the path, got: {msg}"
        );
    }

    #[tokio::test]
    async fn write_file_creates_parent_file_on_existing_dir() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("newfile.txt");

        write_file(path.to_string_lossy().to_string(), "content".to_string())
            .await
            .unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "content");
    }
}
```

- [ ] **Step 2: Run tests to confirm they FAIL**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh/src-tauri && cargo test file_io_tests 2>&1 | tail -20
```

Expected: compile error — `read_file` and `write_file` not found.

- [ ] **Step 3: Add the two commands to `commands.rs`**

Add these two functions just before the `// ─── Helpers ──────────────────────────────────────────────────────` section (around line 962):

```rust
// ─── File I/O ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn read_file(path: String) -> AppResult<String> {
    let path = expand_tilde(&path);
    std::fs::read_to_string(&path)
        .map_err(|e| AppError::Other(format!("read_file({}): {e}", path)))
}

#[tauri::command]
pub async fn write_file(path: String, content: String) -> AppResult<()> {
    let path = expand_tilde(&path);
    std::fs::write(&path, content)
        .map_err(|e| AppError::Other(format!("write_file({}): {e}", path)))
}
```

- [ ] **Step 4: Register in `lib.rs` invoke handler**

In `src-tauri/src/lib.rs`, after the `commands::read_directory,` line (around line 103), add:

```rust
            // File I/O
            commands::read_file,
            commands::write_file,
```

- [ ] **Step 5: Run tests — expect PASS**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh/src-tauri && cargo test file_io_tests 2>&1 | tail -20
```

Expected:
```
test file_io_tests::read_file_returns_content ... ok
test file_io_tests::write_file_persists ... ok
test file_io_tests::read_file_errors_on_missing ... ok
test file_io_tests::write_file_creates_parent_file_on_existing_dir ... ok
```

- [ ] **Step 6: Run full Rust test suite to verify no regressions**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh/src-tauri && cargo test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/tests.rs
git commit -m "feat(backend): add read_file and write_file Tauri commands"
```

---

## Task 2: Install CodeMirror 6 packages

**Files:**
- Modify: `package.json` (via npm install)

- [ ] **Step 1: Install packages**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm install \
  codemirror \
  @codemirror/state \
  @codemirror/view \
  @codemirror/commands \
  @codemirror/language \
  @codemirror/lang-javascript \
  @codemirror/lang-rust \
  @codemirror/lang-python \
  @codemirror/lang-java \
  @codemirror/lang-json \
  @codemirror/lang-markdown \
  @codemirror/lang-html \
  @codemirror/lang-css \
  @codemirror/lang-xml \
  @codemirror/lang-yaml
```

- [ ] **Step 2: Verify install — packages appear in node_modules**

```bash
ls /Users/jonathan/TYPEFY/octopus/octopus-sh/node_modules/@codemirror/ | sort
```

Expected: `commands`, `language`, `lang-css`, `lang-html`, `lang-java`, `lang-javascript`, `lang-json`, `lang-markdown`, `lang-python`, `lang-rust`, `lang-xml`, `lang-yaml`, `state`, `view` (plus others that are transitive deps).

- [ ] **Step 3: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add package.json package-lock.json
git commit -m "chore: install CodeMirror 6 packages"
```

---

## Task 3: IPC wrappers + CSS token

**Files:**
- Modify: `src/lib/ipc.ts` (add `readFile` / `writeFile` to the `ipc` object)
- Modify: `src/styles.css` (add `--brass-faint` to `:root` block)

- [ ] **Step 1: Add `--brass-faint` to styles.css**

In `src/styles.css`, find the `:root` block (around line 38). Add a new line after `--brass-ghost`:

```css
  --brass-faint: rgba(212, 165, 116, 0.04);
```

The full `:root` block should look like:

```css
:root {
  --brass-dim:   rgba(212, 165, 116, 0.4);
  --brass-ghost: rgba(212, 165, 116, 0.08);
  --brass-faint: rgba(212, 165, 116, 0.04);

  /* Motion */
  --ease-octo:    cubic-bezier(0.2, 0.8, 0.3, 1);
  ...
```

- [ ] **Step 2: Add IPC wrappers to `ipc.ts`**

In `src/lib/ipc.ts`, add after the `revealInFinder` entry (in the `// ─── File operations ───────────────────────────────────────────` section):

```typescript
  readFile: (path: string) => invoke<string>("read_file", { path }),
  writeFile: (path: string, content: string) => invoke<void>("write_file", { path, content }),
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm run typecheck 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src/lib/ipc.ts src/styles.css
git commit -m "feat(ipc): add readFile/writeFile wrappers + brass-faint token"
```

---

## Task 4: `editorLang.ts` + tests

**Files:**
- Create: `src/lib/editorLang.ts`
- Create: `src/lib/editorLang.test.ts`

- [ ] **Step 1: Write the failing tests first**

Create `src/lib/editorLang.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { langForExtension } from "./editorLang";

describe("langForExtension", () => {
  it.each([
    ["/a/b/foo.js",   "javascript"],
    ["/a/b/foo.jsx",  "javascript"],
    ["/a/b/foo.ts",   "javascript"],
    ["/a/b/foo.tsx",  "javascript"],
    ["/a/b/foo.mjs",  "javascript"],
    ["/a/b/foo.cjs",  "javascript"],
    ["/a/b/main.rs",  "rust"],
    ["/a/b/app.py",   "python"],
    ["/a/b/Main.java","java"],
    ["/a/b/pkg.json", "json"],
    ["/a/b/README.md","markdown"],
    ["/a/b/page.html","html"],
    ["/a/b/page.htm", "html"],
    ["/a/b/base.css", "css"],
    ["/a/b/main.scss","css"],
    ["/a/b/data.xml", "xml"],
    ["/a/b/icon.svg", "xml"],
    ["/a/b/ci.yaml",  "yaml"],
    ["/a/b/ci.yml",   "yaml"],
    ["/a/b/Makefile", "plaintext"],
    ["/a/b/no-ext",   "plaintext"],
  ])("langForExtension(%s) = %s", (path, expected) => {
    expect(langForExtension(path)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run tests — confirm FAIL**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm test -- editorLang 2>&1 | tail -10
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `editorLang.ts`**

Create `src/lib/editorLang.ts`:

```typescript
/**
 * Maps a file path's extension to a CodeMirror language identifier.
 * Used by EditorPane to pick the correct language support extension.
 */

export type LangId =
  | "javascript"
  | "rust"
  | "python"
  | "java"
  | "json"
  | "markdown"
  | "html"
  | "css"
  | "xml"
  | "yaml"
  | "plaintext";

export function langForExtension(path: string): LangId {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "plaintext";
  const ext = path.slice(dot + 1).toLowerCase();

  switch (ext) {
    case "js":
    case "jsx":
    case "ts":
    case "tsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "rs":
      return "rust";
    case "py":
      return "python";
    case "java":
      return "java";
    case "json":
      return "json";
    case "md":
    case "markdown":
      return "markdown";
    case "html":
    case "htm":
      return "html";
    case "css":
    case "scss":
      return "css";
    case "xml":
    case "svg":
      return "xml";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return "plaintext";
  }
}
```

- [ ] **Step 4: Run tests — confirm PASS**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm test -- editorLang 2>&1 | tail -10
```

Expected: 20 passing.

- [ ] **Step 5: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src/lib/editorLang.ts src/lib/editorLang.test.ts
git commit -m "feat(lib): editorLang — extension to CodeMirror language id"
```

---

## Task 5: `diffParser.ts` + tests

**Files:**
- Create: `src/lib/diffParser.ts`
- Create: `src/lib/diffParser.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/diffParser.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseDiffForFile } from "./diffParser";

// A minimal two-file unified diff fixture.
const SAMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,7 @@
 line1
+added_line_2
+added_line_3
 line3
-deleted_line_4
 line5
diff --git a/src/bar.ts b/src/bar.ts
index 111..222 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -10,3 +10,4 @@
 context
+new_line_in_bar
 context2
`;

describe("parseDiffForFile", () => {
  it("extracts added markers for a specific file", () => {
    const markers = parseDiffForFile(SAMPLE_DIFF, "src/foo.ts");
    const added = markers.filter((m) => m.kind === "added");
    // Lines 2 and 3 in the new file are added
    expect(added.length).toBe(2);
    expect(added[0].line).toBe(2);
    expect(added[1].line).toBe(3);
  });

  it("extracts removed-after markers for deleted lines", () => {
    const markers = parseDiffForFile(SAMPLE_DIFF, "src/foo.ts");
    const removed = markers.filter((m) => m.kind === "removed-after");
    // deleted_line_4 was deleted; its removed-after marker goes on the line
    // that follows in the new file (line 4 after insertions, i.e., line 4).
    expect(removed.length).toBe(1);
  });

  it("returns empty array for a file not in the diff", () => {
    const markers = parseDiffForFile(SAMPLE_DIFF, "src/not_in_diff.ts");
    expect(markers).toEqual([]);
  });

  it("parses bar.ts independently of foo.ts", () => {
    const markers = parseDiffForFile(SAMPLE_DIFF, "src/bar.ts");
    const added = markers.filter((m) => m.kind === "added");
    expect(added.length).toBe(1);
    expect(added[0].line).toBe(11);
  });

  it("returns empty array for empty diff string", () => {
    expect(parseDiffForFile("", "src/foo.ts")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests — confirm FAIL**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm test -- diffParser 2>&1 | tail -10
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `diffParser.ts`**

Create `src/lib/diffParser.ts`:

```typescript
/**
 * Parses a unified diff string and extracts per-file line markers
 * for use with the CodeMirror diff gutter.
 */

export interface DiffLineMarker {
  /** 1-based line number in the NEW (post-diff) file. */
  line: number;
  /** "added" = this line was inserted; "removed-after" = deletions preceded this line. */
  kind: "added" | "removed-after";
}

/**
 * Extract `DiffLineMarker[]` for a single file within a unified diff.
 *
 * @param diff    Full unified diff text (output of `git diff`).
 * @param relPath Relative path of the file to extract (e.g. "src/foo.ts").
 *                Must match the path as it appears after "b/" in the diff header.
 */
export function parseDiffForFile(diff: string, relPath: string): DiffLineMarker[] {
  if (!diff) return [];

  // Split the diff into per-file sections by the "diff --git" boundary.
  const fileSections = diff.split(/^diff --git /m).slice(1);

  // Find the section for our target file.
  const targetSection = fileSections.find((section) => {
    // The first line is "a/path b/path"
    const header = section.split("\n")[0] ?? "";
    return header.includes(`b/${relPath}`);
  });

  if (!targetSection) return [];

  const markers: DiffLineMarker[] = [];
  const lines = targetSection.split("\n");

  // Current position in the NEW file (1-based).
  let newLine = 0;
  // Count of consecutive "-" lines pending a "removed-after" marker.
  let pendingRemovals = 0;

  for (const line of lines) {
    // Hunk header: @@ -old_start,old_count +new_start,new_count @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLine = parseInt(hunkMatch[1], 10) - 1; // will be incremented on first context/+ line
      pendingRemovals = 0;
      continue;
    }

    if (newLine === 0) continue; // still in the file header before the first hunk

    if (line.startsWith("+") && !line.startsWith("+++")) {
      // Flush any pending removals: they happened just before this new line.
      if (pendingRemovals > 0) {
        markers.push({ line: newLine + 1, kind: "removed-after" });
        pendingRemovals = 0;
      }
      newLine++;
      markers.push({ line: newLine, kind: "added" });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      pendingRemovals++;
    } else if (!line.startsWith("\\")) {
      // Context line (or blank): flush pending removals first.
      if (pendingRemovals > 0) {
        markers.push({ line: newLine + 1, kind: "removed-after" });
        pendingRemovals = 0;
      }
      newLine++;
    }
  }

  // Flush any removals at the end of a hunk.
  if (pendingRemovals > 0) {
    markers.push({ line: newLine + 1, kind: "removed-after" });
  }

  return markers;
}
```

- [ ] **Step 4: Run tests — confirm PASS**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm test -- diffParser 2>&1 | tail -10
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src/lib/diffParser.ts src/lib/diffParser.test.ts
git commit -m "feat(lib): diffParser — unified diff to per-file line markers"
```

---

## Task 6: `editorStore.ts` + tests

**Files:**
- Create: `src/stores/editorStore.ts`
- Create: `src/stores/editorStore.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/stores/editorStore.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock IPC ─────────────────────────────────────────────────────
const mockIpc = {
  readFile: vi.fn<(path: string) => Promise<string>>(),
  writeFile: vi.fn<(path: string, content: string) => Promise<void>>(),
};

vi.mock("../lib/ipc", () => ({ ipc: mockIpc }));

const { useEditorStore } = await import("./editorStore");

// ─── Helpers ──────────────────────────────────────────────────────

function reset() {
  useEditorStore.setState({ filesByWs: {}, activeByWs: {} });
  vi.clearAllMocks();
}

// ─── Tests ────────────────────────────────────────────────────────

describe("editorStore — openFile", () => {
  beforeEach(reset);

  it("reads from IPC and stores file on first open", async () => {
    mockIpc.readFile.mockResolvedValueOnce("hello");
    await useEditorStore.getState().openFile("ws-1", "/repo/foo.ts");

    const files = useEditorStore.getState().getFiles("ws-1");
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("/repo/foo.ts");
    expect(files[0].content).toBe("hello");
    expect(files[0].savedContent).toBe("hello");
    expect(useEditorStore.getState().getActivePath("ws-1")).toBe("/repo/foo.ts");
  });

  it("does NOT re-read if file is already open — just activates", async () => {
    mockIpc.readFile.mockResolvedValueOnce("original");
    await useEditorStore.getState().openFile("ws-1", "/repo/foo.ts");

    // Manually dirty the buffer
    useEditorStore.getState().setContent("ws-1", "/repo/foo.ts", "edited");

    // Open again
    await useEditorStore.getState().openFile("ws-1", "/repo/foo.ts");

    // readFile was only called once; content is still the edited version
    expect(mockIpc.readFile).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().getFiles("ws-1")[0].content).toBe("edited");
  });

  it("opens multiple files in the same workspace", async () => {
    mockIpc.readFile
      .mockResolvedValueOnce("a content")
      .mockResolvedValueOnce("b content");

    await useEditorStore.getState().openFile("ws-1", "/repo/a.ts");
    await useEditorStore.getState().openFile("ws-1", "/repo/b.ts");

    const files = useEditorStore.getState().getFiles("ws-1");
    expect(files).toHaveLength(2);
    expect(useEditorStore.getState().getActivePath("ws-1")).toBe("/repo/b.ts");
  });
});

describe("editorStore — closeFile", () => {
  beforeEach(reset);

  it("removes the file from the list", async () => {
    mockIpc.readFile.mockResolvedValueOnce("x");
    await useEditorStore.getState().openFile("ws-1", "/repo/x.ts");
    useEditorStore.getState().closeFile("ws-1", "/repo/x.ts");
    expect(useEditorStore.getState().getFiles("ws-1")).toHaveLength(0);
  });

  it("active becomes null when last file is closed", async () => {
    mockIpc.readFile.mockResolvedValueOnce("x");
    await useEditorStore.getState().openFile("ws-1", "/repo/x.ts");
    useEditorStore.getState().closeFile("ws-1", "/repo/x.ts");
    expect(useEditorStore.getState().getActivePath("ws-1")).toBeNull();
  });

  it("active shifts to a neighbor when active file is closed", async () => {
    mockIpc.readFile
      .mockResolvedValueOnce("a")
      .mockResolvedValueOnce("b");
    await useEditorStore.getState().openFile("ws-1", "/repo/a.ts");
    await useEditorStore.getState().openFile("ws-1", "/repo/b.ts");

    useEditorStore.getState().closeFile("ws-1", "/repo/b.ts");
    expect(useEditorStore.getState().getActivePath("ws-1")).toBe("/repo/a.ts");
  });
});

describe("editorStore — setContent + isDirty", () => {
  beforeEach(reset);

  it("setContent marks the file dirty", async () => {
    mockIpc.readFile.mockResolvedValueOnce("original");
    await useEditorStore.getState().openFile("ws-1", "/repo/foo.ts");

    expect(useEditorStore.getState().isDirty("ws-1", "/repo/foo.ts")).toBe(false);

    useEditorStore.getState().setContent("ws-1", "/repo/foo.ts", "changed");
    expect(useEditorStore.getState().isDirty("ws-1", "/repo/foo.ts")).toBe(true);
  });

  it("setContent does not touch savedContent", async () => {
    mockIpc.readFile.mockResolvedValueOnce("original");
    await useEditorStore.getState().openFile("ws-1", "/repo/foo.ts");
    useEditorStore.getState().setContent("ws-1", "/repo/foo.ts", "changed");

    const file = useEditorStore.getState().getFiles("ws-1")[0];
    expect(file.savedContent).toBe("original");
    expect(file.content).toBe("changed");
  });
});

describe("editorStore — saveActive", () => {
  beforeEach(reset);

  it("calls writeFile and clears dirty flag", async () => {
    mockIpc.readFile.mockResolvedValueOnce("original");
    mockIpc.writeFile.mockResolvedValueOnce(undefined);

    await useEditorStore.getState().openFile("ws-1", "/repo/foo.ts");
    useEditorStore.getState().setContent("ws-1", "/repo/foo.ts", "saved-content");

    await useEditorStore.getState().saveActive("ws-1");

    expect(mockIpc.writeFile).toHaveBeenCalledWith("/repo/foo.ts", "saved-content");
    expect(useEditorStore.getState().isDirty("ws-1", "/repo/foo.ts")).toBe(false);
  });

  it("no-ops when no active file", async () => {
    await useEditorStore.getState().saveActive("ws-1");
    expect(mockIpc.writeFile).not.toHaveBeenCalled();
  });
});

describe("editorStore — workspace isolation", () => {
  beforeEach(reset);

  it("two workspaces have independent file lists", async () => {
    mockIpc.readFile
      .mockResolvedValueOnce("in ws-A")
      .mockResolvedValueOnce("in ws-B");

    await useEditorStore.getState().openFile("ws-A", "/repo/a.ts");
    await useEditorStore.getState().openFile("ws-B", "/repo/b.ts");

    expect(useEditorStore.getState().getFiles("ws-A")).toHaveLength(1);
    expect(useEditorStore.getState().getFiles("ws-B")).toHaveLength(1);
    expect(useEditorStore.getState().getActivePath("ws-A")).toBe("/repo/a.ts");
    expect(useEditorStore.getState().getActivePath("ws-B")).toBe("/repo/b.ts");
  });

  it("empty selectors return stable references", () => {
    const r1 = useEditorStore.getState().getFiles("never-seen-ws");
    const r2 = useEditorStore.getState().getFiles("never-seen-ws");
    expect(r1).toBe(r2); // same reference — no new array each call
  });
});
```

- [ ] **Step 2: Run tests — confirm FAIL**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm test -- editorStore 2>&1 | tail -10
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `editorStore.ts`**

Create `src/stores/editorStore.ts`:

```typescript
import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { langForExtension } from "../lib/editorLang";

// ─── Types ────────────────────────────────────────────────────────

export interface OpenFile {
  path: string;
  content: string;
  savedContent: string;
  lang: string;
}

// Stable empty list — returning a new array per call would bust React memo
// and cause an infinite re-render loop (same trap as terminalsStore/chatStore).
const EMPTY_FILES: OpenFile[] = [];

// ─── Store interface ──────────────────────────────────────────────

interface EditorStore {
  filesByWs: Record<string, OpenFile[]>;
  activeByWs: Record<string, string | null>;

  // Selectors
  getFiles: (workspaceId: string) => OpenFile[];
  getActivePath: (workspaceId: string) => string | null;
  isDirty: (workspaceId: string, path: string) => boolean;

  // Actions
  openFile: (workspaceId: string, path: string) => Promise<void>;
  closeFile: (workspaceId: string, path: string) => void;
  setActive: (workspaceId: string, path: string) => void;
  setContent: (workspaceId: string, path: string, content: string) => void;
  saveActive: (workspaceId: string) => Promise<void>;
}

// ─── Implementation ───────────────────────────────────────────────

export const useEditorStore = create<EditorStore>((set, get) => ({
  filesByWs: {},
  activeByWs: {},

  // ── Selectors ─────────────────────────────────────────────────

  getFiles: (workspaceId) => get().filesByWs[workspaceId] ?? EMPTY_FILES,

  getActivePath: (workspaceId) => {
    const byWs = get().activeByWs;
    return workspaceId in byWs ? byWs[workspaceId] : null;
  },

  isDirty: (workspaceId, path) => {
    const file = (get().filesByWs[workspaceId] ?? EMPTY_FILES).find(
      (f) => f.path === path,
    );
    return file ? file.content !== file.savedContent : false;
  },

  // ── Actions ───────────────────────────────────────────────────

  openFile: async (workspaceId, path) => {
    const existing = (get().filesByWs[workspaceId] ?? EMPTY_FILES).find(
      (f) => f.path === path,
    );
    if (existing) {
      // File already open — just activate it.
      set((s) => ({
        activeByWs: { ...s.activeByWs, [workspaceId]: path },
      }));
      return;
    }

    const content = await ipc.readFile(path);
    const newFile: OpenFile = {
      path,
      content,
      savedContent: content,
      lang: langForExtension(path),
    };

    set((s) => {
      const prev = s.filesByWs[workspaceId] ?? EMPTY_FILES;
      return {
        filesByWs: { ...s.filesByWs, [workspaceId]: [...prev, newFile] },
        activeByWs: { ...s.activeByWs, [workspaceId]: path },
      };
    });
  },

  closeFile: (workspaceId, path) => {
    set((s) => {
      const prev = s.filesByWs[workspaceId] ?? EMPTY_FILES;
      const remaining = prev.filter((f) => f.path !== path);

      const currentActive = s.activeByWs[workspaceId] ?? null;
      let nextActive: string | null = currentActive;

      if (currentActive === path) {
        const idx = prev.findIndex((f) => f.path === path);
        // Prefer the item after; fall back to the one before.
        nextActive = remaining[idx]?.path ?? remaining[idx - 1]?.path ?? null;
      }

      return {
        filesByWs: { ...s.filesByWs, [workspaceId]: remaining },
        activeByWs: { ...s.activeByWs, [workspaceId]: nextActive },
      };
    });
  },

  setActive: (workspaceId, path) =>
    set((s) => ({
      activeByWs: { ...s.activeByWs, [workspaceId]: path },
    })),

  setContent: (workspaceId, path, content) =>
    set((s) => {
      const prev = s.filesByWs[workspaceId] ?? EMPTY_FILES;
      return {
        filesByWs: {
          ...s.filesByWs,
          [workspaceId]: prev.map((f) =>
            f.path === path ? { ...f, content } : f,
          ),
        },
      };
    }),

  saveActive: async (workspaceId) => {
    const activePath = get().getActivePath(workspaceId);
    if (!activePath) return;

    const file = (get().filesByWs[workspaceId] ?? EMPTY_FILES).find(
      (f) => f.path === activePath,
    );
    if (!file) return;

    await ipc.writeFile(activePath, file.content);

    // Update savedContent to mark the file clean.
    set((s) => {
      const prev = s.filesByWs[workspaceId] ?? EMPTY_FILES;
      return {
        filesByWs: {
          ...s.filesByWs,
          [workspaceId]: prev.map((f) =>
            f.path === activePath ? { ...f, savedContent: f.content } : f,
          ),
        },
      };
    });
  },
}));
```

- [ ] **Step 4: Run tests — confirm PASS**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm test -- editorStore 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src/stores/editorStore.ts src/stores/editorStore.test.ts
git commit -m "feat(store): editorStore — per-workspace open files with dirty tracking"
```

---

## Task 7: Atelier theme for CodeMirror

**Files:**
- Create: `src/components/editor/atelierTheme.ts`

This file has no tests because it's a pure visual configuration; visual regressions are caught by the typecheck and component tests.

- [ ] **Step 1: Create the theme directory and file**

```bash
mkdir -p /Users/jonathan/TYPEFY/octopus/octopus-sh/src/components/editor
```

Create `src/components/editor/atelierTheme.ts`:

```typescript
/**
 * Atelier in Onyx & Brass — CodeMirror 6 theme.
 *
 * Hex values mirror the CSS variables defined in src/styles.css @theme block
 * and tokens.ts. Inline hex is intentional here: CodeMirror's theme() API
 * takes a JS object, not CSS variables; reading CSS variables at runtime would
 * require document access and complicate SSR/test environments.
 */

import { EditorView } from "@codemirror/view";
import {
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

// ── Token mirrors ─────────────────────────────────────────────────
const ONYX    = "#0c0a08";
const PANEL   = "#14110d";
const HAIRLINE = "#2a2419";
const BRASS   = "#d4a574";
const IVORY   = "#f4ecdb";
const SAGE    = "#95897a";
const MUTE    = "#6d6354";
const ROUGE   = "#d18b8b";
const BRASS_GHOST = "rgba(212, 165, 116, 0.08)";
const BRASS_FAINT = "rgba(212, 165, 116, 0.04)";

// ── Editor view theme ─────────────────────────────────────────────

const atelierEditorTheme = EditorView.theme(
  {
    "&": {
      color: IVORY,
      backgroundColor: ONYX,
      fontSize: "13px",
      fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Consolas, monospace',
    },

    ".cm-content": {
      caretColor: BRASS,
      padding: "8px 0",
    },

    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: BRASS,
      borderLeftWidth: "2px",
    },

    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: BRASS_GHOST,
    },

    ".cm-gutters": {
      backgroundColor: PANEL,
      color: MUTE,
      border: "none",
      borderRight: `1px solid ${HAIRLINE}`,
    },

    ".cm-activeLineGutter": {
      backgroundColor: BRASS_FAINT,
    },

    ".cm-activeLine": {
      backgroundColor: BRASS_FAINT,
    },

    ".cm-lineNumbers .cm-gutterElement": {
      paddingRight: "12px",
      paddingLeft: "8px",
      minWidth: "32px",
    },

    ".cm-foldGutter .cm-gutterElement": {
      color: MUTE,
    },

    ".cm-matchingBracket, .cm-nonmatchingBracket": {
      backgroundColor: "rgba(212, 165, 116, 0.15)",
    },

    ".cm-tooltip": {
      backgroundColor: PANEL,
      border: `1px solid ${HAIRLINE}`,
      color: IVORY,
    },

    ".cm-scroller": {
      fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Consolas, monospace',
    },
  },
  { dark: true },
);

// ── Syntax highlighting ───────────────────────────────────────────

const atelierHighlightStyle = HighlightStyle.define([
  // Keywords: brass
  { tag: tags.keyword,            color: BRASS, fontWeight: "500" },
  { tag: tags.controlKeyword,     color: BRASS },
  { tag: tags.definitionKeyword,  color: BRASS },
  { tag: tags.moduleKeyword,      color: BRASS },
  { tag: tags.operatorKeyword,    color: BRASS },

  // Strings: sage
  { tag: tags.string,             color: SAGE },
  { tag: tags.special(tags.string), color: SAGE },
  { tag: tags.regexp,             color: SAGE },
  { tag: tags.escape,             color: SAGE },

  // Numbers: rouge (distinctive)
  { tag: tags.number,             color: ROUGE },
  { tag: tags.integer,            color: ROUGE },
  { tag: tags.float,              color: ROUGE },

  // Comments: mute + Spectral italic
  {
    tag: tags.comment,
    color: MUTE,
    fontStyle: "italic",
    fontFamily: '"Spectral", "Iowan Old Style", "Times New Roman", serif',
  },
  { tag: tags.lineComment,        color: MUTE, fontStyle: "italic" },
  { tag: tags.blockComment,       color: MUTE, fontStyle: "italic" },

  // Functions: ivory
  { tag: tags.function(tags.variableName), color: IVORY },
  { tag: tags.function(tags.propertyName), color: IVORY },

  // Types / classes: brass
  { tag: tags.typeName,           color: BRASS },
  { tag: tags.className,          color: BRASS },
  { tag: tags.namespace,          color: BRASS },
  { tag: tags.definition(tags.typeName), color: BRASS },

  // Operators & punctuation: sage
  { tag: tags.operator,           color: SAGE },
  { tag: tags.punctuation,        color: SAGE },
  { tag: tags.separator,          color: SAGE },
  { tag: tags.bracket,            color: SAGE },

  // HTML tags: brass
  { tag: tags.tagName,            color: BRASS },
  { tag: tags.angleBracket,       color: SAGE },

  // HTML attributes: sage
  { tag: tags.attributeName,      color: SAGE },
  { tag: tags.attributeValue,     color: SAGE },

  // Variables / properties: ivory (base)
  { tag: tags.variableName,       color: IVORY },
  { tag: tags.propertyName,       color: IVORY },

  // Boolean / null / undefined: brass
  { tag: tags.bool,               color: BRASS },
  { tag: tags.null,               color: MUTE },

  // Headings (Markdown): brass
  { tag: tags.heading,            color: BRASS, fontWeight: "600" },

  // Links (Markdown): sage
  { tag: tags.link,               color: SAGE },

  // Special / meta: mute
  { tag: tags.meta,               color: MUTE },
  { tag: tags.processingInstruction, color: MUTE },
]);

// ── Exported extension ────────────────────────────────────────────

/** Combined CodeMirror extension: Atelier editor theme + syntax highlighting. */
export const atelierTheme: Extension = [
  atelierEditorTheme,
  syntaxHighlighting(atelierHighlightStyle),
];
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm run typecheck 2>&1 | tail -5
```

Expected: no errors. If `@lezer/highlight` types are missing, they ship with `@codemirror/language` — no extra install needed.

- [ ] **Step 3: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src/components/editor/atelierTheme.ts
git commit -m "feat(editor): Atelier in Onyx & Brass CodeMirror theme"
```

---

## Task 8: Diff gutter extension

**Files:**
- Create: `src/components/editor/diffGutter.ts`

- [ ] **Step 1: Create `diffGutter.ts`**

Create `src/components/editor/diffGutter.ts`:

```typescript
/**
 * CodeMirror 6 gutter extension for diff markers.
 *
 * Renders a narrow colored bar on the left edge of lines that were
 * added or had deletions immediately after them, matching the Atelier palette.
 */

import { gutter, GutterMarker } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { DiffLineMarker } from "../../lib/diffParser";

// ── Token hex mirrors ──────────────────────────────────────────────
// Matches tokens.ts values — no hardcoded literals beyond what the
// design system already canonically defines.
const ADDED_COLOR   = "#d4a574"; // octo-brass — inserted line
const REMOVED_COLOR = "#d18b8b"; // octo-rouge  — deletion marker

// ── GutterMarker subclasses ────────────────────────────────────────

class AddedMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement("div");
    el.style.cssText = `
      width: 3px;
      height: 100%;
      background: ${ADDED_COLOR};
      border-radius: 1px;
      margin: 0 2px;
    `;
    return el;
  }
}

class RemovedAfterMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement("div");
    el.style.cssText = `
      color: ${REMOVED_COLOR};
      font-size: 9px;
      line-height: 1;
      padding-top: 1px;
      text-align: center;
      width: 14px;
    `;
    el.textContent = "▾";
    return el;
  }
}

const addedMarker = new AddedMarker();
const removedAfterMarker = new RemovedAfterMarker();

// ── Extension factory ──────────────────────────────────────────────

/**
 * Build a CodeMirror gutter `Extension` from a list of `DiffLineMarker`.
 *
 * @param markers  Output of `parseDiffForFile()` for the currently-open file.
 */
export function diffGutter(markers: DiffLineMarker[]): Extension {
  // Build a fast lookup: line number → marker kind.
  const byLine = new Map<number, "added" | "removed-after">();
  for (const m of markers) {
    byLine.set(m.line, m.kind);
  }

  return gutter({
    class: "cm-diff-gutter",
    lineMarker(view, line) {
      const lineNo = view.state.doc.lineAt(line.from).number;
      const kind = byLine.get(lineNo);
      if (kind === "added") return addedMarker;
      if (kind === "removed-after") return removedAfterMarker;
      return null;
    },
    initialSpacer: () => addedMarker,
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm run typecheck 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src/components/editor/diffGutter.ts
git commit -m "feat(editor): diff gutter extension — brass additions, rouge deletions"
```

---

## Task 9: `EditorTabs.tsx` + tests

**Files:**
- Create: `src/components/EditorTabs.tsx`
- Create: `src/components/EditorTabs.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `src/components/EditorTabs.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OpenFile } from "../stores/editorStore";

// ─── Mock the editorStore ─────────────────────────────────────────

const mockFiles: OpenFile[] = [
  { path: "/repo/foo.ts", content: "abc", savedContent: "abc", lang: "javascript" },
  { path: "/repo/bar.ts", content: "edited", savedContent: "original", lang: "javascript" },
];

const mockSetActive = vi.fn();
const mockCloseFile = vi.fn();

vi.mock("../stores/editorStore", () => ({
  useEditorStore: vi.fn((selector: (s: unknown) => unknown) => {
    const state = {
      getFiles: (wsId: string) => (wsId === "ws-1" ? mockFiles : []),
      getActivePath: (wsId: string) => (wsId === "ws-1" ? "/repo/foo.ts" : null),
      isDirty: (_wsId: string, path: string) => path === "/repo/bar.ts",
      setActive: mockSetActive,
      closeFile: mockCloseFile,
    };
    return selector(state);
  }),
}));

import { EditorTabs } from "./EditorTabs";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EditorTabs", () => {
  it("renders a tab for each open file using the filename only", () => {
    render(<EditorTabs workspaceId="ws-1" />);
    expect(screen.getByText("foo.ts")).toBeInTheDocument();
    expect(screen.getByText("bar.ts")).toBeInTheDocument();
  });

  it("shows dirty dot (●) on modified files", () => {
    render(<EditorTabs workspaceId="ws-1" />);
    // bar.ts is dirty — should show ●
    expect(screen.getByTestId("dirty-dot-/repo/bar.ts")).toBeInTheDocument();
    // foo.ts is clean — should NOT show ●
    expect(screen.queryByTestId("dirty-dot-/repo/foo.ts")).not.toBeInTheDocument();
  });

  it("clicking a tab calls setActive with the path", async () => {
    render(<EditorTabs workspaceId="ws-1" />);
    await userEvent.click(screen.getByText("bar.ts"));
    expect(mockSetActive).toHaveBeenCalledWith("ws-1", "/repo/bar.ts");
  });

  it("clicking × calls closeFile with the path", async () => {
    render(<EditorTabs workspaceId="ws-1" />);
    // Get the close buttons by test id
    const closeBtn = screen.getByTestId("close-tab-/repo/foo.ts");
    await userEvent.click(closeBtn);
    expect(mockCloseFile).toHaveBeenCalledWith("ws-1", "/repo/foo.ts");
  });

  it("renders nothing when no files are open", () => {
    render(<EditorTabs workspaceId="ws-empty" />);
    expect(screen.queryByTestId(/^tab-/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests — confirm FAIL**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm test -- EditorTabs 2>&1 | tail -10
```

Expected: FAIL — component not found.

- [ ] **Step 3: Implement `EditorTabs.tsx`**

Create `src/components/EditorTabs.tsx`:

```typescript
import { useEditorStore } from "../stores/editorStore";

interface Props {
  workspaceId: string;
}

export function EditorTabs({ workspaceId }: Props) {
  const files = useEditorStore((s) => s.getFiles(workspaceId));
  const activePath = useEditorStore((s) => s.getActivePath(workspaceId));
  const isDirty = useEditorStore((s) => s.isDirty);
  const setActive = useEditorStore((s) => s.setActive);
  const closeFile = useEditorStore((s) => s.closeFile);

  if (files.length === 0) return null;

  return (
    <div
      className="flex overflow-x-auto border-b border-octo-hairline bg-octo-panel"
      style={{ scrollbarWidth: "none" }}
    >
      {files.map((file) => {
        const filename = file.path.split("/").pop() ?? file.path;
        const isActive = file.path === activePath;
        const dirty = isDirty(workspaceId, file.path);

        return (
          <div
            key={file.path}
            data-testid={`tab-${file.path}`}
            className="group relative flex shrink-0 cursor-pointer items-center gap-1.5 px-3 py-2 transition-colors duration-[220ms]"
            style={{
              borderBottom: isActive
                ? "2px solid var(--color-octo-brass)"
                : "2px solid transparent",
              background: isActive
                ? "rgba(212, 165, 116, 0.04)"
                : "transparent",
            }}
            onClick={() => setActive(workspaceId, file.path)}
          >
            {/* Filename */}
            <span
              className={`font-mono text-[11px] ${
                isActive ? "text-octo-ivory" : "text-octo-sage"
              }`}
            >
              {filename}
            </span>

            {/* Dirty indicator */}
            {dirty && (
              <span
                data-testid={`dirty-dot-${file.path}`}
                className="font-mono text-[10px]"
                style={{ color: "var(--color-octo-brass)" }}
              >
                ●
              </span>
            )}

            {/* Close button (visible on hover or when active) */}
            <button
              type="button"
              data-testid={`close-tab-${file.path}`}
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm font-mono text-[10px] transition-opacity duration-[220ms] ${
                isActive
                  ? "opacity-60 hover:opacity-100"
                  : "opacity-0 group-hover:opacity-60 hover:!opacity-100"
              }`}
              style={{ color: "var(--color-octo-sage)" }}
              onClick={(e) => {
                e.stopPropagation();
                closeFile(workspaceId, file.path);
              }}
              aria-label={`Close ${filename}`}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run tests — confirm PASS**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm test -- EditorTabs 2>&1 | tail -10
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src/components/EditorTabs.tsx src/components/EditorTabs.test.tsx
git commit -m "feat(ui): EditorTabs — file tabs strip with dirty indicator and close"
```

---

## Task 10: `EditorPane.tsx` + tests

**Files:**
- Create: `src/components/EditorPane.tsx`
- Create: `src/components/EditorPane.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `src/components/EditorPane.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// ─── Mock CodeMirror (JSDOM can't run it) ─────────────────────────
vi.mock("@codemirror/view", () => ({
  EditorView: vi.fn().mockImplementation(() => ({
    dom: document.createElement("div"),
    destroy: vi.fn(),
    dispatch: vi.fn(),
  })),
  lineNumbers: vi.fn(() => ({})),
  highlightActiveLineGutter: vi.fn(() => ({})),
  highlightActiveLine: vi.fn(() => ({})),
  drawSelection: vi.fn(() => ({})),
  keymap: { of: vi.fn(() => ({})) },
}));

vi.mock("@codemirror/state", () => ({
  EditorState: {
    create: vi.fn().mockReturnValue({ doc: { toString: () => "" } }),
  },
}));

vi.mock("@codemirror/commands", () => ({
  defaultKeymap: [],
  indentWithTab: {},
  history: vi.fn(() => ({})),
  historyKeymap: [],
}));

vi.mock("@codemirror/language", () => ({
  indentOnInput: vi.fn(() => ({})),
  bracketMatching: vi.fn(() => ({})),
  foldGutter: vi.fn(() => ({})),
}));

vi.mock("@codemirror/lang-javascript", () => ({
  javascript: vi.fn(() => ({})),
}));

vi.mock("../components/editor/atelierTheme", () => ({
  atelierTheme: [],
}));

vi.mock("../components/editor/diffGutter", () => ({
  diffGutter: vi.fn(() => ({})),
}));

vi.mock("../lib/diffParser", () => ({
  parseDiffForFile: vi.fn(() => []),
}));

// ─── Mock editorStore ─────────────────────────────────────────────

const mockSaveActive = vi.fn();

vi.mock("../stores/editorStore", () => ({
  useEditorStore: vi.fn((selector: (s: unknown) => unknown) => {
    const state = {
      getActivePath: (wsId: string) =>
        wsId === "ws-active" ? "/repo/file.ts" : null,
      getFiles: (wsId: string) =>
        wsId === "ws-active"
          ? [{ path: "/repo/file.ts", content: "hello", savedContent: "hello", lang: "javascript" }]
          : [],
      setContent: vi.fn(),
      saveActive: mockSaveActive,
    };
    return selector(state);
  }),
}));

import { EditorPane } from "./EditorPane";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EditorPane", () => {
  it("shows empty state when no file is active", () => {
    render(
      <EditorPane
        workspaceId="ws-no-active"
        workspacePath="/repo"
        diffText=""
      />,
    );
    expect(
      screen.getByText("Select a file from the tree to begin."),
    ).toBeInTheDocument();
  });

  it("renders editor-host div when a file is active", () => {
    render(
      <EditorPane
        workspaceId="ws-active"
        workspacePath="/repo"
        diffText=""
      />,
    );
    expect(screen.getByTestId("editor-host")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests — confirm FAIL**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm test -- EditorPane 2>&1 | tail -10
```

Expected: FAIL — component not found.

- [ ] **Step 3: Implement `EditorPane.tsx`**

Create `src/components/EditorPane.tsx`:

```typescript
import { useEffect, useRef } from "react";
import { EditorView, lineNumbers, highlightActiveLineGutter, drawSelection, keymap, highlightActiveLine } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands";
import { indentOnInput, bracketMatching, foldGutter } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { python } from "@codemirror/lang-python";
import { java } from "@codemirror/lang-java";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { atelierTheme } from "./editor/atelierTheme";
import { diffGutter } from "./editor/diffGutter";
import { parseDiffForFile } from "../lib/diffParser";
import { useEditorStore } from "../stores/editorStore";

interface Props {
  workspaceId: string;
  workspacePath: string;
  diffText: string;
}

/** Returns the CodeMirror language extension for a given lang id. */
function langExtension(lang: string) {
  switch (lang) {
    case "javascript": return javascript({ typescript: true, jsx: true });
    case "rust":       return rust();
    case "python":     return python();
    case "java":       return java();
    case "json":       return json();
    case "markdown":   return markdown();
    case "html":       return html();
    case "css":        return css();
    case "xml":        return xml();
    case "yaml":       return yaml();
    default:           return [];
  }
}

export function EditorPane({ workspaceId, workspacePath, diffText }: Props) {
  const activePath = useEditorStore((s) => s.getActivePath(workspaceId));
  const files = useEditorStore((s) => s.getFiles(workspaceId));
  const setContent = useEditorStore((s) => s.setContent);
  const saveActive = useEditorStore((s) => s.saveActive);

  const activeFile = activePath
    ? files.find((f) => f.path === activePath) ?? null
    : null;

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!activeFile || !hostRef.current) return;

    // Compute diff markers for this file.
    const relPath = activeFile.path.startsWith(workspacePath + "/")
      ? activeFile.path.slice(workspacePath.length + 1)
      : activeFile.path;
    const markers = parseDiffForFile(diffText, relPath);

    const state = EditorState.create({
      doc: activeFile.content,
      extensions: [
        // Base extensions
        lineNumbers(),
        foldGutter(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        history(),
        indentOnInput(),
        bracketMatching(),
        // Keymaps
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              saveActive(workspaceId).catch(console.error);
              return true;
            },
          },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        // Language
        langExtension(activeFile.lang),
        // Theme
        atelierTheme,
        // Diff gutter
        diffGutter(markers),
        // Change listener — sync content to store
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            setContent(workspaceId, activeFile.path, update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: hostRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Re-create the editor only when the active file PATH changes (not on every
    // content change — that would reset the cursor and undo history).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, workspaceId]);

  if (!activeFile) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <span className="font-serif italic text-[15px] text-octo-mute">
          Select a file from the tree to begin.
        </span>
      </div>
    );
  }

  return (
    <div className="chat-selectable flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        ref={hostRef}
        data-testid="editor-host"
        className="min-h-0 flex-1 overflow-auto"
        style={{ background: "var(--color-octo-onyx)" }}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run tests — confirm PASS**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm test -- EditorPane 2>&1 | tail -10
```

Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src/components/EditorPane.tsx src/components/EditorPane.test.tsx
git commit -m "feat(ui): EditorPane — CodeMirror 6 with Atelier theme, diff gutter, ⌘S save"
```

---

## Task 11: Wire `CompanionFileTree` `onFileClick` + test

**Files:**
- Modify: `src/components/CompanionFileTree.tsx`
- Modify: `src/components/CompanionFileTree.test.tsx`
- Modify: `src/components/Companion.tsx`

- [ ] **Step 1: Update `CompanionFileTree.tsx` — add `onFileClick` prop**

In `src/components/CompanionFileTree.tsx`:

1. Update the `Props` interface (around line 5):

```typescript
interface Props {
  rootPath: string;
  rootLabel: string;
  changedPaths: Set<string>;
  onFileClick?: (absPath: string) => void;
}
```

2. Add the prop to the function signature (line 13):

```typescript
export function CompanionFileTree({ rootPath, rootLabel, changedPaths, onFileClick }: Props) {
```

3. Pass `onFileClick` down to `TreeNode` (in the return JSX, the `<TreeNode ... />` call around line 62):

Add `onFileClick={onFileClick}` as a prop.

4. Update the `TreeNodeProps` interface (around line 77) to include:

```typescript
  onFileClick?: (absPath: string) => void;
```

5. Update the `TreeNode` function signature to accept `onFileClick`.

6. In the `onClick` handler of the row `<div>` (around line 126), change it from:

```typescript
onClick={() => {
  if (isDir) onToggle(path);
}}
```

to:

```typescript
onClick={() => {
  if (isDir) {
    onToggle(path);
  } else if (onFileClick) {
    onFileClick(path);
  }
}}
```

7. Pass `onFileClick` down recursively in the `TreeNode` → `TreeNode` call (around line 222):

```tsx
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
  onFileClick={onFileClick}
/>
```

- [ ] **Step 2: Add test to `CompanionFileTree.test.tsx`**

Add the following test to the `describe("CompanionFileTree", ...)` block at the end:

```typescript
  it("clicking a file row calls onFileClick with the absolute path", async () => {
    const onFileClick = vi.fn();
    render(
      <CompanionFileTree
        rootPath={ROOT}
        rootLabel="my-project"
        changedPaths={CHANGED}
        onFileClick={onFileClick}
      />,
    );

    // Expand src/ to reveal files
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());
    await userEvent.click(screen.getByText("src"));
    await waitFor(() => expect(screen.getByText("Main.java")).toBeInTheDocument());

    // Click the file row
    await userEvent.click(screen.getByTestId("file-row-/repo/src/Main.java"));

    expect(onFileClick).toHaveBeenCalledTimes(1);
    expect(onFileClick).toHaveBeenCalledWith("/repo/src/Main.java");
  });
```

- [ ] **Step 3: Update `Companion.tsx` — thread `onFileClick` through `FileTreeProps`**

In `src/components/Companion.tsx`:

1. Update the `FileTreeProps` interface:

```typescript
interface FileTreeProps {
  rootPath: string;
  rootLabel: string;
  changedPaths: Set<string>;
  onFileClick?: (absPath: string) => void;
}
```

2. The `<CompanionFileTree {...fileTree} />` spread already passes all props through — no other change needed here.

- [ ] **Step 4: Run tests**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm test -- CompanionFileTree 2>&1 | tail -15
```

Expected: all 10 tests pass (9 existing + 1 new).

- [ ] **Step 5: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src/components/CompanionFileTree.tsx src/components/CompanionFileTree.test.tsx src/components/Companion.tsx
git commit -m "feat(ui): CompanionFileTree — onFileClick prop wires file rows to editor"
```

---

## Task 12: Wire everything in `App.tsx`

**Files:**
- Modify: `src/App.tsx`

This is the main wiring step. It lifts the `gitDiff` state out of `ChangesPanel`, adds `EditorTabs` + `EditorPane` to the Review canvas, and passes `onFileClick` through.

- [ ] **Step 1: Add imports to `App.tsx`**

At the top of `src/App.tsx`, add these imports alongside the existing ones:

```typescript
import { EditorPane } from "./components/EditorPane";
import { EditorTabs } from "./components/EditorTabs";
import { useEditorStore } from "./stores/editorStore";
```

- [ ] **Step 2: Add `gitDiff` state + polling**

In `App.tsx`, just after the existing `const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);` line (around line 88), add:

```typescript
const [gitDiff, setGitDiff] = useState<string>("");
```

Then find the `useEffect` that polls git status (the `// ── Refresh git status on workspace change ──` block, around line 147). Replace it with:

```typescript
// ── Refresh git status + diff on workspace change ──
useEffect(() => {
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  const path = ws?.worktreePath ?? project?.path;
  if (!path) {
    setGitStatus(null);
    setGitDiff("");
    return;
  }
  let cancelled = false;
  Promise.all([
    ipc.getGitStatus(path),
    ipc.getGitDiff(path).catch(() => ""),
  ]).then(([s, d]) => {
    if (!cancelled) {
      setGitStatus(s);
      setGitDiff(d);
    }
  }).catch(() => {});
  return () => {
    cancelled = true;
  };
}, [activeWorkspaceId, workspaces, project]);
```

- [ ] **Step 3: Wire `openFile` into `fileTreeProps`**

Find the `fileTreeProps` `useMemo` (around line 306). Replace it with:

```typescript
const openFileInEditor = useEditorStore((s) => s.openFile);

const fileTreeProps = useMemo(() => {
  if (!activeWorkspace) return undefined;
  const rootPath = activeWorkspace.worktreePath || project!.path;
  return {
    rootPath,
    rootLabel: activeWorkspace.name,
    changedPaths: new Set(
      (gitStatus?.changedFiles ?? []).map((f) => `${rootPath}/${f.path}`),
    ),
    onFileClick: (p: string) => openFileInEditor(activeWorkspace.id, p).catch(console.error),
  };
}, [activeWorkspace, project, gitStatus, openFileInEditor]);
```

- [ ] **Step 4: Replace the Review canvas section**

Find the Review mode `<div>` section (the one with `opacity: activeMode === "review" ? 1 : 0`, around line 449). Replace its inner content:

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
    <div className="flex h-full min-h-0">
      {/* Left: Changes panel (fixed width) */}
      <div className="w-[320px] shrink-0 border-r border-octo-hairline">
        <ChangesPanel
          projectPath={activeWorkspace.worktreePath || project.path}
          diff={gitDiff}
        />
      </div>
      {/* Middle: Editor canvas */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <EditorTabs workspaceId={activeWorkspaceId!} />
        <EditorPane
          workspaceId={activeWorkspaceId!}
          workspacePath={activeWorkspace.worktreePath || project.path}
          diffText={gitDiff}
        />
      </div>
    </div>
  ) : (
    <ReviewEmptyState />
  )}
</div>
```

- [ ] **Step 5: Update `ChangesPanel` to accept a `diff` prop instead of fetching its own**

Now that `App.tsx` owns the diff poll, update `ChangesPanel.tsx` to accept `diff` as a prop, removing its own `ipc.getGitDiff` fetch:

In `src/components/ChangesPanel.tsx`, change the `Props` interface:

```typescript
interface Props {
  projectPath: string;
  diff: string;
}
```

Remove `const [diff, setDiff] = useState<string>("");` from state.

Change the `refresh` function to only fetch git status:

```typescript
async function refresh() {
  try {
    const status = await ipc.getGitStatus(projectPath);
    setGitStatus(status);
  } catch {
    // silently ignore — project may not be a git repo yet
  }
}
```

Remove the `setDiff(d)` call and the `ipc.getGitDiff(projectPath).catch(() => "")` line from the old `Promise.all`.

Consume `diff` from props directly (it's already used in the render — just remove the local state).

- [ ] **Step 6: Run typecheck**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm run typecheck 2>&1 | tail -10
```

Expected: no errors. Fix any type errors that appear.

- [ ] **Step 7: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src/App.tsx src/components/ChangesPanel.tsx
git commit -m "feat(app): wire EditorPane + EditorTabs into Review mode, lift gitDiff state"
```

---

## Task 13: Full test suite + final typecheck

- [ ] **Step 1: Run all frontend tests**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm test 2>&1 | tail -30
```

Expected: all suites pass. Fix any failing tests before proceeding.

- [ ] **Step 2: Run full Rust test suite**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh/src-tauri && cargo test 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 3: Typecheck one final time**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm run typecheck 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 4: Final commit (squash-ready summary commit)**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add -A
git commit -m "feat(review): CodeMirror editor with tabs, save, and diff gutter"
```

---

## Self-Review Checklist

### Spec coverage
| Requirement | Task |
|-------------|------|
| Click file in Companion tree → opens in editor | Tasks 11, 12 |
| ⌘S writes to disk | Task 10 (keymap in EditorPane) |
| Tabs for multiple open files | Task 9 (EditorTabs) |
| Diff gutter markers (brass/rouge) | Tasks 5, 8, 10 |
| CodeMirror 6 (not Monaco) | Tasks 2, 7, 8, 10 |
| Editor in middle canvas of Review mode | Task 12 |
| ChangesPanel stays left, file tree stays right | Task 12 |
| Atelier theme (Onyx & Brass, no foreign colors) | Task 7 |
| Per-workspace store pattern (EMPTY constant) | Task 6 |
| Rust file I/O commands with tests | Task 1 |
| `langForExtension` helper + tests | Task 4 |
| `parseDiffForFile` + tests | Task 5 |
| `EditorStore` tests | Task 6 |
| `EditorTabs` tests | Task 9 |
| `EditorPane` tests | Task 10 |
| `CompanionFileTree` `onFileClick` test | Task 11 |

All requirements covered.

### Type consistency check
- `OpenFile` defined in Task 6, used in Tasks 9 and 10 — same shape.
- `DiffLineMarker` defined in Task 5, used in Task 8 — same shape.
- `LangId` defined in Task 4, `langForExtension` return type — `lang` field in `OpenFile` is `string` (intentionally loose to avoid needing to import `LangId` everywhere).
- `onFileClick?: (absPath: string) => void` consistent in `CompanionFileTree`, `Companion`, and `App.tsx` usage.
- `ChangesPanel` props change: `diff: string` added in Task 12, callers updated in same task.
- `fileTreeProps` type in `App.tsx` gains `onFileClick` — matched by `Companion.tsx` `FileTreeProps` update in Task 11.

### Placeholder scan
No TBDs, no "implement later", no steps without code.
