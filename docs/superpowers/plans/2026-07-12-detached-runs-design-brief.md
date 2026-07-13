# Detached runs — design brief (pillar: "crews that work while you don't")

> Piece (b) of the unattended-operation pillar. (a) crew notifications shipped
> first; (c) Routines (scheduled crews) stacks on top of this.

## The promise
Close the Octopush app — the crew keeps working. Reopen — Mission Control
shows what happened while you were gone. "Background" finally means it.

## Why it's credible here
The exact precedent exists in-repo: **octopush-pty-server**, a sidecar daemon
that outlives the app (terminals survive app restarts; protocol v2). Runs die
today only because they're tokio tasks inside the app process.

## Sketch (to be validated by a full audit next cycle)
- A headless **octopush-run-server** sidecar owning the orchestrator drive
  loop, talking to the same SQLite store (WAL is already on; the single
  Mutex<Db> becomes cross-process — needs the audit's attention).
- App ⇄ daemon protocol like the PTY daemon's (spawn/adopt/events). Events
  currently flow through Tauri emit → must bridge daemon→app (socket) with
  the SAME `run://*` payload shapes so every store/surface keeps working.
- Handoff semantics: app-started runs ADOPTABLE by the daemon (or all runs
  daemon-run from the start — cleaner; app becomes a pure client).
- CLI-substrate stages already spawn `claude` as a child — the daemon just
  needs to own that lifecycle instead of the app.
- Gates while detached: run pauses as today; **crew notifications (a)** ping;
  on reopen, Mission Control's Needs-you band is the inbox. (Notifications
  from the daemon itself — e.g. via `osascript`/UNUserNotification — are part
  of the audit.)
- Pro gating: `runs.detached` feature key; Free runs die with the app as today.

## Open questions for the audit
1. Cross-process SQLite: WAL + busy_timeout enough? Who owns migrations?
2. Event bridge transport (unix socket like PTY? port?); reconnect/replay.
3. Provider keys: daemon needs settings.json + keychain access headlessly.
4. Crash/upgrade story: daemon version vs app version (PTY protocol-v2 lesson).
5. Entitlement check in the daemon (offline grace vs re-verification).
