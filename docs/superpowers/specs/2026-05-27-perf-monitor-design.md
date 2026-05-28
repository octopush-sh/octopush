# Performance Monitor — design

**Date:** 2026-05-27
**Status:** Approved (pending spec review)
**Author:** brainstorming session

## Motivation

The user perceives sluggishness in Octopush's UI responses and wants a way to
tell whether the app is overloading itself (excessive cycles, runaway memory)
versus an environmental cause (nearly-full disk, etc.). The ask: a persistent
performance readout at the bottom of the window — RAM and CPU — similar to the
status-bar monitors other tools ship.

Because most of a Tauri app's memory and a re-render storm's CPU live in the
**WebKit content processes** (not the main Rust process), a monitor that only
measured the main process would under-report and fail to surface the very
problem we're chasing. The design therefore measures the **whole app process
tree**.

## Goals

- Always-visible bottom status strip showing **total RAM (RSS) + CPU%** for
  Octopush.
- Click to expand a popover with a **per-process-group breakdown**: App vs.
  pty daemon.
- Lightweight enough that the monitor itself doesn't meaningfully add to the
  load it measures.

## Non-goals (v1)

- Historical graphs / sparklines over time.
- Threshold alerts / notifications.
- A React re-render profiler. (If, after measuring, the bottleneck is clearly
  in the WebView, that's a separate follow-up.)
- Disk / network metrics.

## Metric definitions

Two process **groups**, plus a total:

- **App** = the main Octopush process (`std::process::id()`) **plus every process
  macOS considers it "responsible" for** — chiefly the WebKit content/GPU/network
  XPC processes. NOTE: on macOS those WebKit processes are *reparented to launchd*
  (their parent pid is 1), so a naive process-tree walk from the app pid misses
  them. We therefore group by the OS **responsible pid**
  (`responsibility_get_pid_responsible_for_pid`, the same signal Activity Monitor
  uses), not by parent/child descent. The daemon happens to be a *child* of the
  app, so it is explicitly excluded from this group (see below). This is the
  number that reflects what the user feels.
- **Daemon** = the `octopush-pty-server` process **only**. It is a child of the
  app process, and its own children are the user's shells and whatever they run
  (npm, tests, agents) — all of that is user workload, not Octopush overhead, so
  the daemon's whole subtree is **excluded** from the App group and only the
  single daemon pid is counted here.
- **Total** = App + Daemon. (No double-counting: the daemon is removed from the
  App group via its process subtree before summing.)

Each group reports `{ rss_bytes, cpu_pct, process_count }`.

CPU% is Activity-Monitor style (relative to one core; a process saturating two
cores reads ~200%). It is computed by `sysinfo` between successive refreshes of
a persistent `System` instance, so the value reflects usage over the most
recent poll window.

## Backend (Rust)

### Dependency

Add the `sysinfo` crate (process features only). It abstracts process
enumeration, RSS, CPU, and parent/child relationships across platforms and
avoids hand-rolled `libc` process-walking.

### State

A persistent `Mutex<System>` held in Tauri-managed state (so CPU deltas are
computed between polls). Refreshed on each `get_perf_stats` call; only
processes are refreshed (not disks/networks).

### Command

```rust
#[tauri::command]
fn get_perf_stats(state) -> PerfStats
```

```rust
struct ProcGroup { rss_bytes: u64, cpu_pct: f32, process_count: u32 }
struct PerfStats { app: ProcGroup, daemon: ProcGroup, total: ProcGroup, ts: i64 }
```

(`PerfStats` is serialized camelCase for the frontend: `rssBytes`, `cpuPct`,
`processCount`.)

### Logic

1. Lock the persistent `System` and refresh processes → flatten into
   `Vec<ProcSample>` (`{ pid, ppid, rss_bytes, cpu_pct }`); release the lock.
2. Read the daemon pid from `~/.octopush/pty-server.pid` (the file the daemon
   already writes via `acquire_pid_file`). If absent/stale, the daemon group is
   reported as zero (its pid won't be found in the live sample).
3. Build `responsible_map` = `pid -> responsible_pid(pid)` via the macOS
   `responsibility_get_pid_responsible_for_pid` FFI (`responsible_pid` falls back
   to the pid itself on failure / off macOS).
4. `compute_app_pids(samples, app_pid, daemon_pid, &responsible_map)` → the App
   group: pids whose responsible pid is `app_pid`, **minus** the daemon's
   process subtree (`collect_descendants(daemon_pid)`). **Pure function,
   unit-tested** with a synthetic responsible map (covers: WebKit helper
   reparented to launchd but responsible-to-app → included; daemon + its shell
   child → excluded; unrelated process → excluded).
5. `compute_stats(samples, &app_pids, daemon_pid, ts)` sums each group via
   `sum_group` (App = app_pids, Daemon = the single daemon pid, Total =
   App + Daemon). **Pure function, unit-tested.**

The FFI (`responsible_pid`/`responsible_map`) and sampling are the only impure
parts; the classification (`compute_app_pids`) and aggregation (`compute_stats`)
are pure and fully unit-tested. The command is `async` so the per-poll process
scan + FFI loop run off the Tauri main/UI thread.

## Frontend (React + Zustand)

### Store: `perfStore`

```ts
{ stats: PerfStats | null, start(): void, stop(): void }
```

- A single polling loop (one `setInterval`) started once from `App` on mount.
- Interval: **2000ms**.
- **Pauses when `document.hidden`** is true (skip the IPC call when the window
  is hidden/backgrounded) so the monitor doesn't burn cycles when unobserved.
- Each tick calls `ipc.getPerfStats()` and sets `stats`. Only components
  subscribed to `perfStore` re-render — i.e. the bar/popover, nothing else.

### Component: `PerfMonitorBar`

- Thin (~22px) full-width strip, always visible.
- Collapsed content: `⌗ 412 MB · CPU 6%` (total). `⌗` glyph in brass.
- Click toggles a small popover anchored to the bar showing per-group rows:
  `App   318 MB   4%   (5 procs)` / `Daemon   94 MB   2%`.
- Atelier styling: `bg-octo-panel`, top `border-octo-hairline`, JetBrains Mono,
  values in brass, labels in mute. No bouncing/spring; calm.
- A `formatBytes(n)` helper (→ "412 MB") is a pure, unit-tested function.

### Layout placement

The app shell becomes a column:

```
┌───────────────────────────────────────────┐
│  [ WorkspaceRail │ main (header/canvas/…) ] │  ← flex-1 row
├───────────────────────────────────────────┤
│  PerfMonitorBar (full width)               │  ← ~22px
└───────────────────────────────────────────┘
```

i.e. wrap the existing `flex h-screen` row in a `flex-col h-screen`, with the
bar as the second child spanning the full window width (classic status bar,
under both rail and main).

## Cadence & overhead

- 2s poll, paused when hidden.
- `sysinfo` refreshes only processes.
- Net cost: one small IPC round-trip + a process refresh every 2s while the
  window is visible. Negligible relative to the app's normal work.

## Testing

**Backend (Rust):**
- `collect_descendants` — synthetic `pid -> ppid` map; asserts the full
  descendant set (including grandchildren) and excludes unrelated trees.
- `sum_group` — synthetic process RSS/CPU; asserts summation + count.
- `PerfStats` serializes to the expected camelCase JSON shape.

**Frontend (Vitest):**
- `perfStore` — start() polls and sets `stats` (mock `ipc.getPerfStats`); stop()
  clears the interval; hidden document skips the call.
- `formatBytes` — bytes → human string boundaries (KB/MB/GB).
- `PerfMonitorBar` — renders the total; clicking toggles the per-group popover.

## Design-system note

A bottom status bar is **new top-level chrome**, which `CLAUDE.md` / the Atelier
surface contract currently discourages. This is added at the user's explicit
request and is designed to be calm and Atelier-native (panel bg, hairline,
mono, brass values, no motion). To prevent pattern drift, the design system
docs (`docs/design-system.md` and the UX redesign spec) will be updated to
include the status-bar surface as a sanctioned part of the layout.

## Out of scope / future

- Time-series history and sparkline.
- Per-threshold warnings.
- React re-render profiling (revisit only if measurement points at the WebView).
