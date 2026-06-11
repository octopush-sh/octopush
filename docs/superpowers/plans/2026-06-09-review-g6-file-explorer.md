# G6 · File Explorer Slice I Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every file (including gitignored/generated ones) reachable from the Companion file tree, with a context menu (Reveal/Open/Copy path), file-type icons, and Tier-0 token + a11y compliance.

**Architecture:** The Rust `read_directory` command gains an optional `show_ignored` flag (double-walk diff marks `isIgnored`); a persisted per-workspace pref in `reviewPrefsStore` drives an Eye toggle in the tree header; a new `FileTreeContextMenu` (portal + fixed, cloned from the ProjectContextMenu template) exposes existing reveal/open IPC; a pure `fileIcons.ts` maps extensions to lucide icons.

**Tech Stack:** Tauri 2 (Rust `ignore::WalkBuilder`), React 19 + TS, Zustand persist, lucide-react, Vitest + Testing Library, Rust `#[tokio::test]` + tempfile.

**Spec:** `docs/superpowers/specs/2026-06-09-review-g6-file-explorer-design.md` (approved). Branch `feat/review-g6-explorer` off `main`, worktree `/Users/jonathan/TYPEFY/octopus/octopus-sh-review`.

**Hard project rules:** tokens only (no hex/rgba literals in the diff), English-only UI copy, NO italics, reuse motion primitives (`octo-menu-enter`), `npm run typecheck` must pass. Frontend tests live next to source as `*.test.tsx`. Run frontend commands from the worktree root; Rust from `src-tauri/`.

---

### Task 1: Backend — `read_directory` gains `show_ignored` + `is_ignored`

**Files:**
- Modify: `src-tauri/src/commands.rs:1905-1985` (DirectoryEntry + read_directory)
- Modify: `src-tauri/src/tests.rs:1395-1454` (existing `read_directory_tests` mod — update call sites, add 2 tests)

The existing command walks one directory level with `ignore::WalkBuilder` and gitignore filtering always on. We add an optional second arg. Key invariant: **`show_ignored = None/Some(false)` must behave byte-for-byte like today** (single filtered walk, all `is_ignored: false`).

