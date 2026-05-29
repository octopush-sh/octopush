//! Process performance sampling for the in-app monitor.
//!
//! Two groups are reported: `app` (the Octopush main process plus the helper
//! processes macOS considers it "responsible" for — e.g. the WebKit content/GPU/
//! networking XPC processes, which are reparented to launchd but attributed back
//! to the app) and `daemon` (the `octopush-pty-server` process only — its shell
//! children are user workloads, not Octopush overhead), plus a total.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use sysinfo::System;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub free_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CacheEntry {
    pub name: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCacheSizes {
    pub entries: Vec<CacheEntry>,
    pub total_bytes: u64,
}

/// Common build/cache directory names scanned at a workspace root.
pub const CACHE_DIR_NAMES: &[&str] = &[
    "target", "node_modules", "dist", "build", ".next", ".nuxt",
    ".gradle", "__pycache__", ".venv", "venv", ".turbo", "out",
];

/// Recursively sum the byte sizes of regular files under `path`. Skips
/// symlinks; ignores per-entry errors (permission, races). Never panics.
pub fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            total = total.saturating_add(dir_size(&entry.path()));
        } else if let Ok(md) = entry.metadata() {
            total = total.saturating_add(md.len());
        }
    }
    total
}

/// For each known cache dir name present (as a directory) directly under
/// `workspace_root`, return (name, size). Absent names are omitted.
pub fn scan_caches(workspace_root: &Path) -> Vec<(String, u64)> {
    let mut out = Vec::new();
    for name in CACHE_DIR_NAMES {
        let p = workspace_root.join(name);
        if p.is_dir() {
            out.push((name.to_string(), dir_size(&p)));
        }
    }
    out
}

/// Given `(mount_point, total, free)` tuples, pick the disk whose mount point
/// is the longest prefix of `target`; fall back to the `/` mount, else the
/// first, else zeros. Pure — unit-testable without sysinfo.
pub fn pick_disk_for_path(mounts: &[(PathBuf, u64, u64)], target: &Path) -> DiskInfo {
    let best = mounts
        .iter()
        .filter(|(mp, _, _)| target.starts_with(mp))
        .max_by_key(|(mp, _, _)| mp.as_os_str().len())
        .or_else(|| mounts.iter().find(|(mp, _, _)| mp == Path::new("/")))
        .or_else(|| mounts.first());
    match best {
        Some((_, total, free)) => DiskInfo { free_bytes: *free, total_bytes: *total },
        None => DiskInfo { free_bytes: 0, total_bytes: 0 },
    }
}

/// Read the free/total bytes of the volume that `$HOME` lives on.
pub fn home_disk() -> DiskInfo {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let mounts: Vec<(PathBuf, u64, u64)> = disks
        .list()
        .iter()
        .map(|d| (d.mount_point().to_path_buf(), d.total_space(), d.available_space()))
        .collect();
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    pick_disk_for_path(&mounts, &home)
}

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
    pub disk: DiskInfo,
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
    disk: DiskInfo,
    ts: i64,
) -> PerfStats {
    let by_pid = samples_by_pid(samples);
    let app = sum_group(app_pids, &by_pid);
    let daemon = match daemon_pid {
        Some(p) => sum_group(&HashSet::from([p]), &by_pid),
        None => ProcGroup::zero(),
    };
    let total = app.plus(&daemon);
    PerfStats { app, daemon, total, disk, ts }
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
        let disk = DiskInfo { free_bytes: 10, total_bytes: 100 };
        let stats = PerfStats { app: g.clone(), daemon: g.clone(), total: g.clone(), disk, ts: 42 };
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
        let disk = DiskInfo { free_bytes: 100, total_bytes: 500 };
        let stats = compute_stats(&samples, &app_pids, Some(200), disk.clone(), 7);
        assert_eq!(stats.app, ProcGroup { rss_bytes: 200, cpu_pct: 3.0, process_count: 2 });
        assert_eq!(stats.daemon, ProcGroup { rss_bytes: 30, cpu_pct: 0.5, process_count: 1 });
        assert_eq!(stats.total, ProcGroup { rss_bytes: 230, cpu_pct: 3.5, process_count: 3 });
        assert_eq!(stats.disk, disk);
        assert_eq!(stats.ts, 7);
    }

    #[test]
    fn compute_stats_daemon_absent_is_zero() {
        let samples = vec![s(100, None, 50, 1.0)];
        let stats = compute_stats(&samples, &HashSet::from([100u32]), None, DiskInfo { free_bytes: 0, total_bytes: 0 }, 0);
        assert_eq!(stats.daemon, ProcGroup::zero());
        assert_eq!(stats.total, stats.app);
    }

    #[test]
    fn dir_size_sums_files_recursively() {
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::write(tmp.path().join("a.txt"), vec![0u8; 100]).unwrap();
        let sub = tmp.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("b.txt"), vec![0u8; 50]).unwrap();
        assert_eq!(dir_size(tmp.path()), 150);
    }

    #[test]
    fn scan_caches_returns_only_present_known_dirs() {
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::create_dir(tmp.path().join("target")).unwrap();
        std::fs::write(tmp.path().join("target").join("x"), vec![0u8; 10]).unwrap();
        std::fs::create_dir(tmp.path().join("node_modules")).unwrap();
        std::fs::write(tmp.path().join("node_modules").join("y"), vec![0u8; 20]).unwrap();
        std::fs::create_dir(tmp.path().join("src")).unwrap(); // not a cache name
        let mut got = scan_caches(tmp.path());
        got.sort();
        assert_eq!(got, vec![("node_modules".to_string(), 20), ("target".to_string(), 10)]);
    }

    #[test]
    fn pick_disk_chooses_longest_prefix_mount() {
        let mounts = vec![
            (PathBuf::from("/"), 1000u64, 100u64),
            (PathBuf::from("/Users"), 2000u64, 200u64),
        ];
        let d = pick_disk_for_path(&mounts, Path::new("/Users/jonathan"));
        assert_eq!(d, DiskInfo { free_bytes: 200, total_bytes: 2000 });
        let root = pick_disk_for_path(&mounts, Path::new("/opt/x"));
        assert_eq!(root, DiskInfo { free_bytes: 100, total_bytes: 1000 });
    }
}
