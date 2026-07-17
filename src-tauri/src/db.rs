//! SQLite persistence for sessions and token events.

use crate::error::AppResult;
use crate::session::{Session, SessionStatus};
use crate::token_engine::{CostEntry, TokenEvent, TokenReport, TrendPoint};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Idempotently add a SQLite column. SQLite has no `ADD COLUMN IF NOT EXISTS`,
/// so we run the ALTER and ignore the specific "duplicate column name" error.
/// Any other error (corrupted DB, locked file, disk full) is propagated.
/// Is the lease-owning worker process still alive? `kill(pid, 0)` probes
/// without signaling (EPERM would also mean "exists", but workers run as the
/// same user). Only meaningful on unix; elsewhere the heartbeat is the sole
/// liveness signal.
fn lease_owner_alive(pid: Option<i64>) -> bool {
    #[cfg(unix)]
    {
        match pid {
            Some(p) if p > 0 && p <= i32::MAX as i64 => {
                // SAFETY: kill(pid, 0) performs no action — existence probe only.
                unsafe { libc::kill(p as i32, 0) == 0 }
            }
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

fn add_column_if_missing(conn: &rusqlite::Connection, alter_sql: &str) -> rusqlite::Result<()> {
    match conn.execute(alter_sql, []) {
        Ok(_) => Ok(()),
        Err(e) if e.to_string().contains("duplicate column name") => Ok(()),
        Err(e) => Err(e),
    }
}

/// Trim an optional text field, treating a blank string as absent — so an empty
/// input is stored as NULL rather than an empty string that would read as "set".
fn normalize_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Parse a stage's `parents` JSON column (a list of upstream positions) into a
/// vec. A NULL or malformed value reads as "no recorded parents" — the caller
/// then treats the stage as part of a legacy linear chain.
fn parse_parents(raw: Option<String>) -> Vec<i64> {
    raw.and_then(|t| serde_json::from_str::<Vec<i64>>(&t).ok())
        .unwrap_or_default()
}

/// Parse a stage's `tools` JSON column (an allowlist) into an optional vec.
/// NULL/malformed ⇒ `None`, meaning "use the archetype's default tool set".
fn parse_tools(raw: Option<String>) -> Option<Vec<String>> {
    raw.and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
}

/// Serialize an optional tool allowlist back to JSON text for storage.
fn tools_to_json(tools: &Option<Vec<String>>) -> Option<String> {
    tools.as_ref().and_then(|t| serde_json::to_string(t).ok())
}

pub struct Db {
    conn: Connection,
}

impl Db {
    pub fn open(path: &Path) -> AppResult<Self> {
        let db = Self::open_raw(path)?;
        db.migrate()?;
        Ok(db)
    }

    /// Open WITHOUT running migrations — for the detached run worker, which is
    /// only ever spawned by an app of the same binary version that migrated at
    /// its own startup. Skipping `migrate()` keeps the one legacy table-rebuild
    /// migration from ever racing across processes on a cold install.
    pub fn open_without_migrations(path: &Path) -> AppResult<Self> {
        Self::open_raw(path)
    }

    fn open_raw(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        // With WAL, synchronous=NORMAL stays crash-safe (no corruption — only a
        // power/OS crash can drop the last commit) while committing with far fewer
        // fsyncs. That shortens how long each write holds the single DB mutex —
        // which matters under N concurrent Direct runs (Pro parallel runs). The
        // busy_timeout lets a contended lock wait briefly instead of erroring.
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(Db { conn })
    }

    /// Returns a reference to the underlying connection. Tests only — the
    /// `#[cfg(test)]` gate enforces the intent at compile time.
    #[cfg(test)]
    pub fn conn_ref(&self) -> &Connection {
        &self.conn
    }

    /// The worktree path for a workspace (None if not yet created).
    pub fn conn_ref_path(&self, workspace_id: &str) -> AppResult<Option<String>> {
        self.conn
            .query_row(
                "SELECT worktree_path FROM workspaces WHERE id = ?1",
                params![workspace_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()
            .map(|opt| opt.flatten())
            .map_err(Into::into)
    }

    pub fn default_path() -> PathBuf {
        let base = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("octopush");
        base.join("octopush.db")
    }

    fn migrate(&self) -> AppResult<()> {
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS sessions (
                id              TEXT PRIMARY KEY,
                name            TEXT NOT NULL,
                color           TEXT NOT NULL,
                icon            TEXT NOT NULL,
                project_root    TEXT NOT NULL,
                agent_config    TEXT NOT NULL,
                token_budget    INTEGER,
                tokens_used     INTEGER NOT NULL DEFAULT 0,
                tokens_input    INTEGER NOT NULL DEFAULT 0,
                tokens_output   INTEGER NOT NULL DEFAULT 0,
                status          TEXT NOT NULL,
                context_files   TEXT NOT NULL DEFAULT '[]',
                tags            TEXT NOT NULL DEFAULT '[]',
                created_at      TEXT NOT NULL,
                last_active     TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_last_active
                ON sessions(last_active DESC);

            CREATE TABLE IF NOT EXISTS token_events (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id      TEXT NOT NULL,
                timestamp       TEXT NOT NULL,
                input_tokens    INTEGER NOT NULL,
                output_tokens   INTEGER NOT NULL,
                cache_read      INTEGER NOT NULL DEFAULT 0,
                cache_create    INTEGER NOT NULL DEFAULT 0,
                model           TEXT NOT NULL,
                cost_usd        REAL NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_token_events_session
                ON token_events(session_id, timestamp DESC);

            CREATE TABLE IF NOT EXISTS projects (
                id              TEXT PRIMARY KEY,
                name            TEXT NOT NULL,
                path            TEXT NOT NULL UNIQUE,
                created_at      TEXT NOT NULL,
                last_opened     TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_projects_last_opened ON projects(last_opened DESC);

            CREATE TABLE IF NOT EXISTS workspaces (
                id              TEXT PRIMARY KEY,
                project_id      TEXT NOT NULL,
                name            TEXT NOT NULL,
                task            TEXT NOT NULL DEFAULT '',
                branch          TEXT NOT NULL,
                worktree_path   TEXT,
                setup_script    TEXT NOT NULL DEFAULT '',
                status          TEXT NOT NULL DEFAULT 'active',
                created_at      TEXT NOT NULL,
                last_active     TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_workspaces_project ON workspaces(project_id, last_active DESC);

            CREATE TABLE IF NOT EXISTS chat_messages (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                workspace_id    TEXT NOT NULL,
                role            TEXT NOT NULL,
                content         TEXT NOT NULL,
                model           TEXT,
                input_tokens    INTEGER,
                output_tokens   INTEGER,
                cost_usd        REAL,
                created_at      TEXT NOT NULL,
                FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_chat_messages_workspace ON chat_messages(workspace_id, created_at);

            CREATE TABLE IF NOT EXISTS terminals (
                id              TEXT PRIMARY KEY,
                workspace_id    TEXT NOT NULL,
                label           TEXT NOT NULL,
                position        INTEGER NOT NULL,
                created_at      INTEGER NOT NULL,
                FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_terminals_workspace ON terminals(workspace_id);

            CREATE TABLE IF NOT EXISTS budgets (
                scope_type    TEXT NOT NULL,
                scope_id      TEXT NOT NULL,
                period        TEXT NOT NULL,
                limit_usd     REAL NOT NULL,
                updated_at    TEXT NOT NULL,
                PRIMARY KEY (scope_type, scope_id, period)
            );

            CREATE TABLE IF NOT EXISTS file_edits (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                workspace_id    TEXT NOT NULL,
                file_path       TEXT NOT NULL,
                tool_name       TEXT NOT NULL,
                message_id      INTEGER,
                created_at      TEXT NOT NULL,
                FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_file_edits_workspace_path
                ON file_edits(workspace_id, file_path);

            CREATE TABLE IF NOT EXISTS pipelines (
                id           TEXT PRIMARY KEY,
                name         TEXT NOT NULL,
                description  TEXT NOT NULL DEFAULT '',
                is_builtin   INTEGER NOT NULL DEFAULT 0,
                created_at   TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS pipeline_stages (
                id            TEXT PRIMARY KEY,
                pipeline_id   TEXT NOT NULL,
                position      INTEGER NOT NULL,
                role          TEXT NOT NULL,
                agent_model   TEXT NOT NULL,
                effort        TEXT,
                escalate_model  TEXT,
                escalate_effort TEXT,
                substrate     TEXT NOT NULL,
                checkpoint    INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY(pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_pipeline_stages_pipeline
                ON pipeline_stages(pipeline_id, position);

            CREATE TABLE IF NOT EXISTS runs (
                id               TEXT PRIMARY KEY,
                workspace_id     TEXT NOT NULL,
                pipeline_id      TEXT NOT NULL,
                task             TEXT NOT NULL DEFAULT '',
                status           TEXT NOT NULL,
                cost_usd         REAL NOT NULL DEFAULT 0,
                baseline_usd     REAL NOT NULL DEFAULT 0,
                reference_model  TEXT,
                linked_issue_key TEXT,
                created_at       TEXT NOT NULL,
                finished_at      TEXT,
                FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_runs_workspace
                ON runs(workspace_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS run_stages (
                id            TEXT PRIMARY KEY,
                run_id        TEXT NOT NULL,
                position      INTEGER NOT NULL,
                role          TEXT NOT NULL,
                agent_model   TEXT NOT NULL,
                effort        TEXT,
                escalate_model  TEXT,
                escalate_effort TEXT,
                escalated     INTEGER NOT NULL DEFAULT 0,
                substrate     TEXT NOT NULL,
                checkpoint    INTEGER NOT NULL DEFAULT 0,
                status        TEXT NOT NULL DEFAULT 'pending',
                input_tokens  INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cost_usd      REAL NOT NULL DEFAULT 0,
                artifact      TEXT,
                feedback      TEXT,
                error         TEXT,
                started_at    TEXT,
                finished_at   TEXT,
                blocked_questions TEXT,
                FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_run_stages_run
                ON run_stages(run_id, position);

            CREATE TABLE IF NOT EXISTS run_events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id      TEXT NOT NULL,
                timestamp   TEXT NOT NULL,
                kind        TEXT NOT NULL,
                payload     TEXT NOT NULL DEFAULT '{}',
                FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_run_events_run
                ON run_events(run_id, id);

            CREATE TABLE IF NOT EXISTS shell_history (
                workspace_id  TEXT NOT NULL,
                command       TEXT NOT NULL,
                used_at       TEXT NOT NULL,
                uses          INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (workspace_id, command),
                FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_shell_history_ws
                ON shell_history(workspace_id, used_at DESC);
            "#,
        )?;
        // Phase 2 — workspace customization columns (glyph + tint).
        // SQLite doesn't support ADD COLUMN IF NOT EXISTS, so we swallow the
        // duplicate-column error if the migration has already run.
        add_column_if_missing(&self.conn, "ALTER TABLE workspaces ADD COLUMN glyph TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE workspaces ADD COLUMN tint TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE workspaces ADD COLUMN test_command TEXT")?;

        // ── v2 contextual issue tracker ────────────────────────────
        add_column_if_missing(
            &self.conn,
            "ALTER TABLE projects ADD COLUMN jira_project_key TEXT",
        )?;
        // ── v3 soft-close: a non-null timestamp means the project is hidden
        // from the rail but its row, workspaces, terminals and chats survive,
        // so it can be reopened later (Plan 2 / bug B1).
        add_column_if_missing(
            &self.conn,
            "ALTER TABLE projects ADD COLUMN closed_at TEXT",
        )?;
        // ── v4 organize: manual rail ordering. `pinned` floats a project to
        // the top; `sort_order` is the manual position within its group.
        add_column_if_missing(
            &self.conn,
            "ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &self.conn,
            "ALTER TABLE projects ADD COLUMN sort_order INTEGER",
        )?;
        // Project tint (parity with workspaces.tint). Without this,
        // update_project(..., Some(tint)) errors with "no such column".
        add_column_if_missing(
            &self.conn,
            "ALTER TABLE projects ADD COLUMN tint TEXT",
        )?;
        add_column_if_missing(
            &self.conn,
            "ALTER TABLE workspaces ADD COLUMN linked_issue_key TEXT",
        )?;
        add_column_if_missing(
            &self.conn,
            // Retained for non-destructive cleanup (Plan 13/T4): column is no longer
            // read or written, but we keep it in place rather than dropping it.
            "ALTER TABLE workspaces ADD COLUMN issue_link_dismissed INTEGER NOT NULL DEFAULT 0",
        )?;
        // `managed` = Octopush created this worktree (default true, matching every
        // existing row). Adopted checkouts (a branch already checked out that we
        // register a workspace over) set it false so delete/archive never
        // `rm -rf` a directory Octopush didn't create.
        add_column_if_missing(
            &self.conn,
            "ALTER TABLE workspaces ADD COLUMN managed INTEGER NOT NULL DEFAULT 1",
        )?;
        // `created_branch` = Octopush created this workspace's git branch (vs
        // reusing/adopting one that already existed). Default true preserves the
        // historical behaviour (delete removes the branch); reused/adopted rows
        // set it false so delete never deletes a branch Octopush didn't create.
        add_column_if_missing(
            &self.conn,
            "ALTER TABLE workspaces ADD COLUMN created_branch INTEGER NOT NULL DEFAULT 1",
        )?;

        // Phase 9 — drop the FK from token_events.session_id. The original
        // schema only ever expected CLI session ids, so chat-driven token
        // events (keyed by workspace_id) were silently rejected by the FK
        // constraint and the CONTEXT/Usage dashboards stayed at zero.
        // SQLite has no ALTER TABLE DROP CONSTRAINT — recreate the table.
        let has_fk: bool = self.conn.query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_list('token_events')",
            [],
            |r| r.get::<_, i64>(0).map(|n| n > 0),
        ).unwrap_or(false);
        if has_fk {
            self.conn.execute_batch(
                r#"
                BEGIN;
                CREATE TABLE token_events_new (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id      TEXT NOT NULL,
                    timestamp       TEXT NOT NULL,
                    input_tokens    INTEGER NOT NULL,
                    output_tokens   INTEGER NOT NULL,
                    cache_read      INTEGER NOT NULL DEFAULT 0,
                    cache_create    INTEGER NOT NULL DEFAULT 0,
                    model           TEXT NOT NULL,
                    cost_usd        REAL NOT NULL DEFAULT 0
                );
                INSERT INTO token_events_new
                    (id, session_id, timestamp, input_tokens, output_tokens,
                     cache_read, cache_create, model, cost_usd)
                    SELECT id, session_id, timestamp, input_tokens, output_tokens,
                           cache_read, cache_create, model, cost_usd
                    FROM token_events;
                DROP TABLE token_events;
                ALTER TABLE token_events_new RENAME TO token_events;
                CREATE INDEX IF NOT EXISTS idx_token_events_session
                    ON token_events(session_id, timestamp DESC);
                COMMIT;
                "#,
            )?;
        }

        // ── v5 Direct review feedback loop (Plan L1) ───────────────
        add_column_if_missing(&self.conn, "ALTER TABLE pipeline_stages ADD COLUMN loop_target_position INTEGER")?;
        add_column_if_missing(&self.conn, "ALTER TABLE pipeline_stages ADD COLUMN loop_max_iterations INTEGER NOT NULL DEFAULT 0")?;
        add_column_if_missing(&self.conn, "ALTER TABLE pipeline_stages ADD COLUMN loop_mode TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN loop_target_position INTEGER")?;
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN loop_max_iterations INTEGER NOT NULL DEFAULT 0")?;
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN loop_mode TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN loop_iterations INTEGER NOT NULL DEFAULT 0")?;
        add_column_if_missing(&self.conn, "ALTER TABLE runs ADD COLUMN retired_cost_usd REAL NOT NULL DEFAULT 0")?;
        add_column_if_missing(&self.conn, "ALTER TABLE runs ADD COLUMN retired_input_tokens INTEGER NOT NULL DEFAULT 0")?;
        add_column_if_missing(&self.conn, "ALTER TABLE runs ADD COLUMN retired_output_tokens INTEGER NOT NULL DEFAULT 0")?;
        // Optional per-run spend cap; NULL = no budget.
        add_column_if_missing(&self.conn, "ALTER TABLE runs ADD COLUMN budget_usd REAL")?;

        // ── Detached runs (segment workers) — the worker lease + control flags ──
        // A run being driven by an out-of-process `octopush-run-worker` carries a
        // lease: nonce (claim identity), pid (diagnostics), heartbeat (liveness —
        // the ONLY signal recovery trusts; PIDs get reused). The two request
        // flags are the cross-process replacements for the orchestrator's
        // in-memory cancel/pause state; `detached` marks the run for the UI.
        add_column_if_missing(&self.conn, "ALTER TABLE runs ADD COLUMN worker_pid INTEGER")?;
        add_column_if_missing(&self.conn, "ALTER TABLE runs ADD COLUMN worker_nonce TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE runs ADD COLUMN heartbeat_at TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE runs ADD COLUMN stop_requested INTEGER NOT NULL DEFAULT 0")?;
        add_column_if_missing(&self.conn, "ALTER TABLE runs ADD COLUMN pause_requested INTEGER NOT NULL DEFAULT 0")?;
        add_column_if_missing(&self.conn, "ALTER TABLE runs ADD COLUMN detached INTEGER NOT NULL DEFAULT 0")?;

        // ── v6 Direct iteration history: persisted live journals ──
        // One row per `run://log` entry (including `{"kind":"reset"}` markers),
        // so stage journals survive app reloads and loop-backs.
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS stage_log (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id    TEXT NOT NULL,
                stage_id  TEXT NOT NULL,
                entry     TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_stage_log_stage ON stage_log(stage_id, id);

            CREATE TABLE IF NOT EXISTS stage_iterations (
                id               TEXT PRIMARY KEY,
                run_id           TEXT NOT NULL,
                stage_id         TEXT NOT NULL,
                iteration        INTEGER NOT NULL,
                role             TEXT NOT NULL,
                agent_model      TEXT NOT NULL,
                status           TEXT NOT NULL,
                artifact         TEXT,
                error            TEXT,
                cost_usd         REAL NOT NULL DEFAULT 0,
                input_tokens     INTEGER NOT NULL DEFAULT 0,
                output_tokens    INTEGER NOT NULL DEFAULT 0,
                closing_feedback TEXT,
                created_at       TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_stage_iterations_stage
                ON stage_iterations(stage_id, iteration);
            "#,
        )?;

        // ── v7 per-stage diff snapshots ────────────────────────────
        // The worktree diff text captured the moment a stage finished, so the
        // focus pane can show what THAT stage saw instead of the live worktree.
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN diff_snapshot TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE stage_iterations ADD COLUMN diff_snapshot TEXT")?;

        // ── v8 base-branch provenance ──────────────────────────────
        // The RESOLVED base branch a workspace was created from (NULL for
        // rows that predate the column or for the auto-created main row).
        add_column_if_missing(&self.conn, "ALTER TABLE workspaces ADD COLUMN from_branch TEXT")?;

        // ── v9 per-stage tool-turn budget (Direct halt recovery F4) ─
        // How many agentic tool turns a stage may burn before it halts.
        // DEFAULT 25 backfills every pre-existing row (the former hard cap).
        add_column_if_missing(&self.conn, "ALTER TABLE pipeline_stages ADD COLUMN max_iterations INTEGER NOT NULL DEFAULT 25")?;
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN max_iterations INTEGER NOT NULL DEFAULT 25")?;

        // ── v10 node-based builder: canvas layout + per-stage agent config ─
        // pos_x/pos_y carry the canvas coordinates (builder-only; execution
        // ignores them). `parents` is a JSON array of upstream stage positions
        // (the flow-edge dependencies); empty/NULL ⇒ legacy linear chain.
        // `tools` is a JSON array allowlist over the workspace tools (NULL ⇒
        // archetype default). `custom_name` is a free display label, and
        // `instructions` are free-form additions to the archetype prompt.
        // All nullable: pre-existing rows keep behaving exactly as before.
        add_column_if_missing(&self.conn, "ALTER TABLE pipeline_stages ADD COLUMN pos_x REAL")?;
        add_column_if_missing(&self.conn, "ALTER TABLE pipeline_stages ADD COLUMN pos_y REAL")?;
        add_column_if_missing(&self.conn, "ALTER TABLE pipeline_stages ADD COLUMN parents TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE pipeline_stages ADD COLUMN tools TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE pipeline_stages ADD COLUMN custom_name TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE pipeline_stages ADD COLUMN instructions TEXT")?;
        // run_stages mirrors only the execution-relevant fields (the run view
        // stays linear, so it needs no canvas coordinates).
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN parents TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN tools TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN custom_name TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN instructions TEXT")?;

        // ── v12 Direct halt recovery: session resume + per-stage baseline ──
        // session_id: the Claude Code CLI session id from the stage's last
        //   attempt — enables `--resume` and is shown in the halt diagnostics.
        // resume_pending: 1 ⇒ the next run of this stage should `--resume`
        //   session_id (set by a Resume action, cleared when the run starts).
        // baseline_commit: dangling commit SHA snapshotting the worktree at the
        //   stage's start, so Discard reverts only this stage's changes.
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN session_id TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN resume_pending INTEGER NOT NULL DEFAULT 0")?;
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN baseline_commit TEXT")?;

        // ── v13 roles as data ──────────────────────────────────────
        self.conn.execute_batch(
            r#"CREATE TABLE IF NOT EXISTS roles (
                key TEXT PRIMARY KEY, label TEXT NOT NULL, description TEXT NOT NULL,
                prompt_body TEXT NOT NULL, artifact_kind TEXT NOT NULL, environment TEXT NOT NULL,
                can_loop INTEGER NOT NULL DEFAULT 0, default_tools TEXT NOT NULL,
                default_substrate TEXT NOT NULL, default_checkpoint INTEGER NOT NULL DEFAULT 0,
                token_est_in INTEGER NOT NULL, token_est_out INTEGER NOT NULL,
                is_builtin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
            );"#,
        )?;
        self.seed_builtin_roles()?;

        // ── v11 chat threads: multiple conversations per workspace ──
        // A `chat_threads` table + a nullable `thread_id` on chat_messages.
        // Then a one-time backfill: every workspace that still has un-threaded
        // messages gets one default thread, and its messages are assigned to it.
        // The backfill is guarded by a COUNT so it's a no-op on every run after
        // the first — consistent with the idempotent, user_version-free style
        // used throughout this migrate().
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS chat_threads (
                id           TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                title        TEXT NOT NULL DEFAULT 'New conversation',
                created_at   TEXT NOT NULL,
                updated_at   TEXT NOT NULL,
                FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_chat_threads_ws ON chat_threads(workspace_id, updated_at DESC);
            "#,
        )?;
        add_column_if_missing(&self.conn, "ALTER TABLE chat_messages ADD COLUMN thread_id TEXT")?;
        // Pinned conversations sort to the top of the chat list. (Must run AFTER
        // chat_threads is created above.)
        add_column_if_missing(
            &self.conn,
            "ALTER TABLE chat_threads ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
        )?;
        self.conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, created_at);",
        )?;

        // Cross-machine run-history sync (Pro-real Part B / B1):
        //   • app_meta   — a tiny key/value store for app-global scalars (e.g. the
        //                  stable per-install `machine_id`); no such table existed.
        //   • synced_runs — a READ-ONLY local mirror of the user's run history
        //                  pulled from the cloud. Kept SEPARATE from `runs` on
        //                  purpose: pulled runs come from other machines and have
        //                  no local workspace (the `runs` table FKs to workspaces).
        //                  `data` is the JSON blob (SyncRun) rendered by the view.
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS app_meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS synced_runs (
                run_id     TEXT PRIMARY KEY,
                data       TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_synced_runs_created ON synced_runs(created_at DESC);

            -- Routines (Pro): a saved pipeline that fires on a schedule. The
            -- last_fired_at / next_due_at / last_run_id triple is the durable
            -- window guard — written before a fire's side effects so a crash
            -- or double tick can't double-fire.
            CREATE TABLE IF NOT EXISTS routines (
                id                 TEXT PRIMARY KEY,
                name               TEXT NOT NULL,
                project_id         TEXT NOT NULL,
                pipeline_id        TEXT NOT NULL,
                task               TEXT NOT NULL DEFAULT '',
                reference_model    TEXT,
                stage_overrides    TEXT,
                budget_usd         REAL,
                schedule_kind      TEXT NOT NULL,
                schedule_spec      TEXT NOT NULL,
                workspace_mode     TEXT NOT NULL DEFAULT 'fixed',
                fixed_workspace_id TEXT,
                base_branch        TEXT,
                branch_prefix      TEXT,
                enabled            INTEGER NOT NULL DEFAULT 1,
                last_fired_at      TEXT,
                next_due_at        TEXT,
                last_run_id        TEXT,
                fire_condition     TEXT,
                last_checked_at    TEXT,
                last_outcome       TEXT,
                created_at         TEXT NOT NULL,
                FOREIGN KEY(project_id)  REFERENCES projects(id)  ON DELETE CASCADE,
                FOREIGN KEY(pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_routines_due ON routines(enabled, next_due_at);
            "#,
        )?;

        // Crew-quality retrofit (ONE-SHOT, gated via app_meta — so it must run
        // after the CREATE above): code_review/security_review gained
        // `run_command` in their default tool preset, but the builder SNAPSHOTS
        // a role's tools into each pipeline_stages row at authoring time (and
        // create_run copies that into run_stages) — so existing pipelines would
        // run the NEW prompt ("run the build or tests…") against the OLD
        // read-only allowlist, unable to comply. Upgrade exactly the rows still
        // carrying the old default snapshot, ONCE: re-running on every launch
        // would silently re-escalate a reviewer a user had deliberately set
        // back to read-only (the old snapshot is byte-identical to that choice).
        if self.meta_get("retrofit_reviewer_run_command")?.is_none() {
            const OLD_RO: &str = r#"["read_file","list_files"]"#;
            const NEW_RUN: &str = r#"["read_file","list_files","run_command"]"#;
            self.conn.execute(
                "UPDATE pipeline_stages SET tools = ?1
                 WHERE role IN ('code_review','security_review') AND tools = ?2",
                params![NEW_RUN, OLD_RO],
            )?;
            // Also stages of runs that haven't executed yet (drafts) — started
            // and terminal runs keep their historical allowlist.
            self.conn.execute(
                "UPDATE run_stages SET tools = ?1
                 WHERE role IN ('code_review','security_review') AND tools = ?2
                   AND status = 'pending'",
                params![NEW_RUN, OLD_RO],
            )?;
            self.meta_set("retrofit_reviewer_run_command", "done")?;
        }

        // Library sync (Pro): per-item LWW needs an edit timestamp on the
        // template tables. Backfill = created_at (a never-edited item is as
        // old as its creation).
        add_column_if_missing(&self.conn, "ALTER TABLE pipelines ADD COLUMN updated_at TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE roles ADD COLUMN updated_at TEXT")?;

        // ── Per-stage reasoning effort (DIRECT operating-model, slice 1) ────
        // The "how hard the model thinks" knob, stored as the Effort enum's
        // lowercase token. Nullable: NULL ⇒ "off" (no thinking params), which
        // is exactly today's behavior for every pre-existing row.
        add_column_if_missing(&self.conn, "ALTER TABLE pipeline_stages ADD COLUMN effort TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN effort TEXT")?;
        // ── Automatic model escalation (DIRECT operating-model, slice 3) ────
        // A stage's escalation POLICY (opt-in, either field ⇒ policy present):
        // on a FAILED attempt, retry once with `escalate_model` and/or bump to
        // `escalate_effort` before halting. `escalated` is sticky run-state on
        // run_stages: set true the first time the stage escalates. NULL/0 for
        // every pre-existing row ⇒ zero behavior change without a policy.
        add_column_if_missing(&self.conn, "ALTER TABLE pipeline_stages ADD COLUMN escalate_model TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE pipeline_stages ADD COLUMN escalate_effort TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN escalate_model TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN escalate_effort TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN escalated INTEGER NOT NULL DEFAULT 0")?;
        // The escape valve: a parked stage's `ask_director` questions (JSON
        // `BlockedAsk`), NULL unless the stage is blocked awaiting the director.
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN blocked_questions TEXT")?;
        self.conn.execute_batch(
            "UPDATE pipelines SET updated_at = created_at WHERE updated_at IS NULL;
             UPDATE roles SET updated_at = created_at WHERE updated_at IS NULL;",
        )?;

        // ── Routine pre-fire condition (Routines, `fire_condition` gate) ────
        // An optional shell command evaluated before each fire (exit 0 ⇒ fire,
        // non-zero ⇒ skip the window with no run/tokens). `last_checked_at` /
        // `last_outcome` are written on EVERY evaluation so a routine that keeps
        // skipping stays legible instead of looking dead. All three NULL for
        // pre-existing rows ⇒ unchanged behavior (always fire).
        add_column_if_missing(&self.conn, "ALTER TABLE routines ADD COLUMN fire_condition TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE routines ADD COLUMN last_checked_at TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE routines ADD COLUMN last_outcome TEXT")?;

        // ── Missions (the first-level unit of intent) ──────────────────────
        // A mission is a thread of intent (build/fix/review/probe/design/perf/
        // ops) with agents, terminals and artifacts inside. The worktree stops
        // being the unit and becomes a *property* a mission chooses along two
        // axes: git-state (worktree/readonly/ephemeral/pr) and execution
        // (none/sandbox/container/cloud). `workspace_id` is NULLABLE so
        // design/probe missions can live without a worktree. The partial UNIQUE
        // index enforces the core invariant: never two *active* missions writing
        // the same checkout (readonly missions may share freely). See
        // docs/superpowers/plans/2026-07-17-missions-reframe-master-plan.md.
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS missions (
                id               TEXT PRIMARY KEY,
                workspace_id     TEXT,
                project_id       TEXT NOT NULL,
                intent           TEXT NOT NULL,
                title            TEXT NOT NULL,
                status           TEXT NOT NULL DEFAULT 'active',
                linked_issue_key TEXT,
                git_isolation    TEXT NOT NULL DEFAULT 'worktree',
                exec_isolation   TEXT NOT NULL DEFAULT 'none',
                payload          TEXT NOT NULL DEFAULT '{}',
                created_at       TEXT NOT NULL,
                updated_at       TEXT NOT NULL,
                archived_at      TEXT,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_missions_project ON missions(project_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_missions_workspace ON missions(workspace_id);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_missions_writer
                ON missions(workspace_id)
                WHERE status = 'active' AND workspace_id IS NOT NULL
                  AND git_isolation IN ('worktree','pr','ephemeral');
            "#,
        )?;
        // Nullable back-references: which mission a run / conversation / terminal
        // belongs to. Adding a column at the END is safe — no read SELECTs *, all
        // list their columns explicitly, so existing positional maps are unmoved.
        add_column_if_missing(&self.conn, "ALTER TABLE runs ADD COLUMN mission_id TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE chat_threads ADD COLUMN mission_id TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE terminals ADD COLUMN mission_id TEXT")?;
        // One-shot re-parenting: every existing workspace becomes a 'build'
        // mission owning its worktree; its runs/threads/terminals inherit the id.
        // Gated by app_meta so it runs exactly once; the WHERE NOT EXISTS keeps a
        // torn/retried migration idempotent even before the flag is set.
        if self.meta_get("missions_backfill_v1")?.is_none() {
            self.conn.execute_batch(
                r#"
                INSERT INTO missions (id, workspace_id, project_id, intent, title, status,
                                      linked_issue_key, git_isolation, exec_isolation, payload,
                                      created_at, updated_at, archived_at)
                SELECT lower(hex(randomblob(16))), w.id, w.project_id, 'build',
                       CASE WHEN w.task <> '' THEN w.task ELSE w.name END,
                       CASE WHEN w.status = 'archived' THEN 'archived' ELSE 'active' END,
                       w.linked_issue_key, 'worktree', 'none', '{}',
                       w.created_at, w.last_active,
                       CASE WHEN w.status = 'archived' THEN w.last_active ELSE NULL END
                FROM workspaces w
                WHERE NOT EXISTS (SELECT 1 FROM missions m WHERE m.workspace_id = w.id)
                  -- Skip any workspace whose project row is missing: with
                  -- foreign_keys=ON the FK insert would otherwise abort the whole
                  -- backfill and wedge startup on every launch (flag never set).
                  AND EXISTS (SELECT 1 FROM projects p WHERE p.id = w.project_id);
                UPDATE runs SET mission_id =
                  (SELECT m.id FROM missions m WHERE m.workspace_id = runs.workspace_id)
                  WHERE mission_id IS NULL;
                UPDATE chat_threads SET mission_id =
                  (SELECT m.id FROM missions m WHERE m.workspace_id = chat_threads.workspace_id)
                  WHERE mission_id IS NULL;
                UPDATE terminals SET mission_id =
                  (SELECT m.id FROM missions m WHERE m.workspace_id = terminals.workspace_id)
                  WHERE mission_id IS NULL;
                "#,
            )?;
            self.meta_set("missions_backfill_v1", "done")?;
        }

        self.backfill_default_threads()?;

        Ok(())
    }

    /// One-time backfill assigning a default thread to every workspace that has
    /// pre-thread chat messages. No-op once every message is threaded.
    fn backfill_default_threads(&self) -> AppResult<()> {
        let pending: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM chat_messages WHERE thread_id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if pending == 0 {
            return Ok(());
        }
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
        // Only workspaces that still EXIST get a backfilled thread — inserting a
        // chat_threads row for an orphan workspace_id would violate the FK and
        // wedge the app in a crash-on-start loop. Truly orphaned messages stay
        // un-threaded (they were already unreachable).
        let workspaces: Vec<String> = {
            let mut stmt = self.conn.prepare(
                "SELECT DISTINCT workspace_id FROM chat_messages
                 WHERE thread_id IS NULL
                   AND workspace_id IN (SELECT id FROM workspaces)",
            )?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for ws in workspaces {
            let tid = uuid::Uuid::new_v4().to_string();
            self.conn.execute(
                "INSERT INTO chat_threads (id, workspace_id, title, created_at, updated_at)
                 VALUES (?1, ?2, 'Conversation', ?3, ?3)",
                rusqlite::params![tid, ws, now],
            )?;
            self.conn.execute(
                "UPDATE chat_messages SET thread_id = ?1 WHERE workspace_id = ?2 AND thread_id IS NULL",
                rusqlite::params![tid, ws],
            )?;
        }
        Ok(())
    }

    fn seed_builtin_roles(&self) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        for r in crate::orchestrator::roles::builtin_roles() {
            // Upsert built-ins (so prompt/desc updates ship); never clobber a
            // user's custom row (different key) — built-ins own their keys.
            self.conn.execute(
                "INSERT INTO roles (key,label,description,prompt_body,artifact_kind,environment,can_loop,default_tools,default_substrate,default_checkpoint,token_est_in,token_est_out,is_builtin,created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,1,?13)
                 ON CONFLICT(key) DO UPDATE SET label=?2,description=?3,prompt_body=?4,artifact_kind=?5,environment=?6,can_loop=?7,default_tools=?8,default_substrate=?9,default_checkpoint=?10,token_est_in=?11,token_est_out=?12,is_builtin=1
                 WHERE roles.is_builtin=1",
                params![r.key, r.label, r.description, r.prompt_body, r.artifact_kind.as_db(), r.environment.as_db(), r.can_loop as i64, serde_json::to_string(&r.default_tools)?, r.default_substrate, r.default_checkpoint as i64, r.token_est_in, r.token_est_out, now],
            )?;
        }
        Ok(())
    }

    fn row_to_role(r: &rusqlite::Row) -> rusqlite::Result<crate::orchestrator::roles::RoleDef> {
        use crate::orchestrator::types::{ArtifactKind, RoleEnvironment};
        let tools_json: String = r.get(7)?;
        Ok(crate::orchestrator::roles::RoleDef {
            key: r.get(0)?, label: r.get(1)?, description: r.get(2)?, prompt_body: r.get(3)?,
            artifact_kind: ArtifactKind::from_db(&r.get::<_, String>(4)?).unwrap_or(ArtifactKind::Note),
            environment: RoleEnvironment::from_db(&r.get::<_, String>(5)?).unwrap_or(RoleEnvironment::Worktree),
            can_loop: r.get::<_, i64>(6)? != 0,
            default_tools: serde_json::from_str(&tools_json).unwrap_or_default(),
            default_substrate: r.get(8)?, default_checkpoint: r.get::<_, i64>(9)? != 0,
            token_est_in: r.get(10)?, token_est_out: r.get(11)?, is_builtin: r.get::<_, i64>(12)? != 0,
        })
    }

    const ROLE_COLS: &str = "key,label,description,prompt_body,artifact_kind,environment,can_loop,default_tools,default_substrate,default_checkpoint,token_est_in,token_est_out,is_builtin";

    pub fn list_roles(&self) -> AppResult<Vec<crate::orchestrator::roles::RoleDef>> {
        let mut stmt = self.conn.prepare(&format!("SELECT {} FROM roles ORDER BY is_builtin DESC, label", Self::ROLE_COLS))?;
        let rows = stmt.query_map([], Self::row_to_role)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn get_role(&self, key: &str) -> AppResult<Option<crate::orchestrator::roles::RoleDef>> {
        let mut stmt = self.conn.prepare(&format!("SELECT {} FROM roles WHERE key=?1", Self::ROLE_COLS))?;
        let mut rows = stmt.query_map(params![key], Self::row_to_role)?;
        Ok(match rows.next() { Some(r) => Some(r?), None => None })
    }

    pub fn upsert_role(&self, role: &crate::orchestrator::roles::RoleDef) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO roles (key,label,description,prompt_body,artifact_kind,environment,can_loop,default_tools,default_substrate,default_checkpoint,token_est_in,token_est_out,is_builtin,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
             ON CONFLICT(key) DO UPDATE SET label=?2,description=?3,prompt_body=?4,artifact_kind=?5,environment=?6,can_loop=?7,default_tools=?8,default_substrate=?9,default_checkpoint=?10,token_est_in=?11,token_est_out=?12,updated_at=?15
             WHERE roles.is_builtin=0",
            params![role.key, role.label, role.description, role.prompt_body, role.artifact_kind.as_db(), role.environment.as_db(), role.can_loop as i64, serde_json::to_string(&role.default_tools)?, role.default_substrate, role.default_checkpoint as i64, role.token_est_in, role.token_est_out, role.is_builtin as i64, now, now],
        )?;
        // Defense-in-depth: if 0 rows were changed, check whether the key belongs
        // to a built-in.  The save_role command guard fires first for normal callers,
        // but direct callers of upsert_role must also get a hard error — not a
        // silent no-op that looks like success.
        if self.conn.changes() == 0 {
            let is_builtin: bool = self.conn.query_row(
                "SELECT is_builtin FROM roles WHERE key=?1",
                params![role.key],
                |r| r.get::<_, i64>(0),
            ).map(|v| v != 0).unwrap_or(false);
            if is_builtin {
                return Err(crate::error::AppError::Other(
                    format!("cannot overwrite built-in role '{}'", role.key),
                ));
            }
        }
        Ok(())
    }

    pub fn role_in_use(&self, key: &str) -> AppResult<bool> {
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM (
                SELECT id FROM pipeline_stages WHERE role=?1
                UNION ALL
                SELECT id FROM run_stages WHERE role=?1
             )",
            params![key],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    pub fn delete_role(&self, key: &str) -> AppResult<()> {
        self.conn.execute("DELETE FROM roles WHERE key=?1 AND is_builtin=0", params![key])?;
        Ok(())
    }

    pub fn upsert_session(&self, s: &Session) -> AppResult<()> {
        let agent_json = serde_json::to_string(&s.agent)?;
        let ctx_json = serde_json::to_string(&s.context_files)?;
        let tags_json = serde_json::to_string(&s.tags)?;
        self.conn.execute(
            r#"INSERT INTO sessions (
                id, name, color, icon, project_root, agent_config,
                token_budget, tokens_used, tokens_input, tokens_output,
                status, context_files, tags, created_at, last_active
            ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                color=excluded.color,
                icon=excluded.icon,
                project_root=excluded.project_root,
                agent_config=excluded.agent_config,
                token_budget=excluded.token_budget,
                tokens_used=excluded.tokens_used,
                tokens_input=excluded.tokens_input,
                tokens_output=excluded.tokens_output,
                status=excluded.status,
                context_files=excluded.context_files,
                tags=excluded.tags,
                last_active=excluded.last_active
            "#,
            params![
                s.id,
                s.name,
                s.color,
                s.icon,
                s.project_root,
                agent_json,
                s.token_budget,
                s.tokens_used as i64,
                s.tokens_input as i64,
                s.tokens_output as i64,
                s.status.as_str(),
                ctx_json,
                tags_json,
                s.created_at.to_rfc3339(),
                s.last_active.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn get_session(&self, id: &str) -> AppResult<Option<Session>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, color, icon, project_root, agent_config, token_budget,
                    tokens_used, tokens_input, tokens_output, status, context_files,
                    tags, created_at, last_active
             FROM sessions WHERE id = ?1",
        )?;
        let row = stmt
            .query_row(params![id], |row| Ok(row_to_session(row)))
            .optional()?;
        match row {
            Some(Ok(s)) => Ok(Some(s)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn list_sessions(&self) -> AppResult<Vec<Session>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, color, icon, project_root, agent_config, token_budget,
                    tokens_used, tokens_input, tokens_output, status, context_files,
                    tags, created_at, last_active
             FROM sessions ORDER BY last_active DESC",
        )?;
        let rows = stmt.query_map([], |row| Ok(row_to_session(row)))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r??);
        }
        Ok(out)
    }

    pub fn delete_session(&self, id: &str) -> AppResult<()> {
        self.conn
            .execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn update_status(&self, id: &str, status: SessionStatus) -> AppResult<()> {
        self.conn.execute(
            "UPDATE sessions SET status = ?1, last_active = ?2 WHERE id = ?3",
            params![status.as_str(), Utc::now().to_rfc3339(), id],
        )?;
        Ok(())
    }

    pub fn set_session_budget(&self, id: &str, budget: Option<u64>) -> AppResult<()> {
        self.conn.execute(
            "UPDATE sessions SET token_budget = ?1, last_active = ?2 WHERE id = ?3",
            params![budget.map(|b| b as i64), Utc::now().to_rfc3339(), id],
        )?;
        Ok(())
    }

    pub fn increment_session_tokens(
        &self,
        id: &str,
        input: u64,
        output: u64,
    ) -> AppResult<()> {
        self.conn.execute(
            "UPDATE sessions SET tokens_input = tokens_input + ?1,
                                 tokens_output = tokens_output + ?2,
                                 tokens_used = tokens_used + ?3,
                                 last_active = ?4
             WHERE id = ?5",
            params![
                input as i64,
                output as i64,
                (input + output) as i64,
                Utc::now().to_rfc3339(),
                id,
            ],
        )?;
        Ok(())
    }

    // ─── Token events ─────────────────────────────────────────────

    pub fn insert_token_event(&self, ev: &TokenEvent) -> AppResult<()> {
        self.conn.execute(
            "INSERT INTO token_events (session_id, timestamp, input_tokens, output_tokens,
                                       cache_read, cache_create, model, cost_usd)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                ev.session_id,
                ev.timestamp,
                ev.input_tokens as i64,
                ev.output_tokens as i64,
                ev.cache_read_tokens as i64,
                ev.cache_creation_tokens as i64,
                ev.model,
                ev.cost_usd,
            ],
        )?;
        Ok(())
    }

    pub fn list_token_events(&self, session_id: &str) -> AppResult<Vec<TokenEvent>> {
        let mut stmt = self.conn.prepare(
            "SELECT session_id, timestamp, input_tokens, output_tokens,
                    cache_read, cache_create, model, cost_usd
             FROM token_events WHERE session_id = ?1 ORDER BY timestamp",
        )?;
        let rows = stmt.query_map(params![session_id], |r| {
            Ok(TokenEvent {
                id: None,
                session_id: r.get(0)?,
                timestamp: r.get(1)?,
                input_tokens: r.get::<_, i64>(2)? as u64,
                output_tokens: r.get::<_, i64>(3)? as u64,
                cache_read_tokens: r.get::<_, i64>(4)? as u64,
                cache_creation_tokens: r.get::<_, i64>(5)? as u64,
                model: r.get(6)?,
                cost_usd: r.get(7)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn token_report(&self, session_id: Option<&str>) -> AppResult<TokenReport> {
        let (where_clause, filter_val) = match session_id {
            Some(id) => ("WHERE session_id = ?1", id.to_string()),
            None => ("", String::new()),
        };

        // Totals
        let (total_input, total_output, total_cached, total_cost): (i64, i64, i64, f64) = {
            let sql = format!(
                "SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                        COALESCE(SUM(cache_read),0), COALESCE(SUM(cost_usd),0)
                 FROM token_events {where_clause}"
            );
            let mut stmt = self.conn.prepare(&sql)?;
            if session_id.is_some() {
                stmt.query_row(params![filter_val], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })?
            } else {
                stmt.query_row([], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })?
            }
        };

        // Cost by session
        let cost_by_session = {
            let sql = format!(
                "SELECT s.name, COALESCE(SUM(e.cost_usd),0), COALESCE(SUM(e.input_tokens+e.output_tokens),0)
                 FROM token_events e JOIN sessions s ON s.id = e.session_id
                 {where_clause} GROUP BY e.session_id ORDER BY 2 DESC LIMIT 20"
            );
            let cost_entry_mapper = |r: &rusqlite::Row| -> rusqlite::Result<CostEntry> {
                Ok(CostEntry {
                    label: r.get(0)?,
                    cost_usd: r.get(1)?,
                    tokens: r.get::<_, i64>(2)? as u64,
                })
            };
            let mut stmt = self.conn.prepare(&sql)?;
            if session_id.is_some() {
                stmt.query_map(params![filter_val], cost_entry_mapper)?
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                stmt.query_map([], cost_entry_mapper)?
                    .collect::<Result<Vec<_>, _>>()?
            }
        };

        // Cost by model
        let cost_by_model = {
            let sql = format!(
                "SELECT model, COALESCE(SUM(cost_usd),0), COALESCE(SUM(input_tokens+output_tokens),0)
                 FROM token_events {where_clause} GROUP BY model ORDER BY 2 DESC LIMIT 20"
            );
            let cost_entry_mapper = |r: &rusqlite::Row| -> rusqlite::Result<CostEntry> {
                Ok(CostEntry {
                    label: r.get(0)?,
                    cost_usd: r.get(1)?,
                    tokens: r.get::<_, i64>(2)? as u64,
                })
            };
            let mut stmt = self.conn.prepare(&sql)?;
            if session_id.is_some() {
                stmt.query_map(params![filter_val], cost_entry_mapper)?
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                stmt.query_map([], cost_entry_mapper)?
                    .collect::<Result<Vec<_>, _>>()?
            }
        };

        // Hourly trend (last 24h)
        let hourly_trend = {
            let sql = format!(
                "SELECT strftime('%Y-%m-%dT%H:00:00Z', timestamp) AS hour,
                        SUM(input_tokens+output_tokens), SUM(cost_usd)
                 FROM token_events
                 WHERE timestamp >= datetime('now', '-24 hours')
                 {extra_and}
                 GROUP BY hour ORDER BY hour",
                extra_and = if session_id.is_some() {
                    "AND session_id = ?1"
                } else {
                    ""
                }
            );
            let trend_mapper = |r: &rusqlite::Row| -> rusqlite::Result<TrendPoint> {
                Ok(TrendPoint {
                    hour: r.get(0)?,
                    tokens: r.get::<_, i64>(1)? as u64,
                    cost_usd: r.get(2)?,
                })
            };
            let mut stmt = self.conn.prepare(&sql)?;
            if session_id.is_some() {
                stmt.query_map(params![filter_val], trend_mapper)?
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                stmt.query_map([], trend_mapper)?
                    .collect::<Result<Vec<_>, _>>()?
            }
        };

        // Budget remaining (only if single session)
        let budget_remaining = if let Some(sid) = session_id {
            self.get_session(sid)?
                .and_then(|s| {
                    s.token_budget
                        .map(|b| b.saturating_sub(s.tokens_input + s.tokens_output))
                })
        } else {
            None
        };

        // Projected daily cost: extrapolate from last hour of activity.
        let projected = {
            let sql = format!(
                "SELECT COALESCE(SUM(cost_usd),0)
                 FROM token_events
                 WHERE timestamp >= datetime('now', '-1 hour')
                 {extra_and}",
                extra_and = if session_id.is_some() {
                    "AND session_id = ?1"
                } else {
                    ""
                }
            );
            let mut stmt = self.conn.prepare(&sql)?;
            let last_hour: f64 = if session_id.is_some() {
                stmt.query_row(params![filter_val], |r| r.get(0))?
            } else {
                stmt.query_row([], |r| r.get(0))?
            };
            last_hour * 24.0
        };

        Ok(TokenReport {
            total_input: total_input as u64,
            total_output: total_output as u64,
            total_cached: total_cached as u64,
            total_cost_usd: total_cost,
            cost_by_session,
            cost_by_model,
            hourly_trend,
            budget_remaining,
            projected_daily_cost: projected,
        })
    }

    // ─── Projects ─────────────────────────────────────────────────

    pub fn insert_project(&self, id: &str, name: &str, path: &str) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO projects (id, name, path, created_at, last_opened) VALUES (?1,?2,?3,?4,?5)",
            params![id, name, path, now, now],
        )?;
        Ok(())
    }

    pub fn list_projects(
        &self,
    ) -> AppResult<Vec<(String, String, String, String, Option<String>, bool, Option<String>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path, last_opened, jira_project_key, pinned, tint FROM projects \
             WHERE closed_at IS NULL \
             ORDER BY pinned DESC, sort_order IS NULL, sort_order ASC, created_at ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get::<_, i64>(5)? != 0, r.get(6)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn get_project(&self, project_id: &str) -> AppResult<Option<crate::commands::ProjectInfo>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path, jira_project_key, pinned, tint FROM projects WHERE id = ?1",
        )?;
        let row = stmt
            .query_row(params![project_id], |r| {
                Ok(crate::commands::ProjectInfo {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    path: r.get(2)?,
                    jira_project_key: r.get(3)?,
                    pinned: r.get::<_, i64>(4)? != 0,
                    tint: r.get(5)?,
                })
            })
            .optional()?;
        Ok(row)
    }

    pub fn update_project_jira_key(
        &self,
        project_id: &str,
        jira_project_key: Option<String>,
    ) -> AppResult<()> {
        self.conn.execute(
            "UPDATE projects SET jira_project_key = ?1 WHERE id = ?2",
            rusqlite::params![jira_project_key, project_id],
        )?;
        Ok(())
    }

    pub fn get_project_by_path(&self, path: &str) -> AppResult<Option<(String, String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path FROM projects WHERE path = ?1",
        )?;
        let row = stmt
            .query_row(params![path], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()?;
        Ok(row)
    }

    pub fn get_project_by_id(&self, id: &str) -> AppResult<Option<(String, String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path FROM projects WHERE id = ?1",
        )?;
        let row = stmt
            .query_row(params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()?;
        Ok(row)
    }

    pub fn update_project(&self, id: &str, name: Option<&str>, tint: Option<&str>) -> AppResult<()> {
        if let Some(name_val) = name {
            self.conn.execute(
                "UPDATE projects SET name = ?1 WHERE id = ?2",
                params![name_val, id],
            )?;
        }
        if let Some(tint_val) = tint {
            self.conn.execute(
                "UPDATE projects SET tint = ?1 WHERE id = ?2",
                params![tint_val, id],
            )?;
        }
        Ok(())
    }

    pub fn set_project_pinned(&self, id: &str, pinned: bool) -> AppResult<()> {
        self.conn.execute(
            "UPDATE projects SET pinned = ?1 WHERE id = ?2",
            params![pinned as i64, id],
        )?;
        Ok(())
    }

    pub fn set_project_order(&self, ids: &[String]) -> AppResult<()> {
        for (idx, id) in ids.iter().enumerate() {
            self.conn.execute(
                "UPDATE projects SET sort_order = ?1 WHERE id = ?2",
                params![idx as i64, id],
            )?;
        }
        Ok(())
    }

    /// Soft-close: hide the project from the rail without deleting anything.
    pub fn close_project(&self, id: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE projects SET closed_at = ?1 WHERE id = ?2",
            params![Utc::now().to_rfc3339(), id],
        )?;
        Ok(())
    }

    /// Reopen a soft-closed project: clear `closed_at` and bump `last_opened`
    /// so it returns to the rail in its prior (creation-order) place.
    pub fn reopen_project(&self, id: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE projects SET closed_at = NULL, last_opened = ?1 WHERE id = ?2",
            params![Utc::now().to_rfc3339(), id],
        )?;
        Ok(())
    }

    /// The most recently closed projects (for the "Recently closed" drawer),
    /// newest first, capped at 10. Same tuple shape as `list_projects`.
    pub fn list_closed_projects(
        &self,
    ) -> AppResult<Vec<(String, String, String, String, Option<String>, bool, Option<String>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path, last_opened, jira_project_key, pinned, tint FROM projects \
             WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 10",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get::<_, i64>(5)? != 0, r.get(6)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn delete_project(&self, id: &str) -> AppResult<()> {
        self.conn.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ─── Workspaces ───────────────────────────────────────────────

    pub fn insert_workspace(
        &self,
        id: &str,
        project_id: &str,
        name: &str,
        task: &str,
        branch: &str,
        worktree_path: Option<&str>,
        setup_script: &str,
        from_branch: Option<&str>,
    ) -> AppResult<()> {
        // Octopush-created worktrees are managed and own their branch by default.
        self.insert_workspace_managed(
            id, project_id, name, task, branch, worktree_path, setup_script, from_branch, true, true,
        )
    }

    /// Insert a workspace row with explicit `managed` / `created_branch` flags,
    /// atomically. The adopt path uses `managed=false`, and a reused branch uses
    /// `created_branch=false`, so the row is *born* with the right ownership —
    /// there's no insert-then-flip window in which a crash could strand a row that
    /// delete/archive would then wrongly `rm -rf` or `git branch -D`.
    #[allow(clippy::too_many_arguments)]
    pub fn insert_workspace_managed(
        &self,
        id: &str,
        project_id: &str,
        name: &str,
        task: &str,
        branch: &str,
        worktree_path: Option<&str>,
        setup_script: &str,
        from_branch: Option<&str>,
        managed: bool,
        created_branch: bool,
    ) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO workspaces (id, project_id, name, task, branch, worktree_path, setup_script, created_at, last_active, from_branch, managed, created_branch)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![id, project_id, name, task, branch, worktree_path, setup_script, now, now, from_branch, managed as i64, created_branch as i64],
        )?;
        Ok(())
    }

    pub fn list_workspaces(&self, project_id: &str) -> AppResult<Vec<WorkspaceRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project_id, name, task, branch, worktree_path, setup_script, status, created_at, last_active, glyph, tint, test_command, linked_issue_key, from_branch
             FROM workspaces WHERE project_id = ?1 AND status != 'archived' ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![project_id], |r| {
            Ok(WorkspaceRow {
                id: r.get(0)?,
                project_id: r.get(1)?,
                name: r.get(2)?,
                task: r.get(3)?,
                branch: r.get(4)?,
                worktree_path: r.get(5)?,
                setup_script: r.get(6)?,
                status: r.get(7)?,
                created_at: r.get(8)?,
                last_active: r.get(9)?,
                glyph: r.get(10)?,
                tint: r.get(11)?,
                test_command: r.get(12)?,
                linked_issue_key: r.get(13)?,
                from_branch: r.get(14)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn get_workspace(&self, workspace_id: &str) -> AppResult<Option<WorkspaceRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project_id, name, task, branch, worktree_path, setup_script, status, created_at, last_active, glyph, tint, test_command, linked_issue_key, from_branch
             FROM workspaces WHERE id = ?1",
        )?;
        let row = stmt
            .query_row(params![workspace_id], |r| {
                Ok(WorkspaceRow {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    name: r.get(2)?,
                    task: r.get(3)?,
                    branch: r.get(4)?,
                    worktree_path: r.get(5)?,
                    setup_script: r.get(6)?,
                    status: r.get(7)?,
                    created_at: r.get(8)?,
                    last_active: r.get(9)?,
                    glyph: r.get(10)?,
                    tint: r.get(11)?,
                    test_command: r.get(12)?,
                    linked_issue_key: r.get(13)?,
                    from_branch: r.get(14)?,
                })
            })
            .optional()?;
        Ok(row)
    }

    // ── Missions ────────────────────────────────────────────────────────────

    #[allow(clippy::too_many_arguments)]
    pub fn insert_mission(
        &self,
        id: &str,
        workspace_id: Option<&str>,
        project_id: &str,
        intent: &str,
        title: &str,
        status: &str,
        linked_issue_key: Option<&str>,
        git_isolation: &str,
        exec_isolation: &str,
        payload: &str,
    ) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn
            .execute(
                "INSERT INTO missions (id, workspace_id, project_id, intent, title, status, linked_issue_key, git_isolation, exec_isolation, payload, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)",
                params![id, workspace_id, project_id, intent, title, status, linked_issue_key, git_isolation, exec_isolation, payload, now],
            )
            .map_err(|e| {
                let s = e.to_string();
                // Only the writer-uniqueness violation (partial index on
                // `workspace_id`) maps to this message; SQLite names the column,
                // not the index. A PK (`missions.id`) collision or any other
                // UNIQUE must propagate untouched, not be mislabeled.
                if s.contains("missions.workspace_id") {
                    crate::error::AppError::Other(
                        "another active mission is already writing this workspace".into(),
                    )
                } else {
                    e.into()
                }
            })?;
        Ok(())
    }

    pub fn list_missions(&self, project_id: &str) -> AppResult<Vec<MissionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, project_id, intent, title, status, linked_issue_key, git_isolation, exec_isolation, payload, created_at, updated_at, archived_at
             FROM missions WHERE project_id = ?1 AND status != 'archived' ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![project_id], |r| row_to_mission(r))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn get_mission(&self, mission_id: &str) -> AppResult<Option<MissionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, project_id, intent, title, status, linked_issue_key, git_isolation, exec_isolation, payload, created_at, updated_at, archived_at
             FROM missions WHERE id = ?1",
        )?;
        stmt.query_row(params![mission_id], |r| row_to_mission(r))
            .optional()
            .map_err(Into::into)
    }

    /// The active mission that owns a workspace (the 1:1 pairing for code
    /// missions). Prefers an active row when an archived one also exists.
    pub fn mission_for_workspace(&self, workspace_id: &str) -> AppResult<Option<MissionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, project_id, intent, title, status, linked_issue_key, git_isolation, exec_isolation, payload, created_at, updated_at, archived_at
             FROM missions WHERE workspace_id = ?1
             ORDER BY (status = 'archived') ASC, created_at ASC LIMIT 1",
        )?;
        stmt.query_row(params![workspace_id], |r| row_to_mission(r))
            .optional()
            .map_err(Into::into)
    }

    /// The *active* mission owning a workspace, if any. Distinct from
    /// `mission_for_workspace` (which prefers-but-falls-back-to archived) — the
    /// pairing path needs "is there a live mission?" so it never re-adopts an
    /// archived row.
    pub fn active_mission_for_workspace(&self, workspace_id: &str) -> AppResult<Option<MissionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, project_id, intent, title, status, linked_issue_key, git_isolation, exec_isolation, payload, created_at, updated_at, archived_at
             FROM missions WHERE workspace_id = ?1 AND status = 'active'
             ORDER BY created_at ASC LIMIT 1",
        )?;
        stmt.query_row(params![workspace_id], |r| row_to_mission(r))
            .optional()
            .map_err(Into::into)
    }

    /// Partial update. `None` leaves a column unchanged (COALESCE); this cannot
    /// clear `linked_issue_key` to NULL — a later slice adds explicit-clear if
    /// the workspace-link mirroring needs it.
    pub fn update_mission(
        &self,
        mission_id: &str,
        title: Option<&str>,
        status: Option<&str>,
        linked_issue_key: Option<&str>,
    ) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE missions SET
                title = COALESCE(?2, title),
                status = COALESCE(?3, status),
                archived_at = CASE
                    WHEN ?3 = 'archived' THEN COALESCE(archived_at, ?5)
                    WHEN ?3 IS NOT NULL THEN NULL
                    ELSE archived_at END,
                linked_issue_key = COALESCE(?4, linked_issue_key),
                updated_at = ?5
             WHERE id = ?1",
            params![mission_id, title, status, linked_issue_key, now],
        )?;
        Ok(())
    }

    /// Archive a mission (status + `archived_at`). Callers archive the underlying
    /// workspace through the existing guarded path (`archive_workspace`) separately.
    pub fn archive_mission(&self, mission_id: &str) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE missions SET status = 'archived', archived_at = ?2, updated_at = ?2 WHERE id = ?1",
            params![mission_id, now],
        )?;
        Ok(())
    }

    /// Find a workspace by `(project_id, branch)` regardless of status. There
    /// is at most one meaningful workspace per branch (git can't check a branch
    /// out twice); when both an active and an archived row somehow exist we
    /// prefer the active one. Used to keep workspace creation idempotent —
    /// including over *archived* rows, which `list_workspaces` hides.
    pub fn find_workspace_by_branch(
        &self,
        project_id: &str,
        branch: &str,
    ) -> AppResult<Option<WorkspaceRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project_id, name, task, branch, worktree_path, setup_script, status, created_at, last_active, glyph, tint, test_command, linked_issue_key, from_branch
             FROM workspaces WHERE project_id = ?1 AND branch = ?2
             ORDER BY (status = 'archived') ASC, created_at ASC LIMIT 1",
        )?;
        let row = stmt
            .query_row(params![project_id, branch], |r| {
                Ok(WorkspaceRow {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    name: r.get(2)?,
                    task: r.get(3)?,
                    branch: r.get(4)?,
                    worktree_path: r.get(5)?,
                    setup_script: r.get(6)?,
                    status: r.get(7)?,
                    created_at: r.get(8)?,
                    last_active: r.get(9)?,
                    glyph: r.get(10)?,
                    tint: r.get(11)?,
                    test_command: r.get(12)?,
                    linked_issue_key: r.get(13)?,
                    from_branch: r.get(14)?,
                })
            })
            .optional()?;
        Ok(row)
    }

    pub fn update_workspace_link(
        &self,
        workspace_id: &str,
        linked_issue_key: Option<String>,
    ) -> AppResult<()> {
        self.conn.execute(
            "UPDATE workspaces SET linked_issue_key = ?1 WHERE id = ?2",
            rusqlite::params![linked_issue_key, workspace_id],
        )?;
        Ok(())
    }

    /// Update a workspace's on-disk worktree path. Used when a worktree is
    /// (re)created at a different location than the row originally recorded —
    /// e.g. the original path was occupied, so `create_worktree` stepped aside.
    pub fn set_workspace_worktree_path(&self, id: &str, worktree_path: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE workspaces SET worktree_path = ?1 WHERE id = ?2",
            params![worktree_path, id],
        )?;
        Ok(())
    }

    /// Set whether Octopush owns (manages) this workspace's worktree. Used by the
    /// heal paths: adopting a branch's checkout at a different location marks it
    /// not-ours (never rm on delete); rebuilding a gone worktree marks it ours.
    pub fn set_workspace_managed(&self, id: &str, managed: bool) -> AppResult<()> {
        self.conn.execute(
            "UPDATE workspaces SET managed = ?1 WHERE id = ?2",
            params![managed as i64, id],
        )?;
        Ok(())
    }

    /// Does Octopush own (manage) this workspace's worktree? An existing row's
    /// legacy default is `true` (every pre-existing worktree was Octopush-made),
    /// but a MISSING ROW is `false`: these flags gate destruction, and "no such
    /// row" is uncertainty — we never `rm -rf` on uncertainty (e.g. a double-fire
    /// delete that finds the row already gone must not rm the path a second time).
    /// The `managed` column is `NOT NULL DEFAULT 1`, so an existing row always
    /// yields a value; `None` here means the row is absent, not legacy.
    pub fn is_workspace_managed(&self, id: &str) -> AppResult<bool> {
        let managed: Option<i64> = self
            .conn
            .query_row(
                "SELECT managed FROM workspaces WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(managed.map(|m| m != 0).unwrap_or(false))
    }

    /// Did Octopush create this workspace's git branch (vs reuse/adopt an existing
    /// one)? Only then may delete remove the branch. An existing row's legacy
    /// default is `true` (historically delete always removed the branch), but a
    /// MISSING ROW is `false` — same reasoning as `is_workspace_managed`: a
    /// double-fire delete on an already-removed row must never `git branch -D` a
    /// branch we may not have created.
    pub fn is_branch_created_by_octopush(&self, id: &str) -> AppResult<bool> {
        let created: Option<i64> = self
            .conn
            .query_row(
                "SELECT created_branch FROM workspaces WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(created.map(|c| c != 0).unwrap_or(false))
    }

    pub fn delete_workspace(&self, id: &str) -> AppResult<()> {
        // Cascade to missions in lockstep. `missions` has no FK on workspace_id
        // (it is nullable for design/probe missions), so a deleted workspace's
        // missions must be removed explicitly or they linger as active orphans.
        self.conn
            .execute("DELETE FROM missions WHERE workspace_id = ?1", params![id])?;
        self.conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Mark a workspace archived (worktree removed, branch kept). The row
    /// survives but is hidden from the rail.
    pub fn archive_workspace(&self, id: &str) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE workspaces SET status = 'archived' WHERE id = ?1",
            params![id],
        )?;
        // Keep the paired mission in lockstep: archive its active mission(s) so
        // the writer slot frees and it stops surfacing as an active mission.
        self.conn.execute(
            "UPDATE missions SET status = 'archived', archived_at = ?2, updated_at = ?2
             WHERE workspace_id = ?1 AND status = 'active'",
            params![id, now],
        )?;
        Ok(())
    }

    /// Un-archive a workspace (status back to active).
    pub fn restore_workspace(&self, id: &str) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE workspaces SET status = 'active' WHERE id = ?1",
            params![id],
        )?;
        // Re-pair: reactivate the most-recent archived mission when the workspace
        // has no active one, restoring the 1:1 code-mission invariant without
        // ever minting a duplicate (the NOT EXISTS guard keeps the writer slot
        // occupied by exactly one active mission).
        self.conn.execute(
            "UPDATE missions SET status = 'active', archived_at = NULL, updated_at = ?2
             WHERE id = (
                 SELECT id FROM missions WHERE workspace_id = ?1 AND status = 'archived'
                 ORDER BY created_at DESC LIMIT 1
             )
             AND NOT EXISTS (
                 SELECT 1 FROM missions m2 WHERE m2.workspace_id = ?1 AND m2.status = 'active'
             )",
            params![id, now],
        )?;
        Ok(())
    }

    /// Archived workspaces for a project (status='archived'), newest first.
    pub fn list_archived_workspaces(&self, project_id: &str) -> AppResult<Vec<WorkspaceRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project_id, name, task, branch, worktree_path, setup_script, status, created_at, last_active, glyph, tint, test_command, linked_issue_key, from_branch
             FROM workspaces WHERE project_id = ?1 AND status = 'archived' ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(params![project_id], |r| {
            Ok(WorkspaceRow {
                id: r.get(0)?,
                project_id: r.get(1)?,
                name: r.get(2)?,
                task: r.get(3)?,
                branch: r.get(4)?,
                worktree_path: r.get(5)?,
                setup_script: r.get(6)?,
                status: r.get(7)?,
                created_at: r.get(8)?,
                last_active: r.get(9)?,
                glyph: r.get(10)?,
                tint: r.get(11)?,
                test_command: r.get(12)?,
                linked_issue_key: r.get(13)?,
                from_branch: r.get(14)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn rename_workspace(&self, id: &str, name: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE workspaces SET name = ?1 WHERE id = ?2",
            params![name, id],
        )?;
        Ok(())
    }

    pub fn update_workspace_customization(
        &self,
        workspace_id: &str,
        glyph: Option<&str>,
        tint: Option<&str>,
    ) -> AppResult<()> {
        self.conn.execute(
            "UPDATE workspaces SET glyph = ?1, tint = ?2 WHERE id = ?3",
            params![glyph, tint, workspace_id],
        )?;
        Ok(())
    }

    // ─── Chat messages ────────────────────────────────────────────

    pub fn insert_chat_message(
        &self,
        workspace_id: &str,
        thread_id: &str,
        role: &str,
        content: &str,
        model: Option<&str>,
        input_tokens: Option<i64>,
        output_tokens: Option<i64>,
        cost: Option<f64>,
    ) -> AppResult<i64> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO chat_messages (workspace_id, thread_id, role, content, model, input_tokens, output_tokens, cost_usd, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![workspace_id, thread_id, role, content, model, input_tokens, output_tokens, cost, now],
        )?;
        // Bump the thread's recency so the history list sorts most-recent-first.
        let _ = self.conn.execute(
            "UPDATE chat_threads SET updated_at = ?1 WHERE id = ?2",
            params![now, thread_id],
        );
        Ok(self.conn.last_insert_rowid())
    }

    // ─── Chat threads ─────────────────────────────────────────────

    /// Create a new conversation thread for a workspace, returning its row.
    pub fn create_chat_thread(&self, workspace_id: &str, title: &str) -> AppResult<ChatThreadRow> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO chat_threads (id, workspace_id, title, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?4)",
            params![id, workspace_id, title, now],
        )?;
        Ok(ChatThreadRow {
            id,
            workspace_id: workspace_id.to_string(),
            title: title.to_string(),
            created_at: now.clone(),
            updated_at: now,
            pinned: false,
        })
    }

    /// Pin/unpin a conversation — pinned threads sort to the top of the list.
    pub fn set_thread_pinned(&self, thread_id: &str, pinned: bool) -> AppResult<()> {
        self.conn.execute(
            "UPDATE chat_threads SET pinned = ?2 WHERE id = ?1",
            params![thread_id, pinned as i64],
        )?;
        Ok(())
    }

    /// List a workspace's threads, most-recently-active first.
    pub fn list_chat_threads(&self, workspace_id: &str) -> AppResult<Vec<ChatThreadRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, title, created_at, updated_at, pinned
             FROM chat_threads WHERE workspace_id = ?1
             ORDER BY pinned DESC, updated_at DESC",
        )?;
        let rows = stmt.query_map(params![workspace_id], |r| {
            Ok(ChatThreadRow {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                title: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
                pinned: r.get::<_, i64>(5)? != 0,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn rename_chat_thread(&self, thread_id: &str, title: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE chat_threads SET title = ?1 WHERE id = ?2",
            params![title, thread_id],
        )?;
        Ok(())
    }

    /// Delete a thread and its messages (messages are removed explicitly since
    /// chat_messages has no FK to chat_threads).
    pub fn delete_chat_thread(&self, thread_id: &str) -> AppResult<()> {
        self.conn.execute("DELETE FROM chat_messages WHERE thread_id = ?1", params![thread_id])?;
        self.conn.execute("DELETE FROM chat_threads WHERE id = ?1", params![thread_id])?;
        Ok(())
    }

    /// Delete a message and everything after it in a thread (ids are monotonic
    /// per thread). Backs Regenerate (truncate from the assistant turn) and
    /// Edit-and-resend (truncate from the edited user message). Scoped by
    /// thread_id so it never touches another conversation's rows.
    pub fn truncate_chat_after(&self, thread_id: &str, message_id: i64) -> AppResult<()> {
        self.conn.execute(
            "DELETE FROM chat_messages WHERE thread_id = ?1 AND id >= ?2",
            params![thread_id, message_id],
        )?;
        Ok(())
    }

    /// Record a `$`-direct command in the workspace's recall history (upsert:
    /// bumps recency + use-count for a repeated command). Best-effort.
    pub fn record_shell_history(&self, workspace_id: &str, command: &str) -> AppResult<()> {
        let cmd = command.trim();
        if cmd.is_empty() {
            return Ok(());
        }
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
        self.conn.execute(
            "INSERT INTO shell_history (workspace_id, command, used_at, uses)
             VALUES (?1, ?2, ?3, 1)
             ON CONFLICT(workspace_id, command)
             DO UPDATE SET used_at = excluded.used_at, uses = uses + 1",
            params![workspace_id, cmd, now],
        )?;
        Ok(())
    }

    /// Most-recently-used `$`-direct commands for a workspace (newest first).
    pub fn list_shell_history(&self, workspace_id: &str, limit: i64) -> AppResult<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT command FROM shell_history WHERE workspace_id = ?1
             ORDER BY used_at DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![workspace_id, limit], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Whether a chat thread still exists — used to avoid persisting a late
    /// live-process result row for a conversation the user already deleted.
    pub fn chat_thread_exists(&self, thread_id: &str) -> AppResult<bool> {
        let exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM chat_threads WHERE id = ?1)",
            params![thread_id],
            |row| row.get(0),
        )?;
        Ok(exists)
    }

    // ─── Terminals ────────────────────────────────────────────────

    pub fn list_terminals(&self, workspace_id: &str) -> AppResult<Vec<TerminalRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, label, position, created_at
             FROM terminals WHERE workspace_id = ?1 ORDER BY position ASC",
        )?;
        let rows = stmt.query_map(params![workspace_id], |r| {
            Ok(TerminalRow {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                label: r.get(2)?,
                position: r.get::<_, i64>(3)? as u32,
                created_at: r.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn create_terminal(
        &self,
        id: &str,
        workspace_id: &str,
        label: &str,
        position: u32,
        created_at: i64,
    ) -> AppResult<()> {
        self.conn.execute(
            "INSERT INTO terminals (id, workspace_id, label, position, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, workspace_id, label, position as i64, created_at],
        )?;
        Ok(())
    }

    pub fn max_terminal_position(&self, workspace_id: &str) -> AppResult<Option<u32>> {
        let mut stmt = self.conn.prepare(
            "SELECT MAX(position) FROM terminals WHERE workspace_id = ?1",
        )?;
        let val: Option<i64> = stmt.query_row(params![workspace_id], |r| r.get(0))?;
        Ok(val.map(|v| v as u32))
    }

    pub fn rename_terminal(&self, id: &str, label: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE terminals SET label = ?1 WHERE id = ?2",
            params![label, id],
        )?;
        Ok(())
    }

    pub fn delete_terminal(&self, id: &str) -> AppResult<()> {
        self.conn.execute(
            "DELETE FROM terminals WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    // ─── Budgets ──────────────────────────────────────────────────

    pub fn list_budgets(&self) -> AppResult<Vec<BudgetRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT scope_type, scope_id, period, limit_usd, updated_at FROM budgets ORDER BY scope_type, scope_id, period",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(BudgetRow {
                scope_type: r.get(0)?,
                scope_id: r.get(1)?,
                period: r.get(2)?,
                limit_usd: r.get(3)?,
                updated_at: r.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn upsert_budget(
        &self,
        scope_type: &str,
        scope_id: &str,
        period: &str,
        limit_usd: f64,
    ) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO budgets (scope_type, scope_id, period, limit_usd, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(scope_type, scope_id, period) DO UPDATE SET
                 limit_usd = excluded.limit_usd,
                 updated_at = excluded.updated_at",
            params![scope_type, scope_id, period, limit_usd, now],
        )?;
        Ok(())
    }

    pub fn delete_budget(&self, scope_type: &str, scope_id: &str, period: &str) -> AppResult<()> {
        self.conn.execute(
            "DELETE FROM budgets WHERE scope_type = ?1 AND scope_id = ?2 AND period = ?3",
            params![scope_type, scope_id, period],
        )?;
        Ok(())
    }

    /// Returns (cost_usd, tokens) for the given scope and period.
    /// - period = "daily"   → events since start of today UTC
    /// - period = "monthly" → events since start of this month UTC
    /// - scope_type = "global"    → all events
    /// - scope_type = "workspace" → events where session_id = scope_id
    /// - scope_type = "project"   → events whose session_id is a workspace belonging to scope_id project
    pub fn period_spend(
        &self,
        scope_type: &str,
        scope_id: &str,
        period: &str,
    ) -> AppResult<(f64, i64)> {
        let since = match period {
            "monthly" => "datetime('now', 'start of month')",
            _ => "datetime('now', 'start of day')",
        };

        let (cost, tokens) = match scope_type {
            "workspace" => {
                let sql = format!(
                    "SELECT COALESCE(SUM(cost_usd), 0.0), COALESCE(SUM(input_tokens + output_tokens), 0)
                     FROM token_events
                     WHERE session_id = ?1 AND timestamp >= {since}"
                );
                let mut stmt = self.conn.prepare(&sql)?;
                stmt.query_row(params![scope_id], |r| {
                    Ok((r.get::<_, f64>(0)?, r.get::<_, i64>(1)?))
                })?
            }
            "project" => {
                let sql = format!(
                    "SELECT COALESCE(SUM(e.cost_usd), 0.0), COALESCE(SUM(e.input_tokens + e.output_tokens), 0)
                     FROM token_events e
                     JOIN workspaces w ON w.id = e.session_id
                     WHERE w.project_id = ?1 AND e.timestamp >= {since}"
                );
                let mut stmt = self.conn.prepare(&sql)?;
                stmt.query_row(params![scope_id], |r| {
                    Ok((r.get::<_, f64>(0)?, r.get::<_, i64>(1)?))
                })?
            }
            _ => {
                // global
                let sql = format!(
                    "SELECT COALESCE(SUM(cost_usd), 0.0), COALESCE(SUM(input_tokens + output_tokens), 0)
                     FROM token_events
                     WHERE timestamp >= {since}"
                );
                let mut stmt = self.conn.prepare(&sql)?;
                stmt.query_row([], |r| {
                    Ok((r.get::<_, f64>(0)?, r.get::<_, i64>(1)?))
                })?
            }
        };
        Ok((cost, tokens))
    }

    /// Return a breakdown of cloud vs local token usage within a time range.
    ///
    /// Local models (provider.local == true) have $0 cost but their volume is
    /// interesting as a "we saved X vs running cloud" metric. We estimate savings
    /// by comparing local token count against the cheapest cloud model price
    /// (currently DeepSeek Chat at $0.14/M input + $0.28/M output — we use a
    /// blended $0.21/M average as a simple conservative estimate).
    pub fn usage_breakdown(
        &self,
        router: &crate::provider_router::ProviderRouter,
        start_iso: &str,
        end_iso: &str,
    ) -> AppResult<UsageBreakdown> {
        // Cheapest cloud equivalent used for local savings estimate.
        // DeepSeek Chat: $0.14/M input, $0.28/M output → blended ~$0.21/M.
        const CHEAPEST_CLOUD_PER_M: f64 = 0.21;

        // Per-model aggregates within the time range.
        let mut stmt = self.conn.prepare(
            "SELECT model,
                    COALESCE(SUM(cost_usd), 0),
                    COALESCE(SUM(input_tokens + output_tokens), 0)
             FROM token_events
             WHERE timestamp >= ?1 AND timestamp <= ?2
             GROUP BY model",
        )?;
        let rows = stmt.query_map(rusqlite::params![start_iso, end_iso], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, f64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;

        let mut cloud_cost_usd = 0.0_f64;
        let mut cloud_tokens: i64 = 0;
        let mut local_tokens: i64 = 0;

        for row in rows {
            let (model, cost, tokens) = row?;
            // Find the provider for this model. Unknown models are treated as cloud.
            let is_local = router
                .find_model(&model)
                .map(|(p, _)| p.local)
                .unwrap_or(false);

            if is_local {
                local_tokens += tokens;
            } else {
                cloud_cost_usd += cost;
                cloud_tokens += tokens;
            }
        }

        let estimated_local_savings_usd =
            local_tokens as f64 * CHEAPEST_CLOUD_PER_M / 1_000_000.0;

        Ok(UsageBreakdown {
            cloud_cost_usd,
            cloud_tokens,
            local_tokens,
            estimated_local_savings_usd,
        })
    }

    /// Export token events in the given time range as CSV.
    pub fn export_token_events_csv(
        &self,
        start_iso: &str,
        end_iso: &str,
    ) -> AppResult<String> {
        let mut stmt = self.conn.prepare(
            "SELECT timestamp, session_id, model, input_tokens, output_tokens, cost_usd
             FROM token_events
             WHERE timestamp >= ?1 AND timestamp <= ?2
             ORDER BY timestamp",
        )?;
        let mut csv = String::from("timestamp,workspace_id,model,input_tokens,output_tokens,cost_usd\n");
        let rows = stmt.query_map(params![start_iso, end_iso], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, f64>(5)?,
            ))
        })?;
        for row in rows {
            let (ts, ws, model, input, output, cost) = row?;
            csv.push_str(&format!("{},{},{},{},{},{:.6}\n", ts, ws, model, input, output, cost));
        }
        Ok(csv)
    }

    // ─── File edits ───────────────────────────────────────────────

    pub fn insert_file_edit(
        &self,
        workspace_id: &str,
        file_path: &str,
        tool_name: &str,
        message_id: Option<i64>,
    ) -> AppResult<i64> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO file_edits (workspace_id, file_path, tool_name, message_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![workspace_id, file_path, tool_name, message_id, now],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn list_file_edits_for_workspace(&self, workspace_id: &str) -> AppResult<Vec<FileEditRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, file_path, tool_name, message_id, created_at
             FROM file_edits WHERE workspace_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(params![workspace_id], |r| {
            Ok(FileEditRow {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                file_path: r.get(2)?,
                tool_name: r.get(3)?,
                message_id: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn latest_edit_for_file(&self, workspace_id: &str, file_path: &str) -> AppResult<Option<FileEditRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, file_path, tool_name, message_id, created_at
             FROM file_edits WHERE workspace_id = ?1 AND file_path = ?2
             ORDER BY created_at DESC LIMIT 1",
        )?;
        let row = stmt
            .query_row(params![workspace_id, file_path], |r| {
                Ok(FileEditRow {
                    id: r.get(0)?,
                    workspace_id: r.get(1)?,
                    file_path: r.get(2)?,
                    tool_name: r.get(3)?,
                    message_id: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })
            .optional()?;
        Ok(row)
    }

    // ─── Workspace test command ───────────────────────────────────

    pub fn set_workspace_test_command(&self, workspace_id: &str, command: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE workspaces SET test_command = ?1 WHERE id = ?2",
            params![command, workspace_id],
        )?;
        Ok(())
    }

    pub fn get_workspace_test_command(&self, workspace_id: &str) -> AppResult<Option<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT test_command FROM workspaces WHERE id = ?1",
        )?;
        let result = stmt
            .query_row(params![workspace_id], |r| r.get::<_, Option<String>>(0))
            .optional()?;
        Ok(result.flatten())
    }

    pub fn get_chat_message(&self, message_id: i64) -> AppResult<Option<ChatMessageRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, role, content, model, input_tokens, output_tokens, cost_usd, created_at
             FROM chat_messages WHERE id = ?1",
        )?;
        let row = stmt
            .query_row(params![message_id], |r| {
                Ok(ChatMessageRow {
                    id: r.get(0)?,
                    workspace_id: r.get(1)?,
                    role: r.get(2)?,
                    content: r.get(3)?,
                    model: r.get(4)?,
                    input_tokens: r.get(5)?,
                    output_tokens: r.get(6)?,
                    cost_usd: r.get(7)?,
                    created_at: r.get(8)?,
                })
            })
            .optional()?;
        Ok(row)
    }

    /// List a single thread's messages in chronological order. (Scoped by
    /// thread, not workspace — a workspace can hold several conversations.)
    pub fn list_chat_messages(&self, thread_id: &str) -> AppResult<Vec<ChatMessageRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, role, content, model, input_tokens, output_tokens, cost_usd, created_at
             FROM chat_messages WHERE thread_id = ?1 ORDER BY created_at",
        )?;
        let rows = stmt.query_map(params![thread_id], |r| {
            Ok(ChatMessageRow {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                role: r.get(2)?,
                content: r.get(3)?,
                model: r.get(4)?,
                input_tokens: r.get(5)?,
                output_tokens: r.get(6)?,
                cost_usd: r.get(7)?,
                created_at: r.get(8)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    // ─── Pipelines ────────────────────────────────────────────────

    pub fn list_pipelines(&self) -> AppResult<Vec<PipelineRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, description, is_builtin, created_at FROM pipelines ORDER BY is_builtin DESC, name",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(PipelineRow {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                is_builtin: r.get::<_, i64>(3)? != 0,
                created_at: r.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn get_pipeline_stages(&self, pipeline_id: &str) -> AppResult<Vec<PipelineStageRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, pipeline_id, position, role, agent_model, substrate, checkpoint,
                    loop_target_position, loop_max_iterations, loop_mode, max_iterations,
                    pos_x, pos_y, parents, tools, custom_name, instructions, effort,
                    escalate_model, escalate_effort
             FROM pipeline_stages WHERE pipeline_id = ?1 ORDER BY position",
        )?;
        let rows = stmt.query_map(params![pipeline_id], |r| {
            Ok(PipelineStageRow {
                id: r.get(0)?,
                pipeline_id: r.get(1)?,
                position: r.get(2)?,
                role: r.get(3)?,
                agent_model: r.get(4)?,
                substrate: r.get(5)?,
                checkpoint: r.get::<_, i64>(6)? != 0,
                loop_target_position: r.get(7)?,
                loop_max_iterations: r.get(8)?,
                loop_mode: r.get(9)?,
                max_iterations: r.get(10)?,
                pos_x: r.get(11)?,
                pos_y: r.get(12)?,
                parents: parse_parents(r.get(13)?),
                tools: parse_tools(r.get(14)?),
                custom_name: r.get(15)?,
                instructions: r.get(16)?,
                effort: r.get::<_, Option<String>>(17)?.as_deref().and_then(crate::providers::Effort::from_str),
                escalate_model: r.get(18)?,
                escalate_effort: r.get::<_, Option<String>>(19)?.as_deref().and_then(crate::providers::Effort::from_str),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn insert_pipeline(
        &self,
        name: &str,
        description: &str,
        is_builtin: bool,
    ) -> AppResult<String> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO pipelines (id, name, description, is_builtin, created_at)
             VALUES (?1,?2,?3,?4,?5)",
            params![id, name, description, is_builtin as i64, now],
        )?;
        Ok(id)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn insert_pipeline_stage(
        &self,
        pipeline_id: &str,
        position: i64,
        role: &str,
        agent_model: &str,
        substrate: &str,
        checkpoint: bool,
        loop_target_position: Option<i64>,
        loop_max_iterations: i64,
        loop_mode: Option<&str>,
        max_iterations: i64,
    ) -> AppResult<String> {
        let id = Uuid::new_v4().to_string();
        self.conn.execute(
            "INSERT INTO pipeline_stages
                (id, pipeline_id, position, role, agent_model, substrate, checkpoint,
                 loop_target_position, loop_max_iterations, loop_mode, max_iterations)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![id, pipeline_id, position, role, agent_model, substrate, checkpoint as i64,
                    loop_target_position, loop_max_iterations, loop_mode, max_iterations],
        )?;
        Ok(id)
    }

    /// Insert the three curated pipelines if they are not already present.
    /// Idempotent: keyed on the builtin name.
    pub fn seed_builtin_pipelines(&self) -> AppResult<()> {
        // (name, description, [(role, model, substrate, checkpoint, loop_target, loop_max, loop_mode)])
        let defs: &[(&str, &str, &[(&str, &str, &str, bool, Option<i64>, i64, Option<&str>)])] = &[
            (
                "Feature Factory",
                "Full build: plan, review, implement, review, test.",
                &[
                    ("plan",        "claude-haiku-4-5",   "api", false, None,    0, None),
                    ("plan_review", "claude-haiku-4-5",   "api", false, None,    0, None),
                    ("implement",   "claude-sonnet-4-6",  "api", true,  None,    0, None),
                    ("code_review", "claude-haiku-4-5",   "api", true,  Some(2), 2, Some("gated")),
                    ("test",        "claude-haiku-4-5",   "api", true,  None,    0, None),
                ],
            ),
            (
                "Bugfix relay",
                "Reproduce, fix, verify. Lean and fast.",
                &[
                    ("repro",  "claude-haiku-4-5",  "api", false, None,    0, None),
                    ("fix",    "claude-sonnet-4-6",  "api", true,  None,    0, None),
                    ("verify", "claude-haiku-4-5",   "api", true,  Some(1), 2, Some("gated")),
                ],
            ),
            (
                "Plan & review",
                "Thinking only — no code is written.",
                &[
                    ("plan",     "claude-sonnet-4-6", "api", false, None, 0, None),
                    ("critique", "claude-haiku-4-5",  "api", false, None, 0, None),
                    ("refine",   "claude-sonnet-4-6", "api", true,  None, 0, None),
                ],
            ),
            (
                "Ship it",
                "Issue to pull request: plan, implement, review, test, open the PR.",
                &[
                    ("plan",         "claude-haiku-4-5",  "api", false, None,    0, None),
                    ("implement",    "claude-sonnet-4-6", "api", true,  None,    0, None),
                    ("code_review",  "claude-haiku-4-5",  "api", true,  Some(1), 2, Some("gated")),
                    ("test",         "claude-haiku-4-5",  "api", true,  None,    0, None),
                    ("pull_request", "claude-sonnet-4-6", "cli", true,  None,    0, None),
                ],
            ),
            (
                "Claude Code build",
                "Plan via API, then implement, review, and test with Claude Code (CLI).",
                &[
                    ("plan",        "claude-haiku-4-5",  "api", false, None,    0, None),
                    ("implement",   "claude-sonnet-4-6", "cli", true,  None,    0, None),
                    ("code_review", "claude-haiku-4-5",  "cli", true,  Some(1), 2, Some("gated")),
                    ("test",        "claude-haiku-4-5",  "cli", true,  None,    0, None),
                ],
            ),
        ];

        for (name, desc, stages) in defs {
            let exists: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM pipelines WHERE name = ?1 AND is_builtin = 1",
                params![name],
                |r| r.get(0),
            )?;
            if exists > 0 {
                continue;
            }
            let pid = self.insert_pipeline(name, desc, true)?;
            for (i, (role, model, substrate, checkpoint, lt, lm, lmode)) in stages.iter().enumerate() {
                self.insert_pipeline_stage(&pid, i as i64, role, model, substrate, *checkpoint, *lt, *lm, *lmode, 25)?;
            }
        }

        // Backfill: existing installs seeded the builtins before loop config existed.
        // Set the gated default on builtin review stages that are still linear. The
        // `loop_mode IS NULL` guard makes this idempotent and never overrides a config.
        self.conn.execute(
            "UPDATE pipeline_stages
             SET loop_target_position =
                   (SELECT MAX(prev.position) FROM pipeline_stages prev
                    WHERE prev.pipeline_id = pipeline_stages.pipeline_id
                      AND prev.role IN ('implement','fix')
                      AND prev.position < pipeline_stages.position),
                 loop_max_iterations = 2,
                 loop_mode = 'gated'
             WHERE loop_mode IS NULL
               AND role IN ('code_review','verify')
               AND pipeline_id IN (SELECT id FROM pipelines WHERE is_builtin = 1)
               AND EXISTS (SELECT 1 FROM pipeline_stages prev
                           WHERE prev.pipeline_id = pipeline_stages.pipeline_id
                             AND prev.role IN ('implement','fix')
                             AND prev.position < pipeline_stages.position)",
            [],
        )?;

        Ok(())
    }

    /// Create, fork, or update a pipeline from builder drafts (validated).
    /// - `None` → create a new custom pipeline.
    /// - `Some(builtin)` → FORK: a new custom copy is created; the builtin is never touched.
    /// - `Some(custom)` → update meta + replace the stage set, transactionally.
    /// Returns the saved pipeline's id (the new id when created/forked).
    pub fn save_pipeline(
        &self,
        pipeline_id: Option<String>,
        name: &str,
        description: &str,
        stages: &[StageDraft],
    ) -> AppResult<String> {
        use crate::error::AppError;
        if name.trim().is_empty() {
            return Err(AppError::Other("the pipeline needs a name".into()));
        }
        self.validate_pipeline_stages(stages)?;

        // Resolve the edit target: does it exist, and is it a builtin?
        let target: Option<(String, bool)> = match pipeline_id.as_deref() {
            Some(id) => Some(
                self.conn
                    .query_row(
                        "SELECT id, is_builtin FROM pipelines WHERE id = ?1",
                        params![id],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0)),
                    )
                    .optional()?
                    .ok_or_else(|| AppError::Other("pipeline not found".into()))?,
            ),
            None => None,
        };

        let tx = self.conn.unchecked_transaction()?;
        let saved_id = match target {
            // Update a custom pipeline in place.
            Some((id, false)) => {
                tx.execute(
                    "UPDATE pipelines SET name = ?2, description = ?3, updated_at = ?4 WHERE id = ?1",
                    params![id, name, description, Utc::now().to_rfc3339()],
                )?;
                tx.execute("DELETE FROM pipeline_stages WHERE pipeline_id = ?1", params![id])?;
                id
            }
            // Create (no target) or fork (builtin target): a fresh custom pipeline.
            _ => {
                let id = Uuid::new_v4().to_string();
                let now = Utc::now().to_rfc3339();
                tx.execute(
                    "INSERT INTO pipelines (id, name, description, is_builtin, created_at, updated_at)
                     VALUES (?1,?2,?3,0,?4,?4)",
                    params![id, name, description, now],
                )?;
                id
            }
        };
        for (i, s) in stages.iter().enumerate() {
            let parents_json = serde_json::to_string(&s.parents).ok();
            let tools_json = tools_to_json(&s.tools);
            let custom_name = s.custom_name.as_deref().map(str::trim).filter(|t| !t.is_empty());
            let instructions = s.instructions.as_deref().map(str::trim).filter(|t| !t.is_empty());
            tx.execute(
                "INSERT INTO pipeline_stages
                    (id, pipeline_id, position, role, agent_model, substrate, checkpoint,
                     loop_target_position, loop_max_iterations, loop_mode, max_iterations,
                     pos_x, pos_y, parents, tools, custom_name, instructions, effort,
                     escalate_model, escalate_effort)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
                params![Uuid::new_v4().to_string(), saved_id, i as i64, s.role, s.agent_model,
                        s.substrate, s.checkpoint as i64,
                        s.loop_target_position, s.loop_max_iterations, s.loop_mode,
                        s.max_iterations,
                        s.pos_x, s.pos_y, parents_json, tools_json, custom_name, instructions,
                        s.effort.as_ref().map(|e| e.as_str()),
                        s.escalate_model.as_deref().map(str::trim).filter(|t| !t.is_empty()),
                        s.escalate_effort.as_ref().map(|e| e.as_str())],
            )?;
        }
        tx.commit()?;
        Ok(saved_id)
    }

    /// Delete a custom pipeline and its stages. Builtins are protected.
    pub fn delete_pipeline(&self, pipeline_id: &str) -> AppResult<()> {
        use crate::error::AppError;
        let is_builtin: bool = self
            .conn
            .query_row(
                "SELECT is_builtin FROM pipelines WHERE id = ?1",
                params![pipeline_id],
                |r| Ok(r.get::<_, i64>(0)? != 0),
            )
            .optional()?
            .ok_or_else(|| AppError::Other("pipeline not found".into()))?;
        if is_builtin {
            return Err(AppError::Other("builtin pipelines cannot be deleted".into()));
        }
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM pipeline_stages WHERE pipeline_id = ?1", params![pipeline_id])?;
        tx.execute("DELETE FROM pipelines WHERE id = ?1", params![pipeline_id])?;
        tx.commit()?;
        Ok(())
    }

    // ─── Runs ─────────────────────────────────────────────────────

    /// Create a run and copy the pipeline's stages into `run_stages` (a private copy
    /// so later edits to the template don't mutate run history).
    ///
    /// `stage_model_overrides` is a list of `(position, model)` pairs. Stages
    /// whose position matches an entry use the override model; all others keep
    /// the pipeline template's model. The template is never mutated.
    pub fn create_run(
        &self,
        workspace_id: &str,
        pipeline_id: &str,
        task: &str,
        reference_model: Option<&str>,
        linked_issue_key: Option<&str>,
        stage_model_overrides: &[(i64, String)],
    ) -> AppResult<String> {
        let stages = self.get_pipeline_stages(pipeline_id)?;
        if stages.is_empty() {
            return Err(crate::error::AppError::Other(format!(
                "pipeline '{pipeline_id}' not found or has no stages"
            )));
        }
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO runs (id, workspace_id, pipeline_id, task, status, reference_model, linked_issue_key, created_at)
             VALUES (?1,?2,?3,?4,'draft',?5,?6,?7)",
            params![id, workspace_id, pipeline_id, task, reference_model, linked_issue_key, now],
        )?;
        for s in &stages {
            let model = stage_model_overrides
                .iter()
                .find(|(pos, _)| *pos == s.position)
                .map(|(_, m)| m.as_str())
                .unwrap_or(s.agent_model.as_str());
            let sid = Uuid::new_v4().to_string();
            let parents_json = serde_json::to_string(&s.parents).ok();
            let tools_json = tools_to_json(&s.tools);
            self.conn.execute(
                "INSERT INTO run_stages
                    (id, run_id, position, role, agent_model, substrate, checkpoint, status,
                     loop_target_position, loop_max_iterations, loop_mode, max_iterations,
                     parents, tools, custom_name, instructions, effort,
                     escalate_model, escalate_effort)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
                params![sid, id, s.position, s.role, model, s.substrate, s.checkpoint as i64,
                        s.loop_target_position, s.loop_max_iterations, s.loop_mode,
                        s.max_iterations,
                        parents_json, tools_json, s.custom_name, s.instructions,
                        s.effort.as_ref().map(|e| e.as_str()),
                        s.escalate_model.as_deref(),
                        s.escalate_effort.as_ref().map(|e| e.as_str())],
            )?;
        }
        Ok(id)
    }

    pub fn get_run(&self, run_id: &str) -> AppResult<Option<RunRow>> {
        self.conn
            .query_row(
                "SELECT id, workspace_id, pipeline_id, task, status, cost_usd, baseline_usd,
                        reference_model, linked_issue_key, created_at, finished_at, budget_usd, detached
                 FROM runs WHERE id = ?1",
                params![run_id],
                row_to_run,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list_runs(&self, workspace_id: &str) -> AppResult<Vec<RunRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, pipeline_id, task, status, cost_usd, baseline_usd,
                    reference_model, linked_issue_key, created_at, finished_at, budget_usd, detached
             FROM runs WHERE workspace_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(params![workspace_id], row_to_run)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// All runs currently `running` or `paused`, across **all** workspaces
    /// (newest first). Drives the global "Runs in progress" tray — including
    /// background runs in workspaces the user hasn't opened this session.
    pub fn list_active_runs(&self) -> AppResult<Vec<RunRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, pipeline_id, task, status, cost_usd, baseline_usd,
                    reference_model, linked_issue_key, created_at, finished_at, budget_usd, detached
             FROM runs WHERE status IN ('running', 'paused') ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], row_to_run)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Count Direct runs that were *started* (i.e. left `draft`) since the start
    /// of the current month — the unit the free-tier Direct-runs meter shows and
    /// the quota gate counts. Mirrors the month-window convention in
    /// `period_spend` (ISO `created_at` vs `datetime('now','start of month')`).
    pub fn count_started_runs_this_month(&self) -> AppResult<u32> {
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM runs
             WHERE status != 'draft' AND created_at >= datetime('now', 'start of month')",
            [],
            |r| r.get(0),
        )?;
        Ok(n.max(0) as u32)
    }

    /// Stamp the durable "this install has started a Direct run" marker.
    /// Kept in `app_meta` because run ROWS cascade-delete with their
    /// workspace — a veteran who cleans up finished workspaces must never be
    /// re-invited by the first-run card. Idempotent.
    pub fn mark_ever_ran(&self) -> AppResult<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO app_meta (key, value) VALUES ('ever_ran_direct', '1')",
            [],
        )?;
        Ok(())
    }

    /// The "has this user ever run a crew?" signal behind the one-shot
    /// first-run invite: the durable marker, OR any surviving started run
    /// (backfill for installs that ran crews before the marker existed).
    /// Never resets — not monthly, and not via workspace-delete cascade.
    pub fn has_ever_started_run(&self) -> AppResult<bool> {
        if self.meta_get("ever_ran_direct")?.is_some() {
            return Ok(true);
        }
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM runs WHERE status != 'draft'",
            [],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    /// Count runs currently `running` or `paused` across **all** workspaces,
    /// excluding `run_id` (a run is never counted against itself). Drives the
    /// concurrency gate: Free may run only one at a time, Pro may run many.
    pub fn count_active_runs_excluding(&self, run_id: &str) -> AppResult<u32> {
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM runs
             WHERE status IN ('running', 'paused') AND id != ?1",
            [run_id],
            |r| r.get(0),
        )?;
        Ok(n.max(0) as u32)
    }

    /// Terminal runs (`completed`/`aborted`) across all workspaces, newest first,
    /// capped at `limit`. Drives the one-shot history backfill push on launch.
    pub fn list_terminal_runs(&self, limit: u32) -> AppResult<Vec<RunRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, pipeline_id, task, status, cost_usd, baseline_usd,
                    reference_model, linked_issue_key, created_at, finished_at, budget_usd, detached
             FROM runs WHERE status IN ('completed', 'aborted') ORDER BY created_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], row_to_run)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    // ── app_meta: tiny key/value store for app-global scalars ────────────────

    /// Read a scalar from `app_meta`; `None` if the key was never set.
    pub fn meta_get(&self, key: &str) -> AppResult<Option<String>> {
        self.conn
            .query_row("SELECT value FROM app_meta WHERE key = ?1", params![key], |r| r.get(0))
            .optional()
            .map_err(Into::into)
    }

    /// Upsert a scalar into `app_meta`.
    pub fn meta_set(&self, key: &str, value: &str) -> AppResult<()> {
        self.conn.execute(
            "INSERT INTO app_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Remove a meta key if present. No-op when absent. Used to re-arm a
    /// one-shot migration (e.g. tests simulating an upgrade from an older DB).
    pub fn meta_delete(&self, key: &str) -> AppResult<()> {
        self.conn.execute("DELETE FROM app_meta WHERE key = ?1", params![key])?;
        Ok(())
    }

    /// A stable, opaque per-install id (generated once, then persisted). Used to
    /// attribute a synced run to the machine it ran on ("from …").
    pub fn get_or_create_machine_id(&self) -> AppResult<String> {
        if let Some(id) = self.meta_get("machine_id")? {
            if !id.is_empty() {
                return Ok(id);
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.meta_set("machine_id", &id)?;
        Ok(id)
    }

    // ── synced_runs: read-only local mirror of cloud run history ─────────────

    /// Replace the entire local history mirror with a freshly pulled set (the
    /// cloud is the source of truth for cross-machine history). Atomic.
    pub fn replace_synced_runs(&self, runs: &[crate::sync::SyncRun]) -> AppResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM synced_runs", [])?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO synced_runs (run_id, data, created_at) VALUES (?1, ?2, ?3)",
            )?;
            for r in runs {
                let data = serde_json::to_string(r)?;
                stmt.execute(params![r.run_id, data, r.created_at])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Drop the entire local history mirror. Called on sign-out so a shared
    /// machine doesn't retain the previous user's cross-machine run history.
    pub fn clear_synced_runs(&self) -> AppResult<()> {
        self.conn.execute("DELETE FROM synced_runs", [])?;
        Ok(())
    }

    // ── Library sync (Pro): custom pipelines + roles follow the user ────────

    /// Every CUSTOM pipeline as a sync payload (builtins never travel).
    pub fn list_custom_pipelines_for_sync(&self) -> AppResult<Vec<crate::sync::SyncPipeline>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, description, COALESCE(updated_at, created_at)
             FROM pipelines WHERE is_builtin = 0",
        )?;
        let heads = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut out = Vec::with_capacity(heads.len());
        for (id, name, description, updated_at) in heads {
            out.push(crate::sync::SyncPipeline {
                stages: self.pipeline_stage_drafts(&id)?,
                id,
                name,
                description,
                updated_at,
            });
        }
        Ok(out)
    }

    /// A pipeline's stages re-expressed as the builder's [`StageDraft`] shape —
    /// the exact input `save_pipeline` consumes, so sync round-trips losslessly.
    pub fn pipeline_stage_drafts(&self, pipeline_id: &str) -> AppResult<Vec<StageDraft>> {
        let mut stmt = self.conn.prepare(
            "SELECT role, agent_model, substrate, checkpoint, loop_target_position,
                    loop_max_iterations, loop_mode, max_iterations, pos_x, pos_y,
                    parents, tools, custom_name, instructions, effort,
                    escalate_model, escalate_effort
             FROM pipeline_stages WHERE pipeline_id = ?1 ORDER BY position",
        )?;
        let rows = stmt.query_map(params![pipeline_id], |r| {
            let parents_json: Option<String> = r.get(10)?;
            let tools_json: Option<String> = r.get(11)?;
            Ok(StageDraft {
                role: r.get(0)?,
                agent_model: r.get(1)?,
                substrate: r.get(2)?,
                checkpoint: r.get::<_, i64>(3)? != 0,
                loop_target_position: r.get(4)?,
                loop_max_iterations: r.get(5)?,
                loop_mode: r.get(6)?,
                max_iterations: r.get(7)?,
                pos_x: r.get(8)?,
                pos_y: r.get(9)?,
                parents: parents_json
                    .and_then(|j| serde_json::from_str(&j).ok())
                    .unwrap_or_default(),
                tools: tools_json.and_then(|j| serde_json::from_str(&j).ok()),
                custom_name: r.get(12)?,
                instructions: r.get(13)?,
                effort: r.get::<_, Option<String>>(14)?.as_deref().and_then(crate::providers::Effort::from_str),
                escalate_model: r.get(15)?,
                escalate_effort: r.get::<_, Option<String>>(16)?.as_deref().and_then(crate::providers::Effort::from_str),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// A pipeline's local LWW state: (updated_at, is_builtin). `None` = absent.
    pub fn pipeline_sync_state(&self, id: &str) -> AppResult<Option<(String, bool)>> {
        self.conn
            .query_row(
                "SELECT COALESCE(updated_at, created_at), is_builtin FROM pipelines WHERE id = ?1",
                params![id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0)),
            )
            .optional()
            .map_err(Into::into)
    }

    /// A role's local LWW state: (updated_at, is_builtin). `None` = absent.
    pub fn role_sync_state(&self, key: &str) -> AppResult<Option<(String, bool)>> {
        self.conn
            .query_row(
                "SELECT COALESCE(updated_at, created_at), is_builtin FROM roles WHERE key = ?1",
                params![key],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0)),
            )
            .optional()
            .map_err(Into::into)
    }

    /// Apply a pulled pipeline (per-item LWW). Returns true when applied.
    /// Never touches a builtin id; never regresses a NEWER local edit; the
    /// pulled stages go through the same validator as the builder's saves
    /// (an unparseable/invalid item is skipped by the caller, not written).
    pub fn upsert_pipeline_from_sync(&self, sp: &crate::sync::SyncPipeline) -> AppResult<bool> {
        match self.pipeline_sync_state(&sp.id)? {
            Some((_, true)) => return Ok(false), // builtin ids never sync
            Some((local, _)) if local.as_str() >= sp.updated_at.as_str() => return Ok(false),
            _ => {}
        }
        self.validate_pipeline_stages(&sp.stages)?;
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO pipelines (id, name, description, is_builtin, created_at, updated_at)
             VALUES (?1, ?2, ?3, 0, ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET name = ?2, description = ?3, updated_at = ?4
             WHERE pipelines.is_builtin = 0",
            params![sp.id, sp.name, sp.description, sp.updated_at],
        )?;
        tx.execute("DELETE FROM pipeline_stages WHERE pipeline_id = ?1", params![sp.id])?;
        for (i, st) in sp.stages.iter().enumerate() {
            let parents_json = serde_json::to_string(&st.parents).ok();
            let tools_json = st.tools.as_ref().and_then(|t| serde_json::to_string(t).ok());
            tx.execute(
                "INSERT INTO pipeline_stages
                    (id, pipeline_id, position, role, agent_model, substrate, checkpoint,
                     loop_target_position, loop_max_iterations, loop_mode, max_iterations,
                     pos_x, pos_y, parents, tools, custom_name, instructions, effort,
                     escalate_model, escalate_effort)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
                params![Uuid::new_v4().to_string(), sp.id, i as i64, st.role, st.agent_model,
                        st.substrate, st.checkpoint as i64,
                        st.loop_target_position, st.loop_max_iterations, st.loop_mode,
                        st.max_iterations, st.pos_x, st.pos_y, parents_json, tools_json,
                        st.custom_name, st.instructions,
                        st.effort.as_ref().map(|e| e.as_str()),
                        // Normalize empty → NULL (mirrors `save_pipeline`), so a
                        // synced `escalate_model = ""` isn't treated as a real
                        // policy that escalates to an empty model id.
                        st.escalate_model.as_deref().map(str::trim).filter(|t| !t.is_empty()),
                        st.escalate_effort.as_ref().map(|e| e.as_str())],
            )?;
        }
        tx.commit()?;
        Ok(true)
    }

    /// Every CUSTOM role with its LWW timestamp (builtins never travel).
    pub fn list_custom_roles_for_sync(
        &self,
    ) -> AppResult<Vec<(crate::orchestrator::roles::RoleDef, String)>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {}, COALESCE(updated_at, created_at) FROM roles WHERE is_builtin = 0",
            Self::ROLE_COLS
        ))?;
        let rows = stmt.query_map([], |r| {
            let role = Self::row_to_role(r)?;
            let updated_at: String = r.get(13)?;
            Ok((role, updated_at))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Bump a CUSTOM role's LWW stamp to now — the local "I'm keeping this"
    /// decision when a pulled tombstone is refused because the role is still
    /// in use here. The bumped stamp beats the tombstone on the next push, so
    /// the keep actually propagates (revives the item cloud-side).
    pub fn touch_role(&self, key: &str) -> AppResult<bool> {
        self.conn.execute(
            "UPDATE roles SET updated_at = ?2 WHERE key = ?1 AND is_builtin = 0",
            params![key, Utc::now().to_rfc3339()],
        )?;
        Ok(self.conn.changes() > 0)
    }

    /// Apply a pulled role (per-item LWW). Returns true when applied. Never
    /// touches a builtin key; never regresses a NEWER local edit.
    pub fn upsert_role_from_sync(
        &self,
        role: &crate::orchestrator::roles::RoleDef,
        updated_at: &str,
    ) -> AppResult<bool> {
        match self.role_sync_state(&role.key)? {
            Some((_, true)) => return Ok(false), // builtin keys never sync
            Some((local, _)) if local.as_str() >= updated_at => return Ok(false),
            _ => {}
        }
        self.conn.execute(
            "INSERT INTO roles (key,label,description,prompt_body,artifact_kind,environment,can_loop,default_tools,default_substrate,default_checkpoint,token_est_in,token_est_out,is_builtin,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,0,?13,?13)
             ON CONFLICT(key) DO UPDATE SET label=?2,description=?3,prompt_body=?4,artifact_kind=?5,environment=?6,can_loop=?7,default_tools=?8,default_substrate=?9,default_checkpoint=?10,token_est_in=?11,token_est_out=?12,updated_at=?13
             WHERE roles.is_builtin=0",
            params![role.key, role.label, role.description, role.prompt_body,
                    role.artifact_kind.as_db(), role.environment.as_db(), role.can_loop as i64,
                    serde_json::to_string(&role.default_tools)?, role.default_substrate,
                    role.default_checkpoint as i64, role.token_est_in, role.token_est_out,
                    updated_at],
        )?;
        Ok(self.conn.changes() > 0)
    }

    /// The local history mirror, newest first. Skips any blob this build can't
    /// parse (forward/back compat) rather than failing the whole read.
    pub fn list_synced_runs(&self) -> AppResult<Vec<crate::sync::SyncRun>> {
        let mut stmt =
            self.conn.prepare("SELECT data FROM synced_runs ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            if let Ok(run) = serde_json::from_str::<crate::sync::SyncRun>(&row?) {
                out.push(run);
            }
        }
        Ok(out)
    }

    pub fn list_run_stages(&self, run_id: &str) -> AppResult<Vec<RunStageRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, run_id, position, role, agent_model, substrate, checkpoint, status,
                    input_tokens, output_tokens, cost_usd, artifact, feedback, error, started_at, finished_at,
                    loop_target_position, loop_max_iterations, loop_mode, loop_iterations, diff_snapshot,
                    max_iterations, parents, tools, custom_name, instructions,
                    session_id, resume_pending, baseline_commit, effort, blocked_questions,
                    escalate_model, escalate_effort, escalated
             FROM run_stages WHERE run_id = ?1 ORDER BY position",
        )?;
        let rows = stmt.query_map(params![run_id], |r| {
            Ok(RunStageRow {
                id: r.get(0)?,
                run_id: r.get(1)?,
                position: r.get(2)?,
                role: r.get(3)?,
                agent_model: r.get(4)?,
                effort: r.get::<_, Option<String>>(29)?.as_deref().and_then(crate::providers::Effort::from_str),
                escalate_model: r.get(31)?,
                escalate_effort: r.get::<_, Option<String>>(32)?.as_deref().and_then(crate::providers::Effort::from_str),
                escalated: r.get::<_, i64>(33)? != 0,
                substrate: r.get(5)?,
                checkpoint: r.get::<_, i64>(6)? != 0,
                status: r.get(7)?,
                input_tokens: r.get(8)?,
                output_tokens: r.get(9)?,
                cost_usd: r.get(10)?,
                artifact: r.get(11)?,
                feedback: r.get(12)?,
                error: r.get(13)?,
                started_at: r.get(14)?,
                finished_at: r.get(15)?,
                loop_target_position: r.get(16)?,
                loop_max_iterations: r.get(17)?,
                loop_mode: r.get(18)?,
                loop_iterations: r.get(19)?,
                diff_snapshot: r.get(20)?,
                max_iterations: r.get(21)?,
                parents: parse_parents(r.get(22)?),
                tools: parse_tools(r.get(23)?),
                custom_name: r.get(24)?,
                instructions: r.get(25)?,
                session_id: r.get(26)?,
                resume_pending: r.get::<_, i64>(27)? != 0,
                baseline_commit: r.get(28)?,
                blocked_questions: r.get(30)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn set_run_status(&self, run_id: &str, status: &str, finished: bool) -> AppResult<()> {
        if finished {
            let now = Utc::now().to_rfc3339();
            self.conn.execute(
                "UPDATE runs SET status = ?2, finished_at = ?3 WHERE id = ?1",
                params![run_id, status, now],
            )?;
        } else {
            self.conn.execute(
                "UPDATE runs SET status = ?2 WHERE id = ?1",
                params![run_id, status],
            )?;
        }
        Ok(())
    }

    pub fn set_run_cost(&self, run_id: &str, cost_usd: f64, baseline_usd: f64) -> AppResult<()> {
        self.conn.execute(
            "UPDATE runs SET cost_usd = ?2, baseline_usd = ?3 WHERE id = ?1",
            params![run_id, cost_usd, baseline_usd],
        )?;
        Ok(())
    }

    /// Clear a run's terminal status so `prepare_rerun` can resume a
    /// `completed` run past `drive_inner`'s early-return check. `paused` /
    /// `running` runs are unaffected in practice (they already read as
    /// resumable), this just makes `completed` resumable too.
    pub fn reopen_run(&self, run_id: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE runs SET status = 'running', finished_at = NULL WHERE id = ?1",
            params![run_id],
        )?;
        Ok(())
    }

    /// Set (or clear, with `None`) the run's optional spend cap.
    pub fn set_run_budget(&self, run_id: &str, budget_usd: Option<f64>) -> AppResult<()> {
        self.conn.execute(
            "UPDATE runs SET budget_usd = ?2 WHERE id = ?1",
            params![run_id, budget_usd],
        )?;
        Ok(())
    }

    pub fn set_run_reference_model(&self, run_id: &str, model: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE runs SET reference_model = ?2 WHERE id = ?1",
            params![run_id, model],
        )?;
        Ok(())
    }

    /// Error message stamped on stages found stuck in `running` at startup.
    /// `isTransientHalt` on the frontend keys off the leading "interrupted"
    /// to offer the amber Resume affordance instead of the rouge hard-failure.
    pub const INTERRUPTED_STAGE_ERROR: &'static str =
        "interrupted — Octopush closed while this stage was in flight; the work on disk is preserved, resume the stage to continue";

    /// Startup recovery: no stage can legitimately be `running` when the app
    /// boots, so any such row is an orphan from a previous process (crash,
    /// force-quit, update). Without this, the run sits "paused" with a stage
    /// stuck on "running" — a state the checkpoint UI has NO affordance for,
    /// stranding the pipeline forever. Orphans land in the normal
    /// halt-recovery flow (failed + paused → Resume).
    ///
    /// A process can also die BETWEEN stages (run `running`, no stage
    /// `running`). Each such run is settled by what its stages say: every
    /// stage done → the run actually finished, mark it `completed`; otherwise
    /// stamp the first unfinished stage as interrupted so the paused run
    /// always has a blocked stage the checkpoint UI can act on — a paused run
    /// with NO blocked stage has no affordance at all and permanently blocks
    /// its workspace. Returns the count of stages stamped.
    /// **Detached-run exception:** a run whose worker lease has a FRESH
    /// heartbeat is not an orphan — an `octopush-run-worker` is driving it
    /// right now in another process, and "repairing" it would mark a live
    /// stage failed and fight the worker's own writes. Those runs are
    /// skipped here; the bridge reconciler repairs them if the worker dies.
    pub fn recover_interrupted_runs(&self) -> AppResult<usize> {
        // Candidates: any run that says `running`, plus any run owning a
        // `running` stage (belt and braces — the two should agree).
        let run_ids: Vec<String> = {
            let mut stmt = self.conn.prepare(
                "SELECT id FROM runs WHERE status = 'running'
                 UNION SELECT DISTINCT run_id FROM run_stages WHERE status = 'running'",
            )?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut n = 0;
        for run_id in run_ids {
            // STARTUP uses heartbeat-only freshness, NOT the pid-aware
            // `worker_lease_fresh`: a persisted `worker_pid` may belong to a
            // PREVIOUS boot and now map to an unrelated live process (`kill
            // pid,0` would falsely say "alive" forever, pinning a dead run as
            // running). A genuinely-alive worker from a prior app session
            // keeps heartbeating every ~1s regardless of the app, so it reads
            // fresh here anyway; a truly dead worker (crash, reboot) has a
            // stale heartbeat and must be repaired.
            //
            // The one cost: an app relaunch within ~1s of a machine WAKE —
            // before the just-resumed worker re-beats — can wrongly repair a
            // still-live run. That is transient and self-healing (the worker's
            // nonce-guarded next beat fails, so it stops into the very same
            // Resume shape), a strictly better failure than a permanent pin.
            // The in-session bridge reconciler keeps the pid signal for the
            // sleep-wake race; only cross-boot startup drops it.
            if self.worker_heartbeat_fresh(&run_id)? {
                continue; // a live detached worker owns this run
            }
            n += self.repair_interrupted_run(&run_id)?;
        }
        Ok(n)
    }

    /// Repair ONE orphaned run whose owning process is gone: its `running`
    /// stages are stamped failed (interrupted), the run status is settled by
    /// what its stages say (all done → completed; else paused with a blocked
    /// stage the checkpoint UI can act on), and any stale worker lease is
    /// cleared. Returns the number of stages stamped.
    pub fn repair_interrupted_run(&self, run_id: &str) -> AppResult<usize> {
        let now = Utc::now().to_rfc3339();
        let mut n = self.conn.execute(
            "UPDATE run_stages SET status = 'failed', error = ?1, finished_at = ?2
             WHERE run_id = ?3 AND status = 'running'",
            params![Self::INTERRUPTED_STAGE_ERROR, now, run_id],
        )?;
        // A stale lease and its request flags are meaningless once repaired.
        self.conn.execute(
            "UPDATE runs SET worker_pid = NULL, worker_nonce = NULL, heartbeat_at = NULL,
                    stop_requested = 0, pause_requested = 0 WHERE id = ?1",
            params![run_id],
        )?;
        let status: Option<String> = self
            .conn
            .query_row("SELECT status FROM runs WHERE id = ?1", params![run_id], |r| r.get(0))
            .optional()?;
        // Only a run stuck on `running` needs its status settled; a paused run
        // with a freshly-failed stage is already the normal recovery shape.
        if status.as_deref() == Some("running") {
            let stages = self.list_run_stages(run_id)?;
            if !stages.is_empty() && stages.iter().all(|s| s.status == "done") {
                // Died after the last stage finished but before the run was
                // stamped — it IS complete.
                self.set_run_status(run_id, "completed", true)?;
                return Ok(n);
            }
            let blocked = stages
                .iter()
                .any(|s| s.status == "failed" || s.status == "awaiting_checkpoint");
            if !blocked {
                if let Some(next) = stages.iter().find(|s| s.status != "done") {
                    self.fail_run_stage(&next.id, Self::INTERRUPTED_STAGE_ERROR)?;
                    n += 1;
                }
            }
            self.set_run_status(run_id, "paused", false)?;
        }
        Ok(n)
    }

    // ── Detached-run worker leases (segment workers) ─────────────────────────
    //
    // A detached run is driven one segment at a time by an out-of-process
    // `octopush-run-worker`. The lease is the cross-process claim: the app
    // RESERVES it (nonce + heartbeat) before spawning, the worker CONFIRMS it
    // (nonce-guarded, records its pid), BEATS it while driving, and CLEARS it
    // on exit. Heartbeat freshness is the only liveness signal recovery
    // trusts — PIDs get reused, nonces don't.

    /// Seconds a lease heartbeat stays *fresh*. Workers beat every ~1s, so a
    /// lease older than this belongs to a dead worker (crash, SIGKILL, power
    /// loss) and its run is safe to repair. Startup recovery and the bridge
    /// reconciler share this one rule.
    pub const WORKER_LEASE_FRESH_SECS: i64 = 45;

    fn lease_stale_before() -> String {
        (Utc::now() - chrono::Duration::seconds(Self::WORKER_LEASE_FRESH_SECS)).to_rfc3339()
    }

    /// App side, before spawning a worker: claim the run for `nonce`. Refuses
    /// (returns `false`) while another LIVE lease exists — the double-spawn
    /// guard. "Live" is the pid-aware `worker_lease_fresh`, not the SQL
    /// staleness alone: a worker mid-`claude` whose heartbeat lapsed during a
    /// system sleep is still alive (its pid answers), and superseding it would
    /// briefly double-drive one worktree until it noticed the nonce change.
    /// The pre-check and the UPDATE are atomic within the app process (single
    /// `Mutex<Db>`; workers never reserve). On success it stamps `detached`
    /// and resets the request flags so a new segment never inherits a stale
    /// stop/pause.
    pub fn reserve_worker_lease(&self, run_id: &str, nonce: &str) -> AppResult<bool> {
        if self.worker_lease_fresh(run_id)? {
            return Ok(false);
        }
        let n = self.conn.execute(
            "UPDATE runs SET worker_nonce = ?2, worker_pid = NULL, heartbeat_at = ?3,
                    stop_requested = 0, pause_requested = 0, detached = 1
             WHERE id = ?1 AND (worker_nonce IS NULL OR heartbeat_at IS NULL OR heartbeat_at < ?4)",
            params![run_id, nonce, Utc::now().to_rfc3339(), Self::lease_stale_before()],
        )?;
        Ok(n > 0)
    }

    /// Worker start: prove the claim and record the worker's pid. Zero rows
    /// affected ⇒ this nonce was superseded (another reserve replaced it) ⇒
    /// the worker must exit without touching the run.
    pub fn confirm_worker_lease(&self, run_id: &str, nonce: &str, pid: i64) -> AppResult<bool> {
        let n = self.conn.execute(
            "UPDATE runs SET worker_pid = ?3, heartbeat_at = ?4
             WHERE id = ?1 AND worker_nonce = ?2",
            params![run_id, nonce, pid, Utc::now().to_rfc3339()],
        )?;
        Ok(n > 0)
    }

    /// Worker heartbeat. Nonce-guarded so a superseded worker's beats can't
    /// resurrect a lease it no longer owns; `false` tells the worker it lost
    /// the claim and must stop driving.
    pub fn beat_worker_lease(&self, run_id: &str, nonce: &str) -> AppResult<bool> {
        let n = self.conn.execute(
            "UPDATE runs SET heartbeat_at = ?3 WHERE id = ?1 AND worker_nonce = ?2",
            params![run_id, nonce, Utc::now().to_rfc3339()],
        )?;
        Ok(n > 0)
    }

    /// Worker exit (or app-side spawn failure): release the claim. Nonce-guarded —
    /// a successor's fresh lease is never cleared by a straggler.
    pub fn clear_worker_lease(&self, run_id: &str, nonce: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE runs SET worker_pid = NULL, worker_nonce = NULL, heartbeat_at = NULL,
                    stop_requested = 0, pause_requested = 0
             WHERE id = ?1 AND worker_nonce = ?2",
            params![run_id, nonce],
        )?;
        Ok(())
    }

    /// Heartbeat-ONLY freshness (no pid trust): nonce present AND heartbeat
    /// within the window. Used by STARTUP recovery, where a persisted pid may
    /// belong to a previous boot — see `recover_interrupted_runs`.
    pub fn worker_heartbeat_fresh(&self, run_id: &str) -> AppResult<bool> {
        let row: Option<(Option<String>, Option<String>)> = self
            .conn
            .query_row(
                "SELECT worker_nonce, heartbeat_at FROM runs WHERE id = ?1",
                params![run_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(matches!(row, Some((Some(_), Some(hb))) if hb >= Self::lease_stale_before()))
    }

    /// `true` while a worker lease is LIVE: nonce present AND (heartbeat
    /// fresh OR the owner pid still alive). The pid check exists for the
    /// sleep race — after a long system sleep every heartbeat is stale the
    /// instant the machine wakes, and repairing a healthy overnight crew on
    /// that evidence would defeat the whole feature. A reused pid can delay a
    /// repair (the run stays "running"; abort remains available), but it
    /// self-heals when that process exits — the safer failure by far.
    pub fn worker_lease_fresh(&self, run_id: &str) -> AppResult<bool> {
        let row: Option<(Option<String>, Option<String>, Option<i64>)> = self
            .conn
            .query_row(
                "SELECT worker_nonce, heartbeat_at, worker_pid FROM runs WHERE id = ?1",
                params![run_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        Ok(match row {
            Some((Some(_), hb, pid)) => {
                matches!(&hb, Some(hb) if *hb >= Self::lease_stale_before())
                    || lease_owner_alive(pid)
            }
            _ => false,
        })
    }

    /// Every run currently carrying a worker lease (fresh or stale) — the
    /// bridge's watch list.
    pub fn list_leased_run_ids(&self) -> AppResult<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM runs WHERE worker_nonce IS NOT NULL")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Repair every DEAD-leased run (its worker died mid-segment) and return
    /// the repaired ids so the bridge can emit their updated state. A lease
    /// is dead only when the heartbeat is stale AND the owner pid is gone —
    /// see `worker_lease_fresh` for why both signals are required.
    pub fn reconcile_stale_leases(&self) -> AppResult<Vec<String>> {
        let candidates: Vec<(String, Option<i64>)> = {
            let mut stmt = self.conn.prepare(
                "SELECT id, worker_pid FROM runs WHERE worker_nonce IS NOT NULL
                 AND (heartbeat_at IS NULL OR heartbeat_at < ?1)",
            )?;
            let rows = stmt.query_map(params![Self::lease_stale_before()], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut repaired = Vec::new();
        for (id, pid) in candidates {
            if lease_owner_alive(pid) {
                continue; // stale heartbeat but the worker breathes (sleep wake)
            }
            self.repair_interrupted_run(&id)?;
            repaired.push(id);
        }
        Ok(repaired)
    }

    /// Mark whether the run's CURRENT segment is worker-driven. Set by
    /// `reserve_worker_lease`; cleared by the in-process drive, so the UI's
    /// "survives quitting" indicator never lies after a fallback.
    pub fn set_run_detached(&self, run_id: &str, on: bool) -> AppResult<()> {
        self.conn.execute(
            "UPDATE runs SET detached = ?2 WHERE id = ?1",
            params![run_id, on as i64],
        )?;
        Ok(())
    }

    /// Cross-process "stop the in-flight stage" request (the DB replacement
    /// for the orchestrator's in-memory cancel flag). The worker polls it.
    pub fn set_stop_requested(&self, run_id: &str, on: bool) -> AppResult<()> {
        self.conn.execute(
            "UPDATE runs SET stop_requested = ?2 WHERE id = ?1",
            params![run_id, on as i64],
        )?;
        Ok(())
    }

    /// Cross-process "pause at the next stage boundary" request (the DB
    /// replacement for the in-memory pause set). The worker polls it.
    pub fn set_pause_requested(&self, run_id: &str, on: bool) -> AppResult<()> {
        self.conn.execute(
            "UPDATE runs SET pause_requested = ?2 WHERE id = ?1",
            params![run_id, on as i64],
        )?;
        Ok(())
    }

    /// One worker control poll: `(status, stop_requested, pause_requested)`.
    /// `None` = the run vanished (workspace deleted under the worker).
    pub fn read_worker_controls(&self, run_id: &str) -> AppResult<Option<(String, bool, bool)>> {
        self.conn
            .query_row(
                "SELECT status, stop_requested, pause_requested FROM runs WHERE id = ?1",
                params![run_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)? != 0,
                        r.get::<_, i64>(2)? != 0,
                    ))
                },
            )
            .optional()
            .map_err(Into::into)
    }

    // ── Routines (scheduled crews) ───────────────────────────────────────────

    /// Insert a routine. `next_due_at` is computed by the caller (from the
    /// schedule + the clock) so `Db` stays clock-free.
    pub fn insert_routine(
        &self,
        id: &str,
        input: &RoutineInput,
        next_due_at: Option<&str>,
        enabled: bool,
    ) -> AppResult<()> {
        // Trim the optional fire condition, empty → NULL (always fire).
        let fire_condition = normalize_optional(input.fire_condition.as_deref());
        // `enabled` is written in the SAME insert (not a create-then-toggle) so a
        // caller wanting a DISABLED routine can never be left with an enabled one
        // by a failed second statement (e.g. SQLITE_BUSY on the shared WAL).
        self.conn.execute(
            "INSERT INTO routines
                (id, name, project_id, pipeline_id, task, reference_model, stage_overrides,
                 budget_usd, schedule_kind, schedule_spec, workspace_mode, fixed_workspace_id,
                 base_branch, branch_prefix, fire_condition, enabled, next_due_at, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
            params![
                id, input.name, input.project_id, input.pipeline_id, input.task,
                input.reference_model, input.stage_overrides, input.budget_usd,
                input.schedule_kind, input.schedule_spec, input.workspace_mode,
                input.fixed_workspace_id, input.base_branch, input.branch_prefix,
                fire_condition, enabled as i64, next_due_at, Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    /// Update a routine's mutable fields + recompute its `next_due_at`. Leaves
    /// `enabled`, `last_fired_at`, and `last_run_id` untouched.
    pub fn update_routine(
        &self,
        id: &str,
        input: &RoutineInput,
        next_due_at: Option<&str>,
    ) -> AppResult<()> {
        let fire_condition = normalize_optional(input.fire_condition.as_deref());
        self.conn.execute(
            "UPDATE routines SET
                name = ?2, project_id = ?3, pipeline_id = ?4, task = ?5, reference_model = ?6,
                stage_overrides = ?7, budget_usd = ?8, schedule_kind = ?9, schedule_spec = ?10,
                workspace_mode = ?11, fixed_workspace_id = ?12, base_branch = ?13,
                branch_prefix = ?14, fire_condition = ?15, next_due_at = ?16
             WHERE id = ?1",
            params![
                id, input.name, input.project_id, input.pipeline_id, input.task,
                input.reference_model, input.stage_overrides, input.budget_usd,
                input.schedule_kind, input.schedule_spec, input.workspace_mode,
                input.fixed_workspace_id, input.base_branch, input.branch_prefix,
                fire_condition, next_due_at,
            ],
        )?;
        Ok(())
    }

    pub fn delete_routine(&self, id: &str) -> AppResult<()> {
        self.conn.execute("DELETE FROM routines WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Enable/disable a routine. Enabling re-seats `next_due_at` (the schedule
    /// resumes from now); disabling leaves the row but the scheduler skips it.
    pub fn set_routine_enabled(
        &self,
        id: &str,
        enabled: bool,
        next_due_at: Option<&str>,
    ) -> AppResult<()> {
        self.conn.execute(
            "UPDATE routines SET enabled = ?2, next_due_at = ?3 WHERE id = ?1",
            params![id, enabled as i64, next_due_at],
        )?;
        Ok(())
    }

    pub fn list_routines(&self) -> AppResult<Vec<RoutineRow>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {ROUTINE_COLS} FROM routines ORDER BY created_at DESC"
        ))?;
        let rows = stmt.query_map([], row_to_routine)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn get_routine(&self, id: &str) -> AppResult<Option<RoutineRow>> {
        self.conn
            .query_row(
                &format!("SELECT {ROUTINE_COLS} FROM routines WHERE id = ?1"),
                params![id],
                row_to_routine,
            )
            .optional()
            .map_err(Into::into)
    }

    /// Enabled routines whose next fire is due (`next_due_at <= now`). `now`
    /// is a UTC RFC3339 string; all `next_due_at` are stored UTC so the string
    /// comparison is a valid time comparison.
    pub fn list_due_routines(&self, now_utc_rfc3339: &str) -> AppResult<Vec<RoutineRow>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {ROUTINE_COLS} FROM routines
             WHERE enabled = 1 AND next_due_at IS NOT NULL AND next_due_at <= ?1
             ORDER BY next_due_at"
        ))?;
        let rows = stmt.query_map(params![now_utc_rfc3339], row_to_routine)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Record a fire: stamp `last_fired_at`/`last_run_id` and advance
    /// `next_due_at` in ONE write, so a crash between them can't double-fire.
    pub fn mark_routine_fired(
        &self,
        id: &str,
        run_id: &str,
        fired_at: &str,
        next_due_at: Option<&str>,
    ) -> AppResult<()> {
        self.conn.execute(
            "UPDATE routines SET last_fired_at = ?2, last_run_id = ?3, next_due_at = ?4 WHERE id = ?1",
            params![id, fired_at, run_id, next_due_at],
        )?;
        Ok(())
    }

    /// Advance `next_due_at` WITHOUT recording a fire — used when a due window
    /// is skipped (workspace busy / previous fresh run still active) OR up
    /// front on every fire (so a crash mid-fire can't re-fire the window).
    pub fn set_routine_next_due(&self, id: &str, next_due_at: Option<&str>) -> AppResult<()> {
        self.conn.execute(
            "UPDATE routines SET next_due_at = ?2 WHERE id = ?1",
            params![id, next_due_at],
        )?;
        Ok(())
    }

    /// Stamp a fire's run onto the routine (`last_fired_at`/`last_run_id`) —
    /// paired with `set_routine_next_due`, which the scheduler calls first.
    pub fn stamp_routine_run(&self, id: &str, run_id: &str, fired_at: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE routines SET last_fired_at = ?2, last_run_id = ?3 WHERE id = ?1",
            params![id, fired_at, run_id],
        )?;
        Ok(())
    }

    /// Record the outcome of a fire evaluation (dispatched, or a skip reason)
    /// on EVERY tick — `last_checked_at`/`last_outcome`. Independent of
    /// `stamp_routine_run` (which records the dispatched run itself); this keeps
    /// a routine that keeps skipping legible ("checked 2m ago · condition not
    /// met") instead of looking dead.
    pub fn set_routine_fire_result(&self, id: &str, checked_at: &str, outcome: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE routines SET last_checked_at = ?2, last_outcome = ?3 WHERE id = ?1",
            params![id, checked_at, outcome],
        )?;
        Ok(())
    }

    /// Delete a run and its stages (FK cascade). Used to clean up a routine's
    /// draft run that was refused at launch and never started — leaving it
    /// `aborted` would wrongly count it in the monthly meter (`status !=
    /// 'draft'`) and surface it as a settled card. Only ever called on a
    /// never-started draft.
    pub fn delete_run(&self, run_id: &str) -> AppResult<()> {
        self.conn.execute("DELETE FROM runs WHERE id = ?1", params![run_id])?;
        Ok(())
    }

    /// `true` if the workspace has a `running`/`paused` run — the fixed-mode
    /// overlap guard (a fresh fire would be refused by `has_concurrent_run`).
    pub fn workspace_has_active_run(&self, workspace_id: &str) -> AppResult<bool> {
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM runs WHERE workspace_id = ?1 AND status IN ('running','paused')",
            params![workspace_id],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    /// Persist (or clear, with `None`) a parked stage's `ask_director`
    /// questions — the JSON `BlockedAsk` the answer form reads. Set when a stage
    /// blocks; cleared when the director answers (or, defensively, on any reset).
    pub fn set_run_stage_blocked(&self, stage_id: &str, questions_json: Option<&str>) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET blocked_questions = ?2 WHERE id = ?1",
            params![stage_id, questions_json],
        )?;
        Ok(())
    }

    /// Mark a run-stage as having escalated (sticky). Set true the first time
    /// the stage retries at its escalation tier; never cleared for the rest of
    /// the run, so any later re-run (loop-back / reject) keeps the strong tier.
    pub fn set_run_stage_escalated(&self, stage_id: &str, escalated: bool) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET escalated = ?2 WHERE id = ?1",
            params![stage_id, escalated as i64],
        )?;
        Ok(())
    }

    pub fn set_run_stage_status(&self, stage_id: &str, status: &str) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        // Stamp started_at the first time it goes running.
        self.conn.execute(
            "UPDATE run_stages SET status = ?2,
                started_at = COALESCE(started_at, CASE WHEN ?2 = 'running' THEN ?3 ELSE started_at END)
             WHERE id = ?1",
            params![stage_id, status, now],
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn complete_run_stage(
        &self,
        stage_id: &str,
        status: &str,
        input_tokens: i64,
        output_tokens: i64,
        cost_usd: f64,
        artifact_json: Option<&str>,
    ) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE run_stages
             SET status = ?2, input_tokens = ?3, output_tokens = ?4, cost_usd = ?5,
                 artifact = ?6, finished_at = ?7
             WHERE id = ?1",
            params![stage_id, status, input_tokens, output_tokens, cost_usd, artifact_json, now],
        )?;
        Ok(())
    }

    pub fn fail_run_stage(&self, stage_id: &str, error: &str) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE run_stages SET status = 'failed', error = ?2, finished_at = ?3 WHERE id = ?1",
            params![stage_id, error, now],
        )?;
        Ok(())
    }

    /// Reset a stage to pending (for re-run), optionally overriding its model and
    /// recording reviewer feedback. Clears the prior artifact/error/finish time,
    /// and any `blocked_questions` — a re-run never carries a stale escape-valve
    /// block, whatever path (reject / answer / loop-back / re-run) triggered it.
    /// NOTE: `session_id`, `resume_pending`, and `baseline_commit` are intentionally
    /// preserved — the UPDATE below does not list them. `resume_pending` is cleared
    /// separately by the Resume action handler after it sets it, and `session_id` /
    /// `baseline_commit` carry forward for the next run's `--resume` / Discard path.
    pub fn reset_run_stage(
        &self,
        stage_id: &str,
        model_override: Option<&str>,
        feedback: Option<&str>,
    ) -> AppResult<()> {
        if let Some(model) = model_override {
            // A manual model override is the director's explicit choice — clear
            // the sticky escalation flag so the re-run honors THIS model instead
            // of `run_stage_once` forcing the escalate tier. The auto loop-back
            // and escalation reset paths pass `None` here, so they stay sticky
            // (a post-escalation loop-back keeps the strong tier by design).
            self.conn.execute(
                "UPDATE run_stages SET agent_model = ?2, escalated = 0 WHERE id = ?1",
                params![stage_id, model],
            )?;
        }
        self.conn.execute(
            "UPDATE run_stages
             SET status = 'pending', artifact = NULL, error = NULL,
                 started_at = NULL, finished_at = NULL, diff_snapshot = NULL,
                 blocked_questions = NULL,
                 input_tokens = 0, output_tokens = 0, cost_usd = 0, feedback = ?2
             WHERE id = ?1",
            params![stage_id, feedback],
        )?;
        Ok(())
    }

    /// Bump the loop-back counter on a review stage that triggered a loop.
    pub fn increment_loop_iteration(&self, stage_id: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET loop_iterations = loop_iterations + 1 WHERE id = ?1",
            params![stage_id],
        )?;
        Ok(())
    }

    /// Zero a stage's loop-back counter. `reset_run_stage` deliberately
    /// preserves `loop_iterations` (the ordinary loop-back path relies on
    /// that to keep counting toward the cap) — `prepare_rerun` needs the
    /// opposite when it rewinds a looping review stage, so it calls this
    /// explicitly instead of `reset_run_stage`.
    pub fn set_stage_loop_iterations(&self, stage_id: &str, iterations: i64) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET loop_iterations = ?2 WHERE id = ?1",
            params![stage_id, iterations],
        )?;
        Ok(())
    }

    /// Hot-edit a **pending, not-yet-started** run-stage row in place — the
    /// validated write path behind the director's live gate-toggle / "Edit
    /// stage" controls. Only ever touches `run_stages`; the pipeline template
    /// is never written, so every other run created from that template is
    /// unaffected. `None` for any field leaves it unchanged.
    ///
    /// The guard read + the UPDATE run inside one `Db` call, and callers only
    /// ever reach `Db` through `Arc<Mutex<Db>>` — so this can't race the
    /// orchestrator's own fresh `list_run_stages` read / `StageSpec` build
    /// right before a stage starts (`orchestrator::run_stage_once`): an edit
    /// either lands while the stage is still `pending` (and is honored when
    /// the orchestrator reaches it) or is atomically rejected the moment the
    /// stage has moved past `pending`.
    #[allow(clippy::too_many_arguments)]
    pub fn update_run_stage(
        &self,
        run_id: &str,
        stage_id: &str,
        checkpoint: Option<bool>,
        instructions: Option<&str>,
        agent_model: Option<&str>,
        max_iterations: Option<i64>,
        loop_mode: Option<&str>,
    ) -> AppResult<()> {
        use crate::error::AppError;

        let run_status: String = self
            .conn
            .query_row(
                "SELECT status FROM runs WHERE id = ?1",
                params![run_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::Other("run not found".into()))?;
        if matches!(run_status.as_str(), "completed" | "aborted") {
            return Err(AppError::Other(
                "this run has finished — its stages can't be edited".into(),
            ));
        }

        let (status, started_at, role, loop_target_position, loop_max_iterations, artifact): (
            String,
            Option<String>,
            String,
            Option<i64>,
            i64,
            Option<String>,
        ) = self
            .conn
            .query_row(
                "SELECT status, started_at, role, loop_target_position, loop_max_iterations, artifact
                 FROM run_stages WHERE id = ?1 AND run_id = ?2",
                params![stage_id, run_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::Other("stage not found".into()))?;

        // Two editable moments: a pending stage the run hasn't reached, and a
        // stage parked BEFORE it began — a budget park or a director pause,
        // which hold the NEXT stage with no work done. The discriminator is
        // `started_at IS NULL` (never ran): those pre-work parks produce nothing
        // and never stamp `started_at`, while a checkpoint-GATE park holds a
        // FINISHED stage's hand-off (artifact present) and an `ask_director`
        // BLOCK holds a stage that DID run (started_at stamped, artifact null) —
        // both are past editing, redirected via the decision bar / answer form
        // or a re-run. Requiring `started_at.is_none()` (not just "no artifact")
        // is what keeps a block out of this branch.
        let pending_unstarted = status == "pending" && started_at.is_none();
        let parked_unbegun =
            status == "awaiting_checkpoint" && artifact.is_none() && started_at.is_none();
        if !pending_unstarted && !parked_unbegun {
            return Err(AppError::Other(format!(
                "{} has already started — only stages that haven't begun can be edited",
                role.replace('_', " ")
            )));
        }
        // Toggling the gate of a stage that is already parked would not
        // release the park (that's what approve/reject are for) — reject it
        // rather than let the toggle silently do nothing.
        if parked_unbegun && checkpoint.is_some() {
            return Err(AppError::Other(
                "this stage is parked awaiting your decision — approve or reject it instead of toggling the gate".into(),
            ));
        }

        Self::validate_stage_patch_fields(
            loop_target_position,
            loop_max_iterations,
            loop_mode,
            agent_model,
        )?;

        self.apply_run_stage_patch(
            stage_id,
            checkpoint,
            instructions,
            agent_model,
            max_iterations,
            loop_mode,
        )
    }

    /// Field-level validation for a stage patch, shared by `update_run_stage`
    /// and the rerun path (which must validate BEFORE it resets anything).
    pub fn validate_stage_patch_fields(
        loop_target_position: Option<i64>,
        loop_max_iterations: i64,
        loop_mode: Option<&str>,
        agent_model: Option<&str>,
    ) -> AppResult<()> {
        use crate::error::AppError;
        if let Some(mode) = loop_mode {
            if loop_target_position.is_none() || loop_max_iterations <= 0 {
                return Err(AppError::Other(
                    "only a looping review stage can switch loop mode".into(),
                ));
            }
            if crate::orchestrator::types::LoopMode::from_db(mode).is_none() {
                return Err(AppError::Other(format!("unknown loop mode '{mode}'")));
            }
        }
        if let Some(model) = agent_model {
            if model.trim().is_empty() {
                return Err(AppError::Other("agent model can't be empty".into()));
            }
        }
        Ok(())
    }

    /// Apply a stage patch with NO state guards — callers are responsible for
    /// having validated the run/stage state (`update_run_stage`) or for having
    /// just reset the stage to pending (the rerun path).
    pub fn apply_run_stage_patch(
        &self,
        stage_id: &str,
        checkpoint: Option<bool>,
        instructions: Option<&str>,
        agent_model: Option<&str>,
        max_iterations: Option<i64>,
        loop_mode: Option<&str>,
    ) -> AppResult<()> {
        if let Some(cp) = checkpoint {
            self.conn.execute(
                "UPDATE run_stages SET checkpoint = ?2 WHERE id = ?1",
                params![stage_id, cp as i64],
            )?;
        }
        if let Some(text) = instructions {
            let trimmed = text.trim();
            let stored: Option<&str> = if trimmed.is_empty() { None } else { Some(trimmed) };
            self.conn.execute(
                "UPDATE run_stages SET instructions = ?2 WHERE id = ?1",
                params![stage_id, stored],
            )?;
        }
        if let Some(model) = agent_model {
            // A manual model override (StageRerunPatch) clears the sticky
            // escalation flag so the director's explicit model wins over the
            // escalate tier. See `reset_run_stage` for the same rule on the
            // reject path.
            self.conn.execute(
                "UPDATE run_stages SET agent_model = ?2, escalated = 0 WHERE id = ?1",
                params![stage_id, model],
            )?;
        }
        if let Some(mt) = max_iterations {
            self.conn.execute(
                "UPDATE run_stages SET max_iterations = ?2 WHERE id = ?1",
                params![stage_id, mt.clamp(1, 100)],
            )?;
        }
        if let Some(mode) = loop_mode {
            self.conn.execute(
                "UPDATE run_stages SET loop_mode = ?2 WHERE id = ?1",
                params![stage_id, mode],
            )?;
        }
        Ok(())
    }

    /// Accumulate a soon-to-be-reset stage's spend onto the run, so the cost
    /// meter keeps counting work erased by a loop-back / reject.
    pub fn retire_stage_cost(
        &self,
        run_id: &str,
        cost_usd: f64,
        input_tokens: i64,
        output_tokens: i64,
    ) -> AppResult<()> {
        self.conn.execute(
            "UPDATE runs
             SET retired_cost_usd = retired_cost_usd + ?2,
                 retired_input_tokens = retired_input_tokens + ?3,
                 retired_output_tokens = retired_output_tokens + ?4
             WHERE id = ?1",
            params![run_id, cost_usd, input_tokens, output_tokens],
        )?;
        Ok(())
    }

    /// `(retired_cost_usd, retired_input_tokens, retired_output_tokens)` for the run.
    pub fn get_retired_cost(&self, run_id: &str) -> AppResult<(f64, i64, i64)> {
        self.conn
            .query_row(
                "SELECT retired_cost_usd, retired_input_tokens, retired_output_tokens FROM runs WHERE id = ?1",
                params![run_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(Into::into)
    }

    /// Persist the worktree diff captured the moment a stage finished. The
    /// orchestrator calls this best-effort right after the outcome lands.
    pub fn set_stage_diff_snapshot(&self, stage_id: &str, diff: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET diff_snapshot = ?2 WHERE id = ?1",
            params![stage_id, diff],
        )?;
        Ok(())
    }

    pub fn set_run_stage_artifact(&self, stage_id: &str, artifact_json: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET artifact = ?2 WHERE id = ?1",
            params![stage_id, artifact_json],
        )?;
        Ok(())
    }

    /// Persist the CLI session id from a stage's attempt (done or failed).
    pub fn set_stage_session(&self, stage_id: &str, session_id: Option<&str>) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET session_id = ?2 WHERE id = ?1",
            params![stage_id, session_id],
        )?;
        Ok(())
    }

    /// Mark that the next run of this stage should `--resume` its session_id.
    pub fn set_stage_resume_pending(&self, stage_id: &str, pending: bool) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET resume_pending = ?2 WHERE id = ?1",
            params![stage_id, pending as i64],
        )?;
        Ok(())
    }

    /// Override a stage's tool-turn budget (used by Resume/Re-run with N turns).
    pub fn set_stage_max_iterations(&self, stage_id: &str, max_iterations: i64) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET max_iterations = ?2 WHERE id = ?1",
            params![stage_id, max_iterations.clamp(1, 100)],
        )?;
        Ok(())
    }

    /// Persist the pre-stage worktree commit SHA captured at stage start.
    /// Used by Discard to revert only this stage's edits.
    pub fn set_stage_baseline(&self, stage_id: &str, baseline: Option<&str>) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET baseline_commit = ?2 WHERE id = ?1",
            params![stage_id, baseline],
        )?;
        Ok(())
    }

    /// Append one `run://log` entry (JSON) to a stage's persisted journal.
    pub fn append_stage_log(&self, run_id: &str, stage_id: &str, entry_json: &str) -> AppResult<()> {
        self.conn.execute(
            "INSERT INTO stage_log (run_id, stage_id, entry) VALUES (?1,?2,?3)",
            params![run_id, stage_id, entry_json],
        )?;
        Ok(())
    }

    /// Append a `{"kind":"reset"}` segment marker — but only when the stage
    /// already has log rows. Stage starts emit reset unconditionally (including
    /// the very first), and a leading marker would shift every attempt↔segment
    /// mapping by one.
    pub fn append_stage_log_marker(&self, run_id: &str, stage_id: &str) -> AppResult<()> {
        self.conn.execute(
            "INSERT INTO stage_log (run_id, stage_id, entry)
             SELECT ?1, ?2, '{\"kind\":\"reset\"}'
             WHERE EXISTS (SELECT 1 FROM stage_log WHERE stage_id = ?2)",
            params![run_id, stage_id],
        )?;
        Ok(())
    }

    /// All persisted journal entries for a stage, oldest first.
    pub fn list_stage_log(&self, stage_id: &str) -> AppResult<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT entry FROM stage_log WHERE stage_id = ?1 ORDER BY id")?;
        let rows = stmt.query_map(params![stage_id], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Journal entries for a whole RUN after a rowid cursor, oldest first:
    /// `(rowid, stage_id, entry_json)`. The detached bridge tails this to
    /// replay a worker's persisted journal as live `run://log` events.
    pub fn list_run_log_after(
        &self,
        run_id: &str,
        after_id: i64,
    ) -> AppResult<Vec<(i64, String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, stage_id, entry FROM stage_log
             WHERE run_id = ?1 AND id > ?2 ORDER BY id",
        )?;
        let rows = stmt.query_map(params![run_id, after_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// The current end of a run's journal — the cursor a bridge tail starts
    /// from when it begins watching an already-running detached run (history
    /// before the app opened is hydrated from `stage_log` by the UI, not
    /// replayed as live events).
    pub fn last_run_log_id(&self, run_id: &str) -> AppResult<i64> {
        let id: Option<i64> = self.conn.query_row(
            "SELECT MAX(id) FROM stage_log WHERE run_id = ?1",
            params![run_id],
            |r| r.get(0),
        )?;
        Ok(id.unwrap_or(0))
    }

    /// Snapshot a stage attempt into `stage_iterations` before it gets reset.
    /// Ordinal = number of prior archives for the stage + 1. `closing_feedback`
    /// is the feedback that ended the attempt (recorded on the review row only).
    pub fn archive_stage_attempt(
        &self,
        stage: &RunStageRow,
        closing_feedback: Option<&str>,
    ) -> AppResult<()> {
        let prior: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM stage_iterations WHERE stage_id = ?1",
            params![stage.id],
            |r| r.get(0),
        )?;
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO stage_iterations
                (id, run_id, stage_id, iteration, role, agent_model, status, artifact, error,
                 cost_usd, input_tokens, output_tokens, closing_feedback, created_at, diff_snapshot)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            params![
                id,
                stage.run_id,
                stage.id,
                prior + 1,
                stage.role,
                stage.agent_model,
                stage.status,
                stage.artifact,
                stage.error,
                stage.cost_usd,
                stage.input_tokens,
                stage.output_tokens,
                closing_feedback,
                now,
                stage.diff_snapshot
            ],
        )?;
        Ok(())
    }

    /// All archived attempts for a stage, oldest first.
    pub fn list_stage_iterations(&self, stage_id: &str) -> AppResult<Vec<StageIterationRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, run_id, stage_id, iteration, role, agent_model, status, artifact, error,
                    cost_usd, input_tokens, output_tokens, closing_feedback, created_at, diff_snapshot
             FROM stage_iterations WHERE stage_id = ?1 ORDER BY iteration",
        )?;
        let rows = stmt.query_map(params![stage_id], |r| {
            Ok(StageIterationRow {
                id: r.get(0)?,
                run_id: r.get(1)?,
                stage_id: r.get(2)?,
                iteration: r.get(3)?,
                role: r.get(4)?,
                agent_model: r.get(5)?,
                status: r.get(6)?,
                artifact: r.get(7)?,
                error: r.get(8)?,
                cost_usd: r.get(9)?,
                input_tokens: r.get(10)?,
                output_tokens: r.get(11)?,
                closing_feedback: r.get(12)?,
                created_at: r.get(13)?,
                diff_snapshot: r.get(14)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn insert_run_event(&self, run_id: &str, kind: &str, payload_json: &str) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO run_events (run_id, timestamp, kind, payload) VALUES (?1,?2,?3,?4)",
            params![run_id, now, kind, payload_json],
        )?;
        Ok(())
    }

}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRow {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub task: String,
    pub branch: String,
    pub worktree_path: Option<String>,
    pub setup_script: String,
    pub status: String,
    pub created_at: String,
    pub last_active: String,
    pub glyph: Option<String>,
    pub tint: Option<String>,
    pub test_command: Option<String>,
    pub linked_issue_key: Option<String>,
    /// The resolved base branch this workspace was created from. None for
    /// rows predating the column and for the auto-created default-branch row.
    pub from_branch: Option<String>,
}

/// A mission — the first-level unit of intent (build/fix/review/probe/design/
/// perf/ops). The worktree is a property it chooses along two isolation axes
/// (`git_isolation` × `exec_isolation`). `workspace_id` is None for missions
/// with no worktree (design/probe).
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MissionRow {
    pub id: String,
    pub workspace_id: Option<String>,
    pub project_id: String,
    pub intent: String,
    pub title: String,
    pub status: String,
    pub linked_issue_key: Option<String>,
    pub git_isolation: String,
    pub exec_isolation: String,
    pub payload: String,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
}

/// A scheduled routine (Pro): a saved pipeline that fires on a schedule.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRow {
    pub id: String,
    pub name: String,
    pub project_id: String,
    pub pipeline_id: String,
    pub task: String,
    pub reference_model: Option<String>,
    pub stage_overrides: Option<String>,
    pub budget_usd: Option<f64>,
    pub schedule_kind: String,
    pub schedule_spec: String,
    pub workspace_mode: String,
    pub fixed_workspace_id: Option<String>,
    pub base_branch: Option<String>,
    pub branch_prefix: Option<String>,
    pub enabled: bool,
    pub last_fired_at: Option<String>,
    pub next_due_at: Option<String>,
    pub last_run_id: Option<String>,
    pub created_at: String,
    /// Optional pre-fire shell command (exit 0 ⇒ fire, non-zero ⇒ skip). NULL =
    /// always fire.
    pub fire_condition: Option<String>,
    /// When the fire condition (or fire) was last evaluated — set on every tick.
    pub last_checked_at: Option<String>,
    /// The last evaluation's outcome ("dispatched" / "condition not met" / …).
    pub last_outcome: Option<String>,
}

