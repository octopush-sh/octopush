# G2 · Editor Reliability & File I/O — Slice 1 design

> Part of the REVIEW-mode overhaul (master tracker:
> `docs/superpowers/plans/2026-06-07-review-mode-master-grouping.md`, stream **G2**,
> priority rank 4 — after G3/G5/G1, all merged). Branch `feat/review-g2-reliability`
> off `main`, worktree `octopus-sh-review`. Status: **spec'd** (slice 1 of ~3).

## Goal

Make the editor refuse to lose or corrupt work. Slice 1 hardens the **open** and
**save** paths: a guarded read that detects binary / oversized / non-UTF-8 files
instead of garbling them, a dedicated binary-file pane (with Reveal-in-Finder /
Open-in-system actions), and a save-failure toast so write errors stop being
swallowed. It also captures each open file's `mtime` — the foundation Slice 2 uses
for external-change detection.

## Why slice (the 3-slice plan)

- **Slice I — Safe open + honest save (this spec).** `read_file_checked`,
  binary/large/encoding handling, `EditorBinaryPane`, save-failure toast, `mtime`
  capture.
- **Slice II — External-change safety (future).** Standalone `file_meta`; on
  window-focus and before-save, compare disk `mtime` vs the tracked value; if changed
  under the user (agents write files directly — see Current state), show a
  reload-or-overwrite `ConfirmDialog`.
- **Slice III — Auto-save (future, optional).** `autoSave` toggle in
  `editorPrefsStore` + debounced save.

## Current state (verified, for a fresh implementer)

- **`src-tauri/src/commands.rs`** — `read_file(path) -> AppResult<String>` is
  `std::fs::read_to_string` with **no** size/binary/encoding guard (fails on non-UTF-8).
  `write_file(path, content) -> AppResult<()>` is `std::fs::write` returning nothing.
  Both call `expand_tilde(&path)` first. `AppResult<T> = Result<T, AppError>`
  (`error.rs`); `AppError::Other(String)` serializes to a plain JSON string.
- **`src-tauri/src/lib.rs`** — commands registered in `tauri::generate_handler![...]`
  (includes `commands::read_file, commands::write_file`).
- **`src/lib/ipc.ts`** — `readFile: (path) => invoke<string>("read_file", { path })`,
  `writeFile: (path, content) => invoke<void>("write_file", { path, content })`. Tauri
  auto-maps camelCase JS args → snake_case Rust params; return structs need
  `#[serde(rename_all = "camelCase")]`.
- **`src/stores/editorStore.ts`** — `OpenFile = { path, content, savedContent, lang }`
  (no mtime). `openFile` does `const content = await ipc.readFile(path)` then pushes an
  `OpenFile`. `saveActive` does `await ipc.writeFile(activePath, file.content)` with
  **no try/catch**, then marks the file clean. `isDirty = content !== savedContent`.
- **`src/components/EditorPane.tsx`** — renders the CodeMirror view for the active
  file; the active-file/empty-state branch is at the bottom of the component. `onSave`
  is `() => saveActive(workspaceId).catch(console.error)` (swallows errors).
- **`src/components/EditorStatusBar.tsx`** — bottom rail; props
  `{ line, col, selectionCount, lang }`.
- **Toasts** (`src/components/Toasts.tsx`) — `pushToast({ level, title, body?, timeout? })`,
  `level ∈ "info"|"success"|"warning"|"error"`. Importable + callable anywhere.
- **`src/components/ConfirmDialog.tsx`** — props `{ title, body, destructiveLabel,
  cancelLabel?, requireInput?, onConfirm, onCancel }`; built on `ModalShell`.
- **Reveal/Open IPC already exist** — `ipc.revealInFinder(path)` (`open -R`, macOS),
  `ipc.openFileInSystem(path)` (`open` / `xdg-open`). Reuse; do not rebuild.
- **No file-watching** (no `notify` crate). Agents write files directly to disk via the
  chat tool executor (`chat_engine.rs`, `std::fs::write`) — never notifying the editor.
  (External-change detection is Slice 2; Slice 1 only *captures* mtime.)
- **`src/stores/editorPrefsStore.ts`** (G1) — `{ wrap, fontSize, tabWidth, lineNumbers }`
  + setters, zustand+persist (`octo-editor-prefs`). (Auto-save toggle would live here in
  Slice 3 — not this slice.)

