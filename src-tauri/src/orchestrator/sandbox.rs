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

/// The `~/.claude` subdirs a headless `claude -p` stage writes as it runs
/// (#774), from Claude Code's "application data" docs
/// (code.claude.com/docs/en/claude-directory) and a traced `-p` run (on
/// Linux, up to the first API call; the docs cover what comes later):
/// transcripts (`projects/`, which `--resume` needs), running-session records
/// (`sessions/`), per-session env and shell snapshots, checkpoint snapshots,
/// task lists, plans, debug logs, large pastes and `~/.claude.json` backups.
/// `todos/` and `statsig/` are the legacy dirs older CLI versions still write.
/// These are the only `~/.claude` paths a sandboxed stage may write: nothing
/// Claude Code loads as instructions or config lives in them (auto memory,
/// under `projects/<p>/memory`, is denied again by `claude_config_denies`).
/// Each is created by Octopush, outside the sandbox (`ensure_home_roots`),
/// since a stage can't create entries in `~/.claude` itself.
const CLAUDE_STATE_DIRS: &[&str] = &[
    "projects",
    "sessions",
    "session-env",
    "shell-snapshots",
    "file-history",
    "tasks",
    "plans",
    "debug",
    "paste-cache",
    "backups",
    "todos",
    "statsig",
];

/// The `~/.claude` dirs Claude Code loads as instructions, config or code
/// (or that hold credentials or installs), denied by `claude_config_denies`
/// after every allow. None is a write root anyway; the denies keep them shut
/// even if a link or a future grant would cover them.
const CLAUDE_CONFIG_DIRS: &[&str] = &[
    "skills",
    "agents",
    "commands",
    "plugins",
    "hooks",
    "rules",
    "output-styles",
    "workflows",
    "agent-memory",
    "themes",
    "ide",
    "jobs",
    "daemon",
    "local",
    "mods",
    "dev-mods",
];

/// The single `~/.claude` files Claude Code loads as instructions or config,
/// or reads managed settings from, denied the same way. `.credentials.json`
/// is not one: it stays writable when it exists (`CLAUDE_CREDENTIALS_FILE`).
const CLAUDE_CONFIG_FILES: &[&str] = &[
    "settings.json",
    "settings.local.json",
    "CLAUDE.md",
    "AGENTS.md",
    "keybindings.json",
    "remote-settings.json",
    "mcp.json",
    ".config.json",
];

/// The file the CLI keeps its login in where there is no Keychain. Granted
/// as a writable literal only when it already exists and passes
/// `resolve_state_file`, so a stage can refresh an expired token (a refresh
/// that can't be saved can sign the user out) but never create the file.
const CLAUDE_CREDENTIALS_FILE: &str = ".credentials.json";

/// The CLI's config dir: `CLAUDE_CONFIG_DIR` when set (`config`, an absolute
/// path), else `~/.claude`. Pure.
fn claude_dir(home: &str, config: Option<&str>) -> String {
    match config {
        Some(c) => {
            let c = c.trim_end_matches('/');
            if c.is_empty() { "/".to_string() } else { c.to_string() }
        }
        None => format!("{}/.claude", home.trim_end_matches('/')),
    }
}

/// The `CLAUDE_CONFIG_DIR` a sandboxed Claude stage's profile follows, from
/// the raw value the stage sees (`raw`): kept only when it is an absolute
/// path. Returns the kept dir and, for a value that isn't kept, the note for
/// the launch line. An empty value counts as unset. Pure.
pub fn claude_config_dir(raw: Option<&str>) -> (Option<String>, Option<String>) {
    match raw.map(str::trim).filter(|v| !v.is_empty()) {
        None => (None, None),
        Some(v) if Path::new(v).is_absolute() => (Some(v.to_string()), None),
        Some(v) => (None, Some(format!("CLAUDE_CONFIG_DIR {v} is not an absolute path, so ~/.claude was used"))),
    }
}

/// The lock files the CLI takes beside its config while it refreshes an
/// expired login (`.oauth_refresh.lock` and its `.oauth_refresh.lock.*`
/// sidecars, such as `.oauth_refresh.lock.owner.tmp.<pid>`), as an SBPL
/// regex for each of `bases` (`claude_dir_bases`). A sidecar name can't hold
/// a `/`, so nothing below a lock path matches. Allowed for `file-write*`
/// only, never `file-link`. Pure.
fn oauth_lock_regexes(bases: &[String]) -> Vec<String> {
    bases
        .iter()
        .map(|b| format!("^{}/\\.oauth_refresh\\.lock(\\.[^/]*)?$", regex_escape(b.trim_end_matches('/'))))
        .collect()
}

