//! Unix socket accept loop and request dispatcher.

use crate::protocol::{
    AttachParams, DetachParams, KillParams, Request, RequestPayload, ResizeParams, Response,
    ResponsePayload, SpawnParams, TerminalInfo, WriteParams,
};
use crate::session::{ClientSender, PtyHandles, Session, TerminalId};
use crate::storage::read_pty_log;
use anyhow::Result;
use base64::Engine as _;
use chrono::Utc;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

// ---------------------------------------------------------------------------
// Shared daemon state
// ---------------------------------------------------------------------------

pub struct ServerState {
    pub sessions: HashMap<TerminalId, Session>,
    pub handles: HashMap<TerminalId, Arc<Mutex<PtyHandles>>>,
    pub last_active: Instant,
    /// Signals the main accept loop to stop.
    pub shutdown: bool,
}

impl ServerState {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            handles: HashMap::new(),
            last_active: Instant::now(),
            shutdown: false,
        }
    }

    fn touch(&mut self) {
        self.last_active = Instant::now();
    }
}

pub type SharedState = Arc<Mutex<ServerState>>;

// ---------------------------------------------------------------------------
// Accept loop
// ---------------------------------------------------------------------------

/// Runs the Unix socket accept loop.  Each incoming connection is handled
/// synchronously on a dedicated thread (no async here — the PTY layer is
/// already synchronous).
pub fn run_accept_loop(
    listener: UnixListener,
    state: SharedState,
    auto_exit_duration: Duration,
) -> Result<()> {
    listener.set_nonblocking(false)?;

    // Idle-check thread: exits the process when conditions are met.
    let idle_state = Arc::clone(&state);
    std::thread::Builder::new()
        .name("idle-checker".into())
        .spawn(move || {
            let check_interval = Duration::from_secs(60);
            loop {
                std::thread::sleep(check_interval);
                let st = idle_state.lock();
                let no_ptys = st.sessions.values().all(|s| !s.running);
                let no_clients = !st.sessions.values().any(|s| s.has_client());
                let idle_since = st.last_active.elapsed();
                if no_ptys && no_clients && idle_since >= auto_exit_duration {
                    info!("auto-exit: no live PTYs and no clients for {:?}", idle_since);
                    std::process::exit(0);
                }
                if st.shutdown {
                    break;
                }
            }
        })?;

    // Attention-detection thread: every second, walks every live
    // session and asks whether the PTY's foreground process group is
    // (a) the shell again (a child just exited) or (b) parked on
    // `read()` with negligible CPU. Either case emits
    // `Event::Attention` to the attached client. Detection uses
    // kernel signals via portable_pty's `process_group_leader()`
    // (which is `tcgetpgrp(master_fd)`) and `proc_pidinfo` —
    // see `Session::check_attention` for the gating logic.
    let attn_state = Arc::clone(&state);
    std::thread::Builder::new()
        .name("attention-checker".into())
        .spawn(move || {
            let tick = Duration::from_secs(1);
            loop {
                std::thread::sleep(tick);
                let mut st = attn_state.lock();
                if st.shutdown {
                    break;
                }
                // Pre-collect (id, fg_pgroup) so we can read from
                // `handles` without holding two mutable references
                // to `st` at once.
                let ids: Vec<String> = st.sessions.keys().cloned().collect();
                let fg_by_id: Vec<(String, Option<i32>)> = ids
                    .into_iter()
                    .map(|id| {
                        let fg = st.handles.get(&id).and_then(|h| {
                            let hg = h.lock();
                            hg.master.process_group_leader()
                        });
                        (id, fg)
                    })
                    .collect();
                for (id, fg) in fg_by_id {
                    if let Some(sess) = st.sessions.get_mut(&id) {
                        if sess.check_attention(fg) {
                            sess.emit_attention();
                        }
                    }
                }
            }
        })?;

    info!("accepting connections");
    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                let st = Arc::clone(&state);
                {
                    let guard = st.lock();
                    if guard.shutdown {
                        break;
                    }
                }
                std::thread::Builder::new()
                    .name("client-conn".into())
                    .spawn(move || {
                        if let Err(e) = handle_connection(s, st) {
                            debug!("connection ended: {e}");
                        }
                    })?;
            }
            Err(e) => {
                // Non-fatal — log and continue.
                warn!("accept error: {e}");
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Per-connection handler
// ---------------------------------------------------------------------------

fn handle_connection(stream: UnixStream, state: SharedState) -> Result<()> {
    let peer_write = stream.try_clone()?;
    let reader = BufReader::new(stream);
    let writer = Arc::new(Mutex::new(peer_write));

    // Per-client write channel — used by streaming push thread.
    let (tx, mut rx): (ClientSender, _) = mpsc::unbounded_channel();
    {
        // Background thread: drain the channel and write to the socket.
        let writer2 = Arc::clone(&writer);
        std::thread::Builder::new()
            .name("client-writer".into())
            .spawn(move || {
                // We can't use async here cleanly; use a blocking receive loop.
                loop {
                    match rx.blocking_recv() {
                        Some(line) => {
                            let mut w = writer2.lock();
                            if w.write_all(&line).is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
            })?;
    }

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                debug!("read error from client: {e}");
                break;
            }
        };
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let resp = Response::bare(ResponsePayload::Error {
                    message: format!("parse error: {e}"),
                });
                let _ = tx.send(resp.to_line());
                continue;
            }
        };

        let reqid = req.reqid;
        let is_shutdown = matches!(req.payload, RequestPayload::Shutdown);
        let resp = dispatch(req.payload, reqid, &state, tx.clone());
        // SentDirectly means the handler already queued its own response.
        if !matches!(resp.payload, ResponsePayload::SentDirectly) {
            let _ = tx.send(resp.to_line());
        }

        if is_shutdown {
            break;
        }
    }

    // Clean up any sessions this client was attached to.
    {
        let mut st = state.lock();
        for sess in st.sessions.values_mut() {
            // The ClientSender clone we gave sessions is the same `tx`;
            // once the connection loop exits, `tx` is dropped (all clones
            // including ones given to sessions via attach will be invalid).
            // Force-detach any session that references a now-dead sender.
            if sess.has_client() {
                sess.detach();
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

fn dispatch(
    payload: RequestPayload,
    reqid: Option<u64>,
    state: &SharedState,
    tx: ClientSender,
) -> Response {
    let inner = match payload {
        RequestPayload::ListTerminals => cmd_list_terminals(state),
        RequestPayload::Spawn(p) => cmd_spawn(p, state, tx),
        RequestPayload::Attach(p) => cmd_attach(p, reqid, state, tx),
        RequestPayload::Detach(p) => cmd_detach(p, state),
        RequestPayload::Write(p) => cmd_write(p, state),
        RequestPayload::Resize(p) => cmd_resize(p, state),
        RequestPayload::Kill(p) => cmd_kill(p, state),
        RequestPayload::Shutdown => cmd_shutdown(state),
        RequestPayload::Version => ResponsePayload::Version {
            version: env!("CARGO_PKG_VERSION").to_string(),
        },
    };
    Response::with_reqid(inner, reqid)
}

fn cmd_list_terminals(state: &SharedState) -> ResponsePayload {
    let st = state.lock();
    let terminals = st
        .sessions
        .values()
        .map(|s| TerminalInfo {
            id: s.id.clone(),
            label: s.label.clone(),
            running: s.running,
            cwd: s.cwd.clone(),
            started_at: s.started_at,
        })
        .collect();
    ResponsePayload::Terminals { terminals }
}

fn cmd_spawn(params: SpawnParams, state: &SharedState, _tx: ClientSender) -> ResponsePayload {
    let SpawnParams {
        id,
        cwd,
        env,
        shell,
        rows,
        cols,
    } = params;

    // Refuse duplicate id.
    {
        let st = state.lock();
        if st.sessions.contains_key(&id) {
            return ResponsePayload::Error {
                message: format!("terminal {id} already exists"),
            };
        }
    }

    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(e) => {
            return ResponsePayload::Error {
                message: format!("openpty: {e}"),
            }
        }
    };

    let shell = shell
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/zsh".to_string());

    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l");
    cmd.cwd(&cwd);
    for key in [
        "HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "TMPDIR",
        "SSH_AUTH_SOCK",
    ] {
        if let Ok(v) = std::env::var(key) {
            cmd.env(key, v);
        }
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    for (k, v) in &env {
        cmd.env(k, v);
    }

    let child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            return ResponsePayload::Error {
                message: format!("spawn: {e}"),
            }
        }
    };
    drop(pair.slave);

    let pid = child.process_id().unwrap_or(0);

    let mut reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            return ResponsePayload::Error {
                message: format!("clone_reader: {e}"),
            }
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => {
            return ResponsePayload::Error {
                message: format!("take_writer: {e}"),
            }
        }
    };

    let handles = Arc::new(Mutex::new(PtyHandles {
        master: pair.master,
        writer,
        child,
    }));

    let started_at = Utc::now().timestamp();
    let mut sess = Session::new(id.clone(), id.clone(), cwd, started_at);
    sess.pid = Some(pid);
    // shell_pid is what the attention-checker compares the PTY's
    // foreground pgroup against to tell shell-at-prompt vs.
    // child-running. `pid` from portable_pty is the spawned shell.
    sess.shell_pid = Some(pid as i32);

    {
        let mut st = state.lock();
        st.sessions.insert(id.clone(), sess);
        st.handles.insert(id.clone(), Arc::clone(&handles));
        st.touch();
    }

    // Reader thread: blocks on PTY reads, pushes output to session.
    let reader_id = id.clone();
    let reader_state = Arc::clone(state);
    std::thread::Builder::new()
        .name(format!("pty-reader-{id}"))
        .spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match std::io::Read::read(&mut reader, &mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let mut st = reader_state.lock();
                        if let Some(sess) = st.sessions.get_mut(&reader_id) {
                            sess.push_output(&buf[..n]);
                        }
                        st.touch();
                    }
                    Err(e) => {
                        debug!(id = %reader_id, error = %e, "pty read error");
                        break;
                    }
                }
            }
            // PTY EOF — determine exit code.
            let code = {
                let mut st = reader_state.lock();
                let code = if let Some(h) = st.handles.get(&reader_id) {
                    let mut hg = h.lock();
                    hg.child.wait().ok().map(|s| s.exit_code() as i32)
                } else {
                    None
                };
                if let Some(sess) = st.sessions.get_mut(&reader_id) {
                    sess.mark_exit(code);
                }
                code
            };
            info!(id = %reader_id, code = ?code, "pty exited");
        })
        .ok();

    info!(id = %id, pid = pid, "spawned PTY");
    ResponsePayload::Spawned { id, pid }
}

