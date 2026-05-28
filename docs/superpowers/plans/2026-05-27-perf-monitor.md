# Performance Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an always-visible bottom status bar showing Octopush's RAM (RSS) + CPU%, with a click-to-expand per-process-group breakdown (app process tree vs pty daemon).

**Architecture:** A Rust `perf` module samples process metrics via the `sysinfo` crate against a persistent `System` (so CPU% is computed between polls). A `get_perf_stats` Tauri command groups the app process tree (main pid + WebKit helper descendants) and the daemon process (single pid, excluding its shell children), returning RSS/CPU/count per group + total. A Zustand `perfStore` polls every 2s (paused when the window is hidden); a `PerfMonitorBar` renders the total and a per-group popover.

**Tech Stack:** Rust (Tauri 2, `sysinfo`, `parking_lot`, `serde`), React 19 + TypeScript, Zustand, Tailwind v4, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-27-perf-monitor-design.md`

---

## File Structure

**Backend (`src-tauri/`):**
- Create `src/perf.rs` — types (`ProcSample`, `ProcGroup`, `PerfStats`), pure grouping functions, the `PerfState` sampler, daemon-pid resolution, and the live sampling helper. Inline `#[cfg(test)]` tests (matches `session.rs`).
- Modify `Cargo.toml` — add `sysinfo`.
- Modify `src/commands.rs` — add the `get_perf_stats` command.
- Modify `src/lib.rs` — `mod perf;`, `.manage(perf::PerfState::new())`, register `commands::get_perf_stats` in the invoke handler.

**Frontend (`src/`):**
- Modify `lib/types.ts` — `ProcGroup`, `PerfStats`.
- Modify `lib/ipc.ts` — `getPerfStats()`.
- Create `lib/formatBytes.ts` + `lib/formatBytes.test.ts` — pure byte formatter.
- Create `stores/perfStore.ts` + `stores/perfStore.test.ts` — polling store.
- Create `components/PerfMonitorBar.tsx` + `components/PerfMonitorBar.test.tsx`.
- Modify `App.tsx` — wrap shell in a column, mount `<PerfMonitorBar/>` at the bottom, start/stop the poll.

**Docs:**
- Modify `docs/design-system.md` — sanction the bottom status-bar surface.

---

## Task 1: Rust perf module — types + pure grouping functions

**Files:**
- Create: `src-tauri/src/perf.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod perf;`)
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add the `sysinfo` dependency**

In `src-tauri/Cargo.toml`, under `[dependencies]`, add:

```toml
sysinfo = { version = "0.32", default-features = false, features = ["system"] }
```

- [ ] **Step 2: Create `src-tauri/src/perf.rs` with types + pure functions (tests first in same file)**