- [ ] **Step 1: Update the 3 existing test call sites** (the new param breaks compilation first — do this together with Step 2's new tests, then watch them fail to compile/pass for the right reason)

In `src-tauri/src/tests.rs`, the `read_directory_tests` mod calls `read_directory(...)` 3 times (lines ~1411, ~1435, ~1446). Add `None` as the second arg to each:

```rust
let entries = read_directory(root, None).await.expect("should succeed");
// ...
let result = read_directory("/nonexistent/path/abc123".to_string(), None).await;
// ...
let entries = read_directory(tmp.path().to_string_lossy().to_string(), None)
    .await
    .unwrap();
```

- [ ] **Step 2: Add the two new failing tests** to the same `read_directory_tests` mod (after `one_level_only`):

```rust
    #[tokio::test]
    async fn show_ignored_includes_and_flags_gitignored_entries() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("target")).unwrap();
        fs::write(tmp.path().join("target").join("app.war"), "x").unwrap();
        fs::write(tmp.path().join("main.rs"), "fn main() {}").unwrap();
        fs::write(tmp.path().join(".gitignore"), "target/\n").unwrap();
        let root = tmp.path().to_string_lossy().to_string();

        // Default mode: target absent, nothing flagged.
        let entries = read_directory(root.clone(), None).await.unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(!names.contains(&"target"), "default mode must hide gitignored dirs");
        assert!(entries.iter().all(|e| !e.is_ignored), "default mode never flags");

        // Show-ignored mode: target present, flagged, still sorted dirs-first.
        let entries = read_directory(root, Some(true)).await.unwrap();
        let target = entries
            .iter()
            .find(|e| e.name == "target")
            .expect("target must be visible in show-ignored mode");
        assert!(target.is_ignored, "target must be flagged ignored");
        assert!(target.is_dir);
        let main = entries.iter().find(|e| e.name == "main.rs").unwrap();
        assert!(!main.is_ignored, "tracked files must not be flagged");
        assert!(entries[0].is_dir, "dirs still sort before files");
    }

    #[tokio::test]
    async fn git_dir_excluded_in_both_modes() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join(".git")).unwrap();
        fs::write(tmp.path().join(".git").join("HEAD"), "ref").unwrap();
        fs::write(tmp.path().join("a.txt"), "x").unwrap();
        let root = tmp.path().to_string_lossy().to_string();

        for mode in [None, Some(false), Some(true)] {
            let entries = read_directory(root.clone(), mode).await.unwrap();
            assert!(
                entries.iter().all(|e| e.name != ".git"),
                ".git must be excluded for mode {mode:?}"
            );
        }
    }
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test read_directory`
Expected: compile error — `read_directory` takes 1 argument, and `is_ignored` doesn't exist on `DirectoryEntry`.

- [ ] **Step 4: Implement** — in `src-tauri/src/commands.rs`, replace the `DirectoryEntry` struct and `read_directory` function (keep the doc comments' spirit; the helper goes right above the command):

```rust
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_ignored: bool,
}

/// One level of `base`: entry paths only (root itself and `.git` excluded).
/// `apply_ignore_filters = true` is today's behavior (gitignore rules on);
/// `false` disables every ignore source so gitignored entries appear too.
fn walk_one_level(base: &std::path::Path, apply_ignore_filters: bool) -> Vec<std::path::PathBuf> {
    let mut builder = ignore::WalkBuilder::new(base);
    builder
        .max_depth(Some(1))
        .standard_filters(true)
        .require_git(false) // apply .gitignore rules even outside a git repo
        .hidden(false); // include dot-files like .gitignore itself
    if !apply_ignore_filters {
        builder
            .git_ignore(false)
            .git_global(false)
            .git_exclude(false)
            .ignore(false)
            .parents(false);
    }
    let mut out = Vec::new();
    for result in builder.build() {
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.depth() == 0 {
            continue;
        }
        if entry.path().file_name().map(|n| n == ".git").unwrap_or(false) {
            continue;
        }
        out.push(entry.path().to_path_buf());
    }
    out
}

/// Read one level of a directory. By default `.gitignore` rules apply (today's
/// behavior). With `show_ignored = Some(true)`, gitignored entries are included
/// and flagged `is_ignored: true` (computed by diffing against the filtered
/// walk of the same directory — both walks are max_depth(1), so this is cheap).
/// Directories are returned first (alphabetical), then files (alphabetical).
/// `.git` is always excluded.
#[tauri::command]
pub async fn read_directory(
    path: String,
    show_ignored: Option<bool>,
) -> AppResult<Vec<DirectoryEntry>> {
    let path = expand_tilde(&path);
    let base = std::path::Path::new(&path);

    if !base.exists() {
        return Err(AppError::Other(format!("Path does not exist: {}", path)));
    }
    if !base.is_dir() {
        return Err(AppError::Other(format!("Not a directory: {}", path)));
    }

    // (path, is_ignored) pairs for this level.
    let entries: Vec<(std::path::PathBuf, bool)> = if show_ignored.unwrap_or(false) {
        let filtered: std::collections::HashSet<std::path::PathBuf> =
            walk_one_level(base, true).into_iter().collect();
        walk_one_level(base, false)
            .into_iter()
            .map(|p| {
                let ignored = !filtered.contains(&p);
                (p, ignored)
            })
            .collect()
    } else {
        walk_one_level(base, true)
            .into_iter()
            .map(|p| (p, false))
            .collect()
    };

    let mut dirs: Vec<DirectoryEntry> = Vec::new();
    let mut files: Vec<DirectoryEntry> = Vec::new();
    for (entry_path, is_ignored) in entries {
        let name = entry_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let is_dir = entry_path.is_dir();
        let de = DirectoryEntry {
            name,
            path: entry_path.to_string_lossy().into_owned(),
            is_dir,
            is_ignored,
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

No `lib.rs` change needed — `read_directory` is already registered; only its signature grew an optional arg.

- [ ] **Step 5: Run the Rust suite**

Run: `cd src-tauri && cargo test`
Expected: all pass, including the 5 `read_directory` tests (3 old + 2 new).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/tests.rs
git commit -m "feat(review/g6): read_directory show_ignored flag + isIgnored entry marking"
```

---

### Task 2: Frontend plumbing — types, ipc, reviewPrefsStore

**Files:**
- Modify: `src/lib/types.ts:277-281` (DirectoryEntry)
- Modify: `src/lib/ipc.ts:303` (readDirectory)
- Modify: `src/stores/reviewPrefsStore.ts` (showIgnoredFiles + toggleShowIgnored)
- Test: `src/stores/reviewPrefsStore.test.ts` (append)

- [ ] **Step 1: Write the failing store test** — append to the existing `describe` block in `src/stores/reviewPrefsStore.test.ts` (match the file's existing import/reset style):

```ts
  it("toggleShowIgnored flips the per-root flag without touching other roots", () => {
    useReviewPrefs.setState({ showIgnoredFiles: {} });

    useReviewPrefs.getState().toggleShowIgnored("/repo");
    expect(useReviewPrefs.getState().showIgnoredFiles["/repo"]).toBe(true);
    expect(useReviewPrefs.getState().showIgnoredFiles["/other"]).toBeUndefined();

    useReviewPrefs.getState().toggleShowIgnored("/repo");
    expect(useReviewPrefs.getState().showIgnoredFiles["/repo"]).toBe(false);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- reviewPrefsStore`
Expected: FAIL — `toggleShowIgnored` is not a function / TS error on `showIgnoredFiles`.

- [ ] **Step 3: Implement the three plumbing changes**

`src/lib/types.ts` — extend the interface:

```ts
export interface DirectoryEntry {
  name: string;
  path: string;
  isDir: boolean;
  isIgnored: boolean;
}
```

`src/lib/ipc.ts` line 303 — optional flag (Tauri 2 maps camelCase `showIgnored` to the Rust `show_ignored` arg, same convention as `sessionId` elsewhere in this file):

```ts
  readDirectory: (path: string, showIgnored?: boolean) =>
    invoke<DirectoryEntry[]>("read_directory", { path, showIgnored }),
```

`src/stores/reviewPrefsStore.ts` — full new content (existing fields preserved):

```ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ReadingMode = "inline" | "sbs";

interface ReviewPrefsState {
  readingMode: ReadingMode;
  ignoreWhitespace: boolean;
  /** Per-workspace "show gitignored files in the tree" pref, keyed by rootPath. */
  showIgnoredFiles: Record<string, boolean>;
  setReadingMode: (m: ReadingMode) => void;
  setIgnoreWhitespace: (v: boolean) => void;
  toggleShowIgnored: (rootPath: string) => void;
}

export const useReviewPrefs = create<ReviewPrefsState>()(
  persist(
    (set) => ({
      readingMode: "inline",
      ignoreWhitespace: false,
      showIgnoredFiles: {},
      setReadingMode: (readingMode) => set({ readingMode }),
      setIgnoreWhitespace: (ignoreWhitespace) => set({ ignoreWhitespace }),
      toggleShowIgnored: (rootPath) =>
        set((s) => ({
          showIgnoredFiles: {
            ...s.showIgnoredFiles,
            [rootPath]: !s.showIgnoredFiles[rootPath],
          },
        })),
    }),
    { name: "octo-review-prefs" },
  ),
);
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -- reviewPrefsStore && npm run typecheck`
Expected: store test passes. Typecheck passes — the only `DirectoryEntry` consumers are `ipc.ts` and `CompanionFileTree.tsx` (which reads `name`/`path`/`isDir` only, so the added required field breaks nothing; test fixtures are untyped `vi.fn()` mocks).

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/ipc.ts src/stores/reviewPrefsStore.ts src/stores/reviewPrefsStore.test.ts
git commit -m "feat(review/g6): isIgnored type, readDirectory showIgnored arg, per-workspace pref"
```

---

### Task 3: File-type icons — `fileIcons.ts` + tree rows

**Files:**
- Create: `src/lib/fileIcons.ts`
- Create: `src/lib/fileIcons.test.ts`
- Modify: `src/components/CompanionFileTree.tsx:158-167` (file indicator span)

- [ ] **Step 1: Write the failing unit tests** — `src/lib/fileIcons.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { File, FileArchive, FileCode, FileCog, FileJson, FileLock } from "lucide-react";
import { fileIcon } from "./fileIcons";

describe("fileIcon", () => {
  it("maps code extensions", () => {
    expect(fileIcon("Main.java")).toBe(FileCode);
    expect(fileIcon("app.tsx")).toBe(FileCode);
  });

  it("maps archives including .war", () => {
    expect(fileIcon("app.war")).toBe(FileArchive);
    expect(fileIcon("bundle.tar.gz")).toBe(FileArchive);
  });

  it("maps data files case-insensitively", () => {
    expect(fileIcon("config.YAML")).toBe(FileJson);
    expect(fileIcon("package.json")).toBe(FileJson);
  });

  it("maps dotfile configs", () => {
    expect(fileIcon(".gitignore")).toBe(FileCog);
  });

  it("maps lockfiles by full name", () => {
    expect(fileIcon("Cargo.lock")).toBe(FileLock);
    expect(fileIcon("package-lock.json")).toBe(FileLock);
  });

  it("falls back to the generic File icon", () => {
    expect(fileIcon("unknown.xyz")).toBe(File);
    expect(fileIcon("LICENSE")).toBe(File);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- fileIcons`
Expected: FAIL — module `./fileIcons` not found.

- [ ] **Step 3: Implement** — `src/lib/fileIcons.ts` (pure module, no React):

```ts
import {
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileTerminal,
  FileText,
  type LucideIcon,
} from "lucide-react";

const CODE = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "java", "py", "go", "rb", "c",
  "h", "cpp", "hpp", "cc", "cs", "swift", "kt", "kts", "php", "sql", "html",
  "css", "scss", "less", "vue", "svelte",
]);
const DATA = new Set(["json", "yaml", "yml", "toml", "xml", "csv"]);
const TEXT = new Set(["md", "mdx", "txt", "rtf", "log"]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"]);
const ARCHIVE = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "war", "jar", "ear"]);
const SHELL = new Set(["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"]);
const CONFIG = new Set([
  "env", "ini", "conf", "cfg", "properties", "gitignore", "gitattributes",
  "editorconfig", "dockerignore", "npmrc", "nvmrc",
]);
const LOCKFILE_NAMES = new Set(["cargo.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);

/** Map a file name to its lucide icon component. Pure; safe to call per row. */
export function fileIcon(name: string): LucideIcon {
  const lower = name.toLowerCase();
  if (LOCKFILE_NAMES.has(lower)) return FileLock;
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot + 1) : "";
  if (CODE.has(ext)) return FileCode;
  if (DATA.has(ext)) return FileJson;
  if (TEXT.has(ext)) return FileText;
  if (IMAGE.has(ext)) return FileImage;
  if (ARCHIVE.has(ext)) return FileArchive;
  if (SHELL.has(ext)) return FileTerminal;
  if (CONFIG.has(ext)) return FileCog;
  if (ext === "lock") return FileLock;
  return File;
}
```

(Note: `.gitignore` → `lastIndexOf(".") === 0` → ext `"gitignore"` → CONFIG. `bundle.tar.gz` → ext `"gz"` → ARCHIVE.)

- [ ] **Step 4: Wire into the tree** — in `src/components/CompanionFileTree.tsx`, import at top:

```ts
import { fileIcon } from "../lib/fileIcons";
```

Inside `TreeNode`, just before `return`:

```ts
  const Icon = !isDir ? fileIcon(label) : null;
```

Replace the file indicator span (current lines 158-167, the `◦`/`●` branch) with — the brass `●` changed indicator stays exactly as-is, the `◦` dot becomes the icon:

```tsx
        ) : isChanged ? (
          <span
            className="shrink-0 font-mono text-[10px]"
            style={{ color: "var(--color-octo-brass)" }}
          >
            ●
          </span>
        ) : (
          Icon && (
            <Icon
              size={12}
              aria-hidden="true"
              className="shrink-0"
              style={{ color: "var(--color-octo-mute)" }}
            />
          )
        )}
```

- [ ] **Step 5: Run the affected suites + typecheck**

Run: `npm test -- fileIcons CompanionFileTree && npm run typecheck`
Expected: all pass — the existing "shows brass dot for changed files" test asserts `●` present on changed and absent on unchanged rows, both still true.

- [ ] **Step 6: Commit**

```bash
git add src/lib/fileIcons.ts src/lib/fileIcons.test.ts src/components/CompanionFileTree.tsx
git commit -m "feat(review/g6): file-type icons in the companion tree"
```

---

### Task 4: Show-ignored toggle + dimmed ignored entries

**Files:**
- Modify: `src/components/CompanionFileTree.tsx` (header toggle, fetch flag, cache invalidation, dimming)
- Test: `src/components/CompanionFileTree.test.tsx` (fixtures + new tests)

- [ ] **Step 1: Update fixtures and add the failing tests** in `src/components/CompanionFileTree.test.tsx`.

Add `isIgnored: false` to every fixture entry (ROOT_CHILDREN, SRC_CHILDREN, and the inline fixtures in the empty-folder and depth tests), e.g.:

```ts
const ROOT_CHILDREN = [
  { name: "src", path: "/repo/src", isDir: true, isIgnored: false },
  { name: "docs", path: "/repo/docs", isDir: true, isIgnored: false },
  { name: "pom.xml", path: "/repo/pom.xml", isDir: false, isIgnored: false },
];
```

Add imports + store reset. At the top (after the existing imports):

```ts
import { useReviewPrefs } from "../stores/reviewPrefsStore";
```

In `beforeEach`, after `vi.clearAllMocks()`:

```ts
  useReviewPrefs.setState({ showIgnoredFiles: {} });
```

New tests (inside the `describe`):

```tsx
  it("eye toggle re-fetches with showIgnored=true and shows dimmed ignored entries", async () => {
    mockReadDirectory.mockImplementation((path: string, show?: boolean) => {
      if (path === ROOT) {
        return Promise.resolve(
          show
            ? [
                ...ROOT_CHILDREN,
                { name: "build", path: "/repo/build", isDir: true, isIgnored: true },
                { name: "app.war", path: "/repo/app.war", isDir: false, isIgnored: true },
              ]
            : ROOT_CHILDREN,
        );
      }
      return Promise.resolve([]);
    });

    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());
    expect(screen.queryByText("app.war")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /show ignored files/i }));

    await waitFor(() => expect(screen.getByText("app.war")).toBeInTheDocument());
    expect(mockReadDirectory).toHaveBeenLastCalledWith(ROOT, true);

    // Ignored entries are dimmed but still clickable rows.
    expect(screen.getByText("app.war").className).toContain("text-octo-mute");
    expect(screen.getByText("build").className).toContain("text-octo-mute");
    // Non-ignored entries keep their normal color.
    expect(screen.getByText("pom.xml").className).toContain("text-octo-sage");
  });

  it("toggling back off re-fetches without the flag and hides ignored entries", async () => {
    mockReadDirectory.mockImplementation((path: string, show?: boolean) => {
      if (path === ROOT) {
        return Promise.resolve(
          show
            ? [...ROOT_CHILDREN, { name: "app.war", path: "/repo/app.war", isDir: false, isIgnored: true }]
            : ROOT_CHILDREN,
        );
      }
      return Promise.resolve([]);
    });

    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /show ignored files/i }));
    await waitFor(() => expect(screen.getByText("app.war")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /show ignored files/i }));
    await waitFor(() => expect(screen.queryByText("app.war")).not.toBeInTheDocument());
    expect(mockReadDirectory).toHaveBeenLastCalledWith(ROOT, false);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- CompanionFileTree`
Expected: FAIL — no button named "Show ignored files".

- [ ] **Step 3: Implement in `CompanionFileTree.tsx`.**

New imports at the top:

```ts
import { useRef } from "react"; // merge into the existing react import
import { Eye, EyeOff } from "lucide-react";
import { useReviewPrefs } from "../stores/reviewPrefsStore";
```

Inside `CompanionFileTree`, read the pref and add a fetch-generation guard (invalidates in-flight responses when the toggle flips):

```ts
  const showIgnored = useReviewPrefs((s) => !!s.showIgnoredFiles[rootPath]);
  const toggleShowIgnored = useReviewPrefs((s) => s.toggleShowIgnored);
  const genRef = useRef(0);
