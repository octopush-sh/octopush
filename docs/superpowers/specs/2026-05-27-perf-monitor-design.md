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

- **App** = the main Octopush process (`std::process::id()`) **plus all of its
  descendant processes** (the WebKit `*.Helper` content/GPU/network processes
  Tauri spawns). RSS and CPU are summed across the tree. This is the number
  that reflects what the user feels.
- **Daemon** = the `octopush-pty-server` process **only**. Its child processes
  are the user's shells and whatever they run (npm, tests, agents) — those are
  user workloads, not Octopush overhead, so they are **excluded**.
- **Total** = App + Daemon.

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

1. Refresh the `System`.
2. Build a `pid -> parent_pid` map from the process list.
3. `collect_descendants(app_pid, &map)` → the set of app pids (app + WebKit
   helpers). **Pure function, unit-tested** with a synthetic parent map.
4. Read the daemon pid from `~/.octopush/pty-server.pid` (the file the daemon
   already writes via `acquire_pid_file`). If absent/stale, the daemon group is
   reported as zero.
5. `sum_group(pids, &system)` → `ProcGroup` (sum RSS, sum CPU, count). **Pure
   function, unit-tested** with synthetic process data.
6. Assemble `PerfStats` and return.

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