```rust
//! Process performance sampling for the in-app monitor.
//!
//! Two groups are reported: `app` (the Octopush main process plus its WebKit
//! helper descendants) and `daemon` (the `octopush-pty-server` process only —
//! its shell children are user workloads, not Octopush overhead), plus a total.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use sysinfo::System;

/// A flattened, sysinfo-independent view of one process.
#[derive(Debug, Clone, Copy)]
pub struct ProcSample {
    pub pid: u32,
    pub ppid: Option<u32>,
    pub rss_bytes: u64,
    pub cpu_pct: f32,
}

/// Aggregated metrics for a group of processes.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcGroup {
    pub rss_bytes: u64,
    pub cpu_pct: f32,
    pub process_count: u32,
}

impl ProcGroup {
    pub fn zero() -> Self {
        ProcGroup { rss_bytes: 0, cpu_pct: 0.0, process_count: 0 }
    }
    pub fn plus(&self, other: &ProcGroup) -> ProcGroup {
        ProcGroup {
            rss_bytes: self.rss_bytes + other.rss_bytes,
            cpu_pct: self.cpu_pct + other.cpu_pct,
            process_count: self.process_count + other.process_count,
        }
    }
}

/// Full payload returned to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfStats {
    pub app: ProcGroup,
    pub daemon: ProcGroup,
    pub total: ProcGroup,
    pub ts: i64,
}

/// Build a `parent_pid -> [child_pid]` map from samples.
pub fn children_map(samples: &[ProcSample]) -> HashMap<u32, Vec<u32>> {
    let mut m: HashMap<u32, Vec<u32>> = HashMap::new();
    for s in samples {
        if let Some(pp) = s.ppid {
            m.entry(pp).or_default().push(s.pid);
        }
    }
    m
}

/// Build a `pid -> sample` lookup.
pub fn samples_by_pid(samples: &[ProcSample]) -> HashMap<u32, ProcSample> {
    samples.iter().map(|s| (s.pid, *s)).collect()
}

/// Returns `root` together with all of its descendant pids (depth-first,
/// cycle-safe via the visited set).
pub fn collect_descendants(root: u32, children_by_parent: &HashMap<u32, Vec<u32>>) -> HashSet<u32> {
    let mut out = HashSet::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if out.insert(pid) {
            if let Some(kids) = children_by_parent.get(&pid) {
                stack.extend(kids.iter().copied());
            }
        }
    }
    out
}

/// Sum RSS + CPU and count the processes in `pids` that exist in `samples`.
pub fn sum_group(pids: &HashSet<u32>, samples: &HashMap<u32, ProcSample>) -> ProcGroup {
    let mut g = ProcGroup::zero();
    for pid in pids {
        if let Some(s) = samples.get(pid) {
            g.rss_bytes += s.rss_bytes;
            g.cpu_pct += s.cpu_pct;
            g.process_count += 1;
        }
    }
    g
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(pid: u32, ppid: Option<u32>, rss: u64, cpu: f32) -> ProcSample {
        ProcSample { pid, ppid, rss_bytes: rss, cpu_pct: cpu }
    }

    #[test]
    fn collect_descendants_includes_root_and_whole_subtree() {
        // 1 -> {2,3}; 2 -> {4}; 5 is an unrelated tree.
        let samples = vec![
            s(1, None, 0, 0.0),
            s(2, Some(1), 0, 0.0),
            s(3, Some(1), 0, 0.0),
            s(4, Some(2), 0, 0.0),
            s(5, None, 0, 0.0),
        ];
        let map = children_map(&samples);
        let set = collect_descendants(1, &map);
        assert_eq!(set, HashSet::from([1, 2, 3, 4]));
        assert!(!set.contains(&5));
    }

    #[test]
    fn collect_descendants_single_pid_when_no_children() {
        let samples = vec![s(10, None, 0, 0.0)];
        let map = children_map(&samples);
        assert_eq!(collect_descendants(10, &map), HashSet::from([10]));
    }

    #[test]
    fn sum_group_sums_rss_cpu_and_counts_present_pids() {
        let samples = vec![s(1, None, 100, 1.5), s(2, Some(1), 200, 2.0), s(9, None, 999, 9.0)];
        let by_pid = samples_by_pid(&samples);
        let g = sum_group(&HashSet::from([1, 2, 404]), &by_pid); // 404 absent
        assert_eq!(g.rss_bytes, 300);
        assert!((g.cpu_pct - 3.5).abs() < 1e-6);
        assert_eq!(g.process_count, 2);
    }

    #[test]
    fn proc_group_plus_adds_fields() {
        let a = ProcGroup { rss_bytes: 10, cpu_pct: 1.0, process_count: 1 };
        let b = ProcGroup { rss_bytes: 5, cpu_pct: 2.0, process_count: 3 };
        assert_eq!(a.plus(&b), ProcGroup { rss_bytes: 15, cpu_pct: 3.0, process_count: 4 });
    }

    #[test]
    fn perf_stats_serializes_camel_case() {
        let g = ProcGroup { rss_bytes: 1, cpu_pct: 2.0, process_count: 3 };
        let stats = PerfStats { app: g.clone(), daemon: g.clone(), total: g.clone(), ts: 42 };
        let json = serde_json::to_string(&stats).unwrap();
        assert!(json.contains("\"rssBytes\":1"));
        assert!(json.contains("\"cpuPct\":2.0"));
        assert!(json.contains("\"processCount\":3"));
        assert!(json.contains("\"ts\":42"));
    }
}
```

