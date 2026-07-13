# Detached runs — phase 1 design (segment workers)

**Date:** 2026-07-12 · **Pillar:** crews that work while you don't (piece b) · **Feature key:** `runs.detached` (Pro)
**Supersedes** the daemon sketch in `2026-07-12-detached-runs-design-brief.md` — the audit killed the long-lived
daemon in favor of something far smaller that the codebase already wants to be.

## The insight the audit surfaced

`drive_inner` already terminates at **every** pause boundary (checkpoint, gate, halt, budget, loop-cap) and
re-derives every decision from DB rows on entry — there is *no* cross-segment in-memory state. A "detached run"
therefore doesn't need a resident daemon with a socket protocol and version handshakes; it needs the **existing
drive segment to run in a process that isn't the app**:

> `octopush-run-worker drive <run_id>` — a sidecar (like `octopush-pty-server` / `octopush-mcp`) that opens the
> same SQLite store, builds an `Orchestrator` with a **no-op live sink** (PersistingSink still journals to
> `stage_log`), drives **one segment** to its natural pause/completion, and exits.

Spawned with `setsid()` (the exact `pty_daemon::spawn_detached` recipe), the worker — and the `claude` CLI child
inside its session — survives the app quitting. Checkpoint decisions still happen in the app (they always did);
resolving one spawns the *next* segment's worker.

## What breaks the naive version (audit findings) → fixes

1. **`recover_interrupted_runs` clobbers a live run at app relaunch** (it marks every `running` stage failed).
   → Runs now carry a **worker lease** (`worker_nonce`, `worker_pid`, `heartbeat_at`); recovery skips any run
   whose lease heartbeat is fresh, and a periodic reconciler repairs runs whose worker died (stale heartbeat).
2. **No cross-process mutual exclusion** (the `active` set is per-process).
   → The lease *is* the cross-process claim: reserved by the app before spawn, confirmed by the worker
   (nonce-guarded UPDATE; zero rows affected ⇒ superseded ⇒ exit), cleared on segment end. App-side mutating
   commands refuse while a fresh foreign lease exists.
3. **Force-killed worker orphans its `claude` child** (`kill_on_drop` never fires on SIGKILL).
   → Worker `setsid()`s into its own session; stop is *graceful by design* (DB flag → the existing in-process
   cancel flag → `cli_runner`'s 500ms cancel watch kills the child). No SIGTERM path in phase 1.
4. **Cancellation/pause are in-memory** (`cancels`, `pause_requests`).
   → Two DB flags (`stop_requested`, `pause_requested`). The worker polls them every second and flips its own
   in-memory flags — zero changes to `agentic.rs`/`cli_runner.rs`. Abort needs nothing new: the drive loop and
   the worker's poll already read `runs.status`.

## The event bridge — DB as transport, zero frontend rewiring

Every "live" event's underlying state is persisted *before* it's emitted (cost → `set_run_cost`, status →
`set_run_status`, journal → `stage_log` via PersistingSink, checkpoint ≡ paused run + blocked stage). So the app
runs a small tokio interval (~1.2s) — the **detached bridge** — that watches leased runs and re-emits the same
`run://stage-update`, `run://cost`, `run://log` (tailed from `stage_log` by rowid cursor, through the RAW sink so
PersistingSink can't double-persist), and `run://checkpoint` events. The entire existing frontend — runs tray,
Mission Control, live journal, crew notifications — works for detached runs **unchanged**.

The bridge also:
- repairs stale-leased runs mid-session (worker crashed) → the standard interrupted/Resume flow + a needs-you ping;
- fires `sync_run_history` when it observes a detached run complete (the worker itself never touches the
  keychain — entitlement is decided by the spawning app, per the audit);
- resolves checkpoint `reason` ("director" vs "decision") from an in-app set of pending director pauses.

## Worker lifecycle

```
app (Pro, runs.detached):  reserve lease (nonce, heartbeat, detached=1) → spawn worker (setsid, reaper thread)
                           └─ spawn fails → clear lease, fall back to the in-process tokio drive (Free path)
worker:                    confirm lease (nonce UPDATE, pid=me) → 0 rows? exit
                           heartbeat + control poll (1s): status/stop_requested/pause_requested → in-memory flags
                           drive ONE segment (run_to_pause) → clear lease → exit
                           └─ if the app is gone (kill(app_pid,0) fails): osascript notification
                              "Crew finished / The crew needs you — open Octopush"
```

- Worker opens the DB **without running migrations** (the spawning app, same binary version, already migrated —
  avoids the one non-idempotent legacy migration racing).
- Worker never calls `Entitlement::current()`, never reads the keychain, never syncs history.
- WAL + busy_timeout(5s) make app-reader + worker-writer the topology SQLite is best at; the lease guarantees
  one *writer* per run.

## Schema (all additive, `add_column_if_missing`)

`runs`: `worker_pid INTEGER`, `worker_nonce TEXT`, `heartbeat_at TEXT`, `stop_requested INTEGER DEFAULT 0`,
`pause_requested INTEGER DEFAULT 0`, `detached INTEGER DEFAULT 0`.

Freshness: heartbeat every ~1s; a lease is *fresh* within 45s. Startup recovery uses heartbeat-only
freshness (a reboot-reused pid must not pin a dead run); the bridge/command guards additionally trust a
live owner pid (the in-session sleep-wake race).

## Command routing (app side)

| Command | Leased (fresh) run | Otherwise |
|---|---|---|
| `start_run` | reserve + spawn worker (fallback in-process) | in-process drive (Free / non-entitled) |
| `resolve_checkpoint` | apply mutations in-app (shared `apply_checkpoint_action`), then spawn next segment's worker | existing `resolve_checkpoint` (mutate + drive in-process) |
| `rerun_from_stage` | `prepare_rerun` in-app, release claim, spawn worker | existing prepare + `resume_claimed_drive` |
| `stop_stage` | set `stop_requested` | in-memory cancel flag |
| `request_run_pause` | set `pause_requested` + remember "director" for the bridge | in-memory pause set |
| `abort_run` | unchanged — status write is already cross-process | unchanged |

## Deferred (phase 2+)

Routines (scheduled crews) on top of the worker; worker-side rich notifications (proper APNs-style, not
osascript); cross-machine "continue elsewhere"; per-run opt-out UI (phase 1: every Pro run is detached).
