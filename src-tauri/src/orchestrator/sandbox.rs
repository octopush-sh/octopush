//! macOS seatbelt sandboxing for agent CLI execution.
//!
//! When a mission's `exec_isolation = "sandbox"`, the CLI substrate's process is
//! wrapped in `sandbox-exec -p <profile> …` under a generated SBPL profile that
//! **confines writes** to the mission's workspace (plus the temp dirs, CLI
//! session dir and the stage's own build cache a real agent needs) while
//! leaving reads and network intact — the
//! agents need both. The core security property: a sandboxed agent cannot modify
//! files outside its own mission (other worktrees, `~/.ssh`, `~/Documents`,
//! system paths stay read-only). Nor can it touch the repo's git hooks, `info/`,
//! config or `.git` pointers (`git_write_rules`), which would run code on the
//! host outside the sandbox; a linked worktree can still `git add`/`git commit`.
//!
//! Enforcement lives at exactly one place — the spawn in `cli_runner.rs` — so it
//! covers in-process runs and the detached worker identically. There is **no
//! silent fallback**: if the sandbox can't be set up, the stage fails with a
//! readable error rather than running unconfined.

use crate::error::{AppError, AppResult};
use std::ffi::{OsStr, OsString};
use std::path::{Component, Path, PathBuf};

/// The system seatbelt driver. Absolute so it resolves regardless of the child's
/// PATH; it is a stable macOS system binary.
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// Escape a path for an SBPL string literal (`"…"`). Backslash and quote are the
/// only characters the SBPL string grammar requires escaping.
fn sbpl_string(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// The writable directory *subtrees* a real CLI process needs regardless of the
/// mission — the temp dir and `/dev`. The Claude CLI's own state dirs under
/// `~/.claude` come from [`CLAUDE_STATE_DIRS`]. Kept deliberately narrow:
/// `~/.ssh`, `~/.aws`, `~/.config` (credentials), `~/.cache` (shared by every
/// tool and mission, so builds get `XDG_CACHE_HOME` in their own cache root
/// instead), documents, and every other project stay read-only. Pure.
///
/// Seatbelt matches the kernel-resolved (realpath) path, so only the `/private`
/// forms are live rules — `/tmp`→`/private/tmp`, `$TMPDIR`→`/private/var/…`. We
/// list the real form here; the exact `$TMPDIR` subtree's canonical form is added
/// by `assemble_write_roots`, so we don't blanket-allow all of `/var/folders`.
fn system_write_roots(tmpdir: Option<&str>) -> Vec<String> {
    let mut v = vec!["/dev".to_string(), "/private/tmp".to_string()];
    if let Some(t) = tmpdir {
        v.push(t.to_string());
    }
    // NB: we do NOT add the global package-manager dirs (~/.cargo, ~/.gradle, …)
    // to the write roots — several are config/executable dirs, and a sandboxed
    // agent could plant a `~/.cargo/config.toml` rustc-wrapper or a
    // `~/.gradle/init.d/*.gradle` that runs OUTSIDE the sandbox on the user's
    // next build (a full confinement escape). Instead, a sandboxed BUILD is made
    // to write its caches into its own cache root via env
    // redirection — see `sandbox_cache_env` and `mission_cache_root`.
    v
}

/// The `~/.claude` subdirs a Claude Code `-p` stage writes, each its own
/// write root: session transcripts (`projects`), todo and task lists, the
/// feature-flag cache (`statsig`), the shell snapshot and session env its Bash
/// tool sources, `~/.claude.json` backups, debug logs, file checkpoints, plans
/// and queued telemetry. `~/.claude` itself is not writable, so a stage can't
/// plant the skills, agents, commands, plugins, hooks, settings or `CLAUDE.md`
/// that every later Claude Code session loads, the user's own `claude` in a
/// terminal included (#774).
const CLAUDE_STATE_DIRS: &[&str] = &[
    "backups",
    "debug",
    "file-history",
    "plans",
    "projects",
    "session-env",
    "shell-snapshots",
    "statsig",
    "tasks",
    "telemetry",
    "todos",
];

/// The `~/.claude` dirs Claude Code loads code or instructions from (`local`
/// holds a local install's `claude` binary). Denied again after every allow.
const CLAUDE_DENIED_DIRS: &[&str] = &["agents", "commands", "hooks", "local", "output-styles", "plugins", "rules", "skills"];

/// The `~/.claude` files Claude Code loads settings, hooks or instructions
/// from. Denied again after every allow, with every other `settings*.json`.
const CLAUDE_DENIED_FILES: &[&str] = &["CLAUDE.md", "settings.json", "settings.local.json"];

/// `~/.claude` as given and as its realpath (given first). Never empty.
fn claude_forms(home: &str) -> Vec<String> {
    let given = format!("{}/.claude", home.trim_end_matches('/'));
    let real = canonical_string(Path::new(&given));
    if real == given { vec![given] } else { vec![given, real] }
}

/// Whether `path` is, or is inside, something Claude Code loads from one of
/// the `~/.claude` forms `claude`: a [`CLAUDE_DENIED_DIRS`] dir, a
/// [`CLAUDE_DENIED_FILES`] file or other `settings*.json`, or a project's
/// auto memory (`projects/<project>/memory`, loaded into every later session
/// of that project). Pure.
fn in_claude_denied(path: &Path, claude: &[String]) -> bool {
    claude.iter().any(|c| {
        let Ok(rel) = path.strip_prefix(c) else { return false };
        let parts: Vec<&str> = rel.iter().filter_map(|p| p.to_str()).collect();
        match parts.as_slice() {
            [first, ..] if CLAUDE_DENIED_DIRS.contains(first) => true,
            [name] => CLAUDE_DENIED_FILES.contains(name) || (name.starts_with("settings") && name.ends_with(".json")),
            ["projects", _, "memory", ..] => true,
            _ => false,
        }
    })
}

/// The deny rules for what Claude Code loads from each `~/.claude` form in
/// `claude` (see [`in_claude_denied`]). Rendered after the allows, so they win
/// even over a state dir or `~/.claude.json` link that resolves there. Pure.
fn claude_deny_rules(claude: &[String]) -> WriteRules {
    let mut rules = WriteRules::default();
    for c in claude {
        let c = c.trim_end_matches('/');
        rules.deny_subpaths.extend(CLAUDE_DENIED_DIRS.iter().map(|d| format!("{c}/{d}")));
        rules.deny_literals.extend(CLAUDE_DENIED_FILES.iter().map(|f| format!("{c}/{f}")));
        let e = regex_escape(c);
        rules.deny_regexes.push(format!("^{e}/settings[^/]*\\.json$"));
        rules.deny_regexes.push(format!("^{e}/projects/[^/]+/memory(/|$)"));
    }
    rules.dedup();
    rules
}

/// A short, stable hex scope key for a string (e.g. a workspace path) — used to
/// give each workspace and access mode its OWN cache subtree so a sandboxed
/// stage on one workspace can't poison the cache another workspace compiles.
fn scope_key(s: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Where every build cache lives: the user cache dir
/// (`~/Library/Caches/octopush/build-cache`), which is NOT a write root. Only
/// the stage's own cache root is added to its profile, so a sandboxed stage can
/// never write the cache of another workspace or access mode (as it could when
/// they all sat in the shared, writable `$TMPDIR`).
fn build_cache_base() -> Option<PathBuf> {
    dirs::cache_dir().map(|d| d.join("octopush").join("build-cache"))
}

/// Where the sandboxed Claude stages' own temp dirs live:
/// `~/Library/Caches/octopush/tmp/<key>`, one per cache root (`stage_tmp_dir`).
/// Not a write root either, so a stage can't write another workspace's or
/// access mode's temp dir. It sits beside `build-cache`, not inside the cache
/// root, to keep the path short: macOS caps a Unix socket path at 104 bytes,
/// and `<cache root>/tmp` (~89 bytes for an 8-letter user name) would leave
/// too little room for a socket a test or tool binds in a temp dir of its own
/// (`tempfile::tempdir()` + `/x.sock` already overflows it).
fn stage_tmp_base() -> Option<PathBuf> {
    dirs::cache_dir().map(|d| d.join("octopush").join("tmp"))
}

/// The temp dir under `tmp_base` that belongs to the cache root `cache_root`
/// (`<base>/<workspace>/<mode>`): keyed by those two names, so it's shared
/// exactly by the stages that share the cache root and found again from it
/// when the workspace is deleted. `None` when `cache_root` has no such
/// names. Pure.
fn stage_tmp_dir(tmp_base: &Path, cache_root: &Path) -> Option<PathBuf> {
    let mode = cache_root.file_name()?.to_str()?;
    let ws = cache_root.parent()?.file_name()?.to_str()?;
    Some(tmp_base.join(scope_key(&format!("{ws}/{mode}"))))
}

/// How long a build cache may go unused before launch removes it
/// (`prune_build_caches`).
pub const BUILD_CACHE_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 60 * 60);

/// The directory under `base` holding every cache root of one workspace
/// (`scope`), so deleting the workspace removes them all
/// (`remove_workspace_build_caches`). A trailing `/` doesn't make another
/// workspace. Pure.
fn workspace_cache_dir(base: &Path, scope: &str) -> PathBuf {
    let trimmed = scope.trim_end_matches('/');
    base.join(scope_key(if trimmed.is_empty() { scope } else { trimmed }))
}

/// Who a sandboxed launch shares its cache root (and the temp dir keyed by
/// it, `stage_tmp_dir`) with, besides launches on the same workspace with the
/// same write roots. A read-confined Claude stage names both dirs with
/// `--add-dir`, and Claude Code loads `.claude/skills`, agents and commands
/// from an `--add-dir` dir. A readonly mission's stages can't write the
/// worktree, so for them these dirs are the only place another launch could
/// plant such files. Each kind of launch therefore gets its own dirs: only
/// read-confined Claude stages of the same workspace, write roots and exec
/// choice write the dirs such a stage loads from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheTenant<'a> {
    /// A CLI stage (Claude or Codex) in a sandboxed mission. `exec_choice` is
    /// the mission's own choice (`StageIsolation::exec_choice`), before a
    /// `readonly` mission forces the sandbox on; `reads_confined` is whether
    /// it is a Claude stage with the read guard (`confine_reads_in_sandbox`),
    /// the only kind that `--add-dir`s its dirs.
    Cli { exec_choice: &'a str, reads_confined: bool },
    /// TALK's inline `run_command` and an API-substrate DIRECT stage's
    /// (`chat_engine::execute_tool`): reads open, no `--add-dir`.
    InProcess,
    /// A Codex writer in Codex's own `workspace-write` sandbox, outside a
    /// sandboxed mission (`codex_build_cache`).
    CodexWorkspaceWrite,
}

impl CacheTenant<'_> {
    /// The tenant's part of the cache root's key. Pure.
    fn tag(&self) -> String {
        match self {
            CacheTenant::Cli { exec_choice, reads_confined } => {
                format!("cli:exec={exec_choice}:reads={}", if *reads_confined { "confined" } else { "open" })
            }
            CacheTenant::InProcess => "in-process".to_string(),
            CacheTenant::CodexWorkspaceWrite => "codex:workspace-write".to_string(),
        }
    }
}

/// A cache root under `base`: `<workspace dir>/<key of the write roots and
/// the tenant>`, so a readonly mission on a workspace doesn't share the
/// writer's cache, and no other kind of launch shares a read-confined Claude
/// stage's ([`CacheTenant`]). Launches with the same workspace, write roots
/// and tenant (two read-confined readonly reviews, say) share one. Pure.
fn mission_cache_root(base: &Path, scope: &str, write_roots: &[String], tenant: CacheTenant) -> PathBuf {
    // `\0` can't occur in a path, so roots and tag can't run into each other.
    let key = format!("{}\0\0{}", write_roots.join("\0"), tenant.tag());
    workspace_cache_dir(base, scope).join(scope_key(&key))
}

/// The dirs a sandboxed launch on the workspace `scope` with `write_roots`
/// and `tenant` writes besides its write roots, before they are created: its
/// cache root and, with `private_tmp`, its temp dir. `None` for the temp dir
/// only when the root has no names to key it by. Pure; `StageDirs::make`
/// creates exactly these.
pub(crate) fn stage_dir_paths(
    cache_base: &Path,
    tmp_base: &Path,
    scope: &str,
    write_roots: &[String],
    tenant: CacheTenant,
    private_tmp: bool,
) -> (PathBuf, Option<PathBuf>) {
    let root = mission_cache_root(cache_base, scope, write_roots, tenant);
    let tmp = if private_tmp { stage_tmp_dir(tmp_base, &root) } else { None };
    (root, tmp)
}

/// Remove every build cache of the workspace at `scope` (all its access
/// modes). Called when the workspace is deleted. Never follows a symlink in
/// the workspace dir's place; a missing dir is fine.
pub fn remove_workspace_build_caches(scope: &str) -> std::io::Result<()> {
    let Some(base) = build_cache_base() else { return Ok(()) };
    let ws_dir = workspace_cache_dir(&base, scope);
    if let Some(tmp_base) = stage_tmp_base() {
        remove_stage_tmps(&ws_dir, &tmp_base)?;
    }
    remove_cache_dir(&ws_dir)
}

/// Remove the stage temp dirs (`stage_tmp_dir`) of every cache root in the
/// workspace dir `ws_dir`. Lists `ws_dir` only when it's a real dir (never
/// through a link); a missing temp dir is fine.
fn remove_stage_tmps(ws_dir: &Path, tmp_base: &Path) -> std::io::Result<()> {
    if !std::fs::symlink_metadata(ws_dir).is_ok_and(|m| m.is_dir()) {
        return Ok(());
    }
    for root in std::fs::read_dir(ws_dir)?.flatten() {
        if let Some(tmp) = stage_tmp_dir(tmp_base, &root.path()) {
            remove_cache_dir(&tmp)?;
        }
    }
    Ok(())
}