- [ ] **Step 3: Register the module**

In `src-tauri/src/lib.rs`, add alongside the other `mod` declarations:

```rust
mod perf;
```

- [ ] **Step 4: Run the tests — verify they pass**

Run: `cd src-tauri && cargo test perf::tests`
Expected: 5 tests pass (`collect_descendants_*`, `sum_group_*`, `proc_group_plus_adds_fields`, `perf_stats_serializes_camel_case`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/perf.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(perf): process grouping types + pure functions"
```

---

## Task 2: Live sampler + `get_perf_stats` command

**Files:**
- Modify: `src-tauri/src/perf.rs` (add `PerfState`, `daemon_pid`, `sample_system`, `compute_stats`)
- Modify: `src-tauri/src/commands.rs` (add command)
- Modify: `src-tauri/src/lib.rs` (manage state + register command)

- [ ] **Step 1: Add the sampler + assembly to `perf.rs`**

Append to `src-tauri/src/perf.rs` (above the `#[cfg(test)]` module):

```rust
/// Persistent sysinfo state so CPU% is computed between successive samples.
/// Held in Tauri-managed state.
pub struct PerfState(pub Mutex<System>);

impl PerfState {
    pub fn new() -> Self {
        PerfState(Mutex::new(System::new()))
    }
}

/// Resolve the daemon's pid from the pid file it writes on startup
/// (`$HOME/.octopush/pty-server.pid`). Returns None if unreadable.
pub fn daemon_pid() -> Option<u32> {
    let home = std::env::var("HOME").ok()?;
    let path = std::path::Path::new(&home).join(".octopush").join("pty-server.pid");
    std::fs::read_to_string(path).ok()?.trim().parse::<u32>().ok()
}

/// Refresh `sys` and flatten every process into a `ProcSample`.
///
/// NOTE: the exact `refresh_processes` call is sysinfo-version specific. For
/// sysinfo 0.32 use `sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true)`.
/// If the pinned version differs, match its signature (the compiler will tell
/// you). Everything else here is version-stable.
pub fn sample_system(sys: &mut System) -> Vec<ProcSample> {
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    sys.processes()
        .iter()
        .map(|(pid, p)| ProcSample {
            pid: pid.as_u32(),
            ppid: p.parent().map(|pp| pp.as_u32()),
            rss_bytes: p.memory(), // bytes (sysinfo >= 0.30)
            cpu_pct: p.cpu_usage(),
        })
        .collect()
}

/// Given the flattened samples + the two anchor pids, build the grouped stats.
/// Pure (no sysinfo) so it is unit-testable.
pub fn compute_stats(samples: &[ProcSample], app_pid: u32, daemon_pid: Option<u32>, ts: i64) -> PerfStats {
    let by_pid = samples_by_pid(samples);
    let kids = children_map(samples);

    let app_pids = collect_descendants(app_pid, &kids);
    let app = sum_group(&app_pids, &by_pid);

    let daemon = match daemon_pid {
        Some(p) => sum_group(&HashSet::from([p]), &by_pid),
        None => ProcGroup::zero(),
    };

    let total = app.plus(&daemon);
    PerfStats { app, daemon, total, ts }
}
```

- [ ] **Step 2: Add a test for `compute_stats` (in the `#[cfg(test)]` module of `perf.rs`)**

