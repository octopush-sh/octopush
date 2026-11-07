//! Real-PTY smoke tests for the daemon's spawn path.
//!
//! Every other test in this crate fakes the PTY. These open a real one with
//! `native_pty_system()`, spawn through `server::build_shell_command` (the
//! exact `CommandBuilder` settings `cmd_spawn` uses: login shell `-l`, the
//! forwarded env, xterm-256color) and drive it through the master the way the
//! daemon does. They pin the portable-pty behaviour the terminal depends on,
//! in particular what 0.9 changed:
//!
//! - the child's signal mask is reset before exec (Ctrl-C must still kill a
//!   foreground job even when the spawning thread had SIGINT blocked),
//! - `search_path` resolution (bare program names resolve through PATH and
//!   no longer from the cwd),
//! - `ttyname_r` in openpty (`MasterPty::tty_name`).
//!
//! The tests are `#[serial]` (with the daemon tests in `main.rs`, which also
//! open PTYs) so the fd-count check never races another PTY, and every wait is bounded by a deadline so a regression fails
//! instead of hanging CI.

use crate::server::{build_shell_command, resolve_shell};
use crate::session::PtyHandles;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serial_test::serial;
use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const NO_ENV: [(&str, &str); 0] = [];

/// Generous: CI macOS runners can be slow to start a login shell.
const OUTPUT_TIMEOUT: Duration = Duration::from_secs(20);
const EXIT_TIMEOUT: Duration = Duration::from_secs(5);

/// A spawned PTY with its output pumped into a channel by a reader thread,
/// mirroring the daemon's `pty-reader-*` thread.
struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    out: Output,
}

/// The reader thread's side of a PTY: chunks arrive on `rx`; the channel
/// disconnects when the thread has hit EOF and dropped its master dup.
struct Output {
    rx: mpsc::Receiver<Vec<u8>>,
    text: String,
}

impl Output {
    /// Reads until `needle` shows up in the accumulated output.
    fn expect(&mut self, needle: &str) -> &str {
        let deadline = Instant::now() + OUTPUT_TIMEOUT;
        while !self.text.contains(needle) {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(left) {
                Ok(chunk) => self.text.push_str(&String::from_utf8_lossy(&chunk)),
                Err(e) => panic!(
                    "waiting for {needle:?} failed ({e}); output so far: {:?}",
                    self.text
                ),
            }
        }
        &self.text
    }

    /// Reads until `needle` shows up after the first `marker`.
    fn expect_after(&mut self, marker: &str, needle: &str) -> &str {
        let deadline = Instant::now() + OUTPUT_TIMEOUT;
        loop {
            if let Some((_, rest)) = self.text.split_once(marker) {
                if rest.contains(needle) {
                    return &self.text;
                }
            }
            let left = deadline.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(left) {
                Ok(chunk) => self.text.push_str(&String::from_utf8_lossy(&chunk)),
                Err(e) => panic!(
                    "waiting for {needle:?} after {marker:?} failed ({e}); output so far: {:?}",
                    self.text
                ),
            }
        }
    }

    /// Collects whatever output has already arrived, without waiting.
    fn drain(&mut self) {
        while let Ok(chunk) = self.rx.try_recv() {
            self.text.push_str(&String::from_utf8_lossy(&chunk));
        }
    }

    /// Drains until the reader thread exits (EOF/EIO after the child died).
    fn wait_reader_done(&mut self) {
        let deadline = Instant::now() + OUTPUT_TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(left) {
                Ok(chunk) => self.text.push_str(&String::from_utf8_lossy(&chunk)),
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    panic!("PTY reader never saw EOF after the child exited")
                }
            }
        }
    }
}