## Architecture (chosen approach: one guarded read command)

A single new backend command returns a **tagged result** so the open path is one
round-trip and the Rust side owns the stat + binary-sniff + capped read. The frontend
branches on `kind`.

### A. Backend — `read_file_checked`

```rust
// Thresholds (module consts in commands.rs)
const BINARY_SNIFF_BYTES: usize = 8192;     // bytes inspected for a NUL byte
const LARGE_WARN_BYTES: u64 = 2 * 1024 * 1024;   // 2 MB — frontend warns before open
const READ_CAP_BYTES: u64   = 50 * 1024 * 1024;  // 50 MB — hard cap, refuse above

#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileReadResult {
    #[serde(rename = "text")]
    Text { content: String, size: u64, mtime: i64 },   // mtime = epoch millis
    #[serde(rename = "binary")]
    Binary { size: u64, mtime: i64 },
    #[serde(rename = "unsupportedEncoding")]
    UnsupportedEncoding { size: u64, mtime: i64 },
    #[serde(rename = "tooLarge")]
    TooLarge { size: u64 },
}

#[tauri::command]
pub async fn read_file_checked(path: String, max_bytes: Option<u64>) -> AppResult<FileReadResult> {
    let path = expand_tilde(&path);
    let meta = std::fs::metadata(&path)
        .map_err(|e| AppError::Other(format!("read_file_checked({path}): {e}")))?;
    let size = meta.len();
    let mtime = mtime_millis(&meta);            // helper below; 0 on failure
    let cap = max_bytes.unwrap_or(READ_CAP_BYTES);
    if size > cap {
        return Ok(FileReadResult::TooLarge { size });
    }
    let bytes = std::fs::read(&path)
        .map_err(|e| AppError::Other(format!("read_file_checked({path}): {e}")))?;
    // Binary sniff: a NUL byte in the head is the standard "this is binary" heuristic.
    if bytes.iter().take(BINARY_SNIFF_BYTES).any(|&b| b == 0) {
        return Ok(FileReadResult::Binary { size, mtime });
    }
    match String::from_utf8(bytes) {
        Ok(content) => Ok(FileReadResult::Text { content, size, mtime }),
        Err(_) => Ok(FileReadResult::UnsupportedEncoding { size, mtime }),
    }
}
```

`mtime_millis(&meta)` is a small helper: `meta.modified().ok()` →
`duration_since(UNIX_EPOCH)` → `as_millis() as i64`, returning `0` on error.