```rust
    #[test]
    fn compute_stats_groups_app_tree_and_single_daemon() {
        // App tree: 100 (main) -> 101 (helper). Daemon 200 -> 201 (a shell, excluded).
        let samples = vec![
            s(100, None, 50, 1.0),
            s(101, Some(100), 150, 2.0),
            s(200, None, 30, 0.5),
            s(201, Some(200), 9999, 99.0), // daemon's child shell — must be excluded
        ];
        let stats = compute_stats(&samples, 100, Some(200), 7);
        assert_eq!(stats.app, ProcGroup { rss_bytes: 200, cpu_pct: 3.0, process_count: 2 });
        assert_eq!(stats.daemon, ProcGroup { rss_bytes: 30, cpu_pct: 0.5, process_count: 1 });
        assert_eq!(stats.total, ProcGroup { rss_bytes: 230, cpu_pct: 3.5, process_count: 3 });
        assert_eq!(stats.ts, 7);
    }

    #[test]
    fn compute_stats_daemon_absent_is_zero() {
        let samples = vec![s(100, None, 50, 1.0)];
        let stats = compute_stats(&samples, 100, None, 0);
        assert_eq!(stats.daemon, ProcGroup::zero());
        assert_eq!(stats.total, stats.app);
    }
```

- [ ] **Step 3: Run the new tests — verify they pass**

Run: `cd src-tauri && cargo test perf::tests`
Expected: 7 tests pass (the 5 from Task 1 plus the 2 new `compute_stats_*`).

- [ ] **Step 4: Add the Tauri command in `src-tauri/src/commands.rs`**

Add near the other command fns (and ensure `use tauri::State;` is in scope — it already is, used by other commands):

```rust
/// Sample current RAM (RSS) + CPU% for Octopush's process groups.
#[tauri::command]
pub fn get_perf_stats(perf: State<'_, crate::perf::PerfState>) -> crate::perf::PerfStats {
    let mut sys = perf.0.lock();
    let samples = crate::perf::sample_system(&mut sys);
    let app_pid = std::process::id();
    let daemon_pid = crate::perf::daemon_pid();
    let ts = chrono::Utc::now().timestamp();
    crate::perf::compute_stats(&samples, app_pid, daemon_pid, ts)
}
```

- [ ] **Step 5: Manage state + register the command in `src-tauri/src/lib.rs`**

In the Tauri builder chain, add the managed state alongside the other `.manage(...)` calls:

```rust
.manage(perf::PerfState::new())
```

And add the command to the `tauri::generate_handler![...]` list (alongside `commands::spawn_or_attach_terminal`):

```rust
commands::get_perf_stats,
```

- [ ] **Step 6: Build to verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: compiles. If `refresh_processes` errors, adjust the call to match the pinned sysinfo version's signature (see the NOTE in `sample_system`), then rebuild.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/perf.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(perf): get_perf_stats command + live sysinfo sampler"
```

---

## Task 3: Frontend types, IPC, and byte formatter

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/ipc.ts`
- Create: `src/lib/formatBytes.ts`
- Test: `src/lib/formatBytes.test.ts`

- [ ] **Step 1: Add types to `src/lib/types.ts`**

```ts
export interface ProcGroup {
  rssBytes: number;
  cpuPct: number;
  processCount: number;
}

export interface PerfStats {
  app: ProcGroup;
  daemon: ProcGroup;
  total: ProcGroup;
  ts: number;
}
```

- [ ] **Step 2: Add the IPC call in `src/lib/ipc.ts`**

Add a `PerfStats` import to the existing `import type { ... } from "./types"` and add to the `ipc` object:

```ts
  getPerfStats: () => invoke<PerfStats>("get_perf_stats"),
```

- [ ] **Step 3: Write the failing test `src/lib/formatBytes.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { formatBytes } from "./formatBytes";

describe("formatBytes", () => {
  it("formats bytes, KB, MB, GB at boundaries", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(412 * 1024 * 1024)).toBe("412 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run src/lib/formatBytes.test.ts`
Expected: FAIL — cannot find module `./formatBytes`.

- [ ] **Step 5: Implement `src/lib/formatBytes.ts`**

