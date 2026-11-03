//! macOS seatbelt sandboxing for agent CLI execution.
//!
//! When a mission's `exec_isolation = "sandbox"`, the CLI substrate's process is
//! wrapped in `sandbox-exec -f <profile> …` under a generated SBPL profile that
//! **confines writes** to the mission's workspace (plus the temp dirs and CLI
//! session dir a real agent needs) while leaving reads and network intact — the
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
/// mission — the temp dir, `/dev`, and the Claude CLI's own session/cache dirs.
/// Kept deliberately narrow: `~/.ssh`, `~/.aws`, `~/.config` (credentials),
/// documents, and every other project stay read-only. Pure over its inputs.
///
/// Seatbelt matches the kernel-resolved (realpath) path, so only the `/private`
/// forms are live rules — `/tmp`→`/private/tmp`, `$TMPDIR`→`/private/var/…`. We
/// list the real form here; the exact `$TMPDIR` subtree's canonical form is added
/// by `assemble_write_roots`, so we don't blanket-allow all of `/var/folders`.
fn system_write_roots(home: Option<&str>, tmpdir: Option<&str>) -> Vec<String> {
    let mut v = vec!["/dev".to_string(), "/private/tmp".to_string()];
    if let Some(t) = tmpdir {
        v.push(t.to_string());
    }
    if let Some(h) = home {
        // The CLI's own session + generic tool caches — needed for it to run.
        v.push(format!("{h}/.claude"));
        v.push(format!("{h}/.cache"));
    }
    // NB: we do NOT add the global package-manager dirs (~/.cargo, ~/.gradle, …)
    // to the write roots — several are config/executable dirs, and a sandboxed
    // agent could plant a `~/.cargo/config.toml` rustc-wrapper or a
    // `~/.gradle/init.d/*.gradle` that runs OUTSIDE the sandbox on the user's
    // next build (a full confinement escape). Instead, a sandboxed BUILD is made
    // to write its caches into the already-allowed temp via env redirection —
    // see `sandbox_cache_env`.
    v
}

