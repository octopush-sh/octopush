//! Process performance sampling for the in-app monitor.
//!
//! Two groups are reported: `app` (the Octopush main process plus its WebKit
//! helper descendants) and `daemon` (the `octopush-pty-server` process only —
//! its shell children are user workloads, not Octopush overhead), plus a total.

use serde::Serialize;
use std::collections::{HashMap, HashSet};

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
}
