//! Collision radar (#732): warn when two in-flight workspaces of one project
//! change the same files, before the merge does.
//!
//! Per live workspace the engine collects the paths it changes:
//! - **committed**: the tree diff from `merge_base(base, HEAD)` to `HEAD`
//!   (`git diff --name-only <merge-base>`), renames counted on both sides;
//! - **uncommitted**: HEAD → index + working tree, untracked files included,
//!   because crews leave work uncommitted by design.
//!
//! Pairwise, the overlap is the intersection of the two sets. When both sides
//! changed an overlapping file in *committed* work, an in-memory
//! `merge_trees(ancestor, a, b)` confirms whether the merge would actually
//! conflict. Overlaps made only of lockfiles fall into their own quiet bucket.
//!
//! **Read-only by construction.** Nothing touches a worktree, an index or a
//! ref: diffs only read, and the merge runs against an in-memory index with a
//! mempack object backend in front of the object database, so even the blobs
//! libgit2 writes while auto-merging stay in memory and are dropped.
//!
//! **Cheap.** The committed set is cached per worktree, keyed by
//! `(HEAD, merge-base)`; merge confirmations are cached per `(head a, head b)`;
//! and a whole project's report is reused for [`REPORT_TTL`] so a burst of
//! callers (rail, Mission Control, Review) costs one scan. Past
//! [`MAX_CONFIRMED_PAIRS`] overlapping pairs, the scan degrades to file
//! overlap only.

use git2::{DiffFindOptions, DiffOptions, MergeOptions, Oid, Repository};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How long a project's report is reused before a scan runs again.
pub const REPORT_TTL: Duration = Duration::from_secs(5);
/// At most this many overlapping pairs get a merge-tree confirmation per scan.
pub const MAX_CONFIRMED_PAIRS: usize = 32;
/// Bound on the merge-confirmation cache; it is cleared when it grows past this.
const MAX_MERGE_CACHE: usize = 512;
/// Bound on the committed-set cache (one entry per worktree path).
const MAX_COMMITTED_CACHE: usize = 256;

/// One live workspace to scan.
#[derive(Clone, Debug)]
pub struct ScanInput {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    /// The branch this workspace was created from. `None` falls back to the
    /// project's default branch, resolved by the caller.
    pub base: Option<String>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// Only lockfiles overlap: noisy by nature, regenerated on merge.
    Lockfile,
    /// The same file changes on both sides; the merge may still be clean.
    Overlap,
    /// `merge_trees` confirmed the two branches conflict.
    Conflict,
}

/// Two workspaces changing the same files.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Collision {
    pub a: String,
    pub a_name: String,
    pub b: String,
    pub b_name: String,
    /// Every overlapping path, sorted.
    pub files: Vec<String>,
    /// The overlapping paths `merge_trees` reports as conflicting, sorted.
    pub conflicting_files: Vec<String>,
    pub severity: Severity,
    /// Whether a merge-tree check ran for this pair (both sides had committed
    /// work on an overlapping file and the pair cap wasn't reached).
    pub confirmed: bool,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCollisions {
    pub collisions: Vec<Collision>,
    /// Workspaces that could be scanned.
    pub scanned: usize,
    /// True when the pair cap was hit and some pairs are file overlap only.
    pub capped: bool,
}

/// The paths one workspace changes.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChangedSet {
    pub head: Option<Oid>,
    pub committed: BTreeSet<String>,
    pub uncommitted: BTreeSet<String>,
}

impl ChangedSet {
    pub fn all(&self) -> BTreeSet<String> {
        self.committed.union(&self.uncommitted).cloned().collect()
    }
}

/// Work counters, so tests can prove the caches hold.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ScanStats {
    pub scans: usize,
    pub committed_diffs: usize,
    pub merges: usize,
}

#[derive(Default)]
pub struct CollisionCache {
    committed: HashMap<PathBuf, (Oid, Oid, BTreeSet<String>)>,
    merges: HashMap<(Oid, Oid), Vec<String>>,
    reports: HashMap<String, (Instant, String, ProjectCollisions)>,
    pub stats: ScanStats,
}

/// Lockfiles: a collision made only of these is low severity.
pub fn is_lockfile(path: &str) -> bool {
    const NAMES: &[&str] = &[
        "package-lock.json",
        "npm-shrinkwrap.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "bun.lockb",
        "bun.lock",
        "Cargo.lock",
        "Gemfile.lock",
        "poetry.lock",
        "Pipfile.lock",
        "uv.lock",
        "composer.lock",
        "go.sum",
        "flake.lock",
        "Podfile.lock",
        "mix.lock",
        "pubspec.lock",
        "gradle.lockfile",
    ];
    let name = path.rsplit('/').next().unwrap_or(path);
    NAMES.contains(&name)
}