```

Replace `fetchChildren` with (adds the flag, a `force` option, and the stale-response guard):

```ts
  const fetchChildren = useCallback(
    async (path: string, opts?: { force?: boolean }) => {
      if (!opts?.force && children[path] && children[path] !== "error") return; // already cached
      const gen = genRef.current;
      setChildren((prev) => ({ ...prev, [path]: "loading" }));
      try {
        const entries = await ipc.readDirectory(path, showIgnored);
        if (genRef.current !== gen) return; // toggle flipped mid-flight; discard
        setChildren((prev) => ({ ...prev, [path]: entries }));
      } catch {
        if (genRef.current !== gen) return;
        setChildren((prev) => ({ ...prev, [path]: "error" }));
      }
    },
    [children, showIgnored],
  );
```

Replace the root-mount effect (lines 32-36) with one that also handles toggle flips — it clears the cache and force-refetches every expanded folder:

```ts
  // (Re)load on mount, on workspace switch, and when the show-ignored toggle
  // flips: bump the generation (discarding in-flight responses), drop the
  // cache, and force-refetch every expanded folder.
  useEffect(() => {
    genRef.current += 1;
    setChildren({});
    const toFetch = new Set(expanded);
    toFetch.add(rootPath); // a freshly-switched workspace root may not be in `expanded` yet
    for (const p of toFetch) {
      void fetchChildren(p, { force: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, showIgnored]);
```

(`expanded` is intentionally not a dependency — expansion fetches are handled by `toggleExpand`; this effect only owns mount/workspace-switch/toggle reloads.)

Replace the `<h3>` header (lines 58-60) so the eyebrow row carries the toggle:

```tsx
      <h3 className="flex h-11 shrink-0 items-center justify-between border-b border-octo-hairline px-4 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
        Files
        <button
          type="button"
          aria-label="Show ignored files"
          aria-pressed={showIgnored}
          title={showIgnored ? "Hide ignored files" : "Show ignored files"}
          onClick={() => toggleShowIgnored(rootPath)}
          className="rounded-sm p-1 transition-colors duration-[220ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          {showIgnored ? (
            <Eye size={12} className="text-octo-brass" />
          ) : (
            <EyeOff size={12} className="text-octo-mute" />
          )}
        </button>
      </h3>
```

Thread `isIgnored` through `TreeNode`. Add to `TreeNodeProps`:

```ts
  isIgnored: boolean;
```

Root call site gets `isIgnored={false}`; the recursive call site (in the children map) gets `isIgnored={entry.isIgnored}`. Destructure `isIgnored` in `TreeNode`'s parameter list.

Update `depthColorClass` (ignored wins over depth, loses to changed):

```ts
/** Returns the label color class for a file/folder based on state and depth. */
function depthColorClass(depth: number, isChanged: boolean, isIgnored: boolean): string {
  if (isChanged) return "text-octo-ivory";
  if (isIgnored) return "text-octo-mute";
  if (depth >= 4) return "text-octo-mute";
  return "text-octo-sage";
}
```

…and its call site in the label span:

```tsx
            className={`min-w-0 truncate font-mono text-[11px] ${depthColorClass(depth, isChanged, isIgnored)}`}
```

Dim the file icon for ignored entries too — in the `Icon` render from Task 3, swap the inline color for a conditional:

```tsx
              style={{ color: "var(--color-octo-mute)", opacity: isIgnored ? 0.6 : 1 }}
```

- [ ] **Step 4: Run the suite + typecheck**

Run: `npm test -- CompanionFileTree reviewPrefsStore && npm run typecheck`
Expected: all pass, including the pre-existing cache test ("does NOT re-fetch when a folder is collapsed and re-expanded") — `fetchChildren` without `force` still respects the cache.

- [ ] **Step 5: Commit**

```bash
git add src/components/CompanionFileTree.tsx src/components/CompanionFileTree.test.tsx
git commit -m "feat(review/g6): show-ignored toggle with per-workspace persistence + dimmed ignored entries"
```

---

### Task 5: Context menu — `FileTreeContextMenu` + row wiring

**Files:**
- Create: `src/components/FileTreeContextMenu.tsx`
- Create: `src/components/FileTreeContextMenu.test.tsx`
- Modify: `src/components/CompanionFileTree.tsx` (menu state + `onContextMenu` on rows)
- Modify: `src/components/CompanionFileTree.test.tsx` (ipc mock gains the 3 fns + integration test)

- [ ] **Step 1: Write the failing component tests** — `src/components/FileTreeContextMenu.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockReveal, mockOpenSystem, mockOpenTerminal, mockPushToast } = vi.hoisted(() => ({
  mockReveal: vi.fn().mockResolvedValue(undefined),
  mockOpenSystem: vi.fn().mockResolvedValue(undefined),
  mockOpenTerminal: vi.fn().mockResolvedValue(undefined),
  mockPushToast: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({
  ipc: {
    revealInFinder: mockReveal,
    openFileInSystem: mockOpenSystem,
    openInTerminal: mockOpenTerminal,
  },
}));

vi.mock("./Toasts", () => ({ pushToast: mockPushToast }));

import { FileTreeContextMenu } from "./FileTreeContextMenu";

const mockWriteText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(navigator, { clipboard: { writeText: mockWriteText } });
});

