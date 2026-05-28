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

/// Persistent sysinfo state so CPU% is computed between successive samples.
/// Held in Tauri-managed state.
pub struct PerfState(pub Mutex<System>);

impl PerfState {
    pub fn new() -> Self {
        PerfState(Mutex::new(System::new()))
    }
}

impl Default for PerfState {
    fn default() -> Self {
        Self::new()
    }
}

/// Resolve the daemon's pid from the pid file it writes on startup
/// (`$HOME/.octopush/pty-server.pid`). Returns None if unreadable.
pub fn daemon_pid() -> Option<u32> {
    let path = dirs::home_dir()?.join(".octopush").join("pty-server.pid");
    std::fs::read_to_string(path).ok()?.trim().parse::<u32>().ok()
}

// macOS "responsibility" API: returns the pid responsible for `pid` — i.e. the
// app that owns a helper/XPC process (e.g. WebKit content/GPU/networking
// processes are "responsible to" their host app). This is how Activity Monitor
// groups helper processes under an app. The symbol is in libSystem.
#[cfg(target_os = "macos")]
extern "C" {
    fn responsibility_get_pid_responsible_for_pid(pid: i32) -> i32;
}

/// The pid macOS considers "responsible" for `pid`. Falls back to `pid` itself
/// (a process is responsible for itself) when the call fails or off macOS.
pub fn responsible_pid(pid: u32) -> u32 {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: the call takes a pid and returns a pid; shares no memory.
        let r = unsafe { responsibility_get_pid_responsible_for_pid(pid as i32) };
        if r > 0 {
            r as u32
        } else {
            pid
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        pid
    }
}

/// Build `pid -> responsible_pid` for all samples (impure: calls the OS per pid).
pub fn responsible_map(samples: &[ProcSample]) -> HashMap<u32, u32> {
    samples.iter().map(|s| (s.pid, responsible_pid(s.pid))).collect()
}

/// The set of pids belonging to the "App" group: every process whose responsible
/// pid is `app_pid`, EXCLUDING the daemon and its subtree (the daemon is its own
/// group and its shell children are user workloads, not app overhead).
///
/// `responsible_by_pid` maps each pid to its responsible pid (see `responsible_map`).
pub fn compute_app_pids(
    samples: &[ProcSample],
    app_pid: u32,
    daemon_pid: Option<u32>,
    responsible_by_pid: &HashMap<u32, u32>,
) -> HashSet<u32> {
    let daemon_subtree = match daemon_pid {
        Some(d) => collect_descendants(d, &children_map(samples)),
        None => HashSet::new(),
    };
    samples
        .iter()
        .map(|s| s.pid)
        .filter(|p| responsible_by_pid.get(p).copied().unwrap_or(*p) == app_pid)
        .filter(|p| !daemon_subtree.contains(p))
        .collect()
}

/// Refresh `sys` and flatten every process into a `ProcSample`.
///
/// NOTE: the exact `refresh_processes` call is sysinfo-version specific. For
/// sysinfo 0.32 use `sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true)`.
/// If the pinned version differs, match its signature (the compiler will tell
/// you). Everything else here is version-stable.
///
/// The first call after `System::new()` returns 0% CPU for all processes;
/// the frontend corrects itself on the next poll.
pub fn sample_system(sys: &mut System) -> Vec<ProcSample> {
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    sys.processes()
        .iter()
        .map(|(pid, p)| ProcSample {
            pid: pid.as_u32(),
            ppid: p.parent().map(|pp| pp.as_u32()),
            rss_bytes: p.memory(),
            cpu_pct: p.cpu_usage(),
        })
        .collect()
}

/// Build the grouped stats from samples + the precomputed App pid set + the
/// daemon pid. Pure (no OS calls) so it is unit-testable.
pub fn compute_stats(
    samples: &[ProcSample],
    app_pids: &HashSet<u32>,
    daemon_pid: Option<u32>,
    ts: i64,
) -> PerfStats {
    let by_pid = samples_by_pid(samples);
    let app = sum_group(app_pids, &by_pid);
    let daemon = match daemon_pid {
        Some(p) => sum_group(&HashSet::from([p]), &by_pid),
        None => ProcGroup::zero(),
    };
    let total = app.plus(&daemon);
    PerfStats { app, daemon, total, ts }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(pid: u32, ppid: Option<u32>, rss: u64, cpu: f32) -> ProcSample {
        ProcSample { pid, ppid, rss_bytes: rss, cpu_pct: cpu }
    }

    #[test]
    fn collect_descendants_includes_root_and_whole_subtree() {
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
        let g = sum_group(&HashSet::from([1, 2, 404]), &by_pid);
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

    #[test]
    fn compute_app_pids_includes_responsible_helpers_excludes_daemon_tree() {
        // 100 = main app. 300 = a WebKit helper reparented to launchd (ppid 1)
        // but RESPONSIBLE to the app. 200 = daemon (child of app, also
        // responsible to app). 201 = a shell spawned by the daemon. 900 =
        // an unrelated app's process.
        let samples = vec![
            s(100, None, 50, 1.0),
            s(300, Some(1), 150, 2.0),   // WebKit helper, reparented
            s(200, Some(100), 30, 0.5),  // daemon
            s(201, Some(200), 9999, 99.0), // daemon's shell child
            s(900, None, 1234, 5.0),     // someone else's process
        ];
        let mut resp = HashMap::new();
        resp.insert(100, 100); // app responsible for itself
        resp.insert(300, 100); // helper responsible to app  -> INCLUDED
        resp.insert(200, 100); // daemon responsible to app  -> excluded (daemon subtree)
        resp.insert(201, 200); // shell responsible to daemon -> excluded
        resp.insert(900, 900); // unrelated -> excluded
        let app = compute_app_pids(&samples, 100, Some(200), &resp);
        assert_eq!(app, HashSet::from([100, 300]));
    }

    #[test]
    fn compute_app_pids_no_daemon_keeps_all_responsible() {
        let samples = vec![s(100, None, 10, 0.0), s(300, Some(1), 20, 0.0)];
        let resp = HashMap::from([(100u32, 100u32), (300u32, 100u32)]);
        let app = compute_app_pids(&samples, 100, None, &resp);
        assert_eq!(app, HashSet::from([100, 300]));
    }

    #[test]
    fn compute_stats_sums_groups_with_precomputed_app_set() {
        // App = {100, 300}; daemon = 200 (single, excludes its shell 201).
        let samples = vec![
            s(100, None, 50, 1.0),
            s(300, Some(1), 150, 2.0),
            s(200, Some(100), 30, 0.5),
            s(201, Some(200), 9999, 99.0),
        ];
        let app_pids = HashSet::from([100u32, 300u32]);
        let stats = compute_stats(&samples, &app_pids, Some(200), 7);
        assert_eq!(stats.app, ProcGroup { rss_bytes: 200, cpu_pct: 3.0, process_count: 2 });
        assert_eq!(stats.daemon, ProcGroup { rss_bytes: 30, cpu_pct: 0.5, process_count: 1 });
        assert_eq!(stats.total, ProcGroup { rss_bytes: 230, cpu_pct: 3.5, process_count: 3 });
        assert_eq!(stats.ts, 7);
    }

    #[test]
    fn compute_stats_daemon_absent_is_zero() {
        let samples = vec![s(100, None, 50, 1.0)];
        let stats = compute_stats(&samples, &HashSet::from([100u32]), None, 0);
        assert_eq!(stats.daemon, ProcGroup::zero());
        assert_eq!(stats.total, stats.app);
    }
}