/// The writable directory *subtrees* a real CLI process needs regardless of the
/// mission — the temp dir, `/dev`, and the Claude CLI's own state dirs
/// (`CLAUDE_STATE_DIRS`, never `~/.claude` as a whole). Kept deliberately
/// narrow: `~/.ssh`, `~/.aws`, `~/.config` (credentials), the shared
/// `~/.cache` (a sandboxed build's `XDG_CACHE_HOME` points into its own cache
/// root instead, `sandbox_cache_env`), documents, and every other project stay
/// read-only. Pure over its inputs.
///
/// Seatbelt matches the kernel-resolved (realpath) path, so only the `/private`
/// forms are live rules — `/tmp`→`/private/tmp`, `$TMPDIR`→`/private/var/…`. We
/// list the real form here; the exact `$TMPDIR` subtree's canonical form is added
/// by `assemble_write_roots`, so we don't blanket-allow all of `/var/folders`.
fn system_write_roots(home: Option<&str>, tmpdir: Option<&str>, config: Option<&str>) -> Vec<String> {
    let mut v = vec!["/dev".to_string(), "/private/tmp".to_string()];
    if let Some(t) = tmpdir {
        v.push(t.to_string());
    }
    if let Some(h) = home {
        v.extend(claude_state_dirs(&claude_dir(h, config)));
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

/// `<claude>/<dir>` for each of `CLAUDE_STATE_DIRS`, where `claude` is the
/// CLI's config dir (`claude_dir`). Pure.
fn claude_state_dirs(claude: &str) -> Vec<String> {
    let c = claude.trim_end_matches('/');
    CLAUDE_STATE_DIRS.iter().map(|d| format!("{c}/{d}")).collect()
}

/// The CLI's config dir `claude` as given and, when it differs, as its
/// realpath (seatbelt matches realpaths, so a symlinked dir needs both).
fn claude_dir_bases(claude: &str) -> Vec<String> {
    let given = claude.trim_end_matches('/').to_string();
    let real = canonical_string(Path::new(&given));
    if real == given { vec![given] } else { vec![given, real] }
}

/// The bases whose config entries are denied: `~/.claude` and, when set, the
/// `CLAUDE_CONFIG_DIR` (`config`), each as given and as its realpath.
fn claude_deny_bases(home: &str, config: Option<&str>) -> Vec<String> {
    let mut v = claude_dir_bases(&claude_dir(home, None));
    if let Some(c) = config {
        v.extend(claude_dir_bases(&claude_dir(home, Some(c))));
    }
    v.sort();
    v.dedup();
    v
}

/// The write denies that keep Claude Code's own config shut (#774), rendered
/// after every allow like the root denies, for each of `bases`
/// (`claude_dir_bases`): `~/.claude` itself as a path, each of
/// `CLAUDE_CONFIG_DIRS` as a subtree, each of `CLAUDE_CONFIG_FILES`, the
/// cached managed-policy files (`policy-limits.json` and its sidecars), and
/// every project's auto memory (`projects/<p>/memory`, loaded into each later
/// session of that project), also under each of `projects` (the realpaths of
/// `~/.claude/projects`, for one linked elsewhere). Pure.
fn claude_config_denies(bases: &[String], projects: &[String]) -> WriteRules {
    let mut rules = WriteRules::default();
    for p in projects {
        let p = regex_escape(p.trim_end_matches('/'));
        rules.deny_regexes.push(format!("^{p}/[^/]+/memory(/|$)"));
    }
    for b in bases {
        let b = b.trim_end_matches('/');
        rules.deny_literals.push(b.to_string());
        rules.deny_subpaths.extend(CLAUDE_CONFIG_DIRS.iter().map(|d| format!("{b}/{d}")));
        rules.deny_literals.extend(CLAUDE_CONFIG_FILES.iter().map(|f| format!("{b}/{f}")));
        let re = regex_escape(b);
        rules.deny_regexes.push(format!("^{re}/policy-limits\\.json"));
        rules.deny_regexes.push(format!("^{re}/projects/[^/]+/memory(/|$)"));
    }
    rules.dedup();
    rules
}

/// Why the `~/.claude` state dir `root`, granted as `paths` (as given and as
/// its realpath), must be left out: it is, or holds, `~/.claude` itself, or it
/// is, holds or sits inside one of Claude Code's config entries
/// (`CLAUDE_CONFIG_DIRS`, `CLAUDE_CONFIG_FILES`), as given or resolved. A
/// `~/.claude/projects` linked to `~/.claude` would otherwise make the whole
/// dir writable. `None` when it overlaps none. Reads the filesystem (realpaths).
fn claude_state_dir_conflict(root: &str, paths: &[String], bases: &[String]) -> Option<String> {
    let config: Vec<PathBuf> = bases
        .iter()
        .flat_map(|b| CLAUDE_CONFIG_DIRS.iter().chain(CLAUDE_CONFIG_FILES).map(move |n| Path::new(b).join(n)))
        .flat_map(|p| [canonical_lenient(&p), p])
        .collect();
    for p in paths.iter().map(Path::new) {
        if let Some(b) = bases.iter().find(|b| Path::new(b).starts_with(p)) {
            return Some(format!("{root} resolves to {b} or above it"));
        }
        if let Some(c) = config.iter().find(|c| p.starts_with(c) || c.starts_with(p)) {
            return Some(format!("{root} overlaps {}", c.display()));
        }
    }
    None
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
/// modes), and its sandboxed Codex homes. Called when the workspace is deleted. Never follows a symlink in
/// the workspace dir's place; a missing dir is fine.
pub fn remove_workspace_build_caches(scope: &str) -> std::io::Result<()> {
    remove_workspace_dirs(build_cache_base().as_deref(), stage_tmp_base().as_deref(), codex_home_base().as_deref(), scope)
}

/// [`remove_workspace_build_caches`] under the given bases: each removal runs
/// whether or not the one before it failed, so a build cache that can't be
/// removed never keeps the workspace's Codex homes (its sessions and its
/// sign-in copy) around; the first error is returned.
fn remove_workspace_dirs(
    cache_base: Option<&Path>,
    tmp_base: Option<&Path>,
    codex_base: Option<&Path>,
    scope: &str,
) -> std::io::Result<()> {
    let mut results = Vec::new();
    if let Some(base) = cache_base {
        let ws_dir = workspace_cache_dir(base, scope);
        if let Some(tmp_base) = tmp_base {
            results.push(remove_stage_tmps(&ws_dir, tmp_base));
        }
        results.push(remove_cache_dir(&ws_dir));
    }
    if let Some(codex) = codex_base {
        results.push(remove_cache_dir(&workspace_cache_dir(codex, scope)));
    }
    results.into_iter().collect::<std::io::Result<Vec<()>>>().map(drop)
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

/// Remove the build caches, stage temp dirs and sandboxed Codex homes unused
/// for longer than `max_age`; returns how many went. Run once on launch, off the main thread.
pub fn prune_build_caches(max_age: std::time::Duration) -> usize {
    let now = std::time::SystemTime::now();
    let caches = build_cache_base().map_or(0, |base| prune_cache_base(&base, now, max_age));
    let tmps = stage_tmp_base().map_or(0, |base| prune_tmp_base(&base, now, max_age));
    // Codex homes are laid out like the build cache, and each launch marks
    // its home as just used (`ensure_cache_root`).
    let codex = codex_home_base().map_or(0, |base| prune_cache_base(&base, now, max_age));
    caches + tmps + codex
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
        // The shared `~/.cache` is not a write root (#774): XDG-aware tools
        // (pre-commit, uv, Hugging Face, torch, …) cache here instead, and so
        // do the few that ignore `XDG_CACHE_HOME`.
        ("XDG_CACHE_HOME".into(), format!("{base}/xdg-cache")),
        ("PRE_COMMIT_HOME".into(), format!("{base}/xdg-cache/pre-commit")),
        ("UV_CACHE_DIR".into(), format!("{base}/xdg-cache/uv")),
    ]
}

/// Env for a sandboxed Claude stage (#774): auto memory off, since
/// `projects/<p>/memory` is denied (`claude_config_denies`) and the CLI would
/// otherwise create it at start and offer the model a memory it can't write.
/// Pure.
pub fn claude_stage_env() -> Vec<(String, String)> {
    vec![("CLAUDE_CODE_DISABLE_AUTO_MEMORY".into(), "1".into())]
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

// ─── A sandboxed Codex stage's own CODEX_HOME (#784) ───────────────────────

/// Where each sandboxed Codex stage's own `CODEX_HOME` lives:
/// `~/Library/Caches/octopush/codex-home/<workspace>/<mode>`, laid out like
/// the build cache (`codex_home_dir`). Not a write root: only the stage's own
/// home is added to its profile, so a stage never writes another
/// workspace's or access mode's Codex sessions. Codex writes its session
/// rollouts, thread-writer locks, `.tmp`, logs and its state DB there, never
/// in the user's `~/.codex`.
fn codex_home_base() -> Option<PathBuf> {
    dirs::cache_dir().map(|d| d.join("octopush").join("codex-home"))
}

/// The single files in a Codex home that Codex reads back as config,
/// instructions, credentials, env, model metadata or managed config, denied
/// in the stage's own home and in the user's Codex home (`codex_home_rules`),
/// matched case-insensitively (`ci_regex`: the home sits on a
/// case-insensitive volume, where `AGENTS.MD` is `AGENTS.md`). Every
/// top-level `*.toml` and every `managed-config-<ns>.json` is denied too
/// (`codex_home_patterns`). From an audit of openai/codex
/// (`codex-rs`, Nov 2026): `.env` is loaded into Codex's env at start;
/// `models_cache.json` carries each model's `base_instructions` (the system
/// prompt) and a planted future `fetched_at` never goes stale;
/// `cloud-config-bundle-cache.json` and `managed-config-<ns>.json` are
/// cached managed config whose HMAC key ships in the binary. `config.toml`
/// and `auth.json` in the stage's home are Octopush's read-only copies
/// (`prepare_codex_home`).
const CODEX_HOME_DENIED_FILES: &[&str] = &[
    "auth.json",
    "AGENTS.md",
    "AGENTS.override.md",
    "instructions.md",
    "hooks.json",
    ".env",
    "models_cache.json",
    "cloud-config-bundle-cache.json",
    ".tmp/plugins.sha",
    ".tmp/plugin-share-local-paths-v1.json",
];

/// The Codex home dirs Codex reads back as prompts, rules, skills, memories,
/// plugins (and their marketplaces and curated copies under `.tmp`), hooks,
/// agents, secrets, tool and plugin catalogs (`cache/`), installed packages
/// or its network proxy's CA, denied as subtrees the same way. Codex's own
/// writes there (installing its bundled skills into `skills/.system`,
/// syncing curated plugins into `.tmp/plugins`, caching tool catalogs) fail,
/// and Codex logs that and carries on (`ext/skills`
/// `ensure_system_skills_installed`, `core-plugins` `startup_sync`).
const CODEX_HOME_DENIED_DIRS: &[&str] = &[
    "prompts",
    "rules",
    "skills",
    "migrated-command-skills",
    "memories",
    "memories_v2",
    "memories_extensions",
    "plugins",
    "hooks",
    "agents",
    "secrets",
    "cache",
    "packages",
    "proxy",
    ".tmp/marketplaces",
    ".tmp/plugins",
];

/// The dirs Octopush creates in a stage's home and pins (denied as a path),
/// because denied paths sit inside them: a stage that could swap `.tmp` for
/// a link would move `.tmp/plugins` out from under its rule.
const CODEX_HOME_PINNED_DIRS: &[&str] = &[".tmp"];

/// The user's Codex config, copied read-only into the stage's home on every
/// launch.
const CODEX_CONFIG_FILE: &str = "config.toml";

/// Codex's sign-in file: in the stage's home only as a read-only copy of a
/// ChatGPT sign-in without its refresh token (`codex_auth_plan`).
const CODEX_AUTH_FILE: &str = "auth.json";

/// The largest `config.toml` or `auth.json` Octopush copies.
const CODEX_SOURCE_MAX_BYTES: u64 = 1 << 20;

/// A ChatGPT sign-in older than this (`last_refresh`) fails the stage before
/// it starts. Codex refreshes the tokens itself once they are 8 days old
/// (openai/codex `login/src/auth/manager.rs` `TOKEN_REFRESH_INTERVAL`), and a
/// sandboxed stage must never attempt that rotating refresh.
pub const CODEX_SIGN_IN_MAX_AGE_DAYS: i64 = 7;

/// A ChatGPT access token that expires sooner than this also fails the stage
/// before it starts: Codex refreshes 5 minutes before it expires.
const CODEX_ACCESS_TOKEN_MIN_LEFT_HOURS: i64 = 24;

/// The stage failure when the ChatGPT sign-in is too old for a sandboxed
/// stage (the user's own Codex refreshes it).
pub const CODEX_REFRESH_SIGN_IN: &str = "Open Codex once to refresh sign-in";

/// The stage failure when Codex's sign-in can't be read or parsed.
pub const CODEX_SIGN_IN_UNREADABLE: &str = "Octopush couldn't read Codex's sign-in (auth.json), so this sandboxed \
     stage can't sign in. Open Codex once to check your sign-in.";

/// The stage failure for a sign-in a sandboxed stage can't use.
pub const CODEX_SIGN_IN_UNSUPPORTED: &str = "This sandboxed stage can't use Codex's saved sign-in. Sign in to Codex \
     with ChatGPT or an API key, or give this stage a Claude model.";

/// A sandboxed Codex stage's `CODEX_HOME` under `base`: one per workspace
/// (`scope`), write roots and tenant, keyed exactly like the stage's build
/// cache (`mission_cache_root`), so a readonly mission never shares the
/// writer's sessions and a resumed stage finds its own. Pure.
pub(crate) fn codex_home_dir(base: &Path, scope: &str, write_roots: &[String], tenant: CacheTenant) -> PathBuf {
    mission_cache_root(base, scope, write_roots, tenant)
}

/// `s` as an SBPL regex that matches every name the way a case-insensitive
/// APFS volume compares names (`name_fold::fold`, #1270): each spelling is
/// a run of the characters `name_fold::forms_at` gives, so a letter is also
/// its other case, `k` and `s` the Kelvin sign and the long s, and `ff`,
/// `fi`, `fl`, `ffi`, `ffl`, `st` and `ss` their ligatures. What still isn't
/// ASCII once folded (a mark, a letter of another script) can't be spelled
/// out: it, the ASCII letters on either side of it (a composed character or
/// a ligature can take them in) and the character before it (a mark's
/// base) match any run of characters but `/`, so the regex denies the whole
/// family of names. Pure.
fn ci_regex(s: &str) -> String {
    let folded: Vec<char> = crate::name_fold::fold(s).chars().collect();
    let mut family = vec![false; folded.len()];
    for i in (0..folded.len()).filter(|&i| !folded[i].is_ascii()) {
        family[i] = true;
        let mut j = i;
        while j > 0 && folded[j - 1].is_ascii_alphabetic() {
            j -= 1;
            family[j] = true;
        }
        if j == i && j > 0 && folded[j - 1] != '/' {
            family[j - 1] = true;
        }
        let mut k = i + 1;
        while k < folded.len() && folded[k].is_ascii_alphabetic() {
            family[k] = true;
            k += 1;
        }
    }
    let mut out = String::new();
    let mut start = 0;
    while start < folded.len() {
        let end = (start..folded.len()).find(|&i| family[i] != family[start]).unwrap_or(folded.len());
        if family[start] {
            out.push_str("[^/]+");
        } else {
            out.push_str(&ascii_ci_regex(&folded[start..end].iter().collect::<String>()));
        }
        start = end;
    }
    out
}

/// [`ci_regex`] of the ASCII `s`: cut into the shortest stretches no
/// ligature crosses, each written as the alternation of its spellings.
fn ascii_ci_regex(s: &str) -> String {
    let folded = crate::name_fold::fold(s);
    let longest = |i: usize| crate::name_fold::forms_at(&folded[i..]).iter().map(|(n, _)| *n).max().unwrap_or(1);
    let mut out = String::new();
    let mut start = 0;
    while start < folded.len() {
        let (mut i, mut end) = (start, start + 1);
        while i < end {
            end = end.max(i + longest(i));
            i += 1;
        }
        match spellings(&folded[start..end]).as_slice() {
            [one] => out.push_str(one),
            many => out.push_str(&format!("({})", many.join("|"))),
        }
        start = end;
    }
    out
}

/// Every spelling of the folded ASCII `stretch` as regexes, one per way to
/// cut it into the characters `name_fold::forms_at` gives.
fn spellings(stretch: &str) -> Vec<String> {
    if stretch.is_empty() {
        return vec![String::new()];
    }
    let mut v = Vec::new();
    for (n, forms) in crate::name_fold::forms_at(stretch) {
        let head = match forms.as_slice() {
            [one] => regex_escape(&one.to_string()),
            _ if forms.iter().all(char::is_ascii_alphabetic) => format!("[{}]", forms.iter().collect::<String>()),
            _ => format!("({})", forms.iter().map(|c| regex_escape(&c.to_string())).collect::<Vec<_>>().join("|")),
        };
        v.extend(spellings(&stretch[n..]).into_iter().map(|tail| format!("{head}{tail}")));
    }
    v
}

/// The deny regexes for the Codex home `base` (as given): every file of
/// `CODEX_HOME_DENIED_FILES`, every dir of `CODEX_HOME_DENIED_DIRS` with
/// everything under it, every top-level `*.toml` (`config.toml`,
/// `managed_config.toml`, `requirements.toml`, `environments.toml`, a
/// `<profile>.config.toml`) and every `managed-config-<ns>.json`, all
/// case-insensitive. Pure.
fn codex_home_patterns(base: &str) -> Vec<String> {
    let b = regex_escape(base.trim_end_matches('/'));
    let mut v: Vec<String> = CODEX_HOME_DENIED_FILES.iter().map(|f| format!("^{b}/{}$", ci_regex(f))).collect();
    v.extend(CODEX_HOME_DENIED_DIRS.iter().map(|d| format!("^{b}/{}(/|$)", ci_regex(d))));
    v.push(format!("^{b}/[^/]*{}$", ci_regex(".toml")));
    v.push(format!("^{b}/{}[^/]*{}$", ci_regex("managed-config-"), ci_regex(".json")));
    v
}

/// The write rules for a sandboxed Codex stage: its own home `home` (a
/// realpath) is writable; the home dir itself is denied as a literal (so it
/// can't be renamed or swapped for a link that would widen the next stage's
/// profile) and its pinned dirs (`CODEX_HOME_PINNED_DIRS`) as paths; and in
/// it and in each of `user_homes` (the user's Codex home, as given and as its
/// realpath) every entry of `codex_home_patterns` is denied, the user's home
/// dir itself too. Pure.
fn codex_home_rules(home: &str, user_homes: &[String]) -> WriteRules {
    let home = home.trim_end_matches('/').to_string();
    let mut rules = WriteRules { subpaths: vec![home.clone()], ..WriteRules::default() };
    let pinned = regex_escape(&home);
    rules.deny_regexes.extend(CODEX_HOME_PINNED_DIRS.iter().map(|d| format!("^{pinned}/{}$", ci_regex(d))));
    let bases = std::iter::once(home).chain(user_homes.iter().map(|u| u.trim_end_matches('/').to_string()));
    for b in bases.filter(|b| !b.is_empty()) {
        rules.deny_regexes.extend(codex_home_patterns(&b));
        rules.deny_literals.push(b);
    }
    rules.dedup();
    rules
}

/// Whether `name` (one entry of a stage's Codex home, read through
/// `name_fold::fold` as the volume compares it) is one the profile denies,
/// other than Octopush's own copies: those go before each launch
/// (`purge_denied_entries`). Pure.
fn is_denied_top_level(name: &str) -> bool {
    let n = crate::name_fold::fold(name);
    if n == CODEX_CONFIG_FILE || n == CODEX_AUTH_FILE {
        return false;
    }
    let listed = |list: &[&str]| list.iter().any(|e| !e.contains('/') && e.eq_ignore_ascii_case(&n));
    listed(CODEX_HOME_DENIED_FILES)
        || listed(CODEX_HOME_DENIED_DIRS)
        || n.ends_with(".toml")
        || (n.starts_with("managed-config-") && n.ends_with(".json"))
}

/// Remove `path` without following a link: a dir with everything in it,
/// anything else as an entry. A missing one is fine.
fn remove_entry(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Remove, outside the sandbox before each launch, every entry of the stage's
/// Codex home `home` that the profile denies (bar Octopush's two copies, which
/// are rewritten next): the top-level ones (`is_denied_top_level`) and the
/// denied paths under the pinned dirs. The profile keeps a stage from
/// creating any of them; this also clears one that got there some other way,
/// so Codex never reads it. Each listed name is also looked up as written,
/// so the volume's own case folding finds a variant the listing missed.
fn purge_denied_entries(home: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(home)?.flatten() {
        if is_denied_top_level(&entry.file_name().to_string_lossy()) {
            remove_entry(&entry.path())?;
        }
    }
    for name in CODEX_HOME_DENIED_FILES.iter().chain(CODEX_HOME_DENIED_DIRS) {
        if *name != CODEX_AUTH_FILE {
            remove_entry(&home.join(name))?;
        }
    }
    Ok(())
}

/// How a sandboxed Codex stage signs in, decided before it starts
/// (`codex_auth_plan`). Its `Debug` never shows a secret.
#[derive(Clone, PartialEq, Eq)]
pub enum CodexAuthPlan {
    /// `CODEX_API_KEY` already reaches the stage (login shell or app env),
    /// and `codex exec` prefers it to any saved sign-in: nothing is copied.
    EnvKey,
    /// No saved sign-in: nothing is copied. Codex says it isn't signed in,
    /// unless the user's config points at a provider with its own env key.
    Nothing,
    /// An API-key sign-in: the key goes to the stage as `CODEX_API_KEY`,
    /// never into a file.
    ApiKey(String),
    /// A ChatGPT sign-in: `auth.json` with its refresh token blanked, written
    /// read-only into the stage's home, so Codex in the stage can never
    /// perform a rotating refresh. Reads aren't confined: a process in the
    /// stage can still read the user's own `auth.json`.
    ChatGpt(String),
}

impl std::fmt::Debug for CodexAuthPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            CodexAuthPlan::EnvKey => "EnvKey",
            CodexAuthPlan::Nothing => "Nothing",
            CodexAuthPlan::ApiKey(_) => "ApiKey(<redacted>)",
            CodexAuthPlan::ChatGpt(_) => "ChatGpt(<redacted>)",
        })
    }
}

/// The `exp` claim of a JWT, read without checking its signature (the token
/// stays with Codex; this only decides whether a stage may start). `None`
/// when it isn't a JWT with a numeric `exp`. Pure.
fn jwt_expiry(token: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    chrono::DateTime::from_timestamp(claims.get("exp")?.as_i64()?, 0)
}

/// The unsandboxed sign-in preflight of a sandboxed Codex stage: how it signs
/// in, from whether `CODEX_API_KEY` reaches it (`env_key`) and the user's
/// `auth.json` (`auth_json`, `None` when there is none) at `now`. Mirrors
/// Codex's own mode resolution (`AuthDotJson::resolved_mode`): `auth_mode`
/// when set, else a personal access token or Bedrock key, else
/// `OPENAI_API_KEY`, else ChatGPT. Fails closed, with the stage's message:
/// [`CODEX_REFRESH_SIGN_IN`] when a ChatGPT sign-in was last refreshed more
/// than [`CODEX_SIGN_IN_MAX_AGE_DAYS`] ago (or not at all, or in an unknown
/// format) or its access token expires within a day;
/// [`CODEX_SIGN_IN_UNREADABLE`] for a file that isn't a JSON object;
/// [`CODEX_SIGN_IN_UNSUPPORTED`] for any other sign-in (external tokens,
/// agent identity, personal access tokens, Bedrock, an API-key mode with no
/// key). Pure.
pub fn codex_auth_plan(
    env_key: bool,
    auth_json: Option<&str>,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<CodexAuthPlan, &'static str> {
    use serde_json::Value;
    if env_key {
        return Ok(CodexAuthPlan::EnvKey);
    }
    let Some(text) = auth_json else { return Ok(CodexAuthPlan::Nothing) };
    let Ok(Value::Object(mut auth)) = serde_json::from_str::<Value>(text) else {
        return Err(CODEX_SIGN_IN_UNREADABLE);
    };
    let present = |k: &str| auth.get(k).is_some_and(|v| !v.is_null());
    let mode = match auth.get("auth_mode") {
        Some(Value::String(m)) => m.clone(),
        None | Some(Value::Null) if present("personal_access_token") || present("bedrock_api_key") || present("bedrock_access_keys") => {
            return Err(CODEX_SIGN_IN_UNSUPPORTED)
        }
        None | Some(Value::Null) if present("OPENAI_API_KEY") => "apikey".to_string(),
        None | Some(Value::Null) => "chatgpt".to_string(),
        Some(_) => return Err(CODEX_SIGN_IN_UNREADABLE),
    };
    match mode.as_str() {
        "apikey" => match auth.get("OPENAI_API_KEY").and_then(Value::as_str).map(str::trim) {
            Some(key) if !key.is_empty() => Ok(CodexAuthPlan::ApiKey(key.to_string())),
            _ => Err(CODEX_SIGN_IN_UNSUPPORTED),
        },
        "chatgpt" => {
            let Some(tokens) = auth.get_mut("tokens").filter(|t| !t.is_null()) else {
                return Ok(CodexAuthPlan::Nothing);
            };
            let Some(tokens) = tokens.as_object_mut() else { return Err(CODEX_SIGN_IN_UNREADABLE) };
            let Some(access) = tokens.get("access_token").and_then(Value::as_str) else {
                return Err(CODEX_SIGN_IN_UNREADABLE);
            };
            if jwt_expiry(access).is_some_and(|exp| exp <= now + chrono::Duration::hours(CODEX_ACCESS_TOKEN_MIN_LEFT_HOURS)) {
                return Err(CODEX_REFRESH_SIGN_IN);
            }
            tokens.insert("refresh_token".to_string(), Value::String(String::new()));
            let last = auth
                .get("last_refresh")
                .and_then(Value::as_str)
                .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                .map(|t| t.with_timezone(&chrono::Utc));
            match last {
                Some(t) if now - t <= chrono::Duration::days(CODEX_SIGN_IN_MAX_AGE_DAYS) => {
                    Ok(CodexAuthPlan::ChatGpt(Value::Object(auth).to_string()))
                }
                _ => Err(CODEX_REFRESH_SIGN_IN),
            }
        }
        _ => Err(CODEX_SIGN_IN_UNSUPPORTED),
    }
}

/// A user file Octopush copies into a stage's Codex home (`config.toml`,
/// `auth.json`): `None` when it doesn't exist. The checks and the read go
/// through one handle, so the file read is the one checked: it must be a
/// regular file (a link is followed, as Codex follows it) owned by `owner`
/// (this user) and at most [`CODEX_SOURCE_MAX_BYTES`].
fn read_user_file(path: &Path, owner: Option<u32>) -> std::io::Result<Option<Vec<u8>>> {
    use std::io::Read;
    let mut file = match std::fs::File::open(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        other => other?,
    };
    let meta = file.metadata()?;
    let refuse = |why: &str| std::io::Error::other(format!("{} {why}", path.display()));
    if !meta.is_file() {
        return Err(refuse("is not a regular file"));
    }
    if !owned_by(&meta, owner) {
        return Err(refuse("is not owned by you"));
    }
    let mut bytes = Vec::new();
    (&mut file).take(CODEX_SOURCE_MAX_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > CODEX_SOURCE_MAX_BYTES {
        return Err(refuse("is too large to copy"));
    }
    Ok(Some(bytes))
}

/// Put `contents` at `<home>/<name>` as a read-only (0400) file, or remove
/// what is there when `contents` is `None`. The copy is written in `staging`
/// (the home's parent, which no stage can write, so no running stage can
/// change it before it lands), created fresh with `O_EXCL | O_NOFOLLOW`, then
/// renamed into place: a rename replaces a link at `name` instead of writing
/// through it. Both dirs must be real directories owned by this user.
#[cfg(unix)]
fn install_read_only_copy(home: &Path, staging: &Path, name: &str, contents: Option<&[u8]>) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    check_own_dir(home)?;
    check_own_dir(staging)?;
    let dest = home.join(name);
    let Some(bytes) = contents else {
        return match std::fs::remove_file(&dest) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        };
    };
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let key = home.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = staging.join(format!(".{key}.{name}.{}-{nanos}", std::process::id()));
    let written = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o400)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, &dest)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

#[cfg(not(unix))]
fn install_read_only_copy(_home: &Path, _staging: &Path, _name: &str, _contents: Option<&[u8]>) -> std::io::Result<()> {
    Err(std::io::Error::other("a sandboxed Codex home needs macOS"))
}

/// A sandboxed Codex stage's own home, ready for its profile and env.
#[derive(Clone, PartialEq, Eq)]
pub struct CodexHome {
    /// The stage's `CODEX_HOME`: a realpath `ensure_cache_root` checked.
    pub dir: String,
    /// The user's own Codex home, as given and as its realpath: its config,
    /// instructions and credentials are denied in the profile too.
    pub user_home: Vec<String>,
    /// `CODEX_HOME` and `CODEX_SQLITE_HOME` (both the stage's home) and, for
    /// an API-key sign-in, `CODEX_API_KEY`.
    pub env: Vec<(String, String)>,
    /// The `-c` overrides that keep the state DB and logs in the stage's
    /// home even when the user's `config.toml` sets `sqlite_home` or
    /// `log_dir` (`codex_home_overrides`).
    pub args: Vec<String>,
}