/// The mutable fields of a routine (create + update share this shape). The
/// caller computes `next_due_at` from `schedule_kind`/`schedule_spec` and the
/// clock, so `Db` stays clock-free and unit-testable.
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoutineInput {
    pub name: String,
    pub project_id: String,
    pub pipeline_id: String,
    #[serde(default)]
    pub task: String,
    pub reference_model: Option<String>,
    pub stage_overrides: Option<String>,
    pub budget_usd: Option<f64>,
    pub schedule_kind: String,
    pub schedule_spec: String,
    #[serde(default = "default_workspace_mode")]
    pub workspace_mode: String,
    pub fixed_workspace_id: Option<String>,
    pub base_branch: Option<String>,
    pub branch_prefix: Option<String>,
    /// Optional pre-fire shell command; trimmed, empty → NULL on write.
    #[serde(default)]
    pub fire_condition: Option<String>,
}

fn default_workspace_mode() -> String {
    "fixed".to_string()
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileEditRow {
    pub id: i64,
    pub workspace_id: String,
    pub file_path: String,
    pub tool_name: String,
    pub message_id: Option<i64>,
    pub created_at: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRow {
    pub id: String,
    pub workspace_id: String,
    pub label: String,
    pub position: u32,
    pub created_at: i64,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageRow {
    pub id: i64,
    pub workspace_id: String,
    pub role: String,
    pub content: String,
    pub model: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub created_at: String,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatThreadRow {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BudgetRow {
    pub scope_type: String,
    pub scope_id: String,
    pub period: String,
    pub limit_usd: f64,
    pub updated_at: String,
}

/// Cloud vs. local usage split for the Usage dashboard.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UsageBreakdown {
    pub cloud_cost_usd: f64,
    pub cloud_tokens: i64,
    pub local_tokens: i64,
    pub estimated_local_savings_usd: f64,
}

/// A builder-authored stage. Position is the array index; the loop contract
/// (review-loop spec §3.7) is enforced by [`validate_pipeline_stages`].
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StageDraft {
    pub role: String,
    pub agent_model: String,
    pub substrate: String,
    pub checkpoint: bool,
    pub loop_target_position: Option<i64>,
    pub loop_max_iterations: i64,
    pub loop_mode: Option<String>,
    /// Per-stage tool-turn budget (1..=100). Defaults to 25 when absent.
    #[serde(default = "default_max_iterations")]
    pub max_iterations: i64,
    /// Canvas coordinates (builder layout; round-tripped, never executed on).
    #[serde(default)]
    pub pos_x: Option<f64>,
    #[serde(default)]
    pub pos_y: Option<f64>,
    /// Upstream stage positions (flow-edge dependencies), each < this stage's
    /// position after the builder's topological sort. Empty ⇒ legacy chain.
    #[serde(default)]
    pub parents: Vec<i64>,
    /// Tool allowlist; `None` ⇒ the archetype's default tool set.
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    /// Free display label; `None`/empty ⇒ the archetype's label.
    #[serde(default)]
    pub custom_name: Option<String>,
    /// Free-form additions appended to the archetype's system prompt.
    #[serde(default)]
    pub instructions: Option<String>,
    /// Per-stage reasoning effort. `None` ⇒ "off" (no thinking). Validated by
    /// the enum's deserializer; omitted by legacy payloads ⇒ None.
    #[serde(default)]
    pub effort: Option<crate::providers::Effort>,
    /// Escalation policy: the stronger model to retry with when this stage
    /// fails. `None` ⇒ no model swap on the retry. Either escalate field set
    /// ⇒ the stage has an escalation policy.
    #[serde(default)]
    pub escalate_model: Option<String>,
    /// Escalation policy: the effort to bump to on the failed-retry (API only,
    /// like `effort`). `None` ⇒ keep the base effort on the retry.
    #[serde(default)]
    pub escalate_effort: Option<crate::providers::Effort>,
}

fn default_max_iterations() -> i64 {
    25
}

/// Hard cap on free-form stage instructions (defensive: keeps a pasted essay
/// from blowing up every prompt this stage runs).
const MAX_INSTRUCTIONS_CHARS: usize = 8_000;

/// The workspace tools a stage's agent may be granted. Keep in sync with
/// `tool_definitions()` in chat_engine.rs and the role default_tools seeded in orchestrator/roles.rs.
pub const KNOWN_TOOLS: &[&str] = &["read_file", "list_files", "write_file", "run_command"];


/// Transitive flow-ancestors of stage `idx`, following `parents` (positions).
/// Assumes parents reference earlier indices (validated before this is used).
fn draft_ancestors(stages: &[StageDraft], idx: usize) -> std::collections::HashSet<i64> {
    let mut seen = std::collections::HashSet::new();
    let mut stack: Vec<i64> = stages[idx].parents.clone();
    while let Some(p) = stack.pop() {
        if p < 0 || p as usize >= stages.len() || !seen.insert(p) {
            continue;
        }
        stack.extend(stages[p as usize].parents.iter().copied());
    }
    seen
}

/// Validate a pipeline's stage drafts (the §3.7 builder contract).
/// Roles are looked up from the DB; an unknown role key is rejected.
impl Db {
pub fn validate_pipeline_stages(&self, stages: &[StageDraft]) -> crate::error::AppResult<()> {
    use crate::error::AppError;
    if stages.is_empty() {
        return Err(AppError::Other("a pipeline needs at least one stage".into()));
    }
    // An authored graph records parents; a legacy/linear draft does not. The
    // loop-target-is-ancestor rule only applies to authored graphs (a linear
    // draft has no parents, so "earlier position" is the right contract there).
    let authored = stages.iter().any(|s| !s.parents.is_empty());
    for (i, s) in stages.iter().enumerate() {
        if self.get_role(&s.role)?.is_none() {
            return Err(AppError::Other(format!("unknown stage role '{}'", s.role)));
        }
        if !matches!(s.substrate.as_str(), "api" | "cli") {
            return Err(AppError::Other(format!("unknown substrate '{}'", s.substrate)));
        }
        if s.agent_model.trim().is_empty() {
            return Err(AppError::Other(format!("stage {} has no model", i + 1)));
        }
        if !(1..=100).contains(&s.max_iterations) {
            return Err(AppError::Other(format!(
                "stage {} max turns must be between 1 and 100 (got {})",
                i + 1,
                s.max_iterations
            )));
        }
        // Flow-edge parents: each must reference a strictly-earlier stage (the
        // builder topo-sorts before saving, so a valid DAG always satisfies
        // this) and must be distinct. This is what keeps the graph acyclic and
        // makes the ancestry-aware dossier well-defined.
        {
            let mut seen = std::collections::HashSet::new();
            for &p in &s.parents {
                if p < 0 || p >= i as i64 {
                    return Err(AppError::Other(format!(
                        "stage {} has an upstream link to a non-earlier stage — the flow must be acyclic",
                        i + 1
                    )));
                }
                if !seen.insert(p) {
                    return Err(AppError::Other(format!(
                        "stage {} lists the same upstream stage twice",
                        i + 1
                    )));
                }
            }
        }
        // Tool allowlist, when set, must be a non-empty subset of the known
        // workspace tools — an empty list would leave the agent unable to act.
        if let Some(tools) = &s.tools {
            if tools.is_empty() {
                return Err(AppError::Other(format!(
                    "stage {} has an empty tool list — give it at least one tool",
                    i + 1
                )));
            }
            for t in tools {
                if !KNOWN_TOOLS.contains(&t.as_str()) {
                    return Err(AppError::Other(format!("unknown tool '{t}'")));
                }
            }
        }
        if let Some(instr) = &s.instructions {
            if instr.chars().count() > MAX_INSTRUCTIONS_CHARS {
                return Err(AppError::Other(format!(
                    "stage {} instructions are too long (max {MAX_INSTRUCTIONS_CHARS} characters)",
                    i + 1
                )));
            }
        }
        match s.loop_target_position {
            Some(target) => {
                if !self.get_role(&s.role)?.map(|r| r.can_loop).unwrap_or(false) {
                    return Err(AppError::Other(format!("stage '{}' cannot carry a loop (not a review role)", s.role)));
                }
                if target < 0 || target >= i as i64 {
                    return Err(AppError::Other("loop target must be an earlier stage".into()));
                }
                // In an authored graph the loop must return to a stage on the
                // review's own path; otherwise loop_back can't re-run it (the
                // dossier and reset both follow ancestry, not raw position).
                if authored && !draft_ancestors(stages, i).contains(&target) {
                    return Err(AppError::Other(
                        "loop target must be an earlier stage on the review's own path".into(),
                    ));
                }
                if s.loop_max_iterations < 1 {
                    return Err(AppError::Other("loop max iterations must be at least 1".into()));
                }
                if !matches!(s.loop_mode.as_deref(), Some("gated") | Some("auto")) {
                    return Err(AppError::Other("loop mode must be 'gated' or 'auto'".into()));
                }
            }
            None => {
                if s.loop_max_iterations != 0 || s.loop_mode.is_some() {
                    return Err(AppError::Other("loop fields set without a loop target".into()));
                }
            }
        }
    }
    Ok(())
}
} // impl Db (validate_pipeline_stages)

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub is_builtin: bool,
    pub created_at: String,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStageRow {
    pub id: String,
    pub pipeline_id: String,
    pub position: i64,
    pub role: String,
    pub agent_model: String,
    pub substrate: String,
    pub checkpoint: bool,
    pub loop_target_position: Option<i64>,
    pub loop_max_iterations: i64,
    pub loop_mode: Option<String>,
    /// Per-stage tool-turn budget (1..=100; default 25).
    pub max_iterations: i64,
    /// Canvas coordinates (builder layout; `None` for legacy rows).
    pub pos_x: Option<f64>,
    pub pos_y: Option<f64>,
    /// Upstream stage positions (flow-edge dependencies). Empty ⇒ legacy chain.
    pub parents: Vec<i64>,
    /// Tool allowlist; `None` ⇒ the archetype's default tool set.
    pub tools: Option<Vec<String>>,
    /// Free display label; `None` ⇒ the archetype's label.
    pub custom_name: Option<String>,
    /// Free-form additions appended to the archetype's system prompt.
    pub instructions: Option<String>,
    /// Per-stage reasoning effort; `None` ⇒ off (no thinking).
    pub effort: Option<crate::providers::Effort>,
    /// Escalation policy — the stronger model to retry with on failure.
    pub escalate_model: Option<String>,
    /// Escalation policy — the effort to bump to on the failed-retry (API only).
    pub escalate_effort: Option<crate::providers::Effort>,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub id: String,
    pub workspace_id: String,
    pub pipeline_id: String,
    pub task: String,
    pub status: String,
    pub cost_usd: f64,
    pub baseline_usd: f64,
    pub reference_model: Option<String>,
    pub linked_issue_key: Option<String>,
    pub created_at: String,
    pub finished_at: Option<String>,
    /// Optional spend cap — the orchestrator pauses before any stage that
    /// would start at/over it. `None` = no budget.
    pub budget_usd: Option<f64>,
    /// `true` when this run was handed to a detached segment worker — it
    /// survives the app quitting. Set at spawn, permanent for the run.
    pub detached: bool,
}

/// The routines column list, in the order `row_to_routine` reads them.
const ROUTINE_COLS: &str = "id, name, project_id, pipeline_id, task, reference_model, \
    stage_overrides, budget_usd, schedule_kind, schedule_spec, workspace_mode, \
    fixed_workspace_id, base_branch, branch_prefix, enabled, last_fired_at, next_due_at, \
    last_run_id, created_at, fire_condition, last_checked_at, last_outcome";

fn row_to_routine(r: &rusqlite::Row) -> rusqlite::Result<RoutineRow> {
    Ok(RoutineRow {
        id: r.get(0)?,
        name: r.get(1)?,
        project_id: r.get(2)?,
        pipeline_id: r.get(3)?,
        task: r.get(4)?,
        reference_model: r.get(5)?,
        stage_overrides: r.get(6)?,
        budget_usd: r.get(7)?,
        schedule_kind: r.get(8)?,
        schedule_spec: r.get(9)?,
        workspace_mode: r.get(10)?,
        fixed_workspace_id: r.get(11)?,
        base_branch: r.get(12)?,
        branch_prefix: r.get(13)?,
        enabled: r.get::<_, i64>(14)? != 0,
        last_fired_at: r.get(15)?,
        next_due_at: r.get(16)?,
        last_run_id: r.get(17)?,
        created_at: r.get(18)?,
        fire_condition: r.get(19)?,
        last_checked_at: r.get(20)?,
        last_outcome: r.get(21)?,
    })
}

fn row_to_mission(r: &rusqlite::Row) -> rusqlite::Result<MissionRow> {
    Ok(MissionRow {
        id: r.get(0)?,
        workspace_id: r.get(1)?,
        project_id: r.get(2)?,
        intent: r.get(3)?,
        title: r.get(4)?,
        status: r.get(5)?,
        linked_issue_key: r.get(6)?,
        git_isolation: r.get(7)?,
        exec_isolation: r.get(8)?,
        payload: r.get(9)?,
        created_at: r.get(10)?,
        updated_at: r.get(11)?,
        archived_at: r.get(12)?,
    })
}

fn row_to_run(r: &rusqlite::Row) -> rusqlite::Result<RunRow> {
    Ok(RunRow {
        id: r.get(0)?,
        workspace_id: r.get(1)?,
        pipeline_id: r.get(2)?,
        task: r.get(3)?,
        status: r.get(4)?,
        cost_usd: r.get(5)?,
        baseline_usd: r.get(6)?,
        reference_model: r.get(7)?,
        linked_issue_key: r.get(8)?,
        created_at: r.get(9)?,
        finished_at: r.get(10)?,
        budget_usd: r.get(11)?,
        detached: r.get::<_, i64>(12)? != 0,
    })
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunStageRow {
    pub id: String,
    pub run_id: String,
    pub position: i64,
    pub role: String,
    pub agent_model: String,
    /// Per-stage reasoning effort; `None` ⇒ off (no thinking).
    pub effort: Option<crate::providers::Effort>,
    /// Escalation policy (copied from the template) — the stronger model to
    /// retry with on failure. `None` ⇒ no model swap on the retry.
    pub escalate_model: Option<String>,
    /// Escalation policy (copied) — the effort to bump to on the retry (API only).
    pub escalate_effort: Option<crate::providers::Effort>,
    /// Sticky run-state: true once this stage has escalated (its one retry at
    /// the strong tier). Drives the escalated model/effort resolution and the badge.
    pub escalated: bool,
    pub substrate: String,
    pub checkpoint: bool,
    pub status: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
    pub artifact: Option<String>,
    pub feedback: Option<String>,
    pub error: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub loop_target_position: Option<i64>,
    pub loop_max_iterations: i64,
    pub loop_mode: Option<String>,
    pub loop_iterations: i64,
    /// Worktree diff text captured when this stage finished (done or failed);
    /// None for legacy runs and stages whose artifact doesn't ref the worktree.
    pub diff_snapshot: Option<String>,
    /// Per-stage tool-turn budget (copied from the pipeline template; default 25).
    pub max_iterations: i64,
    /// Upstream stage positions (flow-edge dependencies), copied from the
    /// template. Empty ⇒ legacy run: the dossier falls back to "all earlier".
    pub parents: Vec<i64>,
    /// Tool allowlist copied from the template; `None` ⇒ archetype default.
    pub tools: Option<Vec<String>>,
    /// Free display label copied from the template; `None` ⇒ archetype label.
    pub custom_name: Option<String>,
    /// Free-form prompt additions copied from the template.
    pub instructions: Option<String>,
    /// Claude Code CLI session id from the stage's last attempt (CLI substrate
    /// only); enables `--resume`. None for legacy rows and API stages.
    pub session_id: Option<String>,
    /// 1 ⇒ the next run of this stage should resume `session_id`.
    pub resume_pending: bool,
    /// Dangling commit SHA snapshotting the worktree at this stage's start.
    pub baseline_commit: Option<String>,
    /// Escape valve: the stage's `ask_director` questions (JSON `BlockedAsk`)
    /// while it is parked awaiting the director; NULL otherwise. Serialized to
    /// the frontend as the PARSED object (or null) — the answer form wants
    /// structured questions, not a JSON string to re-parse.
    #[serde(serialize_with = "serialize_blocked_questions")]
    pub blocked_questions: Option<String>,
}

/// Serialize a stored JSON string as its parsed value (or `null`) so a
/// `RunStageRow`'s `blocked_questions` reaches the frontend as a `BlockedAsk`
/// object rather than an opaque string. Unparseable/absent ⇒ `null`.
fn serialize_blocked_questions<S>(v: &Option<String>, s: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    match v
        .as_deref()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
    {
        Some(val) => serde::Serialize::serialize(&val, s),
        None => s.serialize_none(),
    }
}

/// One archived stage attempt (a snapshot taken just before a loop-back /
/// reject reset wiped the live row).
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StageIterationRow {
    pub id: String,
    pub run_id: String,
    pub stage_id: String,
    pub iteration: i64,
    pub role: String,
    pub agent_model: String,
    pub status: String,
    pub artifact: Option<String>,
    pub error: Option<String>,
    pub cost_usd: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub closing_feedback: Option<String>,
    pub created_at: String,
    /// The worktree diff as THIS attempt saw it (copied from the stage row at
    /// archive time); None for attempts archived before snapshots existed.
    pub diff_snapshot: Option<String>,
}

fn row_to_session(row: &rusqlite::Row) -> AppResult<Session> {
    let agent_json: String = row.get("agent_config")?;
    let ctx_json: String = row.get("context_files")?;
    let tags_json: String = row.get("tags")?;
    let created: String = row.get("created_at")?;
    let active: String = row.get("last_active")?;
    let status_str: String = row.get("status")?;
    let tokens_used: i64 = row.get("tokens_used")?;
    let tokens_input: i64 = row.get("tokens_input")?;
    let tokens_output: i64 = row.get("tokens_output")?;
    Ok(Session {
        id: row.get("id")?,
        name: row.get("name")?,
        color: row.get("color")?,
        icon: row.get("icon")?,
        project_root: row.get("project_root")?,
        agent: serde_json::from_str(&agent_json)?,
        token_budget: row.get("token_budget")?,
        tokens_used: tokens_used as u64,
        tokens_input: tokens_input as u64,
        tokens_output: tokens_output as u64,
        status: SessionStatus::from_str(&status_str),
        context_files: serde_json::from_str(&ctx_json)?,
        tags: serde_json::from_str(&tags_json)?,
        created_at: DateTime::parse_from_rfc3339(&created)
            .map_err(|e| crate::error::AppError::Other(e.to_string()))?
            .with_timezone(&Utc),
        last_active: DateTime::parse_from_rfc3339(&active)
            .map_err(|e| crate::error::AppError::Other(e.to_string()))?
            .with_timezone(&Utc),
    })
}