function renderMenu(overrides: Partial<Parameters<typeof FileTreeContextMenu>[0]> = {}) {
  const onDismiss = vi.fn();
  render(
    <FileTreeContextMenu
      path="/repo/src/Main.java"
      name="Main.java"
      isDir={false}
      rootPath="/repo"
      x={100}
      y={100}
      onDismiss={onDismiss}
      {...overrides}
    />,
  );
  return { onDismiss };
}

describe("FileTreeContextMenu", () => {
  it("file target: shows file items, not the folder-only item", () => {
    renderMenu();
    expect(screen.getByRole("menuitem", { name: /reveal in finder/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /open in system app/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /copy path/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /copy relative path/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /open in terminal/i })).not.toBeInTheDocument();
  });

  it("folder target: shows Open in terminal, not Open in system app", () => {
    renderMenu({ path: "/repo/src", name: "src", isDir: true });
    expect(screen.getByRole("menuitem", { name: /open in terminal/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /open in system app/i })).not.toBeInTheDocument();
  });

  it("Reveal in Finder calls ipc and dismisses", async () => {
    const { onDismiss } = renderMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: /reveal in finder/i }));
    expect(mockReveal).toHaveBeenCalledWith("/repo/src/Main.java");
    expect(onDismiss).toHaveBeenCalled();
  });

  it("Open in system app calls ipc with the file path", async () => {
    renderMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: /open in system app/i }));
    expect(mockOpenSystem).toHaveBeenCalledWith("/repo/src/Main.java");
  });

  it("Copy path writes the absolute path and toasts", async () => {
    renderMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: /^copy path$/i }));
    expect(mockWriteText).toHaveBeenCalledWith("/repo/src/Main.java");
  });

  it("Copy relative path strips the root prefix", async () => {
    renderMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: /copy relative path/i }));
    expect(mockWriteText).toHaveBeenCalledWith("src/Main.java");
  });

  it("renders into document.body (portal) with fixed positioning", () => {
    const { container } = (() => {
      const onDismiss = vi.fn();
      return render(
        <div style={{ overflow: "hidden" }}>
          <FileTreeContextMenu
            path="/repo/a.txt"
            name="a.txt"
            isDir={false}
            rootPath="/repo"
            x={10}
            y={10}
            onDismiss={onDismiss}
          />
        </div>,
      );
    })();
    const menu = screen.getByRole("menu");
    // Portal: the menu is NOT inside the overflow-hidden wrapper.
    expect(container.contains(menu)).toBe(false);
    expect(menu.className).toContain("fixed");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- FileTreeContextMenu`
Expected: FAIL — module `./FileTreeContextMenu` not found.

- [ ] **Step 3: Implement** — `src/components/FileTreeContextMenu.tsx`:

```tsx
import { createPortal } from "react-dom";
import { Copy, ExternalLink, FolderOpen, SquareTerminal } from "lucide-react";
import { useMenuChrome } from "../lib/useMenuChrome";
import { ipc } from "../lib/ipc";
import { pushToast } from "./Toasts";

interface Props {
  /** Absolute path of the right-clicked entry. */
  path: string;
  /** Display name (file or folder basename). */
  name: string;
  isDir: boolean;
  /** Workspace root, for computing the relative path. */
  rootPath: string;
  x: number;
  y: number;
  onDismiss: () => void;
}

const ITEM =
  "flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass";
const SEP = "h-px bg-octo-hairline";

function relativePath(abs: string, root: string): string {
  if (abs === root) return ".";
  if (abs.startsWith(root + "/")) return abs.slice(root.length + 1);
  return abs;
}

/**
 * Context menu for companion file-tree rows. Rendered via a portal to
 * document.body with fixed positioning so it escapes the tree's
 * overflow-y-auto scroll container (same lesson as the ModelPicker dropdown).
 */
export function FileTreeContextMenu({ path, name, isDir, rootPath, x, y, onDismiss }: Props) {
  const { ref, pos } = useMenuChrome(x, y, onDismiss);

  const run = (fn: () => void) => () => {
    fn();
    onDismiss();
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => pushToast({ level: "success", title: "Path copied" }),
      (e) => pushToast({ level: "error", title: "Copy failed", body: String(e) }),
    );
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={`Actions for ${name}`}
      className="octo-menu-enter fixed z-[60] w-[224px] rounded-md border border-octo-hairline bg-octo-panel py-1 shadow-2xl"
      style={{ left: pos.left, top: pos.top, transformOrigin: "top left" }}
    >
      <div className="truncate px-3 pb-1 pt-1 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute">
        {name}
      </div>

      <button type="button" role="menuitem" className={ITEM} onClick={run(() => void ipc.revealInFinder(path))}>
        <FolderOpen size={12} className="shrink-0" /> Reveal in Finder
      </button>
      {isDir ? (
        <button type="button" role="menuitem" className={ITEM} onClick={run(() => void ipc.openInTerminal(path))}>
          <SquareTerminal size={12} className="shrink-0" /> Open in terminal
        </button>
      ) : (
        <button type="button" role="menuitem" className={ITEM} onClick={run(() => void ipc.openFileInSystem(path))}>
          <ExternalLink size={12} className="shrink-0" /> Open in system app
        </button>
      )}

      <div className={SEP} />

      <button type="button" role="menuitem" className={ITEM} onClick={run(() => copy(path))}>
        <Copy size={12} className="shrink-0" /> Copy path
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={run(() => copy(relativePath(path, rootPath)))}>
        <Copy size={12} className="shrink-0" /> Copy relative path
      </button>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 4: Run the component tests**

Run: `npm test -- FileTreeContextMenu`
Expected: PASS (all 8).

- [ ] **Step 5: Wire into the tree.** In `src/components/CompanionFileTree.tsx`:

Import:

```ts
import { FileTreeContextMenu } from "./FileTreeContextMenu";
```

Menu state in `CompanionFileTree` (alongside `expanded`/`children`):

```ts
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; name: string; isDir: boolean } | null>(null);
```

Add a context-menu callback prop to `TreeNodeProps`:

```ts
  onRowContextMenu: (e: React.MouseEvent, path: string, name: string, isDir: boolean) => void;
```

In `CompanionFileTree`, define and pass it (root `<TreeNode>` call site gets `onRowContextMenu={onRowContextMenu}`; the recursive call site passes it through like the other props):

```ts
  const onRowContextMenu = useCallback(
    (e: React.MouseEvent, path: string, name: string, isDir: boolean) => {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, path, name, isDir });
    },
    [],
  );
```

On the row `<div>` in `TreeNode`, add:

```tsx
        onContextMenu={(e) => onRowContextMenu(e, path, label, isDir)}
```

Render the menu at the end of `CompanionFileTree`'s `<section>` (after the scroll container, before `</section>`):

```tsx
      {menu && (
        <FileTreeContextMenu
          path={menu.path}
          name={menu.name}
          isDir={menu.isDir}
          rootPath={rootPath}
          x={menu.x}
          y={menu.y}
          onDismiss={() => setMenu(null)}
        />
      )}
```

- [ ] **Step 6: Add the integration test.** In `src/components/CompanionFileTree.test.tsx`: extend the ipc mock so menu clicks don't explode, import `fireEvent`, and add the test.

Update the mock block:

```ts
const { mockReadDirectory, mockReveal, mockOpenSystem, mockOpenTerminal } = vi.hoisted(() => ({
  mockReadDirectory: vi.fn(),
  mockReveal: vi.fn().mockResolvedValue(undefined),
  mockOpenSystem: vi.fn().mockResolvedValue(undefined),
  mockOpenTerminal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/ipc", () => ({
  ipc: {
    readDirectory: mockReadDirectory,
    revealInFinder: mockReveal,
    openFileInSystem: mockOpenSystem,
    openInTerminal: mockOpenTerminal,
  },
}));
```

Update the testing-library import:

```ts
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
```

New test:

```tsx
  it("right-clicking a file row opens the context menu with file items", async () => {
    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());
    await userEvent.click(screen.getByText("src"));
    await waitFor(() => expect(screen.getByText("Main.java")).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByTestId("file-row-/repo/src/Main.java"));

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /open in system app/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /open in terminal/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("menuitem", { name: /reveal in finder/i }));
    expect(mockReveal).toHaveBeenCalledWith("/repo/src/Main.java");
    // Menu dismissed after action.
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });
```

- [ ] **Step 7: Run both suites + typecheck**

Run: `npm test -- FileTreeContextMenu CompanionFileTree && npm run typecheck`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/components/FileTreeContextMenu.tsx src/components/FileTreeContextMenu.test.tsx src/components/CompanionFileTree.tsx src/components/CompanionFileTree.test.tsx
git commit -m "feat(review/g6): file-tree context menu — reveal, open, copy path (portal + fixed)"
```

---

### Task 6: Tier-0 — tokens, tree roles, keyboard focus

**Files:**
- Modify: `src/components/CompanionFileTree.tsx` (rgba→`var(--brass-dim)`, `role` attributes, `tabIndex` + key handling + focus ring)
- Test: `src/components/CompanionFileTree.test.tsx` (a11y tests)

- [ ] **Step 1: Write the failing a11y tests** in `CompanionFileTree.test.tsx`:

```tsx
  it("exposes tree semantics: role=tree, treeitems, aria-expanded on dirs", async () => {
    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());

    expect(screen.getByRole("tree", { name: /workspace files/i })).toBeInTheDocument();

    const items = screen.getAllByRole("treeitem");
    expect(items.length).toBeGreaterThanOrEqual(4); // root + src + docs + pom.xml

    // The src dir row is collapsed → aria-expanded=false; expanding flips it.
    const srcRow = screen.getByText("src").closest('[role="treeitem"]') as HTMLElement;
    expect(srcRow).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(screen.getByText("src"));
    await waitFor(() => expect(srcRow).toHaveAttribute("aria-expanded", "true"));

    // File rows carry no aria-expanded.
    const fileRow = screen.getByTestId("file-row-/repo/pom.xml");
    expect(fileRow).not.toHaveAttribute("aria-expanded");
  });

  it("Enter on a focused file row opens the file; Space toggles a dir", async () => {
    const onFileClick = vi.fn();
    render(
      <CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} onFileClick={onFileClick} />,
    );
    await waitFor(() => expect(screen.getByText("pom.xml")).toBeInTheDocument());

    const fileRow = screen.getByTestId("file-row-/repo/pom.xml");
    fileRow.focus();
    fireEvent.keyDown(fileRow, { key: "Enter" });
    expect(onFileClick).toHaveBeenCalledWith("/repo/pom.xml");

    const srcRow = screen.getByText("src").closest('[role="treeitem"]') as HTMLElement;
    fireEvent.keyDown(srcRow, { key: " " });
    await waitFor(() => expect(screen.getByText("Main.java")).toBeInTheDocument());
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- CompanionFileTree`
Expected: FAIL — no element with role "tree".

- [ ] **Step 3: Implement in `CompanionFileTree.tsx`:**

Scroll container (line ~62) gains the tree role:

```tsx
      <div role="tree" aria-label="Workspace files" className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
```

Row `<div>` in `TreeNode` — add role, focusability, keyboard handling, and the focus ring class. The full opening tag becomes:

```tsx
      <div
        role="treeitem"
        aria-expanded={isDir ? isExpanded : undefined}
        tabIndex={0}
        className="group relative flex cursor-pointer items-center gap-1 rounded-sm py-1 pr-1 transition-colors duration-[220ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
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
          if (isDir) {
            onToggle(path);
          } else if (onFileClick) {
            onFileClick(path);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (isDir) {
              onToggle(path);
            } else if (onFileClick) {
              onFileClick(path);
            }
          }
        }}
        onContextMenu={(e) => onRowContextMenu(e, path, label, isDir)}
        data-testid={!isDir ? `file-row-${path}` : undefined}
      >
```

Children wrapper (the `isDir && isExpanded` block's `<div>`) gains the group role:

```tsx
        <div role="group">
```

Token swaps — § glyph (line ~174):

```tsx
            style={{ color: "var(--brass-dim)" }}
```

…and the `IndentGuides` border color:

```tsx
              borderColor: isCurrentLevel
                ? "var(--brass-dim)" // current row's guide
                : "var(--color-octo-hairline)", // ancestor guides recede via opacity
```

- [ ] **Step 4: Verify zero color literals remain**

Run: `grep -nE '#[0-9a-fA-F]{3,8}|rgba?\(' src/components/CompanionFileTree.tsx src/components/FileTreeContextMenu.tsx src/lib/fileIcons.ts`
Expected: no output.

- [ ] **Step 5: Run the full frontend suite + typecheck, and the Rust suite**

Run: `npm test && npm run typecheck && cd src-tauri && cargo test && cd ..`
Expected: everything green. (Pre-existing PTY sandbox failures in `cargo test` are known-ignorable per project memory — everything else must pass.)

- [ ] **Step 6: Commit**

```bash
git add src/components/CompanionFileTree.tsx src/components/CompanionFileTree.test.tsx
git commit -m "feat(review/g6): tier-0 — brass-dim tokens, tree/treeitem roles, keyboard focus"
```

---

## Done criteria (whole branch)

- `target/*.war`-style gitignored files are visible (dimmed) when the eye toggle is on, and right-clickable → Reveal in Finder / Open in system app / Copy path work.
- Toggle state persists per workspace across app restarts.
- Default tree (toggle off) is pixel- and behavior-identical to before except: file icons instead of `◦`, tokens instead of rgba literals, and a11y roles.
- `npm test`, `npm run typecheck`, `cargo test` all green; no hex/rgba literals in the diff; UI copy English-only; no italics; no new colors or motion.