/// The `-c` overrides for a stage's Codex home `dir`: `sqlite_home` and
/// `log_dir`, which a user's `config.toml` would otherwise point at a dir
/// shared by every workspace (a `-c` override wins over `config.toml`; Codex
/// ignores keys it doesn't know, so an older Codex starts all the same). The
/// values are TOML strings; a JSON string is one. Pure.
pub fn codex_home_overrides(dir: &str) -> Vec<String> {
    let toml = |p: &str| serde_json::to_string(p).unwrap_or_else(|_| "\"\"".to_string());
    let dir = dir.trim_end_matches('/');
    vec![
        "-c".to_string(),
        format!("sqlite_home={}", toml(dir)),
        "-c".to_string(),
        format!("log_dir={}", toml(&format!("{dir}/log"))),
    ]
}

impl std::fmt::Debug for CodexHome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let names: Vec<&str> = self.env.iter().map(|(k, _)| k.as_str()).collect();
        f.debug_struct("CodexHome")
            .field("dir", &self.dir)
            .field("user_home", &self.user_home)
            .field("env", &names)
            .field("args", &self.args)
            .finish()
    }
}

/// Why a sandboxed Codex stage's home couldn't be prepared.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexHomeError {
    /// The sign-in preflight failed: the stage's whole failure message.
    SignIn(&'static str),
    /// The home or a copy couldn't be made safely.
    Setup(String),
}

/// Prepare a sandboxed Codex stage's own `CODEX_HOME`, outside the sandbox
/// and before its profile is built: run the sign-in preflight
/// (`codex_auth_plan`, on the user's `auth.json` in `user_home`, the user's
/// Codex home, which must be absolute), create the home (`codex_home_dir`,
/// with `ensure_cache_root`'s `O_NOFOLLOW`, owner and 0700 checks), copy the
/// user's `config.toml` into it read-only (removing a stale copy when there
/// is none), write or remove the sign-in copy, and return the env. `env_key`:
/// `CODEX_API_KEY` already reaches the stage.
pub fn prepare_codex_home(
    scope: &str,
    write_roots: &[String],
    tenant: CacheTenant,
    user_home: &Path,
    env_key: bool,
) -> Result<CodexHome, CodexHomeError> {
    let base = codex_home_base().ok_or_else(|| CodexHomeError::Setup("no cache directory for Codex's home".into()))?;
    prepare_codex_home_in(&base, scope, write_roots, tenant, user_home, env_key, chrono::Utc::now())
}