fn cmd_attach(
    params: AttachParams,
    reqid: Option<u64>,
    state: &SharedState,
    tx: ClientSender,
) -> ResponsePayload {
    let AttachParams { id, since_seq } = params;
    let since = since_seq.unwrap_or(0);

    // Clone tx for replaying backlog; the original is given to the session.
    let replay_tx = tx.clone();

    // Capture the replay snapshot ATOMICALLY with the attach, under the lock.
    //
    // Why under the lock: `Session::push_output` (the PTY reader thread)
    // appends to both the ring buffer/disk log AND forwards live to the
    // attached client, and it takes this same lock. If we read the disk log
    // *after* releasing the lock, a chunk produced during the reattach could
    // be both written to disk (and thus appear in the disk replay) AND pushed
    // live to the freshly-attached client — delivering it twice. By snapshotting
    // while holding the lock, the disk/ring replay covers exactly the bytes that
    // existed at attach time (seqs [0, current-1]) and the live stream covers
    // seq >= current, with no overlap.
    enum Replay {
        Disk(Vec<u8>),
        Ring(Vec<(u64, Vec<u8>)>),
    }
    let replay = {
        let mut st = state.lock();
        st.touch();
        let (oldest, backlog) = match st.sessions.get_mut(&id) {
            None => {
                return ResponsePayload::Error {
                    message: format!("terminal {id} not found"),
                }
            }
            Some(sess) => {
                let oldest = sess.ring_oldest_seq();
                // Attaching registers the live client; from here on new output
                // is delivered live (seq >= current).
                let backlog = sess.attach(tx, since);
                (oldest, backlog)
            }
        };

        // A gap exists when the client requests a seq older than what the ring
        // still holds — then we must replay from the disk log instead.
        if since < oldest {
            let bytes = match read_pty_log(&id) {
                Ok(b) => b,
                Err(e) => {
                    warn!(id = %id, error = %e, "failed to read disk log for replay");
                    Vec::new()
                }
            };
            debug!(id = %id, since_seq = since, ring_oldest = oldest, disk_bytes = bytes.len(), "attached client for disk replay");
            Replay::Disk(bytes)
        } else {
            debug!(id = %id, since_seq = since, ring_oldest = oldest, backlog_len = backlog.len(), "attached client for ring replay");
            Replay::Ring(backlog)
        }
    };

    // Send Ok{} FIRST (with reqid echoed) so the client's send_recv call sees
    // it before any events.
    let ok_resp = Response::with_reqid(ResponsePayload::Ok {}, reqid);
    let _ = replay_tx.send(ok_resp.to_line());

    match replay {
        Replay::Disk(bytes) if !bytes.is_empty() => {
            // The disk log is a raw byte stream without seq information.
            // Replay it as 16 KiB chunks to avoid huge single events.
            const CHUNK_SIZE: usize = 16 * 1024;
            let total_chunks = (bytes.len() + CHUNK_SIZE - 1) / CHUNK_SIZE;
            for (chunk_idx, chunk) in bytes.chunks(CHUNK_SIZE).enumerate() {
                let ev = crate::protocol::Event::Data {
                    id: id.clone(),
                    // Fake high seq to distinguish disk chunks from ring seqs;
                    // the frontend doesn't rely on it.
                    seq: u64::MAX - (total_chunks as u64 - chunk_idx as u64),
                    bytes: base64::engine::general_purpose::STANDARD.encode(chunk),
                };
                debug!(id = %id, chunk = chunk_idx, total_chunks = total_chunks, chunk_bytes = chunk.len(), "replaying disk history chunk");
                let _ = replay_tx.send(ev.to_line());
            }
        }
        Replay::Disk(_) => {
            debug!(id = %id, "disk log is empty");
        }
        Replay::Ring(backlog) => {
            // Ring buffer has all requested data; send each chunk as an event.
            for (seq, data) in backlog {
                let ev = crate::protocol::Event::Data {
                    id: id.clone(),
                    seq,
                    bytes: base64::engine::general_purpose::STANDARD.encode(&data),
                };
                debug!(id = %id, seq = seq, bytes_len = data.len(), "replaying ring buffer chunk");
                let _ = replay_tx.send(ev.to_line());
            }
        }
    }

    // Return SentDirectly so handle_connection doesn't send a duplicate Ok{}.
    ResponsePayload::SentDirectly
}