/// A short, stable hex scope key for a string (e.g. a workspace path) — used to
/// give each mission its OWN cache subtree so one sandboxed mission can't poison
/// the cache another later compiles.
fn scope_key(s: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Env vars that redirect common build toolchains' WRITE caches into a confined
/// **per-mission** subtree of `$TMPDIR` (already an allowed write root), so a
/// sandboxed `npm install`/`cargo build` works WITHOUT exposing the user's real
/// `~/.cargo` etc. AND without two sandboxed missions sharing (and poisoning)
/// one cache — `scope` (the workspace path) keys the subtree. Read-only global
/// installs (toolchains, tool binaries on PATH) still work — reads are open;
/// only writes are redirected. Applied by the CLI substrate and TALK's sandboxed
/// `run_command`. Pure over its inputs.
pub fn sandbox_cache_env(tmpdir: &str, scope: &str) -> Vec<(String, String)> {
    let base = format!(
        "{}/octopush-build-cache/{}",
        tmpdir.trim_end_matches('/'),
        scope_key(scope)
    );
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
    ]
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

/// Merge the mission's write roots with the system defaults, add canonical forms
/// (seatbelt matches realpaths, so a symlinked root must appear resolved too),
/// and de-duplicate. Pure over its inputs.
fn assemble_write_roots(mission_roots: &[String], home: Option<&str>, tmpdir: Option<&str>) -> Vec<String> {
    let mut roots: Vec<String> = mission_roots.to_vec();
    roots.extend(system_write_roots(home, tmpdir));
    // Add realpath forms where they differ (best-effort; skip non-existent).
    let mut canonical: Vec<String> = Vec::new();
    for r in &roots {
        if let Ok(c) = std::fs::canonicalize(r) {
            let cs = c.to_string_lossy().into_owned();
            if &cs != r {
                canonical.push(cs);
            }
        }
    }
    roots.extend(canonical);
    roots.sort();
    roots.dedup();
    roots
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
        subpaths: vec![
            g.to_string(),
            format!("{c}/objects"),
            format!("{c}/refs"),
            format!("{c}/logs"),
            format!("{c}/reftable"),
        ],
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

/// Render an SBPL profile that allows everything by default, denies all file
/// writes, then re-allows writes under `subpaths` (directory subtrees) and to
/// `literals` (individual files), and finally denies writes to and hardlinks
/// of `deny_subpaths`, `deny_literals` and `deny_regexes`. In SBPL the last
/// matching rule wins, so the trailing denies beat any allow above them. `(allow default)`
/// keeps reads and network working — confinement is on writes only. Pure.
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
    p.push_str("(allow file-write*\n");
    filters(&mut p, "subpath", &rules.subpaths);
    filters(&mut p, "literal", &rules.literals);
    p.push_str(")\n");
    if !rules.deny_subpaths.is_empty() || !rules.deny_literals.is_empty() || !rules.deny_regexes.is_empty() {
        // `file-link` is checked against the file being linked, not the new
        // name, and isn't part of `file-write*`: without it a stage could
        // hardlink `.git/config` or a hook into the workspace and write
        // through the link.
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

/// Build the seatbelt profile text for a mission's write roots, resolving the
/// system dirs from the environment and each workspace root's git layout. A
/// readonly mission has no mission roots, so it gets no git rules (temp-only).
/// Errors when a workspace's git layout can't be resolved (fail closed).
pub fn build_seatbelt_profile(mission_write_roots: &[String]) -> AppResult<String> {
    let home = std::env::var("HOME").ok();
    let tmpdir = std::env::var("TMPDIR").ok();
    let mut rules = WriteRules {
        subpaths: assemble_write_roots(mission_write_roots, home.as_deref(), tmpdir.as_deref()),
        literals: system_write_files(home.as_deref()),
        ..WriteRules::default()
    };
    let write_roots = rules.subpaths.clone();
    for root in mission_write_roots {
        if let Some(layout) = resolve_git_layout(root)? {
            rules.extend(git_write_rules(&canonical_string(Path::new(root)), &layout, &write_roots));
        }
    }
    rules.dedup();
    Ok(render_profile(&rules))
}

/// Wrap a program + args as a `sandbox-exec -f <profile> <program> <args…>` argv.
/// Pure — returns the new program and full arg vector.
fn sandbox_argv(program: &OsStr, args: &[String], profile_path: &Path) -> (OsString, Vec<OsString>) {
    let mut wrapped: Vec<OsString> = Vec::with_capacity(args.len() + 3);
    wrapped.push(OsString::from("-f"));
    wrapped.push(profile_path.as_os_str().to_os_string());
    wrapped.push(program.to_os_string());
    for a in args {
        wrapped.push(OsString::from(a));
    }
    (OsString::from(SANDBOX_EXEC), wrapped)
}

/// Removes the generated profile file when the stage's command finishes.
pub struct ProfileGuard {
    path: PathBuf,
}

impl Drop for ProfileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// The wrapped command ready to spawn, plus the profile-cleanup guard (hold it
/// until after the child exits).
pub struct Prepared {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub guard: ProfileGuard,
}

/// Prepare a sandboxed launch: verify the platform + driver, write a fresh
/// seatbelt profile, and return the wrapped argv. Errors (no silent fallback) if
/// sandboxing is unavailable or the profile can't be written. Shared by the CLI
/// substrate (wrapping `claude`) and in-process `run_command` (wrapping `bash`).
pub fn prepare(write_roots: &[String], program: &OsStr, args: &[String]) -> AppResult<Prepared> {
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
    let profile = build_seatbelt_profile(write_roots)?;
    let path = std::env::temp_dir().join(format!("octopush-sandbox-{}.sb", uuid::Uuid::new_v4()));
    std::fs::write(&path, profile)
        .map_err(|e| AppError::Other(format!("could not write the sandbox profile: {e}")))?;
    let (prog, wrapped) = sandbox_argv(program, args, &path);
    Ok(Prepared {
        program: prog,
        args: wrapped,
        guard: ProfileGuard { path },
    })
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
        let p = build_seatbelt_profile(&[]).unwrap();
        assert!(!p.contains("/objects\""));
        assert!(!p.contains("(deny file-write*\n"));
        assert!(!p.contains("(deny file-link"));
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
        assert!(build_seatbelt_profile(&wt_root).is_err());
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
            let prepared = prepare(&roots, OsStr::new("bash"), &args).unwrap();
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
        let roots = assemble_write_roots(&["/ws".to_string()], Some("/home/u"), Some("/tmp/session"));
        assert!(roots.contains(&"/ws".to_string()));
        assert!(roots.contains(&"/home/u/.claude".to_string()));
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
        let roots = assemble_write_roots(&[], Some("/home/u"), Some("/tmp/session"));
        assert!(!roots.iter().any(|r| r.starts_with("/home/u/.cargo") || r == "/home/u/go"));
        assert!(!roots.contains(&"/ws".to_string()));
        // Temp + the CLI's own dirs are still there (a shell needs them).
        assert!(roots.contains(&"/tmp/session".to_string()));
        assert!(roots.contains(&"/home/u/.claude".to_string()));
    }

    #[test]
    fn sandbox_cache_env_redirects_into_the_confined_temp() {
        let env: std::collections::HashMap<String, String> =
            sandbox_cache_env("/tmp/session", "/ws-a").into_iter().collect();
        // Every redirect points under the confined temp, never at ~.
        for (k, v) in &env {
            assert!(v.starts_with("/tmp/session/octopush-build-cache/"), "{k}={v} escaped temp");
        }
        assert!(env.get("CARGO_HOME").unwrap().ends_with("/cargo"));
        assert!(env.contains_key("npm_config_cache"));
        assert!(env.contains_key("GOPATH"));
        assert!(env.contains_key("GRADLE_USER_HOME"));
        // Per-mission isolation: a DIFFERENT workspace gets a DIFFERENT cache
        // subtree, so one sandboxed mission can't poison another's build cache.
        let other: std::collections::HashMap<String, String> =
            sandbox_cache_env("/tmp/session", "/ws-b").into_iter().collect();
        assert_ne!(env.get("CARGO_HOME"), other.get("CARGO_HOME"));
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
    fn sandbox_argv_prepends_driver_flags_then_program() {
        let (prog, args) = sandbox_argv(
            OsStr::new("/usr/local/bin/claude"),
            &["-p".to_string(), "hi".to_string()],
            Path::new("/tmp/p.sb"),
        );
        assert_eq!(prog, OsString::from(SANDBOX_EXEC));
        assert_eq!(
            args,
            vec![
                OsString::from("-f"),
                OsString::from("/tmp/p.sb"),
                OsString::from("/usr/local/bin/claude"),
                OsString::from("-p"),
                OsString::from("hi"),
            ]
        );
    }
}