fn delta_paths(diff: &git2::Diff<'_>, out: &mut BTreeSet<String>) {
    for delta in diff.deltas() {
        for file in [delta.old_file(), delta.new_file()] {
            if let Some(p) = file.path().and_then(|p| p.to_str()) {
                out.insert(p.to_string());
            }
        }
    }
}

fn find_renames(diff: &mut git2::Diff<'_>, untracked: bool) {
    let mut find = DiffFindOptions::new();
    find.renames(true).for_untracked(untracked);
    // Rename detection is a nicety: both paths land in the set either way.
    let _ = diff.find_similar(Some(&mut find));
}

/// The merge base to diff from: the newest of `merge_base(HEAD, origin/base)`
/// and `merge_base(HEAD, base)`, so a stale local base (or a stale remote)
/// never pulls the base's own commits into the changed set.
fn resolve_merge_base(repo: &Repository, head: Oid, base: &str) -> Option<Oid> {
    let mut bases: Vec<Oid> = Vec::new();
    for name in [format!("origin/{base}"), base.to_string()] {
        let Ok(obj) = repo.revparse_single(&name) else { continue };
        let Ok(commit) = obj.peel_to_commit() else { continue };
        if let Ok(mb) = repo.merge_base(head, commit.id()) {
            if !bases.contains(&mb) {
                bases.push(mb);
            }
        }
    }
    bases.iter().copied().find(|&mb| {
        bases
            .iter()
            .all(|&other| other == mb || repo.graph_descendant_of(mb, other).unwrap_or(false))
    })
    .or_else(|| bases.first().copied())
}

/// Paths changed between HEAD and the index + working tree (untracked included).
pub fn uncommitted_paths(repo: &Repository) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut opts = DiffOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    if let Ok(mut diff) = repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts)) {
        find_renames(&mut diff, true);
        delta_paths(&diff, &mut out);
    }
    out
}

impl CollisionCache {
    /// Every path the workspace changes. The committed half comes from the
    /// cache when HEAD and the merge base are unchanged.
    pub fn changed_set(&mut self, path: &Path, base: Option<&str>) -> Option<ChangedSet> {
        let repo = Repository::open(path).ok()?;
        let uncommitted = uncommitted_paths(&repo);
        let head = repo.head().ok().and_then(|h| h.peel_to_commit().ok()).map(|c| c.id());
        let mut committed = BTreeSet::new();
        if let (Some(head), Some(base)) = (head, base) {
            if let Some(mb) = resolve_merge_base(&repo, head, base) {
                let key = path.to_path_buf();
                match self.committed.get(&key) {
                    Some((h, m, set)) if *h == head && *m == mb => committed = set.clone(),
                    _ => {
                        self.stats.committed_diffs += 1;
                        if mb != head {
                            let from = repo.find_commit(mb).and_then(|c| c.tree()).ok();
                            let to = repo.find_commit(head).and_then(|c| c.tree()).ok();
                            if let Ok(mut diff) =
                                repo.diff_tree_to_tree(from.as_ref(), to.as_ref(), None)
                            {
                                find_renames(&mut diff, false);
                                delta_paths(&diff, &mut committed);
                            }
                        }
                        if self.committed.len() >= MAX_COMMITTED_CACHE {
                            self.committed.clear();
                        }
                        self.committed.insert(key, (head, mb, committed.clone()));
                    }
                }
            }
        }
        Some(ChangedSet { head, committed, uncommitted })
    }

