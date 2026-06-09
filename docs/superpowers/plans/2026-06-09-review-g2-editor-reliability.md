# G2 · Editor Reliability & File I/O — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the editor's open and save paths so binary / oversized / non-UTF-8 files are detected (not garbled), save failures surface as toasts, and each open file's mtime is captured.

**Architecture:** A new Rust `read_file_checked` returns a tagged result (`text`/`binary`/`unsupportedEncoding`/`tooLarge`); `write_file` returns the new mtime. The frontend `editorStore.openFile` branches on `kind` (with an injected `confirm` for large files), `saveActive` try/catches with a toast, and a new `EditorBinaryPane` renders binary tabs with Reveal/Open actions.

**Tech Stack:** Rust (Tauri 2 commands, `tempfile` for tests), React 19 + TypeScript, Zustand, Vitest + Testing Library, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-06-09-review-g2-editor-reliability-design.md`

**Branch:** `feat/review-g2-reliability` (worktree `octopus-sh-review`, off `main`).

---

## File structure

| File | Responsibility | Task |
|------|----------------|------|
| `src-tauri/src/commands.rs` *(modify)* | `read_file_checked` + `FileReadResult` + `WriteResult` + `mtime_millis`; `write_file` returns mtime | 1 |
| `src-tauri/src/lib.rs` *(modify)* | register `read_file_checked` | 1 |
| `src-tauri/src/tests.rs` *(modify)* | Rust tests for the above | 1 |
| `src/lib/formatBytes.ts` *(new)* + test | human-readable byte sizes | 2 |
| `src/lib/ipc.ts` *(modify)* | `FileReadResult` type, `readFileChecked`, `writeFile` return type | 3 |
| `src/stores/editorStore.ts` *(modify)* + test | `OpenFile` fields, `openFile` branching, `saveActive` toast, `isDirty` | 4 |
| `src/components/EditorBinaryPane.tsx` *(new)* + test | binary placeholder pane + Reveal/Open | 5 |
| `src/components/EditorPane.tsx` *(modify)* + test | binary branch; skip CM view + status bar for binaries | 6 |
| `src/App.tsx` *(modify)* | inject the large-file `ConfirmDialog` into `openFile` | 7 |

> **Testing note (CodeMirror):** `EditorPane.test.tsx` mocks CodeMirror (jsdom can't lay
> out a real view). Keep that boundary — assert at the React/mock layer, don't un-mock CM.

---

## Task 1: Backend — `read_file_checked`, `write_file` mtime, helper + tests

**Files:**
- Modify: `src-tauri/src/commands.rs:1959-1971` (the File I/O section)
- Modify: `src-tauri/src/lib.rs:219-220` (handler list)
- Test: `src-tauri/src/tests.rs`

- [ ] **Step 1: Write the failing Rust tests**

Add this module at the end of `src-tauri/src/tests.rs`:

```rust
#[cfg(test)]
mod file_io_tests {
    use crate::commands::{read_file_checked_inner, write_file_inner, FileReadResult};
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn temp_with_bytes(bytes: &[u8]) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(bytes).unwrap();
        f.flush().unwrap();
        f
    }

    #[test]
    fn reads_utf8_text() {
        let f = temp_with_bytes(b"hello world");
        match read_file_checked_inner(f.path().to_str().unwrap(), 1_000_000).unwrap() {
            FileReadResult::Text { content, size, mtime } => {
                assert_eq!(content, "hello world");
                assert_eq!(size, 11);
                assert!(mtime > 0, "mtime should be a positive epoch-millis value");
            }
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn detects_binary_via_nul_byte() {
        let f = temp_with_bytes(b"PK\x03\x04\x00\x00binary");
        match read_file_checked_inner(f.path().to_str().unwrap(), 1_000_000).unwrap() {
            FileReadResult::Binary { size, .. } => assert!(size > 0),
            other => panic!("expected Binary, got {other:?}"),
        }
    }

    #[test]
    fn detects_unsupported_encoding() {
        // Invalid UTF-8 with no NUL byte (0xff 0xfe is a UTF-16 BOM, invalid UTF-8).
        let f = temp_with_bytes(&[0xff, 0xfe, 0x41, 0x42]);
        match read_file_checked_inner(f.path().to_str().unwrap(), 1_000_000).unwrap() {
            FileReadResult::UnsupportedEncoding { size, .. } => assert_eq!(size, 4),
            other => panic!("expected UnsupportedEncoding, got {other:?}"),
        }
    }

    #[test]
    fn flags_too_large() {
        let f = temp_with_bytes(b"0123456789"); // 10 bytes
        match read_file_checked_inner(f.path().to_str().unwrap(), 4).unwrap() {
            FileReadResult::TooLarge { size } => assert_eq!(size, 10),
            other => panic!("expected TooLarge, got {other:?}"),
        }
    }

    #[test]
    fn serializes_kind_tag_as_camel_case() {
        let v = serde_json::to_value(FileReadResult::TooLarge { size: 9 }).unwrap();
        assert_eq!(v["kind"], "tooLarge");
        assert_eq!(v["size"], 9);
    }

    #[test]
    fn write_returns_mtime_and_persists() {
        let f = NamedTempFile::new().unwrap();
        let res = write_file_inner(f.path().to_str().unwrap(), "saved").unwrap();
        assert!(res.mtime > 0);
        assert_eq!(std::fs::read_to_string(f.path()).unwrap(), "saved");
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /Users/jonathan/TYPEFY/octopus/octopus-sh-review/src-tauri && cargo test file_io_tests 2>&1 | tail -20`
Expected: compile error — `read_file_checked_inner` / `write_file_inner` / `FileReadResult` not found.

- [ ] **Step 3: Implement in `commands.rs`**

Replace the current File I/O block (`src-tauri/src/commands.rs:1957-1971`) with:

```rust
// ─── File I/O ─────────────────────────────────────────────────────

const BINARY_SNIFF_BYTES: usize = 8192;
/// Hard cap above which `read_file_checked` refuses to load (avoids OOM).
const READ_CAP_BYTES: u64 = 50 * 1024 * 1024;

/// File modification time as epoch milliseconds, or 0 if unavailable.
fn mtime_millis(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileReadResult {
    Text { content: String, size: u64, mtime: i64 },
    Binary { size: u64, mtime: i64 },
    UnsupportedEncoding { size: u64, mtime: i64 },
    TooLarge { size: u64 },
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub mtime: i64,
}

/// Sync core of `read_file_checked` (testable without a tokio runtime).
pub(crate) fn read_file_checked_inner(path: &str, max_bytes: u64) -> AppResult<FileReadResult> {
    let meta = std::fs::metadata(path)
        .map_err(|e| AppError::Other(format!("read_file_checked({path}): {e}")))?;
    let size = meta.len();
    let mtime = mtime_millis(&meta);
    if size > max_bytes {
        return Ok(FileReadResult::TooLarge { size });
    }
    let bytes = std::fs::read(path)
        .map_err(|e| AppError::Other(format!("read_file_checked({path}): {e}")))?;
    if bytes.iter().take(BINARY_SNIFF_BYTES).any(|&b| b == 0) {
        return Ok(FileReadResult::Binary { size, mtime });
    }
    match String::from_utf8(bytes) {
        Ok(content) => Ok(FileReadResult::Text { content, size, mtime }),
        Err(_) => Ok(FileReadResult::UnsupportedEncoding { size, mtime }),
    }
}

#[tauri::command]
pub async fn read_file_checked(path: String, max_bytes: Option<u64>) -> AppResult<FileReadResult> {
    let path = expand_tilde(&path);
    read_file_checked_inner(&path, max_bytes.unwrap_or(READ_CAP_BYTES))
}

/// Kept for any non-editor callers that want a plain string read.
#[tauri::command]
pub async fn read_file(path: String) -> AppResult<String> {
    let path = expand_tilde(&path);
    std::fs::read_to_string(&path)
        .map_err(|e| AppError::Other(format!("read_file({}): {e}", path)))
}

/// Sync core of `write_file` (testable; returns the post-write mtime).
pub(crate) fn write_file_inner(path: &str, content: &str) -> AppResult<WriteResult> {
    std::fs::write(path, content)
        .map_err(|e| AppError::Other(format!("write_file({path}): {e}")))?;
    let mtime = std::fs::metadata(path).map(|m| mtime_millis(&m)).unwrap_or(0);
    Ok(WriteResult { mtime })
}

#[tauri::command]
pub async fn write_file(path: String, content: String) -> AppResult<WriteResult> {
    let path = expand_tilde(&path);
    write_file_inner(&path, &content)
}
```

- [ ] **Step 4: Register `read_file_checked` in `lib.rs`**

In `src-tauri/src/lib.rs`, add the new command to the `generate_handler!` list, right after the `commands::read_file,` line (around line 219):

```rust
            commands::read_file,
            commands::read_file_checked,
            commands::write_file,
```

- [ ] **Step 5: Run tests + clippy build**

Run: `cd /Users/jonathan/TYPEFY/octopus/octopus-sh-review/src-tauri && cargo test file_io_tests 2>&1 | tail -20`
Expected: `test result: ok. 6 passed`.

Run: `cargo build 2>&1 | tail -5`
Expected: builds (warnings ok). Confirm no error about an unused `read_file` (it stays registered).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/tests.rs
git commit -m "feat(g2): read_file_checked (binary/large/encoding) + write_file returns mtime"
```

---

## Task 2: `formatBytes` utility

**Files:**
- Create: `src/lib/formatBytes.ts`
- Test: `src/lib/formatBytes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/formatBytes.test.ts
import { describe, it, expect } from "vitest";
import { formatBytes } from "./formatBytes";

describe("formatBytes", () => {
  it("formats bytes under 1 KB as whole bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });
  it("formats KB and MB with one decimal", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });
  it("formats GB", () => {
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/jonathan/TYPEFY/octopus/octopus-sh-review && npx vitest run src/lib/formatBytes.test.ts`
Expected: FAIL — `Cannot find module './formatBytes'`.

- [ ] **Step 3: Implement**

```ts
// src/lib/formatBytes.ts
/** Human-readable byte size: whole bytes under 1 KB, else one decimal. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/formatBytes.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/formatBytes.ts src/lib/formatBytes.test.ts
git commit -m "feat(g2): formatBytes helper"
```

---

## Task 3: IPC — `readFileChecked` + `writeFile` return type

**Files:**
- Modify: `src/lib/ipc.ts:271-272`

- [ ] **Step 1: Add the type + functions**

In `src/lib/ipc.ts`, near the other type exports at the top of the file, add:

```ts
export type FileReadResult =
  | { kind: "text"; content: string; size: number; mtime: number }
  | { kind: "binary"; size: number; mtime: number }
  | { kind: "unsupportedEncoding"; size: number; mtime: number }
  | { kind: "tooLarge"; size: number };
```

Then replace the `readFile` / `writeFile` lines (271-272) with:

```ts
  readFile: (path: string) => invoke<string>("read_file", { path }),
  readFileChecked: (path: string, maxBytes?: number) =>
    invoke<FileReadResult>("read_file_checked", { path, maxBytes }),
  writeFile: (path: string, content: string) =>
    invoke<{ mtime: number }>("write_file", { path, content }),
```

(Keep `readFile` — non-editor callers still use it.)

- [ ] **Step 2: Typecheck**

Run: `cd /Users/jonathan/TYPEFY/octopus/octopus-sh-review && npm run typecheck 2>&1 | tail -8`
Expected: this will FAIL in `editorStore.ts` / `App.tsx` only if they consume the old `writeFile: Promise<void>` shape in a way that conflicts. If the only errors are about `writeFile`'s return being used (it currently isn't — `saveActive` ignores it), expect CLEAN. If clean, proceed.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ipc.ts
git commit -m "feat(g2): ipc readFileChecked + writeFile returns mtime"
```

---

## Task 4: editorStore — branching open, honest save, mtime

**Files:**
- Modify: `src/stores/editorStore.ts`
- Test: `src/stores/editorStore.test.ts` *(new)*

- [ ] **Step 1: Write the failing tests**

```ts
// src/stores/editorStore.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const readFileChecked = vi.fn();
const writeFile = vi.fn();
const pushToast = vi.fn();

vi.mock("../lib/ipc", () => ({
  ipc: {
    readFileChecked: (...a: unknown[]) => readFileChecked(...a),
    writeFile: (...a: unknown[]) => writeFile(...a),
  },
}));
vi.mock("../components/Toasts", () => ({ pushToast: (...a: unknown[]) => pushToast(...a) }));
vi.mock("../lib/editorLang", () => ({ langForExtension: () => "javascript" }));

import { useEditorStore } from "./editorStore";

function reset() {
  useEditorStore.setState({ filesByWs: {}, activeByWs: {} });
  vi.clearAllMocks();
}

describe("editorStore.openFile", () => {
  beforeEach(reset);

  it("opens a text file with content, mtime and size", async () => {
    readFileChecked.mockResolvedValue({ kind: "text", content: "hi", size: 2, mtime: 111 });
    await useEditorStore.getState().openFile("ws", "/a.ts");
    const f = useEditorStore.getState().getFiles("ws")[0];
    expect(f).toMatchObject({ path: "/a.ts", content: "hi", savedContent: "hi", kind: "text", mtime: 111, size: 2 });
    expect(useEditorStore.getState().isDirty("ws", "/a.ts")).toBe(false);
  });

  it("opens a binary file with no content and is never dirty", async () => {
    readFileChecked.mockResolvedValue({ kind: "binary", size: 1000, mtime: 5 });
    await useEditorStore.getState().openFile("ws", "/x.war");
    const f = useEditorStore.getState().getFiles("ws")[0];
    expect(f).toMatchObject({ kind: "binary", binaryReason: "binary", content: "", size: 1000 });
    expect(useEditorStore.getState().isDirty("ws", "/x.war")).toBe(false);
  });

  it("maps unsupportedEncoding to a binary file with that reason", async () => {
    readFileChecked.mockResolvedValue({ kind: "unsupportedEncoding", size: 4, mtime: 5 });
    await useEditorStore.getState().openFile("ws", "/x.bin");
    expect(useEditorStore.getState().getFiles("ws")[0]).toMatchObject({
      kind: "binary", binaryReason: "unsupportedEncoding",
    });
  });

  it("prompts before opening a large text file; declining opens nothing", async () => {
    readFileChecked.mockResolvedValue({ kind: "text", content: "big", size: 5_000_000, mtime: 1 });
    const confirm = vi.fn().mockResolvedValue(false);
    await useEditorStore.getState().openFile("ws", "/big.ts", confirm);
    expect(confirm).toHaveBeenCalledWith(5_000_000, "/big.ts");
    expect(useEditorStore.getState().getFiles("ws")).toHaveLength(0);
  });

  it("re-reads a tooLarge file (cap raised) when the user confirms", async () => {
    readFileChecked
      .mockResolvedValueOnce({ kind: "tooLarge", size: 99_000_000 })
      .mockResolvedValueOnce({ kind: "text", content: "huge", size: 99_000_000, mtime: 2 });
    const confirm = vi.fn().mockResolvedValue(true);
    await useEditorStore.getState().openFile("ws", "/huge.log", confirm);
    expect(readFileChecked).toHaveBeenNthCalledWith(2, "/huge.log", Number.MAX_SAFE_INTEGER);
    expect(useEditorStore.getState().getFiles("ws")[0]).toMatchObject({ kind: "text", content: "huge" });
  });
});

describe("editorStore.saveActive", () => {
  beforeEach(reset);

  async function openText() {
    readFileChecked.mockResolvedValue({ kind: "text", content: "v1", size: 2, mtime: 100 });
    await useEditorStore.getState().openFile("ws", "/a.ts");
  }

  it("updates savedContent + mtime on success", async () => {
    await openText();
    useEditorStore.getState().setContent("ws", "/a.ts", "v2");
    writeFile.mockResolvedValue({ mtime: 200 });
    await useEditorStore.getState().saveActive("ws");
    const f = useEditorStore.getState().getFiles("ws")[0];
    expect(f.savedContent).toBe("v2");
    expect(f.mtime).toBe(200);
    expect(useEditorStore.getState().isDirty("ws", "/a.ts")).toBe(false);
  });

  it("toasts on write failure and leaves the file dirty", async () => {
    await openText();
    useEditorStore.getState().setContent("ws", "/a.ts", "v2");
    writeFile.mockRejectedValue(new Error("permission denied"));
    await useEditorStore.getState().saveActive("ws");
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));
    expect(useEditorStore.getState().isDirty("ws", "/a.ts")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/stores/editorStore.test.ts`
Expected: FAIL — `openFile`/`saveActive` don't have the new behavior (binary fields, confirm, toast).

- [ ] **Step 3: Update `editorStore.ts`**

Replace the `OpenFile` interface and imports (top of file) with:

```ts
import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { langForExtension } from "../lib/editorLang";
import { pushToast } from "../components/Toasts";

const LARGE_WARN_BYTES = 2 * 1024 * 1024;

export type BinaryReason = "binary" | "unsupportedEncoding";

export interface OpenFile {
  path: string;
  content: string;        // "" for binary
  savedContent: string;   // "" for binary
  lang: string;
  kind: "text" | "binary";
  binaryReason?: BinaryReason;
  mtime: number;
  size: number;
}

/** Async confirm injected by the UI so the store stays React-free. */
export type OpenConfirm = (sizeBytes: number, path: string) => Promise<boolean>;
```

Update the `openFile` signature in the `EditorStore` interface:

```ts
  openFile: (workspaceId: string, path: string, confirm?: OpenConfirm) => Promise<void>;
```

Replace the `openFile` action body with:

```ts
  openFile: async (workspaceId, path, confirm) => {
    const existing = (get().filesByWs[workspaceId] ?? EMPTY_FILES).find(
      (f) => f.path === path,
    );
    if (existing) {
      set((s) => ({ activeByWs: { ...s.activeByWs, [workspaceId]: path } }));
      return;
    }

    let res = await ipc.readFileChecked(path);

    if (res.kind === "tooLarge") {
      const ok = confirm ? await confirm(res.size, path) : false;
      if (!ok) return;
      res = await ipc.readFileChecked(path, Number.MAX_SAFE_INTEGER);
    }

    let newFile: OpenFile;
    if (res.kind === "binary" || res.kind === "unsupportedEncoding") {
      newFile = {
        path, content: "", savedContent: "", lang: langForExtension(path),
        kind: "binary",
        binaryReason: res.kind === "binary" ? "binary" : "unsupportedEncoding",
        mtime: res.mtime, size: res.size,
      };
    } else if (res.kind === "tooLarge") {
      // The re-read above replaced `res`; a second tooLarge means the file
      // grew past MAX_SAFE_INTEGER — treat as binary-unopenable. (Practically
      // unreachable; keeps the branch total.)
      return;
    } else {
      // text
      if (res.size > LARGE_WARN_BYTES) {
        const ok = confirm ? await confirm(res.size, path) : false;
        if (!ok) return;
      }
      newFile = {
        path, content: res.content, savedContent: res.content,
        lang: langForExtension(path), kind: "text",
        mtime: res.mtime, size: res.size,
      };
    }

    set((s) => {
      const prev = s.filesByWs[workspaceId] ?? EMPTY_FILES;
      return {
        filesByWs: { ...s.filesByWs, [workspaceId]: [...prev, newFile] },
        activeByWs: { ...s.activeByWs, [workspaceId]: path },
      };
    });
  },
```

Update `isDirty` so binary files are never dirty:

```ts
  isDirty: (workspaceId, path) => {
    const file = (get().filesByWs[workspaceId] ?? EMPTY_FILES).find(
      (f) => f.path === path,
    );
    if (!file || file.kind === "binary") return false;
    return file.content !== file.savedContent;
  },
```

Replace the `saveActive` action with a try/catch that toasts and updates mtime:

```ts
  saveActive: async (workspaceId) => {
    const activePath = get().getActivePath(workspaceId);
    if (!activePath) return;

    const file = (get().filesByWs[workspaceId] ?? EMPTY_FILES).find(
      (f) => f.path === activePath,
    );
    if (!file || file.kind === "binary") return;

    try {
      const { mtime } = await ipc.writeFile(activePath, file.content);
      set((s) => {
        const prev = s.filesByWs[workspaceId] ?? EMPTY_FILES;
        return {
          filesByWs: {
            ...s.filesByWs,
            [workspaceId]: prev.map((f) =>
              f.path === activePath ? { ...f, savedContent: f.content, mtime } : f,
            ),
          },
        };
      });
    } catch (e) {
      const name = activePath.split("/").pop() ?? activePath;
      pushToast({
        level: "error",
        title: "Couldn't save file",
        body: `${name}: ${e instanceof Error ? e.message : String(e)}`,
        timeout: 7000,
      });
      // Do NOT mark clean — the file stays dirty.
    }
  },
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/stores/editorStore.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck 2>&1 | tail -8`
Expected: this surfaces that existing callers building `OpenFile` (mocks in `EditorTabs.test.tsx` / `EditorPane.test.tsx`) now miss the new required fields. **Do not fix those here** — Tasks 6 handles `EditorPane.test`; if `EditorTabs.test.tsx`'s mock `OpenFile[]` errors, add `kind: "text", mtime: 0, size: 0` to those mock objects in this task (it's a one-line-per-object change to keep the type sound) and re-run. Expected CLEAN after that.

- [ ] **Step 6: Commit**

```bash
git add src/stores/editorStore.ts src/stores/editorStore.test.ts src/components/EditorTabs.test.tsx
git commit -m "feat(g2): editorStore branches open by kind, honest save with toast, mtime"
```

---

## Task 5: `EditorBinaryPane` component

**Files:**
- Create: `src/components/EditorBinaryPane.tsx`
- Test: `src/components/EditorBinaryPane.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/EditorBinaryPane.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const revealInFinder = vi.fn();
const openFileInSystem = vi.fn();
vi.mock("../lib/ipc", () => ({
  ipc: {
    revealInFinder: (...a: unknown[]) => revealInFinder(...a),
    openFileInSystem: (...a: unknown[]) => openFileInSystem(...a),
  },
}));

import { EditorBinaryPane } from "./EditorBinaryPane";

beforeEach(() => vi.clearAllMocks());

describe("EditorBinaryPane", () => {
  it("shows the file name, size and a binary message", () => {
    render(<EditorBinaryPane path="/repo/app.war" size={2 * 1024 * 1024} reason="binary" />);
    expect(screen.getByText("app.war")).toBeInTheDocument();
    expect(screen.getByText("2.0 MB")).toBeInTheDocument();
    expect(screen.getByText(/can't be edited as text/i)).toBeInTheDocument();
  });

  it("shows an encoding message for unsupportedEncoding", () => {
    render(<EditorBinaryPane path="/repo/x.dat" size={10} reason="unsupportedEncoding" />);
    expect(screen.getByText(/unsupported text encoding/i)).toBeInTheDocument();
  });

  it("reveals in Finder and opens in system with the path", async () => {
    render(<EditorBinaryPane path="/repo/app.war" size={10} reason="binary" />);
    await userEvent.click(screen.getByRole("button", { name: /reveal in finder/i }));
    expect(revealInFinder).toHaveBeenCalledWith("/repo/app.war");
    await userEvent.click(screen.getByRole("button", { name: /open in system/i }));
    expect(openFileInSystem).toHaveBeenCalledWith("/repo/app.war");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/EditorBinaryPane.test.tsx`
Expected: FAIL — `Cannot find module './EditorBinaryPane'`.

- [ ] **Step 3: Implement**

```tsx
// src/components/EditorBinaryPane.tsx
import { ipc } from "../lib/ipc";
import { formatBytes } from "../lib/formatBytes";
import type { BinaryReason } from "../stores/editorStore";

interface Props {
  path: string;
  size: number;
  reason: BinaryReason;
}

const BTN =
  "rounded px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-octo-brass transition-colors hover:bg-octo-panel focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass";

export function EditorBinaryPane({ path, size, reason }: Props) {
  const name = path.split("/").pop() ?? path;
  const message =
    reason === "unsupportedEncoding"
      ? "Unsupported text encoding — this file can't be edited as text."
      : "This file can't be edited as text.";

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
        § Binary
      </span>
      <span className="font-mono text-[13px] text-octo-ivory">{name}</span>
      <span className="font-mono text-[11px] text-octo-mute">{formatBytes(size)}</span>
      <p className="max-w-sm text-[12px] text-octo-sage">{message}</p>
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          className={BTN}
          style={{ border: "1px solid var(--brass-dim)" }}
          onClick={() => ipc.revealInFinder(path)}
        >
          Reveal in Finder
        </button>
        <button
          type="button"
          className={BTN}
          style={{ border: "1px solid var(--brass-dim)" }}
          onClick={() => ipc.openFileInSystem(path)}
        >
          Open in system
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/components/EditorBinaryPane.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/EditorBinaryPane.tsx src/components/EditorBinaryPane.test.tsx
git commit -m "feat(g2): EditorBinaryPane — Reveal/Open for non-text files"
```

---

## Task 6: EditorPane — render the binary pane, skip CM view for binaries

**Files:**
- Modify: `src/components/EditorPane.tsx`
- Test: `src/components/EditorPane.test.tsx`

- [ ] **Step 1: Update the swap effect to handle binary + no-file uniformly**

In `src/components/EditorPane.tsx`, the document-swap effect currently early-returns for
`!activeFile` (the close-tab fix). Replace that effect's top so it also clears the view
for binary files and still caches the outgoing text tab's state. The new effect body:

```tsx
  // Swap the document state when the active file changes; preserve per-tab state.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    // Cache the outgoing text tab's live state before any switch.
    const prevPath = lastPathRef.current;
    if (prevPath && prevPath !== activeFile?.path) {
      stateCache.current.set(prevPath, view.state);
    }

    // No active file, or a binary file: clear the view so neither stale text
    // nor garbled bytes show behind the overlay / binary pane.
    if (!activeFile || activeFile.kind !== "text") {
      view.setState(EditorState.create({ doc: "" }));
      lastPathRef.current = null;
      return;
    }

    const cached = stateCache.current.get(activeFile.path);
    view.setState(cached ?? freshState(activeFile));
    view.dispatch({ effects: [
      wrapComp.reconfigure(wrapValue(prefsRef.current)),
      lineNumComp.reconfigure(lineNumValue(prefsRef.current)),
      tabComp.reconfigure(tabValue(prefsRef.current)),
      fontComp.reconfigure(fontValue(prefsRef.current)),
    ]});
    lastPathRef.current = activeFile.path;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, workspaceId]);
```

- [ ] **Step 2: Add the binary overlay + import; gate the status bar**

Add the import near the other component imports at the top of `EditorPane.tsx`:

```tsx
import { EditorBinaryPane } from "./EditorBinaryPane";
```

In the returned JSX, the host is wrapped in `<div className="relative min-h-0 flex-1">`
with the empty-state overlay. Add a binary overlay as a sibling of the empty-state
overlay, and change the status-bar condition to text-only. The relevant block becomes:

```tsx
      <div className="relative min-h-0 flex-1">
        <div
          ref={hostRef}
          data-testid="editor-host"
          className="absolute inset-0 overflow-auto"
          style={{ background: "var(--color-octo-onyx)" }}
        />
        {!activeFile && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="font-serif text-[15px] text-octo-mute">
              Select a file from the tree to begin.
            </span>
          </div>
        )}
        {activeFile?.kind === "binary" && (
          <div
            className="absolute inset-0"
            style={{ background: "var(--color-octo-onyx)" }}
          >
            <EditorBinaryPane
              path={activeFile.path}
              size={activeFile.size}
              reason={activeFile.binaryReason ?? "binary"}
            />
          </div>
        )}
      </div>
      {activeFile?.kind === "text" && (
        <EditorStatusBar
          line={pos.line}
          col={pos.col}
          selectionCount={pos.selections}
          lang={activeFile.lang}
        />
      )}
```

(The previous `{activeFile && <EditorStatusBar .../>}` becomes `{activeFile?.kind === "text" && ...}`.)

- [ ] **Step 3: Update the test mocks + add a binary test**

In `src/components/EditorPane.test.tsx`:

(a) Add `kind: "text"` (and `mtime`/`size`) to the active-file mock so the existing tests
still see a text file. Change the `getFiles` mock object to:

```ts
      getFiles: (wsId: string) =>
        wsId === "ws-active"
          ? [{ path: "/repo/file.ts", content: "hello", savedContent: "hello", lang: "javascript", kind: "text", mtime: 0, size: 5 }]
          : wsId === "ws-binary"
          ? [{ path: "/repo/app.war", content: "", savedContent: "", lang: "plaintext", kind: "binary", binaryReason: "binary", mtime: 0, size: 2048 }]
          : [],
```

and the `getActivePath` mock:

```ts
      getActivePath: (wsId: string) =>
        wsId === "ws-active" ? "/repo/file.ts" : wsId === "ws-binary" ? "/repo/app.war" : null,
```

(b) Add a mock for the binary pane so the test stays isolated:

```ts
vi.mock("./EditorBinaryPane", () => ({
  EditorBinaryPane: () => <div data-testid="binary-pane" />,
}));
```

(c) Add the test inside `describe("EditorPane", ...)`:

```tsx
  it("renders the binary pane (not the status bar) for a binary file", () => {
    render(<EditorPane workspaceId="ws-binary" workspacePath="/repo" diffText="" />);
    expect(screen.getByTestId("binary-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("status-bar")).not.toBeInTheDocument();
  });
```

(The existing active-file test asserts the status bar / host for text; keep it.)

- [ ] **Step 4: Run tests + typecheck + build**

Run: `npx vitest run src/components/EditorPane.test.tsx 2>&1 | tail -8`
Expected: PASS (the 3 existing + 1 new binary test).

Run: `npm run typecheck 2>&1 | tail -5`
Expected: clean.

Run: `npm run build 2>&1 | tail -4`
Expected: Vite build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/EditorPane.tsx src/components/EditorPane.test.tsx
git commit -m "feat(g2): EditorPane renders binary pane and skips CM view for binaries"
```

---

## Task 7: App — inject the large-file confirm dialog

**Files:**
- Modify: `src/App.tsx` (the `navigateToFile` callback ~line 922-953 + render a `ConfirmDialog`)

- [ ] **Step 1: Add confirm state + helper**

In `App.tsx`, add these near the other `useState`/`useRef` hooks in the `App` component
(ensure `ConfirmDialog` and `formatBytes` are imported — add
`import { ConfirmDialog } from "./components/ConfirmDialog";` and
`import { formatBytes } from "./lib/formatBytes";` if not already present):

```tsx
  const [largeFile, setLargeFile] = useState<{ size: number; path: string } | null>(null);
  const largeFileResolver = useRef<((ok: boolean) => void) | null>(null);
  const confirmLargeFile = useCallback((size: number, path: string) => {
    return new Promise<boolean>((resolve) => {
      largeFileResolver.current = resolve;
      setLargeFile({ size, path });
    });
  }, []);
  const resolveLargeFile = useCallback((ok: boolean) => {
    largeFileResolver.current?.(ok);
    largeFileResolver.current = null;
    setLargeFile(null);
  }, []);
```

- [ ] **Step 2: Pass the confirm into `openFileInEditor`**

In the `navigateToFile` callback, change the editor-open call (line ~935) to pass the
confirm, and add `confirmLargeFile` to the dependency array:

```tsx
      if (view === "editor") {
        openFileInEditor(activeWorkspace.id, absolute, confirmLargeFile).catch((e) =>
          pushToast({
            level: "error",
            title: "Could not open file",
            body: String(e),
          }),
        );
      } else {
```

```tsx
    [activeWorkspace, project, openFileInEditor, setMode, confirmLargeFile],
```

- [ ] **Step 3: Render the ConfirmDialog**

Near where other top-level dialogs/modals are rendered in `App`'s JSX (e.g. alongside
`ConfirmDialog`/`Settings` usages), add:

```tsx
      {largeFile && (
        <ConfirmDialog
          title="Large file"
          body={`${largeFile.path.split("/").pop()} is ${formatBytes(largeFile.size)}. Opening large files can make the editor slow. Open anyway?`}
          destructiveLabel="Open anyway"
          cancelLabel="Cancel"
          onConfirm={() => resolveLargeFile(true)}
          onCancel={() => resolveLargeFile(false)}
        />
      )}
```

- [ ] **Step 4: Typecheck + build + full suite**

Run: `npm run typecheck 2>&1 | tail -5`
Expected: clean.

Run: `npm run build 2>&1 | tail -4`
Expected: Vite build succeeds.

Run: `npx vitest run 2>&1 | tail -6`
Expected: all tests pass (new suites: formatBytes, editorStore, EditorBinaryPane + extended EditorPane; pre-existing unrelated jsdom "errors" acceptable).

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat(g2): wire large-file confirm dialog into file open"
```

---

## Final verification (after all tasks)

- [ ] `cd src-tauri && cargo test 2>&1 | tail -6` — all Rust tests pass (incl. `file_io_tests`)
- [ ] `npm run typecheck` — clean
- [ ] `npx vitest run` — all tests pass
- [ ] `npm run build` — succeeds
- [ ] `git diff main...HEAD | grep -nE '#[0-9a-fA-F]{3,8}|rgba\('` — empty (no hardcoded colors; `EditorBinaryPane` uses tokens + `var(--brass-dim)`)
- [ ] Manual (`npm run tauri:dev`): open a generated `.war`/binary in the tree → binary pane with Reveal/Open (both work); open a normal source file → edits + saves as before; make a file read-only and save → error toast, file stays dirty; close the last tab → editor empty (no stale content).

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| `read_file_checked` tagged result (text/binary/unsupportedEncoding/tooLarge) | 1 |
| Binary sniff (NUL byte, 8 KB), size cap (50 MB), mtime millis | 1 |
| `write_file` returns mtime | 1 |
| `read_file_checked` registered in lib.rs | 1 |
| `ipc.readFileChecked` + `writeFile` return type | 3 |
| `OpenFile` gains kind/binaryReason/mtime/size | 4 |
| `openFile` branches per kind; injected confirm for large/too-large | 4, 7 |
| `saveActive` try/catch + toast + mtime; not-clean on failure | 4 |
| `isDirty` false for binary | 4 |
| `EditorBinaryPane` (Reveal/Open, formatBytes) | 2, 5 |
| `EditorPane` binary branch; skip CM view + status bar | 6 |
| Large-file `ConfirmDialog` injected from App | 7 |

Deferred (correctly absent): external-change/reload-or-overwrite + `file_meta` (Slice 2); auto-save (Slice 3); file-watching; binary preview; encoding conversion.
