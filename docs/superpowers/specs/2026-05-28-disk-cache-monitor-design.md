# Disk & Cache in the Performance Monitor — design

**Date:** 2026-05-28
**Status:** Approved (pending spec review)
**Sub-project:** B of the "providers + perf-disk" release

## Motivation

The user's original "Octopush feels slow" report turned out to have a disk
component: the Rust `target/` build cache had grown to ~34 GB and exhausted free
space. The performance monitor (bottom bar: RAM + CPU, with an App/Daemon
popover) already exists; extending it to surface **free disk space** and the
**size of the active workspace's build/cache directories** gives that problem
visibility without leaving the app. This is read-only — no destructive cleanup
in v1 (explicitly chosen).

## Goals

- Show **free disk space** (the volume containing the user's home dir) in the
  monitor, refreshed on the existing 2 s poll.
- On opening the monitor popover, show the **sizes of common build/cache
  directories** in the active workspace (e.g. `target`, `node_modules`, `dist`,
  `build`, `.next`, `.gradle`, `__pycache__`, `.venv`) plus a total — computed
  **on demand**, not on the poll.
- Stay calm and read-only; no cleanup/delete action.

## Non-goals (v1)

- Destructive cache cleanup / delete buttons.
- Multi-volume reporting (only the home-dir volume).
- Per-package or deep breakdowns (just the top-level cache dir sizes).
- Computing cache sizes on the 2 s poll (it's a directory walk — far too
  expensive to run continuously; on-demand only).

## Architecture

Extends the existing monitor (`src-tauri/src/perf.rs`, `get_perf_stats`,
`src/stores/perfStore.ts`, `src/components/PerfMonitorBar.tsx`). Two distinct
data paths by cost:

- **Disk free (cheap, polled):** folded into `get_perf_stats` via `sysinfo`'s
  disk list. Refreshed every 2 s with the rest of the stats.
- **Cache sizes (expensive, on-demand):** a separate command invoked only when
  the popover opens (and not on a timer), because summing `target/` /
  `node_modules/` is a full directory walk.

## Backend (Rust)

### `perf.rs`

- Add `DiskInfo { free_bytes: u64, total_bytes: u64 }` and a field `disk:
  DiskInfo` on `PerfStats` (serde camelCase → `freeBytes` / `totalBytes`, and
  `disk` on the payload).
- `fn home_disk(disks: &sysinfo::Disks) -> DiskInfo`: pick the disk whose mount
  point is the longest prefix of `$HOME` (the volume home lives on); return its
  `available_space()` / `total_space()`. Falls back to the root (`/`) mount if
  home can't be matched. **Pure-ish helper** taking the refreshed disk list, so
  the mount-selection logic is unit-testable with a synthetic mount list.
- `pub fn dir_size(path: &Path) -> u64`: recursively sum file sizes under
  `path` (follows entries, not symlinks; ignores errors on individual entries).
  Pure, unit-testable.
- `pub const CACHE_DIR_NAMES: &[&str] = &["target", "node_modules", "dist",
  "build", ".next", ".nuxt", ".gradle", "__pycache__", ".venv", "venv",
  ".turbo", "out"];`
- `pub fn scan_caches(workspace_root: &Path) -> Vec<(String, u64)>`: for each
  name in `CACHE_DIR_NAMES`, if `workspace_root/name` exists and is a dir,
  include `(name, dir_size(...))`. Returns only present dirs. Unit-testable with
  a temp workspace.

### `commands.rs`

- Extend `get_perf_stats` (already `async`) to also compute `disk`: create a
  short-lived `sysinfo::Disks::new_with_refreshed_list()` in the command each
  call and pass it to `home_disk(...)`. This is cheap and needs no change to
  `PerfState` (which keeps holding only the process `System`).
- New command `get_workspace_cache_sizes(workspace_path: String) -> Result<{
  entries: Vec<{ name: String, bytes: u64 }>, total_bytes: u64 }, AppError>`:
  runs `scan_caches` on the path off the UI thread (it's `async`, so Tauri runs
  it off-thread; the walk can take a second). Returns entries + total. Empty/
  missing path → empty result.

## Frontend (React + TypeScript)

### Types / ipc

- `PerfStats` (in `src/lib/types.ts`) gains `disk: { freeBytes: number;
  totalBytes: number }`.
- `WorkspaceCacheSizes { entries: { name: string; bytes: number }[]; totalBytes:
  number }` type.
- `ipc.getWorkspaceCacheSizes(workspacePath: string)` → that type.

### `perfStore`

- No structural change beyond the `disk` field arriving inside `stats` (already
  set by the polled `get_perf_stats`). Cache sizes are NOT in the store — they're
  fetched ad-hoc by the component.

### `PerfMonitorBar`

- Receives a new optional prop `workspacePath?: string` (passed from `App`, which
  knows the active workspace).
- **Bar line** gains disk free: `⌗ 412 MB · CPU 6% · 18 GB free` — the free value
  in brass (the key "running low" signal), formatted with the existing
  `formatBytes`.
- **Popover** keeps the App/Daemon rows and adds a **"Workspace caches"** section.
  On the popover opening (a `useEffect` keyed on `open` + `workspacePath`), it
  calls `ipc.getWorkspaceCacheSizes(workspacePath)` once, shows a brief
  "scanning…" state, then lists each cache dir + size and a total. If there's no
  active workspace or no cache dirs, it shows a quiet "—" / "no build caches".
- A small "rescan" affordance (re-runs the fetch) is acceptable but optional.

### `App.tsx`

- Pass `workspacePath={activeWorkspace?.worktreePath ?? project?.path}` to
  `<PerfMonitorBar />`.

## Data flow

- Disk free: `get_perf_stats` (polled 2 s) → `perfStore.stats.disk` → bar.
- Cache sizes: popover opens → `getWorkspaceCacheSizes(workspacePath)` → local
  component state → popover list. Re-fetched when the workspace path changes or
  on manual rescan.

## Error handling

- `dir_size` ignores per-entry errors (permission denied, races) and sums what it
  can — never panics.
- A failed cache-size fetch shows a quiet error line in the popover; the rest of
  the monitor is unaffected.
- Disk selection falls back to `/` if `$HOME`'s volume can't be matched.

## Design-system alignment (Atelier in Onyx & Brass)

Extends the existing monitor surface — no new chrome:

- Bar stays a single calm mono line; disk-free uses `text-octo-brass` for the
  value, `text-octo-mute` for the unit/label, consistent with RAM/CPU. Tokens only.
- The popover "Workspace caches" rows match the existing App/Daemon `PerfRow`
  shape: label in `text-octo-sage`, size in `font-mono` `text-octo-ivory`, total
  in `text-octo-mute`. Eyebrow "WORKSPACE CACHES" in `font-mono text-[9-10px]
  uppercase tracking-[0.25em] text-octo-mute`.
- No italics; calm motion (the "scanning…" state is a quiet text swap, no spinner
  animation beyond a subtle one if any, ≤280ms). Read-only — no destructive
  styling needed.

## Testing

**Backend (Rust):**
- `dir_size`: temp dir with known file sizes (incl. a nested subdir) → exact byte
  sum.
- `scan_caches`: temp workspace containing e.g. `target/` + `node_modules/` (with
  files) and some non-cache dirs → returns only the cache entries with correct
  sizes; absent names omitted.
- `home_disk` mount selection: synthetic mount list → picks the longest-prefix
  mount of a given home path; falls back to `/`.

**Frontend (Vitest):**
- `formatBytes` already covers byte formatting (reused).
- `PerfMonitorBar`: with `stats.disk` set, the bar renders the free value; opening
  the popover triggers `getWorkspaceCacheSizes` (ipc mocked) and lists the
  returned entries + total; no workspace path → quiet empty state.
- `perfStore`: `disk` field flows through from a mocked `get_perf_stats`.

## Out of scope / future

- One-click destructive cache cleanup.
- Multiple volumes.
- Deep/per-package size breakdown; size history over time.