/// Polls `try_wait` (which reaps) until the child exits.
fn wait_exit(child: &mut dyn Child, within: Duration) -> portable_pty::ExitStatus {
    let deadline = Instant::now() + within;
    loop {
        if let Some(status) = child.try_wait().expect("try_wait") {
            return status;
        }
        if Instant::now() >= deadline {
            // Don't leave a stray process behind on failure.
            let _ = child.kill();
            panic!("child did not exit within {within:?}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn size(rows: u16, cols: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Opens a PTY and spawns `cmd` into it, like `cmd_spawn`.
fn spawn(cmd: CommandBuilder) -> Pty {
    spawn_with(cmd, |slave, cmd| slave.spawn_command(cmd))
}

fn spawn_with(
    cmd: CommandBuilder,
    do_spawn: impl FnOnce(
        Box<dyn portable_pty::SlavePty + Send>,
        CommandBuilder,
    ) -> anyhow::Result<Box<dyn Child + Send + Sync>>,
) -> Pty {
    let pair = native_pty_system().openpty(size(24, 80)).expect("openpty");
    let child = do_spawn(pair.slave, cmd).expect("spawn_command");
    let mut reader = pair.master.try_clone_reader().expect("clone reader");
    let writer = pair.master.take_writer().expect("take writer");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    Pty {
        master: pair.master,
        writer,
        child,
        out: Output {
            rx,
            text: String::new(),
        },
    }
}

/// `$SHELL -l -c script`: the app's login-shell command with a script.
fn shell_script(shell: &str, script: &str) -> CommandBuilder {
    let mut cmd = build_shell_command(shell, &cwd(), NO_ENV);
    cmd.arg("-c");
    cmd.arg(script);
    cmd
}

fn cwd() -> String {
    std::env::temp_dir().to_string_lossy().into_owned()
}

impl Pty {
    fn expect(&mut self, needle: &str) -> &str {
        self.out.expect(needle)
    }

    fn send(&mut self, bytes: &[u8]) {
        self.writer.write_all(bytes).expect("write to master");
        self.writer.flush().expect("flush master");
    }

    fn pid(&self) -> i32 {
        self.child.process_id().expect("child pid") as i32
    }

    fn wait_exit(&mut self, within: Duration) -> portable_pty::ExitStatus {
        wait_exit(self.child.as_mut(), within)
    }

    /// Polls the PTY's foreground process group (`tcgetpgrp` on the master,
    /// the attention checker's signal) until `pred` holds.
    fn wait_fg(&mut self, what: &str, pred: impl Fn(Option<i32>) -> bool) {
        let deadline = Instant::now() + OUTPUT_TIMEOUT;
        while !pred(self.master.process_group_leader()) {
            if Instant::now() >= deadline {
                self.out.drain();
                panic!(
                    "timed out waiting for foreground group: {what}; fg={:?}; output so far: {:?}",
                    self.master.process_group_leader(),
                    self.out.text
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn is_killed_by_sigint(status: &portable_pty::ExitStatus) -> bool {
    // portable-pty names the signal with strsignal(3): "Interrupt" on Linux,
    // "Interrupt: 2" on macOS.
    status.signal().is_some_and(|s| s.starts_with("Interrupt"))
}

// ---------------------------------------------------------------------------
// (a) Login shell, PATH, bare-name resolution
// ---------------------------------------------------------------------------

#[test]
#[serial]
fn login_shell_runs_with_non_empty_path() {
    // The daemon's own default: the client's shell, else $SHELL, else zsh.
    let shell = resolve_shell(None);
    let exists = std::path::Path::new(&shell).exists();
    // macOS always ships /bin/zsh, so a missing shell there is a real
    // failure; elsewhere (Linux CI without zsh) it is a skip.
    if cfg!(target_os = "macos") {
        assert!(exists, "resolved shell {shell} does not exist");
    } else if !exists {
        eprintln!("skipping: resolved shell {shell} does not exist here");
        return;
    }
    // `env` is a bare name, so the shell must find it through PATH.
    let mut pty = spawn(shell_script(
        &shell,
        r#"printf 'PATH=[%s]\n' "$PATH"; env >/dev/null && echo ENV_RESOLVED; exit"#,
    ));
    let out = pty.expect("ENV_RESOLVED").to_string();
    let path = out
        .split("PATH=[")
        .nth(1)
        .and_then(|rest| rest.split(']').next())
        .expect("PATH line in output");
    assert!(
        !path.trim().is_empty(),
        "login shell PATH is empty: {out:?}"
    );
    assert!(pty.wait_exit(EXIT_TIMEOUT).success());
}

#[test]
#[serial]
fn bare_shell_name_resolves_through_path() {
    // `sh`, not `/bin/sh`: portable-pty's `search_path` must resolve it
    // through the forwarded PATH.
    let mut pty = spawn(shell_script("sh", "echo BARE_$((20+22))"));
    pty.expect("BARE_42");
    assert!(pty.wait_exit(EXIT_TIMEOUT).success());
}

#[test]
#[serial]
fn bare_name_is_not_resolved_from_the_cwd() {
    // portable-pty 0.9: a bare program name is looked up on PATH only.
    // 0.8 tried `<cwd>/<name>` first, so a workspace containing an
    // executable named like the shell would have hijacked the terminal.
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::TempDir::new().unwrap();
    let name = "octopush-cwd-probe";
    let probe = dir.path().join(name);
    std::fs::write(&probe, "#!/bin/sh\necho HIJACKED\n").unwrap();
    std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut cmd = direct(name, &[]);
    cmd.cwd(dir.path());
    let pair = native_pty_system().openpty(size(24, 80)).unwrap();
    match pair.slave.spawn_command(cmd) {
        Ok(mut child) => {
            let _ = child.kill();
            let _ = child.wait();
            panic!("bare name {name} was resolved from the cwd");
        }
        // The refusal must come from PATH resolution, not from some other
        // spawn failure (bad cwd, openpty trouble...).
        Err(err) => {
            let msg = format!("{err:#}");
            assert!(
                msg.contains("No viable candidates found in PATH"),
                "spawn failed, but not because PATH lookup missed: {msg}"
            );
        }
    }

    // Control: the same probe, named explicitly relative to the cwd, does
    // resolve and run, so the refusal above is about bare-name lookup.
    let mut cmd = direct(&format!("./{name}"), &[]);
    cmd.cwd(dir.path());
    let mut pty = spawn(cmd);
    pty.expect("HIJACKED");
    assert!(pty.wait_exit(EXIT_TIMEOUT).success());
}

// ---------------------------------------------------------------------------
// (b) Signals: Ctrl-C kills the foreground job, SIGINT not blocked/ignored
// ---------------------------------------------------------------------------

#[test]
#[serial]
fn ctrl_c_kills_foreground_sleep() {
    let mut pty = spawn(shell_script("/bin/sh", "echo READY; exec sleep 30"));
    pty.expect("READY");
    let pid = pty.pid();
    // `exec` replaced the shell with sleep; it leads the foreground group.
    pty.wait_fg("sleep in the foreground", |fg| fg == Some(pid));
    pty.send(b"\x03");
    let status = pty.wait_exit(EXIT_TIMEOUT);
    assert!(
        is_killed_by_sigint(&status),
        "expected death by SIGINT, got {status:?}"
    );
}

/// Spawns `cmd` from a thread that has SIGINT blocked. fork() copies the
/// calling thread's mask and exec preserves it, so unless portable-pty
/// resets the mask (added in 0.9) the child starts with SIGINT blocked.
fn spawn_with_sigint_blocked(cmd: CommandBuilder) -> Pty {
    spawn_with(cmd, |slave, cmd| {
        std::thread::spawn(move || {
            // SAFETY: plain sigset manipulation on this thread's own mask.
            unsafe {
                let mut set: libc::sigset_t = std::mem::zeroed();
                libc::sigemptyset(&mut set);
                libc::sigaddset(&mut set, libc::SIGINT);
                assert_eq!(
                    libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut()),
                    0
                );
            }
            slave.spawn_command(cmd)
        })
        .join()
        .expect("spawner thread")
    })
}

/// A program spawned directly, without a shell in between: shells such as
/// dash unblock signals on startup and would hide a leaked mask.
fn direct(program: &str, args: &[&str]) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    cmd.cwd(cwd());
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", path);
    }
    cmd
}

#[test]
#[serial]
fn ctrl_c_works_even_if_spawner_blocked_sigint() {
    let mut pty = spawn_with_sigint_blocked(direct("sleep", &["30"]));
    let pid = pty.pid();
    pty.wait_fg("sleep in the foreground", |fg| fg == Some(pid));
    pty.send(b"\x03");
    let status = pty.wait_exit(EXIT_TIMEOUT);
    assert!(
        is_killed_by_sigint(&status),
        "child inherited a blocked SIGINT (signal mask not reset): {status:?}"
    );
}

#[cfg(target_os = "linux")]
#[test]
#[serial]
fn child_signal_mask_and_dispositions_are_clean() {
    let mut pty = spawn_with_sigint_blocked(direct(
        "grep",
        &["-E", "^Sig(Blk|Ign):", "/proc/self/status"],
    ));
    assert!(pty.wait_exit(EXIT_TIMEOUT).success());
    pty.out.wait_reader_done();
    let out = pty.out.text.clone();
    let mask = |field: &str| -> u64 {
        let line = out
            .lines()
            .find(|l| l.starts_with(field))
            .unwrap_or_else(|| panic!("{field} missing from {out:?}"));
        u64::from_str_radix(line[field.len()..].trim(), 16).unwrap()
    };
    let sigint_bit = 1u64 << (libc::SIGINT - 1);
    assert_eq!(mask("SigBlk:") & sigint_bit, 0, "SIGINT blocked in child");
    assert_eq!(mask("SigIgn:") & sigint_bit, 0, "SIGINT ignored in child");
}

// ---------------------------------------------------------------------------
// (c) Ctrl-Z job control in an interactive shell
// ---------------------------------------------------------------------------

#[test]
#[serial]
fn ctrl_z_suspends_and_fg_resumes() {
    let mut cmd = build_shell_command("/bin/sh", &cwd(), [("ENV", "/dev/null"), ("PS1", "$ ")]);
    cmd.arg("-i");
    let mut pty = spawn(cmd);
    let shell = pty.pid();
    pty.wait_fg("shell owns the terminal", |fg| fg == Some(shell));
    // Wait until the shell has finished starting up and is reading commands:
    // typed-ahead input can otherwise race the login profile.
    pty.send(b"echo PROMPT_$((1+1))\n");
    pty.expect("PROMPT_2");

    pty.send(b"sleep 30\n");
    pty.wait_fg("sleep in the foreground", |fg| {
        fg.is_some_and(|g| g != shell)
    });
    // The shell hands the terminal to the forked child before it execs
    // sleep, and until then the child still ignores SIGTSTP, so a single
    // Ctrl-Z can be lost. Resend it until the shell owns the terminal again.
    let deadline = Instant::now() + OUTPUT_TIMEOUT;
    while pty.master.process_group_leader() != Some(shell) {
        if Instant::now() >= deadline {
            pty.out.drain();
            panic!(
                "Ctrl-Z never suspended sleep; fg={:?}; output so far: {:?}",
                pty.master.process_group_leader(),
                pty.out.text
            );
        }
        pty.send(b"\x1a");
        std::thread::sleep(Duration::from_millis(200));
    }
    // The shell is reading again: prove it with a computed marker (the echo
    // of the typed line itself can't match).
    pty.send(b"echo SUSPENDED_$((40+2))\n");
    pty.expect("SUSPENDED_42");

    pty.send(b"fg\n");
    pty.wait_fg("sleep resumed in the foreground", |fg| {
        fg.is_some_and(|g| g != shell)
    });
    pty.send(b"\x03");
    pty.wait_fg("shell back after Ctrl-C", |fg| fg == Some(shell));
    pty.send(b"exit\n");
    pty.wait_exit(EXIT_TIMEOUT);
}

// ---------------------------------------------------------------------------
// (d) Resize through the daemon's PtyHandles::resize
// ---------------------------------------------------------------------------

#[test]
#[serial]
fn resize_is_seen_by_stty() {
    let pty = spawn(shell_script(
        "/bin/sh",
        "echo READY; read _go; echo SIZE=$(stty size)",
    ));
    // Hand the PTY to the daemon's own handle type and resize through it.
    let Pty {
        master,
        writer,
        child,
        mut out,
    } = pty;
    let mut handles = PtyHandles {
        master,
        writer,
        child,
    };
    out.expect("READY");
    handles.resize(50, 132).expect("resize");
    handles.writer.write_all(b"go\n").unwrap();
    handles.writer.flush().unwrap();
    out.expect("SIZE=50 132");
    assert!(wait_exit(handles.child.as_mut(), EXIT_TIMEOUT).success());
}

// ---------------------------------------------------------------------------
// (e) tty name (ttyname_r)
// ---------------------------------------------------------------------------

#[test]
#[serial]
fn tty_reports_dev_path_matching_master_tty_name() {
    let mut pty = spawn(shell_script("/bin/sh", "echo TTY=[$(tty)]"));
    // Wait for the closing bracket after the marker, not just any `]`.
    let out = pty.out.expect_after("TTY=[", "]").to_string();
    let tty = out
        .split("TTY=[")
        .nth(1)
        .and_then(|rest| rest.split(']').next())
        .expect("TTY line")
        .to_string();
    assert!(tty.starts_with("/dev/"), "tty printed {tty:?}");
    let name = pty.master.tty_name().expect("MasterPty::tty_name");
    assert_eq!(name, std::path::PathBuf::from(&tty));
    assert!(pty.wait_exit(EXIT_TIMEOUT).success());
}

// ---------------------------------------------------------------------------
// (f) Cleanup: child reaped, no fd growth across spawn/kill/drop cycles
// ---------------------------------------------------------------------------

/// Open fds that are terminals (PTY masters/slaves), via `/dev/fd`. Counting
/// only ttys keeps unrelated tests' files and sockets out of the number.
fn open_tty_fds() -> usize {
    let fds: Vec<i32> = std::fs::read_dir("/dev/fd")
        .expect("read /dev/fd")
        .filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok())
        .collect();
    fds.into_iter()
        // SAFETY: isatty only inspects the fd; a closed one returns 0.
        .filter(|&fd| unsafe { libc::isatty(fd) } == 1)
        .count()
}

#[test]
#[serial]
fn kill_and_drop_reaps_child_and_releases_fds() {
    const CYCLES: usize = 5;
    // A leak of even one master fd per spawn exceeds this.
    const TOLERANCE: usize = 1;

    // Warm up once so lazily-opened process-wide fds don't count as growth.
    {
        let mut pty = spawn(shell_script("/bin/sh", "echo READY; exec sleep 30"));
        pty.expect("READY");
        unsafe { libc::kill(-pty.pid(), libc::SIGKILL) };
        pty.wait_exit(EXIT_TIMEOUT);
        pty.out.wait_reader_done();
    }
    let before = open_tty_fds();

    for _ in 0..CYCLES {
        let mut pty = spawn(shell_script("/bin/sh", "echo READY; exec sleep 30"));
        pty.expect("READY");
        // Non-vacuous: while this PTY is open its master fd must be visible
        // to the counter, or the growth check below could never fail.
        let during = open_tty_fds();
        assert!(
            during > before,
            "open PTY not visible to the fd counter ({during} open vs {before} before)"
        );
        let pid = pty.pid();
        // Same kill as `cmd_remove`: SIGKILL to the shell's process group
        // (the shell is a session leader, so -pid is its group).
        unsafe { libc::kill(-pid, libc::SIGKILL) };
        let status = pty.wait_exit(EXIT_TIMEOUT);
        assert!(!status.success());
        // The reader thread must see EOF and drop its master dup, as the
        // daemon's `pty-reader-*` thread relies on to release handles.
        pty.out.wait_reader_done();
        drop(pty);
        // Reaped: a zombie would still answer kill(pid, 0).
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        assert!(!alive, "child {pid} not reaped after wait");
    }

    let after = open_tty_fds();
    assert!(
        after <= before + TOLERANCE,
        "open tty fds grew from {before} to {after} over {CYCLES} spawn/kill/drop cycles"
    );
}