fn remove_cache_dir(dir: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(dir) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(dir),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Remove the build caches unused for longer than `max_age`; returns how
/// many cache roots went. Run once on launch, off the main thread.
pub fn prune_build_caches(max_age: std::time::Duration) -> usize {
    let now = std::time::SystemTime::now();
    let caches = build_cache_base().map_or(0, |base| prune_cache_base(&base, now, max_age));
    let tmps = stage_tmp_base().map_or(0, |base| prune_tmp_base(&base, now, max_age));
    caches + tmps
}

/// `prune_build_caches` over the stage temp dirs in `base` (one level, each
/// refreshed whenever a stage uses it): removes those unused for longer than
/// `max_age`, links without following them. Same guard as
/// `prune_cache_base`: nothing unless `base` and its parent are real
/// directories owned by this user.
fn prune_tmp_base(base: &Path, now: std::time::SystemTime, max_age: std::time::Duration) -> usize {
    if check_own_dir(base).is_err() || !base.parent().is_some_and(|p| check_own_dir(p).is_ok()) {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(base) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_stale(&path, now, max_age) {
            continue;
        }
        let gone = match entry.file_type() {
            Ok(t) if t.is_dir() => std::fs::remove_dir_all(&path),
            _ => std::fs::remove_file(&path),
        };
        if gone.is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Whether `p` (not followed if a link) was last modified more than
/// `max_age` before `now`.
fn is_stale(p: &Path, now: std::time::SystemTime, max_age: std::time::Duration) -> bool {
    std::fs::symlink_metadata(p)
        .and_then(|m| m.modified())
        .is_ok_and(|t| now.duration_since(t).is_ok_and(|age| age > max_age))
}

/// `prune_build_caches` over `base`: each workspace dir's entries older than
/// `max_age` are removed (a cache root's mtime is refreshed every time a stage
/// uses it, `ensure_cache_root`), then the workspace dir if that left it empty
/// and it was itself stale. Links are removed, never followed. Pre-#762 flat
/// roots (`<base>/<key>/cargo`…) are pruned the same way. Prunes nothing
/// unless `base` and its parent (`…/Caches/octopush`) are real directories
/// owned by this user: through a link it would delete old entries wherever
/// the link points.
///
/// A stage starting meanwhile (a detached worker, a resumed run) may have its
/// root removed between the staleness check and the removal, or its workspace
/// dir between `ensure_cache_root`'s two `create_dir`s. Its `ensure_cache_root`
/// or its build then fails closed; nothing escapes the sandbox.
fn prune_cache_base(base: &Path, now: std::time::SystemTime, max_age: std::time::Duration) -> usize {
    if check_own_dir(base).is_err() || !base.parent().is_some_and(|p| check_own_dir(p).is_ok()) {
        return 0;
    }
    let Ok(dirs) = std::fs::read_dir(base) else { return 0 };
    let mut removed = 0;
    for ws in dirs.flatten() {
        if !ws.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let ws_dir = ws.path();
        let ws_stale = is_stale(&ws_dir, now, max_age);
        let Ok(roots) = std::fs::read_dir(&ws_dir) else { continue };
        for root in roots.flatten() {
            let path = root.path();
            if !is_stale(&path, now, max_age) {
                continue;
            }
            let gone = match root.file_type() {
                Ok(t) if t.is_dir() => std::fs::remove_dir_all(&path),
                _ => std::fs::remove_file(&path),
            };
            if gone.is_ok() {
                removed += 1;
            }
        }
        if ws_stale {
            // Only succeeds when empty.
            let _ = std::fs::remove_dir(&ws_dir);
        }
    }
    removed
}

/// Env vars that redirect common build toolchains' WRITE caches into a confined
/// cache root per workspace and access mode (`mission_cache_root`, the one cache
/// subtree the stage's profile may write), so a sandboxed `npm install`/`cargo build`
/// works WITHOUT exposing the user's real `~/.cargo` etc. AND without sandboxed
/// stages on different workspaces sharing (and poisoning) one cache. Read-only global
/// installs (toolchains, tool binaries on PATH) still work — reads are open;
/// only writes are redirected. Returned by `prepare` for the CLI substrate and
/// TALK's sandboxed `run_command`. Pure over its inputs.
fn sandbox_cache_env(cache_root: &str) -> Vec<(String, String)> {
    let base = cache_root.trim_end_matches('/');
    vec![
        ("CARGO_HOME".into(), format!("{base}/cargo")), // rust: registry/git/config/bin (fresh, confined)
        ("npm_config_cache".into(), format!("{base}/npm")),
        ("YARN_CACHE_FOLDER".into(), format!("{base}/yarn")),
        ("npm_config_store_dir".into(), format!("{base}/pnpm")), // pnpm store
        ("GOPATH".into(), format!("{base}/go")),
        ("GOCACHE".into(), format!("{base}/go-build")),
        ("GOMODCACHE".into(), format!("{base}/go/pkg/mod")),
        ("GRADLE_USER_HOME".into(), format!("{base}/gradle")),
        ("DENO_DIR".into(), format!("{base}/deno")),
        ("PIP_CACHE_DIR".into(), format!("{base}/pip")),
        // Every XDG tool (pre-commit, uv, ruff, …) instead of the shared ~/.cache.
        ("XDG_CACHE_HOME".into(), format!("{base}/xdg")),
    ]
}

/// The cache root of a Codex writer stage in Codex's own `workspace-write`
/// sandbox, keyed by the workspace and its own tenant so it never shares a
/// sandboxed mission's root. Pure.
pub(crate) fn codex_cache_root(base: &Path, scope: &str) -> PathBuf {
    mission_cache_root(base, scope, &[], CacheTenant::CodexWorkspaceWrite)
}

/// Set up the build cache of a Codex writer stage outside a sandboxed
/// mission: `npm install`, `cargo build` & co. can't write `~/.npm` or
/// `~/.cargo` under Codex's `workspace-write` sandbox, so their caches go to
/// this stage's own root, which the runner adds to Codex's writable roots.
/// Returns the root and the same env as a sandboxed stage gets
/// (`sandbox_cache_env`). Same checks as `prepare`'s cache root.
pub fn codex_build_cache(scope: &str) -> std::io::Result<(String, Vec<(String, String)>)> {
    let base = build_cache_base().ok_or_else(|| std::io::Error::other("no cache directory for builds"))?;
    let root = ensure_cache_root(&codex_cache_root(&base, scope))?.to_string_lossy().into_owned();
    let env = sandbox_cache_env(&root);
    Ok((root, env))
}

/// Writable individual *files* (as opposed to subtrees). Seatbelt's `subpath`
/// won't cover a bare file sibling of an allowed dir, so the CLI's top-level
/// `~/.claude.json` state file needs its own `literal` rule.
fn system_write_files(home: Option<&str>) -> Vec<String> {
    match home {
        Some(h) => vec![format!("{h}/.claude.json")],
        None => Vec::new(),
    }
}

/// This process's user id, which owns the user-home write roots.
#[cfg(unix)]
fn current_uid() -> Option<u32> {
    // SAFETY: `getuid` has no preconditions and can't fail.
    Some(unsafe { libc::getuid() })
}

#[cfg(not(unix))]
fn current_uid() -> Option<u32> {
    None
}

#[cfg(unix)]
fn owner_of(meta: &std::fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    Some(meta.uid())
}

#[cfg(not(unix))]
fn owner_of(_meta: &std::fs::Metadata) -> Option<u32> {
    None
}

/// Whether `meta` is owned by `owner` (always, when there is no owner to
/// check against or the platform has no uids).
fn owned_by(meta: &std::fs::Metadata, owner: Option<u32>) -> bool {
    match (owner, owner_of(meta)) {
        (Some(want), Some(got)) => want == got,
        _ => true,
    }
}

/// The dirs no system write root may resolve to: `/`, `/Users`, `$HOME` and
/// every ancestor of `$HOME`, each as given and as its realpath.
fn forbidden_root_targets(home: Option<&str>) -> Vec<PathBuf> {
    let mut v = vec![PathBuf::from("/"), PathBuf::from("/Users"), canonical_lenient(Path::new("/Users"))];
    if let Some(h) = home {
        for base in [PathBuf::from(h), canonical_lenient(Path::new(h))] {
            v.extend(base.ancestors().map(Path::to_path_buf));
        }
    }
    v.sort();
    v.dedup();
    v
}

/// The dirs only Octopush may hand out, which no system write root may hold:
/// the build-cache base and the stage temp base, each as given and as its
/// realpath. A stage must never write another stage's cache root or temp dir.
fn private_bases() -> Vec<PathBuf> {
    let mut v = Vec::new();
    for base in [build_cache_base(), stage_tmp_base()].into_iter().flatten() {
        v.push(canonical_lenient(&base));
        v.push(base);
    }
    v.sort();
    v.dedup();
    v
}

/// Why `real` (a system root's realpath) sits in a user dir no stage may
/// write: `~/.config`, `~/.ssh`, or `~/Library` outside `~/Library/Caches`
/// (`$HOME` as given and as its realpath). Credentials and launch agents
/// live there. Pure over its inputs (`home_real` is `$HOME`'s realpath).
fn guarded_home_dir(real: &Path, home: &str, home_real: &Path) -> Option<String> {
    for base in [Path::new(home), home_real] {
        for name in [".config", ".ssh", "Library"] {
            let guarded = base.join(name);
            if real.starts_with(&guarded) && !(name == "Library" && real.starts_with(base.join("Library/Caches"))) {
                return Some(format!("{home}/{name}"));
            }
        }
    }
    None
}

/// The paths a profile may grant for the system write root dir `root`: the
/// root as given and, when it differs, its realpath. A root that doesn't exist
/// yet is granted as given (the root deny keeps a stage from creating it).
/// Fails closed, with the reason, when the root resolves to `/`, `/Users`,
/// `$HOME` or an ancestor of `$HOME`, holds one of `private` (the build-cache
/// and stage temp bases, `private_bases`), resolves under `~/.config`,
/// `~/.ssh` or `~/Library` outside its `Caches`, doesn't resolve, isn't a
/// directory, or (with `owner`, for the user-home roots) the entry or what it
/// resolves to isn't owned by `owner`.
fn resolve_system_root(
    root: &str,
    home: Option<&str>,
    owner: Option<u32>,
    private: &[PathBuf],
) -> Result<Vec<String>, String> {
    let path = Path::new(root);
    let Ok(entry) = std::fs::symlink_metadata(path) else {
        return Ok(vec![root.to_string()]);
    };
    let real = std::fs::canonicalize(path).map_err(|e| format!("{root} doesn't resolve ({e})"))?;
    if forbidden_root_targets(home).contains(&real) {
        return Err(format!("{root} resolves to {}", real.display()));
    }
    if let Some(base) = private.iter().find(|b| b.starts_with(&real)) {
        return Err(format!("{root} holds Octopush's own stage dirs ({})", base.display()));
    }
    if let Some(dir) = home.and_then(|h| guarded_home_dir(&real, h, &canonical_lenient(Path::new(h)))) {
        return Err(format!("{root} resolves under {dir}"));
    }
    let target = std::fs::metadata(&real).map_err(|e| format!("{root} can't be read ({e})"))?;
    if !target.is_dir() {
        return Err(format!("{root} is not a directory"));
    }
    if !owned_by(&entry, owner) || !owned_by(&target, owner) {
        return Err(format!("{root} is not owned by you"));
    }
    let real = real.to_string_lossy().into_owned();
    Ok(if real == root { vec![real] } else { vec![root.to_string(), real] })
}

/// The paths a profile may grant for the CLI state file `file`
/// (`~/.claude.json`): the file as given and, when it differs, its realpath.
/// A file that doesn't exist yet is granted as given. Fails closed, with the
/// reason, when it doesn't resolve, isn't a regular file, has another hard
/// link, isn't owned by `owner`, or is a symlink to anything outside
/// `~/.claude/` (a path-component prefix: `~/.claude-old` is outside) or to
/// something Claude Code loads from there (`in_claude_denied`).
fn resolve_state_file(file: &str, home: &str, owner: Option<u32>) -> Result<Vec<String>, String> {
    let path = Path::new(file);
    let Ok(entry) = std::fs::symlink_metadata(path) else {
        return Ok(vec![file.to_string()]);
    };
    let real = std::fs::canonicalize(path).map_err(|e| format!("{file} doesn't resolve ({e})"))?;
    let target = std::fs::metadata(&real).map_err(|e| format!("{file} can't be read ({e})"))?;
    if !target.is_file() {
        return Err(format!("{file} is not a regular file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if target.nlink() != 1 {
            return Err(format!("{file} has more than one hard link"));
        }
    }
    if !owned_by(&entry, owner) || !owned_by(&target, owner) {
        return Err(format!("{file} is not owned by you"));
    }
    let real = real.to_string_lossy().into_owned();
    if entry.file_type().is_symlink() {
        let dot_claude = canonical_lenient(Path::new(home)).join(".claude");
        if !Path::new(&real).starts_with(&dot_claude) {
            return Err(format!("{file} links outside {home}/.claude"));
        }
        if in_claude_denied(Path::new(&real), &claude_forms(home)) {
            return Err(format!("{file} links to {real}, which Claude Code loads"));
        }
    }
    Ok(if real == file { vec![real] } else { vec![file.to_string(), real] })
}

/// [`resolve_system_root`] for the Claude Code state dir `root`
/// (`~/.claude/<dir>`, [`CLAUDE_STATE_DIRS`]), which must also not resolve
/// to `~/.claude` itself or a dir holding it (that would make the whole config
/// writable again), nor into something Claude Code loads
/// (`in_claude_denied`). `claude` is `~/.claude` as given and as its realpath.
fn resolve_claude_state_dir(
    root: &str,
    home: Option<&str>,
    owner: Option<u32>,
    private: &[PathBuf],
    claude: &[String],
) -> Result<Vec<String>, String> {
    let paths = resolve_system_root(root, home, owner, private)?;
    let real = canonical_lenient(Path::new(root));
    if claude.iter().any(|c| Path::new(c).starts_with(&real)) {
        return Err(format!("{root} resolves to {}, which holds {}", real.display(), claude[0]));
    }
    if in_claude_denied(&real, claude) {
        return Err(format!("{root} resolves to {}, which Claude Code loads", real.display()));
    }
    Ok(paths)
}

/// The write roots a profile is built from (see [`assemble_write_roots`]).
#[derive(Debug, Default, PartialEq)]
struct WriteRoots {
    /// Every writable subtree: the mission's roots and the system roots that
    /// passed [`resolve_system_root`], with their realpaths.
    subpaths: Vec<String>,
    /// The system root dirs themselves (as given and as realpaths), denied as
    /// paths so a stage can write inside them but never remove or replace one.
    system_roots: Vec<String>,
    /// Writable single files (`~/.claude.json` and its realpath).
    files: Vec<String>,
    /// `~/.claude` as given and as its realpath, whose loaded files and dirs
    /// the profile denies (`claude_deny_rules`). Empty without a `$HOME`.
    claude: Vec<String>,
    /// Why a system root or file was left out, one line each.
    refused: Vec<String>,
}

/// Merge the mission's write roots with the system defaults, add canonical forms
/// (seatbelt matches realpaths, so a symlinked root must appear resolved too),
/// and de-duplicate. The system roots, the Claude Code state dirs and the
/// state file go through [`resolve_system_root`] /
/// [`resolve_claude_state_dir`] / [`resolve_state_file`] (user-home ones
/// checked against `owner`, none allowed to hold one of `private`); one that
/// fails is left out (fail closed) and its reason recorded in `refused`. The
/// state dirs are only granted when `~/.claude` itself passes
/// [`resolve_system_root`]. Reads the filesystem, writes nothing.
fn assemble_write_roots(
    mission_roots: &[String],
    home: Option<&str>,
    tmpdir: Option<&str>,
    owner: Option<u32>,
    private: &[PathBuf],
) -> WriteRoots {
    let mut out = WriteRoots::default();
    for r in mission_roots {
        out.subpaths.push(r.clone());
        // Add the realpath form where it differs (best-effort; skip non-existent).
        if let Ok(c) = std::fs::canonicalize(r) {
            out.subpaths.push(c.to_string_lossy().into_owned());
        }
    }
    let in_home = |r: &str| home.is_some_and(|h| Path::new(r).starts_with(h));
    for r in system_write_roots(tmpdir) {
        let check_owner = if in_home(&r) { owner } else { None };
        match resolve_system_root(&r, home, check_owner, private) {
            Ok(paths) => {
                out.subpaths.extend(paths.iter().cloned());
                out.system_roots.extend(paths);
            }
            Err(why) => out.refused.push(why),
        }
    }
    if let Some(h) = home {
        let claude = claude_forms(h);
        match resolve_system_root(&claude[0], home, owner, private) {
            Ok(_) => {
                for name in CLAUDE_STATE_DIRS {
                    let dir = format!("{}/{name}", claude[0]);
                    match resolve_claude_state_dir(&dir, home, owner, private, &claude) {
                        Ok(paths) => {
                            out.subpaths.extend(paths.iter().cloned());
                            out.system_roots.extend(paths);
                        }
                        Err(why) => out.refused.push(why),
                    }
                }
            }
            Err(why) => out.refused.push(why),
        }
        out.claude = claude;
        for f in system_write_files(home) {
            match resolve_state_file(&f, h, owner) {
                Ok(paths) => out.files.extend(paths),
                Err(why) => out.refused.push(why),
            }
        }
    }
    for v in [&mut out.subpaths, &mut out.system_roots, &mut out.files] {
        v.sort();
        v.dedup();
    }
    out
}

/// Create `~/.claude` and its state dirs ([`CLAUDE_STATE_DIRS`], the
/// user-home write roots) when they don't exist yet, outside the sandbox and
/// before the profile is built, so a stage never gets to create a root entry
/// itself (each root is pinned, so it couldn't). The state dirs are only made
/// inside a `~/.claude` that passes [`resolve_system_root`]. `create_dir`
/// never follows a link in the new dir's place, each new dir is made
/// owner-only (0700, as the CLI makes `~/.claude`), and it must be a real
/// directory of the user's. An existing entry is left as it is. Best-effort:
/// a root that can't be made is still resolved (and checked) as usual.
fn ensure_home_roots(home: &str) {
    let make = |dir: &Path| {
        if std::fs::symlink_metadata(dir).is_ok() {
            return;
        }
        if let Err(e) = create_dir_0700(dir).and_then(|()| check_own_dir(dir)) {
            tracing::warn!(dir = %dir.display(), error = %e, "sandbox: couldn't create a write root");
        }
    };
    let claude = claude_forms(home).swap_remove(0);
    make(Path::new(&claude));
    if resolve_system_root(&claude, Some(home), current_uid(), &private_bases()).is_err() {
        return;
    }
    for name in CLAUDE_STATE_DIRS {
        make(&Path::new(&claude).join(name));
    }
}

/// Escape `s` so an SBPL `(regex …)` matches it literally.
fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if "\\.^$|?*+()[]{}".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// The write rules a profile is rendered from: re-allowed subtrees and files,
/// then the subtrees, files and path regexes denied again on top of them.
#[derive(Debug, Default, PartialEq)]
struct WriteRules {
    subpaths: Vec<String>,
    literals: Vec<String>,
    deny_subpaths: Vec<String>,
    deny_literals: Vec<String>,
    deny_regexes: Vec<String>,
}

impl WriteRules {
    fn extend(&mut self, other: WriteRules) {
        self.subpaths.extend(other.subpaths);
        self.literals.extend(other.literals);
        self.deny_subpaths.extend(other.deny_subpaths);
        self.deny_literals.extend(other.deny_literals);
        self.deny_regexes.extend(other.deny_regexes);
    }

    fn dedup(&mut self) {
        for v in [
            &mut self.subpaths,
            &mut self.literals,
            &mut self.deny_subpaths,
            &mut self.deny_literals,
            &mut self.deny_regexes,
        ] {
            v.sort();
            v.dedup();
        }
    }
}

/// Where a workspace's git metadata lives (all realpaths): `git_dir` is the
/// per-worktree dir (index, HEAD) and `common_dir` the shared one (objects,
/// refs, hooks, config) — the same dir for a main checkout. `hooks_dir` is the
/// dir git actually runs hooks from: `<common>/hooks`, or `core.hooksPath`.
#[derive(Debug, Clone, PartialEq)]
struct GitLayout {
    git_dir: String,
    common_dir: String,
    hooks_dir: String,
}

/// The dirs strictly between `root` (a writable root) and `path` (nearest
/// first). Denying them stops an agent renaming an ancestor of the hooks dir
/// and putting a symlink in its place. Empty when `path` isn't inside `root`.
/// Pure.
fn ancestors_within(root: &str, path: &str) -> Vec<String> {
    let root = Path::new(root);
    Path::new(path)
        .ancestors()
        .skip(1)
        .take_while(|dir| *dir != root && dir.starts_with(root))
        .map(|dir| dir.to_string_lossy().into_owned())
        .collect()
}

/// The shared git subtrees `git add`/`git commit`/`git stash` write: objects,
/// refs, reflogs and the reftable. Never hooks, `info/` or config. Pure.
fn shared_git_write_subpaths(common_dir: &str) -> [String; 4] {
    let c = common_dir.trim_end_matches('/');
    ["objects", "refs", "logs", "reftable"].map(|d| format!("{c}/{d}"))
}

/// The git write rules for a workspace. Allows what `git add`/`git commit` need
/// — the per-worktree git dir plus the shared objects, refs, reflogs and
/// packed-refs (or reftable) — which a linked worktree keeps outside its own
/// subtree. Then denies everything that runs code or changes git's behaviour
/// on the host: the effective hooks dir (and `<common>/hooks`) plus its parent
/// dirs inside the workspace or any other of `write_roots` (a `core.hooksPath`
/// may point into `$TMPDIR` or a `~/.claude` state dir), `info/`, the legacy `remotes/` and
/// `branches/` (a planted file there redirects a later `git fetch`), the
/// shared and per-worktree config, every worktree's `commondir`/`gitdir`/
/// `config.worktree` (a main checkout could otherwise repoint a sibling
/// worktree), submodule git dirs under every `modules/` (shared, own and each
/// sibling worktree's), `<common>/worktrees` and each worktree's git dir as
/// paths (so none can be renamed and replaced), the workspace's own `.git`
/// entry and writes under any nested `.git` path in it (replacing one would
/// redirect git to a planted config). Not covered: moving in a directory that
/// already holds a `.git`. A hook planted there would run unsandboxed on the
/// user's next commit or `git status`. Applies to main checkouts too. Pure.
fn git_write_rules(workspace: &str, layout: &GitLayout, write_roots: &[String]) -> WriteRules {
    let ws = workspace.trim_end_matches('/');
    let g = layout.git_dir.trim_end_matches('/');
    let c = layout.common_dir.trim_end_matches('/');
    let hooks = layout.hooks_dir.trim_end_matches('/');
    let mut deny_literals = vec![
        format!("{c}/config"),
        format!("{c}/config.lock"),
        format!("{c}/config.worktree"),
        format!("{c}/config.worktree.lock"),
        format!("{g}/config.worktree"),
        format!("{g}/config.worktree.lock"),
        format!("{g}/commondir"),
        format!("{ws}/.git"),
        // Seatbelt checks a rename only against its source and destination, so
        // `worktrees/` itself must not be movable or the denies below are moot.
        format!("{c}/worktrees"),
    ];
    let other_roots = write_roots.iter().map(|r| r.trim_end_matches('/')).filter(|r| !r.is_empty());
    for root in std::iter::once(ws).chain(other_roots) {
        deny_literals.extend(ancestors_within(root, hooks));
    }
    let mut rules = WriteRules {
        subpaths: std::iter::once(g.to_string()).chain(shared_git_write_subpaths(c)).collect(),
        literals: vec![format!("{c}/packed-refs"), format!("{c}/packed-refs.lock")],
        deny_subpaths: vec![
            hooks.to_string(),
            format!("{c}/hooks"),
            format!("{c}/info"),
            format!("{c}/remotes"),
            format!("{c}/branches"),
            format!("{c}/modules"),
            format!("{g}/modules"),
        ],
        deny_literals,
        deny_regexes: vec![
            format!(
                "^{}/worktrees/[^/]+/(commondir|gitdir|config\\.worktree|config\\.worktree\\.lock)$",
                regex_escape(c)
            ),
            // Each worktree's git dir itself (not its contents), so no worktree
            // can be renamed away and replaced by a planted dir. Writes inside
            // the own linked git dir (index, HEAD) stay allowed.
            format!("^{}/worktrees/[^/]+$", regex_escape(c)),
            // `modules/` is per worktree, so a sibling's submodule git dirs sit
            // under `<common>/worktrees/<name>/modules`, inside a main checkout.
            format!("^{}/worktrees/[^/]+/modules(/|$)", regex_escape(c)),
            format!("^{}/.+/\\.git(/|$)", regex_escape(ws)),
        ],
    };
    rules.dedup();
    rules
}

/// Whether a resolved layout looks like one git itself would create for this
/// workspace: a main checkout's `<ws>/.git`, or a linked worktree's
/// `<common>/worktrees/<name>`. Anything else (a `.git` file edited to point at
/// `$HOME`, say) refuses the sandbox, so it can't widen the write roots. Pure.
fn is_plausible_layout(workspace: &str, layout: &GitLayout) -> bool {
    let ws = Path::new(workspace);
    let git_dir = Path::new(&layout.git_dir);
    let common = Path::new(&layout.common_dir);
    let main_checkout = git_dir == common && git_dir == ws.join(".git");
    let linked = git_dir.parent() == Some(common.join("worktrees").as_path());
    main_checkout || linked
}

/// The realpath of `p`. A path that doesn't exist yet (a hooks dir husky hasn't
/// created, say) keeps its missing tail on its nearest existing ancestor's
/// realpath, so seatbelt still matches it.
fn canonical_lenient(p: &Path) -> PathBuf {
    if let Ok(c) = std::fs::canonicalize(p) {
        return c;
    }
    match (p.parent(), p.file_name()) {
        (Some(parent), Some(name)) => canonical_lenient(parent).join(name),
        _ => p.to_path_buf(),
    }
}

fn canonical_string(p: &Path) -> String {
    canonical_lenient(p).to_string_lossy().into_owned()
}

/// Resolve a workspace's git layout with `git rev-parse --git-dir
/// --git-common-dir --git-path hooks`. `Ok(None)` only when the workspace has
/// no `.git` entry of its own. Fails closed: when git can't answer (an agent
/// may have corrupted `HEAD`) or the layout is implausible, it errors instead
/// of dropping the git rules, so the stage doesn't run with hooks writable.
fn resolve_git_layout(workspace: &str) -> AppResult<Option<GitLayout>> {
    let ws = Path::new(workspace);
    // `symlink_metadata`, so a dangling `.git` symlink still counts as present.
    if std::fs::symlink_metadata(ws.join(".git")).is_err() {
        return Ok(None);
    }
    let refuse = |why: &str| {
        AppError::Other(format!(
            "the sandbox can't protect the git hooks and config of {workspace} ({why}). \
             Run `git status` there to check the repository."
        ))
    };
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(ws)
        .args(["rev-parse", "--git-dir", "--git-common-dir", "--git-path", "hooks"])
        .env_remove("GIT_DIR")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_WORK_TREE")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|e| refuse(&format!("git could not run: {e}")))?;
    if !output.status.success() {
        return Err(refuse("git can't read the repository"));
    }
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let lines: Vec<&str> = text.lines().collect();
    let [git_dir, common_dir, hooks_dir] = lines[..] else {
        return Err(refuse("git gave an unexpected answer"));
    };
    // Relative answers are relative to `-C <ws>`; absolute ones replace it. A
    // relative `core.hooksPath` is relative to the worktree root, i.e. `<ws>`.
    let ws_real = canonical_string(ws);
    let base = Path::new(&ws_real);
    let layout = GitLayout {
        git_dir: canonical_string(&base.join(git_dir)),
        common_dir: canonical_string(&base.join(common_dir)),
        hooks_dir: canonical_string(&base.join(hooks_dir)),
    };
    if !is_plausible_layout(&ws_real, &layout) {
        return Err(refuse("its `.git` points somewhere git itself wouldn't put it"));
    }
    Ok(Some(layout))
}

/// A workspace's `.git` entry as a Codex writer stage found it. In a linked
/// worktree it is a file holding `gitdir: <common>/worktrees/<name>`; an agent
/// that rewrites it can point git at a dir it planted, with its own config
/// (`core.fsmonitor`, `core.hooksPath`) and hooks, which the next git command
/// run outside the sandbox would execute. The Seatbelt profile denies writing
/// it; Codex's writable roots can't deny a path, so the runner records it
/// before the stage and checks it after ([`restore_git_entry`]).
#[derive(Debug, Clone, PartialEq)]
pub enum GitEntry {
    Missing,
    Dir,
    File(Vec<u8>),
    Symlink(PathBuf),
    Other,
}

impl GitEntry {
    /// `<workspace>/.git`, without following a symlink.
    pub fn read(workspace: &Path) -> GitEntry {
        let path = workspace.join(".git");
        match std::fs::symlink_metadata(&path) {
            Err(_) => GitEntry::Missing,
            Ok(m) if m.file_type().is_symlink() => {
                std::fs::read_link(&path).map(GitEntry::Symlink).unwrap_or(GitEntry::Other)
            }
            Ok(m) if m.is_dir() => GitEntry::Dir,
            Ok(m) if m.is_file() => std::fs::read(&path).map(GitEntry::File).unwrap_or(GitEntry::Other),
            Ok(_) => GitEntry::Other,
        }
    }
}

/// Compare `<workspace>/.git` with `before`, recorded ahead of a Codex writer
/// stage. `None` when it is unchanged, or when there was none (a stage may
/// `git init` a plain dir). When a gitdir pointer file changed, the changed
/// entry is moved aside to `.git.changed-by-stage` and the original written
/// back, before anything runs git there again. Returns the stage's failure
/// message whenever the entry changed, saying whether it was put back.
pub fn restore_git_entry(workspace: &Path, before: &GitEntry) -> Option<String> {
    let now = GitEntry::read(workspace);
    if now == *before || *before == GitEntry::Missing {
        return None;
    }
    let shown = workspace.display();
    let GitEntry::File(original) = before else {
        return Some(format!(
            "This stage changed {shown}/.git, which tells git where the repository lives. \
             Don't run git there until you have put it back."
        ));
    };
    let git = workspace.join(".git");
    let put_back = || -> std::io::Result<Option<PathBuf>> {
        let aside = if now == GitEntry::Missing {
            None
        } else {
            let aside = std::iter::once(".git.changed-by-stage".to_string())
                .chain((2..100).map(|n| format!(".git.changed-by-stage-{n}")))
                .map(|name| workspace.join(name))
                .find(|p| std::fs::symlink_metadata(p).is_err())
                .ok_or_else(|| std::io::Error::other("no free name to move the changed one to"))?;
            std::fs::rename(&git, &aside)?;
            Some(aside)
        };
        // `create_new`, so a symlink planted in the meantime is never followed.
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&git)?;
        std::io::Write::write_all(&mut file, original)?;
        Ok(aside)
    };
    Some(match put_back() {
        Ok(Some(aside)) => format!(
            "This stage changed the worktree's .git file, which tells git where the repository \
             lives. Octopush put the original back and kept the changed one as {} for you to look at.",
            aside.display()
        ),
        Ok(None) => "This stage removed the worktree's .git file. Octopush put it back.".to_string(),
        Err(e) => format!(
            "This stage changed the worktree's .git file, which tells git where the repository \
             lives, and Octopush couldn't put it back ({e}). Don't run git in {shown} until .git \
             holds its original gitdir line again."
        ),
    })
}

/// Render an SBPL profile that allows everything by default, denies all file
/// writes and hard links, then re-allows writes under `subpaths` (directory
/// subtrees) and to `literals` (individual files), re-allows hard links under
/// `subpaths` only, and finally denies writes to and hard links of
/// `deny_subpaths`, `deny_literals` and `deny_regexes`. In SBPL the last
/// matching rule wins, so the trailing denies beat any allow above them.
/// `(allow default)` keeps reads and network working — confinement is on
/// writes only. Pure.
fn render_profile(rules: &WriteRules) -> String {
    fn filters(p: &mut String, kind: &str, values: &[String]) {
        for v in values {
            p.push_str("  (");
            p.push_str(kind);
            p.push(' ');
            p.push_str(&sbpl_string(v));
            p.push_str(")\n");
        }
    }
    let mut p = String::new();
    p.push_str("(version 1)\n");
    p.push_str("(allow default)\n");
    p.push_str("(deny file-write*)\n");
    // `file-link` isn't part of `file-write*`, and `(allow default)` would
    // otherwise let a stage hard-link a file from outside its roots into one
    // and write through the link. Seatbelt checks the link's source as well as
    // the new name, so allowing it only under the write roots keeps both
    // inside them. Symlinks are plain writes and need no rule of their own.
    p.push_str("(deny file-link)\n");
    // An allow with no filters would match every path, so an empty list
    // renders no allow at all.
    if !rules.subpaths.is_empty() || !rules.literals.is_empty() {
        p.push_str("(allow file-write*\n");
        filters(&mut p, "subpath", &rules.subpaths);
        filters(&mut p, "literal", &rules.literals);
        p.push_str(")\n");
    }
    if !rules.subpaths.is_empty() {
        p.push_str("(allow file-link\n");
        filters(&mut p, "subpath", &rules.subpaths);
        p.push_str(")\n");
    }
    if !rules.deny_subpaths.is_empty() || !rules.deny_literals.is_empty() || !rules.deny_regexes.is_empty() {
        // Hard links of the same paths are denied again on top of the
        // `file-link` allow: without it a stage could hard-link `.git/config`
        // or a hook into the workspace and write through the link.
        for op in ["file-write*", "file-link"] {
            p.push_str("(deny ");
            p.push_str(op);
            p.push('\n');
            filters(&mut p, "subpath", &rules.deny_subpaths);
            filters(&mut p, "literal", &rules.deny_literals);
            filters(&mut p, "regex", &rules.deny_regexes);
            p.push_str(")\n");
        }
    }
    p
}

/// Resolve the effective sandbox write-roots for a mission's execution, unifying
/// the two isolation axes into one confinement decision:
///
/// - **`git_isolation = "readonly"`** (review/probe missions) is *read-only by
///   construction*: the sandbox is forced ON with **no workspace in the write
///   roots** (temp-only writes), so the agent can read the checkout but never
///   modify it — regardless of the mission's own `exec_isolation`.
/// - else **`exec_isolation = "sandbox"`** → confine writes to the workspace.
/// - else → `None` (unconfined; a `none`/unimplemented tier is handled by the
///   caller / `cli_runner`'s fail-closed match).
///
/// `Some(vec![])` means "sandboxed, temp-only"; `Some(vec![ws])` means
/// "sandboxed, workspace-writable"; `None` means "not sandboxed". Pure.
pub fn sandbox_write_roots(
    git_isolation: &str,
    exec_isolation: &str,
    workspace_path: &str,
) -> Option<Vec<String>> {
    if git_isolation == "readonly" {
        Some(Vec::new())
    } else if exec_isolation == "sandbox" {
        Some(vec![workspace_path.to_string()])
    } else {
        None
    }
}

/// A stage's isolation, derived from its mission (see [`stage_isolation`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageIsolation {
    /// The effective tier: `sandbox` whenever [`sandbox_write_roots`] confines
    /// the stage (a `readonly` mission included), else the mission's choice.
    pub exec_isolation: String,
    /// The mission's own `exec_isolation`, before a `readonly` mission forces
    /// the sandbox on. Gates what only that choice asks for (the Claude read
    /// guard, #702).
    pub exec_choice: String,
    pub allowed_write_roots: Vec<String>,
}

/// Derive a stage's [`StageIsolation`] from its mission's two isolation axes.
/// Pure.
pub fn stage_isolation(git_isolation: &str, exec_choice: &str, workspace_path: &str) -> StageIsolation {
    let (exec_isolation, allowed_write_roots) = match sandbox_write_roots(git_isolation, exec_choice, workspace_path) {
        Some(roots) => ("sandbox".to_string(), roots),
        None => (exec_choice.to_string(), vec![workspace_path.to_string()]),
    };
    StageIsolation { exec_isolation, exec_choice: exec_choice.to_string(), allowed_write_roots }
}

/// Build the seatbelt profile text for a mission's write roots, resolving the
/// system dirs from the environment and each workspace root's git layout. A
/// readonly mission has no mission roots, so it gets no git rules (temp-only).
/// `cache_roots` (the stage's own build cache and temp dir, as realpaths
/// `prepare` checked) are writable too but never treated as workspaces. They go in as given, not
/// re-resolved, and each root dir itself is denied: a `subpath` also matches
/// its root, so without the deny a stage could swap the root for a symlink and
/// widen the next stage's profile to wherever it points. The system write root
/// dirs (`/dev`, `/private/tmp`, `$TMPDIR` and the `~/.claude` state dirs) and
/// their realpaths are denied as paths the same way, and a system root or the
/// `~/.claude.json` state file that fails its check is left out with a
/// warning (see [`assemble_write_roots`]). What Claude Code loads from
/// `~/.claude` is denied after every allow (`claude_deny_rules`). Errors when a workspace's git
/// layout can't be resolved (fail closed).
pub fn build_seatbelt_profile(mission_write_roots: &[String], cache_roots: &[String]) -> AppResult<String> {
    seatbelt_profile_and_refusals(mission_write_roots, cache_roots).map(|(profile, _)| profile)
}

/// [`build_seatbelt_profile`], plus why each system root or state file left
/// out of the profile was refused (one line each), for the stage launch line.
/// The missing user-home roots are created only on macOS, the one platform
/// that runs the sandbox, so a test elsewhere never writes the real `$HOME`.
fn seatbelt_profile_and_refusals(
    mission_write_roots: &[String],
    cache_roots: &[String],
) -> AppResult<(String, Vec<String>)> {
    let home = std::env::var("HOME").ok();
    let tmpdir = std::env::var("TMPDIR").ok();
    if let (true, Some(h)) = (cfg!(target_os = "macos"), home.as_deref()) {
        ensure_home_roots(h);
    }
    let roots = assemble_write_roots(
        mission_write_roots,
        home.as_deref(),
        tmpdir.as_deref(),
        current_uid(),
        &private_bases(),
    );
    profile_from_roots(roots, mission_write_roots, cache_roots)
}

/// The profile for the assembled `roots` (see
/// [`seatbelt_profile_and_refusals`]): the roots, `cache_roots` and the state
/// file allowed, every root dir pinned, then denied again what Claude Code
/// loads from `~/.claude` and each workspace's git hooks and config.
fn profile_from_roots(
    roots: WriteRoots,
    mission_write_roots: &[String],
    cache_roots: &[String],
) -> AppResult<(String, Vec<String>)> {
    for why in &roots.refused {
        tracing::warn!(reason = %why, "sandbox: a system write root was left out of the profile");
    }
    let refused = roots.refused;
    let mut subpaths = roots.subpaths;
    subpaths.extend(cache_roots.iter().cloned());
    let mut deny_literals = roots.system_roots;
    deny_literals.extend(cache_roots.iter().cloned());
    let mut rules = WriteRules {
        subpaths,
        literals: roots.files,
        deny_literals,
        ..WriteRules::default()
    };
    rules.extend(claude_deny_rules(&roots.claude));
    let write_roots = rules.subpaths.clone();
    for root in mission_write_roots {
        if let Some(layout) = resolve_git_layout(root)? {
            rules.extend(git_write_rules(&canonical_string(Path::new(root)), &layout, &write_roots));
        }
    }
    rules.dedup();
    Ok((render_profile(&rules), refused))
}

/// The launch-line note for the system roots left out of a stage's profile
/// (`Prepared::left_out`), so a dropped root never breaks a stage quietly:
/// `left out of the sandbox: <why>; <why>`. `None` when nothing was. Pure.
pub fn left_out_label(left_out: &[String]) -> Option<String> {
    (!left_out.is_empty()).then(|| format!("left out of the sandbox: {}", left_out.join("; ")))
}

/// Wrap a program + args as a `sandbox-exec -p <profile> <program> <args…>` argv.
/// The profile text travels inline, so no profile file exists that a stage
/// already running (with its temp dir writable) could overwrite before this
/// one starts. Pure — returns the new program and full arg vector.
fn sandbox_argv(program: &OsStr, args: &[String], profile: &str) -> (OsString, Vec<OsString>) {
    let mut wrapped: Vec<OsString> = Vec::with_capacity(args.len() + 3);
    wrapped.push(OsString::from("-p"));
    wrapped.push(OsString::from(profile));
    wrapped.push(program.to_os_string());
    for a in args {
        wrapped.push(OsString::from(a));
    }
    (OsString::from(SANDBOX_EXEC), wrapped)
}

/// The wrapped command ready to spawn, plus the env that points its build
/// caches at the stage's own cache root (empty when none was asked for) and,
/// for a stage that asked for one, `TMPDIR` at its own temp dir.
pub struct Prepared {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub env: Vec<(String, String)>,
    /// Why each system root or state file was left out of the profile (see
    /// [`left_out_label`]).
    pub left_out: Vec<String>,
}

/// Make `dir` owner-only (0700), refusing unless it is a real directory (not a
/// symlink) owned by this user. The checks and the chmod go through one
/// `O_NOFOLLOW` handle, so a link swapped in at any point fails the open and
/// the app never chmods wherever a link points.
#[cfg(unix)]
fn own_dir_0700(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    open_own_dir(dir)?.set_permissions(std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn own_dir_0700(dir: &Path) -> std::io::Result<()> {
    check_own_dir(dir)
}

/// Open `dir` through an `O_NOFOLLOW` handle, refusing unless it is a real
/// directory (not a symlink) owned by this user.
#[cfg(unix)]
fn open_own_dir(dir: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let refuse = |why: String| std::io::Error::other(format!("{} must be a directory you own ({why})", dir.display()));
    let handle = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(dir)
        .map_err(|e| refuse(e.to_string()))?;
    let meta = handle.metadata()?;
    // SAFETY: `getuid` has no preconditions and can't fail.
    let uid = unsafe { libc::getuid() };
    if !meta.is_dir() || meta.uid() != uid {
        return Err(refuse(format!("owner uid {}", meta.uid())));
    }
    Ok(handle)
}

/// `own_dir_0700`'s checks without the chmod.
#[cfg(unix)]
fn check_own_dir(dir: &Path) -> std::io::Result<()> {
    open_own_dir(dir).map(drop)
}

#[cfg(not(unix))]
fn check_own_dir(dir: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(dir)?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(std::io::Error::other(format!("{} must be a real directory", dir.display())));
    }
    Ok(())
}

/// `create_dir`, not `create_dir_all`: it never follows a link in `dir`'s
/// place; an existing entry is left for `own_dir_0700` to check.
fn create_dir_once(dir: &Path) -> std::io::Result<()> {
    match std::fs::create_dir(dir) {
        Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => Err(e),
        _ => Ok(()),
    }
}

/// [`create_dir_once`], but a dir it creates starts out owner-only (0700), so
/// there is no moment it is open to others.
#[cfg(unix)]
fn create_dir_0700(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => Err(e),
        _ => Ok(()),
    }
}

#[cfg(not(unix))]
fn create_dir_0700(dir: &Path) -> std::io::Result<()> {
    create_dir_once(dir)
}

/// Mark `dir` as just used (its mtime), so `prune_build_caches` keeps it.
/// Best-effort, and never through a link.
#[cfg(unix)]
fn touch_dir(dir: &Path) {
    use std::os::unix::fs::OpenOptionsExt;
    if let Ok(handle) = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(dir)
    {
        let _ = handle.set_modified(std::time::SystemTime::now());
    }
}

#[cfg(not(unix))]
fn touch_dir(_dir: &Path) {}

/// Create the cache root `root` (`<base>/<workspace>/<key>`) and return it as
/// `<realpath of base>/<workspace>/<key>`. Fails closed when the base, the
/// workspace dir or the root is a symlink, not a directory, or not owned by
/// this user: a stage can write inside its root, and a root it replaced with
/// a link must never get chmodded or put in the next profile. All three end
/// up 0700; the workspace dir and the root are marked as just used.
fn ensure_cache_root(root: &Path) -> std::io::Result<PathBuf> {
    let not_a_root = || std::io::Error::other(format!("{} is not a cache root", root.display()));
    let ws_dir = root.parent().ok_or_else(not_a_root)?;
    let (Some(base), Some(ws), Some(key)) = (ws_dir.parent(), ws_dir.file_name(), root.file_name()) else {
        return Err(not_a_root());
    };
    std::fs::create_dir_all(base)?;
    own_dir_0700(base)?;
    let ws_dir = std::fs::canonicalize(base)?.join(ws);
    create_dir_once(&ws_dir)?;
    own_dir_0700(&ws_dir)?;
    let root = ws_dir.join(key);
    create_dir_once(&root)?;
    own_dir_0700(&root)?;
    touch_dir(&ws_dir);
    touch_dir(&root);
    Ok(root)
}

/// Create the temp dir `dir` (`<tmp base>/<key>`, `stage_tmp_dir`) and return
/// it as `<realpath of tmp base>/<key>`. Same checks as `ensure_cache_root`:
/// fails closed when the base or the dir is a symlink, not a directory, or
/// not owned by this user; both end up 0700 and the dir is marked as just
/// used.
fn ensure_stage_tmp(dir: &Path) -> std::io::Result<PathBuf> {
    let not_a_tmp = || std::io::Error::other(format!("{} is not a stage temp dir", dir.display()));
    let (Some(base), Some(key)) = (dir.parent(), dir.file_name()) else {
        return Err(not_a_tmp());
    };
    std::fs::create_dir_all(base)?;
    own_dir_0700(base)?;
    let dir = std::fs::canonicalize(base)?.join(key);
    create_dir_once(&dir)?;
    own_dir_0700(&dir)?;
    touch_dir(&dir);
    Ok(dir)
}

/// The dirs a sandboxed launch writes besides its write roots: the build-cache
/// root (with a `cache_scope`) and, when asked for, the stage's own temp dir.
/// Both are realpaths the `ensure_*` checks passed.
#[derive(Debug, Default)]
struct StageDirs {
    cache_root: Option<String>,
    tmp: Option<String>,
}

impl StageDirs {
    /// Create the dirs for `write_roots` and `tenant` on the workspace
    /// `cache_scope` (the paths `stage_dir_paths` gives); the temp dir only
    /// with `private_tmp` (and a cache root to key it by).
    /// Errors, so the launch fails closed, when one can't be made or isn't a
    /// real directory of the user's.
    fn make(
        write_roots: &[String],
        cache_scope: Option<&str>,
        tenant: CacheTenant,
        private_tmp: bool,
    ) -> AppResult<StageDirs> {
        let Some(scope) = cache_scope else { return Ok(StageDirs::default()) };
        let base = build_cache_base()
            .ok_or_else(|| AppError::Other("the sandbox found no cache directory for builds".into()))?;
        let no_tmp = || AppError::Other("the sandbox found no directory for the stage's temp files".into());
        let tmp_base = match private_tmp {
            true => stage_tmp_base().ok_or_else(no_tmp)?,
            false => PathBuf::new(),
        };
        let (root, tmp) = stage_dir_paths(&base, &tmp_base, scope, write_roots, tenant, private_tmp);
        let root = ensure_cache_root(&root)
            .map_err(|e| AppError::Other(format!("could not set up the sandbox build cache: {e}")))?;
        let tmp = match (private_tmp, tmp) {
            (false, _) => None,
            (true, None) => return Err(no_tmp()),
            (true, Some(dir)) => {
                let dir = ensure_stage_tmp(&dir)
                    .map_err(|e| AppError::Other(format!("could not set up the stage's temp dir: {e}")))?;
                Some(dir.to_string_lossy().into_owned())
            }
        };
        Ok(StageDirs { cache_root: Some(root.to_string_lossy().into_owned()), tmp })
    }

    /// The dirs themselves, cache root first: writable in the profile, and the
    /// ones a read-confined stage names with `--add-dir`.
    fn dirs(&self) -> Vec<String> {
        self.cache_root.iter().chain(self.tmp.iter()).cloned().collect()
    }

    /// The env pointing the launch at them: `sandbox_cache_env` for the cache
    /// root, plus `TMPDIR` for the temp dir. Pure.
    fn env(&self) -> Vec<(String, String)> {
        let mut env = self.cache_root.as_deref().map(sandbox_cache_env).unwrap_or_default();
        if let Some(t) = &self.tmp {
            env.push(("TMPDIR".into(), t.clone()));
        }
        env
    }
}

/// Prepare an in-process sandboxed launch (`chat_engine`'s `run_command`
/// and `write_file`, wrapping `bash`): verify the platform + driver, build a
/// fresh seatbelt profile, and return the wrapped argv. With `cache_scope`
/// (the workspace), the build-cache root for that workspace, these write
/// roots and [`CacheTenant::InProcess`] is created, made writable in the
/// profile, and returned as `env`; it is never a CLI stage's root. Errors (no
/// silent fallback) if sandboxing is unavailable or the cache root can't be
/// made or isn't a real directory of the user's.
pub fn prepare(
    write_roots: &[String],
    cache_scope: Option<&str>,
    program: &OsStr,
    args: &[String],
) -> AppResult<Prepared> {
    prepare_with(write_roots, cache_scope, CacheTenant::InProcess, program, args, false, |_| Vec::new())
}

/// [`prepare`] for a CLI stage, whose dirs are keyed by `tenant`
/// ([`CacheTenant::Cli`]). With `private_tmp` (and a
/// `cache_scope`), the stage also gets its own temp dir (`stage_tmp_dir`,
/// 0700, writable in the profile) and `TMPDIR` pointing at it, instead of the
/// user-wide `$TMPDIR` every app and stage shares. `extra_args` gets the
/// stage's own dirs (cache root, then temp dir; empty without a
/// `cache_scope`) and its result is appended to the wrapped program's argv:
/// a read-confined Claude stage names them with `--add-dir`, so it can read
/// the caches its builds write and its own temp files.
pub fn prepare_with(
    write_roots: &[String],
    cache_scope: Option<&str>,
    tenant: CacheTenant,
    program: &OsStr,
    args: &[String],
    private_tmp: bool,
    extra_args: impl FnOnce(&[String]) -> Vec<String>,
) -> AppResult<Prepared> {
    if !cfg!(target_os = "macos") {
        return Err(AppError::Other(
            "sandboxed execution is only available on macOS".into(),
        ));
    }
    if !Path::new(SANDBOX_EXEC).exists() {
        return Err(AppError::Other(format!(
            "the sandbox driver ({SANDBOX_EXEC}) was not found"
        )));
    }
    let stage_dirs = StageDirs::make(write_roots, cache_scope, tenant, private_tmp)?;
    let own_dirs = stage_dirs.dirs();
    let (profile, left_out) = seatbelt_profile_and_refusals(write_roots, &own_dirs)?;
    let mut args = args.to_vec();
    args.extend(extra_args(&own_dirs));
    let (prog, wrapped) = sandbox_argv(program, &args, &profile);
    Ok(Prepared { program: prog, args: wrapped, env: stage_dirs.env(), left_out })
}

/// Collapse `.`/`..` components lexically (no filesystem access, so it works for
/// paths that don't exist yet — e.g. a `write_file` target). Absolute inputs
/// stay absolute; `..` can't climb above root.
fn normalize_lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Whether an in-process `write_file` target is permitted for a sandboxed
/// mission: the lexically-normalized absolute path must sit under one of the
/// mission's write roots. Catches absolute-path and `..` escapes; a symlink
/// escape would first need `run_command`, which is itself sandboxed.
pub fn is_write_allowed(target: &Path, write_roots: &[String]) -> bool {
    let normalized = normalize_lexical(target);
    write_roots.iter().any(|r| {
        let root = normalize_lexical(Path::new(r));
        normalized.starts_with(&root)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A read-confined Claude stage's tenant (a `sandbox` mission).
    const RC: CacheTenant<'static> = CacheTenant::Cli { exec_choice: "sandbox", reads_confined: true };

    #[test]
    fn sbpl_string_escapes_quotes_and_backslashes() {
        assert_eq!(sbpl_string("/a/b"), "\"/a/b\"");
        assert_eq!(sbpl_string("/a \"x\""), "\"/a \\\"x\\\"\"");
        assert_eq!(sbpl_string("/a\\b"), "\"/a\\\\b\"");
    }

    #[test]
    fn render_profile_confines_writes_but_allows_default() {
        let p = render_profile(&WriteRules {
            subpaths: vec!["/ws".to_string(), "/tmp".to_string()],
            literals: vec!["/home/u/.claude.json".to_string()],
            ..WriteRules::default()
        });
        assert!(p.contains("(version 1)"));
        assert!(p.contains("(allow default)"));
        assert!(p.contains("(deny file-write*)"));
        assert!(p.contains("(subpath \"/ws\")"));
        assert!(p.contains("(subpath \"/tmp\")"));
        // Individual files use `literal`, not `subpath`.
        assert!(p.contains("(literal \"/home/u/.claude.json\")"));
        // The deny must precede the write-allow so the re-allow wins.
        assert!(p.find("(deny file-write*)").unwrap() < p.find("(allow file-write*").unwrap());
        // No git rules → no trailing deny block.
        assert!(!p.contains("(deny file-write*\n"));
    }

    #[test]
    fn render_profile_allows_hard_links_only_under_the_write_roots() {
        let mut rules = WriteRules {
            subpaths: vec!["/ws".to_string(), "/tmp".to_string()],
            literals: vec!["/home/u/.claude.json".to_string()],
            ..WriteRules::default()
        };
        rules.extend(git_write_rules("/ws", &main_layout(), &[]));
        let p = render_profile(&rules);
        // Hard links are denied everywhere first, ahead of every allow.
        let deny_all = p.find("(deny file-link)\n").expect("a global file-link deny");
        let allow_write = p.find("(allow file-write*\n").unwrap();
        let allow_link = p.find("(allow file-link\n").expect("a file-link allow");
        assert!(deny_all < allow_write && deny_all < allow_link);
        // Then re-allowed under each subtree root, never for a single-file grant.
        let end = allow_link + p[allow_link..].find(")\n)\n").unwrap() + 2;
        let block = &p[allow_link..end];
        for root in &rules.subpaths {
            assert!(block.contains(&format!("(subpath {})", sbpl_string(root))), "{root} allows links");
        }
        assert!(!block.contains("(literal "), "a single writable file can't be linked");
        assert!(!block.contains("(regex "));
        // The trailing per-path denies still come after the allow and win.
        let deny_link = p.rfind("(deny file-link\n").expect("a trailing file-link deny");
        assert!(allow_link < deny_link);
        assert!(p[deny_link..].contains("(literal \"/ws/.git/config\")"));
        assert!(p[deny_link..].contains("(subpath \"/ws/.git/hooks\")"));
        // Nothing grants hard links unconditionally.
        assert!(!p.contains("(allow file-link)"));
        // With no write roots there is no allow at all, so the deny stands.
        let empty = render_profile(&WriteRules::default());
        assert!(empty.contains("(deny file-link)\n"));
        assert!(!empty.contains("(allow file-link"));
        assert!(!empty.contains("(allow file-write*"));
    }

    fn main_layout() -> GitLayout {
        GitLayout {
            git_dir: "/ws/.git".into(),
            common_dir: "/ws/.git".into(),
            hooks_dir: "/ws/.git/hooks".into(),
        }
    }

    fn linked_layout() -> GitLayout {
        GitLayout {
            git_dir: "/repo/.git/worktrees/wt".into(),
            common_dir: "/repo/.git".into(),
            hooks_dir: "/repo/.git/hooks".into(),
        }
    }

    /// Whether any of the rules' deny regexes matches `path` (SBPL regexes are
    /// POSIX ERE; the subset we emit means the same in the `regex` crate).
    fn regex_denies(r: &WriteRules, path: &str) -> bool {
        r.deny_regexes.iter().any(|re| regex::Regex::new(re).unwrap().is_match(path))
    }

    #[test]
    fn regex_escape_quotes_metacharacters() {
        assert_eq!(regex_escape("/a.b/c+d(e)"), "/a\\.b/c\\+d\\(e\\)");
        let re = regex::Regex::new(&format!("^{}$", regex_escape("/x[1]/y.z"))).unwrap();
        assert!(re.is_match("/x[1]/y.z"));
        assert!(!re.is_match("/x1/yaz"));
    }

    #[test]
    fn git_rules_deny_every_worktrees_pointers_not_just_the_own() {
        // From a main checkout, a sibling worktree's commondir sits inside the
        // workspace subtree; repointing it would plant config for that worktree.
        let r = git_write_rules("/ws", &main_layout(), &[]);
        for d in [
            "/ws/.git/worktrees/sib/commondir",
            "/ws/.git/worktrees/sib/gitdir",
            "/ws/.git/worktrees/sib/config.worktree",
            "/ws/.git/worktrees/sib/config.worktree.lock",
        ] {
            assert!(regex_denies(&r, d), "{d} must be denied");
        }
        // The sibling's index/HEAD aren't code; git may still touch them.
        assert!(!regex_denies(&r, "/ws/.git/worktrees/sib/HEAD"));
        assert!(!regex_denies(&r, "/ws/.git/worktrees/sib/commondir2"));
        let l = git_write_rules("/wt", &linked_layout(), &[]);
        assert!(regex_denies(&l, "/repo/.git/worktrees/other/commondir"));
        assert!(regex_denies(&l, "/repo/.git/worktrees/wt/gitdir"));
    }

    #[test]
    fn git_rules_deny_renaming_worktrees_or_a_worktree_dir() {
        // Seatbelt checks a rename against its source and destination only, so
        // the parents of the pointer denies must be pinned as paths too.
        let r = git_write_rules("/ws", &main_layout(), &[]);
        assert!(r.deny_literals.contains(&"/ws/.git/worktrees".to_string()));
        assert!(r.deny_regexes.contains(&"^/ws/\\.git/worktrees/[^/]+$".to_string()));
        for d in ["/ws/.git/worktrees/wt", "/ws/.git/worktrees/wt-old"] {
            assert!(regex_denies(&r, d), "{d} must be denied");
        }
        let l = git_write_rules("/wt", &linked_layout(), &[]);
        assert!(l.deny_literals.contains(&"/repo/.git/worktrees".to_string()));
        assert!(regex_denies(&l, "/repo/.git/worktrees/wt"));
        // Writes inside the own linked git dir stay allowed.
        for ok in ["/repo/.git/worktrees/wt/index", "/repo/.git/worktrees/wt/HEAD", "/repo/.git/worktrees/wt/index.lock"] {
            assert!(!regex_denies(&l, ok), "{ok} must stay writable");
            assert!(!l.deny_literals.contains(&ok.to_string()));
        }
    }

    #[test]
    fn git_rules_deny_submodule_git_dirs_and_nested_dot_git() {
        let r = git_write_rules("/ws", &main_layout(), &[]);
        assert!(r.deny_subpaths.contains(&"/ws/.git/modules".to_string()));
        let l = git_write_rules("/wt", &linked_layout(), &[]);
        // A linked worktree's submodules live under its own git dir.
        assert!(l.deny_subpaths.contains(&"/repo/.git/modules".to_string()));
        assert!(l.deny_subpaths.contains(&"/repo/.git/worktrees/wt/modules".to_string()));
        // From a main checkout, a sibling worktree's submodule git dirs.
        for d in [
            "/ws/.git/worktrees/sib/modules",
            "/ws/.git/worktrees/sib/modules/m/config",
            "/ws/.git/worktrees/sib/modules/m/hooks/pre-commit",
        ] {
            assert!(regex_denies(&r, d), "{d} must be denied");
        }
        assert!(regex_denies(&l, "/repo/.git/worktrees/other/modules/m/config"));
        assert!(!regex_denies(&r, "/ws/.git/worktrees/sib/modules2"));
        assert!(!regex_denies(&r, "/ws/.git/worktrees/sib/index"));
        // A submodule's `.git` pointer (or an embedded `.git` dir) in the tree.
        for d in ["/wt/sub/.git", "/wt/a/b/.git/hooks/pre-commit", "/wt/a/.git/config"] {
            assert!(regex_denies(&l, d), "{d} must be denied");
        }
        for ok in ["/wt/.github/workflows/ci.yml", "/wt/src/.gitignore", "/wt/a/.gitkeep"] {
            assert!(!regex_denies(&l, ok), "{ok} must stay writable");
        }
    }

    #[test]
    fn git_rules_deny_a_configured_hooks_path_inside_the_workspace() {
        // Husky v9: core.hooksPath=.husky/_ (gitignored, so invisible in a diff).
        let layout = GitLayout { hooks_dir: "/wt/.husky/_".into(), ..linked_layout() };
        let r = git_write_rules("/wt", &layout, &[]);
        assert!(r.deny_subpaths.contains(&"/wt/.husky/_".to_string()));
        // The default hooks dir stays denied too.
        assert!(r.deny_subpaths.contains(&"/repo/.git/hooks".to_string()));
        // `.husky` can't be swapped for a symlink to an unprotected dir...
        assert!(r.deny_literals.contains(&"/wt/.husky".to_string()));
        // ...but the workspace root itself isn't frozen.
        assert!(!r.deny_literals.contains(&"/wt".to_string()));
        assert_eq!(ancestors_within("/wt", "/wt/a/b/hooks"), vec!["/wt/a/b".to_string(), "/wt/a".to_string()]);
        assert!(ancestors_within("/wt", "/elsewhere/hooks").is_empty());
    }

    #[test]
    fn git_rules_deny_a_hooks_path_parents_inside_any_writable_root() {
        // core.hooksPath pointed into $TMPDIR or ~/.cache: its parents there are
        // writable too, so they must be pinned like the workspace's.
        let roots = vec!["/private/tmp".to_string(), "/home/u/.cache/".to_string(), "/wt".to_string()];
        let layout = GitLayout { hooks_dir: "/private/tmp/shared/git/hooks".into(), ..linked_layout() };
        let r = git_write_rules("/wt", &layout, &roots);
        assert!(r.deny_subpaths.contains(&"/private/tmp/shared/git/hooks".to_string()));
        for d in ["/private/tmp/shared/git", "/private/tmp/shared"] {
            assert!(r.deny_literals.contains(&d.to_string()), "{d} must be denied");
        }
        // The allowed root itself stays usable.
        assert!(!r.deny_literals.contains(&"/private/tmp".to_string()));
        let layout = GitLayout { hooks_dir: "/home/u/.cache/hooks/x".into(), ..linked_layout() };
        let r = git_write_rules("/wt", &layout, &roots);
        assert!(r.deny_literals.contains(&"/home/u/.cache/hooks".to_string()));
        assert!(!r.deny_literals.contains(&"/home/u/.cache".to_string()));
        // A hooks dir outside every writable root needs no parent denies.
        let layout = GitLayout { hooks_dir: "/opt/hooks/x".into(), ..linked_layout() };
        let r = git_write_rules("/wt", &layout, &roots);
        assert!(!r.deny_literals.iter().any(|d| d.starts_with("/opt")));
    }

    #[test]
    fn git_rules_for_a_main_checkout_deny_hooks_config_and_info() {
        let r = git_write_rules("/ws", &main_layout(), &[]);
        // `remotes/` and `branches/` are legacy remote definitions `git fetch` still reads.
        for d in ["/ws/.git/hooks", "/ws/.git/info", "/ws/.git/remotes", "/ws/.git/branches"] {
            assert!(r.deny_subpaths.contains(&d.to_string()), "{d} must be denied");
        }
        for d in ["/ws/.git/config", "/ws/.git/config.lock", "/ws/.git/config.worktree", "/ws/.git"] {
            assert!(r.deny_literals.contains(&d.to_string()), "{d} must be denied");
        }
        // The objects/refs a commit writes stay allowed (inside the workspace anyway).
        assert!(r.subpaths.contains(&"/ws/.git/objects".to_string()));
        assert!(r.literals.contains(&"/ws/.git/packed-refs".to_string()));
    }

    #[test]
    fn git_rules_for_a_linked_worktree_allow_commits_but_not_hooks() {
        let r = git_write_rules("/wt", &linked_layout(), &[]);
        // What `git add` / `git commit` write, outside the worktree's own subtree.
        for a in ["/repo/.git/worktrees/wt", "/repo/.git/objects", "/repo/.git/refs", "/repo/.git/logs"] {
            assert!(r.subpaths.contains(&a.to_string()), "{a} must be writable");
        }
        assert!(r.literals.contains(&"/repo/.git/packed-refs".to_string()));
        assert!(r.literals.contains(&"/repo/.git/packed-refs.lock".to_string()));
        // Never the whole common dir, so config and hooks stay out of reach.
        assert!(!r.subpaths.contains(&"/repo/.git".to_string()));
        assert!(r.deny_subpaths.contains(&"/repo/.git/hooks".to_string()));
        assert!(r.deny_subpaths.contains(&"/repo/.git/info".to_string()));
        for d in [
            "/repo/.git/config",
            "/repo/.git/worktrees/wt/config.worktree",
            "/repo/.git/worktrees/wt/commondir",
            "/wt/.git",
        ] {
            assert!(r.deny_literals.contains(&d.to_string()), "{d} must be denied");
        }
    }

    #[test]
    fn render_profile_puts_git_denies_after_every_allow() {
        // SBPL: the last matching rule wins, so the denies must come last to
        // beat the workspace (and $TMPDIR) subtree allows.
        let mut rules = WriteRules { subpaths: vec!["/ws".into()], ..WriteRules::default() };
        rules.extend(git_write_rules("/ws", &main_layout(), &[]));
        let p = render_profile(&rules);
        let allow = p.find("(allow file-write*").unwrap();
        let deny = p.rfind("(deny file-write*\n").unwrap();
        assert!(allow < deny);
        let tail = &p[deny..];
        assert!(tail.contains("(subpath \"/ws/.git/hooks\")"));
        assert!(tail.contains("(literal \"/ws/.git/config\")"));
        assert!(tail.contains("(subpath \"/ws/.git/info\")"));
        assert!(tail.contains("(subpath \"/ws/.git/modules\")"));
        assert!(tail.contains("(literal \"/ws/.git/worktrees\")"));
        // Regex backslashes are doubled once more for the SBPL string literal.
        assert!(tail.contains("(regex \"^/ws/\\\\.git/worktrees/[^/]+/(commondir|"));
        assert!(tail.contains("(regex \"^/ws/\\\\.git/worktrees/[^/]+$\")"));
        // Hardlinking a protected file (to write through the link) is denied
        // for the same paths; `file-link` isn't covered by `file-write*`.
        let link = p.find("(deny file-link\n").expect("a file-link deny block");
        assert!(allow < link);
        let link_block = &p[link..];
        assert!(link_block.contains("(literal \"/ws/.git/config\")"));
        assert!(link_block.contains("(subpath \"/ws/.git/hooks\")"));
    }

    #[test]
    fn readonly_profile_has_no_git_rules() {
        // A readonly mission has no mission roots: still temp-only, no git allows.
        let p = build_seatbelt_profile(&[], &[]).unwrap();
        assert!(!p.contains("/objects\""));
        // The only trailing denies are the system root dirs themselves and
        // what Claude Code loads from `~/.claude`.
        if let Some(deny) = p.find("(deny file-write*\n") {
            for line in p[deny..].lines().filter(|l| l.contains("(subpath ") || l.contains("(regex ")) {
                assert!(line.contains("/.claude/") || line.contains("/\\\\.claude/"), "{line}");
            }
        }
        assert!(!p.contains("/.git/"));
        assert!(!p.contains("/worktrees/"));
    }

    /// Profile-free check of `resolve_system_root` with `home` as `$HOME`.
    fn root_ok(root: &Path, home: &Path, owner: Option<u32>) -> bool {
        resolve_system_root(root.to_str().unwrap(), home.to_str(), owner, &[]).is_ok()
    }

    #[test]
    #[cfg(unix)]
    fn a_system_root_resolving_to_home_or_an_ancestor_is_left_out() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(dir.path()).unwrap().join("home");
        std::fs::create_dir_all(home.join("dotfiles/claude")).unwrap();
        let uid = current_uid();
        // A real dir, a missing one and a link to a dir of the user's are granted.
        std::fs::create_dir(home.join(".cache")).unwrap();
        assert!(root_ok(&home.join(".cache"), &home, uid));
        assert_eq!(
            resolve_system_root(home.join(".missing").to_str().unwrap(), home.to_str(), uid, &[]).unwrap(),
            vec![home.join(".missing").to_string_lossy().into_owned()]
        );
        symlink(home.join("dotfiles/claude"), home.join(".claude")).unwrap();
        let granted = resolve_system_root(home.join(".claude").to_str().unwrap(), home.to_str(), uid, &[]).unwrap();
        assert!(granted.contains(&home.join(".claude").to_string_lossy().into_owned()));
        assert!(granted.contains(&home.join("dotfiles/claude").to_string_lossy().into_owned()));
        // Links to `$HOME`, each of its ancestors and `/` are not.
        let mut targets: Vec<PathBuf> = home.ancestors().map(Path::to_path_buf).collect();
        targets.push(PathBuf::from("/"));
        for (i, t) in targets.iter().enumerate() {
            let link = home.join(format!(".link-{i}"));
            symlink(t, &link).unwrap();
            assert!(!root_ok(&link, &home, uid), "a link to {} must be left out", t.display());
            assert!(!root_ok(&link, &home, None), "a link to {} must be left out unchecked too", t.display());
        }
        // Through a chain of links as well.
        symlink(home.join(".link-0"), home.join(".chain")).unwrap();
        assert!(!root_ok(&home.join(".chain"), &home, uid));
        // `/Users` (macOS's home parent) is never a root, even outside `$HOME`'s chain.
        if Path::new("/Users").is_dir() {
            symlink("/Users", home.join(".users")).unwrap();
            assert!(!root_ok(&home.join(".users"), &home, None));
        }
        // A dangling link or a link to a file is left out.
        symlink(home.join("gone"), home.join(".dangling")).unwrap();
        assert!(!root_ok(&home.join(".dangling"), &home, uid));
        std::fs::write(home.join("file"), "x").unwrap();
        symlink(home.join("file"), home.join(".to-file")).unwrap();
        assert!(!root_ok(&home.join(".to-file"), &home, uid));
    }

    #[test]
    #[cfg(unix)]
    fn a_system_root_holding_the_stage_dirs_or_in_a_guarded_home_dir_is_left_out() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(dir.path()).unwrap().join("home");
        let caches = home.join("Library/Caches");
        let private = vec![caches.join("octopush/build-cache"), caches.join("octopush/tmp")];
        for d in [".config/gh", ".ssh", "Library/LaunchAgents", "Library/Caches/octopush/tmp", "Library/Caches/other"] {
            std::fs::create_dir_all(home.join(d)).unwrap();
        }
        let uid = current_uid();
        let h = home.to_str();
        let ok = |name: &str, target: PathBuf| {
            symlink(&target, home.join(name)).unwrap();
            resolve_system_root(home.join(name).to_str().unwrap(), h, uid, &private)
        };
        // A root that is, or holds, the cache or temp base (even one not made yet).
        let holders = [home.join("Library"), caches.clone(), caches.join("octopush"), caches.join("octopush/tmp")];
        for (i, t) in holders.into_iter().enumerate() {
            let why = ok(&format!(".holds-{i}"), t.clone()).unwrap_err();
            assert!(why.contains("stage dirs"), "{}: {why}", t.display());
        }
        // A root under `~/.config`, `~/.ssh` or `~/Library` outside its Caches.
        let guarded = [home.join(".config"), home.join(".config/gh"), home.join(".ssh"), home.join("Library/LaunchAgents")];
        for (i, t) in guarded.into_iter().enumerate() {
            let why = ok(&format!(".guarded-{i}"), t.clone()).unwrap_err();
            assert!(why.contains("resolves under"), "{}: {why}", t.display());
        }
        // Another dir in `~/Library/Caches` is fine, and so is a root as given
        // without a private base to protect.
        assert!(ok(".other-cache", caches.join("other")).is_ok());
        assert!(resolve_system_root(caches.to_str().unwrap(), h, uid, &[]).is_ok());
        assert!(resolve_system_root(home.join(".ssh").to_str().unwrap(), h, uid, &[]).is_err());
        assert!(resolve_system_root(home.join("Library").to_str().unwrap(), h, uid, &[]).is_err());
        // Pure: the guarded dirs by name, with `$HOME` as given or resolved.
        let g = |p: &str| guarded_home_dir(Path::new(p), "/home/u", Path::new("/real/u"));
        assert_eq!(g("/home/u/.ssh/keys").as_deref(), Some("/home/u/.ssh"));
        assert_eq!(g("/real/u/Library/Preferences").as_deref(), Some("/home/u/Library"));
        assert_eq!(g("/real/u/Library/Caches/x"), None);
        assert_eq!(g("/home/u/.configs"), None, "a path-component prefix, not a string one");
        assert_eq!(g("/home/u/.cache"), None);
    }

    #[test]
    #[cfg(unix)]
    fn a_user_home_root_owned_by_someone_else_is_left_out() {
        use std::os::unix::fs::{symlink, MetadataExt};
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir(home.join(".cache")).unwrap();
        std::fs::create_dir(home.join("elsewhere")).unwrap();
        symlink(home.join("elsewhere"), home.join(".claude")).unwrap();
        let mine = std::fs::metadata(&home).unwrap().uid();
        // Stand in a different owner for "someone else": every entry here is ours.
        let foreign = Some(mine.wrapping_add(1));
        assert!(root_ok(&home.join(".cache"), &home, Some(mine)));
        assert!(!root_ok(&home.join(".cache"), &home, foreign));
        assert!(root_ok(&home.join(".claude"), &home, Some(mine)));
        assert!(!root_ok(&home.join(".claude"), &home, foreign));
        // A root-owned target the user's link points at (`/` aside) is foreign too.
        if mine != 0 {
            symlink("/usr", home.join(".foreign")).unwrap();
            assert!(!root_ok(&home.join(".foreign"), &home, Some(mine)));
        }
        // `assemble_write_roots` drops a refused `~/.claude` with every state
        // dir in it and says why once, keeping the other roots.
        let h = home.to_string_lossy().into_owned();
        std::fs::create_dir(home.join("elsewhere/projects")).unwrap();
        let roots = assemble_write_roots(&[], Some(&h), None, foreign, &[]);
        assert!(!roots.subpaths.iter().any(|r| r.starts_with(&format!("{h}/.c"))));
        assert!(!roots.subpaths.iter().any(|r| r.contains("/elsewhere")));
        assert_eq!(roots.refused.len(), 1, "{:?}", roots.refused);
        assert!(roots.subpaths.contains(&"/dev".to_string()));
        let roots = assemble_write_roots(&[], Some(&h), None, Some(mine), &[]);
        assert!(roots.refused.is_empty(), "{:?}", roots.refused);
        for r in [format!("{h}/.claude/projects"), format!("{h}/elsewhere/projects"), format!("{h}/.claude/todos")] {
            assert!(roots.subpaths.contains(&r), "{r} is writable");
            assert!(roots.system_roots.contains(&r), "{r} is pinned");
        }
        // Neither `~/.claude` itself (as given or resolved) nor `~/.cache`.
        for r in [format!("{h}/.claude"), format!("{h}/elsewhere"), format!("{h}/.cache")] {
            assert!(!roots.subpaths.contains(&r), "{r} is not writable");
        }
        assert_eq!(roots.claude, vec![format!("{h}/.claude"), format!("{h}/elsewhere")]);
    }

    #[test]
    #[cfg(unix)]
    fn the_state_file_is_granted_only_as_a_plain_file_of_the_users_or_a_link_into_dot_claude() {
        use std::os::unix::fs::{symlink, MetadataExt};
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(dir.path()).unwrap();
        let h = home.to_string_lossy().into_owned();
        let file = format!("{h}/.claude.json");
        let mine = std::fs::metadata(&home).unwrap().uid();
        let ok = |owner: u32| resolve_state_file(&file, &h, Some(owner));
        // Missing: granted as given, so the CLI can create it.
        assert_eq!(ok(mine).unwrap(), vec![file.clone()]);
        // A plain file of the user's.
        std::fs::write(&file, "{}").unwrap();
        assert_eq!(ok(mine).unwrap(), vec![file.clone()]);
        assert!(ok(mine.wrapping_add(1)).is_err(), "someone else's file is left out");
        // A second hard link to it is left out.
        std::fs::hard_link(&file, home.join("other-name")).unwrap();
        assert!(ok(mine).is_err());
        std::fs::remove_file(home.join("other-name")).unwrap();
        // A link into `~/.claude*` is granted, with its realpath.
        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude/state.json"), "{}").unwrap();
        symlink(home.join(".claude/state.json"), &file).unwrap();
        assert_eq!(ok(mine).unwrap(), vec![file.clone(), format!("{h}/.claude/state.json")]);
        // A link anywhere else (a sibling that only shares the `.claude`
        // prefix included), to a dir, or dangling is left out.
        std::fs::remove_file(&file).unwrap();
        std::fs::write(home.join(".zshrc"), "x").unwrap();
        std::fs::create_dir(home.join(".claude-old")).unwrap();
        std::fs::write(home.join(".claude-old/state.json"), "{}").unwrap();
        let near = home.join(".claude-old/state.json");
        for target in [home.join(".zshrc"), near, home.join(".claude"), home.join("gone"), PathBuf::from("/")] {
            symlink(&target, &file).unwrap();
            assert!(ok(mine).is_err(), "a link to {} must be left out", target.display());
            std::fs::remove_file(&file).unwrap();
        }
        // Nor a link to a file Claude Code loads from `~/.claude`, which a
        // stage could otherwise write through the granted state file.
        std::fs::create_dir_all(home.join(".claude/skills/x")).unwrap();
        for loaded in ["settings.json", "settings.local.json", "settings.prod.json", "CLAUDE.md", "skills/x/SKILL.md"] {
            let target = home.join(".claude").join(loaded);
            std::fs::write(&target, "{}").unwrap();
            symlink(&target, &file).unwrap();
            let why = ok(mine).unwrap_err();
            assert!(why.contains("Claude Code loads"), "{loaded}: {why}");
            std::fs::remove_file(&file).unwrap();
        }
        // `assemble_write_roots` records the refusal and grants no file.
        symlink(home.join(".zshrc"), &file).unwrap();
        let roots = assemble_write_roots(&[], Some(&h), None, Some(mine), &[]);
        assert!(roots.files.is_empty());
        assert!(roots.refused.iter().any(|w| w.contains(".claude.json")), "{:?}", roots.refused);
    }

    #[test]
    fn the_profile_denies_each_system_root_dir_itself_after_the_allows() {
        let home = std::env::var("HOME").ok();
        let tmpdir = std::env::var("TMPDIR").ok();
        let p = build_seatbelt_profile(&[], &[]).unwrap();
        let allow = p.find("(allow file-write*").unwrap();
        let deny = p.find("(deny file-write*\n").expect("a deny block for the system roots");
        let link = p.find("(deny file-link\n").expect("a file-link deny for the system roots");
        assert!(allow < deny && deny < link);
        let roots = assemble_write_roots(&[], home.as_deref(), tmpdir.as_deref(), current_uid(), &private_bases());
        assert!(roots.system_roots.contains(&"/dev".to_string()));
        for r in &roots.system_roots {
            let subpath = format!("(subpath {})", sbpl_string(r));
            let pin = format!("(literal {})", sbpl_string(r));
            assert!(p[allow..deny].contains(&subpath), "writes inside {r} are allowed");
            assert!(p[deny..link].contains(&pin), "{r} itself can't be removed or replaced");
            assert!(p[link..].contains(&pin), "{r} itself can't be hardlinked");
            // Every root the profile grants is pinned, as given and as its realpath.
            let real = canonical_string(Path::new(r));
            if Path::new(r).exists() {
                assert!(roots.system_roots.contains(&real), "{real} is pinned too");
            }
        }
        // The state file stays writable: it is an allow literal, not a deny.
        for f in &roots.files {
            let lit = format!("(literal {})", sbpl_string(f));
            assert!(p[allow..deny].contains(&lit));
            assert!(!p[deny..].contains(&lit), "{f} stays writable");
        }
        // Pure rendering: the root deny comes after the allows.
        let rules = WriteRules {
            subpaths: vec!["/private/tmp".into()],
            deny_literals: vec!["/private/tmp".into()],
            ..WriteRules::default()
        };
        let r = render_profile(&rules);
        assert!(r.find("(subpath \"/private/tmp\")").unwrap() < r.find("(literal \"/private/tmp\")").unwrap());
    }

    #[test]
    #[cfg(unix)]
    fn ensure_home_roots_creates_missing_roots_as_owner_only_real_dirs_and_leaves_links_alone() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir(home.join("target")).unwrap();
        symlink(home.join("target"), home.join(".cache")).unwrap();
        ensure_home_roots(home.to_str().unwrap());
        let claude = std::fs::symlink_metadata(home.join(".claude")).unwrap();
        assert!(claude.is_dir() && !claude.file_type().is_symlink(), "~/.claude was created");
        assert_eq!(claude.permissions().mode() & 0o777, 0o700, "~/.claude is owner-only");
        for name in CLAUDE_STATE_DIRS {
            let dir = std::fs::symlink_metadata(home.join(".claude").join(name)).unwrap();
            assert!(dir.is_dir() && !dir.file_type().is_symlink(), "~/.claude/{name} was created");
            assert_eq!(dir.permissions().mode() & 0o777, 0o700, "~/.claude/{name} is owner-only");
        }
        // Nothing else: what Claude Code loads is never made, and `~/.cache`
        // is no write root any more.
        assert_eq!(std::fs::read_dir(home.join(".claude")).unwrap().count(), CLAUDE_STATE_DIRS.len());
        assert!(std::fs::symlink_metadata(home.join(".cache")).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_dir(home.join("target")).unwrap().count(), 0, "nothing written through the link");
        // A `~/.claude` that links to `$HOME` gets no state dirs made in it.
        let other = tempfile::tempdir().unwrap();
        let other_home = std::fs::canonicalize(other.path()).unwrap();
        symlink(&other_home, other_home.join(".claude")).unwrap();
        ensure_home_roots(other_home.to_str().unwrap());
        assert_eq!(std::fs::read_dir(&other_home).unwrap().count(), 1, "only the link itself");
    }

    #[test]
    fn the_profile_denies_what_later_claude_code_sessions_load_from_dot_claude() {
        let forms = vec!["/home/u/.claude".to_string(), "/real/u/.claude".to_string()];
        let r = claude_deny_rules(&forms);
        for c in &forms {
            for d in ["skills", "agents", "commands", "plugins", "hooks", "local", "output-styles", "rules"] {
                assert!(r.deny_subpaths.contains(&format!("{c}/{d}")), "{c}/{d} must be denied");
            }
            for f in ["settings.json", "settings.local.json", "CLAUDE.md"] {
                assert!(r.deny_literals.contains(&format!("{c}/{f}")), "{c}/{f} must be denied");
            }
            for d in ["settings.json", "settings.local.json", "settings.work.json", "projects/-ws/memory", "projects/-ws/memory/MEMORY.md"] {
                assert!(regex_denies(&r, &format!("{c}/{d}")), "{c}/{d} must be denied");
                assert!(in_claude_denied(Path::new(&format!("{c}/{d}")), &forms), "{c}/{d}");
            }
            // What a stage writes stays allowed.
            for ok in ["projects/-ws/abc.jsonl", "projects/-ws/abc/subagents/x.jsonl", "todos/x.json", "settings.json.d", "statsig/x"] {
                assert!(!regex_denies(&r, &format!("{c}/{ok}")), "{c}/{ok} must stay writable");
                assert!(!in_claude_denied(Path::new(&format!("{c}/{ok}")), &forms), "{c}/{ok}");
            }
        }
        for d in ["/home/u/.claude/skills/x/SKILL.md", "/real/u/.claude/agents/a.md", "/home/u/.claude/CLAUDE.md"] {
            assert!(in_claude_denied(Path::new(d), &forms), "{d}");
        }
        for ok in ["/home/u/.claude", "/home/u/.claude-old/skills", "/home/u/skills", "/home/u/.claude/projects"] {
            assert!(!in_claude_denied(Path::new(ok), &forms), "{ok}");
        }
        // Rendered after every allow, so they beat a state dir that leads there.
        let mut rules = WriteRules { subpaths: vec!["/home/u/.claude/projects".into()], ..WriteRules::default() };
        rules.extend(claude_deny_rules(&forms));
        let p = render_profile(&rules);
        let allow = p.find("(allow file-write*").unwrap();
        for op in ["(deny file-write*\n", "(deny file-link\n"] {
            let deny = p.rfind(op).unwrap();
            assert!(allow < deny);
            assert!(p[deny..].contains("(subpath \"/home/u/.claude/skills\")"));
            assert!(p[deny..].contains("(literal \"/home/u/.claude/settings.json\")"));
        }
    }

    #[test]
    #[cfg(unix)]
    fn a_claude_state_dir_resolving_to_the_config_or_into_what_it_loads_is_left_out() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(dir.path()).unwrap();
        let h = home.to_string_lossy().into_owned();
        let claude = home.join(".claude");
        std::fs::create_dir_all(claude.join("skills")).unwrap();
        std::fs::create_dir_all(home.join("sync/projects")).unwrap();
        let uid = current_uid();
        let forms = claude_forms(&h);
        let state = |name: &str| resolve_claude_state_dir(&format!("{h}/.claude/{name}"), Some(&h), uid, &[], &forms);
        // A real dir, a missing one and a link to a dir elsewhere of the user's.
        std::fs::create_dir(claude.join("todos")).unwrap();
        assert!(state("todos").is_ok());
        assert!(state("plans").is_ok());
        symlink(home.join("sync/projects"), claude.join("projects")).unwrap();
        assert!(state("projects").unwrap().contains(&format!("{h}/sync/projects")));
        // A link to `~/.claude` itself, into what it loads, or to `$HOME`.
        for (name, target) in [("debug", claude.clone()), ("statsig", claude.join("skills")), ("tasks", home.clone())] {
            symlink(&target, claude.join(name)).unwrap();
            assert!(state(name).is_err(), "{name} → {} must be left out", target.display());
        }
        let roots = assemble_write_roots(&[], Some(&h), None, uid, &[]);
        assert_eq!(roots.refused.len(), 3, "{:?}", roots.refused);
        assert!(!roots.subpaths.iter().any(|r| r == &h || r.ends_with("/.claude") || r.ends_with("/skills")));
        assert!(roots.subpaths.contains(&format!("{h}/.claude/todos")));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn seatbelt_keeps_user_level_claude_config_out_of_a_stages_reach() {
        // A stand-in `$HOME` with a user's real-looking `~/.claude`, so the
        // test never risks the machine's own settings.
        let dir = tempfile::tempdir().unwrap();
        let home = canonical_string(dir.path());
        let claude = format!("{home}/.claude");
        std::fs::create_dir(&claude).unwrap();
        std::fs::create_dir(format!("{claude}/skills")).unwrap();
        std::fs::write(format!("{claude}/settings.json"), "{}\n").unwrap();
        ensure_home_roots(&home);
        let ws = tempfile::tempdir().unwrap();
        let ws = canonical_string(ws.path());
        let roots = assemble_write_roots(std::slice::from_ref(&ws), Some(&home), None, current_uid(), &private_bases());
        assert!(roots.refused.is_empty(), "{:?}", roots.refused);
        let (profile, _) = profile_from_roots(roots, std::slice::from_ref(&ws), &[]).unwrap();
        let sandboxed = |script: String| -> bool {
            let (prog, args) = sandbox_argv(OsStr::new("bash"), &["-c".to_string(), script], &profile);
            std::process::Command::new(prog)
                .args(args)
                .current_dir(&ws)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        // What a stage writes: transcripts, todos, the shell snapshot, the state file.
        for ok in [
            format!("mkdir -p '{claude}/projects/-ws' && echo x > '{claude}/projects/-ws/s.jsonl.tmp' && mv '{claude}/projects/-ws/s.jsonl.tmp' '{claude}/projects/-ws/s.jsonl'"),
            format!("echo '[]' > '{claude}/todos/t.json'"),
            format!("echo x > '{claude}/shell-snapshots/snapshot-bash.sh'"),
            format!("echo '{{}}' > '{home}/.claude.json'"),
        ] {
            assert!(sandboxed(ok.clone()), "{ok} works");
        }
        // A user-level skill, agent, command, plugin, hook script or `CLAUDE.md`.
        for (what, script) in [
            ("a skill", format!("mkdir -p '{claude}/skills/x' && echo x > '{claude}/skills/x/SKILL.md'")),
            ("a skill in a new skills dir", format!("rmdir '{claude}/skills'; mkdir -p '{claude}/skills/y'")),
            ("an agent", format!("mkdir -p '{claude}/agents' && echo x > '{claude}/agents/a.md'")),
            ("a command", format!("mkdir -p '{claude}/commands' && echo x > '{claude}/commands/c.md'")),
            ("a plugin", format!("mkdir -p '{claude}/plugins/p'")),
            ("a hook script", format!("mkdir -p '{claude}/hooks' && echo x > '{claude}/hooks/h.sh'")),
            ("CLAUDE.md", format!("echo x > '{claude}/CLAUDE.md'")),
            ("a local claude binary", format!("mkdir -p '{claude}/local' && echo x > '{claude}/local/claude'")),
            ("project memory", format!("mkdir -p '{claude}/projects/-ws/memory' && echo x > '{claude}/projects/-ws/memory/MEMORY.md'")),
        ] {
            assert!(!sandboxed(script), "a stage can't plant {what}");
        }
        for gone in ["skills/x", "skills/y", "agents", "commands", "plugins", "hooks", "CLAUDE.md", "local", "projects/-ws/memory"] {
            assert!(std::fs::symlink_metadata(format!("{claude}/{gone}")).is_err(), "{gone} was created");
        }
        assert!(Path::new(&format!("{claude}/skills")).is_dir(), "the skills dir is still there");
        // A hook in the settings: appended, replaced by an atomic rename, a
        // new `settings.local.json`, or written through a link from a state dir.
        let hook = r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch /tmp/pwned"}]}]}}"#;
        for (what, script) in [
            ("modify settings.json", format!("echo '{hook}' >> '{claude}/settings.json'")),
            ("replace settings.json", format!("echo '{hook}' > '{claude}/projects/s' && mv '{claude}/projects/s' '{claude}/settings.json'")),
            ("add settings.local.json", format!("echo '{hook}' > '{claude}/settings.local.json'")),
            ("write through a link", format!("ln -s ../settings.json '{claude}/todos/s' && echo '{hook}' > '{claude}/todos/s'")),
            ("hard-link settings.json in", format!("ln '{claude}/settings.json' '{claude}/todos/h' && echo '{hook}' >> '{claude}/todos/h'")),
        ] {
            assert!(!sandboxed(script), "a stage can't {what}");
        }
        assert_eq!(std::fs::read_to_string(format!("{claude}/settings.json")).unwrap(), "{}\n", "settings unchanged");
        assert!(!Path::new(&format!("{claude}/settings.local.json")).exists());
        // Nor swap a state dir for a link into what Claude Code loads.
        assert!(!sandboxed(format!("mv '{claude}/plans' '{claude}/plans.old'; rmdir '{claude}/plans'; ln -s skills '{claude}/plans'")));
        let plans = std::fs::symlink_metadata(format!("{claude}/plans")).unwrap();
        assert!(plans.is_dir() && !plans.file_type().is_symlink(), "plans is still a real dir");
        // And the shared `~/.cache` is no write root any more.
        assert!(!sandboxed(format!("mkdir -p '{home}/.cache/pre-commit'")));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn a_real_claude_p_stage_runs_the_same_under_the_narrowed_profile() {
        // The real `claude` on the real `$HOME`, as a stage runs it. A model
        // that doesn't exist fails before any tokens are spent, after the CLI
        // has started up, read its config and written its state. Skipped
        // where Claude Code isn't installed.
        let installed = std::process::Command::new("claude")
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success());
        if !installed {
            eprintln!("claude not installed; skipping");
            return;
        }
        let ws = tempfile::tempdir().unwrap();
        let ws_path = canonical_string(ws.path());
        let args: Vec<String> = [
            "-p",
            "Reply with exactly: ok",
            "--output-format",
            "stream-json",
            "--verbose",
            "--model",
            "claude-nonexistent-model-0",
            "--max-turns",
            "1",
            "--strict-mcp-config",
            "--setting-sources",
            "project",
        ]
        .map(String::from)
        .to_vec();
        fn run(program: &OsStr, args: &[OsString], env: &[(String, String)], cwd: &str) -> (Option<i32>, String) {
            let mut child = std::process::Command::new(program)
                .args(args)
                .envs(env.iter().cloned())
                .current_dir(cwd)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            let start = std::time::Instant::now();
            while child.try_wait().unwrap().is_none() {
                if start.elapsed() > std::time::Duration::from_secs(120) {
                    let _ = child.kill();
                    panic!("claude -p didn't finish in 120s");
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            let out = child.wait_with_output().unwrap();
            let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
            (out.status.code(), text)
        }
        let plain: Vec<OsString> = args.iter().map(OsString::from).collect();
        let (want, plain_text) = run(OsStr::new("claude"), &plain, &[], &ws_path);
        let roots = vec![ws_path.clone()];
        let scope = format!("{ws_path}-real-claude-test");
        let prepared = prepare_with(&roots, Some(scope.as_str()), RC, OsStr::new("claude"), &args, true, |_| Vec::new()).unwrap();
        let (got, text) = run(&prepared.program, &prepared.args, &prepared.env, &ws_path);
        let _ = remove_workspace_build_caches(&scope);
        assert!(prepared.left_out.is_empty(), "{:?}", prepared.left_out);
        assert!(!text.contains("EPERM") && !text.contains("operation not permitted"), "a write was refused:\n{text}");
        let result = "\"type\":\"result\"";
        assert_eq!(text.contains(result), plain_text.contains(result), "the stage reports a result as unsandboxed:\n{text}");
        assert_eq!(got, want, "the same exit as unsandboxed:\n{text}");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn seatbelt_keeps_a_system_root_writable_inside_but_not_replaceable() {
        // `$TMPDIR` and `/private/tmp` are system roots on every Mac; the
        // `~/.claude` state dirs are created by the profile builder when missing.
        let ws = tempfile::tempdir().unwrap();
        let roots = vec![ws.path().to_string_lossy().into_owned()];
        let run = |script: &str| -> bool {
            let args = vec!["-c".to_string(), script.to_string()];
            let prepared = prepare(&roots, None, OsStr::new("bash"), &args).unwrap();
            std::process::Command::new(&prepared.program)
                .args(&prepared.args)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        let home = std::env::var("HOME").unwrap();
        let projects = format!("{home}/.claude/projects");
        let tmpdir = canonical_string(Path::new(&std::env::var("TMPDIR").unwrap()));
        let tag = format!("octopush-root-test-{}", std::process::id());
        // Writes and the atomic write-then-rename editors and the CLI use work
        // inside each real root. (Renaming a real root itself is left to the
        // root below: their parents aren't writable anyway, so it would prove
        // nothing about the pin.)
        for root in ["/private/tmp".to_string(), tmpdir, projects] {
            let inside = format!("{root}/{tag}");
            let script = format!("mkdir -p '{inside}' && echo x > '{inside}/probe.tmp' && mv '{inside}/probe.tmp' '{inside}/probe'");
            assert!(run(&script), "writes and renames inside {root} work");
            assert!(Path::new(&inside).join("probe").exists() && !Path::new(&inside).join("probe.tmp").exists());
            let _ = std::fs::remove_dir_all(&inside);
        }
        assert!(run("echo x > /dev/null"), "/dev/null stays writable");
        // An empty root can't be removed or renamed, and its parent can still
        // hold other entries: the same rules, on a root whose parent is writable.
        let parent = tempfile::tempdir().unwrap();
        let root = canonical_string(&parent.path().join("root"));
        std::fs::create_dir(&root).unwrap();
        let profile = render_profile(&WriteRules {
            subpaths: vec![canonical_string(parent.path())],
            deny_literals: vec![root.clone()],
            ..WriteRules::default()
        });
        let sandboxed = |script: String| -> bool {
            let (prog, args) = sandbox_argv(OsStr::new("bash"), &["-c".to_string(), script], &profile);
            std::process::Command::new(prog).args(args).output().map(|o| o.status.success()).unwrap_or(false)
        };
        assert!(sandboxed(format!("echo x > '{root}/probe' && rm '{root}/probe'")), "the root's contents stay writable");
        assert!(!sandboxed(format!("rmdir '{root}'")), "the empty root can't be removed");
        assert!(!sandboxed(format!("mv '{root}' '{root}.moved'")), "the root can't be renamed");
        assert!(!sandboxed(format!("rmdir '{root}'; ln -s / '{root}'")), "the root can't be replaced by a link");
        let meta = std::fs::symlink_metadata(&root).unwrap();
        assert!(meta.is_dir() && !meta.file_type().is_symlink());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn seatbelt_allows_hard_links_only_to_files_inside_the_write_roots() {
        // A root and a file beside it, outside every root of the profile.
        let parent = tempfile::tempdir().unwrap();
        let root = canonical_string(&parent.path().join("root"));
        std::fs::create_dir(&root).unwrap();
        let outside = canonical_string(&parent.path().join("outside.txt"));
        std::fs::write(&outside, "original\n").unwrap();
        let profile = render_profile(&WriteRules { subpaths: vec![root.clone()], ..WriteRules::default() });
        let sandboxed = |script: String| -> bool {
            let (prog, args) = sandbox_argv(OsStr::new("bash"), &["-c".to_string(), script], &profile);
            std::process::Command::new(prog)
                .args(args)
                .current_dir(&root)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        // A hard link to the outside file is refused, or at least can't be
        // written through.
        let linked = sandboxed(format!("ln '{outside}' '{root}/x'"));
        let _ = sandboxed(format!("test -f '{root}/x' && echo changed >> '{root}/x'"));
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "original\n", "the outside file is unchanged");
        assert!(!linked, "no hard link to a file outside the roots");
        assert!(!Path::new(&root).join("x").exists());
        // Links whose source is inside the root work, and so do symlinks.
        assert!(sandboxed(format!("echo a > '{root}/a' && ln '{root}/a' '{root}/b' && echo b >> '{root}/b'")));
        assert_eq!(std::fs::read_to_string(Path::new(&root).join("a")).unwrap(), "a\nb\n");
        assert!(sandboxed(format!("mkdir -p '{root}/d' && ln '{root}/a' '{root}/d/c'")), "into a subdir too");
        assert!(sandboxed(format!("ln -s '{outside}' '{root}/s' && ln -s a '{root}/t'")), "symlinks are writes, not links");
        // A link can't be placed outside the root either.
        assert!(!sandboxed(format!("ln '{root}/a' '{}/escaped'", canonical_string(parent.path()))));

        // The full profile, with git: commits and repacks (which hard-link
        // objects) still work in a main checkout and a linked worktree.
        let Some((dir, main, wt)) = repo_with_worktree() else {
            eprintln!("git unavailable; skipping the git half");
            return;
        };
        let run = |ws: &Path, script: &str| -> bool {
            let roots = vec![ws.to_string_lossy().into_owned()];
            let args = vec!["-c".to_string(), script.to_string()];
            let prepared = prepare(&roots, None, OsStr::new("bash"), &args).unwrap();
            std::process::Command::new(&prepared.program)
                .args(&prepared.args)
                .current_dir(ws)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        for ws in [&main, &wt] {
            let commit = "echo x >> note.txt && git add note.txt && git -c user.name=t -c user.email=t@example.com commit -qm note";
            assert!(run(ws, commit), "git commit works in {}", ws.display());
            assert!(run(ws, "git repack -adq"), "git repack works in {}", ws.display());
            assert!(run(ws, "ln note.txt note-link && rm note-link"), "a hard link inside the workspace works");
        }
        assert!(run(&main, "git gc -q"), "git gc works in a main checkout");
        drop(dir);
        // The temp dirs sit under $TMPDIR, a write root of the full profile, so
        // the outside file for it goes under $HOME.
        let Ok(home) = std::env::var("HOME") else { return };
        let away = tempfile::tempdir_in(&home).unwrap();
        let away_file = canonical_string(&away.path().join("outside.txt"));
        std::fs::write(&away_file, "original\n").unwrap();
        let ws = tempfile::tempdir().unwrap();
        let ws = PathBuf::from(canonical_string(ws.path()));
        let linked = run(&ws, &format!("ln '{away_file}' x"));
        let _ = run(&ws, "test -f x && echo changed >> x");
        assert_eq!(std::fs::read_to_string(&away_file).unwrap(), "original\n", "the outside file is unchanged");
        assert!(!linked, "the full profile refuses a hard link to a file outside the roots");
    }

    #[test]
    fn implausible_git_layouts_are_rejected() {
        assert!(is_plausible_layout("/ws", &main_layout()));
        assert!(is_plausible_layout("/wt", &linked_layout()));
        // A `.git` file pointed at $HOME must not make $HOME writable.
        let home = GitLayout { git_dir: "/Users/u".into(), common_dir: "/Users/u".into(), ..main_layout() };
        assert!(!is_plausible_layout("/wt", &home));
        let stray = GitLayout { git_dir: "/Users/u/x".into(), ..linked_layout() };
        assert!(!is_plausible_layout("/wt", &stray));
    }

    fn git(dir: &Path, args: &[&str]) -> bool {
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
            .args(args)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// A main checkout with one commit, plus a linked worktree of it.
    fn repo_with_worktree() -> Option<(tempfile::TempDir, PathBuf, PathBuf)> {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main");
        let wt = dir.path().join("wt");
        std::fs::create_dir(&main).unwrap();
        let ok = git(&main, &["init", "-q"])
            && git(&main, &["commit", "-q", "--allow-empty", "-m", "init"])
            && git(&main, &["worktree", "add", "-q", "-b", "wt", wt.to_str().unwrap()]);
        ok.then_some((dir, main, wt))
    }

    #[test]
    fn resolve_git_layout_finds_main_and_linked_git_dirs() {
        let Some((_dir, main, wt)) = repo_with_worktree() else {
            eprintln!("git unavailable; skipping");
            return;
        };
        let common = canonical_string(&main.join(".git"));
        let resolve = |p: &Path| resolve_git_layout(p.to_str().unwrap());
        let m = resolve(&main).unwrap().expect("main layout");
        assert_eq!(
            m,
            GitLayout {
                git_dir: common.clone(),
                common_dir: common.clone(),
                hooks_dir: format!("{common}/hooks"),
            }
        );
        let l = resolve(&wt).unwrap().expect("linked layout");
        assert_eq!(l.common_dir, common);
        assert_eq!(l.git_dir, format!("{common}/worktrees/wt"));
        assert_eq!(l.hooks_dir, format!("{common}/hooks"));
        // A plain directory is not a git workspace.
        let plain = tempfile::tempdir().unwrap();
        assert_eq!(resolve(plain.path()).unwrap(), None);
    }

    #[test]
    fn a_redirected_gitdir_pointer_is_put_back_after_a_codex_stage() {
        let Some((_dir, main, wt)) = repo_with_worktree() else {
            eprintln!("git unavailable; skipping");
            return;
        };
        let git_file = wt.join(".git");
        let original = std::fs::read(&git_file).unwrap();
        let before = GitEntry::read(&wt);
        assert_eq!(before, GitEntry::File(original.clone()));
        // Unchanged: the stage stands.
        assert_eq!(restore_git_entry(&wt, &before), None);

        // Repointed at a planted git dir: the original comes back, the changed
        // one is kept aside, and git resolves the real worktree git dir again.
        let planted = wt.join("planted");
        std::fs::create_dir(&planted).unwrap();
        std::fs::write(&git_file, format!("gitdir: {}\n", planted.display())).unwrap();
        let msg = restore_git_entry(&wt, &before).expect("a changed .git fails the stage");
        assert!(msg.contains("put the original back"), "{msg}");
        assert_eq!(std::fs::read(&git_file).unwrap(), original);
        let aside = std::fs::read_to_string(wt.join(".git.changed-by-stage")).unwrap();
        assert!(aside.contains("planted"), "{aside}");
        let layout = resolve_git_layout(wt.to_str().unwrap()).unwrap().unwrap();
        assert_eq!(layout.git_dir, format!("{}/worktrees/wt", canonical_string(&main.join(".git"))));

        // Replaced by a dir: moved aside under the next free name.
        std::fs::remove_file(&git_file).unwrap();
        std::fs::create_dir(&git_file).unwrap();
        assert!(restore_git_entry(&wt, &before).is_some());
        assert_eq!(std::fs::read(&git_file).unwrap(), original);
        assert!(wt.join(".git.changed-by-stage-2").is_dir());

        // Removed: written back.
        std::fs::remove_file(&git_file).unwrap();
        let msg = restore_git_entry(&wt, &before).unwrap();
        assert!(msg.contains("put it back"), "{msg}");
        assert_eq!(std::fs::read(&git_file).unwrap(), original);

        // A main checkout's `.git` dir that stays a dir, and a plain dir that
        // gains a repo, leave the stage alone.
        let main_before = GitEntry::read(&main);
        assert_eq!(main_before, GitEntry::Dir);
        assert_eq!(restore_git_entry(&main, &main_before), None);
        let plain = tempfile::tempdir().unwrap();
        let plain_before = GitEntry::read(plain.path());
        assert_eq!(plain_before, GitEntry::Missing);
        std::fs::create_dir(plain.path().join(".git")).unwrap();
        assert_eq!(restore_git_entry(plain.path(), &plain_before), None);
    }

    #[test]
    fn resolve_git_layout_follows_a_configured_hooks_path() {
        let Some((_dir, main, wt)) = repo_with_worktree() else {
            eprintln!("git unavailable; skipping");
            return;
        };
        // Husky v9's setting; the dir doesn't exist yet, it must still resolve.
        assert!(git(&main, &["config", "core.hooksPath", ".husky/_"]));
        for ws in [&main, &wt] {
            let layout = resolve_git_layout(ws.to_str().unwrap()).unwrap().unwrap();
            assert_eq!(layout.hooks_dir, format!("{}/.husky/_", canonical_string(ws)));
        }
    }

    #[test]
    fn resolve_git_layout_fails_closed_when_git_cant_answer() {
        let Some((dir, main, wt)) = repo_with_worktree() else {
            eprintln!("git unavailable; skipping");
            return;
        };
        // A sandboxed command could corrupt a linked worktree's HEAD (its git
        // dir is writable); the next profile must refuse, not drop the denies.
        std::fs::write(main.join(".git/worktrees/wt/HEAD"), "junk\n").unwrap();
        let wt_root = vec![wt.to_string_lossy().into_owned()];
        assert!(resolve_git_layout(&wt_root[0]).is_err());
        assert!(build_seatbelt_profile(&wt_root, &[]).is_err());
        // A `.git` file pointing at a git dir git wouldn't use for it.
        let odd = dir.path().join("odd");
        std::fs::create_dir(&odd).unwrap();
        std::fs::write(odd.join(".git"), format!("gitdir: {}\n", main.join(".git").display())).unwrap();
        assert!(resolve_git_layout(odd.to_str().unwrap()).is_err());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn seatbelt_denies_git_hooks_and_config_but_allows_commits() {
        // Kernel check that the trailing denies beat the earlier allows (the
        // tempdir sits under the allowed $TMPDIR, so only the denies stop it).
        let Some((dir, main, wt)) = repo_with_worktree() else {
            eprintln!("git unavailable; skipping");
            return;
        };
        let run = |ws: &Path, script: &str| -> bool {
            let roots = vec![ws.to_string_lossy().into_owned()];
            let args = vec!["-c".to_string(), script.to_string()];
            let prepared = prepare(&roots, None, OsStr::new("bash"), &args).unwrap();
            std::process::Command::new(&prepared.program)
                .args(&prepared.args)
                .current_dir(ws)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        for ws in [&main, &wt] {
            assert!(run(ws, "echo x > note.txt"), "workspace writes still work");
            let commit = "git add note.txt && git -c user.name=t -c user.email=t@example.com commit -qm note";
            assert!(run(ws, commit), "git add/commit works in {}", ws.display());
            assert!(!run(ws, "git config user.email evil@example.com"), "config is denied");
            assert!(!run(ws, "git config core.hooksPath /tmp"), "core.hooksPath is denied");
            assert!(!run(ws, "mv .git .git-moved"), "the .git entry can't be replaced");
            assert!(!run(ws, "mkdir -p sub && echo 'gitdir: /x' > sub/.git"), "no nested .git");
        }
        let hooks = main.join(".git/hooks");
        assert!(!run(&main, &format!("echo x > '{}/pre-commit'", hooks.display())));
        assert!(!run(&wt, &format!("echo x > '{}/pre-commit'", hooks.display())));
        assert!(!hooks.join("pre-commit").exists(), "no hook was planted");
        // No hardlink to the config or a hook inside the writable tree, so
        // nothing can be written through one. `probe` isn't a hook name git runs.
        let config = main.join(".git/config");
        let config_before = std::fs::read(&config).unwrap();
        let probe = hooks.join("probe");
        std::fs::write(&probe, "#!/bin/sh\n").unwrap();
        for ws in [&main, &wt] {
            let to_config = format!("ln '{}' cfg-link && echo '[core]' >> cfg-link", config.display());
            assert!(!run(ws, &to_config), "no hardlink to .git/config from {}", ws.display());
            assert!(!ws.join("cfg-link").exists());
            let to_hook = format!("ln '{}' hook-link && echo evil >> hook-link", probe.display());
            assert!(!run(ws, &to_hook), "no hardlink to a hook from {}", ws.display());
            assert!(!ws.join("hook-link").exists());
        }
        assert_eq!(std::fs::read(&config).unwrap(), config_before, "the config is unchanged");
        assert_eq!(std::fs::read(&probe).unwrap(), b"#!/bin/sh\n", "the hook is unchanged");
        // Legacy remote definitions a later `git fetch` would follow.
        assert!(!run(&main, "mkdir -p .git/remotes && echo 'URL: /evil' > .git/remotes/origin"), "remotes/ is denied");
        assert!(!run(&main, "mkdir -p .git/branches && echo /evil > .git/branches/origin"), "branches/ is denied");
        // From the main checkout, a sibling worktree can't be repointed, and
        // submodule git dirs can't gain hooks or config.
        assert!(!run(&main, "echo /evil > .git/worktrees/wt/commondir"), "sibling commondir is denied");
        assert!(!run(&main, "echo /evil > .git/worktrees/wt/gitdir"), "sibling gitdir is denied");
        // Nor renamed away and replaced (seatbelt doesn't check moved children).
        assert!(!run(&main, "mv .git/worktrees/wt .git/worktrees/wt-old"), "a worktree dir can't be renamed");
        assert!(!run(&main, "mv .git/worktrees .git/w-old"), "worktrees/ can't be renamed");
        assert!(!run(&main, "mkdir .git/worktrees/planted"), "no new worktree dir");
        assert!(main.join(".git/worktrees/wt/commondir").exists(), "the sibling is intact");
        assert!(!run(&main, "mkdir -p .git/modules/m/hooks"), "submodule git dirs are denied");
        assert!(
            !run(&main, "mkdir -p .git/worktrees/wt/modules/m/hooks"),
            "a sibling worktree's submodule git dirs are denied"
        );
        // A configured hooks dir inside the workspace (husky) is denied too.
        assert!(git(&main, &["config", "core.hooksPath", ".husky/_"]));
        std::fs::create_dir_all(wt.join(".husky")).unwrap();
        assert!(!run(&wt, "mkdir -p .husky/_ && echo x > .husky/_/pre-commit"), "hooksPath is denied");
        assert!(!run(&wt, "mv .husky .husky-moved"), "the hooks dir's parent can't be swapped");
        assert!(!wt.join(".husky/_/pre-commit").exists(), "no hook was planted");
        // Commits still work with a configured hooks path.
        let commit = "echo y > note.txt && git add note.txt && git -c user.name=t -c user.email=t@example.com commit -qm y";
        assert!(run(&wt, commit), "git commit still works");
        // A hooks dir in another writable root ($TMPDIR holds the tempdir): its
        // parents there can't be swapped either.
        let shared = dir.path().join("shared");
        std::fs::create_dir_all(shared.join("hooks")).unwrap();
        assert!(git(&main, &["config", "core.hooksPath", shared.join("hooks").to_str().unwrap()]));
        let moved = dir.path().join("shared-old");
        for ws in [&main, &wt] {
            let swap = format!("mv '{}' '{}'", shared.display(), moved.display());
            assert!(!run(ws, &swap), "the hooks dir's parent outside the workspace can't be swapped");
            let plant = format!("echo x > '{}/pre-commit'", shared.join("hooks").display());
            assert!(!run(ws, &plant), "hooksPath outside the workspace is denied");
        }
        assert!(!moved.exists() && !shared.join("hooks/pre-commit").exists(), "nothing was swapped or planted");
        let commit = "echo z > note.txt && git add note.txt && git -c user.name=t -c user.email=t@example.com commit -qm z";
        assert!(run(&wt, commit), "git commit still works");
    }

    #[test]
    fn assemble_write_roots_is_narrow() {
        let roots = assemble_write_roots(&["/ws".to_string()], Some("/home/u"), Some("/tmp/session"), None, &[]).subpaths;
        assert!(roots.contains(&"/ws".to_string()));
        assert!(roots.contains(&"/home/u/.claude/projects".to_string()));
        assert!(roots.contains(&"/tmp/session".to_string()));
        assert!(roots.contains(&"/dev".to_string()));
        // Only Claude Code's state dirs, never `~/.claude` itself (skills,
        // agents, settings hooks) nor the shared `~/.cache` (#774).
        let in_claude: Vec<&String> = roots.iter().filter(|r| r.starts_with("/home/u/.claude")).collect();
        assert_eq!(in_claude.len(), CLAUDE_STATE_DIRS.len(), "{in_claude:?}");
        for name in CLAUDE_STATE_DIRS {
            assert!(roots.contains(&format!("/home/u/.claude/{name}")));
        }
        assert!(!roots.iter().any(|r| r == "/home/u/.claude" || r.starts_with("/home/u/.cache")));
        // No GLOBAL package-manager dirs are writable — several are config/exec
        // dirs (a sandboxed agent must not plant a ~/.cargo/config.toml
        // rustc-wrapper or ~/.gradle/init.d/*.gradle that runs outside the
        // sandbox). Builds get a CONFINED cache via env redirect, not these.
        assert!(!roots.iter().any(|r| {
            r == "/home/u/.ssh"
                || r == "/home/u/.aws"
                || r == "/home/u/.config"
                || r == "/home/u/Library/Caches"
                || r == "/home/u/.cargo"
                || r == "/home/u/.gradle"
                || r == "/home/u/.rustup"
                || r == "/home/u/go"
                || r == "/home/u"
                || r == "/var/folders"
                || r == "/private/var/folders"
        }));
    }

    #[test]
    fn readonly_missions_get_no_write_roots_beyond_temp() {
        // A readonly (review/probe) mission is `Some(vec![])` → temp-only. It must
        // NOT gain the workspace OR any package-manager dir. (The gap that let
        // the first cut of B3 accidentally grant readonly missions write access
        // to ~/.cargo etc.)
        let roots = assemble_write_roots(&[], Some("/home/u"), Some("/tmp/session"), None, &[]).subpaths;
        assert!(!roots.iter().any(|r| r.starts_with("/home/u/.cargo") || r == "/home/u/go"));
        assert!(!roots.contains(&"/ws".to_string()));
        // Temp + the CLI's own dirs are still there (a shell needs them).
        assert!(roots.contains(&"/tmp/session".to_string()));
        assert!(roots.contains(&"/home/u/.claude/projects".to_string()));
        assert!(!roots.contains(&"/home/u/.claude".to_string()));
    }

    #[test]
    fn sandbox_cache_env_redirects_into_the_mission_cache_root() {
        let env: std::collections::HashMap<String, String> =
            sandbox_cache_env("/c/build-cache/abc/").into_iter().collect();
        // Every redirect points under the mission's cache root, never at ~.
        for (k, v) in &env {
            assert!(v.starts_with("/c/build-cache/abc/"), "{k}={v} escaped the cache root");
        }
        assert!(env.get("CARGO_HOME").unwrap().ends_with("/cargo"));
        assert!(env.contains_key("npm_config_cache"));
        assert!(env.contains_key("GOPATH"));
        assert!(env.contains_key("GRADLE_USER_HOME"));
        // XDG tools cache there too, not in the shared, unwritable ~/.cache.
        assert_eq!(env.get("XDG_CACHE_HOME").map(String::as_str), Some("/c/build-cache/abc/xdg"));
    }

    #[test]
    fn a_codex_workspace_write_stage_gets_its_own_cache_root_per_workspace() {
        let base = Path::new("/home/u/Library/Caches/octopush/build-cache");
        let a = codex_cache_root(base, "/ws-a");
        assert_eq!(a, codex_cache_root(base, "/ws-a"));
        assert_ne!(a, codex_cache_root(base, "/ws-b"));
        // Never the root a sandboxed mission on the same workspace builds with.
        assert_ne!(a, mission_cache_root(base, "/ws-a", &["/ws-a".to_string()], RC));
        assert_ne!(a, mission_cache_root(base, "/ws-a", &[], RC));
        // In the workspace's dir, so deleting the workspace removes it too.
        assert_eq!(a.parent(), Some(workspace_cache_dir(base, "/ws-a").as_path()));
    }

    #[test]
    fn codex_build_cache_makes_a_private_root_and_redirects_into_it() {
        let ws = tempfile::tempdir().unwrap();
        let scope = ws.path().join("octopush-codex-cache-test").to_string_lossy().into_owned();
        let Ok((root, env)) = codex_build_cache(&scope) else { return };
        assert!(Path::new(&root).is_dir());
        for (k, v) in &env {
            assert!(v.starts_with(&format!("{root}/")), "{k}={v} escaped the cache root");
        }
        assert!(env.iter().any(|(k, _)| k == "npm_config_cache"));
        assert!(env.iter().any(|(k, _)| k == "CARGO_HOME"));
        // Codex keeps the user's TMPDIR: only Claude stages get their own.
        assert_eq!(env, sandbox_cache_env(&root));
        assert!(!env.iter().any(|(k, _)| k == "TMPDIR"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&root).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let _ = remove_workspace_build_caches(&scope);
        assert!(!Path::new(&root).exists(), "deleting the workspace removes its cache");
    }

    #[test]
    fn each_workspace_and_access_mode_gets_its_own_cache_root_outside_every_shared_write_root() {
        let home = "/home/u";
        let tmpdir = "/private/var/folders/xy/T";
        let base = Path::new("/home/u/Library/Caches/octopush/build-cache");
        let ws_a = vec!["/ws-a".to_string()];
        let a = mission_cache_root(base, "/ws-a", &ws_a, RC);
        let b = mission_cache_root(base, "/ws-b", &["/ws-b".to_string()], RC);
        // A different workspace, or a readonly mission on the same one, gets a
        // different root, so a readonly review never builds with a cache a
        // writer on that workspace (or any other workspace) filled.
        assert_ne!(a, b);
        assert_ne!(a, mission_cache_root(base, "/ws-a", &[], RC));
        // Missions with the same workspace and access mode share one root.
        assert_eq!(mission_cache_root(base, "/ws-a", &[], RC), mission_cache_root(base, "/ws-a", &[], RC));
        // ...but only launches of the same tenant: an exec-`none` readonly
        // stage, a Codex stage of a sandboxed readonly mission and an
        // in-process `run_command` each get their own, in the same dir.
        let tenants = [
            RC,
            CacheTenant::Cli { exec_choice: "none", reads_confined: false },
            CacheTenant::Cli { exec_choice: "sandbox", reads_confined: false },
            CacheTenant::InProcess,
            CacheTenant::CodexWorkspaceWrite,
        ];
        let roots: Vec<PathBuf> = tenants.iter().map(|t| mission_cache_root(base, "/ws-a", &[], *t)).collect();
        for (i, r) in roots.iter().enumerate() {
            assert!(roots.iter().skip(i + 1).all(|o| o != r), "{:?} shares a root", tenants[i]);
            assert_eq!(r.parent(), Some(workspace_cache_dir(base, "/ws-a").as_path()));
        }
        // Every mode's root sits in the one dir of its workspace.
        let ws_dir = workspace_cache_dir(base, "/ws-a");
        assert_eq!(a.parent(), Some(ws_dir.as_path()));
        assert_eq!(mission_cache_root(base, "/ws-a", &[], RC).parent(), Some(ws_dir.as_path()));
        assert_eq!(ws_dir.parent(), Some(base));
        assert_ne!(ws_dir, workspace_cache_dir(base, "/ws-b"));
        assert_eq!(ws_dir, workspace_cache_dir(base, "/ws-a/"), "a trailing slash is the same workspace");
        // The base sits outside every root all missions share (temp, the
        // ~/.claude state dirs), so only the own subtree is ever writable.
        let shared = assemble_write_roots(&[], Some(home), Some(tmpdir), None, &[]).subpaths;
        for r in &shared {
            assert!(!base.starts_with(r), "the cache base {} is inside the write root {r}", base.display());
        }
        let a_str = a.to_string_lossy().into_owned();
        let b_str = b.to_string_lossy().into_owned();
        let roots = assemble_write_roots(&[ws_a[0].clone(), a_str.clone()], Some(home), Some(tmpdir), None, &[]).subpaths;
        assert!(roots.contains(&a_str));
        assert!(!roots.iter().any(|r| Path::new(&b_str).starts_with(r)), "mission B's cache is writable to A");
    }

    #[test]
    fn the_cache_root_is_allowed_as_given_and_the_root_dir_itself_is_denied() {
        // A real dir and a symlink to it: the profile must take the given path
        // and never add the link's target as another writable root.
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let root = canonical_string(&real);
        let p = build_seatbelt_profile(&[], std::slice::from_ref(&root)).unwrap();
        let allow = p.find("(allow file-write*").unwrap();
        let deny = p.find("(deny file-write*\n").expect("a deny block for the cache root");
        let link = p.find("(deny file-link\n").expect("a file-link deny for the cache root");
        let rule = format!("(subpath {})", sbpl_string(&root));
        assert!(p[allow..deny].contains(&rule), "writes inside the root are allowed");
        let pin = format!("(literal {})", sbpl_string(&root));
        assert!(p[deny..link].contains(&pin), "the root can't be removed or replaced");
        assert!(p[link..].contains(&pin), "the root can't be hardlinked");
        #[cfg(unix)]
        {
            let target = dir.path().join("target");
            std::fs::create_dir(&target).unwrap();
            let via_link = dir.path().join("link");
            std::os::unix::fs::symlink(&target, &via_link).unwrap();
            let link_str = via_link.to_string_lossy().into_owned();
            let p = build_seatbelt_profile(&[], std::slice::from_ref(&link_str)).unwrap();
            let target_rule = format!("(subpath {})", sbpl_string(&canonical_string(&target)));
            assert!(!p.contains(&target_rule), "a cache root is never re-resolved");
        }
    }

    #[test]
    #[cfg(unix)]
    fn ensure_cache_root_refuses_a_root_or_base_that_isnt_a_real_dir() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("build-cache");
        let root = base.join("ws").join("key");
        let made = ensure_cache_root(&root).unwrap();
        assert_eq!(made, std::fs::canonicalize(&base).unwrap().join("ws").join("key"));
        assert_eq!(std::fs::canonicalize(&made).unwrap(), made, "the returned root is its own realpath");
        assert_eq!(mode(&made), 0o700);
        assert_eq!(mode(&base.join("ws")), 0o700);
        assert_eq!(mode(&base), 0o700);
        // Idempotent for a real dir.
        assert_eq!(ensure_cache_root(&root).unwrap(), made);

        // The root swapped for a symlink to a dir outside: refused, and the
        // target isn't chmodded.
        let target = dir.path().join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::remove_dir(&made).unwrap();
        std::os::unix::fs::symlink(&target, &made).unwrap();
        assert!(ensure_cache_root(&root).is_err(), "a symlinked root is refused");
        assert_eq!(mode(&target), 0o755, "the link's target keeps its mode");
        // A dangling link, or a file, in the root's place.
        std::fs::remove_file(&made).unwrap();
        std::os::unix::fs::symlink(dir.path().join("nowhere"), &made).unwrap();
        assert!(ensure_cache_root(&root).is_err(), "a dangling link is refused");
        assert!(!dir.path().join("nowhere").exists(), "nothing was created through it");
        std::fs::remove_file(&made).unwrap();
        std::fs::write(&made, "x").unwrap();
        assert!(ensure_cache_root(&root).is_err(), "a file is refused");

        // A symlinked base is refused too.
        let link_base = dir.path().join("link-base");
        std::os::unix::fs::symlink(&target, &link_base).unwrap();
        assert!(ensure_cache_root(&link_base.join("ws").join("key")).is_err(), "a symlinked base is refused");
        assert_eq!(mode(&target), 0o755);
        assert!(!target.join("ws").exists());

        // And a symlinked workspace dir.
        let other = base.join("other");
        std::os::unix::fs::symlink(&target, &other).unwrap();
        assert!(ensure_cache_root(&other.join("key")).is_err(), "a symlinked workspace dir is refused");
        assert_eq!(mode(&target), 0o755);
        assert!(!target.join("key").exists());
    }

    #[test]
    fn a_stage_temp_dir_is_keyed_by_its_cache_root_and_short_enough_for_sockets() {
        let home = "/Users/abcdefgh";
        let base = PathBuf::from(format!("{home}/Library/Caches/octopush/build-cache"));
        let tmp_base = PathBuf::from(format!("{home}/Library/Caches/octopush/tmp"));
        let writer = mission_cache_root(&base, "/ws-a", &["/ws-a".to_string()], RC);
        let reader = mission_cache_root(&base, "/ws-a", &[], RC);
        let other_ws = mission_cache_root(&base, "/ws-b", &["/ws-b".to_string()], RC);
        let t = stage_tmp_dir(&tmp_base, &writer).unwrap();
        assert_eq!(t.parent(), Some(tmp_base.as_path()));
        assert_eq!(stage_tmp_dir(&tmp_base, &writer), Some(t.clone()), "stable");
        assert_ne!(stage_tmp_dir(&tmp_base, &reader), Some(t.clone()), "per access mode");
        assert_ne!(stage_tmp_dir(&tmp_base, &other_ws), Some(t.clone()), "per workspace");
        // The base differs between the app and a resolved form; the key
        // doesn't.
        let real = PathBuf::from("/private").join(writer.strip_prefix("/").unwrap());
        assert_eq!(stage_tmp_dir(&tmp_base, &real), Some(t.clone()));
        assert_eq!(stage_tmp_dir(&tmp_base, Path::new("/")), None);
        // macOS caps a Unix socket path at 104 bytes (103 + NUL). The temp dir
        // stays near the default `/var/folders/…/T/` (49 bytes) instead of
        // `<cache root>/tmp`.
        let t_len = t.to_string_lossy().len();
        let in_root_len = writer.join("tmp").to_string_lossy().len();
        assert_eq!(t_len, 60, "{}", t.display());
        assert_eq!(in_root_len, 89);
        // `tempfile::tempdir()` + `/x.sock` fits, as a Python multiprocessing
        // listener (`/pymp-xxxxxxxx/listener-xxxxxxxx`) does.
        assert!(t_len + "/.tmpAbC123/x.sock".len() < 104);
        assert!(t_len + "/pymp-abcdefgh/listener-abcdefgh".len() < 104);
    }

    #[test]
    fn stage_dirs_give_a_claude_stage_its_own_temp_dir_and_nothing_else() {
        use crate::orchestrator::cli_runner::sandbox_read_dir_args;
        let ws = tempfile::tempdir().unwrap();
        let roots = vec![ws.path().to_string_lossy().into_owned()];
        let scope = format!("{}-stage-tmp-test", roots[0]);
        let Ok(claude) = StageDirs::make(&roots, Some(scope.as_str()), RC, true) else { return };
        let root = claude.cache_root.clone().unwrap();
        let tmp = claude.tmp.clone().unwrap();
        assert_eq!(claude.dirs(), vec![root.clone(), tmp.clone()], "cache root, then temp dir");
        assert!(Path::new(&tmp).is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&tmp).unwrap().permissions().mode() & 0o777, 0o700);
        }
        assert_eq!(std::fs::canonicalize(&tmp).unwrap().to_string_lossy(), tmp, "a realpath");
        // TMPDIR is the stage's own dir, never the user-wide one, and the
        // cache env is the same as without it.
        let env = claude.env();
        let tmpdirs: Vec<&String> = env.iter().filter(|(k, _)| k == "TMPDIR").map(|(_, v)| v).collect();
        assert_eq!(tmpdirs, vec![&tmp]);
        let without_tmp: Vec<(String, String)> = env.iter().filter(|(k, _)| k != "TMPDIR").cloned().collect();
        assert_eq!(without_tmp, sandbox_cache_env(&root));
        // Outside every shared write root, so no other workspace's stage can
        // write it (or plant `.claude/skills` in it). (Only macOS runs the
        // sandbox, so only its cache dir is checked.)
        #[cfg(target_os = "macos")]
        {
            let home = std::env::var("HOME").ok();
            let shared = assemble_write_roots(
                &[],
                home.as_deref(),
                std::env::var("TMPDIR").ok().as_deref(),
                current_uid(),
                &private_bases(),
            )
            .subpaths;
            for r in &shared {
                assert!(!Path::new(&tmp).starts_with(r), "{tmp} is inside {r}");
            }
        }
        // A read-confined stage names exactly these two with `--add-dir`.
        let add = sandbox_read_dir_args(true, &claude.dirs());
        assert_eq!(add, vec!["--add-dir".to_string(), root.clone(), "--add-dir".to_string(), tmp.clone()]);

        // Without `private_tmp`, for the same tenant: the same cache root, no
        // temp dir, no TMPDIR. (TALK's `run_command` and Codex stages have
        // tenants of their own, so roots of their own.)
        let plain = StageDirs::make(&roots, Some(scope.as_str()), RC, false).unwrap();
        assert_eq!(plain.dirs(), vec![root.clone()]);
        assert_eq!(plain.env(), sandbox_cache_env(&root));
        // No cache scope: nothing at all, even when a temp dir was asked for.
        let none = StageDirs::make(&roots, None, RC, true).unwrap();
        assert!(none.dirs().is_empty() && none.env().is_empty());

        // Deleting the workspace removes its temp dirs with its caches.
        remove_workspace_build_caches(&scope).unwrap();
        assert!(!Path::new(&tmp).exists() && !Path::new(&root).exists());
    }

    #[test]
    #[cfg(unix)]
    fn ensure_stage_tmp_refuses_a_dir_or_base_that_isnt_a_real_dir() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("tmp");
        let made = ensure_stage_tmp(&base.join("key")).unwrap();
        assert_eq!(made, std::fs::canonicalize(&base).unwrap().join("key"));
        assert_eq!((mode(&made), mode(&base)), (0o700, 0o700));
        assert_eq!(ensure_stage_tmp(&base.join("key")).unwrap(), made, "idempotent");
        let target = dir.path().join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::remove_dir(&made).unwrap();
        std::os::unix::fs::symlink(&target, &made).unwrap();
        assert!(ensure_stage_tmp(&base.join("key")).is_err(), "a symlinked temp dir is refused");
        assert_eq!(mode(&target), 0o755, "the link's target keeps its mode");
        let link_base = dir.path().join("link-base");
        std::os::unix::fs::symlink(&target, &link_base).unwrap();
        assert!(ensure_stage_tmp(&link_base.join("key")).is_err(), "a symlinked base is refused");
        assert!(!target.join("key").exists());
    }

    #[test]
    #[cfg(unix)]
    fn prune_removes_stage_temp_dirs_unused_for_too_long() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("octopush").join("tmp");
        let old = ensure_stage_tmp(&base.join("old")).unwrap();
        let fresh = ensure_stage_tmp(&base.join("fresh")).unwrap();
        std::fs::write(old.join("f"), "x").unwrap();
        let day = std::time::Duration::from_secs(24 * 60 * 60);
        let past = std::time::SystemTime::now() - 40 * day;
        std::fs::File::open(&old).unwrap().set_modified(past).unwrap();
        let now = std::time::SystemTime::now();
        assert_eq!(prune_tmp_base(&base, now, 30 * day), 1);
        assert!(!old.exists() && fresh.exists());
        // Through a symlinked base, nothing.
        let link = dir.path().join("octopush").join("link");
        std::os::unix::fs::symlink(&base, &link).unwrap();
        std::fs::File::open(&fresh).unwrap().set_modified(past).unwrap();
        assert_eq!(prune_tmp_base(&link, now, 30 * day), 0);
        assert!(fresh.exists());
    }

    #[test]
    #[cfg(unix)]
    fn ensure_cache_root_marks_the_root_as_just_used() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("build-cache").join("ws").join("key");
        let made = ensure_cache_root(&root).unwrap();
        let old = std::time::SystemTime::now() - 2 * BUILD_CACHE_MAX_AGE;
        let set_old = |p: &Path| std::fs::File::open(p).unwrap().set_modified(old).unwrap();
        set_old(&made);
        set_old(made.parent().unwrap());
        let now = std::time::SystemTime::now();
        assert!(is_stale(&made, now, BUILD_CACHE_MAX_AGE));
        ensure_cache_root(&root).unwrap();
        assert!(!is_stale(&made, now, BUILD_CACHE_MAX_AGE), "a used root is fresh again");
        assert!(!is_stale(made.parent().unwrap(), now, BUILD_CACHE_MAX_AGE));
    }

    #[test]
    #[cfg(unix)]
    fn pruning_removes_only_caches_unused_past_the_max_age() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("build-cache");
        let now = std::time::SystemTime::now();
        let old = now - 2 * BUILD_CACHE_MAX_AGE;
        let set_old = |p: &Path| std::fs::File::open(p).unwrap().set_modified(old).unwrap();

        // Workspace A: a stale readonly root beside a fresh writer root. The
        // stale one holds a link to a dir outside the base.
        let stale = ensure_cache_root(&mission_cache_root(&base, "/ws-a", &[], RC)).unwrap();
        let fresh = ensure_cache_root(&mission_cache_root(&base, "/ws-a", &["/ws-a".to_string()], RC)).unwrap();
        let outside = dir.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("keep"), "x").unwrap();
        std::fs::create_dir_all(stale.join("cargo")).unwrap();
        std::os::unix::fs::symlink(&outside, stale.join("cargo/link")).unwrap();
        set_old(&stale);
        set_old(stale.parent().unwrap());
        // Workspace B: only stale roots, so its dir goes too.
        let gone = ensure_cache_root(&mission_cache_root(&base, "/ws-b", &[], RC)).unwrap();
        set_old(&gone);
        let ws_b = gone.parent().unwrap().to_path_buf();
        set_old(&ws_b);

        assert_eq!(prune_cache_base(&base, now, BUILD_CACHE_MAX_AGE), 2);
        assert!(!stale.exists());
        assert!(fresh.is_dir(), "a cache used recently stays");
        assert!(stale.parent().unwrap().is_dir(), "a workspace with a fresh cache keeps its dir");
        assert!(!ws_b.exists(), "an emptied stale workspace dir is removed");
        assert!(outside.join("keep").exists(), "nothing behind a link is touched");
        // Nothing left to prune.
        assert_eq!(prune_cache_base(&base, now, BUILD_CACHE_MAX_AGE), 0);
        assert_eq!(prune_cache_base(&dir.path().join("missing"), now, BUILD_CACHE_MAX_AGE), 0);
    }

    #[test]
    #[cfg(unix)]
    fn pruning_through_a_symlinked_base_or_parent_removes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let old = std::time::SystemTime::now() - 2 * BUILD_CACHE_MAX_AGE;
        let set_old = |p: &Path| std::fs::File::open(p).unwrap().set_modified(old).unwrap();
        // Old user data two levels down in the dir a link points at.
        let target = dir.path().join("target");
        let entry = target.join("project").join("src");
        std::fs::create_dir_all(&entry).unwrap();
        std::fs::write(entry.join("main.rs"), "x").unwrap();
        set_old(&entry);
        set_old(entry.parent().unwrap());
        let now = std::time::SystemTime::now();

        // `build-cache` itself is the link.
        let link_base = dir.path().join("build-cache");
        std::os::unix::fs::symlink(&target, &link_base).unwrap();
        assert_eq!(prune_cache_base(&link_base, now, BUILD_CACHE_MAX_AGE), 0);
        assert!(entry.join("main.rs").exists(), "the link's target keeps its old entries");

        // `…/Caches/octopush` is the link, `build-cache` a real dir inside.
        let real_parent = dir.path().join("real-parent");
        std::fs::create_dir(&real_parent).unwrap();
        std::fs::rename(&target, real_parent.join("build-cache")).unwrap();
        let link_parent = dir.path().join("octopush");
        std::os::unix::fs::symlink(&real_parent, &link_parent).unwrap();
        let moved = real_parent.join("build-cache").join("project").join("src");
        assert_eq!(prune_cache_base(&link_parent.join("build-cache"), now, BUILD_CACHE_MAX_AGE), 0);
        assert!(moved.join("main.rs").exists(), "nothing behind a linked parent is pruned");

        // The same tree reached directly is pruned, so the refusals above are
        // the base check and not the entries being fresh.
        assert_eq!(prune_cache_base(&real_parent.join("build-cache"), now, BUILD_CACHE_MAX_AGE), 1);
        assert!(!moved.exists());
    }

    #[test]
    #[cfg(unix)]
    fn removing_a_workspaces_caches_takes_every_mode_and_spares_other_workspaces() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("build-cache");
        let a_ro = ensure_cache_root(&mission_cache_root(&base, "/ws-a", &[], RC)).unwrap();
        let a_rw = ensure_cache_root(&mission_cache_root(&base, "/ws-a", &["/ws-a".to_string()], RC)).unwrap();
        let a_codex = ensure_cache_root(&codex_cache_root(&base, "/ws-a")).unwrap();
        // Every tenant's root sits in the same workspace dir.
        let open = CacheTenant::Cli { exec_choice: "none", reads_confined: false };
        let a_open = ensure_cache_root(&mission_cache_root(&base, "/ws-a", &[], open)).unwrap();
        let a_talk = ensure_cache_root(&mission_cache_root(&base, "/ws-a", &[], CacheTenant::InProcess)).unwrap();
        let b = ensure_cache_root(&mission_cache_root(&base, "/ws-b", &[], RC)).unwrap();
        remove_cache_dir(&workspace_cache_dir(&base, "/ws-a/")).unwrap();
        assert!(!a_ro.exists() && !a_rw.exists() && !a_codex.exists() && !a_open.exists() && !a_talk.exists());
        assert!(!workspace_cache_dir(&base, "/ws-a").exists());
        assert!(b.is_dir(), "another workspace's cache stays");
        // Already gone, or never made: fine.
        remove_cache_dir(&workspace_cache_dir(&base, "/ws-a")).unwrap();
        // A link in the workspace dir's place is left alone, its target too.
        let target = dir.path().join("target");
        std::fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink(&target, workspace_cache_dir(&base, "/ws-c")).unwrap();
        remove_cache_dir(&workspace_cache_dir(&base, "/ws-c")).unwrap();
        assert!(target.is_dir());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn seatbelt_stops_a_stage_swapping_its_cache_root_for_a_symlink() {
        use std::os::unix::fs::PermissionsExt;
        let ws = tempfile::tempdir().unwrap();
        let roots = vec![ws.path().to_string_lossy().into_owned()];
        let scope = format!("{}-swap-test", roots[0]);
        let base = build_cache_base().unwrap();
        // A dir outside every write root (the base itself is one).
        let target = base.join("swap-test-target");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        let swap = format!(
            "root=\"$(dirname \"$CARGO_HOME\")\"; rm -rf \"$root\"; mv \"$root\" \"$root.old\"; ln -s '{}' \"$root\" && test -L \"$root\"",
            target.display()
        );
        let args = vec!["-c".to_string(), swap];
        let prepared = prepare(&roots, Some(scope.as_str()), OsStr::new("bash"), &args).unwrap();
        let cargo_home = prepared.env.iter().find(|(k, _)| k == "CARGO_HOME").unwrap().1.clone();
        let own = Path::new(&cargo_home).parent().unwrap().to_path_buf();
        let swapped = std::process::Command::new(&prepared.program)
            .args(&prepared.args)
            .envs(prepared.env.iter().cloned())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(!swapped, "the stage can't replace its cache root");
        let meta = std::fs::symlink_metadata(&own).unwrap();
        assert!(meta.is_dir() && !meta.file_type().is_symlink(), "the cache root is still a real dir");

        // Even if the root were swapped some other way, the next prepare
        // refuses it and leaves the target alone.
        std::fs::remove_dir_all(&own).unwrap();
        std::os::unix::fs::symlink(&target, &own).unwrap();
        let probe = vec!["-c".to_string(), "true".to_string()];
        assert!(prepare(&roots, Some(scope.as_str()), OsStr::new("bash"), &probe).is_err());
        let target_mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        let _ = std::fs::remove_file(&own);
        let _ = std::fs::remove_dir_all(workspace_cache_dir(&base, &scope));
        let _ = std::fs::remove_dir_all(&target);
        assert_eq!(target_mode, 0o755, "the link's target wasn't chmodded");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn seatbelt_lets_a_claude_stage_write_its_own_temp_dir_only() {
        let ws = tempfile::tempdir().unwrap();
        let roots = vec![ws.path().to_string_lossy().into_owned()];
        let scope = format!("{}-seatbelt-tmp-test", roots[0]);
        let run = |script: &str| {
            let mut seen: Vec<String> = Vec::new();
            let args = vec!["-c".to_string(), script.to_string()];
            let prepared = prepare_with(&roots, Some(scope.as_str()), RC, OsStr::new("bash"), &args, true, |dirs| {
                seen = dirs.to_vec();
                Vec::new()
            })
            .unwrap();
            let ok = std::process::Command::new(&prepared.program)
                .args(&prepared.args)
                .envs(prepared.env.iter().cloned())
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            (ok, prepared.env, seen)
        };
        let (ok, env, seen) = run("echo x > \"$TMPDIR/probe\" && mkdir -p \"$TMPDIR/d\"");
        let tmp = env.iter().find(|(k, _)| k == "TMPDIR").unwrap().1.clone();
        assert!(ok, "the stage writes its own temp dir");
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[1], tmp);
        // The temp dir itself can't be swapped for a link.
        let (swapped, _, _) = run("mv \"$TMPDIR\" \"$TMPDIR.old\" || rm -rf \"$TMPDIR\"; ln -s / \"$TMPDIR\"");
        assert!(!swapped);
        assert!(std::fs::symlink_metadata(&tmp).unwrap().is_dir());
        // Another stage's temp dir (same base, other key) is denied.
        let sibling = Path::new(&tmp).parent().unwrap().join("not-this-stage");
        let (planted, _, _) = run(&format!("mkdir -p '{}'", sibling.display()));
        assert!(!planted && !sibling.exists());
        let _ = remove_workspace_build_caches(&scope);
        assert!(!Path::new(&tmp).exists());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn the_real_cache_base_is_outside_every_shared_write_root() {
        let base = build_cache_base().expect("a user cache dir");
        let home = std::env::var("HOME").ok();
        let tmpdir = std::env::var("TMPDIR").ok();
        let shared = assemble_write_roots(&[], home.as_deref(), tmpdir.as_deref(), current_uid(), &private_bases()).subpaths;
        for base in [base, stage_tmp_base().expect("a user cache dir")] {
            let real = canonical_lenient(&base);
            for r in &shared {
                assert!(!base.starts_with(r) && !real.starts_with(r), "{} is inside {r}", base.display());
            }
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn seatbelt_lets_a_mission_write_only_its_own_build_cache() {
        let ws = tempfile::tempdir().unwrap();
        let roots = vec![ws.path().to_string_lossy().into_owned()];
        let scope = format!("{}-cache-test", roots[0]);
        let args = vec!["-c".to_string(), "mkdir -p \"$CARGO_HOME\" && echo x > \"$CARGO_HOME/probe\"".to_string()];
        let prepared = prepare(&roots, Some(scope.as_str()), OsStr::new("bash"), &args).unwrap();
        let ok = std::process::Command::new(&prepared.program)
            .args(&prepared.args)
            .envs(prepared.env.iter().cloned())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(ok, "the mission's own cache is writable");
        // A sibling under the shared base is another mission's cache.
        let base = build_cache_base().unwrap();
        let sibling = base.join("not-this-mission");
        let plant = vec!["-c".to_string(), format!("mkdir -p '{}'", sibling.display())];
        let prepared = prepare(&roots, Some(scope.as_str()), OsStr::new("bash"), &plant).unwrap();
        let planted = std::process::Command::new(&prepared.program)
            .args(&prepared.args)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(!planted && !sibling.exists(), "another mission's cache is denied");

        // The same workspace's roots for other access modes sit beside this
        // one in its workspace dir: the stage can neither create them nor,
        // once they exist, write inside them.
        let run = |script: String| {
            let args = vec!["-c".to_string(), script];
            let prepared = prepare(&roots, Some(scope.as_str()), OsStr::new("bash"), &args).unwrap();
            std::process::Command::new(&prepared.program)
                .args(&prepared.args)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        let readonly = mission_cache_root(&base, &scope, &[], RC);
        let codex = codex_cache_root(&base, &scope);
        // Nor the root a read-confined Claude stage with the same write roots
        // loads with `--add-dir`: an in-process `run_command` has its own.
        let claude_same_roots = mission_cache_root(&base, &scope, &roots, RC);
        for other in [&readonly, &codex, &claude_same_roots] {
            assert!(!run(format!("mkdir '{}'", other.display())), "{} can't be created", other.display());
            assert!(!other.exists());
            let made = ensure_cache_root(other).unwrap();
            assert!(!run(format!("echo x > '{}/probe'", made.display())), "{} can't be written", made.display());
            assert!(!made.join("probe").exists());
            assert!(!run(format!("mkdir '{}/cargo'", made.display())));
            assert!(!made.join("cargo").exists());
        }
        // Nor any new entry in its own workspace dir.
        let ws_dir = workspace_cache_dir(&base, &scope);
        let planted_dir = ws_dir.join("planted-dir");
        let planted_file = ws_dir.join("planted-file");
        let planted_link = ws_dir.join("planted-link");
        assert!(!run(format!("mkdir '{}'", planted_dir.display())));
        assert!(!run(format!("echo x > '{}'", planted_file.display())));
        assert!(!run(format!("ln -s /tmp '{}'", planted_link.display())));
        for p in [&planted_dir, &planted_file, &planted_link] {
            assert!(std::fs::symlink_metadata(p).is_err(), "{} was created", p.display());
        }
        let _ = std::fs::remove_dir_all(&ws_dir);
    }

    #[test]
    fn system_write_files_covers_the_claude_state_file() {
        assert_eq!(system_write_files(Some("/home/u")), vec!["/home/u/.claude.json".to_string()]);
        assert!(system_write_files(None).is_empty());
    }

    #[test]
    fn sandbox_write_roots_makes_readonly_temp_only_and_sandbox_workspace_writable() {
        // readonly forces the sandbox on with NO workspace root (temp-only), even
        // if the mission's exec_isolation says "none".
        assert_eq!(sandbox_write_roots("readonly", "none", "/ws"), Some(vec![]));
        assert_eq!(sandbox_write_roots("readonly", "sandbox", "/ws"), Some(vec![]));
        // a normal sandboxed mission may write its workspace.
        assert_eq!(sandbox_write_roots("worktree", "sandbox", "/ws"), Some(vec!["/ws".to_string()]));
        // an unsandboxed writer mission is not confined.
        assert_eq!(sandbox_write_roots("worktree", "none", "/ws"), None);
    }

    #[test]
    fn is_write_allowed_confines_to_roots_and_blocks_escapes() {
        let roots = vec!["/ws".to_string(), "/private/tmp".to_string()];
        assert!(is_write_allowed(Path::new("/ws/src/main.rs"), &roots));
        assert!(is_write_allowed(Path::new("/private/tmp/x"), &roots));
        // Absolute escape (Path::join discards the base for an absolute arg).
        assert!(!is_write_allowed(Path::new("/etc/passwd"), &roots));
        // `..` escape out of the workspace.
        assert!(!is_write_allowed(Path::new("/ws/../etc/passwd"), &roots));
        // A sibling dir that merely shares a prefix is NOT under the root.
        assert!(!is_write_allowed(Path::new("/ws-other/x"), &roots));
    }

    #[test]
    fn the_launch_line_names_each_root_left_out_of_the_sandbox() {
        assert_eq!(left_out_label(&[]), None);
        let why = vec!["/u/.cache resolves to /u".to_string(), "/u/.claude.json has more than one hard link".to_string()];
        assert_eq!(
            left_out_label(&why).as_deref(),
            Some("left out of the sandbox: /u/.cache resolves to /u; /u/.claude.json has more than one hard link")
        );
    }

    #[test]
    fn sandbox_argv_passes_the_profile_inline_then_program() {
        // Inline (`-p`), never a profile file (`-f`) another sandboxed stage
        // could overwrite between its write and this spawn.
        let profile = "(version 1)\n(allow default)\n";
        let (prog, args) = sandbox_argv(
            OsStr::new("/usr/local/bin/claude"),
            &["-p".to_string(), "hi".to_string()],
            profile,
        );
        assert_eq!(prog, OsString::from(SANDBOX_EXEC));
        assert!(!args.contains(&OsString::from("-f")));
        assert_eq!(
            args,
            vec![
                OsString::from("-p"),
                OsString::from(profile),
                OsString::from("/usr/local/bin/claude"),
                OsString::from("-p"),
                OsString::from("hi"),
            ]
        );
    }
}