```ts
/** Human-readable byte size: ≥10 of a unit shows whole numbers, otherwise 1 decimal. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const num = v < 10 ? v.toFixed(1) : String(Math.round(v));
  return `${num} ${units[i]}`;
}
```

- [ ] **Step 6: Run it to verify it passes**

Run: `npx vitest run src/lib/formatBytes.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/lib/types.ts src/lib/ipc.ts src/lib/formatBytes.ts src/lib/formatBytes.test.ts
git commit -m "feat(perf): frontend types, ipc.getPerfStats, formatBytes"
```

---

## Task 4: `perfStore` polling store

**Files:**
- Create: `src/stores/perfStore.ts`
- Test: `src/stores/perfStore.test.ts`

- [ ] **Step 1: Write the failing test `src/stores/perfStore.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PerfStats } from "../lib/types";

const mockIpc = {
  getPerfStats: vi.fn<() => Promise<PerfStats>>(),
};
vi.mock("../lib/ipc", () => ({ ipc: mockIpc }));

const { usePerfStore } = await import("./perfStore");

const SAMPLE: PerfStats = {
  app: { rssBytes: 100, cpuPct: 1, processCount: 2 },
  daemon: { rssBytes: 50, cpuPct: 0.5, processCount: 1 },
  total: { rssBytes: 150, cpuPct: 1.5, processCount: 3 },
  ts: 1,
};

beforeEach(() => {
  vi.useFakeTimers();
  usePerfStore.getState().stop();
  usePerfStore.setState({ stats: null });
  mockIpc.getPerfStats.mockReset();
  mockIpc.getPerfStats.mockResolvedValue(SAMPLE);
  // jsdom: default document.hidden is false
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});
afterEach(() => {
  usePerfStore.getState().stop();
  vi.useRealTimers();
});

describe("perfStore", () => {
  it("polls immediately on start and sets stats", async () => {
    usePerfStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockIpc.getPerfStats).toHaveBeenCalledTimes(1);
    expect(usePerfStore.getState().stats).toEqual(SAMPLE);
  });

  it("polls again after the interval", async () => {
    usePerfStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockIpc.getPerfStats).toHaveBeenCalledTimes(2);
  });

  it("skips the IPC call when the document is hidden", async () => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    usePerfStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockIpc.getPerfStats).not.toHaveBeenCalled();
  });

  it("stop() halts polling", async () => {
    usePerfStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    usePerfStore.getState().stop();
    await vi.advanceTimersByTimeAsync(4000);
    expect(mockIpc.getPerfStats).toHaveBeenCalledTimes(1);
  });

  it("start() is idempotent (no duplicate intervals)", async () => {
    usePerfStore.getState().start();
    usePerfStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    // 1 immediate + 1 interval tick = 2, not 4
    expect(mockIpc.getPerfStats).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/stores/perfStore.test.ts`
Expected: FAIL — cannot find module `./perfStore`.

- [ ] **Step 3: Implement `src/stores/perfStore.ts`**

```ts
import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { PerfStats } from "../lib/types";

interface PerfState {
  stats: PerfStats | null;
  start: () => void;
  stop: () => void;
}

const POLL_MS = 2000;
// Module-level timer so it survives component re-renders and start() is idempotent.
let timer: ReturnType<typeof setInterval> | null = null;

export const usePerfStore = create<PerfState>((set) => {
  const tick = async () => {
    // Don't burn cycles sampling when nobody's looking.
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const stats = await ipc.getPerfStats();
      set({ stats });
    } catch {
      // Transient (daemon restart, etc.) — keep the last good reading.
    }
  };

  return {
    stats: null,
    start: () => {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), POLL_MS);
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
});
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/stores/perfStore.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stores/perfStore.ts src/stores/perfStore.test.ts
git commit -m "feat(perf): perfStore polling (2s, paused when hidden)"
```

---

## Task 5: `PerfMonitorBar` component

**Files:**
- Create: `src/components/PerfMonitorBar.tsx`
- Test: `src/components/PerfMonitorBar.test.tsx`