fn cmd_detach(params: DetachParams, state: &SharedState) -> ResponsePayload {
    let mut st = state.lock();
    st.touch();
    if let Some(sess) = st.sessions.get_mut(&params.id) {
        sess.detach();
        ResponsePayload::Ok {}
    } else {
        ResponsePayload::Error {
            message: format!("terminal {} not found", params.id),
        }
    }
}

fn cmd_write(params: WriteParams, state: &SharedState) -> ResponsePayload {
    let data = match base64::engine::general_purpose::STANDARD.decode(&params.data) {
        Ok(d) => d,
        Err(e) => {
            return ResponsePayload::Error {
                message: format!("base64 decode: {e}"),
            }
        }
    };

    let st = state.lock();
    match st.handles.get(&params.id) {
        None => ResponsePayload::Error {
            message: format!("terminal {} not found", params.id),
        },
        Some(h) => {
            let mut hg = h.lock();
            if let Err(e) = hg.writer.write_all(&data) {
                ResponsePayload::Error {
                    message: format!("write: {e}"),
                }
            } else {
                let _ = hg.writer.flush();
                ResponsePayload::Ok {}
            }
        }
    }
}

fn cmd_resize(params: ResizeParams, state: &SharedState) -> ResponsePayload {
    let st = state.lock();
    match st.handles.get(&params.id) {
        None => ResponsePayload::Error {
            message: format!("terminal {} not found", params.id),
        },
        Some(h) => match h.lock().resize(params.rows, params.cols) {
            Ok(_) => ResponsePayload::Ok {},
            Err(e) => ResponsePayload::Error {
                message: format!("resize: {e}"),
            },
        },
    }
}

fn cmd_kill(params: KillParams, state: &SharedState) -> ResponsePayload {
    let sigkill = params.signal.as_deref() == Some("KILL");

    let mut st = state.lock();
    match st.handles.get(&params.id) {
        None => ResponsePayload::Error {
            message: format!("terminal {} not found", params.id),
        },
        Some(h) => {
            let hg = h.lock();
            let pid = hg.child.process_id();
            drop(hg); // release lock before sending signal
            if let Some(pid) = pid {
                #[cfg(unix)]
                {
                    let sig = if sigkill {
                        libc::SIGKILL
                    } else {
                        libc::SIGTERM
                    };
                    unsafe {
                        libc::kill(pid as i32, sig);
                    }
                }
                #[cfg(not(unix))]
                {
                    let mut hg2 = st.handles.get(&params.id).unwrap().lock();
                    let _ = hg2.child.kill();
                }
            }
            if let Some(sess) = st.sessions.get_mut(&params.id) {
                sess.mark_exit(None);
            }
            ResponsePayload::Ok {}
        }
    }
}

fn cmd_shutdown(state: &SharedState) -> ResponsePayload {
    let mut st = state.lock();
    st.shutdown = true;
    info!("shutdown requested");
    ResponsePayload::Ok {}
}