    /// Paths `merge_trees(merge_base(a, b), a, b)` reports as conflicting.
    /// Runs against an in-memory index with a mempack in front of the object
    /// database: nothing is written to disk.
    fn merge_conflicts(&mut self, repo_path: &Path, a: Oid, b: Oid) -> Option<Vec<String>> {
        let key = if a <= b { (a, b) } else { (b, a) };
        if let Some(hit) = self.merges.get(&key) {
            return Some(hit.clone());
        }
        let repo = Repository::open(repo_path).ok()?;
        let odb = repo.odb().ok()?;
        // Highest priority, so every object write lands in memory.
        let _mempack = odb.add_new_mempack_backend(1000).ok()?;
        let ancestor = repo.merge_base(a, b).ok()?;
        let tree = |oid: Oid| repo.find_commit(oid).and_then(|c| c.tree()).ok();
        let (anc, ours, theirs) = (tree(ancestor)?, tree(a)?, tree(b)?);
        let mut opts = MergeOptions::new();
        opts.find_renames(true);
        self.stats.merges += 1;
        let index = repo.merge_trees(&anc, &ours, &theirs, Some(&opts)).ok()?;
        let mut files = BTreeSet::new();
        if index.has_conflicts() {
            if let Ok(conflicts) = index.conflicts() {
                for c in conflicts.flatten() {
                    for entry in [c.ancestor, c.our, c.their].into_iter().flatten() {
                        if let Ok(p) = String::from_utf8(entry.path) {
                            files.insert(p);
                        }
                    }
                }
            }
        }
        let files: Vec<String> = files.into_iter().collect();
        if self.merges.len() >= MAX_MERGE_CACHE {
            self.merges.clear();
        }
        self.merges.insert(key, files.clone());
        Some(files)
    }

    /// Scan a project now, ignoring the report TTL.
    pub fn scan(&mut self, inputs: &[ScanInput]) -> ProjectCollisions {
        self.stats.scans += 1;
        // A single live workspace can't collide with anything.
        if inputs.len() < 2 {
            return ProjectCollisions { scanned: inputs.len(), ..Default::default() };
        }
        let mut sets: Vec<(&ScanInput, ChangedSet)> = Vec::new();
        let mut seen_paths: BTreeSet<PathBuf> = BTreeSet::new();
        for input in inputs {
            let canon = std::fs::canonicalize(&input.path).unwrap_or_else(|_| input.path.clone());
            if !seen_paths.insert(canon) {
                continue; // two rows on one checkout are one workspace
            }
            if let Some(set) = self.changed_set(&input.path, input.base.as_deref()) {
                sets.push((input, set));
            }
        }
        let scanned = sets.len();
        let mut collisions = Vec::new();
        let mut confirmed_pairs = 0usize;
        let mut capped = false;
        for i in 0..sets.len() {
            for j in (i + 1)..sets.len() {
                let (ia, sa) = &sets[i];
                let (ib, sb) = &sets[j];
                let files: Vec<String> = sa.all().intersection(&sb.all()).cloned().collect();
                if files.is_empty() {
                    continue;
                }
                let committed_overlap =
                    files.iter().any(|f| sa.committed.contains(f) && sb.committed.contains(f));
                let mut conflicting_files = Vec::new();
                let mut confirmed = false;
                if committed_overlap {
                    if let (Some(ha), Some(hb)) = (sa.head, sb.head) {
                        if confirmed_pairs < MAX_CONFIRMED_PAIRS {
                            confirmed_pairs += 1;
                            if let Some(found) = self.merge_conflicts(&ia.path, ha, hb) {
                                confirmed = true;
                                conflicting_files =
                                    found.into_iter().filter(|f| files.contains(f)).collect();
                            }
                        } else {
                            capped = true;
                        }
                    }
                }
                let severity = if !conflicting_files.is_empty() {
                    Severity::Conflict
                } else if files.iter().all(|f| is_lockfile(f)) {
                    Severity::Lockfile
                } else {
                    Severity::Overlap
                };
                collisions.push(Collision {
                    a: ia.id.clone(),
                    a_name: ia.name.clone(),
                    b: ib.id.clone(),
                    b_name: ib.name.clone(),
                    files,
                    conflicting_files,
                    severity,
                    confirmed,
                });
            }
        }
        ProjectCollisions { collisions, scanned, capped }
    }

    /// The project's report, reused while younger than `ttl`.
    pub fn scan_throttled(
        &mut self,
        project: &str,
        inputs: &[ScanInput],
        now: Instant,
        ttl: Duration,
    ) -> ProjectCollisions {
        // A workspace added, archived or renamed invalidates the report at once.
        let shape: String = inputs
            .iter()
            .map(|i| format!("{}\u{1f}{}\u{1f}{}\u{1f}{:?}\u{1e}", i.id, i.name, i.path.display(), i.base))
            .collect();
        if let Some((at, prev_shape, report)) = self.reports.get(project) {
            if *prev_shape == shape && now.saturating_duration_since(*at) < ttl {
                return report.clone();
            }
        }
        let report = self.scan(inputs);
        self.reports.insert(project.to_string(), (now, shape, report.clone()));
        report
    }
}