- [ ] **Step 1: Write the failing test `src/components/PerfMonitorBar.test.tsx`**

```tsx
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PerfMonitorBar } from "./PerfMonitorBar";
import { usePerfStore } from "../stores/perfStore";

beforeEach(() => {
  usePerfStore.setState({ stats: null });
});

describe("PerfMonitorBar", () => {
  it("shows a measuring state before any sample", () => {
    render(<PerfMonitorBar />);
    expect(screen.getByText(/measuring/i)).toBeInTheDocument();
  });

  it("shows the total RAM + CPU once stats arrive", () => {
    usePerfStore.setState({
      stats: {
        app: { rssBytes: 318 * 1024 * 1024, cpuPct: 4, processCount: 5 },
        daemon: { rssBytes: 94 * 1024 * 1024, cpuPct: 2, processCount: 1 },
        total: { rssBytes: 412 * 1024 * 1024, cpuPct: 6, processCount: 6 },
        ts: 1,
      },
    });
    render(<PerfMonitorBar />);
    expect(screen.getByText("412 MB")).toBeInTheDocument();
    expect(screen.getByText("6%")).toBeInTheDocument();
  });

  it("toggles the per-group popover on click", () => {
    usePerfStore.setState({
      stats: {
        app: { rssBytes: 318 * 1024 * 1024, cpuPct: 4, processCount: 5 },
        daemon: { rssBytes: 94 * 1024 * 1024, cpuPct: 2, processCount: 1 },
        total: { rssBytes: 412 * 1024 * 1024, cpuPct: 6, processCount: 6 },
        ts: 1,
      },
    });
    render(<PerfMonitorBar />);
    expect(screen.queryByText("App")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /performance/i }));
    expect(screen.getByText("App")).toBeInTheDocument();
    expect(screen.getByText("Daemon")).toBeInTheDocument();
    expect(screen.getByText("318 MB")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/PerfMonitorBar.test.tsx`
Expected: FAIL — cannot find module `./PerfMonitorBar`.

- [ ] **Step 3: Implement `src/components/PerfMonitorBar.tsx`**

```tsx
import { useState } from "react";
import { usePerfStore } from "../stores/perfStore";
import { formatBytes } from "../lib/formatBytes";
import type { ProcGroup } from "../lib/types";

function PerfRow({ label, g }: { label: string; g: ProcGroup }) {
  return (
    <div className="flex items-center gap-3 whitespace-nowrap px-1 py-0.5">
      <span className="w-16 text-octo-sage">{label}</span>
      <span className="w-16 text-right text-octo-ivory">{formatBytes(g.rssBytes)}</span>
      <span className="w-10 text-right text-octo-ivory">{Math.round(g.cpuPct)}%</span>
      <span className="w-16 text-right text-octo-mute">{g.processCount} proc</span>
    </div>
  );
}

export function PerfMonitorBar() {
  const stats = usePerfStore((s) => s.stats);
  const [open, setOpen] = useState(false);

  return (
    <div className="relative flex h-[22px] w-full flex-shrink-0 items-center border-t border-octo-hairline bg-octo-panel px-3 font-mono text-[11px] text-octo-mute">
      {!stats ? (
        <span className="flex items-center gap-2">
          <span className="text-octo-brass">⌗</span>
          <span>measuring…</span>
        </span>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label="Performance details"
            aria-expanded={open}
            className="flex items-center gap-2 hover:text-octo-sage"
          >
            <span className="text-octo-brass">⌗</span>
            <span className="text-octo-brass">{formatBytes(stats.total.rssBytes)}</span>
            <span>·</span>
            <span>
              CPU <span className="text-octo-brass">{Math.round(stats.total.cpuPct)}%</span>
            </span>
            <span className="text-octo-mute">{open ? "▾" : "▸"}</span>
          </button>
          {open && (
            <div className="absolute bottom-[26px] left-2 z-50 rounded-md border border-octo-hairline bg-octo-panel-2 p-2 shadow-lg">
              <PerfRow label="App" g={stats.app} />
              <PerfRow label="Daemon" g={stats.daemon} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/components/PerfMonitorBar.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean. (If `bg-octo-panel-2` is not a defined token, use `bg-octo-panel` — verify against `src/styles.css`.)

```bash
git add src/components/PerfMonitorBar.tsx src/components/PerfMonitorBar.test.tsx
git commit -m "feat(perf): PerfMonitorBar status strip + per-group popover"
```

---

## Task 6: Wire the bar into the app shell + start/stop polling

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Import the bar and store at the top of `src/App.tsx`**

```tsx
import { PerfMonitorBar } from "./components/PerfMonitorBar";
import { usePerfStore } from "./stores/perfStore";
```

- [ ] **Step 2: Start/stop the poll once, near the other startup effects**

Add this effect in the `App` component body (e.g. just after the startup project-restore effect):

```tsx
  // Performance monitor polling — runs for the whole app lifetime.
  useEffect(() => {
    usePerfStore.getState().start();
    return () => usePerfStore.getState().stop();
  }, []);