`LARGE_WARN_BYTES` is **not** enforced in Rust — the frontend uses the returned `size`
to decide whether to prompt. Two distinct cases:
1. A file between `LARGE_WARN_BYTES` and `READ_CAP_BYTES` (2–50 MB) comes back as
   `Text` already (the 50 MB cap didn't trip). The warn is purely a frontend confirm
   *before accepting* that already-loaded result — **no re-read**.
2. A file above `READ_CAP_BYTES` (>50 MB) comes back as `TooLarge` (no content/mtime).
   Confirming re-reads with `max_bytes` set effectively unlimited
   (`Number.MAX_SAFE_INTEGER`) to actually load it (the user explicitly accepted the
   OOM risk). The re-read result is then branched normally (`Text`/`Binary`).

See Data flow.

### B. Backend — `write_file` returns the new mtime

Change `write_file` to return the post-write mtime so a save updates the tracked value
(prevents Slice 2 false positives after our own save):

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult { pub mtime: i64 }

#[tauri::command]
pub async fn write_file(path: String, content: String) -> AppResult<WriteResult> {
    let path = expand_tilde(&path);
    std::fs::write(&path, content)
        .map_err(|e| AppError::Other(format!("write_file({path}): {e}")))?;
    let mtime = std::fs::metadata(&path).map(|m| mtime_millis(&m)).unwrap_or(0);
    Ok(WriteResult { mtime })
}
```

Register `read_file_checked` in `lib.rs`'s `generate_handler!`. `write_file` stays
registered (signature change only).

### C. Frontend IPC (`ipc.ts`)

```ts
export type FileReadResult =
  | { kind: "text"; content: string; size: number; mtime: number }
  | { kind: "binary"; size: number; mtime: number }
  | { kind: "unsupportedEncoding"; size: number; mtime: number }
  | { kind: "tooLarge"; size: number };

readFileChecked: (path: string, maxBytes?: number) =>
  invoke<FileReadResult>("read_file_checked", { path, maxBytes }),
writeFile: (path: string, content: string) =>
  invoke<{ mtime: number }>("write_file", { path, content }),
```

(Keep the existing `readFile` for any non-editor callers; the editor switches to
`readFileChecked`.)

### D. Store (`editorStore.ts`)

`OpenFile` gains `kind`, `mtime`, `size`. The `unsupportedEncoding` case is stored as
`kind: "binary"` with a `binaryReason` so the pane shows the right message — keeping
`EditorPane`'s branch a simple `kind === "binary"` check.

```ts
export type BinaryReason = "binary" | "unsupportedEncoding";
export interface OpenFile {
  path: string;
  content: string;        // "" for binary
  savedContent: string;   // "" for binary
  lang: string;
  kind: "text" | "binary";
  binaryReason?: BinaryReason;  // set when kind==="binary"
  mtime: number;
  size: number;
}
```

`openFile(workspaceId, path)` becomes:

1. `let res = await ipc.readFileChecked(path)`.
2. If `res.kind === "tooLarge"`: `if (!(await confirm(res.size, path))) return;` (no tab
   on decline). Otherwise `res = await ipc.readFileChecked(path, Number.MAX_SAFE_INTEGER)`
   and fall through to branch on the new `res`.
3. `binary` / `unsupportedEncoding` → push an `OpenFile` with `kind:"binary"`,
   `binaryReason` (`"unsupportedEncoding"` maps reason; both render the binary pane),
   empty content, `mtime`/`size` from the result.
4. `text` with `res.size > LARGE_WARN_BYTES` → `if (!(await confirm(res.size, path)))
   return;` then push the text `OpenFile` (content already in hand — no re-read).
5. `text` (≤ `LARGE_WARN_BYTES`) → push an `OpenFile` with `kind:"text"`, `content`,
   `savedContent=content`, `lang`, `mtime`, `size` (current behavior + the new fields).

`LARGE_WARN_BYTES` is mirrored as a frontend constant (or returned in a future field —
for Slice 1 a shared `2 * 1024 * 1024` constant in the store is fine).

`isDirty` returns `false` for `kind:"binary"` (binary files are never dirty).

`saveActive` wraps the write:

```ts
try {
  const { mtime } = await ipc.writeFile(activePath, file.content);
  // mark clean + update tracked mtime
  set(/* savedContent = content, mtime */);
} catch (e) {
  pushToast({
    level: "error",
    title: "Couldn't save file",
    body: `${fileName}: ${e instanceof Error ? e.message : String(e)}`,
    timeout: 7000,
  });
  // do NOT mark clean — the file stays dirty
}
```

The `tooLarge` confirm cannot be a blocking `window.confirm` (design system: use
`ConfirmDialog`). Since the store can't render a dialog, the **confirm is injected**:
`openFile` accepts an optional `confirm?: (sizeBytes:number, path:string) =>
Promise<boolean>` argument supplied by the caller (`App.navigateToFile` /
`openFileInEditor`), which renders a `ConfirmDialog` and resolves the promise. If no
`confirm` is provided (e.g. tests), default to **declining** large files (safe). This
keeps the store UI-free.

### E. Components

- **`src/components/EditorBinaryPane.tsx`** *(new)* — props `{ path, size,
  reason: BinaryReason }`. Atelier placeholder centered in the editor area: an eyebrow
  (`§ BINARY` in brass mono), the file name (mono), a human-readable size
  (`formatBytes(size)`), a message — `"This file can't be edited as text."` for
  `binary`, `"Unsupported text encoding — can't be edited as text."` for
  `unsupportedEncoding` — and two buttons: **Reveal in Finder** → `ipc.revealInFinder(path)`,
  **Open in system** → `ipc.openFileInSystem(path)`. Tokens only, English copy, focus
  rings. A small `formatBytes` helper lives in this file (or `src/lib/formatBytes.ts` if
  reused — check first; otherwise local).
- **`src/components/EditorPane.tsx`** — when `activeFile.kind === "binary"`, render
  `<EditorBinaryPane path size reason>` inside the host area instead of the CodeMirror
  view, and do **not** mount `<EditorStatusBar>` for binary files (or mount a minimal
  variant — Slice 1 hides it for binaries to avoid Ln/Col on a non-text file). The
  CodeMirror view-creation/swap effects must **skip** binary files (guard:
  `activeFile.kind === "text"`), so no CodeMirror state is built for a binary tab.
- **Large-file `ConfirmDialog`** — rendered by App (the `confirm` injected into
  `openFile`): `title: "Large file"`, `body: "<name> is <size>. Opening large files can
  make the editor slow. Open anyway?"`, `destructiveLabel: "Open anyway"`,
  `cancelLabel: "Cancel"`.

### F. EditorTabs

Binary tabs render like any tab (filename + close). No dirty dot for binary files
(`isDirty` is false). No other change.

## Data flow

```
click file in tree → App.navigateToFile(path,"editor") → openFileInEditor(ws, path, confirm)
  → editorStore.openFile(ws, path, confirm)
      → ipc.readFileChecked(path)
          ├ text (≤2MB)  → OpenFile{kind:text, content, mtime, size}  → CodeMirror renders
          ├ text (>2MB)  → confirm(size,path)? yes → text OpenFile (no re-read) / no → no tab
          ├ binary/unsupportedEncoding → OpenFile{kind:binary,…}      → EditorBinaryPane renders
          └ tooLarge (>50MB) → confirm? yes → re-read(MAX) → branch as above / no → no tab
save (⌘S) → saveActive
  → ipc.writeFile → {mtime}  → mark clean + store mtime
  → on reject     → pushToast(error) + stay dirty
```

## Error handling

- Every editor I/O failure surfaces: open failures that aren't a tagged result
  (e.g. `metadata` errors → the command returns `Err`) propagate to `openFile`'s caller,
  which shows an error toast (`App` wraps `openFileInEditor` in a `.catch` → `pushToast`).
- Save failures → error toast, file stays dirty (never silently "saved").
- Binary/encoding/too-large are **not** errors — they're expected tagged outcomes with
  dedicated UI.

## Testing

- **Rust** (`src-tauri/src/tests.rs`): `read_file_checked` on a temp dir — UTF-8 text →
  `Text` with correct content/size and `mtime > 0`; a file with a NUL byte → `Binary`; a
  file of invalid UTF-8 (no NUL, e.g. `0xff 0xfe`) → `UnsupportedEncoding`; a file larger
  than a small `max_bytes` → `TooLarge`. `write_file` returns a `WriteResult` with
  `mtime > 0` and the bytes land on disk.
- **Frontend** (vitest, `ipc` mocked):
  - `editorStore`: `openFile` branches per `kind` (text stores content+mtime+size;
    binary stores `kind:"binary"`+reason, empty content; tooLarge calls the injected
    confirm and opens only on accept / re-reads with raised cap); `isDirty` false for
    binary; `saveActive` success updates mtime + clears dirty; `saveActive` failure calls
    `pushToast` (mock) and leaves the file dirty.
  - `EditorBinaryPane`: renders name/size/message per reason; Reveal/Open buttons call
    `ipc.revealInFinder`/`ipc.openFileInSystem` with the path.
  - `EditorPane`: a binary `activeFile` renders `EditorBinaryPane` and does **not**
    create a CodeMirror view (assert via the existing CM mock that `setState` isn't
    driven for binary) and hides the status bar.

## Scope guardrails (YAGNI / out of scope for Slice 1)

External-change detection / reload-or-overwrite prompt and the standalone `file_meta`
command (Slice 2 — uses the `mtime` Slice 1 stores); auto-save (Slice 3); file-watching
(`notify` crate); binary *preview* (hex/image viewers); encoding *conversion* (we detect
and refuse, we don't transcode); per-workspace I/O settings.

## Design-system compliance

Tokens only (no hardcoded hex/rgba). English-only UI copy. No italics. The binary pane
and dialogs reuse existing Atelier primitives (`ModalShell`/`ConfirmDialog`, toast
styles, brass eyebrow + mono meta). No new top-level chrome; the binary pane occupies the
existing editor canvas area, mirroring the empty-state pane.