/// [`prepare_codex_home`] under `base` at `now`.
fn prepare_codex_home_in(
    base: &Path,
    scope: &str,
    write_roots: &[String],
    tenant: CacheTenant,
    user_home: &Path,
    env_key: bool,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<CodexHome, CodexHomeError> {
    let setup = CodexHomeError::Setup;
    if !user_home.is_absolute() {
        return Err(setup(format!("CODEX_HOME {} is not an absolute path", user_home.display())));
    }
    let user_real = canonical_lenient(user_home);
    if user_real.starts_with(canonical_lenient(base)) {
        return Err(setup(format!("CODEX_HOME {} is inside Octopush's own Codex homes", user_home.display())));
    }
    // The preflight runs before anything is created or copied.
    let auth = match env_key {
        true => None,
        false => read_user_file(&user_home.join(CODEX_AUTH_FILE), current_uid()).map_err(|_| CodexHomeError::SignIn(CODEX_SIGN_IN_UNREADABLE))?,
    };
    let auth_text = auth
        .as_deref()
        .map(std::str::from_utf8)
        .transpose()
        .map_err(|_| CodexHomeError::SignIn(CODEX_SIGN_IN_UNREADABLE))?;
    let plan = codex_auth_plan(env_key, auth_text, now).map_err(CodexHomeError::SignIn)?;
    let config = read_user_file(&user_home.join(CODEX_CONFIG_FILE), current_uid())
        .map_err(|e| setup(format!("couldn't read your Codex config: {e}")))?;
    let home = ensure_cache_root(&codex_home_dir(base, scope, write_roots, tenant))
        .map_err(|e| setup(format!("couldn't set up Codex's home for this stage: {e}")))?;
    let staging = home.parent().ok_or_else(|| setup("Codex's home has no parent".into()))?;
    for name in CODEX_HOME_PINNED_DIRS {
        let dir = home.join(name);
        create_dir_0700(&dir)
            .and_then(|()| check_own_dir(&dir))
            .map_err(|e| setup(format!("couldn't set up Codex's home for this stage: {e}")))?;
    }
    purge_denied_entries(&home).map_err(|e| setup(format!("couldn't clear Codex's home for this stage: {e}")))?;
    install_read_only_copy(&home, staging, CODEX_CONFIG_FILE, config.as_deref())
        .map_err(|e| setup(format!("couldn't copy your Codex config: {e}")))?;
    let auth_copy = match &plan {
        CodexAuthPlan::ChatGpt(json) => Some(json.as_bytes()),
        _ => None,
    };
    install_read_only_copy(&home, staging, CODEX_AUTH_FILE, auth_copy)
        .map_err(|e| setup(format!("couldn't copy Codex's sign-in: {e}")))?;
    let dir = home.to_string_lossy().into_owned();
    let mut env = vec![("CODEX_HOME".to_string(), dir.clone()), ("CODEX_SQLITE_HOME".to_string(), dir.clone())];
    if let CodexAuthPlan::ApiKey(key) = plan {
        env.push(("CODEX_API_KEY".to_string(), key));
    }
    let mut user = vec![user_home.to_string_lossy().into_owned(), user_real.to_string_lossy().into_owned()];
    user.dedup();
    let args = codex_home_overrides(&dir);
    Ok(CodexHome { dir, user_home: user, env, args })
}

/// Writable individual *files* (as opposed to subtrees). Seatbelt's `subpath`
/// won't cover a bare file sibling of an allowed dir, so the CLI's top-level
/// `~/.claude.json` state file (`<CLAUDE_CONFIG_DIR>/.claude.json` when
/// `config` is set) needs its own `literal` rule.
fn system_write_files(home: Option<&str>, config: Option<&str>) -> Vec<String> {
    match (home, config) {
        (Some(h), Some(c)) => vec![format!("{}/.claude.json", claude_dir(h, Some(c)))],
        (Some(h), None) => vec![format!("{h}/.claude.json")],
        (None, _) => Vec::new(),
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
/// the build-cache base, the stage temp base and the Codex home base, each as
/// given and as its realpath. A stage must never write another stage's cache
/// root, temp dir or Codex home.
fn private_bases() -> Vec<PathBuf> {
    let mut v = Vec::new();
    for base in [build_cache_base(), stage_tmp_base(), codex_home_base()].into_iter().flatten() {
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
/// (`~/.claude.json`, or `.credentials.json` in the CLI's config dir): the
/// file as given and, when it differs, its realpath. A file that doesn't
/// exist yet is granted as given (the caller checks first where that must not
/// happen). Fails closed, with the reason, when it doesn't resolve, isn't a
/// regular file, has another hard link, isn't owned by `owner`, or is a
/// symlink to anything outside `claude` (the CLI's config dir, `claude_dir`;
/// a path-component prefix: `~/.claude-old` is outside `~/.claude`).
fn resolve_state_file(file: &str, claude: &str, owner: Option<u32>) -> Result<Vec<String>, String> {
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
        let dot_claude = canonical_lenient(Path::new(claude));
        if !Path::new(&real).starts_with(&dot_claude) {
            return Err(format!("{file} links outside {claude}"));
        }
    }
    Ok(if real == file { vec![real] } else { vec![file.to_string(), real] })
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
    /// Writable single files (`~/.claude.json`, an existing
    /// `.credentials.json`, and their realpaths).
    files: Vec<String>,
    /// Writable path regexes (`file-write*` only): the CLI's login-refresh
    /// lock files beside its config (`oauth_lock_regexes`).
    regexes: Vec<String>,
    /// Why a system root or file was left out, one line each.
    refused: Vec<String>,
}

/// Merge the mission's write roots with the system defaults, add canonical forms
/// (seatbelt matches realpaths, so a symlinked root must appear resolved too),
/// and de-duplicate. The system roots and the state file go through
/// [`resolve_system_root`] / [`resolve_state_file`] (user-home ones checked
/// against `owner`, none allowed to hold one of `private`); one that fails is
/// left out (fail closed) and its reason recorded in `refused`. The CLI's
/// config dir (`~/.claude`, or `config`, the stage's `CLAUDE_CONFIG_DIR`)
/// goes through [`resolve_system_root`] too, owner-checked: when it fails,
/// its state dirs, files and lock files are all left out with one reason.
/// Reads the filesystem, writes nothing.
fn assemble_write_roots(
    mission_roots: &[String],
    home: Option<&str>,
    tmpdir: Option<&str>,
    config: Option<&str>,
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
    let claude = home.map(|h| claude_dir(h, config));
    let state_dirs = claude.as_deref().map(claude_state_dirs).unwrap_or_default();
    let deny_bases = home.map(|h| claude_deny_bases(h, config)).unwrap_or_default();
    // The config dir itself: its realpath must be a dir of the user's that
    // is not `$HOME` or above it, under `~/.config` or the like.
    let claude_ok = match &claude {
        Some(c) => match resolve_system_root(c, home, owner, private) {
            Ok(paths) => {
                out.regexes.extend(oauth_lock_regexes(&paths));
                true
            }
            Err(why) => {
                out.refused.push(why);
                false
            }
        },
        None => false,
    };
    for r in system_write_roots(home, tmpdir, config) {
        let is_state_dir = state_dirs.contains(&r);
        if is_state_dir && !claude_ok {
            continue;
        }
        let check_owner = if in_home(&r) || is_state_dir { owner } else { None };
        let resolved = resolve_system_root(&r, home, check_owner, private).and_then(|paths| match is_state_dir {
            true => claude_state_dir_conflict(&r, &paths, &deny_bases).map_or(Ok(paths), Err),
            false => Ok(paths),
        });
        match resolved {
            Ok(paths) => {
                out.subpaths.extend(paths.iter().cloned());
                out.system_roots.extend(paths);
            }
            Err(why) => out.refused.push(why),
        }
    }
    if let Some(c) = claude.as_deref() {
        let mut files = Vec::new();
        // `~/.claude.json` sits in `$HOME`, outside the config dir, unless
        // `CLAUDE_CONFIG_DIR` is set.
        if claude_ok || config.is_none() {
            files.extend(system_write_files(home, config));
        }
        // An existing login file only: a missing one is never created.
        let credentials = format!("{c}/{CLAUDE_CREDENTIALS_FILE}");
        if claude_ok && std::fs::symlink_metadata(&credentials).is_ok() {
            files.push(credentials);
        }
        for f in files {
            match resolve_state_file(&f, c, owner) {
                Ok(paths) => out.files.extend(paths),
                Err(why) => out.refused.push(why),
            }
        }
    }
    for v in [&mut out.subpaths, &mut out.system_roots, &mut out.files, &mut out.regexes] {
        v.sort();
        v.dedup();
    }
    out
}

/// Create the user-home write roots, the `~/.claude` state dirs
/// (`CLAUDE_STATE_DIRS`), when they don't exist yet, outside the sandbox and
/// before the profile is built: a stage can't create entries in `~/.claude`
/// itself, and never gets to create a root entry. With `config` (the stage's
/// `CLAUDE_CONFIG_DIR`), that dir takes `~/.claude`'s place. The config dir
/// is created first when missing (the last component only), then resolved
/// with the same checks as a system root (`resolve_system_root`: a real dir
/// of the user's, not `$HOME` or above it); the state dirs are made in its
/// realpath, and only when it passes. Each `create_dir` never follows a link
/// in the dir's place, a new dir is owner-only (0700, as the CLI makes them),
/// and it must be a real directory of the user's. An existing dir is left as
/// it is. Best-effort: a dir that can't be made is still resolved (and
/// checked) as usual.
fn ensure_home_roots(home: &str, config: Option<&str>) {
    let claude = PathBuf::from(claude_dir(home, config));
    if std::fs::symlink_metadata(&claude).is_err() {
        if let Err(e) = create_dir_0700(&claude).and_then(|()| check_own_dir(&claude)) {
            tracing::warn!(dir = %claude.display(), error = %e, "sandbox: couldn't create the Claude config dir");
            return;
        }
    }
    let claude_str = claude.to_string_lossy();
    let base = match resolve_system_root(&claude_str, Some(home), current_uid(), &private_bases()) {
        Ok(paths) => PathBuf::from(paths.last().cloned().unwrap_or_else(|| claude_str.to_string())),
        Err(why) => {
            tracing::warn!(reason = %why, "sandbox: not creating the ~/.claude state dirs");
            return;
        }
    };
    for name in CLAUDE_STATE_DIRS {
        let dir = base.join(name);
        if std::fs::symlink_metadata(&dir).is_ok() {
            continue;
        }
        if let Err(e) = create_dir_0700(&dir).and_then(|()| check_own_dir(&dir)) {
            tracing::warn!(dir = %dir.display(), error = %e, "sandbox: couldn't create a write root");
        }
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
    /// Re-allowed for `file-write*` only (never `file-link`).
    regexes: Vec<String>,
    deny_subpaths: Vec<String>,
    deny_literals: Vec<String>,
    deny_regexes: Vec<String>,
}

impl WriteRules {
    fn extend(&mut self, other: WriteRules) {
        self.subpaths.extend(other.subpaths);
        self.literals.extend(other.literals);
        self.regexes.extend(other.regexes);
        self.deny_subpaths.extend(other.deny_subpaths);
        self.deny_literals.extend(other.deny_literals);
        self.deny_regexes.extend(other.deny_regexes);
    }

    fn dedup(&mut self) {
        for v in [
            &mut self.subpaths,
            &mut self.literals,
            &mut self.regexes,
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
/// may point into `$TMPDIR` or `~/.cache`), `info/`, the legacy `remotes/` and
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
        regexes: Vec::new(),
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
    if !rules.subpaths.is_empty() || !rules.literals.is_empty() || !rules.regexes.is_empty() {
        p.push_str("(allow file-write*\n");
        filters(&mut p, "subpath", &rules.subpaths);
        filters(&mut p, "literal", &rules.literals);
        filters(&mut p, "regex", &rules.regexes);
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
/// dirs (`/dev`, `/private/tmp`, `$TMPDIR`, the `~/.claude` state dirs) and
/// their realpaths are denied as paths the same way, and a system root or the
/// `~/.claude.json` state file that fails its check is left out with a
/// warning (see [`assemble_write_roots`]). Claude Code's own config in
/// `~/.claude` (skills, agents, hooks, settings, auto memory…) is denied after
/// every allow (`claude_config_denies`). Errors when a workspace's git
/// layout can't be resolved (fail closed).
pub fn build_seatbelt_profile(mission_write_roots: &[String], cache_roots: &[String]) -> AppResult<String> {
    seatbelt_profile_and_refusals(mission_write_roots, cache_roots, None, None).map(|(profile, _)| profile)
}

/// [`build_seatbelt_profile`], plus why each system root or state file left
/// out of the profile was refused (one line each), for the stage launch line.
/// The missing user-home roots are created only on macOS, the one platform
/// that runs the sandbox, so a test elsewhere never writes the real `$HOME`.
/// `claude_config` is a Claude stage's absolute `CLAUDE_CONFIG_DIR`
/// (`claude_config_dir`), which takes `~/.claude`'s place. `codex` is a Codex
/// stage's own home (`prepare_codex_home`, `codex_home_rules`).
fn seatbelt_profile_and_refusals(
    mission_write_roots: &[String],
    cache_roots: &[String],
    claude_config: Option<&str>,
    codex: Option<&CodexHome>,
) -> AppResult<(String, Vec<String>)> {
    let home = std::env::var("HOME").ok();
    let tmpdir = std::env::var("TMPDIR").ok();
    if let (true, Some(h)) = (cfg!(target_os = "macos"), home.as_deref()) {
        ensure_home_roots(h, claude_config);
    }
    profile_and_refusals_for(home.as_deref(), tmpdir.as_deref(), claude_config, codex, mission_write_roots, cache_roots)
}

/// [`seatbelt_profile_and_refusals`] for the given `$HOME`, `$TMPDIR`,
/// `CLAUDE_CONFIG_DIR` and Codex home, without creating anything. Reads the
/// filesystem (realpaths, git layouts).
fn profile_and_refusals_for(
    home: Option<&str>,
    tmpdir: Option<&str>,
    claude_config: Option<&str>,
    codex: Option<&CodexHome>,
    mission_write_roots: &[String],
    cache_roots: &[String],
) -> AppResult<(String, Vec<String>)> {
    let roots = assemble_write_roots(mission_write_roots, home, tmpdir, claude_config, current_uid(), &private_bases());
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
        regexes: roots.regexes,
        deny_literals,
        ..WriteRules::default()
    };
    if let Some(h) = home {
        let projects = canonical_string(&Path::new(&claude_dir(h, claude_config)).join("projects"));
        rules.extend(claude_config_denies(&claude_deny_bases(h, claude_config), &[projects]));
    }
    if let Some(c) = codex {
        rules.extend(codex_home_rules(&c.dir, &c.user_home));
    }
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
    prepare_with(write_roots, cache_scope, CacheTenant::InProcess, program, args, false, None, None, |_| Vec::new())
}

/// [`prepare`] for a CLI stage, whose dirs are keyed by `tenant`
/// ([`CacheTenant::Cli`]). With `private_tmp` (and a
/// `cache_scope`), the stage also gets its own temp dir (`stage_tmp_dir`,
/// 0700, writable in the profile) and `TMPDIR` pointing at it, instead of the
/// user-wide `$TMPDIR` every app and stage shares. `extra_args` gets the
/// stage's own dirs (cache root, then temp dir; empty without a
/// `cache_scope`) and its result is appended to the wrapped program's argv:
/// a read-confined Claude stage names them with `--add-dir`, so it can read
/// the caches its builds write and its own temp files. `claude_config` is a
/// Claude stage's absolute `CLAUDE_CONFIG_DIR` (`claude_config_dir`): the
/// profile then grants that dir's state, not `~/.claude`'s (`None` keeps
/// `~/.claude`). `codex` is a Codex stage's own home (`prepare_codex_home`):
/// the profile grants it and denies its root and copies
/// (`codex_home_rules`), and its env is added to the returned env.
#[allow(clippy::too_many_arguments)]
pub fn prepare_with(
    write_roots: &[String],
    cache_scope: Option<&str>,
    tenant: CacheTenant,
    program: &OsStr,
    args: &[String],
    private_tmp: bool,
    claude_config: Option<&str>,
    codex: Option<&CodexHome>,
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
    let (profile, left_out) = seatbelt_profile_and_refusals(write_roots, &own_dirs, claude_config, codex)?;
    let mut args = args.to_vec();
    args.extend(extra_args(&own_dirs));
    let (prog, wrapped) = sandbox_argv(program, &args, &profile);
    let mut env = stage_dirs.env();
    env.extend(codex.map(|c| c.env.clone()).unwrap_or_default());
    Ok(Prepared { program: prog, args: wrapped, env, left_out })
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
        // Claude Code's config in `~/.claude`.
        let claude = std::env::var("HOME")
            .map(|h| claude_config_denies(&claude_dir_bases(&claude_dir(&h, None)), &[canonical_string(&Path::new(&h).join(".claude/projects"))]))
            .unwrap_or_default();
        if let Some(deny) = p.find("(deny file-write*\n") {
            for line in p[deny..].lines().filter(|l| l.contains("(subpath ") || l.contains("(regex ")) {
                let listed = claude.deny_subpaths.iter().chain(&claude.deny_regexes).any(|v| line.contains(&sbpl_string(v)));
                assert!(listed, "unexpected deny: {line}");
            }
        }
        assert!(!p.contains("/.git/"));
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
        std::fs::create_dir(home.join(".claude")).unwrap();
        std::fs::create_dir(home.join(".claude/projects")).unwrap();
        std::fs::create_dir(home.join("elsewhere")).unwrap();
        symlink(home.join("elsewhere"), home.join(".claude/sessions")).unwrap();
        let mine = std::fs::metadata(&home).unwrap().uid();
        // Stand in a different owner for "someone else": every entry here is ours.
        let foreign = Some(mine.wrapping_add(1));
        let projects = home.join(".claude/projects");
        let sessions = home.join(".claude/sessions");
        assert!(root_ok(&projects, &home, Some(mine)));
        assert!(!root_ok(&projects, &home, foreign));
        assert!(root_ok(&sessions, &home, Some(mine)));
        assert!(!root_ok(&sessions, &home, foreign));
        // A root-owned target the user's link points at (`/` aside) is foreign too.
        if mine != 0 {
            symlink("/usr", home.join(".foreign")).unwrap();
            assert!(!root_ok(&home.join(".foreign"), &home, Some(mine)));
        }
        // `assemble_write_roots` drops a refused user-home root and says why,
        // keeping the others. Here `~/.claude` itself is someone else's, so
        // all its state dirs go with it, under one reason.
        let h = home.to_string_lossy().into_owned();
        let roots = assemble_write_roots(&[], Some(&h), None, None, foreign, &[]);
        let p = projects.to_string_lossy().into_owned();
        let s = sessions.to_string_lossy().into_owned();
        assert!(!roots.subpaths.iter().any(|r| r == &p || r == &s));
        assert!(!roots.subpaths.iter().any(|r| r.ends_with("/elsewhere")));
        assert_eq!(roots.refused.len(), 1, "{:?}", roots.refused);
        assert!(roots.refused[0].ends_with("/.claude is not owned by you"), "{:?}", roots.refused);
        assert!(roots.regexes.is_empty(), "no lock files in a refused dir");
        assert!(roots.subpaths.contains(&"/dev".to_string()));
        let roots = assemble_write_roots(&[], Some(&h), None, None, Some(mine), &[]);
        assert!(roots.refused.is_empty(), "{:?}", roots.refused);
        for r in [p, s, format!("{h}/elsewhere")] {
            assert!(roots.subpaths.contains(&r), "{r} is writable");
            assert!(roots.system_roots.contains(&r), "{r} is pinned");
        }
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
        let claude = format!("{h}/.claude");
        let ok = |owner: u32| resolve_state_file(&file, &claude, Some(owner));
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
        // `assemble_write_roots` records the refusal and grants no file.
        symlink(home.join(".zshrc"), &file).unwrap();
        let roots = assemble_write_roots(&[], Some(&h), None, None, Some(mine), &[]);
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
        let roots = assemble_write_roots(&[], home.as_deref(), tmpdir.as_deref(), None, current_uid(), &private_bases());
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
        // `~/.claude` exists with one state dir a link: that one is left alone.
        std::fs::create_dir(home.join(".claude")).unwrap();
        symlink(home.join("target"), home.join(".claude/projects")).unwrap();
        ensure_home_roots(home.to_str().unwrap(), None);
        for name in CLAUDE_STATE_DIRS.iter().filter(|n| **n != "projects") {
            let m = std::fs::symlink_metadata(home.join(".claude").join(name)).unwrap();
            assert!(m.is_dir() && !m.file_type().is_symlink(), "~/.claude/{name} was created");
            assert_eq!(m.permissions().mode() & 0o777, 0o700, "~/.claude/{name} is owner-only");
        }
        assert!(std::fs::symlink_metadata(home.join(".claude/projects")).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_dir(home.join("target")).unwrap().count(), 0, "nothing written through the link");
        // The shared `~/.cache` is no write root, so it isn't made; nor is any
        // config dir.
        assert!(std::fs::symlink_metadata(home.join(".cache")).is_err());
        for name in CLAUDE_CONFIG_DIRS {
            assert!(std::fs::symlink_metadata(home.join(".claude").join(name)).is_err(), "{name} not made");
        }

        // A missing `~/.claude` is created owner-only, with its state dirs.
        let fresh = tempfile::tempdir().unwrap();
        let fresh = std::fs::canonicalize(fresh.path()).unwrap();
        ensure_home_roots(fresh.to_str().unwrap(), None);
        let claude = std::fs::symlink_metadata(fresh.join(".claude")).unwrap();
        assert!(claude.is_dir() && !claude.file_type().is_symlink(), "~/.claude was created");
        assert_eq!(claude.permissions().mode() & 0o777, 0o700, "~/.claude is owner-only");
        assert!(fresh.join(".claude/projects").is_dir());

        // A symlinked `~/.claude` (dotfiles) gets them in its target; one
        // that resolves to `$HOME` gets none, so nothing lands in `$HOME`.
        let dotfiles = tempfile::tempdir().unwrap();
        let dotfiles = std::fs::canonicalize(dotfiles.path()).unwrap();
        std::fs::create_dir(dotfiles.join("claude")).unwrap();
        symlink(dotfiles.join("claude"), dotfiles.join(".claude")).unwrap();
        ensure_home_roots(dotfiles.to_str().unwrap(), None);
        assert!(dotfiles.join("claude/projects").is_dir());
        let looped = tempfile::tempdir().unwrap();
        let looped = std::fs::canonicalize(looped.path()).unwrap();
        symlink(&looped, looped.join(".claude")).unwrap();
        ensure_home_roots(looped.to_str().unwrap(), None);
        assert!(std::fs::symlink_metadata(looped.join("projects")).is_err(), "nothing made in $HOME");
    }

    #[test]
    fn claude_config_denies_cover_every_config_entry_after_the_allows() {
        let rules = claude_config_denies(&["/h/.claude".to_string(), "/real/claude".to_string()], &["/vol/projects".to_string()]);
        assert!(regex_denies(&rules, "/vol/projects/-ws/memory/MEMORY.md"), "a linked projects dir's memory too");
        assert!(!regex_denies(&rules, "/vol/projects/-ws/s.jsonl"));
        for b in ["/h/.claude", "/real/claude"] {
            assert!(rules.deny_literals.contains(&b.to_string()), "{b} is pinned");
            for d in ["skills", "agents", "commands", "plugins", "hooks", "rules", "output-styles", "workflows", "agent-memory", "local", "mods", "dev-mods"] {
                assert!(rules.deny_subpaths.contains(&format!("{b}/{d}")), "{b}/{d} is denied");
            }
            for f in ["settings.json", "settings.local.json", "CLAUDE.md", "keybindings.json", "remote-settings.json", "mcp.json", ".config.json"] {
                assert!(rules.deny_literals.contains(&format!("{b}/{f}")), "{b}/{f} is denied");
            }
            // The login file is granted (when it exists), never denied.
            assert!(!rules.deny_literals.contains(&format!("{b}/.credentials.json")));
            assert!(!regex_denies(&rules, &format!("{b}/.credentials.json")));
            assert!(!regex_denies(&rules, &format!("{b}/.oauth_refresh.lock")));
            for d in [
                format!("{b}/projects/-ws/memory"),
                format!("{b}/projects/-ws/memory/MEMORY.md"),
                format!("{b}/policy-limits.json"),
                format!("{b}/policy-limits.json.stamp.json"),
            ] {
                assert!(regex_denies(&rules, &d), "{d} is denied");
            }
            // Transcripts stay writable.
            for ok in [format!("{b}/projects/-ws/s.jsonl"), format!("{b}/projects/-ws/s/subagents/a.jsonl"), format!("{b}/projects/-ws/memoryx")] {
                assert!(!regex_denies(&rules, &ok), "{ok} stays writable");
            }
        }
        // No state dir is denied: each is a write root.
        for d in CLAUDE_STATE_DIRS {
            assert!(!rules.deny_subpaths.iter().any(|s| s.ends_with(&format!("/{d}"))));
            assert!(!CLAUDE_CONFIG_DIRS.contains(d));
        }
        // Rendered after the allows, so they win over a state dir or a link.
        let mut all = WriteRules { subpaths: vec!["/h/.claude/projects".into()], ..WriteRules::default() };
        all.extend(rules);
        let p = render_profile(&all);
        let allow = p.find("(subpath \"/h/.claude/projects\")").unwrap();
        assert!(allow < p.find("(subpath \"/h/.claude/skills\")").unwrap());
        assert!(allow < p.find("(literal \"/h/.claude/settings.json\")").unwrap());
    }

    #[test]
    fn the_profile_grants_only_the_claude_state_dirs_never_the_whole_dir_or_cache() {
        let roots = assemble_write_roots(&[], Some("/home/u"), None, None, None, &[]);
        for d in CLAUDE_STATE_DIRS {
            let r = format!("/home/u/.claude/{d}");
            assert!(roots.subpaths.contains(&r), "{r} is writable");
            assert!(roots.system_roots.contains(&r), "{r} is pinned");
        }
        for no in ["/home/u/.claude", "/home/u/.cache", "/home/u/.claude/skills", "/home/u/.claude/plugins"] {
            assert!(!roots.subpaths.iter().any(|r| r == no), "{no} is not a write root");
        }
        assert!(!roots.subpaths.iter().any(|r| r.starts_with("/home/u/.cache")));
        assert_eq!(roots.files, vec!["/home/u/.claude.json".to_string()]);
    }

    #[test]
    #[cfg(unix)]
    fn a_claude_state_dir_linked_onto_the_dir_or_a_config_entry_is_left_out() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(dir.path()).unwrap();
        let h = home.to_string_lossy().into_owned();
        let c = home.join(".claude");
        std::fs::create_dir_all(c.join("skills/x")).unwrap();
        std::fs::create_dir(home.join("dotfiles")).unwrap();
        std::fs::create_dir(home.join("dotfiles/projects")).unwrap();
        // projects -> ~/.claude, plans -> ~/.claude/skills, tasks -> a skill
        // inside it, sessions -> a dir holding the user's linked skills.
        symlink(&c, c.join("projects")).unwrap();
        symlink(c.join("skills"), c.join("plans")).unwrap();
        symlink(c.join("skills/x"), c.join("tasks")).unwrap();
        symlink(home.join("dotfiles"), c.join("sessions")).unwrap();
        std::fs::create_dir(home.join("dotfiles/agents")).unwrap();
        symlink(home.join("dotfiles/agents"), c.join("agents")).unwrap();
        // debug -> a plain dir elsewhere is fine.
        symlink(home.join("dotfiles/projects"), c.join("debug")).unwrap();
        let roots = assemble_write_roots(&[], Some(&h), None, None, current_uid(), &[]);
        for bad in ["projects", "plans", "tasks", "sessions"] {
            let r = format!("{h}/.claude/{bad}");
            assert!(!roots.subpaths.contains(&r), "{r} must be left out");
            assert!(roots.refused.iter().any(|w| w.starts_with(&r)), "{r}: {:?}", roots.refused);
        }
        assert!(!roots.subpaths.iter().any(|r| Path::new(r) == c || Path::new(r).starts_with(c.join("skills"))));
        assert!(roots.subpaths.contains(&format!("{h}/.claude/debug")));
        assert!(roots.subpaths.contains(&format!("{h}/dotfiles/projects")));
        assert_eq!(roots.refused.len(), 4, "{:?}", roots.refused);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn seatbelt_keeps_a_system_root_writable_inside_but_not_replaceable() {
        // `$TMPDIR` and `/private/tmp` are system roots on every Mac; the
        // `~/.claude` state dirs are those of a stand-in `$HOME`, so the test
        // never writes the developer's real `~/.claude/projects`. The stand-in
        // sits in the user cache dir, not in `$TMPDIR`: a root that holds
        // `$HOME` is left out, so a `$HOME` inside `$TMPDIR` would drop it.
        let ws = tempfile::tempdir().unwrap();
        let roots = vec![ws.path().to_string_lossy().into_owned()];
        let caches = dirs::cache_dir().unwrap();
        std::fs::create_dir_all(&caches).unwrap();
        let fake_home = tempfile::Builder::new().prefix("octopush-home-test-").tempdir_in(&caches).unwrap();
        let home = canonical_string(fake_home.path());
        ensure_home_roots(&home, None);
        let tmpdir = canonical_string(Path::new(&std::env::var("TMPDIR").unwrap()));
        let (profile, _) = profile_and_refusals_for(Some(&home), Some(&tmpdir), None, None, &roots, &[]).unwrap();
        let run = |script: &str| -> bool {
            let (prog, args) = sandbox_argv(OsStr::new("bash"), &["-c".to_string(), script.to_string()], &profile);
            std::process::Command::new(prog).args(args).output().map(|o| o.status.success()).unwrap_or(false)
        };
        let cache = format!("{home}/.claude/projects");
        let tag = format!("octopush-root-test-{}", std::process::id());
        // Writes and the atomic write-then-rename editors and the CLI use work
        // inside each real root. (Renaming a real root itself is left to the
        // root below: their parents aren't writable anyway, so it would prove
        // nothing about the pin.)
        for root in ["/private/tmp".to_string(), tmpdir, cache] {
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
        let roots = assemble_write_roots(&["/ws".to_string()], Some("/home/u"), Some("/tmp/session"), None, None, &[]).subpaths;
        assert!(roots.contains(&"/ws".to_string()));
        assert!(roots.contains(&"/home/u/.claude/projects".to_string()));
        assert!(!roots.contains(&"/home/u/.claude".to_string()), "never ~/.claude as a whole");
        assert!(!roots.contains(&"/home/u/.cache".to_string()), "never the shared ~/.cache");
        assert!(roots.contains(&"/tmp/session".to_string()));
        assert!(roots.contains(&"/dev".to_string()));
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
        let roots = assemble_write_roots(&[], Some("/home/u"), Some("/tmp/session"), None, None, &[]).subpaths;
        assert!(!roots.iter().any(|r| r.starts_with("/home/u/.cargo") || r == "/home/u/go"));
        assert!(!roots.contains(&"/ws".to_string()));
        // Temp + the CLI's own dirs are still there (a shell needs them).
        assert!(roots.contains(&"/tmp/session".to_string()));
        assert!(roots.contains(&"/home/u/.claude/projects".to_string()));
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
        // The shared ~/.cache isn't writable: XDG caches go to the root too.
        assert_eq!(env.get("XDG_CACHE_HOME").unwrap(), "/c/build-cache/abc/xdg-cache");
        for k in ["PRE_COMMIT_HOME", "UV_CACHE_DIR", "PIP_CACHE_DIR"] {
            assert!(env.contains_key(k), "{k} is redirected");
        }
        // A sandboxed Claude stage gets auto memory off (its dir is denied).
        assert_eq!(claude_stage_env(), vec![("CLAUDE_CODE_DISABLE_AUTO_MEMORY".to_string(), "1".to_string())]);
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
        // The base sits outside every root all missions share (temp, ~/.claude,
        // ~/.cache), so only the own subtree is ever writable.
        let shared = system_write_roots(Some(home), Some(tmpdir), None);
        for r in &shared {
            assert!(!base.starts_with(r), "the cache base {} is inside the write root {r}", base.display());
        }
        let a_str = a.to_string_lossy().into_owned();
        let b_str = b.to_string_lossy().into_owned();
        let roots = assemble_write_roots(&[ws_a[0].clone(), a_str.clone()], Some(home), Some(tmpdir), None, None, &[]).subpaths;
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
        // write it (or plant `.claude/skills` in it). (On Linux too, now that
        // `~/.cache`, Linux's cache dir, is no longer a shared root.)
        {
            let home = std::env::var("HOME").ok();
            let shared = assemble_write_roots(
                &[],
                home.as_deref(),
                std::env::var("TMPDIR").ok().as_deref(),
                None,
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
            let prepared = prepare_with(&roots, Some(scope.as_str()), RC, OsStr::new("bash"), &args, true, None, None, |dirs| {
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
        let shared = assemble_write_roots(&[], home.as_deref(), tmpdir.as_deref(), None, current_uid(), &private_bases()).subpaths;
        for base in [base, stage_tmp_base().expect("a user cache dir"), codex_home_base().expect("a user cache dir")] {
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
    #[cfg(target_os = "macos")]
    fn seatbelt_lets_a_stage_write_claude_state_but_not_claude_config() {
        // The full profile for a stand-in `$HOME` (so the real one is never
        // touched), built the way a stage's is: state dirs made outside the
        // sandbox first, then the roots, pins and config denies.
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(dir.path()).unwrap();
        let h = home.to_string_lossy().into_owned();
        let c = format!("{h}/.claude");
        ensure_home_roots(&h, None);
        // Some config already exists, some doesn't.
        std::fs::create_dir_all(format!("{c}/skills/existing")).unwrap();
        std::fs::write(format!("{c}/skills/existing/SKILL.md"), "original\n").unwrap();
        std::fs::write(format!("{c}/settings.json"), "{}\n").unwrap();
        std::fs::create_dir(format!("{c}/agents")).unwrap();
        let (profile, refused) = profile_and_refusals_for(Some(&h), None, None, None, &[], &[]).unwrap();
        assert!(refused.is_empty(), "{refused:?}");
        let sandboxed = |script: String| -> bool {
            let (prog, args) = sandbox_argv(OsStr::new("bash"), &["-c".to_string(), script], &profile);
            std::process::Command::new(prog).args(args).output().map(|o| o.status.success()).unwrap_or(false)
        };
        // What a `-p` stage writes works: a transcript (atomically, too), a
        // session record, a shell snapshot, a checkpoint, and `~/.claude.json`.
        let p = format!("{c}/projects/-ws");
        assert!(sandboxed(format!("mkdir -p '{p}/s/subagents' && echo x >> '{p}/s.jsonl' && echo y > '{p}/s.tmp' && mv '{p}/s.tmp' '{p}/s2.jsonl' && echo z > '{p}/s/subagents/a.jsonl'")));
        assert!(sandboxed(format!("echo 1 > '{c}/sessions/1.json' && echo e > '{c}/shell-snapshots/snap.sh' && mkdir -p '{c}/file-history/s' && mkdir -p '{c}/session-env/s' && mkdir -p '{c}/tasks/l'")));
        assert!(sandboxed(format!("echo '{{}}' > '{h}/.claude.json'")));
        assert_eq!(std::fs::read_to_string(format!("{p}/s.jsonl")).unwrap(), "x\n");
        // The login-refresh lock and its sidecar, so an expired token can be
        // refreshed.
        let lock = format!("{c}/.oauth_refresh.lock");
        assert!(sandboxed(format!("echo 1 > '{lock}' && echo o > '{lock}.owner.tmp.123' && rm '{lock}.owner.tmp.123'")));
        assert!(Path::new(&lock).is_file());

        // Nothing Claude Code loads as instructions or config can be written.
        let denied = [
            format!("mkdir -p '{c}/skills/x' && echo x > '{c}/skills/x/SKILL.md'"),
            format!("echo x >> '{c}/skills/existing/SKILL.md'"),
            format!("echo x > '{c}/skills/existing/other.md'"),
            format!("echo '{{\"hooks\":{{}}}}' > '{c}/settings.json'"),
            format!("echo x > '{p}/new.json' && mv '{p}/new.json' '{c}/settings.json'"),
            format!("echo x > '{c}/settings.local.json'"),
            format!("mkdir -p '{c}/hooks' && echo x > '{c}/hooks/pre.sh'"),
            format!("echo x > '{c}/agents/a.md'"),
            format!("mkdir -p '{c}/commands' && echo x > '{c}/commands/c.md'"),
            format!("mkdir -p '{c}/plugins/p'"),
            format!("echo x > '{c}/CLAUDE.md'"),
            format!("mkdir -p '{p}/memory' && echo x > '{p}/memory/MEMORY.md'"),
            format!("echo x > '{c}/remote-settings.json'"),
            format!("echo x > '{c}/mcp.json'"),
            format!("echo x > '{c}/.config.json'"),
            format!("mkdir -p '{c}/mods/m'"),
            format!("mkdir -p '{c}/dev-mods/m'"),
            // No login file yet: a stage can't create one.
            format!("echo x > '{c}/.credentials.json'"),
            // A new top-level entry, or swapping a state dir for a link.
            format!("echo x > '{c}/anything-new'"),
            format!("echo x > '{c}/.oauth_refresh.lockx'"),
            format!("echo x > '{c}/.oauth_refresh'"),
            format!("mkdir '{c}/.oauth_refresh.lock.d' && echo x > '{c}/.oauth_refresh.lock.d/x'"),
            // The lock files are writable, never hard-linkable.
            format!("ln '{p}/s.jsonl' '{c}/.oauth_refresh.lock.linked'"),
            format!("mv '{c}/plans' '{c}/plans.old'"),
            format!("rmdir '{c}/plans' && ln -s '{c}/skills' '{c}/plans'"),
            // Through a link planted in a writable state dir.
            format!("ln -s '{c}/skills' '{p}/to-skills' && mkdir -p '{p}/to-skills/y' && echo x > '{p}/to-skills/y/SKILL.md'"),
            format!("ln -s '{c}/settings.json' '{p}/to-settings' && echo x >> '{p}/to-settings'"),
        ];
        for script in &denied {
            assert!(!sandboxed(script.clone()), "must be denied: {script}");
        }
        assert_eq!(std::fs::read_to_string(format!("{c}/settings.json")).unwrap(), "{}\n");
        assert_eq!(std::fs::read_to_string(format!("{c}/skills/existing/SKILL.md")).unwrap(), "original\n");
        for gone in ["skills/x", "skills/existing/other.md", "settings.local.json", "hooks", "agents/a.md", "commands", "plugins", "CLAUDE.md", "projects/-ws/memory", "remote-settings.json", "mcp.json", ".config.json", "mods", "dev-mods", ".credentials.json", "anything-new", ".oauth_refresh.lockx", ".oauth_refresh", ".oauth_refresh.lock.linked", "skills/y"] {
            assert!(std::fs::symlink_metadata(format!("{c}/{gone}")).is_err(), "{gone} was created");
        }
        let plans = std::fs::symlink_metadata(format!("{c}/plans")).unwrap();
        assert!(plans.is_dir() && !plans.file_type().is_symlink(), "plans/ is still the real dir");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn seatbelt_lets_a_stage_save_an_existing_login_file_only() {
        // A stand-in `$HOME` whose `~/.claude` already holds the login file.
        let dir = tempfile::tempdir().unwrap();
        let h = canonical_string(dir.path());
        let c = format!("{h}/.claude");
        ensure_home_roots(&h, None);
        let creds = format!("{c}/.credentials.json");
        std::fs::write(&creds, "{\"old\":1}\n").unwrap();
        let (profile, refused) = profile_and_refusals_for(Some(&h), None, None, None, &[], &[]).unwrap();
        assert!(refused.is_empty(), "{refused:?}");
        let sandboxed = |script: String| -> bool {
            let (prog, args) = sandbox_argv(OsStr::new("bash"), &["-c".to_string(), script], &profile);
            std::process::Command::new(prog).args(args).output().map(|o| o.status.success()).unwrap_or(false)
        };
        // A refreshed token can be saved in place, under the refresh lock.
        assert!(sandboxed(format!("echo 1 > '{c}/.oauth_refresh.lock' && echo '{{\"new\":1}}' > '{creds}' && rm '{c}/.oauth_refresh.lock'")));
        assert_eq!(std::fs::read_to_string(&creds).unwrap(), "{\"new\":1}\n");
        // Never hard-linked out, nor anything new beside it.
        assert!(!sandboxed(format!("ln '{creds}' '{c}/projects/creds'")));
        assert!(!sandboxed(format!("echo x > '{c}/.credentials.json.new'")));
        // A login file with a second hard link is left out, and named.
        std::fs::hard_link(&creds, format!("{h}/copy")).unwrap();
        let (profile, refused) = profile_and_refusals_for(Some(&h), None, None, None, &[], &[]).unwrap();
        assert!(refused.iter().any(|w| w.contains(".credentials.json")), "{refused:?}");
        let (prog, args) = sandbox_argv(OsStr::new("bash"), &["-c".to_string(), format!("echo x > '{creds}'")], &profile);
        assert!(!std::process::Command::new(prog).args(args).output().unwrap().status.success());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn seatbelt_follows_a_claude_config_dir() {
        let dir = tempfile::tempdir().unwrap();
        let h = canonical_string(dir.path());
        let cfg = format!("{h}/alt-claude");
        ensure_home_roots(&h, Some(&cfg));
        std::fs::create_dir(format!("{h}/.claude")).unwrap();
        let (profile, refused) = profile_and_refusals_for(Some(&h), None, Some(&cfg), None, &[], &[]).unwrap();
        assert!(refused.is_empty(), "{refused:?}");
        let sandboxed = |script: String| -> bool {
            let (prog, args) = sandbox_argv(OsStr::new("bash"), &["-c".to_string(), script], &profile);
            std::process::Command::new(prog).args(args).output().map(|o| o.status.success()).unwrap_or(false)
        };
        assert!(sandboxed(format!("mkdir -p '{cfg}/projects/-ws' && echo x > '{cfg}/projects/-ws/s.jsonl'")));
        assert!(sandboxed(format!("echo '{{}}' > '{cfg}/.claude.json' && echo 1 > '{cfg}/.oauth_refresh.lock'")));
        for denied in [
            format!("echo x > '{cfg}/settings.json'"),
            format!("mkdir -p '{cfg}/skills/x'"),
            format!("mkdir -p '{cfg}/projects/-ws/memory'"),
            format!("echo x > '{h}/.claude/settings.json'"),
            format!("mkdir -p '{h}/.claude/projects'"),
            format!("echo x > '{h}/.claude.json'"),
        ] {
            assert!(!sandboxed(denied.clone()), "must be denied: {denied}");
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn seatbelt_stops_a_stage_writing_the_shared_cache_and_points_xdg_at_its_own() {
        let ws = tempfile::tempdir().unwrap();
        let roots = vec![ws.path().to_string_lossy().into_owned()];
        let scope = format!("{}-xdg-test", roots[0]);
        let home = std::env::var("HOME").unwrap();
        let probe = format!("{home}/.cache/octopush-774-probe-{}", std::process::id());
        let run = |script: String| -> (bool, String) {
            let args = vec!["-c".to_string(), script];
            let prepared = prepare(&roots, Some(scope.as_str()), OsStr::new("bash"), &args).unwrap();
            let out = std::process::Command::new(&prepared.program)
                .args(&prepared.args)
                .envs(prepared.env.iter().cloned())
                .output()
                .unwrap();
            (out.status.success(), String::from_utf8_lossy(&out.stdout).trim().to_string())
        };
        let (made, _) = run(format!("mkdir -p '{probe}' && echo x > '{probe}/foo'"));
        let existed = Path::new(&probe).exists();
        let _ = std::fs::remove_dir_all(&probe);
        assert!(!made && !existed, "the shared ~/.cache is not writable");
        // XDG_CACHE_HOME points into the stage's own build cache, and a tool
        // that caches there works.
        let (ok, xdg) = run("mkdir -p \"$XDG_CACHE_HOME/tool\" && echo x > \"$XDG_CACHE_HOME/tool/c\" && echo \"$XDG_CACHE_HOME\"".to_string());
        assert!(ok, "the XDG cache is writable");
        let base = canonical_lenient(&build_cache_base().unwrap());
        assert!(Path::new(&xdg).starts_with(&base), "{xdg} is inside the build cache {}", base.display());
        assert!(Path::new(&xdg).join("tool/c").exists());
        let _ = remove_workspace_build_caches(&scope);
    }

    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "needs the Claude CLI on PATH; run by hand with `cargo test --lib a_real_claude_cli -- --ignored`"]
    fn a_real_claude_cli_still_starts_under_the_profile() {
        // A real `-p` needs auth, so only `--version`. Ignored by default (CI
        // has no CLI); run by hand on a Mac with the CLI installed.
        let Some(claude) = std::env::var_os("PATH")
            .and_then(|p| std::env::split_paths(&p).map(|d| d.join("claude")).find(|c| c.is_file()))
        else {
            println!("skipped: claude not on PATH");
            return;
        };
        let ws = tempfile::tempdir().unwrap();
        let roots = vec![ws.path().to_string_lossy().into_owned()];
        let scope = format!("{}-claude-version-test", roots[0]);
        let args = vec!["--version".to_string()];
        let prepared = prepare_with(&roots, Some(scope.as_str()), RC, claude.as_os_str(), &args, true, None, None, |_| Vec::new()).unwrap();
        let out = std::process::Command::new(&prepared.program)
            .args(&prepared.args)
            .envs(prepared.env.iter().cloned())
            .envs(claude_stage_env())
            .current_dir(ws.path())
            .output()
            .unwrap();
        let _ = remove_workspace_build_caches(&scope);
        assert!(out.status.success(), "claude --version failed: {}", String::from_utf8_lossy(&out.stderr));
        assert!(String::from_utf8_lossy(&out.stdout).contains("Claude Code"));
    }

    #[test]
    fn the_oauth_lock_regexes_match_only_the_lock_files_beside_the_config() {
        let res: Vec<regex::Regex> = oauth_lock_regexes(&["/h/.cl+aude/".to_string()])
            .iter()
            .map(|r| regex::Regex::new(r).unwrap())
            .collect();
        let hit = |p: &str| res.iter().any(|r| r.is_match(p));
        assert!(hit("/h/.cl+aude/.oauth_refresh.lock"));
        assert!(hit("/h/.cl+aude/.oauth_refresh.lock.owner.tmp.123"));
        for no in [
            "/h/.cl+aude/.oauth_refresh.lockx",
            "/h/.cl+aude/.oauth_refresh",
            "/h/.cl+aude/.oauth_refresh.lock.d/x",
            "/h/.cl+aude/projects/.oauth_refresh.lock",
            "/h/.cl+aude/settings.json",
            "/h/.cl+aude/anything-new",
            "/h/.claude/.oauth_refresh.lock",
            "/h/.cl+audeX/.oauth_refresh.lock",
            "/h/.cl+aude/.oauth_refresh.lock/x",
        ] {
            assert!(!hit(no), "{no} must not match");
        }
        // Rendered as a `file-write*` allow only, never a `file-link` one.
        let p = render_profile(&WriteRules {
            subpaths: vec!["/ws".into()],
            regexes: oauth_lock_regexes(&["/h/.claude".to_string()]),
            ..WriteRules::default()
        });
        let link = p.find("(allow file-link").unwrap();
        let lock = p.find("oauth_refresh").unwrap();
        assert!(p.find("(allow file-write*").unwrap() < lock && lock < link, "{p}");
        assert_eq!(p.matches("oauth_refresh").count(), 1, "{p}");
    }

    #[test]
    fn the_profile_grants_the_oauth_lock_files_of_the_claude_dir() {
        let roots = assemble_write_roots(&[], Some("/home/u"), None, None, None, &[]);
        assert_eq!(roots.regexes, oauth_lock_regexes(&["/home/u/.claude".to_string()]));
        let roots = assemble_write_roots(&[], Some("/home/u"), None, Some("/cfg/claude"), None, &[]);
        assert_eq!(roots.regexes, oauth_lock_regexes(&["/cfg/claude".to_string()]));
    }

    #[test]
    #[cfg(unix)]
    fn the_credentials_file_is_granted_only_when_it_exists_and_is_a_plain_file_of_the_users() {
        use std::os::unix::fs::{symlink, MetadataExt};
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(dir.path()).unwrap();
        let h = home.to_string_lossy().into_owned();
        std::fs::create_dir(home.join(".claude")).unwrap();
        let creds = format!("{h}/.claude/.credentials.json");
        let mine = std::fs::metadata(&home).unwrap().uid();
        let assemble = || assemble_write_roots(&[], Some(&h), None, None, Some(mine), &[]);
        // Missing: not granted, so a stage can't create it.
        let roots = assemble();
        assert!(!roots.files.contains(&creds), "{:?}", roots.files);
        assert!(roots.refused.is_empty(), "{:?}", roots.refused);
        // A plain file of the user's: granted as a literal.
        std::fs::write(&creds, "{}").unwrap();
        let roots = assemble();
        assert!(roots.files.contains(&creds), "{:?}", roots.files);
        assert!(!roots.subpaths.contains(&format!("{h}/.claude")));
        // Someone else's is left out.
        let theirs = assemble_write_roots(&[], Some(&h), None, None, Some(mine.wrapping_add(1)), &[]);
        assert!(!theirs.files.contains(&creds));
        // A second hard link is left out, with the reason.
        std::fs::hard_link(&creds, home.join("copy")).unwrap();
        let roots = assemble();
        assert!(!roots.files.contains(&creds));
        assert!(roots.refused.iter().any(|w| w.contains(".credentials.json")), "{:?}", roots.refused);
        std::fs::remove_file(home.join("copy")).unwrap();
        // A link outside `~/.claude` is left out.
        std::fs::remove_file(&creds).unwrap();
        std::fs::write(home.join(".zshrc"), "x").unwrap();
        symlink(home.join(".zshrc"), &creds).unwrap();
        let roots = assemble();
        assert!(!roots.files.iter().any(|f| f == &creds || f.ends_with(".zshrc")), "{:?}", roots.files);
        assert!(roots.refused.iter().any(|w| w.contains(".credentials.json")), "{:?}", roots.refused);
    }

    #[test]
    fn claude_config_dir_keeps_only_an_absolute_path() {
        assert_eq!(claude_config_dir(None), (None, None));
        assert_eq!(claude_config_dir(Some("  ")), (None, None));
        assert_eq!(claude_config_dir(Some("/cfg/claude")), (Some("/cfg/claude".to_string()), None));
        let (kept, note) = claude_config_dir(Some("rel/claude"));
        assert_eq!(kept, None);
        let note = note.unwrap();
        assert!(note.contains("CLAUDE_CONFIG_DIR rel/claude") && note.contains("not an absolute path"), "{note}");
        assert_eq!(claude_dir("/home/u/", None), "/home/u/.claude");
        assert_eq!(claude_dir("/home/u", Some("/cfg/claude/")), "/cfg/claude");
    }

    #[test]
    #[cfg(unix)]
    fn a_claude_config_dir_takes_the_place_of_dot_claude() {
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(dir.path()).unwrap();
        let h = home.to_string_lossy().into_owned();
        let cfg = format!("{h}/alt-claude");
        std::fs::create_dir(&cfg).unwrap();
        let roots = assemble_write_roots(&[], Some(&h), None, Some(&cfg), current_uid(), &[]);
        assert!(roots.refused.is_empty(), "{:?}", roots.refused);
        for d in CLAUDE_STATE_DIRS {
            assert!(roots.subpaths.contains(&format!("{cfg}/{d}")), "{cfg}/{d} is writable");
            assert!(!roots.subpaths.contains(&format!("{h}/.claude/{d}")), "~/.claude/{d} is not");
        }
        assert_eq!(roots.files, vec![format!("{cfg}/.claude.json")]);
        // Config entries are denied under both dirs, auto memory in the
        // config dir's projects.
        let (profile, refused) = profile_and_refusals_for(Some(&h), None, Some(&cfg), None, &[], &[]).unwrap();
        assert!(refused.is_empty(), "{refused:?}");
        let deny = profile.find("(deny file-write*\n").unwrap();
        for f in [format!("{h}/.claude/settings.json"), format!("{cfg}/settings.json"), format!("{cfg}/mcp.json")] {
            let at = profile.find(&format!("(literal {})", sbpl_string(&f))).unwrap_or_else(|| panic!("{f} denied"));
            assert!(at > deny);
        }
        assert!(profile.contains(&format!("(subpath {})", sbpl_string(&format!("{cfg}/skills")))));
        assert!(profile.contains(&format!("(subpath {})", sbpl_string(&format!("{h}/.claude/skills")))));
        assert!(profile.contains(&sbpl_string(&format!("^{}/projects/[^/]+/memory(/|$)", regex_escape(&cfg)))));
        // An unsafe config dir is left out, with everything in it, and named.
        let ssh = format!("{h}/.config/claude");
        std::fs::create_dir_all(&ssh).unwrap();
        for bad in [h.clone(), ssh.clone()] {
            let roots = assemble_write_roots(&[], Some(&h), None, Some(&bad), current_uid(), &[]);
            assert!(roots.refused.iter().any(|w| w.starts_with(&bad)), "{bad}: {:?}", roots.refused);
            assert!(!roots.subpaths.iter().any(|r| r.contains("projects")), "{:?}", roots.subpaths);
            assert!(roots.files.is_empty() && roots.regexes.is_empty(), "{:?}", roots.files);
        }
    }

    #[test]
    #[cfg(unix)]
    fn ensure_home_roots_makes_the_state_dirs_in_the_claude_config_dir() {
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(dir.path()).unwrap();
        let h = home.to_string_lossy().into_owned();
        let cfg = home.join("alt-claude");
        ensure_home_roots(&h, Some(cfg.to_str().unwrap()));
        for name in CLAUDE_STATE_DIRS {
            assert!(cfg.join(name).is_dir(), "{name} made in the config dir");
        }
        assert!(std::fs::symlink_metadata(home.join(".claude")).is_err(), "~/.claude is left alone");
    }

    #[test]
    fn system_write_files_covers_the_claude_state_file() {
        assert_eq!(system_write_files(Some("/home/u"), None), vec!["/home/u/.claude.json".to_string()]);
        assert!(system_write_files(None, None).is_empty());
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

    // ─── A sandboxed Codex stage's own CODEX_HOME (#784) ───────────────────

    /// A Codex stage's tenant in a `sandbox` mission (reads open).
    const CT: CacheTenant<'static> = CacheTenant::Cli { exec_choice: "sandbox", reads_confined: false };

    fn utc(s: &str) -> chrono::DateTime<chrono::Utc> {
        s.parse().unwrap()
    }

    /// A JWT-shaped token whose payload carries `exp` (unsigned; only the
    /// claim is read).
    fn token_expiring(exp: chrono::DateTime<chrono::Utc>) -> String {
        use base64::Engine;
        let claims = serde_json::json!({ "exp": exp.timestamp() }).to_string();
        format!("e30.{}.sig", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims))
    }

    /// A ChatGPT sign-in as Codex saves it.
    fn chatgpt_auth(last_refresh: &str, access_token: &str) -> String {
        serde_json::json!({
            "OPENAI_API_KEY": null,
            "tokens": {
                "id_token": "id-token-value",
                "access_token": access_token,
                "refresh_token": "rt-secret-value",
                "account_id": "acct"
            },
            "last_refresh": last_refresh
        })
        .to_string()
    }

    #[test]
    fn each_workspace_and_access_mode_gets_its_own_codex_home() {
        let base = Path::new("/c/octopush/codex-home");
        let roots = vec!["/ws".to_string()];
        let home = codex_home_dir(base, "/ws", &roots, CT);
        assert_eq!(home, codex_home_dir(base, "/ws/", &roots, CT), "a trailing / is the same workspace");
        assert_eq!(home.parent().unwrap(), workspace_cache_dir(base, "/ws"), "in the workspace's dir, removed with it");
        assert_eq!(home.parent().unwrap().parent().unwrap(), base);
        assert_ne!(home, codex_home_dir(base, "/other", &roots, CT));
        // A readonly mission, or a read-only stage (no write roots), never
        // shares the writer's sessions; nor does another exec choice.
        assert_ne!(home, codex_home_dir(base, "/ws", &[], CT));
        assert_ne!(home, codex_home_dir(base, "/ws", &roots, CacheTenant::Cli { exec_choice: "none", reads_confined: false }));
        // Keyed exactly like the stage's build-cache root, under its own base.
        let cache = mission_cache_root(Path::new("/b"), "/ws", &roots, CT);
        assert_eq!(home.strip_prefix(base).unwrap(), cache.strip_prefix("/b").unwrap());
    }

    /// Whether `rules` deny writing `path` (a literal, a subtree or a regex).
    fn codex_denies(rules: &WriteRules, path: &str) -> bool {
        rules.deny_literals.iter().any(|l| l == path)
            || rules.deny_subpaths.iter().any(|d| Path::new(path).starts_with(d))
            || regex_denies(rules, path)
    }

    /// Case variants of `name` as a case-insensitive volume sees them.
    fn case_variants(name: &str) -> Vec<String> {
        let upper = name.to_ascii_uppercase();
        let mut title = name.to_string();
        if let Some(i) = title.find(|c: char| c.is_ascii_alphabetic()) {
            title.replace_range(i..=i, &title[i..=i].to_ascii_uppercase());
        }
        let mut v = vec![name.to_string(), upper, title, name.to_ascii_lowercase()];
        v.dedup();
        v
    }

    #[test]
    fn a_codex_home_is_writable_but_what_codex_reads_back_is_not() {
        let user = vec!["/u/.codex".to_string(), "/real/u/.codex/".to_string()];
        let rules = codex_home_rules("/c/h/", &user);
        assert_eq!(rules.subpaths, vec!["/c/h".to_string()], "only the stage's own home");
        assert!(rules.literals.is_empty() && rules.regexes.is_empty());
        for b in ["/c/h", "/u/.codex", "/real/u/.codex"] {
            assert!(rules.deny_literals.contains(&b.to_string()), "{b} itself is pinned");
            let files = [
                "config.toml", "managed_config.toml", "requirements.toml", "environments.toml", "work.config.toml",
                "auth.json", "AGENTS.md", "AGENTS.override.md", "instructions.md", ".env", "hooks.json",
                "models_cache.json", "cloud-config-bundle-cache.json", "managed-config-acme.json", "managed-config-.json",
                ".tmp/plugins.sha", ".tmp/plugin-share-local-paths-v1.json",
            ];
            for f in files {
                for v in case_variants(f) {
                    assert!(codex_denies(&rules, &format!("{b}/{v}")), "{b}/{v}");
                }
            }
            let dirs = [
                "prompts", "rules", "skills", "migrated-command-skills", "memories", "memories_v2", "memories_extensions",
                "plugins", "hooks", "agents", "secrets", "cache", "packages", "proxy", ".tmp/marketplaces", ".tmp/plugins",
            ];
            for d in dirs {
                for v in case_variants(d) {
                    assert!(codex_denies(&rules, &format!("{b}/{v}")), "{b}/{v} itself");
                    assert!(codex_denies(&rules, &format!("{b}/{v}/x/y.md")), "{b}/{v}/x/y.md");
                }
            }
            // The Kelvin sign and the long s fold to `k` and `s` on APFS.
            assert!(codex_denies(&rules, &format!("{b}/\u{17F}kills/x/SKILL.md")));
            assert!(codex_denies(&rules, &format!("{b}/s\u{212A}ills/x/SKILL.md")));
            assert!(codex_denies(&rules, &format!("{b}/.tmp/plugin\u{17F}/p")));
            // So do the ligatures (#1270).
            assert!(codex_denies(&rules, &format!("{b}/in\u{FB05}ructions.md")));
            assert!(codex_denies(&rules, &format!("{b}/cloud-con\u{FB01}g-bundle-cache.json")));
            assert!(codex_denies(&rules, &format!("{b}/managed-con\u{FB01}g-acme.json")));
            assert!(codex_denies(&rules, &format!("{b}/memories_exten\u{17F}ions/m.md")));
        }
        // `.tmp` is pinned in the stage's own home, not its contents.
        assert!(codex_denies(&rules, "/c/h/.tmp") && codex_denies(&rules, "/c/h/.TMP"));
        // What `codex exec` writes stays writable.
        for w in [
            "sessions/2026/11/20/rollout-x.jsonl", "archived_sessions/x", "thread-writer-locks/t.lock", ".tmp/x", "tmp/arg0/x",
            "log/codex-tui.log", "state_5.sqlite", "state_5.sqlite-wal", "logs_2.sqlite", "memories_1.sqlite",
            "goals_1.sqlite", "history.jsonl", "session_index.jsonl", "shell_snapshots/s.sh", "version.json",
            "installation_id", ".tmp/plugins.sync.lock", "plugins.toml.bak", "skills-old",
        ] {
            assert!(!codex_denies(&rules, &format!("/c/h/{w}")), "/c/h/{w}");
        }
        // The denies come after the allow, so they win.
        let profile = render_profile(&rules);
        let allow = profile.find("(allow file-write*").unwrap();
        let deny = profile.rfind("(regex \"^/c/h/").unwrap();
        assert!(allow < deny, "{profile}");
        assert!(profile.contains("(deny file-link"), "hard links of the copies are denied too");
    }

    #[test]
    fn only_what_the_profile_denies_is_cleared_from_a_codex_home() {
        for denied in ["AGENTS.md", "agents.MD", ".env", "models_cache.json", "Models_Cache.json", "managed-config-acme.json", "environments.toml", "x.config.toml", "Config.TOML.bak.toml", "skills", "Secrets", "cache", "packages", "proxy"] {
            assert!(is_denied_top_level(denied), "{denied}");
        }
        for kept in ["config.toml", "CONFIG.toml", "auth.json", "sessions", "log", ".tmp", "tmp", "state_5.sqlite", "history.jsonl", "version.json", "installation_id"] {
            assert!(!is_denied_top_level(kept), "{kept}");
        }
        // Read the way the volume compares names (#1270).
        for denied in ["in\u{FB06}ructions.md", "managed-con\u{FB01}g-acme.json", "x.TOM\u{212A}.toml", "\u{17F}kills", "Secret\u{17F}"] {
            assert!(is_denied_top_level(denied), "{denied}");
        }
        assert!(!is_denied_top_level("con\u{FB01}g.toml"), "Octopush's own copy, as the volume sees it");
    }

    /// Whether the anchored `ci_regex` of `name` matches `path`.
    fn ci_matches(name: &str, path: &str) -> bool {
        regex::Regex::new(&format!("^{}$", ci_regex(name))).unwrap().is_match(path)
    }

    /// The characters outside ASCII that fold to ASCII on the volume.
    const FOLDING_TO_ASCII: [char; 11] = [
        '\u{DF}', '\u{17F}', '\u{1E9E}', '\u{212A}', '\u{FB00}', '\u{FB01}', '\u{FB02}', '\u{FB03}', '\u{FB04}',
        '\u{FB05}', '\u{FB06}',
    ];

    #[test]
    fn ci_regex_matches_every_ligature_of_the_latin_block() {
        for c in '\u{FB00}'..='\u{FB06}' {
            let letters = crate::name_fold::fold(&c.to_string());
            let name = format!("x{letters}y.json");
            for spelling in [name.clone(), name.to_ascii_uppercase(), format!("x{c}y.json"), format!("X{c}Y.JSON")] {
                assert!(ci_matches(&name, &spelling), "U+{:04X}: {spelling}", c as u32);
            }
            assert!(!ci_matches(&name, &format!("x{c}{c}y.json")), "U+{:04X}", c as u32);
            assert!(!ci_matches(&name, "xy.json"), "U+{:04X}", c as u32);
        }
        // Ligatures that overlap, and the sharp s.
        let words: [(&str, &[&str]); 3] = [
            ("offline", &["o\u{FB00}line", "of\u{FB02}ine", "o\u{FB04}ine", "OFFLINE"]),
            ("official", &["o\u{FB03}cial", "of\u{FB01}cial", "o\u{FB00}icial"]),
            ("mistress", &["mi\u{FB05}re\u{DF}", "MI\u{FB06}RE\u{1E9E}", "mi\u{17F}tre\u{17F}\u{17F}"]),
        ];
        for (name, spellings) in words {
            for s in spellings {
                assert!(ci_matches(name, s), "{name}: {s}");
            }
        }
        assert!(!ci_matches("offline", "o\u{FB00}\u{FB02}ine"));
        assert_eq!(ci_regex("st"), "((S|s|\u{17F})[Tt]|(\u{FB05}|\u{FB06}))");
        assert_eq!(ci_regex(".env"), "\\.[Ee][Nn][Vv]");
    }

    #[test]
    fn ci_regex_denies_every_ligature_spelling_of_a_protected_name() {
        for name in CODEX_HOME_DENIED_FILES.iter().chain(CODEX_HOME_DENIED_DIRS) {
            let folded = crate::name_fold::fold(name);
            for c in FOLDING_TO_ASCII {
                let letters = crate::name_fold::fold(&c.to_string());
                for (i, _) in folded.match_indices(letters.as_str()) {
                    let spelling = format!("{}{c}{}", &name[..i], &name[i + letters.len()..]);
                    assert!(ci_matches(name, &spelling), "{name}: {spelling}");
                }
            }
        }
    }

    #[test]
    fn ci_regex_matches_what_name_fold_matches() {
        assert!(ci_matches(".mcp.json", ".mcp.j\u{17F}on"));
        assert!(ci_matches("tasks.json", "tas\u{212A}s.json"));
        assert!(ci_matches("workflows", "work\u{FB02}ows"));
        assert!(ci_matches("claude.md", "CLAUDE.MD"));
        assert!(ci_matches("STRASSE", "Stra\u{DF}e"));
        // A name written with a ligature matches its plain spelling too.
        assert!(ci_matches("work\u{FB02}ows", "WORKFLOWS"));
        // What can't be spelled out denies the whole family: every spelling
        // of the name, and never across a `/`.
        for s in ["Caf\u{E9}.md", "Cafe\u{301}.md", "CAF\u{C9}.MD", "cafe\u{301}.md"] {
            assert!(ci_matches("Caf\u{E9}.md", s), "{s}");
            assert!(ci_matches("Cafe\u{301}.md", s), "{s}");
        }
        assert!(!ci_matches("Caf\u{E9}.md", "x/Caf\u{E9}.md"));
        assert!(!ci_matches("Caf\u{E9}.md", "Caf\u{E9}.txt"));
        assert!(ci_matches("\u{C5}ngstr\u{F6}m", "A\u{30A}ngstro\u{308}m"));
        assert!(ci_matches("\u{C5}ngstr\u{F6}m", "\u{C5}NGSTR\u{D6}M"));
    }

    #[test]
    #[cfg(unix)]
    fn a_codex_home_is_cleared_of_denied_entries_before_each_launch() {
        let dir = tempfile::tempdir().unwrap();
        let home = canonical_lenient(dir.path());
        for d in ["sessions/2026", "skills/x", "secrets", ".tmp/plugins/p", ".tmp/marketplaces/m", ".tmp/keep", "cache/codex_apps_tools"] {
            std::fs::create_dir_all(home.join(d)).unwrap();
        }
        for f in ["sessions/2026/r.jsonl", "skills/x/SKILL.md", "AGENTS.md", ".env", "models_cache.json", "managed-config-ns.json", "environments.toml", ".tmp/plugins.sha", ".tmp/keep/k", "state_5.sqlite", "config.toml"] {
            std::fs::write(home.join(f), "x").unwrap();
        }
        // A link is removed, never followed.
        let outside = home.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("keep"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, home.join("prompts")).unwrap();
        purge_denied_entries(&home).unwrap();
        for gone in ["skills", "secrets", ".tmp/plugins", ".tmp/marketplaces", "cache", "AGENTS.md", ".env", "models_cache.json", "managed-config-ns.json", "environments.toml", ".tmp/plugins.sha", "prompts"] {
            assert!(std::fs::symlink_metadata(home.join(gone)).is_err(), "{gone} is still there");
        }
        for kept in ["sessions/2026/r.jsonl", ".tmp/keep/k", "state_5.sqlite", "config.toml", "outside/keep"] {
            assert!(home.join(kept).exists(), "{kept} was removed");
        }
    }

    #[test]
    fn a_codex_stage_keeps_its_state_db_and_logs_in_its_own_home() {
        assert_eq!(
            codex_home_overrides("/c/h/"),
            vec!["-c".to_string(), "sqlite_home=\"/c/h\"".to_string(), "-c".to_string(), "log_dir=\"/c/h/log\"".to_string()]
        );
        // A quote in the path stays inside the TOML string.
        assert_eq!(codex_home_overrides("/c/a\"b")[1], "sqlite_home=\"/c/a\\\"b\"");
    }

    #[test]
    fn removing_a_workspace_takes_its_codex_homes_even_when_its_build_cache_cant_go() {
        let dir = tempfile::tempdir().unwrap();
        let (cache, tmp, codex) = (dir.path().join("build-cache"), dir.path().join("tmp"), dir.path().join("codex-home"));
        let home = codex_home_dir(&codex, "/ws", &[], CT);
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("auth.json"), "{}").unwrap();
        // The build cache's workspace dir can't be listed: its removal fails.
        let ws_cache = workspace_cache_dir(&cache, "/ws");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(&ws_cache, "not a dir").unwrap();
        let other = codex_home_dir(&codex, "/other", &[], CT);
        std::fs::create_dir_all(&other).unwrap();
        let _ = remove_workspace_dirs(Some(&cache), Some(&tmp), Some(&codex), "/ws");
        assert!(!home.exists(), "the workspace's Codex home is gone");
        assert!(other.exists(), "another workspace's is kept");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // A build cache that can't be removed (an unwritable workspace dir).
            std::fs::remove_file(&ws_cache).unwrap();
            std::fs::create_dir_all(ws_cache.join("root/sub")).unwrap();
            std::fs::create_dir_all(&home).unwrap();
            std::fs::set_permissions(&ws_cache, std::fs::Permissions::from_mode(0o500)).unwrap();
            let got = remove_workspace_dirs(Some(&cache), None, Some(&codex), "/ws");
            std::fs::set_permissions(&ws_cache, std::fs::Permissions::from_mode(0o700)).unwrap();
            // (Root removes it anyway, so only a normal user sees the failure.)
            assert!(got.is_err() || current_uid() == Some(0), "the build cache's failure is reported");
            assert!(!home.exists(), "and the Codex home went all the same");
        }
    }

    #[test]
    fn the_codex_sign_in_preflight_passes_keys_by_env_and_never_hands_out_a_refresh_token() {
        let now = utc("2026-11-20T12:00:00Z");
        let fresh = token_expiring(utc("2026-11-28T12:00:00Z"));
        // `CODEX_API_KEY` already reaches the stage: the file isn't even parsed.
        assert_eq!(codex_auth_plan(true, Some("not json"), now), Ok(CodexAuthPlan::EnvKey));
        assert_eq!(codex_auth_plan(false, None, now), Ok(CodexAuthPlan::Nothing));
        // An API-key sign-in goes by env, never by file.
        assert_eq!(codex_auth_plan(false, Some(r#"{"OPENAI_API_KEY":" sk-test "}"#), now), Ok(CodexAuthPlan::ApiKey("sk-test".into())));
        assert_eq!(
            codex_auth_plan(false, Some(r#"{"auth_mode":"apikey","OPENAI_API_KEY":"sk-test"}"#), now),
            Ok(CodexAuthPlan::ApiKey("sk-test".into()))
        );
        // A fresh ChatGPT sign-in: a copy without the refresh token.
        let text = chatgpt_auth("2026-11-18T09:30:00.123Z", &fresh);
        let Ok(CodexAuthPlan::ChatGpt(copy)) = codex_auth_plan(false, Some(&text), now) else { panic!("a fresh sign-in passes") };
        let v: serde_json::Value = serde_json::from_str(&copy).unwrap();
        assert_eq!(v["tokens"]["refresh_token"], "");
        assert_eq!(v["tokens"]["access_token"], fresh.as_str());
        assert_eq!(v["tokens"]["id_token"], "id-token-value");
        assert_eq!(v["last_refresh"], "2026-11-18T09:30:00.123Z");
        assert!(!copy.contains("rt-secret-value"));
        let explicit = text.replacen('{', r#"{"auth_mode":"chatgpt","#, 1);
        assert!(matches!(codex_auth_plan(false, Some(&explicit), now), Ok(CodexAuthPlan::ChatGpt(_))));
        // Exactly 7 days old still passes; any older fails closed.
        assert!(matches!(codex_auth_plan(false, Some(&chatgpt_auth("2026-11-13T12:00:00Z", &fresh)), now), Ok(CodexAuthPlan::ChatGpt(_))));
        for stale in ["2026-11-13T11:59:59Z", "2026-11-01T00:00:00Z", "yesterday"] {
            assert_eq!(codex_auth_plan(false, Some(&chatgpt_auth(stale, &fresh)), now), Err("Open Codex once to refresh sign-in"), "{stale}");
        }
        let no_refresh = serde_json::json!({ "tokens": { "access_token": fresh, "refresh_token": "r" } }).to_string();
        assert_eq!(codex_auth_plan(false, Some(&no_refresh), now), Err(CODEX_REFRESH_SIGN_IN));
        // An access token expiring within a day fails closed too, however
        // fresh `last_refresh` says it is; an opaque one is judged by
        // `last_refresh` alone, as Codex does.
        let soon = token_expiring(utc("2026-11-21T06:00:00Z"));
        assert_eq!(codex_auth_plan(false, Some(&chatgpt_auth("2026-11-20T11:00:00Z", &soon)), now), Err(CODEX_REFRESH_SIGN_IN));
        assert!(matches!(codex_auth_plan(false, Some(&chatgpt_auth("2026-11-20T11:00:00Z", "opaque")), now), Ok(CodexAuthPlan::ChatGpt(_))));
        // No tokens saved: nothing to copy.
        assert_eq!(codex_auth_plan(false, Some(r#"{"OPENAI_API_KEY":null}"#), now), Ok(CodexAuthPlan::Nothing));
        // Unreadable shapes and other sign-ins fail closed.
        for bad in ["", "[]", "not json", r#"{"auth_mode":3}"#, r#"{"tokens":"x"}"#, r#"{"tokens":{"refresh_token":"r"}}"#] {
            assert_eq!(codex_auth_plan(false, Some(bad), now), Err(CODEX_SIGN_IN_UNREADABLE), "{bad}");
        }
        for other in [
            r#"{"auth_mode":"chatgptAuthTokens","tokens":{"access_token":"a"}}"#,
            r#"{"auth_mode":"agentIdentity"}"#,
            r#"{"auth_mode":"headers"}"#,
            r#"{"personal_access_token":"at-x"}"#,
            r#"{"bedrock_api_key":{"key":"k"}}"#,
            r#"{"auth_mode":"apikey","OPENAI_API_KEY":""}"#,
        ] {
            assert_eq!(codex_auth_plan(false, Some(other), now), Err(CODEX_SIGN_IN_UNSUPPORTED), "{other}");
        }
        // Never a secret in a log line.
        for plan in [CodexAuthPlan::ApiKey("sk-test".into()), CodexAuthPlan::ChatGpt(copy)] {
            let shown = format!("{plan:?}");
            assert!(!shown.contains("sk-test") && !shown.contains("access_token"), "{shown}");
        }
    }

    #[test]
    fn a_users_codex_file_is_copied_only_as_a_small_regular_file_of_theirs() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.toml");
        assert!(read_user_file(&file, current_uid()).unwrap().is_none(), "a missing file is no copy");
        std::fs::write(&file, "model = \"gpt-5\"\n").unwrap();
        assert_eq!(read_user_file(&file, current_uid()).unwrap().as_deref(), Some(&b"model = \"gpt-5\"\n"[..]));
        assert!(read_user_file(dir.path(), current_uid()).is_err(), "a dir");
        let big = dir.path().join("big.toml");
        std::fs::write(&big, vec![b'#'; (CODEX_SOURCE_MAX_BYTES + 1) as usize]).unwrap();
        assert!(read_user_file(&big, current_uid()).is_err(), "too large");
        #[cfg(unix)]
        {
            // A dotfiles link is followed, as Codex follows it.
            let link = dir.path().join("linked.toml");
            std::os::unix::fs::symlink(&file, &link).unwrap();
            assert!(read_user_file(&link, current_uid()).unwrap().is_some());
            let someone_else = current_uid().map(|u| u.wrapping_add(1));
            let err = read_user_file(&file, someone_else).unwrap_err();
            assert!(err.to_string().contains("not owned by you"), "{err}");
        }
    }

    #[test]
    #[cfg(unix)]
    fn a_read_only_copy_lands_as_a_fresh_file_and_never_writes_through_a_link() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let staging = canonical_lenient(dir.path());
        let home = staging.join("home");
        create_dir_0700(&home).unwrap();
        install_read_only_copy(&home, &staging, "config.toml", Some(b"a = 1\n")).unwrap();
        let copy = home.join("config.toml");
        assert_eq!(std::fs::read(&copy).unwrap(), b"a = 1\n");
        assert_eq!(std::fs::metadata(&copy).unwrap().permissions().mode() & 0o777, 0o400);
        // Replaced on the next launch, read-only as it is.
        install_read_only_copy(&home, &staging, "config.toml", Some(b"a = 2\n")).unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), b"a = 2\n");
        // Nothing is left behind in the staging dir.
        let left: Vec<_> = std::fs::read_dir(&staging).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left, vec![std::ffi::OsString::from("home")], "{left:?}");
        // A link at the name is replaced, never written through.
        let outside = staging.join("outside.toml");
        std::fs::write(&outside, "original\n").unwrap();
        std::fs::remove_file(&copy).unwrap();
        std::os::unix::fs::symlink(&outside, &copy).unwrap();
        install_read_only_copy(&home, &staging, "config.toml", Some(b"a = 3\n")).unwrap();
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "original\n");
        let meta = std::fs::symlink_metadata(&copy).unwrap();
        assert!(meta.is_file() && !meta.file_type().is_symlink());
        // No copy: what is there goes; nothing there is fine.
        install_read_only_copy(&home, &staging, "config.toml", None).unwrap();
        assert!(std::fs::symlink_metadata(&copy).is_err());
        install_read_only_copy(&home, &staging, "config.toml", None).unwrap();
        // A home or staging dir that is a link is refused (O_NOFOLLOW), and
        // nothing lands where it points.
        let target = staging.join("target");
        std::fs::create_dir(&target).unwrap();
        let linked = staging.join("linked-home");
        std::os::unix::fs::symlink(&target, &linked).unwrap();
        assert!(install_read_only_copy(&linked, &staging, "config.toml", Some(b"x")).is_err());
        assert!(install_read_only_copy(&home, &linked, "config.toml", Some(b"x")).is_err());
        assert!(std::fs::read_dir(&target).unwrap().next().is_none(), "nothing written through the link");
    }

    /// A stand-in user Codex home in `dir` with a config, a fresh ChatGPT
    /// sign-in, instructions and a prompt.
    #[cfg(unix)]
    fn user_codex_home(dir: &Path) -> PathBuf {
        let user = dir.join(".codex");
        std::fs::create_dir_all(user.join("prompts")).unwrap();
        std::fs::create_dir_all(user.join("sessions")).unwrap();
        std::fs::write(user.join("config.toml"), "model = \"gpt-5\"\n").unwrap();
        let now = chrono::Utc::now();
        let auth = chatgpt_auth(&(now - chrono::Duration::days(1)).to_rfc3339(), &token_expiring(now + chrono::Duration::days(9)));
        std::fs::write(user.join("auth.json"), auth).unwrap();
        std::fs::write(user.join("AGENTS.md"), "original\n").unwrap();
        std::fs::write(user.join("prompts/p.md"), "original\n").unwrap();
        user
    }

    #[test]
    #[cfg(unix)]
    fn preparing_a_codex_home_copies_the_config_and_sign_in_read_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_lenient(dir.path());
        let base = root.join("codex-home");
        let user = user_codex_home(&root);
        let roots = vec!["/ws".to_string()];
        let now = chrono::Utc::now();
        let home = prepare_codex_home_in(&base, "/ws", &roots, CT, &user, false, now).unwrap();
        let h = PathBuf::from(&home.dir);
        assert_eq!(h, codex_home_dir(&base, "/ws", &roots, CT));
        assert_eq!(std::fs::metadata(&h).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(std::fs::read(h.join("config.toml")).unwrap(), std::fs::read(user.join("config.toml")).unwrap());
        for f in ["config.toml", "auth.json"] {
            assert_eq!(std::fs::metadata(h.join(f)).unwrap().permissions().mode() & 0o777, 0o400, "{f}");
        }
        let auth: serde_json::Value = serde_json::from_slice(&std::fs::read(h.join("auth.json")).unwrap()).unwrap();
        assert_eq!(auth["tokens"]["refresh_token"], "", "the stage never holds the refresh token");
        assert_eq!(home.env, vec![("CODEX_HOME".to_string(), home.dir.clone()), ("CODEX_SQLITE_HOME".to_string(), home.dir.clone())]);
        assert_eq!(home.args, codex_home_overrides(&home.dir));
        let tmp = std::fs::symlink_metadata(h.join(".tmp")).unwrap();
        assert!(tmp.is_dir() && !tmp.file_type().is_symlink(), "the pinned .tmp is made as a real dir");
        assert_eq!(tmp.permissions().mode() & 0o777, 0o700);
        assert_eq!(home.user_home, vec![user.to_string_lossy().into_owned()]);
        assert!(!format!("{home:?}").contains("rt-secret"));
        // The user's own files are untouched.
        assert!(std::fs::read_to_string(user.join("auth.json")).unwrap().contains("rt-secret-value"));

        // An API-key sign-in: the key by env, and the old sign-in copy goes.
        std::fs::write(user.join("auth.json"), r#"{"OPENAI_API_KEY":"sk-test"}"#).unwrap();
        let keyed = prepare_codex_home_in(&base, "/ws", &roots, CT, &user, false, now).unwrap();
        assert!(keyed.env.contains(&("CODEX_API_KEY".to_string(), "sk-test".to_string())));
        assert!(!format!("{keyed:?}").contains("sk-test"), "{keyed:?}");
        assert!(std::fs::symlink_metadata(h.join("auth.json")).is_err());
        // `CODEX_API_KEY` in the stage's env: auth.json isn't read at all.
        std::fs::remove_file(user.join("auth.json")).unwrap();
        std::fs::create_dir(user.join("auth.json")).unwrap();
        let env = prepare_codex_home_in(&base, "/ws", &roots, CT, &user, true, now).unwrap();
        assert!(!env.env.iter().any(|(k, _)| k == "CODEX_API_KEY"));
        assert_eq!(
            prepare_codex_home_in(&base, "/ws", &roots, CT, &user, false, now),
            Err(CodexHomeError::SignIn(CODEX_SIGN_IN_UNREADABLE))
        );
        // A config the user removed is removed from the copy too.
        std::fs::remove_file(user.join("config.toml")).unwrap();
        prepare_codex_home_in(&base, "/ws", &roots, CT, &user, true, now).unwrap();
        assert!(std::fs::symlink_metadata(h.join("config.toml")).is_err());
        // A relative CODEX_HOME is refused.
        assert!(matches!(
            prepare_codex_home_in(&base, "/ws", &roots, CT, Path::new("rel/.codex"), true, now),
            Err(CodexHomeError::Setup(_))
        ));
    }

    #[test]
    #[cfg(unix)]
    fn a_stale_sign_in_fails_the_stage_before_anything_is_made() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_lenient(dir.path());
        let base = root.join("codex-home");
        let user = user_codex_home(&root);
        let now = chrono::Utc::now();
        let stale = chatgpt_auth(&(now - chrono::Duration::days(8)).to_rfc3339(), &token_expiring(now + chrono::Duration::days(2)));
        std::fs::write(user.join("auth.json"), stale).unwrap();
        let got = prepare_codex_home_in(&base, "/ws", &[], CT, &user, false, now);
        assert_eq!(got, Err(CodexHomeError::SignIn("Open Codex once to refresh sign-in")));
        assert!(!base.exists(), "the preflight runs before the home is made");
    }

    #[test]
    #[cfg(unix)]
    fn a_codex_home_swapped_for_a_link_is_refused_and_its_target_left_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_lenient(dir.path());
        let base = root.join("codex-home");
        let user = user_codex_home(&root);
        let now = chrono::Utc::now();
        let home = prepare_codex_home_in(&base, "/ws", &[], CT, &user, true, now).unwrap();
        let target = root.join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::remove_dir_all(&home.dir).unwrap();
        std::os::unix::fs::symlink(&target, &home.dir).unwrap();
        assert!(matches!(prepare_codex_home_in(&base, "/ws", &[], CT, &user, true, now), Err(CodexHomeError::Setup(_))));
        assert_eq!(std::fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o755, "not chmodded");
        assert!(std::fs::read_dir(&target).unwrap().next().is_none(), "no copy landed in the target");
    }

    /// The full profile of a Codex stage for a stand-in `$HOME` (so the real
    /// `~/.codex` is never touched), built the way a stage's is: its home
    /// prepared outside the sandbox first. The stand-in sits in the user
    /// cache dir, not in `$TMPDIR` (a system root).
    #[cfg(target_os = "macos")]
    fn codex_stage(roots: &[String]) -> (tempfile::TempDir, String, PathBuf, CodexHome, String) {
        let caches = dirs::cache_dir().unwrap();
        std::fs::create_dir_all(&caches).unwrap();
        let fake = tempfile::Builder::new().prefix("octopush-codex-test-").tempdir_in(&caches).unwrap();
        let h = canonical_string(fake.path());
        let user = user_codex_home(Path::new(&h));
        let base = PathBuf::from(format!("{h}/codex-home"));
        let scope = roots.first().cloned().unwrap_or_else(|| format!("{h}/ws"));
        let codex = prepare_codex_home_in(&base, &scope, roots, CT, &user, false, chrono::Utc::now()).unwrap();
        let (profile, _) = profile_and_refusals_for(Some(&h), None, None, Some(&codex), roots, &[]).unwrap();
        (fake, h, user, codex, profile)
    }

    #[cfg(target_os = "macos")]
    fn run_codex_stub(profile: &str, codex: &CodexHome, script: &str) -> bool {
        let (prog, args) = sandbox_argv(OsStr::new("bash"), &["-c".to_string(), script.to_string()], profile);
        std::process::Command::new(prog)
            .args(args)
            .envs(codex.env.iter().cloned())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn seatbelt_lets_a_codex_stage_write_its_own_home_but_never_codex_config() {
        // A writer stage (the workspace writable) and one with no workspace
        // write root (a readonly mission's writer role).
        let ws = tempfile::tempdir().unwrap();
        let w = canonical_string(ws.path());
        assert!(std::process::Command::new("git").args(["init", "-q", w.as_str()]).status().unwrap().success());
        for (roots, ws_writable) in [(vec![w.clone()], true), (Vec::new(), false)] {
            let (_fake, _h, user, codex, profile) = codex_stage(&roots);
            let run = |script: String| run_codex_stub(&profile, &codex, &script);
            let c = codex.dir.clone();
            let u = user.to_string_lossy().into_owned();
            // What `codex exec` writes: its session rollout, thread-writer
            // lock, `.tmp`, arg0 helpers, log, history and state DBs.
            assert!(run(r#"set -e
                mkdir -p "$CODEX_HOME/sessions/2026/11/20" && echo '{}' >> "$CODEX_HOME/sessions/2026/11/20/rollout-x.jsonl"
                mkdir -p "$CODEX_HOME/thread-writer-locks" && echo 1 > "$CODEX_HOME/thread-writer-locks/t.lock"
                mkdir -p "$CODEX_HOME/.tmp/arg0" "$CODEX_HOME/tmp/arg0" "$CODEX_HOME/log" "$CODEX_HOME/shell_snapshots"
                echo l >> "$CODEX_HOME/log/codex-tui.log" && echo h >> "$CODEX_HOME/history.jsonl"
                for db in state_5 logs_2 goals_1 memories_1 queue_1 thread_history_1; do
                  echo s > "$CODEX_SQLITE_HOME/$db.sqlite" && echo w > "$CODEX_SQLITE_HOME/$db.sqlite-wal"
                done
                echo 1 > "$CODEX_HOME/.tmp/plugins.sync.lock"
                echo t > "$CODEX_HOME/.tmp/x.tmp" && mv "$CODEX_HOME/.tmp/x.tmp" "$CODEX_HOME/version.json"
                echo r > "$CODEX_HOME/sessions/ro.txt" && chmod 400 "$CODEX_HOME/sessions/ro.txt" && chmod u+w "$CODEX_HOME/sessions/ro.txt" && echo w > "$CODEX_HOME/sessions/ro.txt""#.to_string()), "codex's own writes work");
            assert_eq!(run(format!("echo x > '{w}/probe'")), ws_writable, "the workspace is writable only for a writer");
            // Git's hooks and config stay shut either way; with no workspace
            // write root nothing in the repo's git dir is writable at all.
            for git in [format!("echo x > '{w}/.git/hooks/pre-commit'"), format!("echo x >> '{w}/.git/config'")] {
                assert!(!run(git.clone()), "must be denied: {git}");
            }
            assert_eq!(run(format!("echo x > '{w}/.git/objects/probe'")), ws_writable, "git objects follow the workspace");
            let mut denied = vec![
                // The read-only config copy: not modified, replaced, removed or linked.
                format!("chmod u+w '{c}/config.toml' && echo 'model = \"x\"' > '{c}/config.toml'"),
                format!("echo 'model = \"x\"' > '{c}/sessions/new.toml' && mv -f '{c}/sessions/new.toml' '{c}/config.toml'"),
                format!("rm -f '{c}/config.toml'"),
                format!("mv '{c}/config.toml' '{c}/sessions/moved.toml'"),
                format!("ln -sf /dev/null '{c}/config.toml'"),
                format!("ln '{c}/config.toml' '{c}/sessions/hard.toml'"),
                // Nor the sign-in copy.
                format!("chmod u+w '{c}/auth.json' && echo '{{}}' > '{c}/auth.json'"),
                format!("echo '{{}}' > '{c}/sessions/a.json' && mv -f '{c}/sessions/a.json' '{c}/auth.json'"),
                // The pinned `.tmp` can't be swapped for a link that would move
                // `.tmp/plugins` out from under its rule.
                format!("mv '{c}/.tmp' '{c}/sessions/tmp-old'"),
                format!("rm -rf '{c}/.tmp' && ln -s '{c}/sessions' '{c}/.tmp'"),
                // Through a link planted in the writable home.
                format!("ln -s '{u}' '{c}/sessions/to-user' && echo x >> '{c}/sessions/to-user/config.toml'"),
                // The user's own ~/.codex: config, sign-in, instructions, prompts, sessions.
                format!("echo x >> '{u}/config.toml'"),
                format!("echo '{{}}' > '{u}/auth.json'"),
                format!("echo x >> '{u}/AGENTS.md'"),
                format!("echo x > '{u}/prompts/p.md'"),
                format!("echo x > '{u}/prompts/new.md'"),
                format!("echo x > '{u}/sessions/rollout.jsonl'"),
                format!("echo x > '{u}/anything-new'"),
            ];
            // Everything Codex reads back, as written and in other cases (the
            // volume is case-insensitive), plus the Kelvin sign and long s, and
            // ligatures (#1270).
            let plants = [
                "in\u{FB06}ructions.md", "cloud-con\u{FB01}g-bundle-cache.json", "managed-con\u{FB01}g-acme.json",
                "AGENTS.md", "AGENTS.MD", "agents.md", "AGENTS.override.md", "instructions.md", ".env", ".ENV",
                "hooks.json", "Hooks.json", "models_cache.json", "MODELS_CACHE.JSON", "cloud-config-bundle-cache.json",
                "managed-config-acme.json", "Managed-Config-acme.JSON", "managed_config.toml", "requirements.toml",
                "environments.toml", "work.config.toml", "Config.toml", "CONFIG.TOML", ".tmp/plugins.sha",
                ".tmp/plugin-share-local-paths-v1.json", ".TMP/plugins.sha",
            ];
            for f in plants {
                denied.push(format!("echo x > '{c}/{f}'"));
            }
            let dirs = [
                "prompts/p.md", "Prompts/p.md", "skills/x/SKILL.md", "Skills/x/SKILL.md", "\u{17F}kills/x/SKILL.md",
                "s\u{212A}ills/x/SKILL.md", "migrated-command-skills/x/SKILL.md", "rules/r.rules", "RULES/r.rules",
                "memories/m.md", "memories_v2/m.md", "memories_extensions/m.md", "plugins/p/plugin.json",
                "Plugins/p/plugin.json", "hooks/hooks.json", "HOOKS/hooks.json", "agents/a.toml", "Agents/a.toml",
                "secrets/local.age", "cache/codex_apps_tools/t.json", "packages/standalone/x", "proxy/ca.pem",
                ".tmp/marketplaces/m/marketplace.json", ".tmp/plugins/p/plugin.json", ".TMP/Plugins/p/plugin.json",
            ];
            for d in dirs {
                let parent = Path::new(d).parent().unwrap().display().to_string();
                denied.push(format!("mkdir -p '{c}/{parent}' && echo x > '{c}/{d}'"));
            }
            for script in &denied {
                assert!(!run(script.clone()), "must be denied: {script}");
            }
            // With no sign-in copy, `auth.json` can't be created in any case.
            std::fs::remove_file(format!("{c}/auth.json")).unwrap();
            for a in ["auth.json", "AUTH.JSON", "Auth.json"] {
                assert!(!run(format!("echo '{{}}' > '{c}/{a}'")), "must be denied: {a}");
            }
            assert_eq!(std::fs::read_to_string(format!("{c}/config.toml")).unwrap(), "model = \"gpt-5\"\n");
            let left: Vec<String> = std::fs::read_dir(&c).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            for name in &left {
                assert!(!is_denied_top_level(name), "{name} was planted in the home: {left:?}");
            }
            let tmp = std::fs::symlink_metadata(format!("{c}/.tmp")).unwrap();
            assert!(tmp.is_dir() && !tmp.file_type().is_symlink(), ".tmp is still the real dir");
            for f in ["plugins", "marketplaces", "plugins.sha", "plugin-share-local-paths-v1.json"] {
                assert!(std::fs::symlink_metadata(format!("{c}/.tmp/{f}")).is_err(), ".tmp/{f} was created");
            }
            assert_eq!(std::fs::read_to_string(user.join("config.toml")).unwrap(), "model = \"gpt-5\"\n");
            assert!(std::fs::read_to_string(user.join("auth.json")).unwrap().contains("rt-secret-value"));
            assert_eq!(std::fs::read_to_string(user.join("AGENTS.md")).unwrap(), "original\n");
            assert_eq!(std::fs::read_to_string(user.join("prompts/p.md")).unwrap(), "original\n");
            for f in ["prompts/new.md", "sessions/rollout.jsonl", "anything-new"] {
                assert!(!user.join(f).exists(), "{f} was created in the user's Codex home");
            }
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn seatbelt_stops_a_codex_stage_swapping_its_home() {
        let (_fake, h, user, codex, profile) = codex_stage(&[]);
        let run = |script: &str| run_codex_stub(&profile, &codex, script);
        let c = codex.dir.clone();
        let ws_dir = Path::new(&c).parent().unwrap().to_path_buf();
        assert!(!run(r#"mv "$CODEX_HOME" "$CODEX_HOME.old""#), "the home can't be renamed");
        assert!(!run(r#"rm -rf "$CODEX_HOME""#), "the home can't be removed");
        assert!(!run(r#"rmdir "$CODEX_HOME"; ln -s / "$CODEX_HOME" && test -L "$CODEX_HOME""#), "the home can't be swapped for a link");
        assert!(!run(&format!("ln -s '{h}' '{}/planted'", ws_dir.display())), "nothing new beside it");
        assert!(!run(&format!("mkdir '{}/other-mode'", ws_dir.display())), "no other mode's home");
        let meta = std::fs::symlink_metadata(&c).unwrap();
        assert!(meta.is_dir() && !meta.file_type().is_symlink(), "still the real home");
        assert!(Path::new(&c).join("config.toml").is_file(), "its config copy survived the rm -rf");
        assert!(std::fs::symlink_metadata(ws_dir.join("planted")).is_err() && !ws_dir.join("other-mode").exists());
        // The next launch still prepares the same, real home.
        let again = prepare_codex_home_in(&PathBuf::from(format!("{h}/codex-home")), &format!("{h}/ws"), &[], CT, &user, false, chrono::Utc::now()).unwrap();
        assert_eq!(again.dir, c);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn seatbelt_refuses_a_nested_sandbox() {
        // Why a read-only Codex stage is refused in a sandboxed mission
        // (`cli_runner::codex_read_only_refusal`): Codex runs each command of
        // a `--sandbox read-only` stage under `sandbox-exec`, and inside the
        // mission profile applying that nested profile fails with EPERM.
        let (_fake, _h, _user, codex, profile) = codex_stage(&[]);
        let inner = "(version 1)\n(allow default)\n".to_string();
        let nested = ["-p".to_string(), inner, "/usr/bin/true".into()];
        let (prog, args) = sandbox_argv(OsStr::new(SANDBOX_EXEC), &nested, &profile);
        let out = std::process::Command::new(prog).args(args).envs(codex.env.iter().cloned()).output().unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(!out.status.success(), "a nested sandbox must not start: {stderr}");
        assert!(stderr.contains("sandbox_apply"), "applying the nested profile is what fails: {stderr}");
        assert!(stderr.contains("Operation not permitted"), "EPERM, as Codex would get it: {stderr}");
        // The same command runs outside the mission profile.
        let plain = ["-p".to_string(), "(version 1)\n(allow default)\n".to_string(), "/usr/bin/true".to_string()];
        assert!(std::process::Command::new(SANDBOX_EXEC).args(&plain).status().unwrap().success());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn a_claude_stage_in_the_mission_profile_runs_bash_without_claude_codes_own_sandbox() {
        use crate::orchestrator::cli_runner::{build_cli_args, build_cli_args_resume, turn_off_inner_sandbox, CliDialect};
        use std::os::unix::fs::PermissionsExt;
        // #1001: a fake `claude` that, like Claude Code, wraps its Bash call in
        // its own sandbox when the user's settings turn it on, unless the
        // `--settings` value turns it off.
        let dir = tempfile::tempdir().unwrap();
        let user_settings = dir.path().join("settings.json");
        std::fs::write(&user_settings, r#"{"sandbox":{"enabled":true}}"#).unwrap();
        let fake = dir.path().join("claude");
        std::fs::write(
            &fake,
            format!(
                "#!/bin/bash\nsettings=\"\"\nwhile [ $# -gt 0 ]; do [ \"$1\" = --settings ] && settings=\"$2\"; shift; done\n\
                 on=0\ngrep -q '\"enabled\":true' \"$FAKE_USER_SETTINGS\" && on=1\n\
                 case \"$settings\" in *'\"sandbox\":{{\"enabled\":false}}'*) on=0;; esac\n\
                 if [ $on = 1 ]; then exec {SANDBOX_EXEC} -p '(version 1)\n(allow default)\n' /usr/bin/true; fi\n\
                 exec /usr/bin/true\n"
            ),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let ws = tempfile::tempdir().unwrap();
        let roots = vec![canonical_string(ws.path())];
        let (profile, _) = profile_and_refusals_for(None, None, None, None, &roots, &[]).unwrap();
        let bash_call = |args: &[String]| {
            let (prog, wrapped) = sandbox_argv(fake.as_os_str(), args, &profile);
            std::process::Command::new(prog).args(wrapped).env("FAKE_USER_SETTINGS", &user_settings).output().unwrap()
        };
        for mut args in [build_cli_args("m", "sys", 10, false), build_cli_args_resume("m", "sess", 10, true)] {
            // Without the override the user's sandbox can't start in the profile.
            let out = bash_call(&args);
            let stderr = String::from_utf8_lossy(&out.stderr);
            assert!(!out.status.success() && stderr.contains("sandbox_apply"), "nested: {stderr}");
            // With it, the profile is the one boundary and the call runs.
            assert!(turn_off_inner_sandbox(CliDialect::Claude, "sandbox", &mut args));
            let out = bash_call(&args);
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        }
    }
}