```

- [ ] **Step 3: Wrap the workspace shell in a column and mount the bar at the bottom**

Find the workspace-shell return (the top-level element `<div className="flex h-screen w-screen bg-octo-bg text-octo-ivory">` that contains `<WorkspaceRail .../>` and `<main ...>`). Replace its wrapper so the rail+main row is flex-1 and the bar sits beneath, full width:

```tsx
return (
  <div className="flex h-screen w-screen flex-col bg-octo-bg text-octo-ivory">
    <div className="flex min-h-0 flex-1">
      <WorkspaceRail
        /* ...unchanged props... */
      />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* ...unchanged main contents... */}
      </main>
    </div>
    <PerfMonitorBar />
    {/* ...unchanged overlays/modals that were siblings of main stay here... */}
  </div>
);
```

Keep all existing children (overlays, context menus, ToastContainer, UpdateNotifier, modals) exactly as they were — only the outer wrapper changes from `flex` to `flex flex-col`, the existing rail+main get wrapped in the `flex min-h-0 flex-1` row, and `<PerfMonitorBar/>` is added after that row. Overlays that use `absolute inset-0` continue to cover the whole window; that's fine.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Full frontend test run (no regressions)**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "feat(perf): mount PerfMonitorBar at the app bottom + drive polling"
```

---

## Task 7: Sanction the status bar in the design system docs

**Files:**
- Modify: `docs/design-system.md`

- [ ] **Step 1: Add a status-bar section to `docs/design-system.md`**

Add the following under the layout/signature-patterns area:

```markdown
### Status bar (bottom)

A single full-width strip at the very bottom of the window (~22px), beneath
both the rail and the main column. It is the one sanctioned piece of bottom
chrome. Rules:

- `bg-octo-panel`, top `border-octo-hairline`, JetBrains Mono `text-[11px]`.
- Labels in `text-octo-mute`/`text-octo-sage`; live values in `text-octo-brass`.
- Calm: no motion, no spring. It informs, it doesn't perform.
- Current resident: the performance monitor (RAM + CPU). Future bottom-bar
  content must keep this quiet, single-line character.
```

- [ ] **Step 2: Commit**

```bash
git add docs/design-system.md
git commit -m "docs: sanction the bottom status-bar surface in the design system"
```

---

## Verification (after all tasks)

- [ ] `npm run typecheck` — clean
- [ ] `npx vitest run` — all pass (formatBytes, perfStore, PerfMonitorBar + existing)
- [ ] `cd src-tauri && cargo test` — all pass (perf::tests + existing)
- [ ] `npm run tauri:build` — builds; launch the `.app` and confirm: bottom bar shows RAM + CPU, updates ~every 2s, click expands App/Daemon breakdown, and the numbers are in the same ballpark as Activity Monitor for the Octopush + octopush-pty-server processes.
