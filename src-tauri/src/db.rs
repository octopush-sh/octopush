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

/// A group's name as stored: trimmed, and never empty.
fn normalize_group_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(group_error("Group name cannot be empty."));
    }
    Ok(name.to_string())
}

/// A group's tint as stored: None for absent or blank, else one of
/// [`GROUP_TINTS`]. Anything else is refused, so no new hue reaches the rail.
fn normalize_group_tint(tint: Option<&str>) -> AppResult<Option<String>> {
    match normalize_optional(tint) {
        None => Ok(None),
        Some(t) if GROUP_TINTS.contains(&t.as_str()) => Ok(Some(t)),
        Some(t) => Err(group_error(format!(
            "Unknown tint '{t}'. Use one of: {}.",
            GROUP_TINTS.join(", ")
        ))),
    }
}

/// A refusal from the rail-group layer, worded for the user.
fn group_error(message: impl Into<String>) -> crate::error::AppError {
    crate::error::AppError::Other(message.into())
}

fn unknown_group_item_kind(kind: &str) -> crate::error::AppError {
    group_error(format!("Unknown item kind '{kind}'. Use 'project' or 'workspace'."))
}

/// What a mission can wait for on its prerequisite (`workspaces.after_condition`).
pub const PREREQUISITE_CONDITIONS: [&str; 2] = ["run_finished", "pr_merged"];

/// A refusal from the prerequisite ("Starts after") layer, worded for the user.
fn prerequisite_error(message: impl Into<String>) -> crate::error::AppError {
    crate::error::AppError::Other(message.into())
}

/// Clears every link that points at `workspace_id` (it is being deleted or
/// archived), so no mission waits on one that is gone.
const CLEAR_LINKS_TO_WORKSPACE_SQL: &str =
    "UPDATE workspaces SET after_workspace_id = NULL, after_condition = NULL,
            branch_from_prerequisite = 0, auto_start = 0
     WHERE after_workspace_id = ?1";

/// Map an UPDATE's row count to "the group exists".
fn group_found(changed: usize) -> AppResult<()> {
    if changed == 0 {
        return Err(group_error("Group not found."));
    }
    Ok(())
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

            -- Canonical spend ledger (token-accounting rebuild, Phase 2). Unlike
            -- token_events (whose overloaded `session_id` conflates workspace /
            -- CLI-session / terminal ids), spend rows carry an explicit `surface`
            -- plus denormalized project/workspace attribution (project_id survives
            -- a workspace deletion) and an `idempotency_key` for dedupe. Phase 2
            -- Slice 1 populates only the `direct` surface (the orchestrator never
            -- wrote a ledger row before, so DIRECT spend was invisible to Usage
            -- and budgets); TALK/RUN/REVIEW still flow through token_events and are
            -- unioned below. Later slices migrate those surfaces here too.
            CREATE TABLE IF NOT EXISTS spend_events (
                id                    INTEGER PRIMARY KEY AUTOINCREMENT,
                ts_utc                TEXT NOT NULL,
                surface               TEXT NOT NULL,
                project_id            TEXT,
                workspace_id          TEXT,
                source_id             TEXT,
                attempt               INTEGER NOT NULL DEFAULT 1,
                model_raw             TEXT NOT NULL,
                model                 TEXT NOT NULL,
                input_tokens          INTEGER NOT NULL DEFAULT 0,
                output_tokens         INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
                cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                provider_cost_usd     REAL,
                computed_cost_usd     REAL,
                cost_usd              REAL NOT NULL DEFAULT 0,
                cost_basis            TEXT NOT NULL DEFAULT 'computed',
                idempotency_key       TEXT UNIQUE,
                CHECK (input_tokens >= 0 AND output_tokens >= 0
                       AND cache_read_tokens >= 0 AND cache_creation_tokens >= 0),
                CHECK (surface IN ('talk','run','direct','review','adhoc')),
                CHECK (cost_basis IN ('provider','computed','subscription','unpriced','estimated'))
            );
            CREATE INDEX IF NOT EXISTS idx_spend_ts ON spend_events(ts_utc);
            CREATE INDEX IF NOT EXISTS idx_spend_ws ON spend_events(workspace_id, ts_utc);
            CREATE INDEX IF NOT EXISTS idx_spend_project ON spend_events(project_id, ts_utc);
            CREATE INDEX IF NOT EXISTS idx_spend_source ON spend_events(source_id);

            -- Unified read surface over the canonical ledger. Every surface
            -- (TALK/RUN/REVIEW/DIRECT) now lives in spend_events, so the old
            -- token_events UNION is gone. `session_id` is projected as
            -- COALESCE(workspace_id, source_id): workspace-attributed spend
            -- (talk/review/direct) keys on its workspace id — exactly what the
            -- workspace/project scope filters expect — while RUN spend keys on
            -- its CLI-session id (source_id), so per-session recap/scope still
            -- works. DROP first: `CREATE VIEW IF NOT EXISTS` would otherwise keep
            -- a stale earlier definition on upgraded installs.
            DROP VIEW IF EXISTS all_spend;
            CREATE VIEW all_spend AS
                SELECT COALESCE(workspace_id, source_id) AS session_id,
                       ts_utc AS timestamp,
                       input_tokens, output_tokens,
                       cache_read_tokens AS cache_read,
                       cache_creation_tokens AS cache_create,
                       model, cost_usd
                FROM spend_events;

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
        // The project's setup-script template (the wizard's last-used script),
        // readable by the backend so a Routine's fresh worktree runs it too.
        add_column_if_missing(
            &self.conn,
            "ALTER TABLE projects ADD COLUMN setup_script TEXT NOT NULL DEFAULT ''",
        )?;
        // What new missions borrow from the main checkout (#961): a JSON
        // `worktree_share::ShareSpec`, '' for nothing (opt-in).
        add_column_if_missing(
            &self.conn,
            "ALTER TABLE projects ADD COLUMN share_with_missions TEXT NOT NULL DEFAULT ''",
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
        // MCP servers switched off for one conversation (the Companion's "can
        // use" chips): a JSON array of server names. NULL — every row from
        // before the column — means none is off, so every configured server
        // stays available, as it always was.
        add_column_if_missing(&self.conn, "ALTER TABLE chat_threads ADD COLUMN mcp_disabled TEXT")?;
        // A conversation's permission mode (`permissions::Mode`, #1146):
        // `plan` or `edit`. NULL, which every row from before the column
        // has, is Edit freely: what Talk always did.
        add_column_if_missing(&self.conn, "ALTER TABLE chat_threads ADD COLUMN permission_mode TEXT")?;
        self.conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, created_at);",
        )?;
        // TALK sub-agents: the live journal of each `Agent` tool call, keyed by
        // the tool call id so the crew card can be rehydrated after a reload.
        // Thread-scoped so `delete_chat_thread` can cascade it.
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS chat_agent_log (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                thread_id  TEXT NOT NULL,
                call_id    TEXT NOT NULL,
                entry      TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_chat_agent_log_call ON chat_agent_log(call_id, id);
            CREATE INDEX IF NOT EXISTS idx_chat_agent_log_thread ON chat_agent_log(thread_id);
            "#,
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
        // D18: the ask_director conversation transcript, so an answered block
        // CONTINUES its conversation instead of re-running from scratch.
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN blocked_transcript TEXT")?;
        // #730: the secret guard's hold on an Action stage (JSON `SecretHold`:
        // findings without values, a fingerprint, and whether the director
        // approved proceeding past exactly those findings). NULL otherwise.
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN secret_hold TEXT")?;
        // #362: the spend the session had already reported when a Resume (or
        // an answered block) set resume_pending — the resumed Claude run
        // reports the conversation's whole total, so its budget cap sits on
        // top. 0 for every pre-existing row.
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN resume_prior_cost_usd REAL NOT NULL DEFAULT 0")?;
        // #712: 1 once an attempt of this stage stopped before its CLI reported
        // usage (Codex) — its cost is unknown, not $0. Sticky across re-runs:
        // the unknown spend was burned all the same.
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN usage_unreported INTEGER NOT NULL DEFAULT 0")?;
        // #860: the same flag for the stage's current attempt only (cleared
        // when an attempt starts), so the ledger labels each attempt's row by
        // what that attempt did, not by an earlier one.
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN attempt_usage_unreported INTEGER NOT NULL DEFAULT 0")?;
        // #682: the token totals the stage's CLI session had reported by the end
        // of its last attempt (JSON `{"session": id, "usage": SessionUsage}`,
        // Codex only) — the baseline a `codex exec resume` subtracts, since a
        // resumed thread reports its running total. NULL when unknown.
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN session_usage TEXT")?;
        // #791: the model the stage's last attempt actually ran on, when Claude
        // Code's `system/init` named another than `agent_model` (its settings
        // blocked the requested one). NULL when they matched or nobody said.
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN ran_model TEXT")?;
        // #893: how many tool calls Claude Code refused in the stage's last
        // attempt (its result event's `permission_denials`).
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN refused_calls INTEGER NOT NULL DEFAULT 0")?;
        // #895: the context size of the Claude CLI stage's latest top-level
        // assistant message (input + cache read + cache write, Talk's
        // `contextTokens`) and the window of the model that answered it, as
        // `PersistingSink` last saw them — what the Direct context meter reads,
        // detached runs included. NULL until the stage's first message, for
        // Codex/API stages, and (window) when the catalog doesn't list the model.
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN context_tokens INTEGER")?;
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN context_window INTEGER")?;
        // #1025: the context reading a Resume (or an answered block) found on
        // the stage before its reset forgot it — a resumed Claude run whose
        // first reply reads far less came back on an empty conversation.
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN resume_context_tokens INTEGER")?;
        // #973: 1 ⇒ the stage's pending `--resume` drops the deferred call
        // whose tool is gone (`CLAUDE_CODE_DROP_UNAVAILABLE_DEFERRED_TOOL`).
        // Set by the Drop-the-call action, cleared when the run starts.
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN drop_deferred_pending INTEGER NOT NULL DEFAULT 0")?;
        self.conn.execute_batch(
            "UPDATE pipelines SET updated_at = created_at WHERE updated_at IS NULL;
             UPDATE roles SET updated_at = created_at WHERE updated_at IS NULL;",
        )?;
        // #613 (ONE-SHOT, gated via app_meta): Codex CLI stages took no effort
        // before #613, so a stored effort on one that already ran is one it never
        // got. Clear it, so history (RunFlow's pill, the pre-run estimate's
        // samples) is true to what ran; from here on a Codex stage's effort is
        // real. Only stages of a terminal run (completed/aborted — what `drive`
        // never resumes) are cleared: every stage of a draft, running or paused
        // run (a budget-parked `awaiting_checkpoint` stage, a retryable failed
        // one) will still run with its effort. A stage is judged on the model it
        // last ran on (`escalate_model` once escalated, as RunFlow and
        // `run_stage_once` do); the model test mirrors
        // `cli_runner::dialect_for_model`. `pipeline_stages` is left alone: those
        // efforts apply from now on.
        if self.meta_get("codex_stage_effort_cleared_v1")?.is_none() {
            self.conn.execute(
                "UPDATE run_stages SET effort = NULL, escalate_effort = NULL
                 WHERE id IN (
                     SELECT id FROM (
                         SELECT s.id, lower(CASE WHEN s.escalated AND s.escalate_model IS NOT NULL
                                                 THEN s.escalate_model ELSE s.agent_model END) AS m
                         FROM run_stages s JOIN runs r ON r.id = s.run_id
                         WHERE s.substrate = 'cli' AND r.status IN ('completed', 'aborted')
                     )
                     WHERE m LIKE 'gpt-%' OR m LIKE 'o1%' OR m LIKE 'o3%' OR m LIKE 'o4%'
                        OR m LIKE '%codex%'
                 )",
                [],
            )?;
            self.meta_set("codex_stage_effort_cleared_v1", "done")?;
        }

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
        // Claude plan limit park (#731): the window that stopped the run, when
        // it resets, when the automatic resume is due (NULL = the director
        // resumes), and how many automatic resumes ran since the director
        // last acted or a stage finished. Epoch seconds.
        add_column_if_missing(&self.conn, "ALTER TABLE runs ADD COLUMN plan_window TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE runs ADD COLUMN plan_resets_at INTEGER")?;
        add_column_if_missing(&self.conn, "ALTER TABLE runs ADD COLUMN plan_resume_at INTEGER")?;
        add_column_if_missing(&self.conn, "ALTER TABLE runs ADD COLUMN plan_resume_count INTEGER NOT NULL DEFAULT 0")?;
        // Consecutive automatic resumes claimed but not applied (#857): on
        // the row, so the app and a detached worker share one count and a
        // restart doesn't reset it.
        add_column_if_missing(&self.conn, "ALTER TABLE runs ADD COLUMN plan_retry_count INTEGER NOT NULL DEFAULT 0")?;
        // Plan-limit reports in a row whose reset was already past (#1109):
        // Claude Code before 2.1.332 can report a limit that already reset.
        add_column_if_missing(&self.conn, "ALTER TABLE runs ADD COLUMN plan_stale_count INTEGER NOT NULL DEFAULT 0")?;
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

        // Backfill DIRECT spend history into the canonical ledger so past runs
        // show up in Usage the moment this ships. One row per current run_stage
        // that burned spend, attributed to its run's workspace/project. INSERT OR
        // IGNORE + a deterministic key make it idempotent even before the flag is
        // set. (Retired/archived attempts in stage_iterations are not backfilled;
        // the live path captures each attempt going forward — a later slice can
        // retro-fill them for exact parity with the retire-inclusive run meter.)
        if self.meta_get("spend_events_direct_backfill_v1")?.is_none() {
            self.conn.execute_batch(
                r#"
                INSERT OR IGNORE INTO spend_events
                    (ts_utc, surface, project_id, workspace_id, source_id, attempt,
                     model_raw, model, input_tokens, output_tokens,
                     cache_read_tokens, cache_creation_tokens,
                     provider_cost_usd, computed_cost_usd, cost_usd, cost_basis, idempotency_key)
                SELECT COALESCE(s.finished_at, r.created_at),
                       'direct', w.project_id, r.workspace_id, s.id, 1,
                       s.agent_model, s.agent_model, s.input_tokens, s.output_tokens,
                       0, 0, NULL, s.cost_usd, s.cost_usd, 'computed',
                       'direct-backfill:' || s.id
                FROM run_stages s
                JOIN runs r ON r.id = s.run_id
                LEFT JOIN workspaces w ON w.id = r.workspace_id
                WHERE (s.cost_usd > 0 OR s.input_tokens > 0 OR s.output_tokens > 0);
                "#,
            )?;
            self.meta_set("spend_events_direct_backfill_v1", "done")?;
        }

        // F14: migrate all historical token_events (TALK/RUN/REVIEW/adhoc) into the
        // canonical ledger, since record() now writes spend_events exclusively and
        // the all_spend view no longer reads token_events. Surface is classified by
        // what session_id actually names (a CLI session → 'run', a workspace →
        // 'talk', the ai-adhoc bucket → 'adhoc'); TALK vs REVIEW can't be told
        // apart in legacy data, so workspace-attributed rows land as 'talk'.
        // Attribution: workspace_id/project_id when session_id is a real workspace;
        // source_id always preserves the original id. Deterministic key + INSERT OR
        // IGNORE keep it idempotent. token_events itself is left intact (read-only
        // history / manual-recovery fallback).
        if self.meta_get("spend_events_token_backfill_v1")?.is_none() {
            self.conn.execute_batch(
                r#"
                INSERT OR IGNORE INTO spend_events
                    (ts_utc, surface, project_id, workspace_id, source_id, attempt,
                     model_raw, model, input_tokens, output_tokens,
                     cache_read_tokens, cache_creation_tokens,
                     provider_cost_usd, computed_cost_usd, cost_usd, cost_basis, idempotency_key)
                SELECT te.timestamp,
                       CASE
                         WHEN EXISTS (SELECT 1 FROM sessions s WHERE s.id = te.session_id) THEN 'run'
                         WHEN te.session_id = 'ai-adhoc' THEN 'adhoc'
                         WHEN EXISTS (SELECT 1 FROM workspaces w WHERE w.id = te.session_id) THEN 'talk'
                         ELSE 'adhoc'
                       END,
                       (SELECT w.project_id FROM workspaces w WHERE w.id = te.session_id),
                       (SELECT w.id FROM workspaces w WHERE w.id = te.session_id),
                       te.session_id, 1,
                       te.model, te.model, te.input_tokens, te.output_tokens,
                       te.cache_read, te.cache_create,
                       NULL, te.cost_usd, te.cost_usd, 'computed',
                       'token-backfill:' || te.id
                FROM token_events te;
                "#,
            )?;
            self.meta_set("spend_events_token_backfill_v1", "done")?;
        }

        // Logbook (M2): denormalize mission_id onto spend_events so cost rolls up
        // per mission without a workspace_id JOIN (which would mis-attribute
        // across an archived→recreated mission on the same workspace). Populated
        // at write time by record_token_spend/record_direct_spend going forward;
        // backfilled here (after all history-inserting migrations above) from the
        // workspace→mission pairing — covers talk/review/direct (the surfaces that
        // carry workspace_id); RUN/adhoc stay NULL until RUN gets workspace
        // attribution.
        add_column_if_missing(&self.conn, "ALTER TABLE spend_events ADD COLUMN mission_id TEXT")?;
        // Talk attribution below the workspace: the thread a row was billed
        // in, and whether the director or a sub-agent (`subagent:<call id>`)
        // spent it — the Companion's conversation cost reads these.
        add_column_if_missing(&self.conn, "ALTER TABLE spend_events ADD COLUMN thread_id TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE spend_events ADD COLUMN origin TEXT")?;
        // The provider's message id beside the request id a RUN row is keyed
        // on: a gateway logs one or the other, and reconciliation matches
        // its rows against both. NULL on rows ingested before this column.
        add_column_if_missing(&self.conn, "ALTER TABLE spend_events ADD COLUMN provider_msg_id TEXT")?;
        // `usage.speed` of a single-request row (`'fast'` in fast mode, priced
        // at the fast rate). NULL on older rows and on aggregated ones.
        add_column_if_missing(&self.conn, "ALTER TABLE spend_events ADD COLUMN speed TEXT")?;
        self.conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_spend_thread ON spend_events(thread_id, ts_utc);",
        )?;
        // Per-turn prompt accounting on assistant rows: what the turn's rounds
        // read from cache and wrote to it, and the size of the LAST prompt
        // (the real context the next turn will carry).
        add_column_if_missing(&self.conn, "ALTER TABLE chat_messages ADD COLUMN cache_read_tokens INTEGER")?;
        add_column_if_missing(&self.conn, "ALTER TABLE chat_messages ADD COLUMN cache_creation_tokens INTEGER")?;
        add_column_if_missing(&self.conn, "ALTER TABLE chat_messages ADD COLUMN context_tokens INTEGER")?;
        // A user row's `@` context blocks (#1150): `[{token, kind, label,
        // tokens, start, end, notIncluded?}]`, offsets into `content` (UTF-16
        // units). NULL on older rows and on asks with no `@` context.
        add_column_if_missing(&self.conn, "ALTER TABLE chat_messages ADD COLUMN context_blocks TEXT")?;
        // Talk's append-only transcript (`context::transcript`, B2), written
        // once on a `talkEngine: "v2"` turn: an `assistant_tool_use` row's
        // verbatim round and origin model (`raw_json`), and a tool row's call
        // (`tool_use_id`) and the capped text the model was given
        // (`model_view`). NULL on older rows, which replay as text.
        add_column_if_missing(&self.conn, "ALTER TABLE chat_messages ADD COLUMN raw_json TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE chat_messages ADD COLUMN tool_use_id TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE chat_messages ADD COLUMN model_view TEXT")?;
        // How a Talk `error` row's turn failed (`ProviderErrorKind::as_str`),
        // which picks the error card's action. NULL on older rows, which
        // read as `other`.
        add_column_if_missing(&self.conn, "ALTER TABLE chat_messages ADD COLUMN error_kind TEXT")?;
        // A finished sub-agent's conversation, kept so the user can give it
        // more turns or an answer and it CONTINUES instead of starting over.
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS chat_agent_runs (
                call_id         TEXT PRIMARY KEY,
                thread_id       TEXT NOT NULL,
                workspace_id    TEXT NOT NULL,
                message_id      INTEGER,
                spec_json       TEXT NOT NULL,
                transcript_json TEXT NOT NULL,
                model           TEXT NOT NULL,
                updated_at      TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chat_agent_runs_thread ON chat_agent_runs(thread_id);
            "#,
        )?;
        // The original of an MCP tool output whose binary payloads the row
        // shows as placeholders, for `recall_tool_output` only. Kept apart
        // from `chat_messages.content`, which the webview receives on every
        // new row and thread load. Goes with its row (deleted thread,
        // truncate, deleted workspace).
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS chat_tool_originals (
                message_id      INTEGER PRIMARY KEY,
                thread_id       TEXT NOT NULL,
                content         TEXT NOT NULL,
                total_bytes     INTEGER NOT NULL,
                FOREIGN KEY(message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
            );
            "#,
        )?;
        self.conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_spend_mission ON spend_events(mission_id, ts_utc);",
        )?;
        if self.meta_get("spend_events_mission_backfill_v1")?.is_none() {
            // Pass 1: attribute each spend to the mission whose lifetime
            // [created_at, archived_at) actually brackets its ts_utc — so an
            // archived→recreated mission on the same workspace keeps its own
            // historical cost instead of donating it to the survivor. The ts_utc
            // correlation lives in the WHERE only: SQLite does not resolve an
            // outer-table reference inside a subquery's ORDER BY (it does in the
            // WHERE, which is why workspace_id correlation works).
            self.conn.execute(
                "UPDATE spend_events SET mission_id = (
                     SELECT m.id FROM missions m
                     WHERE m.workspace_id = spend_events.workspace_id
                       AND m.created_at <= spend_events.ts_utc
                       AND (m.archived_at IS NULL OR m.archived_at > spend_events.ts_utc)
                     ORDER BY m.created_at DESC LIMIT 1
                 )
                 WHERE mission_id IS NULL AND workspace_id IS NOT NULL",
                [],
            )?;
            // Pass 2: rows no mission bracketed (the common case — the M1 backfill
            // stamped every mission with a recent created_at, so pre-mission spend
            // predates them all) fall back to the earliest non-archived mission,
            // preserving the original single-mission behaviour.
            self.conn.execute(
                "UPDATE spend_events SET mission_id = (
                     SELECT m.id FROM missions m
                     WHERE m.workspace_id = spend_events.workspace_id
                     ORDER BY (m.status = 'archived') ASC, m.created_at ASC LIMIT 1
                 )
                 WHERE mission_id IS NULL AND workspace_id IS NOT NULL",
                [],
            )?;
            self.meta_set("spend_events_mission_backfill_v1", "done")?;
        }

        // Logbook (M2): work_spans — coalesced activity intervals, the "hours"
        // half of the Logbook. Worked time per mission = the UNION of its spans'
        // intervals (a TALK span and a terminal span open at once count once,
        // merged in Rust), never the sum of per-surface durations.
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS work_spans (
                id           TEXT PRIMARY KEY,
                mission_id   TEXT,
                workspace_id TEXT,
                project_id   TEXT NOT NULL,
                surface      TEXT NOT NULL,   -- talk | direct | terminal | review
                source       TEXT NOT NULL,   -- chat | stage | pty | edit
                started_at   TEXT NOT NULL,
                ended_at     TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_work_spans_mission ON work_spans(mission_id, started_at);
            CREATE INDEX IF NOT EXISTS idx_work_spans_project ON work_spans(project_id, started_at);
            CREATE INDEX IF NOT EXISTS idx_work_spans_coalesce ON work_spans(workspace_id, surface, ended_at);
            "#,
        )?;

        // Claude Code hook signals (#287): written by `octopush-mcp hook` from
        // inside a Run terminal, drained by the app's poller. A queue, not a
        // history — rows are deleted once read. No message text is stored.
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS hook_signals (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                terminal_id TEXT NOT NULL,
                signal      TEXT NOT NULL,   -- permission | input | settled
                session_id  TEXT,
                created_at  TEXT NOT NULL
            );
            "#,
        )?;

        // Reconcile each run's retired/looped DIRECT history into the ledger. The
        // Slice-1 backfill only captured the CURRENT run_stages, so a run that
        // looped/rejected before that shipped is missing its retired attempts,
        // making its Usage figure lower than the retire-inclusive `runs.cost_usd`.
        // We can't backfill stage_iterations naively — attempts archived AFTER the
        // live capture (complete_run_stage) landed are already in the ledger, so
        // re-adding them would double-count. Instead insert ONE reconciliation row
        // per run for the GAP = runs.cost_usd − (DIRECT spend already recorded for
        // that run's stages). Only positive gaps insert, so already-complete runs
        // add nothing; the per-run idempotency key makes it safe to re-run. Runs
        // after the mission column/backfill above so reconciliation rows can carry
        // their run's mission_id and roll up in the Logbook.
        if self.meta_get("spend_events_retired_reconcile_v1")?.is_none() {
            self.reconcile_retired_direct_spend()?;
            self.meta_set("spend_events_retired_reconcile_v1", "done")?;
        }

        // #861: every Claude CLI session a Direct stage ran, kept for good
        // (`run_stages.session_id` is overwritten per attempt and cleared on
        // completion paths). The transcript ingestor skips these sessions —
        // their spend is already metered as the stage's `direct` row — and
        // removes any `run` rows it recorded for them before they were known.
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS direct_cli_sessions (
                session_id TEXT PRIMARY KEY,
                run_id     TEXT,
                stage_id   TEXT,
                created_at TEXT NOT NULL
            );
            "#,
        )?;
        // Which Claude Code session each Run terminal runs, as that session's
        // own hooks say (`claude_hooks::remember_sessions`): the hook's
        // environment names the terminal, its payload the session. One
        // current session per terminal; a terminal with none has no row. The
        // Run Companion's Context section reads one terminal's context and
        // spend through it. `ended_claude_sessions` remembers the sessions
        // whose `SessionEnd` fired, so a late signal can't relink one and a
        // finished conversation is never taken for a terminal's rival.
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS terminal_claude_session (
                terminal_id TEXT PRIMARY KEY,
                session_id  TEXT NOT NULL,
                linked_at   TEXT NOT NULL   -- the last hook signal naming this pair
            );
            CREATE INDEX IF NOT EXISTS idx_terminal_claude_session_session
                ON terminal_claude_session(session_id);
            CREATE TABLE IF NOT EXISTS ended_claude_sessions (
                session_id TEXT PRIMARY KEY,
                ended_at   TEXT NOT NULL
            );
            "#,
        )?;
        // Pruned on every migrating open (the app's start, and each
        // `octopush-mcp` server start): 30 days is far past any message that
        // could still be recent to a live session, or any late signal.
        self.prune_ended_claude_sessions(&(Utc::now() - chrono::Duration::days(ENDED_SESSION_DAYS)).to_rfc3339())?;
        // One-time backfill from what the stage rows still remember: the last
        // attempt's session id, and the session its reported usage belongs to.
        // The ingestor then purges the duplicate `run` rows those sessions'
        // transcripts produced (it has to read the files to know their keys).
        if self.meta_get("direct_cli_sessions_backfill_v1")?.is_none() {
            self.backfill_direct_cli_sessions()?;
            self.meta_set("direct_cli_sessions_backfill_v1", "done")?;
        }

        // Rail groups: a named, optionally tinted, one-level container for the
        // workspace rail. One table, two scopes. A `project` group holds
        // projects and belongs to no project; a `workspace` group holds one
        // project's workspaces and is deleted with that project. Membership is
        // the nullable `group_id` on the member's own row, so an item is in at
        // most one group. The columns carry no foreign key: `delete_group`
        // clears them in its own transaction, and a group that loses every
        // member stays until it is deleted.
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS groups (
                id          TEXT PRIMARY KEY,
                scope       TEXT NOT NULL CHECK (scope IN ('project','workspace')),
                project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
                name        TEXT NOT NULL,
                tint        TEXT,
                sort_order  INTEGER NOT NULL,
                created_at  TEXT NOT NULL,
                CHECK ((scope = 'project' AND project_id IS NULL)
                    OR (scope = 'workspace' AND project_id IS NOT NULL))
            );
            CREATE INDEX IF NOT EXISTS idx_groups_scope ON groups(scope, project_id, sort_order);
            "#,
        )?;
        add_column_if_missing(&self.conn, "ALTER TABLE projects ADD COLUMN group_id TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE workspaces ADD COLUMN group_id TEXT")?;

        // ── Starts after (#960): a mission that waits on another mission of
        // the same project. `after_workspace_id` names the prerequisite (no
        // foreign key: deleting or archiving it clears the link in
        // `delete_workspace` / `archive_workspace`); `after_condition` is one
        // of `PREREQUISITE_CONDITIONS`. Both are NULL when there is no link.
        add_column_if_missing(&self.conn, "ALTER TABLE workspaces ADD COLUMN after_workspace_id TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE workspaces ADD COLUMN after_condition TEXT")?;
        add_column_if_missing(
            &self.conn,
            "ALTER TABLE workspaces ADD COLUMN branch_from_prerequisite INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &self.conn,
            "ALTER TABLE workspaces ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 0",
        )?;

        self.backfill_default_threads()?;

        Ok(())
    }

    /// Seed `direct_cli_sessions` from `run_stages.session_id` and the session
    /// named in `run_stages.session_usage` (#861). Idempotent.
    fn backfill_direct_cli_sessions(&self) -> AppResult<()> {
        let rows: Vec<(String, String, Option<String>, Option<String>, Option<String>)> = {
            let mut stmt = self.conn.prepare(
                "SELECT id, run_id, session_id, session_usage, COALESCE(finished_at, started_at)
                 FROM run_stages
                 WHERE session_id IS NOT NULL OR session_usage IS NOT NULL",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let now = Utc::now().to_rfc3339();
        for (stage_id, run_id, session_id, usage, at) in rows {
            let from_usage = usage
                .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
                .and_then(|v| v.get("session").and_then(|s| s.as_str()).map(str::to_string));
            for sid in [session_id, from_usage].into_iter().flatten().filter(|s| !s.is_empty()) {
                self.conn.execute(
                    "INSERT OR IGNORE INTO direct_cli_sessions (session_id, run_id, stage_id, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![sid, run_id, stage_id, at.as_deref().unwrap_or(&now)],
                )?;
            }
        }
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
                s.token_budget.map(|b| b as i64),
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

    /// Events for one source id (a RUN CLI-session id, or a workspace id), read
    /// from the canonical ledger. Used by session export/recap. Reads
    /// spend_events (not the retired token_events table) so it reflects spend
    /// recorded after the F14 migration.
    pub fn list_token_events(&self, session_id: &str) -> AppResult<Vec<TokenEvent>> {
        let mut stmt = self.conn.prepare(
            "SELECT source_id, ts_utc, input_tokens, output_tokens,
                    cache_read_tokens, cache_creation_tokens, model, cost_usd
             FROM spend_events WHERE source_id = ?1 ORDER BY ts_utc",
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

    // ─── Spend ledger (canonical, Phase 2) ────────────────────────

    /// Insert a canonical spend event. `INSERT OR IGNORE` so a non-null
    /// `idempotency_key` dedupes replays/retries (a NULL key always inserts —
    /// SQLite treats NULLs as distinct under a UNIQUE constraint).
    pub fn insert_spend_event(&self, ev: &SpendEvent) -> AppResult<()> {
        self.insert_spend_event_if_new(ev).map(|_| ())
    }

    /// [`insert_spend_event`](Self::insert_spend_event), reporting whether the
    /// row was new (`false` when its `idempotency_key` was already present).
    pub fn insert_spend_event_if_new(&self, ev: &SpendEvent) -> AppResult<bool> {
        let n = self.conn.execute(
            "INSERT OR IGNORE INTO spend_events
                (ts_utc, surface, project_id, workspace_id, source_id, attempt,
                 model_raw, model, input_tokens, output_tokens,
                 cache_read_tokens, cache_creation_tokens,
                 provider_cost_usd, computed_cost_usd, cost_usd, cost_basis, idempotency_key,
                 mission_id, thread_id, origin, speed)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",
            params![
                ev.ts_utc,
                ev.surface,
                ev.project_id,
                ev.workspace_id,
                ev.source_id,
                ev.attempt,
                ev.model_raw,
                ev.model,
                ev.input_tokens,
                ev.output_tokens,
                ev.cache_read_tokens,
                ev.cache_creation_tokens,
                ev.provider_cost_usd,
                ev.computed_cost_usd,
                ev.cost_usd,
                ev.cost_basis,
                ev.idempotency_key,
                ev.mission_id,
                ev.thread_id,
                ev.origin,
                ev.speed,
            ],
        )?;
        Ok(n > 0)
    }

    /// Every workspace that has a worktree on disk: `(id, project_id, path)`.
    /// Archived ones included — spend recorded against them still belongs
    /// to them.
    pub fn list_workspace_paths(&self) -> AppResult<Vec<(String, String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project_id, worktree_path FROM workspaces WHERE worktree_path IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// The workspace whose worktree is `path`, as `(id, project_id)`.
    pub fn workspace_by_path(&self, path: &str) -> AppResult<Option<(String, String)>> {
        self.conn
            .query_row(
                "SELECT id, project_id FROM workspaces WHERE worktree_path = ?1 LIMIT 1",
                params![path],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(Into::into)
    }

    /// Every RUN session opened on `project_root`.
    pub fn session_ids_for_root(&self, project_root: &str) -> AppResult<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT id FROM sessions WHERE project_root = ?1")?;
        let rows = stmt.query_map(params![project_root], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Every terminal of a workspace (the ids the PTY hook scans under).
    pub fn terminal_ids_for_workspace(&self, workspace_id: &str) -> AppResult<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT id FROM terminals WHERE workspace_id = ?1")?;
        let rows = stmt.query_map(params![workspace_id], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// The working directory a PTY source id runs in: a RUN session's
    /// project root, or a workspace terminal's worktree.
    pub fn run_cwd_for_source(&self, id: &str) -> AppResult<Option<String>> {
        self.conn
            .query_row(
                "SELECT project_root FROM sessions WHERE id = ?1
                 UNION ALL
                 SELECT w.worktree_path FROM terminals t JOIN workspaces w ON w.id = t.workspace_id
                 WHERE t.id = ?1 AND w.worktree_path IS NOT NULL
                 LIMIT 1",
                params![id],
                |r| r.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    /// The mission a workspace was on at `ts_utc`: the one whose lifetime
    /// brackets the timestamp, else the earliest non-archived one (the same
    /// rule the mission backfill uses), so historical spend is never stamped
    /// with a mission that did not exist yet.
    pub fn mission_for_workspace_at(&self, workspace_id: &str, ts_utc: &str) -> AppResult<Option<String>> {
        self.conn
            .query_row(
                "SELECT id FROM missions
                 WHERE workspace_id = ?1 AND created_at <= ?2
                   AND (archived_at IS NULL OR archived_at > ?2)
                 ORDER BY created_at DESC LIMIT 1",
                params![workspace_id, ts_utc],
                |r| r.get(0),
            )
            .optional()?
            .map_or_else(
                || {
                    self.conn
                        .query_row(
                            "SELECT id FROM missions WHERE workspace_id = ?1
                             ORDER BY (status = 'archived') ASC, created_at ASC LIMIT 1",
                            params![workspace_id],
                            |r| r.get(0),
                        )
                        .optional()
                        .map_err(Into::into)
                },
                |m| Ok(Some(m)),
            )
    }

    /// Insert a keyed spend event, or bring the existing row with that key up
    /// to date (tokens, cost, model). Returns whether the row was new. Used
    /// by transcript ingestion, where one API message is written as several
    /// lines that may straddle two polls — the later line carries the final
    /// usage and must win.
    pub fn upsert_spend_event_by_key(&self, ev: &SpendEvent) -> AppResult<bool> {
        let Some(key) = ev.idempotency_key.as_deref() else {
            return self.insert_spend_event_if_new(ev);
        };
        let exists: Option<i64> = self
            .conn
            .query_row(
                "SELECT id FROM spend_events WHERE idempotency_key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?;
        match exists {
            None => self.insert_spend_event_if_new(ev),
            Some(id) => {
                self.conn.execute(
                    "UPDATE spend_events
                     SET model_raw = ?2, model = ?3, input_tokens = ?4, output_tokens = ?5,
                         cache_read_tokens = ?6, cache_creation_tokens = ?7,
                         computed_cost_usd = ?8, cost_usd = ?9, cost_basis = ?10, speed = ?11
                     WHERE id = ?1",
                    params![
                        id,
                        ev.model_raw,
                        ev.model,
                        ev.input_tokens,
                        ev.output_tokens,
                        ev.cache_read_tokens,
                        ev.cache_creation_tokens,
                        ev.computed_cost_usd,
                        ev.cost_usd,
                        ev.cost_basis,
                        ev.speed,
                    ],
                )?;
                Ok(false)
            }
        }
    }

    /// Drop the screen-scraped RUN rows (`surface = 'run'`, no idempotency
    /// key — the PTY scanner's `Total cost:` summaries) of the given sources
    /// from `since_ts_utc` on: a transcript now meters those runs exactly,
    /// so the scrape would count them twice. Returns rows removed.
    pub fn delete_scraped_run_spend(&self, source_ids: &[String], since_ts_utc: &str) -> AppResult<usize> {
        let mut n = 0usize;
        for sid in source_ids {
            n += self.conn.execute(
                "DELETE FROM spend_events
                 WHERE surface = 'run' AND idempotency_key IS NULL
                   AND source_id = ?1 AND ts_utc >= ?2",
                params![sid, since_ts_utc],
            )?;
        }
        Ok(n)
    }

    /// One reconciliation row per run for the gap between its retire-inclusive
    /// meter (`runs.cost_usd`) and the DIRECT spend already in the ledger for its
    /// stages — i.e. retired/looped attempts that predate the live-capture path.
    /// Double-count-safe: only positive gaps insert, and a per-run idempotency
    /// key makes it a no-op to re-run. (Cost-only: token counts stay 0, since the
    /// captured attempts already carry their tokens.)
    pub fn reconcile_retired_direct_spend(&self) -> AppResult<()> {
        self.conn.execute_batch(
            r#"
            INSERT OR IGNORE INTO spend_events
                (ts_utc, surface, project_id, workspace_id, source_id, attempt,
                 model_raw, model, input_tokens, output_tokens,
                 cache_read_tokens, cache_creation_tokens,
                 provider_cost_usd, computed_cost_usd, cost_usd, cost_basis,
                 idempotency_key, mission_id)
            SELECT ts, 'direct', project_id, workspace_id, run_id, 1,
                   'retired-history', 'retired-history', 0, 0, 0, 0,
                   NULL, gap, gap, 'computed',
                   'direct-retired-reconcile:' || run_id, mission_id
            FROM (
                SELECT r.id AS run_id, r.workspace_id AS workspace_id,
                       w.project_id AS project_id, r.mission_id AS mission_id,
                       COALESCE(r.finished_at, r.created_at) AS ts,
                       r.cost_usd - COALESCE((
                           SELECT SUM(se.cost_usd)
                           FROM spend_events se
                           JOIN run_stages rs ON rs.id = se.source_id
                           WHERE rs.run_id = r.id AND se.surface = 'direct'
                       ), 0) AS gap
                FROM runs r
                LEFT JOIN workspaces w ON w.id = r.workspace_id
            )
            WHERE gap > 0.005;
            "#,
        )?;
        Ok(())
    }

    /// Record a TALK/RUN/REVIEW/adhoc token event into the canonical ledger.
    /// Attribution is derived from what `session_id` actually is (a workspace id
    /// for TALK/REVIEW, a CLI-session id for RUN, or the literal `ai-adhoc`) so
    /// the ledger never re-overloads a single column: `source_id` always keeps
    /// the original id (for RUN session recap / scope), while `workspace_id` /
    /// `project_id` are populated only when `session_id` names a real workspace.
    pub fn record_token_spend(&self, ev: &TokenEvent, surface: &str) -> AppResult<()> {
        self.record_token_spend_in_thread(ev, surface, None, None)
    }

    /// [`record_token_spend`](Self::record_token_spend) with Talk attribution:
    /// the thread and whether the director or a sub-agent spent it. Records
    /// `cost_basis = 'computed'`; callers that resolved the price (and so
    /// know when it is missing) use
    /// [`record_token_spend_with_basis`](Self::record_token_spend_with_basis).
    pub fn record_token_spend_in_thread(
        &self,
        ev: &TokenEvent,
        surface: &str,
        thread_id: Option<&str>,
        origin: Option<&str>,
    ) -> AppResult<()> {
        self.record_token_spend_with_basis(ev, surface, thread_id, origin, "computed")
    }

    /// Record with the `cost_basis` the caller resolved before taking the DB
    /// lock (`'computed'` or `'unpriced'`, see `token_engine::basis_for`) —
    /// the DB layer never loads the pricing catalog itself.
    pub fn record_token_spend_with_basis(
        &self,
        ev: &TokenEvent,
        surface: &str,
        thread_id: Option<&str>,
        origin: Option<&str>,
        cost_basis: &str,
    ) -> AppResult<()> {
        // A workspace id names the workspace; a workspace TERMINAL id (the
        // RUN-mode PTY hook scans under it) resolves to its workspace, so
        // terminal spend counts against workspace/project budgets and lands
        // under the workspace's name in Usage.
        let workspace_id: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM workspaces WHERE id = ?1
                 UNION ALL
                 SELECT workspace_id FROM terminals WHERE id = ?1
                 LIMIT 1",
                params![ev.session_id],
                |r| r.get(0),
            )
            .optional()?;
        let project_id: Option<String> = match &workspace_id {
            Some(ws) => self
                .conn
                .query_row(
                    "SELECT project_id FROM workspaces WHERE id = ?1",
                    params![ws],
                    |r| r.get(0),
                )
                .optional()?,
            None => None,
        };
        // Denormalize the mission for per-mission cost rollups (Logbook).
        let mission_id: Option<String> = match &workspace_id {
            Some(ws) => self.active_mission_for_workspace(ws)?.map(|m| m.id),
            None => None,
        };
        self.insert_spend_event(&SpendEvent {
            ts_utc: ev.timestamp.clone(),
            surface: surface.to_string(),
            project_id,
            workspace_id,
            mission_id,
            source_id: Some(ev.session_id.clone()),
            attempt: 1,
            model_raw: ev.model.clone(),
            model: ev.model.clone(),
            input_tokens: ev.input_tokens as i64,
            output_tokens: ev.output_tokens as i64,
            cache_read_tokens: ev.cache_read_tokens as i64,
            cache_creation_tokens: ev.cache_creation_tokens as i64,
            provider_cost_usd: None,
            computed_cost_usd: Some(ev.cost_usd),
            cost_usd: ev.cost_usd,
            // 'unpriced' when the model has no price (tokens at $0) — the
            // Usage page flags it and savings leave it out.
            cost_basis: cost_basis.to_string(),
            // No idempotency key: these are distinct billed calls (the PTY scanner
            // already deduped via its seq high-water before we get here).
            idempotency_key: None,
            thread_id: thread_id.map(str::to_string),
            origin: origin.map(str::to_string),
            speed: None,
        })
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
                        COALESCE(SUM(cache_read + cache_create),0), COALESCE(SUM(cost_usd),0)
                 FROM all_spend {where_clause}"
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

        // Cost by session/workspace. LEFT JOINs (not the old INNER JOIN on
        // `sessions`) so no rows are silently dropped: the old query kept only
        // RUN-session-attributed spend and discarded every workspace-attributed
        // TALK/REVIEW/DIRECT row, so this breakdown never summed to the headline
        // total (F9). Each entity is labeled by its session name (RUN) or
        // workspace name (everything keyed by a workspace id), falling back to
        // the raw id — and the breakdown now reconciles to `total_cost`.
        let cost_by_session = {
            let sql = format!(
                "SELECT COALESCE(s.name, w.name, e.session_id, 'unknown'),
                        COALESCE(SUM(e.cost_usd),0), COALESCE(SUM(e.input_tokens+e.output_tokens),0)
                 FROM all_spend e
                 LEFT JOIN sessions s ON s.id = e.session_id
                 LEFT JOIN workspaces w ON w.id = e.session_id
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
                 FROM all_spend {where_clause} GROUP BY model ORDER BY 2 DESC LIMIT 20"
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

        // Hourly trend (last 24h). The cutoff is computed in Rust as an RFC3339
        // UTC string so it string-compares correctly against the stored
        // `to_rfc3339()` timestamps. (SQLite's `datetime('now', …)` renders a
        // space-separated naive form whose lexical order diverges from the
        // stored `T…+00:00` form — that bug widened the window to the whole day.)
        let trend_cutoff = (Utc::now() - chrono::Duration::hours(24)).to_rfc3339();
        let hourly_trend = {
            let sql = format!(
                "SELECT strftime('%Y-%m-%dT%H:00:00Z', timestamp) AS hour,
                        SUM(input_tokens+output_tokens), SUM(cost_usd)
                 FROM all_spend
                 WHERE timestamp >= ?1
                 {extra_and}
                 GROUP BY hour ORDER BY hour",
                extra_and = if session_id.is_some() {
                    "AND session_id = ?2"
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
                stmt.query_map(params![trend_cutoff, filter_val], trend_mapper)?
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                stmt.query_map(params![trend_cutoff], trend_mapper)?
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

        // Projected daily cost: extrapolate from the last hour of activity.
        // Same RFC3339 cutoff fix as the trend above — the previous
        // `datetime('now', '-1 hour')` string-compared as the whole current
        // day, inflating the projection by up to ~24×.
        let proj_cutoff = (Utc::now() - chrono::Duration::hours(1)).to_rfc3339();
        let projected = {
            let sql = format!(
                "SELECT COALESCE(SUM(cost_usd),0)
                 FROM all_spend
                 WHERE timestamp >= ?1
                 {extra_and}",
                extra_and = if session_id.is_some() {
                    "AND session_id = ?2"
                } else {
                    ""
                }
            );
            let mut stmt = self.conn.prepare(&sql)?;
            let last_hour: f64 = if session_id.is_some() {
                stmt.query_row(params![proj_cutoff, filter_val], |r| r.get(0))?
            } else {
                stmt.query_row(params![proj_cutoff], |r| r.get(0))?
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

    // ─── Usage report (Settings → Usage) ──────────────────────────

    /// Record the provider's message id beside a ledger row's dedupe key
    /// (RUN rows are keyed on Claude Code's request id; a gateway may log
    /// either). A no-op for a key the ledger does not have.
    pub fn set_spend_provider_msg_id(&self, idempotency_key: &str, msg_id: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE spend_events SET provider_msg_id = ?2 WHERE idempotency_key = ?1",
            params![idempotency_key, msg_id],
        )?;
        Ok(())
    }

    /// Every provider id the billed rows in `[start, end]` carry, bare, with
    /// the row's model: the id in each row's dedupe key (`cc:<request id>` /
    /// `cc:msg:<id>` for RUN, without the prefix) and its recorded message
    /// id — what a gateway's request log is matched against, and what tells
    /// a gateway's model name from the ledger's.
    pub fn ledger_ids_with_model_between(&self, start_iso: &str, end_iso: &str) -> AppResult<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT idempotency_key, provider_msg_id, model FROM spend_events
             WHERE ts_utc >= ?1 AND ts_utc <= ?2 AND idempotency_key IS NOT NULL",
        )?;
        let mut out = Vec::new();
        for row in stmt.query_map(params![start_iso, end_iso], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, String>(2)?))
        })? {
            let (key, msg, model) = row?;
            out.push((crate::gateway::bare_ledger_id(&key).to_string(), model.clone()));
            if let Some(m) = msg.filter(|m| !m.is_empty()) {
                out.push((m, model));
            }
        }
        Ok(out)
    }

    /// The Usage page's report over one date range, optionally one surface
    /// (`talk` / `run` / `review` / `direct` / `adhoc`). Reads the canonical
    /// `spend_events` ledger directly (the `all_spend` view has no surface).
    ///
    /// Cache hit ratio is `cache_read / (input + cache_read + cache_create)`:
    /// the share of prompt tokens that were served from cache. Cache WRITES
    /// are misses (they are billed at a premium, not saved), and a slice
    /// whose rows report no cache tokens at all is `cache_tracked = false`
    /// with no ratio — "0%" would claim the provider caches nothing when we
    /// simply weren't told.
    ///
    /// `utc_offset_minutes` is the viewer's local offset (JS
    /// `-getTimezoneOffset()`): day buckets and the active-day count follow
    /// the user's calendar, not UTC's.
    pub fn usage_report(
        &self,
        start_iso: &str,
        end_iso: &str,
        surface: Option<&str>,
        utc_offset_minutes: i32,
    ) -> AppResult<UsageReport> {
        let surface_and = if surface.is_some() { "AND surface = ?3" } else { "" };
        let sf = surface.unwrap_or("").to_string();
        let shift = format!("{utc_offset_minutes} minutes");
        let slice_cols = "COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                          COALESCE(SUM(cache_read_tokens),0), COALESCE(SUM(cache_creation_tokens),0),
                          COALESCE(SUM(cost_usd),0), COUNT(*)";
        let slice_of = |r: &rusqlite::Row, at: usize| -> rusqlite::Result<UsageSlice> {
            Ok(UsageSlice::new(
                r.get::<_, i64>(at)?,
                r.get::<_, i64>(at + 1)?,
                r.get::<_, i64>(at + 2)?,
                r.get::<_, i64>(at + 3)?,
                r.get::<_, f64>(at + 4)?,
                r.get::<_, i64>(at + 5)?,
            ))
        };

        let totals = {
            let sql = format!(
                "SELECT {slice_cols} FROM spend_events
                 WHERE ts_utc >= ?1 AND ts_utc <= ?2 {surface_and}"
            );
            let mut stmt = self.conn.prepare(&sql)?;
            if surface.is_some() {
                stmt.query_row(params![start_iso, end_iso, sf], |r| slice_of(r, 0))?
            } else {
                stmt.query_row(params![start_iso, end_iso], |r| slice_of(r, 0))?
            }
        };

        let by_surface = {
            let sql = format!(
                "SELECT surface, {slice_cols} FROM spend_events
                 WHERE ts_utc >= ?1 AND ts_utc <= ?2 {surface_and}
                 GROUP BY surface ORDER BY 6 DESC"
            );
            let map = |r: &rusqlite::Row| -> rusqlite::Result<SurfaceUsage> {
                Ok(SurfaceUsage { surface: r.get(0)?, usage: slice_of(r, 1)? })
            };
            let mut stmt = self.conn.prepare(&sql)?;
            if surface.is_some() {
                stmt.query_map(params![start_iso, end_iso, sf], map)?.collect::<Result<Vec<_>, _>>()?
            } else {
                stmt.query_map(params![start_iso, end_iso], map)?.collect::<Result<Vec<_>, _>>()?
            }
        };

        let by_model = {
            let sql = format!(
                "SELECT model, {slice_cols},
                        COALESCE(SUM(CASE WHEN cost_basis = 'unpriced' THEN 1 ELSE 0 END), 0)
                 FROM spend_events
                 WHERE ts_utc >= ?1 AND ts_utc <= ?2 {surface_and}
                 GROUP BY model ORDER BY 6 DESC LIMIT 30"
            );
            let map = |r: &rusqlite::Row| -> rusqlite::Result<ModelUsage> {
                Ok(ModelUsage { model: r.get(0)?, usage: slice_of(r, 1)?, unpriced_calls: r.get(7)? })
            };
            let mut stmt = self.conn.prepare(&sql)?;
            if surface.is_some() {
                stmt.query_map(params![start_iso, end_iso, sf], map)?.collect::<Result<Vec<_>, _>>()?
            } else {
                stmt.query_map(params![start_iso, end_iso], map)?.collect::<Result<Vec<_>, _>>()?
            }
        };

        // Where it went: one row per workspace (TALK/REVIEW/DIRECT and RUN
        // sessions opened on a worktree) or RUN session (plain terminals),
        // labelled by name, with its per-surface split for the stacked bar.
        let by_source = {
            let sql = format!(
                "SELECT e.k,
                        COALESCE(w.name, s.name, e.k) AS label,
                        CASE WHEN w.id IS NOT NULL THEN 'workspace'
                             WHEN s.id IS NOT NULL THEN 'session'
                             ELSE 'other' END AS kind,
                        p.name,
                        MAX(e.ts_utc),
                        {slice_cols}
                 FROM (SELECT COALESCE(workspace_id,
                                       (SELECT t.workspace_id FROM terminals t WHERE t.id = source_id),
                                       source_id, 'unattributed') AS k, *
                       FROM spend_events
                       WHERE ts_utc >= ?1 AND ts_utc <= ?2 {surface_and}) e
                 LEFT JOIN workspaces w ON w.id = e.k
                 LEFT JOIN sessions s ON s.id = e.k
                 LEFT JOIN projects p ON p.id = w.project_id
                 GROUP BY e.k ORDER BY 10 DESC LIMIT 25"
            );
            let map = |r: &rusqlite::Row| -> rusqlite::Result<SourceUsage> {
                Ok(SourceUsage {
                    id: r.get(0)?,
                    label: r.get(1)?,
                    kind: r.get(2)?,
                    project: r.get(3)?,
                    last_ts: r.get(4)?,
                    usage: slice_of(r, 5)?,
                    surfaces: Vec::new(),
                })
            };
            let mut stmt = self.conn.prepare(&sql)?;
            let mut rows: Vec<SourceUsage> = if surface.is_some() {
                stmt.query_map(params![start_iso, end_iso, sf], map)?.collect::<Result<Vec<_>, _>>()?
            } else {
                stmt.query_map(params![start_iso, end_iso], map)?.collect::<Result<Vec<_>, _>>()?
            };
            let split_sql = format!(
                "SELECT COALESCE(workspace_id,
                                 (SELECT t.workspace_id FROM terminals t WHERE t.id = source_id),
                                 source_id, 'unattributed'), surface, COALESCE(SUM(cost_usd),0)
                 FROM spend_events
                 WHERE ts_utc >= ?1 AND ts_utc <= ?2 {surface_and}
                 GROUP BY 1, 2"
            );
            let split_map = |r: &rusqlite::Row| -> rusqlite::Result<(String, String, f64)> {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            };
            let mut stmt = self.conn.prepare(&split_sql)?;
            let splits: Vec<(String, String, f64)> = if surface.is_some() {
                stmt.query_map(params![start_iso, end_iso, sf], split_map)?.collect::<Result<Vec<_>, _>>()?
            } else {
                stmt.query_map(params![start_iso, end_iso], split_map)?.collect::<Result<Vec<_>, _>>()?
            };
            for (k, sfc, cost) in splits {
                if let Some(row) = rows.iter_mut().find(|r| r.id == k) {
                    row.surfaces.push(SurfaceCost { surface: sfc, cost_usd: cost });
                }
            }
            for row in &mut rows {
                row.surfaces.sort_by(|a, b| b.cost_usd.total_cmp(&a.cost_usd));
            }
            rows
        };

        // Trend: hourly for a window of two days or less, daily beyond.
        let span_hours = match (
            chrono::DateTime::parse_from_rfc3339(start_iso),
            chrono::DateTime::parse_from_rfc3339(end_iso),
        ) {
            (Ok(a), Ok(b)) => (b - a).num_hours(),
            _ => 24 * 30,
        };
        let trend_bucket = if span_hours <= 48 { "hour" } else { "day" };
        let bucket_fmt = if trend_bucket == "hour" { "%Y-%m-%dT%H:00" } else { "%Y-%m-%d" };
        let trend = {
            let sql = format!(
                "SELECT strftime(?4, ts_utc, ?5) AS b,
                        COALESCE(SUM(cost_usd),0), COALESCE(SUM(input_tokens + output_tokens),0)
                 FROM spend_events
                 WHERE ts_utc >= ?1 AND ts_utc <= ?2 {surface_and}
                 GROUP BY b HAVING b IS NOT NULL ORDER BY b"
            );
            let map = |r: &rusqlite::Row| -> rusqlite::Result<UsageTrendPoint> {
                Ok(UsageTrendPoint {
                    bucket: r.get(0)?,
                    cost_usd: r.get(1)?,
                    tokens: r.get::<_, i64>(2)?.max(0) as u64,
                })
            };
            let mut stmt = self.conn.prepare(&sql)?;
            if surface.is_some() {
                stmt.query_map(params![start_iso, end_iso, sf, bucket_fmt, shift], map)?
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                // ?3 is unused without a surface filter; bind a placeholder so
                // the numbered parameters line up.
                stmt.query_map(params![start_iso, end_iso, "", bucket_fmt, shift], map)?
                    .collect::<Result<Vec<_>, _>>()?
            }
        };

        let active_days: i64 = {
            let sql = format!(
                "SELECT COUNT(DISTINCT strftime('%Y-%m-%d', ts_utc, ?4))
                 FROM spend_events
                 WHERE ts_utc >= ?1 AND ts_utc <= ?2 {surface_and}"
            );
            let mut stmt = self.conn.prepare(&sql)?;
            if surface.is_some() {
                stmt.query_row(params![start_iso, end_iso, sf, shift], |r| r.get(0))?
            } else {
                stmt.query_row(params![start_iso, end_iso, "", shift], |r| r.get(0))?
            }
        };
        let per_active_day_usd = if active_days > 0 {
            totals.cost_usd / active_days as f64
        } else {
            0.0
        };

        // Rolling last 24h regardless of the range — the burn rate right now.
        let last_24h_usd: f64 = {
            let cutoff = (Utc::now() - chrono::Duration::hours(24)).to_rfc3339();
            let sql = format!(
                "SELECT COALESCE(SUM(cost_usd),0) FROM spend_events
                 WHERE ts_utc >= ?1 {}",
                if surface.is_some() { "AND surface = ?2" } else { "" }
            );
            let mut stmt = self.conn.prepare(&sql)?;
            if surface.is_some() {
                stmt.query_row(params![cutoff, sf], |r| r.get(0))?
            } else {
                stmt.query_row(params![cutoff], |r| r.get(0))?
            }
        };

        // Rows the ledger could not price (unknown model / unpriced cloud
        // catalog entry), marked `cost_basis = 'unpriced'` at record time or
        // by `reprice_unpriced` (which also classifies legacy rows). A local
        // model's $0, a subscription-covered or a provider-reported $0 is a
        // real price, not a gap.
        let unpriced_calls: i64 = {
            let sql = format!(
                "SELECT COUNT(*) FROM spend_events
                 WHERE ts_utc >= ?1 AND ts_utc <= ?2 {surface_and}
                   AND cost_basis = 'unpriced'"
            );
            let mut stmt = self.conn.prepare(&sql)?;
            if surface.is_some() {
                stmt.query_row(params![start_iso, end_iso, sf], |r| r.get(0))?
            } else {
                stmt.query_row(params![start_iso, end_iso], |r| r.get(0))?
            }
        };

        Ok(UsageReport {
            start: start_iso.to_string(),
            end: end_iso.to_string(),
            surface: surface.map(str::to_string),
            totals,
            by_surface,
            by_model,
            by_source,
            trend,
            trend_bucket: trend_bucket.to_string(),
            active_days,
            per_active_day_usd,
            last_24h_usd,
            unpriced_calls,
            pricing_refreshed_at: None,
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
    ) -> AppResult<Vec<ProjectListRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path, last_opened, jira_project_key, pinned, tint, group_id FROM projects \
             WHERE closed_at IS NULL \
             ORDER BY pinned DESC, sort_order IS NULL, sort_order ASC, created_at ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get::<_, i64>(5)? != 0, r.get(6)?, r.get(7)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn get_project(&self, project_id: &str) -> AppResult<Option<crate::commands::ProjectInfo>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path, jira_project_key, pinned, tint, group_id FROM projects WHERE id = ?1",
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
                    group_id: r.get(6)?,
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

    /// The project's setup-script template ("" when none, or no such project).
    pub fn get_project_setup_script(&self, id: &str) -> AppResult<String> {
        let script: Option<String> = self
            .conn
            .query_row(
                "SELECT setup_script FROM projects WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(script.unwrap_or_default())
    }

    pub fn set_project_setup_script(&self, id: &str, script: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE projects SET setup_script = ?1 WHERE id = ?2",
            params![script, id],
        )?;
        Ok(())
    }

    /// What the project shares with new missions (nothing when unset, or no
    /// such project). Read leniently and sanitized.
    pub fn get_project_share(&self, id: &str) -> AppResult<crate::worktree_share::ShareSpec> {
        let raw: Option<String> = self
            .conn
            .query_row(
                "SELECT share_with_missions FROM projects WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(crate::worktree_share::ShareSpec::from_stored(&raw.unwrap_or_default()))
    }

    pub fn set_project_share(&self, id: &str, spec: &crate::worktree_share::ShareSpec) -> AppResult<()> {
        let spec = spec.sanitized();
        let raw = if spec.is_empty() { String::new() } else { serde_json::to_string(&spec).unwrap_or_default() };
        self.conn.execute(
            "UPDATE projects SET share_with_missions = ?1 WHERE id = ?2",
            params![raw, id],
        )?;
        Ok(())
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
    ) -> AppResult<Vec<ProjectListRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path, last_opened, jira_project_key, pinned, tint, group_id FROM projects \
             WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 10",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get::<_, i64>(5)? != 0, r.get(6)?, r.get(7)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn delete_project(&self, id: &str) -> AppResult<()> {
        self.conn.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ─── Rail groups ──────────────────────────────────────────────

    fn row_to_group(r: &rusqlite::Row) -> rusqlite::Result<GroupRow> {
        Ok(GroupRow {
            id: r.get(0)?,
            scope: r.get(1)?,
            project_id: r.get(2)?,
            name: r.get(3)?,
            tint: r.get(4)?,
            sort_order: r.get(5)?,
            created_at: r.get(6)?,
        })
    }

    /// Every group, both scopes: project groups first, then workspace groups
    /// project by project, each run in `sort_order`.
    pub fn list_groups(&self) -> AppResult<Vec<GroupRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, scope, project_id, name, tint, sort_order, created_at FROM groups
             ORDER BY scope ASC, project_id ASC, sort_order ASC, created_at ASC",
        )?;
        let rows = stmt.query_map([], Self::row_to_group)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn get_group(&self, id: &str) -> AppResult<Option<GroupRow>> {
        self.conn
            .query_row(
                "SELECT id, scope, project_id, name, tint, sort_order, created_at FROM groups WHERE id = ?1",
                params![id],
                Self::row_to_group,
            )
            .optional()
            .map_err(Into::into)
    }

    /// Check that an item may join a group of `group_scope` owned by
    /// `group_project`. `kind` is `project` or `workspace`; a group only holds
    /// items of its own scope, and a workspace group only its project's.
    fn ensure_item_fits_group(
        &self,
        kind: &str,
        item_id: &str,
        group_scope: &str,
        group_project: Option<&str>,
    ) -> AppResult<()> {
        match kind {
            "project" => {
                self.ensure_group_item_exists(kind, item_id)?;
                if group_scope != "project" {
                    return Err(group_error("A project can only join a project group."));
                }
            }
            "workspace" => {
                let owner = self.ensure_group_item_exists(kind, item_id)?;
                if group_scope != "workspace" {
                    return Err(group_error("A workspace can only join a workspace group."));
                }
                if owner.as_deref() != group_project {
                    return Err(group_error("A workspace can only join a group in its own project."));
                }
            }
            other => return Err(unknown_group_item_kind(other)),
        }
        Ok(())
    }

    /// Check that the item exists. Returns a workspace's project id (None for
    /// a project).
    fn ensure_group_item_exists(&self, kind: &str, item_id: &str) -> AppResult<Option<String>> {
        match kind {
            "project" => {
                let found: Option<i64> = self
                    .conn
                    .query_row("SELECT 1 FROM projects WHERE id = ?1", params![item_id], |r| r.get(0))
                    .optional()?;
                found.map(|_| None).ok_or_else(|| group_error("Project not found."))
            }
            "workspace" => {
                let owner: Option<String> = self
                    .conn
                    .query_row(
                        "SELECT project_id FROM workspaces WHERE id = ?1",
                        params![item_id],
                        |r| r.get(0),
                    )
                    .optional()?;
                owner.map(Some).ok_or_else(|| group_error("Workspace not found."))
            }
            other => Err(unknown_group_item_kind(other)),
        }
    }

    /// Where a new group goes among its siblings (the groups of the same scope
    /// and project). With no members it goes last. With members it takes the
    /// place of its first member in rail order: before the first sibling whose
    /// own first member comes later. Siblings that are empty keep their place.
    /// Rail order is `list_projects`' for projects and `created_at` for
    /// workspaces; closed projects and archived workspaces count too, so the
    /// answer doesn't depend on what the rail hides.
    fn new_group_sort_order(
        &self,
        scope: &str,
        project_id: Option<&str>,
        member_ids: &[String],
    ) -> AppResult<i64> {
        let siblings: Vec<(String, i64)> = {
            let mut stmt = self.conn.prepare(
                "SELECT id, sort_order FROM groups WHERE scope = ?1 AND project_id IS ?2
                 ORDER BY sort_order ASC, created_at ASC",
            )?;
            let rows = stmt.query_map(params![scope, project_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let last = siblings.iter().map(|(_, order)| *order + 1).max().unwrap_or(0);
        if member_ids.is_empty() {
            return Ok(last);
        }
        // (item id, its current group) in rail order.
        let items: Vec<(String, Option<String>)> = if scope == "project" {
            let mut stmt = self.conn.prepare(
                "SELECT id, group_id FROM projects
                 ORDER BY pinned DESC, sort_order IS NULL, sort_order ASC, created_at ASC, rowid ASC",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<Result<Vec<_>, _>>()?
        } else {
            let mut stmt = self.conn.prepare(
                "SELECT id, group_id FROM workspaces WHERE project_id = ?1
                 ORDER BY created_at ASC, rowid ASC",
            )?;
            let rows = stmt.query_map(params![project_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let Some(first_member) = items.iter().position(|(id, _)| member_ids.contains(id)) else {
            return Ok(last);
        };
        // Each sibling's first member that stays with it (the new group's
        // members are leaving theirs).
        let mut sibling_first: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
        for (idx, (id, group)) in items.iter().enumerate() {
            let Some(group) = group else { continue };
            if !member_ids.contains(id) {
                sibling_first.entry(group.as_str()).or_insert(idx);
            }
        }
        for (id, order) in &siblings {
            if sibling_first.get(id.as_str()).is_some_and(|first| *first > first_member) {
                return Ok(*order);
            }
        }
        Ok(last)
    }

    /// Create a group and move `member_ids` into it, in one transaction. The
    /// group is placed by [`Self::new_group_sort_order`]; siblings at or after
    /// that place shift down by one. A member that was in another group leaves
    /// it (one membership per item).
    pub fn create_group(
        &self,
        scope: &str,
        project_id: Option<&str>,
        name: &str,
        tint: Option<&str>,
        member_ids: &[String],
    ) -> AppResult<GroupRow> {
        let name = normalize_group_name(name)?;
        let tint = normalize_group_tint(tint)?;
        let project_id = normalize_optional(project_id);
        match scope {
            "project" => {
                if project_id.is_some() {
                    return Err(group_error("A project group cannot belong to a project."));
                }
            }
            "workspace" => {
                let Some(pid) = project_id.as_deref() else {
                    return Err(group_error("A workspace group needs the project it belongs to."));
                };
                self.ensure_group_item_exists("project", pid)?;
            }
            other => {
                return Err(group_error(format!(
                    "Unknown group scope '{other}'. Use 'project' or 'workspace'."
                )))
            }
        }
        // IMMEDIATE: the checks and the placement read before anything is
        // written, and another process (octopush-mcp, a run worker) may write
        // in between. Taking the write lock up front waits for it (busy
        // timeout) instead of failing the upgrade from a stale read.
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        for member in member_ids {
            self.ensure_item_fits_group(scope, member, scope, project_id.as_deref())?;
        }
        let sort_order = self.new_group_sort_order(scope, project_id.as_deref(), member_ids)?;
        tx.execute(
            "UPDATE groups SET sort_order = sort_order + 1
             WHERE scope = ?1 AND project_id IS ?2 AND sort_order >= ?3",
            params![scope, project_id, sort_order],
        )?;
        let group = GroupRow {
            id: uuid::Uuid::new_v4().to_string(),
            scope: scope.to_string(),
            project_id,
            name,
            tint,
            sort_order,
            created_at: Utc::now().to_rfc3339(),
        };
        tx.execute(
            "INSERT INTO groups (id, scope, project_id, name, tint, sort_order, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![group.id, group.scope, group.project_id, group.name, group.tint, group.sort_order, group.created_at],
        )?;
        let assign = if scope == "project" {
            "UPDATE projects SET group_id = ?1 WHERE id = ?2"
        } else {
            "UPDATE workspaces SET group_id = ?1 WHERE id = ?2"
        };
        for member in member_ids {
            tx.execute(assign, params![group.id, member])?;
        }
        tx.commit()?;
        Ok(group)
    }

    /// Rename a group. The name is trimmed; an empty one is refused.
    pub fn rename_group(&self, id: &str, name: &str) -> AppResult<()> {
        let name = normalize_group_name(name)?;
        let changed = self
            .conn
            .execute("UPDATE groups SET name = ?1 WHERE id = ?2", params![name, id])?;
        group_found(changed)
    }

    /// Set or clear (None or blank) a group's tint. Only [`GROUP_TINTS`] pass.
    pub fn set_group_tint(&self, id: &str, tint: Option<&str>) -> AppResult<()> {
        let tint = normalize_group_tint(tint)?;
        let changed = self
            .conn
            .execute("UPDATE groups SET tint = ?1 WHERE id = ?2", params![tint, id])?;
        group_found(changed)
    }

    /// Persist a manual order: each id gets its index in `ids` as `sort_order`,
    /// like `set_project_order`. Pass the sibling groups of one scope (and
    /// project) in their new order; ids that match no group are ignored.
    pub fn set_group_order(&self, ids: &[String]) -> AppResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        for (idx, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE groups SET sort_order = ?1 WHERE id = ?2",
                params![idx as i64, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Delete a group and keep its members: their `group_id` is cleared in the
    /// same transaction (archived workspaces and closed projects included).
    pub fn delete_group(&self, id: &str) -> AppResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("UPDATE projects SET group_id = NULL WHERE group_id = ?1", params![id])?;
        tx.execute("UPDATE workspaces SET group_id = NULL WHERE group_id = ?1", params![id])?;
        tx.execute("DELETE FROM groups WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    /// Move a project or workspace into a group, or out of any group
    /// (`group_id` None). Refuses a group of the other scope and a workspace
    /// group of another project. An item is in at most one group, so joining
    /// one leaves the previous.
    pub fn set_item_group(&self, kind: &str, item_id: &str, group_id: Option<&str>) -> AppResult<()> {
        match group_id {
            Some(gid) => {
                // Name an unknown kind before an unknown group.
                if !matches!(kind, "project" | "workspace") {
                    return Err(unknown_group_item_kind(kind));
                }
                let group = self
                    .get_group(gid)?
                    .ok_or_else(|| group_error("Group not found."))?;
                self.ensure_item_fits_group(kind, item_id, &group.scope, group.project_id.as_deref())?;
            }
            None => {
                self.ensure_group_item_exists(kind, item_id)?;
            }
        }
        let sql = if kind == "project" {
            "UPDATE projects SET group_id = ?1 WHERE id = ?2"
        } else {
            "UPDATE workspaces SET group_id = ?1 WHERE id = ?2"
        };
        self.conn.execute(sql, params![group_id, item_id])?;
        Ok(())
    }

    /// Move several projects or workspaces (one `kind`) into a group, or out of
    /// any, in one transaction: every item is checked like [`Self::set_item_group`]
    /// checks one, and a single refusal leaves them all where they were.
    pub fn set_items_group(&self, kind: &str, item_ids: &[String], group_id: Option<&str>) -> AppResult<()> {
        if !matches!(kind, "project" | "workspace") {
            return Err(unknown_group_item_kind(kind));
        }
        // IMMEDIATE, like `create_group`: the checks read before the writes.
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let group = match group_id {
            Some(gid) => Some(self.get_group(gid)?.ok_or_else(|| group_error("Group not found."))?),
            None => None,
        };
        for item_id in item_ids {
            match &group {
                Some(g) => self.ensure_item_fits_group(kind, item_id, &g.scope, g.project_id.as_deref())?,
                None => {
                    self.ensure_group_item_exists(kind, item_id)?;
                }
            }
        }
        let sql = if kind == "project" {
            "UPDATE projects SET group_id = ?1 WHERE id = ?2"
        } else {
            "UPDATE workspaces SET group_id = ?1 WHERE id = ?2"
        };
        for item_id in item_ids {
            tx.execute(sql, params![group_id, item_id])?;
        }
        tx.commit()?;
        Ok(())
    }

    // ─── Prerequisites ("Starts after", #960) ─────────────────────

    /// The mission `workspace_id` waits on, or None when it has no link.
    pub fn get_workspace_prerequisite(&self, workspace_id: &str) -> AppResult<Option<PrerequisiteRow>> {
        let row: Option<(Option<String>, Option<String>, i64, i64)> = self
            .conn
            .query_row(
                "SELECT after_workspace_id, after_condition, branch_from_prerequisite, auto_start
                 FROM workspaces WHERE id = ?1",
                params![workspace_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let (after, condition, branch_from, auto_start) =
            row.ok_or_else(|| prerequisite_error("Mission not found."))?;
        Ok(match (after, condition) {
            (Some(after_workspace_id), Some(after_condition)) => Some(PrerequisiteRow {
                workspace_id: workspace_id.to_string(),
                after_workspace_id,
                after_condition,
                branch_from_prerequisite: branch_from != 0,
                auto_start: auto_start != 0,
            }),
            _ => None,
        })
    }

    /// Every link of `project_id`'s active (not archived) missions, oldest
    /// mission first.
    pub fn list_workspace_prerequisites(&self, project_id: &str) -> AppResult<Vec<PrerequisiteRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, after_workspace_id, after_condition, branch_from_prerequisite, auto_start
             FROM workspaces
             WHERE project_id = ?1 AND status != 'archived'
               AND after_workspace_id IS NOT NULL AND after_condition IS NOT NULL
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![project_id], |r| {
            Ok(PrerequisiteRow {
                workspace_id: r.get(0)?,
                after_workspace_id: r.get(1)?,
                after_condition: r.get(2)?,
                branch_from_prerequisite: r.get::<_, i64>(3)? != 0,
                auto_start: r.get::<_, i64>(4)? != 0,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Make `workspace_id` wait on `after_workspace_id` until `condition`
    /// (one of [`PREREQUISITE_CONDITIONS`]), replacing any earlier link.
    /// Refuses an unknown condition, a missing or archived prerequisite, one
    /// from another project, and any link that would close a cycle (itself
    /// included).
    pub fn set_workspace_prerequisite(
        &self,
        workspace_id: &str,
        after_workspace_id: &str,
        condition: &str,
        branch_from_prerequisite: bool,
        auto_start: bool,
    ) -> AppResult<PrerequisiteRow> {
        if !PREREQUISITE_CONDITIONS.contains(&condition) {
            return Err(prerequisite_error(format!(
                "Unknown condition '{condition}'. Use one of: {}.",
                PREREQUISITE_CONDITIONS.join(", ")
            )));
        }
        // IMMEDIATE, like `set_items_group`: the checks read before the write.
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let lookup = |id: &str| -> AppResult<Option<(String, String)>> {
            Ok(self
                .conn
                .query_row(
                    "SELECT project_id, status FROM workspaces WHERE id = ?1",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?)
        };
        let (project, _) = lookup(workspace_id)?.ok_or_else(|| prerequisite_error("Mission not found."))?;
        let (after_project, after_status) = lookup(after_workspace_id)?
            .ok_or_else(|| prerequisite_error("The mission to wait on was not found."))?;
        if after_status == "archived" {
            return Err(prerequisite_error("A mission can't wait on an archived mission."));
        }
        if after_project != project {
            return Err(prerequisite_error("A mission can only wait on a mission of its own project."));
        }
        // Walk the chain up from the prerequisite: reaching `workspace_id`
        // means the new link would close a loop. `seen` stops on a loop that
        // somehow exists already.
        let mut seen = std::collections::HashSet::new();
        let mut cursor = Some(after_workspace_id.to_string());
        while let Some(id) = cursor {
            if id == workspace_id {
                return Err(prerequisite_error("These missions would wait on each other."));
            }
            if !seen.insert(id.clone()) {
                break;
            }
            cursor = self
                .conn
                .query_row(
                    "SELECT after_workspace_id FROM workspaces WHERE id = ?1",
                    params![id],
                    |r| r.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten();
        }
        tx.execute(
            "UPDATE workspaces SET after_workspace_id = ?2, after_condition = ?3,
                    branch_from_prerequisite = ?4, auto_start = ?5
             WHERE id = ?1",
            params![
                workspace_id,
                after_workspace_id,
                condition,
                branch_from_prerequisite as i64,
                auto_start as i64
            ],
        )?;
        tx.commit()?;
        Ok(PrerequisiteRow {
            workspace_id: workspace_id.to_string(),
            after_workspace_id: after_workspace_id.to_string(),
            after_condition: condition.to_string(),
            branch_from_prerequisite,
            auto_start,
        })
    }

    /// Remove `workspace_id`'s prerequisite, if it has one.
    pub fn clear_workspace_prerequisite(&self, workspace_id: &str) -> AppResult<()> {
        let changed = self.conn.execute(
            "UPDATE workspaces SET after_workspace_id = NULL, after_condition = NULL,
                    branch_from_prerequisite = 0, auto_start = 0
             WHERE id = ?1",
            params![workspace_id],
        )?;
        if changed == 0 {
            return Err(prerequisite_error("Mission not found."));
        }
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
            "SELECT id, project_id, name, task, branch, worktree_path, setup_script, status, created_at, last_active, glyph, tint, test_command, linked_issue_key, from_branch, group_id
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
                group_id: r.get(15)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn get_workspace(&self, workspace_id: &str) -> AppResult<Option<WorkspaceRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project_id, name, task, branch, worktree_path, setup_script, status, created_at, last_active, glyph, tint, test_command, linked_issue_key, from_branch, group_id
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
                    group_id: r.get(15)?,
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

    /// The `git_isolation` of an active mission on this workspace that DIFFERS
    /// from `git_isolation`, if any. Keeps one checkout to a single isolation
    /// mode — the invariant the `active_mission_for_workspace`-based confinement
    /// resolution relies on (a readonly + writer mix on one checkout would be
    /// unsafe). `None` = no conflict.
    pub fn conflicting_active_isolation(
        &self,
        workspace_id: &str,
        git_isolation: &str,
    ) -> AppResult<Option<String>> {
        self.conn
            .query_row(
                "SELECT git_isolation FROM missions
                 WHERE workspace_id = ?1 AND status = 'active' AND git_isolation != ?2 LIMIT 1",
                params![workspace_id, git_isolation],
                |r| r.get(0),
            )
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

    /// Update a mission's two axes in place (used when the wizard is re-run for
    /// an already-paired workspace with a different intent/isolation). Safe re:
    /// the writer index — it updates one existing row, never adds a second.
    pub fn update_mission_axes(
        &self,
        mission_id: &str,
        intent: &str,
        git_isolation: &str,
    ) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE missions SET intent = ?2, git_isolation = ?3, updated_at = ?4 WHERE id = ?1",
            params![mission_id, intent, git_isolation, now],
        )?;
        Ok(())
    }

    /// Set a mission's execution isolation in place (the wizard's Execution
    /// choice, applied after `ensure_for_workspace` on both create and reuse so
    /// the picked value is honored without churning the pairing signature).
    pub fn update_mission_exec_isolation(&self, mission_id: &str, exec_isolation: &str) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE missions SET exec_isolation = ?2, updated_at = ?3 WHERE id = ?1",
            params![mission_id, exec_isolation, now],
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

    /// Total (cost_usd, tokens) attributed to a mission in `[from, to]` — the
    /// cost half of the Logbook. Rolls up `spend_events` by the denormalized
    /// `mission_id`, so it covers talk/review/direct (the surfaces that resolve
    /// a workspace); RUN/adhoc spend is unattributed and excluded.
    pub fn mission_spend(&self, mission_id: &str, from: &str, to: &str) -> AppResult<(f64, i64)> {
        let row = self.conn.query_row(
            "SELECT COALESCE(SUM(cost_usd), 0.0),
                    COALESCE(SUM(input_tokens + output_tokens), 0)
             FROM spend_events
             WHERE mission_id = ?1 AND ts_utc >= ?2 AND ts_utc <= ?3",
            params![mission_id, from, to],
            |r| Ok((r.get::<_, f64>(0)?, r.get::<_, i64>(1)?)),
        )?;
        Ok(row)
    }

    /// Record a coalesced activity beat for a workspace (Logbook hours). Extends
    /// the most recent `(workspace, surface)` span if it's within the 10-minute
    /// idle window, else opens a fresh one — so ongoing work grows no rows. A
    /// workspace with no active mission still records a project-scoped span.
    pub fn record_activity(&self, workspace_id: &str, surface: &str, source: &str) -> AppResult<()> {
        let now = Utc::now();
        let now_s = now.to_rfc3339();
        let cutoff = (now - chrono::Duration::minutes(10)).to_rfc3339();
        let project_id: Option<String> = self
            .conn
            .query_row(
                "SELECT project_id FROM workspaces WHERE id = ?1",
                params![workspace_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(project_id) = project_id else { return Ok(()) }; // workspace gone
        let mission_id = self.active_mission_for_workspace(workspace_id)?.map(|m| m.id);
        // All work_spans timestamps come from Utc::now().to_rfc3339() (same
        // format + offset), so a string `>` on ended_at is chronological. Match
        // on mission_id too (`IS` so NULL==NULL): if the workspace's active
        // mission changed mid-window we must open a fresh span, not extend the
        // old mission's — otherwise worked time is attributed to the wrong one.
        let recent: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM work_spans
                 WHERE workspace_id = ?1 AND surface = ?2 AND ended_at > ?3 AND mission_id IS ?4
                 ORDER BY ended_at DESC LIMIT 1",
                params![workspace_id, surface, cutoff, mission_id],
                |r| r.get(0),
            )
            .optional()?;
        match recent {
            Some(id) => {
                self.conn
                    .execute("UPDATE work_spans SET ended_at = ?2 WHERE id = ?1", params![id, now_s])?;
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                self.conn.execute(
                    "INSERT INTO work_spans
                        (id, mission_id, workspace_id, project_id, surface, source, started_at, ended_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?7)",
                    params![id, mission_id, workspace_id, project_id, surface, source, now_s],
                )?;
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn work_span_count_for_test(&self) -> i64 {
        self.conn
            .query_row("SELECT COUNT(*) FROM work_spans", [], |r| r.get(0))
            .unwrap()
    }

    #[cfg(test)]
    pub fn insert_work_span_for_test(
        &self,
        mission_id: &str,
        workspace_id: &str,
        project_id: &str,
        surface: &str,
        started_at: &str,
        ended_at: &str,
    ) {
        let id = uuid::Uuid::new_v4().to_string();
        self.conn
            .execute(
                "INSERT INTO work_spans (id, mission_id, workspace_id, project_id, surface, source, started_at, ended_at)
                 VALUES (?1,?2,?3,?4,?5,'test',?6,?7)",
                params![id, mission_id, workspace_id, project_id, surface, started_at, ended_at],
            )
            .unwrap();
    }

    /// Worked seconds for a mission in `[from, to]` = the UNION of its span
    /// intervals (overlapping surfaces counted once), plus a display-only
    /// per-surface breakdown (raw, may exceed the union).
    fn mission_spans_summary(
        &self,
        mission_id: &str,
        from: &str,
        to: &str,
    ) -> AppResult<(i64, Vec<LogbookSurfaceSecs>)> {
        let mut stmt = self.conn.prepare(
            "SELECT surface, started_at, ended_at FROM work_spans
             WHERE mission_id = ?1 AND started_at <= ?3 AND ended_at >= ?2
             ORDER BY started_at ASC",
        )?;
        let rows: Vec<(String, String, String)> = stmt
            .query_map(params![mission_id, from, to], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        let (from_s, to_s) = (parse_epoch(from), parse_epoch(to));
        let mut intervals: Vec<(i64, i64)> = Vec::new();
        let mut per: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        for (surface, s, e) in &rows {
            let a = parse_epoch(s).max(from_s);
            let b = parse_epoch(e).min(to_s);
            if b <= a {
                continue;
            }
            intervals.push((a, b));
            *per.entry(surface.clone()).or_insert(0) += b - a;
        }
        intervals.sort_by_key(|iv| iv.0);
        let mut total = 0i64;
        let mut cur: Option<(i64, i64)> = None;
        for (a, b) in intervals {
            match cur {
                None => cur = Some((a, b)),
                Some((ca, cb)) if a <= cb => cur = Some((ca, cb.max(b))),
                Some((ca, cb)) => {
                    total += cb - ca;
                    cur = Some((a, b));
                }
            }
        }
        if let Some((ca, cb)) = cur {
            total += cb - ca;
        }
        let mut per_vec: Vec<LogbookSurfaceSecs> =
            per.into_iter().map(|(surface, secs)| LogbookSurfaceSecs { surface, secs }).collect();
        per_vec.sort_by(|a, b| b.secs.cmp(&a.secs));
        Ok((total, per_vec))
    }

    /// (savings_usd, runs_count) for a mission's DIRECT runs in `[from, to]`.
    /// Savings = baseline − actual, DIRECT-only (only runs carry a baseline).
    fn mission_run_stats(&self, mission_id: &str, from: &str, to: &str) -> AppResult<(f64, i64)> {
        self.conn
            .query_row(
                "SELECT COALESCE(SUM(MAX(baseline_usd - cost_usd, 0)), 0.0), COUNT(*)
                 FROM runs WHERE mission_id = ?1 AND created_at >= ?2 AND created_at <= ?3",
                params![mission_id, from, to],
                |r| Ok((r.get::<_, f64>(0)?, r.get::<_, i64>(1)?)),
            )
            .map_err(Into::into)
    }

    fn mission_message_count(&self, mission_id: &str, from: &str, to: &str) -> AppResult<i64> {
        self.conn
            .query_row(
                "SELECT COUNT(*) FROM chat_messages cm
                 JOIN chat_threads ct ON ct.id = cm.thread_id
                 WHERE ct.mission_id = ?1 AND cm.created_at >= ?2 AND cm.created_at <= ?3",
                params![mission_id, from, to],
                |r| r.get(0),
            )
            .map_err(Into::into)
    }

    /// The Logbook rollup: hours (span union) + cost + savings + counts per
    /// mission, for a mission / project / global scope over `[from, to]`.
    pub fn logbook_summary(
        &self,
        scope_type: &str,
        scope_id: Option<&str>,
        from: &str,
        to: &str,
    ) -> AppResult<Vec<LogbookMissionRow>> {
        let missions: Vec<MissionRow> = match scope_type {
            "mission" => {
                let id = scope_id
                    .ok_or_else(|| crate::error::AppError::Other("mission scope needs an id".into()))?;
                self.get_mission(id)?.into_iter().collect()
            }
            "project" => {
                let id = scope_id
                    .ok_or_else(|| crate::error::AppError::Other("project scope needs an id".into()))?;
                self.list_missions(id)?
            }
            "global" => {
                let mut stmt = self.conn.prepare(
                    "SELECT id, workspace_id, project_id, intent, title, status, linked_issue_key, git_isolation, exec_isolation, payload, created_at, updated_at, archived_at
                     FROM missions WHERE status != 'archived' ORDER BY created_at ASC",
                )?;
                let rows = stmt.query_map([], |r| row_to_mission(r))?;
                rows.collect::<Result<Vec<_>, _>>()?
            }
            other => {
                return Err(crate::error::AppError::Other(format!("unknown logbook scope '{other}'")))
            }
        };

        let mut out = Vec::with_capacity(missions.len());
        for m in missions {
            let (cost_usd, _tokens) = self.mission_spend(&m.id, from, to)?;
            let (hours_secs, per_surface) = self.mission_spans_summary(&m.id, from, to)?;
            let (savings_usd, runs_count) = self.mission_run_stats(&m.id, from, to)?;
            let messages_count = self.mission_message_count(&m.id, from, to)?;
            out.push(LogbookMissionRow {
                mission_id: m.id,
                title: m.title,
                intent: m.intent,
                status: m.status,
                hours_secs,
                cost_usd,
                savings_usd,
                runs_count,
                messages_count,
                per_surface,
            });
        }
        Ok(out)
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
            "SELECT id, project_id, name, task, branch, worktree_path, setup_script, status, created_at, last_active, glyph, tint, test_command, linked_issue_key, from_branch, group_id
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
                    group_id: r.get(15)?,
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
        self.conn.execute(CLEAR_LINKS_TO_WORKSPACE_SQL, params![id])?;
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
        // Missions waiting on this one stop waiting; restoring it doesn't
        // bring the links back.
        self.conn.execute(CLEAR_LINKS_TO_WORKSPACE_SQL, params![id])?;
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
            "SELECT id, project_id, name, task, branch, worktree_path, setup_script, status, created_at, last_active, glyph, tint, test_command, linked_issue_key, from_branch, group_id
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
                group_id: r.get(15)?,
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
        // Stamp the thread's mission at birth so mission-first scoping is honest.
        // The column was only ever written by the one-shot M1 backfill; new
        // threads left it NULL, so any thread created after the backfill silently
        // lost its mission. Mirror `create_run`'s birth-stamp.
        let mission_id = self
            .active_mission_for_workspace(workspace_id)?
            .map(|m| m.id);
        self.conn.execute(
            "INSERT INTO chat_threads (id, workspace_id, mission_id, title, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?5)",
            params![id, workspace_id, mission_id, title, now],
        )?;
        Ok(ChatThreadRow {
            id,
            workspace_id: workspace_id.to_string(),
            mission_id,
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
            "SELECT id, workspace_id, mission_id, title, created_at, updated_at, pinned
             FROM chat_threads WHERE workspace_id = ?1
             ORDER BY pinned DESC, updated_at DESC",
        )?;
        let rows = stmt.query_map(params![workspace_id], |r| {
            Ok(ChatThreadRow {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                mission_id: r.get(2)?,
                title: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
                pinned: r.get::<_, i64>(6)? != 0,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// The MCP servers switched off in a conversation, sorted. Empty for a
    /// thread that never switched one off (NULL), an unreadable value, or a
    /// thread that no longer exists: the default is every server.
    pub fn thread_mcp_disabled(&self, thread_id: &str) -> AppResult<Vec<String>> {
        let raw: Option<String> = self
            .conn
            .query_row("SELECT mcp_disabled FROM chat_threads WHERE id = ?1", params![thread_id], |r| r.get(0))
            .optional()?
            .flatten();
        Ok(raw.and_then(|j| serde_json::from_str::<Vec<String>>(&j).ok()).unwrap_or_default())
    }

    /// Replace a conversation's switched-off MCP servers. Names are trimmed,
    /// de-duplicated and sorted; an empty list stores NULL (all on).
    pub fn set_thread_mcp_disabled(&self, thread_id: &str, servers: &[String]) -> AppResult<()> {
        let names: std::collections::BTreeSet<&str> =
            servers.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
        let value = (!names.is_empty()).then(|| serde_json::to_string(&names).ok()).flatten();
        self.conn.execute(
            "UPDATE chat_threads SET mcp_disabled = ?2 WHERE id = ?1",
            params![thread_id, value],
        )?;
        Ok(())
    }

    /// A conversation's stored permission mode, as written; `None` for a
    /// thread that never set one (or no longer exists). Read it through
    /// `permissions::thread_mode`, which says what each value means.
    pub fn thread_permission_mode(&self, thread_id: &str) -> AppResult<Option<String>> {
        let raw: Option<Option<String>> = self
            .conn
            .query_row("SELECT permission_mode FROM chat_threads WHERE id = ?1", params![thread_id], |r| r.get(0))
            .optional()?;
        Ok(raw.flatten())
    }

    /// The workspace a conversation belongs to, `None` once it's gone.
    pub fn chat_thread_workspace(&self, thread_id: &str) -> AppResult<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT workspace_id FROM chat_threads WHERE id = ?1", params![thread_id], |r| r.get(0))
            .optional()?)
    }

    /// Set a conversation's permission mode.
    pub fn set_thread_permission_mode(&self, thread_id: &str, mode: crate::permissions::Mode) -> AppResult<()> {
        let changed = self.conn.execute(
            "UPDATE chat_threads SET permission_mode = ?2 WHERE id = ?1",
            params![thread_id, mode.as_str()],
        )?;
        if changed == 0 {
            return Err(crate::error::AppError::Other("That conversation no longer exists.".into()));
        }
        Ok(())
    }

    /// Turn one MCP server off (or back on) in a conversation, leaving the
    /// others as stored, and return the new list. Read and written under the
    /// one connection the caller holds locked, so two toggles never lose
    /// each other's change.
    pub fn set_thread_mcp_server_off(&self, thread_id: &str, server: &str, off: bool) -> AppResult<Vec<String>> {
        let server = server.trim();
        let mut names = self.thread_mcp_disabled(thread_id)?;
        names.retain(|n| n != server);
        if off && !server.is_empty() {
            names.push(server.to_string());
        }
        self.set_thread_mcp_disabled(thread_id, &names)?;
        self.thread_mcp_disabled(thread_id)
    }

    /// After MCP servers were renamed in Settings (`renames`: old → new):
    /// every conversation that had an old name switched off has the new one
    /// off instead, so a renamed server doesn't come back on there. Not
    /// where `keeps_old(workspace path, old name)` says the conversation's
    /// project still defines the old name itself (its `.claude/mcp.json`):
    /// the entry there still means that server. All rows in one
    /// transaction; an unreadable value is left as it is. Returns how many
    /// conversations changed.
    pub fn rename_thread_mcp_servers(
        &self,
        renames: &[(String, String)],
        keeps_old: impl Fn(&str, &str) -> bool,
    ) -> AppResult<usize> {
        if renames.is_empty() {
            return Ok(0);
        }
        let tx = self.conn.unchecked_transaction()?;
        let rows: Vec<(String, String, Option<String>)> = {
            let mut stmt = tx.prepare(
                "SELECT t.id, t.mcp_disabled, COALESCE(NULLIF(w.worktree_path, ''), p.path) FROM chat_threads t \
                 LEFT JOIN workspaces w ON w.id = t.workspace_id LEFT JOIN projects p ON p.id = w.project_id \
                 WHERE t.mcp_disabled IS NOT NULL",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut changed = 0;
        for (id, raw, path) in rows {
            let Ok(names) = serde_json::from_str::<Vec<String>>(&raw) else { continue };
            let mut hit = false;
            // Each name maps once, so two servers that swap names swap here too.
            let renamed: std::collections::BTreeSet<String> = names
                .into_iter()
                .map(|n| match renames.iter().find(|(old, _)| *old == n) {
                    Some(_) if path.as_deref().is_some_and(|p| keeps_old(p, &n)) => n,
                    Some((_, new)) => {
                        hit = true;
                        new.clone()
                    }
                    None => n,
                })
                .collect();
            if hit {
                tx.execute(
                    "UPDATE chat_threads SET mcp_disabled = ?2 WHERE id = ?1",
                    params![id, serde_json::to_string(&renamed)?],
                )?;
                changed += 1;
            }
        }
        tx.commit()?;
        Ok(changed)
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
        self.conn.execute("DELETE FROM chat_agent_log WHERE thread_id = ?1", params![thread_id])?;
        self.conn.execute("DELETE FROM chat_messages WHERE thread_id = ?1", params![thread_id])?;
        self.conn.execute("DELETE FROM chat_threads WHERE id = ?1", params![thread_id])?;
        Ok(())
    }

    /// The worktree of the workspace a thread belongs to (its checkpoints
    /// live in that repository).
    pub fn chat_thread_worktree(&self, thread_id: &str) -> AppResult<Option<String>> {
        let path = self
            .conn
            .query_row(
                "SELECT w.worktree_path FROM chat_threads t JOIN workspaces w ON w.id = t.workspace_id
                 WHERE t.id = ?1",
                params![thread_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?;
        Ok(path.flatten())
    }

    /// The workspace a thread belongs to and its worktree, when it has one.
    pub fn chat_thread_home(&self, thread_id: &str) -> AppResult<Option<(String, Option<String>)>> {
        self.conn
            .query_row(
                "SELECT w.id, w.worktree_path FROM chat_threads t JOIN workspaces w ON w.id = t.workspace_id
                 WHERE t.id = ?1",
                params![thread_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(Into::into)
    }

    /// Every thread of every workspace checked out at the same path as
    /// `thread_id`'s workspace (itself included): the conversations whose
    /// turns write to the same files.
    pub fn chat_threads_sharing_worktree(&self, thread_id: &str) -> AppResult<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT t2.id FROM chat_threads t
               JOIN workspaces w ON w.id = t.workspace_id
               JOIN workspaces w2 ON w2.id = w.id
                 OR (w.worktree_path IS NOT NULL AND rtrim(w2.worktree_path, '/') = rtrim(w.worktree_path, '/'))
               JOIN chat_threads t2 ON t2.workspace_id = w2.id
             WHERE t.id = ?1",
        )?;
        let rows = stmt.query_map(params![thread_id], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Whether a Direct run is in progress (`running` or `paused`) in a
    /// workspace checked out at `worktree_path`.
    pub fn has_active_run_at(&self, worktree_path: &str) -> AppResult<bool> {
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM runs r JOIN workspaces w ON w.id = r.workspace_id
             WHERE r.status IN ('running', 'paused')
               AND rtrim(w.worktree_path, '/') = rtrim(?1, '/')",
            params![worktree_path],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    /// The threads of every workspace checked out at `worktree_path` (a
    /// trailing slash ignored), to ask the chat engine whether one runs there.
    pub fn chat_threads_at_worktree(&self, worktree_path: &str) -> AppResult<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.id FROM chat_threads t JOIN workspaces w ON w.id = t.workspace_id
             WHERE rtrim(w.worktree_path, '/') = rtrim(?1, '/')",
        )?;
        let rows = stmt.query_map(params![worktree_path], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// The ids of a workspace's threads (their checkpoints go when the
    /// workspace is deleted or archived).
    pub fn chat_thread_ids(&self, workspace_id: &str) -> AppResult<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT id FROM chat_threads WHERE workspace_id = ?1")?;
        let rows = stmt.query_map(params![workspace_id], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Fork from a user turn (#958): a new thread in the same workspace holding
    /// a copy of every message BEFORE `message_id`, which must be a user turn
    /// of `thread_id`. Returns the new thread, the turn's text (the fork's
    /// draft) and each copied row's (old id, new id).
    pub fn fork_chat_thread(
        &self,
        thread_id: &str,
        message_id: i64,
    ) -> AppResult<(ChatThreadRow, String, Vec<(i64, i64)>)> {
        let (workspace_id, title): (String, String) = self
            .conn
            .query_row(
                "SELECT workspace_id, title FROM chat_threads WHERE id = ?1",
                params![thread_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| crate::error::AppError::Other("That conversation no longer exists.".into()))?;
        let draft: String = self
            .conn
            .query_row(
                "SELECT content FROM chat_messages WHERE id = ?1 AND thread_id = ?2 AND role = 'user'",
                params![message_id, thread_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| crate::error::AppError::Other("Only a message you sent can be forked from.".into()))?;
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM chat_messages WHERE thread_id = ?1 AND id < ?2 ORDER BY id")?;
        let ids: Vec<i64> = stmt
            .query_map(params![thread_id, message_id], |r| r.get(0))?
            .collect::<Result<Vec<i64>, rusqlite::Error>>()?;
        drop(stmt);
        // One transaction: a failure part-way leaves no half-copied fork.
        let tx = self.conn.unchecked_transaction()?;
        let thread = self.create_chat_thread(&workspace_id, &format!("{title} · fork"))?;
        // A fork is the same conversation from here: it keeps its MCP scope
        // and its permission mode.
        tx.execute(
            "UPDATE chat_threads SET (mcp_disabled, permission_mode) = \
             (SELECT mcp_disabled, permission_mode FROM chat_threads WHERE id = ?2) WHERE id = ?1",
            params![thread.id, thread_id],
        )?;
        let mut pairs = Vec::with_capacity(ids.len());
        // The transcript's columns stay behind: a model view names its own
        // row for recall, so a fork's copies replay as text with their own ids.
        for old in ids {
            tx.execute(
                "INSERT INTO chat_messages (workspace_id, thread_id, role, content, model, input_tokens,
                    output_tokens, cost_usd, created_at, cache_read_tokens, cache_creation_tokens, context_tokens,
                    context_blocks)
                 SELECT workspace_id, ?1, role, content, model, input_tokens, output_tokens, cost_usd,
                    created_at, cache_read_tokens, cache_creation_tokens, context_tokens, context_blocks
                 FROM chat_messages WHERE id = ?2",
                params![thread.id, old],
            )?;
            pairs.push((old, tx.last_insert_rowid()));
        }
        tx.commit()?;
        Ok((thread, draft, pairs))
    }

    /// Delete a message and everything after it in a thread (ids are monotonic
    /// per thread). Backs Regenerate (truncate from the assistant turn) and
    /// Edit-and-resend (truncate from the edited user message). Scoped by
    /// thread_id so it never touches another conversation's rows, and
    /// refused unless `message_id` is one of this thread's: an id from
    /// another thread (a view that showed the wrong rows) would cut from
    /// wherever its number falls here.
    pub fn truncate_chat_after(&self, thread_id: &str, message_id: i64) -> AppResult<()> {
        let owner: Option<Option<String>> = self
            .conn
            .query_row("SELECT thread_id FROM chat_messages WHERE id = ?1", params![message_id], |r| r.get(0))
            .optional()?;
        if owner.flatten().as_deref() != Some(thread_id) {
            return Err(crate::error::AppError::Other(
                "That message isn't part of this conversation, so nothing was deleted.".into(),
            ));
        }
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

    // ─── Claude Code hook signals ──────────────────────────────────

    /// Queue one hook signal for the app's poller (`claude_hooks`), stamped now.
    pub fn insert_hook_signal(&self, terminal_id: &str, signal: &str, session_id: Option<&str>) -> AppResult<()> {
        self.insert_hook_signal_at(terminal_id, signal, session_id, &Utc::now().to_rfc3339())
    }

    /// [`Self::insert_hook_signal`] stamped `at` (RFC3339 UTC): when the hook
    /// fired, which the hook process notes as it starts. Rows are queued in
    /// the order they are WRITTEN, and a hook that waited on the database
    /// can be written after one that fired later; the stamp keeps the order
    /// the events happened in.
    pub fn insert_hook_signal_at(&self, terminal_id: &str, signal: &str, session_id: Option<&str>, at: &str) -> AppResult<()> {
        self.conn.execute(
            "INSERT INTO hook_signals (terminal_id, signal, session_id, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![terminal_id, signal, session_id, at],
        )?;
        Ok(())
    }

    /// Every queued hook signal, oldest first, removed from the queue in the
    /// same transaction so a row is delivered once.
    pub fn drain_hook_signals(&self) -> AppResult<Vec<HookSignalRow>> {
        let tx = self.conn.unchecked_transaction()?;
        let rows = {
            let mut stmt = tx.prepare(
                "SELECT id, terminal_id, signal, session_id, created_at FROM hook_signals ORDER BY id",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(HookSignalRow {
                    id: r.get(0)?,
                    terminal_id: r.get(1)?,
                    signal: r.get(2)?,
                    session_id: r.get(3)?,
                    created_at: r.get(4)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        if let Some(last) = rows.last() {
            tx.execute("DELETE FROM hook_signals WHERE id <= ?1", params![last.id])?;
        }
        tx.commit()?;
        Ok(rows)
    }

    // ─── Terminals ────────────────────────────────────────────────

    /// The workspace a terminal belongs to — resolved once at spawn so the
    /// Logbook can attribute PTY activity without a lookup per output chunk.
    pub fn workspace_for_terminal(&self, terminal_id: &str) -> AppResult<Option<String>> {
        self.conn
            .query_row(
                "SELECT workspace_id FROM terminals WHERE id = ?1",
                params![terminal_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

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

    /// Persist the session line's order: `ids[i]` takes position `i`. Only
    /// the workspace's own terminals move, so a stale or foreign id is a
    /// no-op, and a session `ids` leaves out goes after the listed ones,
    /// keeping its relative order.
    pub fn set_terminal_order(&self, workspace_id: &str, ids: &[String]) -> AppResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        let current: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT id FROM terminals WHERE workspace_id = ?1 ORDER BY position ASC, created_at ASC",
            )?;
            let rows = stmt.query_map(params![workspace_id], |r| r.get(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut order: Vec<&String> = Vec::with_capacity(current.len());
        for id in ids.iter().chain(current.iter()) {
            if current.contains(id) && !order.contains(&id) {
                order.push(id);
            }
        }
        for (idx, id) in order.iter().enumerate() {
            tx.execute(
                "UPDATE terminals SET position = ?1 WHERE id = ?2 AND workspace_id = ?3",
                params![idx as i64, id, workspace_id],
            )?;
        }
        tx.commit()?;
        Ok(())
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
        // Whatever Claude Code session it ran is no terminal's any more.
        self.conn.execute("DELETE FROM terminal_claude_session WHERE terminal_id = ?1", params![id])?;
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
    /// - period = "daily"   → events since start of today (LOCAL time)
    /// - period = "monthly" → events since start of this month (LOCAL time)
    /// - scope_type = "global"    → all events
    /// - scope_type = "workspace" → events where session_id = scope_id
    /// - scope_type = "project"   → events whose session_id is a workspace belonging to scope_id project
    ///
    /// The cutoff is computed in the user's local timezone (F13: daily/monthly
    /// budgets reset at local midnight, not 00:00 UTC) and bound as an RFC3339
    /// UTC string that string-compares correctly against the stored timestamps.
    pub fn period_spend(
        &self,
        scope_type: &str,
        scope_id: &str,
        period: &str,
    ) -> AppResult<(f64, i64)> {
        let since = period_since_utc(period);

        let (cost, tokens) = match scope_type {
            "workspace" => {
                let mut stmt = self.conn.prepare(
                    "SELECT COALESCE(SUM(cost_usd), 0.0), COALESCE(SUM(input_tokens + output_tokens), 0)
                     FROM all_spend
                     WHERE session_id = ?1 AND timestamp >= ?2",
                )?;
                stmt.query_row(params![scope_id, since], |r| {
                    Ok((r.get::<_, f64>(0)?, r.get::<_, i64>(1)?))
                })?
            }
            "project" => {
                let mut stmt = self.conn.prepare(
                    "SELECT COALESCE(SUM(e.cost_usd), 0.0), COALESCE(SUM(e.input_tokens + e.output_tokens), 0)
                     FROM all_spend e
                     JOIN workspaces w ON w.id = e.session_id
                     WHERE w.project_id = ?1 AND e.timestamp >= ?2",
                )?;
                stmt.query_row(params![scope_id, since], |r| {
                    Ok((r.get::<_, f64>(0)?, r.get::<_, i64>(1)?))
                })?
            }
            _ => {
                // global
                let mut stmt = self.conn.prepare(
                    "SELECT COALESCE(SUM(cost_usd), 0.0), COALESCE(SUM(input_tokens + output_tokens), 0)
                     FROM all_spend
                     WHERE timestamp >= ?1",
                )?;
                stmt.query_row(params![since], |r| {
                    Ok((r.get::<_, f64>(0)?, r.get::<_, i64>(1)?))
                })?
            }
        };
        Ok((cost, tokens))
    }

    /// Backend budget gate: is spending currently over ANY configured budget for
    /// this workspace (and its project, and global)? Reads the same `budgets`
    /// rows and `period_spend` figures the UI uses. Returns the first breached
    /// scope, else `Allow`. A scope with no budget (or limit ≤ 0) never blocks.
    pub fn check_budget(&self, workspace_id: Option<&str>) -> AppResult<BudgetVerdict> {
        for (scope, spent, limit) in self.budget_spend(workspace_id)? {
            if spent >= limit {
                return Ok(BudgetVerdict::Block { scope, spent, limit });
            }
        }
        Ok(BudgetVerdict::Allow)
    }

    /// What is left to spend under every configured budget that covers this
    /// workspace (its own, its project's, global; daily and monthly): the
    /// smallest `limit − spent`, never below zero. `None` when no budget is
    /// set — spend there is unbounded. The same rows `check_budget` reads.
    pub fn budget_headroom(&self, workspace_id: Option<&str>) -> AppResult<Option<f64>> {
        Ok(self
            .budget_spend(workspace_id)?
            .into_iter()
            .map(|(_, spent, limit)| (limit - spent).max(0.0))
            .reduce(f64::min))
    }

    /// Each configured budget covering this workspace, widest scope first:
    /// `("<scope> <period>", spent, limit)`. A limit ≤ 0 is no budget.
    fn budget_spend(&self, workspace_id: Option<&str>) -> AppResult<Vec<(String, f64, f64)>> {
        let project_id: Option<String> = match workspace_id {
            Some(ws) => self
                .conn
                .query_row(
                    "SELECT project_id FROM workspaces WHERE id = ?1",
                    params![ws],
                    |r| r.get(0),
                )
                .optional()?,
            None => None,
        };
        // (scope_type, scope_id) tuples to check, widest first.
        let mut scopes: Vec<(&str, String)> = vec![("global", String::new())];
        if let Some(pid) = &project_id {
            scopes.push(("project", pid.clone()));
        }
        if let Some(ws) = workspace_id {
            scopes.push(("workspace", ws.to_string()));
        }
        let budgets = self.list_budgets()?;
        let mut out = Vec::new();
        for (scope_type, scope_id) in &scopes {
            for period in ["daily", "monthly"] {
                let Some(b) = budgets.iter().find(|b| {
                    b.scope_type == *scope_type && b.scope_id == *scope_id && b.period == period
                }) else {
                    continue;
                };
                if b.limit_usd <= 0.0 {
                    continue;
                }
                let (spent, _) = self.period_spend(scope_type, scope_id, period)?;
                out.push((format!("{scope_type} {period}"), spent, b.limit_usd));
            }
        }
        Ok(out)
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
        // Cheapest cloud equivalent for the "we saved X vs running cloud" metric,
        // derived from the actual enabled catalog (blended (input+output)/2 of the
        // cheapest enabled non-local model) rather than a stale hardcoded constant
        // (F19). Falls back to ~$0.21/M (DeepSeek-era blend) if nothing qualifies.
        let cheapest_cloud_per_m = router
            .list_providers()
            .iter()
            .filter(|p| p.enabled && !p.local)
            .flat_map(|p| p.models.iter())
            .map(|m| (m.input_cost_per_m + m.output_cost_per_m) / 2.0)
            .filter(|&r| r > 0.0)
            .fold(f64::INFINITY, f64::min);
        let cheapest_cloud_per_m = if cheapest_cloud_per_m.is_finite() {
            cheapest_cloud_per_m
        } else {
            0.21
        };

        // Per-model aggregates within the time range.
        let mut stmt = self.conn.prepare(
            "SELECT model,
                    COALESCE(SUM(cost_usd), 0),
                    COALESCE(SUM(input_tokens + output_tokens), 0)
             FROM all_spend
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
            local_tokens as f64 * cheapest_cloud_per_m / 1_000_000.0;

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
             FROM all_spend
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
            "SELECT id, workspace_id, role, content, model, input_tokens, output_tokens, cost_usd, created_at,
                    cache_read_tokens, cache_creation_tokens, context_tokens, context_blocks,
                    raw_json, tool_use_id, model_view, error_kind
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
                    cache_read_tokens: r.get(9)?,
                    cache_creation_tokens: r.get(10)?,
                    context_tokens: r.get(11)?,
                    context_blocks: r.get(12)?,
                    raw_json: r.get(13)?,
                    tool_use_id: r.get(14)?,
                    model_view: r.get(15)?,
                    error_kind: r.get(16)?,
                    input_tokens: r.get(5)?,
                    output_tokens: r.get(6)?,
                    cost_usd: r.get(7)?,
                    created_at: r.get(8)?,
                })
            })
            .optional()?;
        Ok(row)
    }

    /// The persisted content of one `role="tool"` row, scoped to `thread_id`
    /// so the TALK `recall_tool_output` tool can only reach outputs of the
    /// conversation it runs in. `None` when the id is unknown, belongs to
    /// another thread, or isn't a tool row.
    pub fn get_chat_tool_output(&self, thread_id: &str, message_id: i64) -> AppResult<Option<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT content FROM chat_messages WHERE id = ?1 AND thread_id = ?2 AND role = 'tool'",
        )?;
        let content = stmt
            .query_row(params![message_id, thread_id], |r| r.get::<_, String>(0))
            .optional()?;
        Ok(content)
    }

    /// Keep the original of tool row `message_id`'s output for
    /// `recall_tool_output`: at most `chat_history::ORIGINAL_CAP_BYTES` of it
    /// (cut on a char boundary), with its full size.
    pub fn set_chat_tool_original(&self, message_id: i64, thread_id: &str, original: &str) -> AppResult<()> {
        let kept = crate::chat_history::capped_original(original);
        self.conn.execute(
            "INSERT OR REPLACE INTO chat_tool_originals (message_id, thread_id, content, total_bytes) VALUES (?1, ?2, ?3, ?4)",
            params![message_id, thread_id, kept, original.len() as i64],
        )?;
        Ok(())
    }

    /// The kept original of tool row `message_id` and its full size in
    /// bytes, scoped to `thread_id` like [`Self::get_chat_tool_output`].
    pub fn get_chat_tool_original(&self, thread_id: &str, message_id: i64) -> AppResult<Option<(String, usize)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT content, total_bytes FROM chat_tool_originals WHERE message_id = ?1 AND thread_id = ?2")?;
        let row = stmt
            .query_row(params![message_id, thread_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize)))
            .optional()?;
        Ok(row)
    }

    /// A user row's content and `@` context spans, scoped to `thread_id` like
    /// a tool output, so `recall_tool_output` can return one of its blocks.
    pub fn get_chat_sent_context(&self, thread_id: &str, message_id: i64) -> AppResult<Option<(String, String)>> {
        let row = self
            .conn
            .query_row(
                "SELECT content, context_blocks FROM chat_messages
                 WHERE id = ?1 AND thread_id = ?2 AND role = 'user' AND context_blocks IS NOT NULL",
                params![message_id, thread_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(row)
    }

    /// Record where a just-sent ask's `@` context blocks sit in its content.
    pub fn set_chat_message_context(&self, message_id: i64, context_blocks: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE chat_messages SET context_blocks = ?2 WHERE id = ?1",
            params![message_id, context_blocks],
        )?;
        Ok(())
    }

    /// Record how a Talk `error` row's turn failed.
    pub fn set_chat_error_kind(&self, message_id: i64, kind: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE chat_messages SET error_kind = ?2 WHERE id = ?1 AND role = 'error'",
            params![message_id, kind],
        )?;
        Ok(())
    }

    /// Keep a tool round's verbatim assistant turn and its origin model
    /// (`context::transcript::RoundRecord`) on its `assistant_tool_use` row.
    /// Written once: a row that has one keeps it.
    pub fn set_chat_round(&self, message_id: i64, raw_json: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE chat_messages SET raw_json = ?2 WHERE id = ?1 AND role = 'assistant_tool_use' AND raw_json IS NULL",
            params![message_id, raw_json],
        )?;
        Ok(())
    }

    /// Keep what the model was given for tool row `message_id`: the tool_use
    /// it answers and the capped text (`context::transcript::model_view`).
    /// Written once; only the context guard's stub replaces it, once
    /// ([`Self::set_chat_tool_stub`]).
    pub fn set_chat_tool_view(&self, message_id: i64, tool_use_id: &str, model_view: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE chat_messages SET tool_use_id = ?2, model_view = ?3
             WHERE id = ?1 AND role = 'tool' AND model_view IS NULL",
            params![message_id, tool_use_id, model_view],
        )?;
        Ok(())
    }

    /// The context guard stubbed tool row `message_id`'s result in a v2
    /// request: the stub becomes its model view, so later turns replay it
    /// byte for byte. A stub is never stubbed again, so this happens once.
    pub fn set_chat_tool_stub(&self, message_id: i64, stub: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE chat_messages SET model_view = ?2 WHERE id = ?1 AND role = 'tool' AND model_view IS NOT NULL",
            params![message_id, stub],
        )?;
        Ok(())
    }

    /// Append one live-journal entry of a TALK sub-agent (`Agent` tool call).
    pub fn append_chat_agent_log(&self, thread_id: &str, call_id: &str, entry_json: &str) -> AppResult<()> {
        self.conn.execute(
            "INSERT INTO chat_agent_log (thread_id, call_id, entry) VALUES (?1, ?2, ?3)",
            params![thread_id, call_id, entry_json],
        )?;
        Ok(())
    }

    /// All persisted journal entries of one sub-agent call, oldest first.
    pub fn list_chat_agent_log(&self, call_id: &str) -> AppResult<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT entry FROM chat_agent_log WHERE call_id = ?1 ORDER BY id")?;
        let rows = stmt.query_map(params![call_id], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Stamp a turn's prompt accounting on its assistant row.
    pub fn set_chat_message_usage(
        &self,
        message_id: i64,
        cache_read_tokens: i64,
        cache_creation_tokens: i64,
        context_tokens: i64,
    ) -> AppResult<()> {
        self.conn.execute(
            "UPDATE chat_messages SET cache_read_tokens = ?2, cache_creation_tokens = ?3, context_tokens = ?4
             WHERE id = ?1",
            params![message_id, cache_read_tokens, cache_creation_tokens, context_tokens],
        )?;
        Ok(())
    }

    /// Replace a message's content in place (a continued sub-agent's tool
    /// row takes its new report and meta). The row's model view was the old
    /// content as the model was given it, so it goes too: the director's
    /// next turn reads the new report, from that turn on as text.
    pub fn update_chat_message_content(&self, message_id: i64, content: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE chat_messages SET content = ?2, model_view = NULL WHERE id = ?1",
            params![message_id, content],
        )?;
        Ok(())
    }

    // ─── Sub-agent runs (continue / reply) ────────────────────────

    /// Keep a finished sub-agent's spec + conversation so it can be given
    /// more turns or an answer later.
    #[allow(clippy::too_many_arguments)]
    pub fn upsert_chat_agent_run(
        &self,
        call_id: &str,
        thread_id: &str,
        workspace_id: &str,
        spec_json: &str,
        transcript_json: &str,
        model: &str,
    ) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO chat_agent_runs (call_id, thread_id, workspace_id, spec_json, transcript_json, model, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(call_id) DO UPDATE SET spec_json = excluded.spec_json,
                 transcript_json = excluded.transcript_json, model = excluded.model,
                 updated_at = excluded.updated_at",
            params![call_id, thread_id, workspace_id, spec_json, transcript_json, model, now],
        )?;
        Ok(())
    }

    /// Link a sub-agent run to the tool row that carries its report.
    pub fn set_chat_agent_run_message(&self, call_id: &str, message_id: i64) -> AppResult<()> {
        self.conn.execute(
            "UPDATE chat_agent_runs SET message_id = ?2 WHERE call_id = ?1",
            params![call_id, message_id],
        )?;
        Ok(())
    }

    pub fn get_chat_agent_run(&self, call_id: &str) -> AppResult<Option<ChatAgentRun>> {
        self.conn
            .query_row(
                "SELECT call_id, thread_id, workspace_id, message_id, spec_json, transcript_json, model
                 FROM chat_agent_runs WHERE call_id = ?1",
                params![call_id],
                |r| {
                    Ok(ChatAgentRun {
                        call_id: r.get(0)?,
                        thread_id: r.get(1)?,
                        workspace_id: r.get(2)?,
                        message_id: r.get(3)?,
                        spec_json: r.get(4)?,
                        transcript_json: r.get(5)?,
                        model: r.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    /// What one Talk thread cost, from the ledger: every row billed in the
    /// thread (director rounds and sub-agent runs alike, cache-aware), how
    /// much of it sub-agents spent, and what the same tokens would have cost
    /// on the strong tier's model (`strong`, cache-aware) — the all-strong
    /// baseline the economy director is judged against.
    pub fn thread_cost(&self, thread_id: &str, strong: Option<&crate::token_engine::ModelPrices>) -> AppResult<ThreadCost> {
        let mut stmt = self.conn.prepare(
            "SELECT origin, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
                    cost_basis, model
             FROM spend_events WHERE thread_id = ?1",
        )?;
        let rows = stmt.query_map(params![thread_id], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, f64>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
            ))
        })?;
        let mut out = ThreadCost::default();
        let (mut input, mut read, mut create) = (0i64, 0i64, 0i64);
        for row in rows {
            let (origin, i, o, cr, cc, cost, basis, model) = row?;
            out.calls += 1;
            input += i;
            read += cr;
            create += cc;
            if basis == "unpriced" {
                // No price: its real cost is unknown, so it is neither spend
                // nor saving — leave it out of the baseline (it would count
                // as 100% saved) and name the model for the UI.
                out.unpriced_calls += 1;
                if !out.unpriced_models.contains(&model) {
                    out.unpriced_models.push(model);
                }
                continue;
            }
            out.spent_usd += cost;
            if origin.as_deref().is_some_and(|o| o.starts_with("subagent:")) {
                out.subagents_usd += cost;
            }
            if let Some(p) = strong {
                out.baseline_usd += p.cost(i.max(0) as u64, o.max(0) as u64, cr.max(0) as u64, cc.max(0) as u64);
            }
        }
        out.strong_priced = strong.is_some();
        let (pct, _) = cache_hit_pct(input, read, create);
        out.cache_hit_pct = pct;
        Ok(out)
    }

    /// Make `session_id` the current Claude Code session of `terminal_id`,
    /// confirmed at `at` (RFC3339 UTC, when the hook fired): what one of
    /// that session's hooks just said. `started` is its `SessionStart`,
    /// which also revives a session that had ended (a resume), but only when
    /// it fired AFTER that end: `SessionStart` is asynchronous and
    /// `SessionEnd` is not, so the start of a session that ended at once can
    /// be written after its end, and must not link the terminal to a dead
    /// session. Any other signal of an ended session is late and changes
    /// nothing. `false` when nothing was linked. A session is current in one
    /// terminal only: it leaves any other terminal, which then has none.
    pub fn link_terminal_claude_session(&self, terminal_id: &str, session_id: &str, at: &str, started: bool) -> AppResult<bool> {
        let tx = self.conn.unchecked_transaction()?;
        let ended_at: Option<String> = tx
            .query_row("SELECT ended_at FROM ended_claude_sessions WHERE session_id = ?1", params![session_id], |r| r.get(0))
            .optional()?;
        if let Some(ended_at) = ended_at {
            // Both stamps are RFC3339 UTC in one shape, so they compare as text.
            if !started || at <= ended_at.as_str() {
                return Ok(false);
            }
            tx.execute("DELETE FROM ended_claude_sessions WHERE session_id = ?1", params![session_id])?;
        }
        tx.execute(
            "DELETE FROM terminal_claude_session WHERE session_id = ?1 AND terminal_id != ?2",
            params![session_id, terminal_id],
        )?;
        tx.execute(
            "INSERT INTO terminal_claude_session (terminal_id, session_id, linked_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(terminal_id) DO UPDATE SET session_id = excluded.session_id, linked_at = excluded.linked_at",
            params![terminal_id, session_id, at],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// The Claude Code session `session_id` ended at `at` (its `SessionEnd`):
    /// it is remembered as ended, and `terminal_id` has no current session
    /// if that was the one it ran (an end naming another session leaves the
    /// terminal's own alone). Also how a print-mode session is set aside,
    /// from its first moment: it is never a terminal's session, and recorded
    /// here it is never taken for a rival either. The newest end is kept.
    pub fn end_terminal_claude_session(&self, terminal_id: &str, session_id: &str, at: &str) -> AppResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO ended_claude_sessions (session_id, ended_at) VALUES (?1, ?2)
             ON CONFLICT(session_id) DO UPDATE SET ended_at = MAX(ended_at, excluded.ended_at)",
            params![session_id, at],
        )?;
        tx.execute(
            "DELETE FROM terminal_claude_session WHERE terminal_id = ?1 AND session_id = ?2",
            params![terminal_id, session_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// The Claude Code session `terminal_id` runs, and when a hook last said
    /// so: `(session id, linked_at)`. `None` when it has none.
    pub fn terminal_claude_session(&self, terminal_id: &str) -> AppResult<Option<(String, String)>> {
        self.conn
            .query_row(
                "SELECT session_id, linked_at FROM terminal_claude_session WHERE terminal_id = ?1",
                params![terminal_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(Into::into)
    }

    /// Whether `session_id` is the current session of some terminal.
    pub fn claude_session_is_linked(&self, session_id: &str) -> AppResult<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM terminal_claude_session WHERE session_id = ?1)",
            params![session_id],
            |r| r.get(0),
        )?)
    }

    /// Drop the ended sessions whose end is older than `cutoff` (RFC3339
    /// UTC). An ended session only matters while its messages are recent
    /// enough to be taken for a rival's, or a late signal of its own could
    /// still arrive; the table would otherwise grow by one row per
    /// conversation, for good. Returns the rows removed.
    pub fn prune_ended_claude_sessions(&self, cutoff: &str) -> AppResult<usize> {
        Ok(self.conn.execute("DELETE FROM ended_claude_sessions WHERE ended_at < ?1", params![cutoff])?)
    }

    /// Forget every terminal's current session (the hooks setting went off:
    /// nothing confirms them any more).
    pub fn clear_terminal_claude_sessions(&self) -> AppResult<()> {
        self.conn.execute("DELETE FROM terminal_claude_session", [])?;
        Ok(())
    }

    /// The workspace a Run terminal belongs to.
    pub fn terminal_workspace(&self, terminal_id: &str) -> AppResult<Option<String>> {
        self.conn
            .query_row("SELECT workspace_id FROM terminals WHERE id = ?1", params![terminal_id], |r| r.get(0))
            .optional()
            .map_err(Into::into)
    }

    /// Whether `terminal_id`'s session (`source_id`, the ledger's
    /// `cc:<session id>`) has a rival: another Claude Code session metered in
    /// `workspace_id` after `since` (RFC3339 UTC) that is neither over (its
    /// `SessionEnd` fired) nor the current session of another terminal. Such
    /// a session may be the one this terminal runs now, with no hook having
    /// said so yet: a session whose hooks predate `SessionStart`, or one
    /// started outside Octopush's terminals.
    pub fn run_session_has_rival(&self, workspace_id: &str, terminal_id: &str, source_id: &str, since: &str) -> AppResult<bool> {
        // `substr(source_id, 4)` drops the `cc:` prefix, so both lookups go
        // through an index on the session id (the ended table's key, and
        // `idx_terminal_claude_session_session`).
        self.conn
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM spend_events se
                     WHERE se.surface = 'run' AND se.workspace_id = ?1 AND se.ts_utc > ?4
                       AND se.source_id LIKE 'cc:%' AND se.source_id != ?3
                       AND NOT EXISTS (SELECT 1 FROM ended_claude_sessions e
                                       WHERE e.session_id = substr(se.source_id, 4))
                       AND NOT EXISTS (SELECT 1 FROM terminal_claude_session t
                                       WHERE t.session_id = substr(se.source_id, 4) AND t.terminal_id != ?2)
                 )",
                params![workspace_id, terminal_id, source_id, since],
                |r| r.get(0),
            )
            .map_err(Into::into)
    }

    /// One Claude Code session's RUN rows, folded for the Run Companion's
    /// Context section: what it spent (unpriced calls aside, as in
    /// [`Self::thread_cost`]), the share of its prompt tokens the cache
    /// served, and the model and time of its newest row. `source_id` is the
    /// ledger's own key for a transcript-metered session (`cc:<session id>`).
    /// `None` when the ledger holds no such row.
    pub fn run_session_ledger(&self, source_id: &str) -> AppResult<Option<RunSessionLedger>> {
        let (calls, unpriced_calls, spent_usd, input, read, create) = self.conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(cost_basis = 'unpriced'), 0),
                    COALESCE(SUM(CASE WHEN cost_basis = 'unpriced' THEN 0.0 ELSE cost_usd END), 0.0),
                    COALESCE(SUM(input_tokens), 0),
                    COALESCE(SUM(cache_read_tokens), 0),
                    COALESCE(SUM(cache_creation_tokens), 0)
             FROM spend_events WHERE surface = 'run' AND source_id = ?1",
            params![source_id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, f64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                ))
            },
        )?;
        if calls == 0 {
            return Ok(None);
        }
        let (last_model, last_ts) = self.conn.query_row(
            "SELECT model, ts_utc FROM spend_events
             WHERE surface = 'run' AND source_id = ?1
             ORDER BY ts_utc DESC, id DESC LIMIT 1",
            params![source_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )?;
        let (cache_hit_pct, _) = cache_hit_pct(input, read, create);
        Ok(Some(RunSessionLedger { calls, unpriced_calls, spent_usd, cache_hit_pct, last_model, last_ts }))
    }

    /// Rows the re-pricer looks at: `'unpriced'` rows with tokens, plus —
    /// when `include_legacy` — `'computed'` rows at $0 with tokens (recorded
    /// before the ledger told unknown from free; a one-time pass, gated by
    /// the caller with an `app_meta` flag, so free local rows are not
    /// rescanned on every launch).
    pub fn reprice_candidates(&self, include_legacy: bool) -> AppResult<Vec<RepriceCandidate>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, model, surface, origin, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, speed
             FROM spend_events
             WHERE cost_usd = 0
               AND (cost_basis = 'unpriced' OR (?1 AND cost_basis = 'computed'))
               AND (input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) > 0",
        )?;
        let rows = stmt.query_map(params![include_legacy], RepriceCandidate::from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// `'computed'` rows (not provider-reported) whose model id may be one
    /// an earlier release priced wrong (see
    /// `provider_router::STALE_BUILTIN_PRICES`). A LIKE pre-filter; the
    /// caller matches the normalized id exactly.
    pub fn stale_price_candidates(&self, like_patterns: &[&str]) -> AppResult<Vec<RepriceCandidate>> {
        let mut out = Vec::new();
        for pat in like_patterns {
            let mut stmt = self.conn.prepare(
                "SELECT id, model, surface, origin, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, speed
                 FROM spend_events
                 WHERE cost_basis = 'computed' AND provider_cost_usd IS NULL AND cost_usd > 0
                   AND model LIKE ?1",
            )?;
            let rows = stmt.query_map(params![pat], RepriceCandidate::from_row)?;
            for r in rows {
                let r = r?;
                if !out.iter().any(|c: &RepriceCandidate| c.id == r.id) {
                    out.push(r);
                }
            }
        }
        Ok(out)
    }

    /// Apply a [`RepricePlan`] in one savepoint: per-row new costs, then the
    /// `'unpriced'` / back-to-`'computed'` classifications in bulk
    /// (`WHERE id IN (…)`). Returns how many rows got a (new) price.
    pub fn apply_reprice(&self, plan: &RepricePlan) -> AppResult<usize> {
        if plan.is_empty() {
            return Ok(0);
        }
        self.conn.execute_batch("SAVEPOINT reprice")?;
        let result = self.apply_reprice_inner(plan);
        match result {
            Ok(_) => self.conn.execute_batch("RELEASE reprice")?,
            Err(_) => self.conn.execute_batch("ROLLBACK TO reprice; RELEASE reprice")?,
        }
        result
    }

    fn apply_reprice_inner(&self, plan: &RepricePlan) -> AppResult<usize> {
        let mut n = 0usize;
        {
            let mut stmt = self.conn.prepare(
                "UPDATE spend_events SET cost_usd = ?2, computed_cost_usd = ?2, cost_basis = 'computed' WHERE id = ?1",
            )?;
            for (id, cost) in &plan.priced {
                n += stmt.execute(params![id, cost])?;
            }
        }
        self.update_basis_in("unpriced", "cost_basis <> 'unpriced'", &plan.unpriced)?;
        self.update_basis_in("computed", "cost_basis = 'unpriced'", &plan.free)?;
        Ok(n)
    }

    /// `UPDATE spend_events SET cost_basis = ?basis WHERE {guard} AND id IN (…)`,
    /// chunked to stay under SQLite's bound-parameter limit.
    fn update_basis_in(&self, basis: &str, guard: &str, ids: &[i64]) -> AppResult<()> {
        for chunk in ids.chunks(500) {
            let marks = vec!["?"; chunk.len()].join(",");
            let sql = format!("UPDATE spend_events SET cost_basis = '{basis}' WHERE {guard} AND id IN ({marks})");
            self.conn.execute(&sql, rusqlite::params_from_iter(chunk.iter()))?;
        }
        Ok(())
    }

    /// Give a price to rows that were billed at $0 because their model was
    /// unpriced at the time (`cost_basis = 'unpriced'`, or a legacy
    /// `'computed'` row with tokens but no cost). `price` resolves a model to
    /// its current prices; rows whose model is still unpriced are marked
    /// `'unpriced'` and keep $0; an explicit $0 price (a local or
    /// deliberately-free model) marks the row `'computed'`. Returns rows that
    /// got a price. (The app's own path splits this around the DB lock —
    /// `commands::reprice_ledger`; this one-call form is for tests.)
    pub fn reprice_unpriced(
        &self,
        price: &dyn Fn(&str) -> Option<crate::token_engine::ModelPrices>,
    ) -> AppResult<usize> {
        let candidates = self.reprice_candidates(true)?;
        self.apply_reprice(&plan_reprice(&candidates, price))
    }

    /// One-time correction of DIRECT run figures billed at a known-wrong
    /// builtin price: every `run_stages` row whose model normalizes to one
    /// of `ratios`' ids has its cost scaled by that ratio (stages persist no
    /// cache split, and those prices were wrong by one uniform factor), each
    /// affected run's `cost_usd` drops by the difference, and a run whose
    /// reference model is one of those ids has its baseline scaled too
    /// (then clamped to ≥ cost, like `recompute_run_cost`). Retired attempts
    /// carry no model and are left as they are. Returns stages changed.
    pub fn fix_stale_direct_prices(&self, ratios: &[(String, f64)]) -> AppResult<usize> {
        if ratios.is_empty() {
            return Ok(0);
        }
        let ratio_of = |model: &str| {
            let norm = crate::token_engine::normalize_model_id(model);
            ratios.iter().find(|(id, _)| *id == norm).map(|(_, r)| *r)
        };
        let stages: Vec<(String, String, String, f64)> = {
            let mut stmt = self.conn.prepare(
                "SELECT id, run_id, agent_model, cost_usd FROM run_stages WHERE cost_usd > 0",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let runs: Vec<(String, f64, f64, Option<String>)> = {
            let mut stmt = self.conn.prepare("SELECT id, cost_usd, baseline_usd, reference_model FROM runs")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        self.conn.execute_batch("SAVEPOINT stale_direct")?;
        let result = (|| -> AppResult<usize> {
            let mut changed = 0usize;
            let mut delta: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
            for (id, run_id, model, cost) in &stages {
                let Some(r) = ratio_of(model) else { continue };
                let new = cost * r;
                self.conn.execute("UPDATE run_stages SET cost_usd = ?2 WHERE id = ?1", params![id, new])?;
                *delta.entry(run_id.clone()).or_insert(0.0) += cost - new;
                changed += 1;
            }
            for (id, cost, baseline, reference) in &runs {
                let d = delta.get(id).copied().unwrap_or(0.0);
                let ref_ratio = reference.as_deref().and_then(ratio_of);
                if d == 0.0 && ref_ratio.is_none() {
                    continue;
                }
                let new_cost = (cost - d).max(0.0);
                let new_baseline = (baseline * ref_ratio.unwrap_or(1.0)).max(new_cost);
                self.conn.execute(
                    "UPDATE runs SET cost_usd = ?2, baseline_usd = ?3 WHERE id = ?1",
                    params![id, new_cost, new_baseline],
                )?;
            }
            Ok(changed)
        })();
        match result {
            Ok(_) => self.conn.execute_batch("RELEASE stale_direct")?,
            Err(_) => self.conn.execute_batch("ROLLBACK TO stale_direct; RELEASE stale_direct")?,
        }
        result
    }

    /// List a single thread's messages in chronological order. (Scoped by
    /// thread, not workspace — a workspace can hold several conversations.)
    pub fn list_chat_messages(&self, thread_id: &str) -> AppResult<Vec<ChatMessageRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, role, content, model, input_tokens, output_tokens, cost_usd, created_at,
                    cache_read_tokens, cache_creation_tokens, context_tokens, context_blocks,
                    raw_json, tool_use_id, model_view, error_kind
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
                cache_read_tokens: r.get(9)?,
                cache_creation_tokens: r.get(10)?,
                context_tokens: r.get(11)?,
                context_blocks: r.get(12)?,
                raw_json: r.get(13)?,
                tool_use_id: r.get(14)?,
                model_view: r.get(15)?,
                error_kind: r.get(16)?,
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
                loop_max_iterations: clamp_loop_iterations(r.get(8)?),
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
        // Models come from the builtin lineup's tags, so a fresh install seeds
        // current models. Crews already seeded are never rewritten (keyed on the
        // name below): a saved crew's cost doesn't change silently.
        let fast = crate::provider_router::builtin_anthropic_model_tagged("fast");
        let balanced = crate::provider_router::builtin_anthropic_model_tagged("balanced");
        let (fast, balanced) = (fast.as_str(), balanced.as_str());
        // (name, description, [(role, model, substrate, checkpoint, loop_target, loop_max, loop_mode)])
        let defs: &[(&str, &str, &[(&str, &str, &str, bool, Option<i64>, i64, Option<&str>)])] = &[
            (
                "Feature Factory",
                "Full build: plan, review, implement, review, test.",
                &[
                    ("plan",        fast,     "api", false, None,    0, None),
                    ("plan_review", fast,     "api", false, None,    0, None),
                    ("implement",   balanced, "api", true,  None,    0, None),
                    ("code_review", fast,     "api", true,  Some(2), 2, Some("gated")),
                    ("test",        fast,     "api", true,  None,    0, None),
                ],
            ),
            (
                "Bugfix relay",
                "Reproduce, fix, verify. Lean and fast.",
                &[
                    ("repro",  fast,     "api", false, None,    0, None),
                    ("fix",    balanced, "api", true,  None,    0, None),
                    ("verify", fast,     "api", true,  Some(1), 2, Some("gated")),
                ],
            ),
            (
                "Plan & review",
                "Thinking only — no code is written.",
                &[
                    ("plan",     balanced, "api", false, None, 0, None),
                    ("critique", fast,     "api", false, None, 0, None),
                    ("refine",   balanced, "api", true,  None, 0, None),
                ],
            ),
            (
                "Ship it",
                "Issue to pull request: plan, implement, review, test, open the PR.",
                &[
                    ("plan",         fast,     "api", false, None,    0, None),
                    ("implement",    balanced, "api", true,  None,    0, None),
                    ("code_review",  fast,     "api", true,  Some(1), 2, Some("gated")),
                    ("test",         fast,     "api", true,  None,    0, None),
                    ("pull_request", balanced, "cli", true,  None,    0, None),
                ],
            ),
            (
                "Claude Code build",
                "Plan via API, then implement, review, and test with Claude Code (CLI).",
                &[
                    ("plan",        fast,     "api", false, None,    0, None),
                    ("implement",   balanced, "cli", true,  None,    0, None),
                    ("code_review", fast,     "cli", true,  Some(1), 2, Some("gated")),
                    ("test",        fast,     "cli", true,  None,    0, None),
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

        // The Greenfield crew (prompt genesis, G3): plan-with-stack-choice →
        // gate → scaffold → first working increment → honest verification. It
        // carries per-stage instructions the simple `defs` shape can't express,
        // so it seeds separately (still idempotent on the builtin name).
        self.seed_greenfield_pipeline()?;
        self.seed_perf_probe_pipeline()?;

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

    /// Seed the "Greenfield" builtin — the crew that turns a prompt into a first
    /// working slice of a brand-new project. Idempotent (keyed on the name). The
    /// director chose (G3): the crew CHOOSES the stack, gated by a checkpoint the
    /// director approves before any scaffolding; it ends at a LOCAL repo (no
    /// push/PR). Honesty is mechanical — the final stage writes a verification
    /// README declaring what it could and could NOT verify.
    fn seed_greenfield_pipeline(&self) -> AppResult<()> {
        let exists: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM pipelines WHERE name = ?1 AND is_builtin = 1",
            params!["Greenfield"],
            |r| r.get(0),
        )?;
        if exists > 0 {
            return Ok(());
        }
        let pid = self.insert_pipeline(
            "Greenfield",
            "From a prompt to a first working slice of a brand-new project.",
            true,
        )?;
        let fast = crate::provider_router::builtin_anthropic_model_tagged("fast");
        let balanced = crate::provider_router::builtin_anthropic_model_tagged("balanced");
        let (fast, balanced) = (fast.as_str(), balanced.as_str());
        // (role, custom_name, model, checkpoint, loop_target, loop_max, loop_mode, instructions)
        let stages: &[(&str, &str, &str, bool, Option<i64>, i64, Option<&str>, &str)] = &[
            (
                "plan", "Choose the stack", balanced, true, None, 0, None,
                "This is a GREENFIELD project — the repository is empty. Read the brief and choose the \
                 SIMPLEST language, framework, and structure that genuinely satisfies it (bias to what \
                 can be verified locally with common toolchains). Propose the directory structure and a \
                 FIRST working increment — the smallest slice that actually runs. Explicitly declare what \
                 you will NOT attempt in this first slice. Do NOT write any code yet; this is the plan the \
                 director approves before the build begins.",
            ),
            (
                "implement", "Scaffold", balanced, false, None, 0, None,
                "Scaffold ONLY the structure the approved plan chose: directories, dependency manifests, \
                 config, and a sensible .gitignore. Do not implement features yet — create the skeleton \
                 that installs/builds cleanly. Prefer standard, well-known project layouts for the chosen \
                 stack.",
            ),
            (
                "implement", "First increment", balanced, true, None, 0, None,
                "Implement the FIRST working increment from the plan — the smallest slice that actually \
                 runs: a passing test, a server that responds, a CLI that does one thing, or a view that \
                 compiles. Keep it minimal and real. This is a starting point a developer can build on, \
                 not a finished product.",
            ),
            (
                "code_review", "Review the increment", fast, true, Some(2), 2, Some("gated"),
                "Review the increment for correctness and obvious issues. Keep the bar at 'a competent \
                 first slice', not 'production-ready' — this is a greenfield starting point.",
            ),
            (
                "test", "Verify honestly", balanced, true, None, 0, None,
                "Run whatever can be run to verify the increment. Then write a README.md that is HONEST: \
                 how to run it, what you actually verified (e.g. 'tests pass', 'the server responds on \
                 :3000'), and what you could NOT verify in this environment (e.g. 'no iOS simulator \
                 available to launch the app'). Never claim more than you verified. Do not push anywhere \
                 or open a pull request — the work stays in this local repository.",
            ),
        ];
        for (i, (role, custom_name, model, checkpoint, lt, lm, lmode, instructions)) in
            stages.iter().enumerate()
        {
            let id = Uuid::new_v4().to_string();
            self.conn.execute(
                "INSERT INTO pipeline_stages
                    (id, pipeline_id, position, role, agent_model, substrate, checkpoint,
                     loop_target_position, loop_max_iterations, loop_mode, max_iterations,
                     custom_name, instructions)
                 VALUES (?1,?2,?3,?4,?5,'api',?6,?7,?8,?9,25,?10,?11)",
                params![id, pid, i as i64, role, model, *checkpoint as i64, lt, lm, lmode, custom_name, instructions],
            )?;
        }
        Ok(())
    }

    /// Seed the "Perf probe" builtin — the crew a `perf` (Chase a regression)
    /// mission stages: a READ-ONLY investigation of what got slow. Idempotent
    /// (keyed on the name). Every stage is api + carries authored instructions;
    /// nothing writes code (the mission is readonly, so the sandbox enforces it —
    /// the crew reads, measures with existing tooling, and reports its findings as
    /// the stage artifact, never a file it can't write).
    fn seed_perf_probe_pipeline(&self) -> AppResult<()> {
        let exists: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM pipelines WHERE name = ?1 AND is_builtin = 1",
            params!["Perf probe"],
            |r| r.get(0),
        )?;
        if exists > 0 {
            return Ok(());
        }
        let pid = self.insert_pipeline(
            "Perf probe",
            "Read-only: profile the code and find what regressed.",
            true,
        )?;
        // The `critique` role is read-only-oriented ("verify claims with your
        // tools"); we override the per-stage tool allowlist so the measure/find
        // stages can RUN profilers (`run_command`) while the report stage stays
        // read-only. (The mission is readonly regardless — the sandbox blocks any
        // write — but a tight allowlist keeps the agent from even trying.)
        let profile_tools = r#"["read_file","list_files","run_command"]"#;
        let read_tools = r#"["read_file","list_files"]"#;
        let model = crate::provider_router::builtin_anthropic_model_tagged("balanced");
        // (custom_name, checkpoint, instructions, tools_json)
        let stages: &[(&str, bool, &str, &str)] = &[
            (
                "Measure", false,
                "This is a READ-ONLY performance investigation — you cannot modify the code. Read the \
                 brief, then MEASURE: identify the hot path(s) with the tooling available (existing \
                 benchmarks, `time`, a profiler, reading the code's complexity). State what you measured \
                 and the numbers. Do NOT propose a fix yet.",
                profile_tools,
            ),
            (
                "Find the regression", false,
                "From the measurements, IDENTIFY what got slow and WHY — the specific function, query, \
                 allocation, or algorithm, with the evidence (the code + the numbers). Compare against \
                 git history if it helps pinpoint the change that introduced it. Read-only: no edits.",
                profile_tools,
            ),
            (
                "Report", true,
                "Write the findings as your final answer (the stage artifact — you can't write files in a \
                 read-only mission): the regression, the evidence, and a RECOMMENDED fix described in \
                 words (not applied). End with the honest boundary — what you could and could NOT measure \
                 in this environment. To actually apply the fix, the director starts a `fix` mission.",
                read_tools,
            ),
        ];
        for (i, (custom_name, checkpoint, instructions, tools)) in stages.iter().enumerate() {
            let id = Uuid::new_v4().to_string();
            self.conn.execute(
                "INSERT INTO pipeline_stages
                    (id, pipeline_id, position, role, agent_model, substrate, checkpoint,
                     loop_target_position, loop_max_iterations, loop_mode, max_iterations,
                     custom_name, instructions, tools)
                 VALUES (?1,?2,?3,'critique',?8,'api',?4,NULL,0,NULL,25,?5,?6,?7)",
                params![id, pid, i as i64, *checkpoint as i64, custom_name, instructions, tools, model],
            )?;
        }
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
        // Stamp the run's mission at birth so DIRECT spend/savings/run-count roll
        // up in the Logbook. `record_direct_spend` and `mission_run_stats` both
        // read `runs.mission_id`; without this they'd stay NULL forever (only the
        // one-shot backfill ever wrote the column otherwise).
        let mission_id = self
            .active_mission_for_workspace(workspace_id)?
            .map(|m| m.id);
        self.conn.execute(
            "INSERT INTO runs (id, workspace_id, pipeline_id, task, status, reference_model, linked_issue_key, created_at, mission_id)
             VALUES (?1,?2,?3,?4,'draft',?5,?6,?7,?8)",
            params![id, workspace_id, pipeline_id, task, reference_model, linked_issue_key, now, mission_id],
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
                        reference_model, linked_issue_key, created_at, finished_at, budget_usd, detached,
                    plan_window, plan_resets_at, plan_resume_at, plan_resume_count, EXISTS (SELECT 1 FROM run_stages s WHERE s.run_id = runs.id
                      AND (s.status = 'awaiting_checkpoint'
                           OR (s.status = 'failed' AND instr(COALESCE(s.error, ''), '(plan_limit)') = 0))),
                    plan_stale_count
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
                    reference_model, linked_issue_key, created_at, finished_at, budget_usd, detached,
                    plan_window, plan_resets_at, plan_resume_at, plan_resume_count, EXISTS (SELECT 1 FROM run_stages s WHERE s.run_id = runs.id
                      AND (s.status = 'awaiting_checkpoint'
                           OR (s.status = 'failed' AND instr(COALESCE(s.error, ''), '(plan_limit)') = 0))),
                    plan_stale_count
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
                    reference_model, linked_issue_key, created_at, finished_at, budget_usd, detached,
                    plan_window, plan_resets_at, plan_resume_at, plan_resume_count, EXISTS (SELECT 1 FROM run_stages s WHERE s.run_id = runs.id
                      AND (s.status = 'awaiting_checkpoint'
                           OR (s.status = 'failed' AND instr(COALESCE(s.error, ''), '(plan_limit)') = 0))),
                    plan_stale_count
             FROM runs WHERE status IN ('running', 'paused') ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], row_to_run)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// What every `paused` run waits on, for the menu bar Octo (#718): one row
    /// per blocked stage (`awaiting_checkpoint` or `failed`), in stage order,
    /// or a single row with no stage for a paused run with none blocked (the
    /// director's own pause at a boundary). Only the few columns the menu
    /// reads: never a stage's artifact, diff or journal. The stage's title is
    /// the frontend's `stageTitle`: the author's custom name, else the role's
    /// label.
    pub fn list_parked_stages(&self) -> AppResult<Vec<ParkedStageRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT r.id, w.name, s.status,
                    COALESCE(NULLIF(TRIM(s.custom_name), ''), ro.label, s.role),
                    s.started_at IS NOT NULL,
                    TRIM(COALESCE(s.blocked_questions, '')) != '',
                    s.secret_hold,
                    s.error
             FROM runs r
             LEFT JOIN workspaces w ON w.id = r.workspace_id
             LEFT JOIN run_stages s ON s.run_id = r.id AND s.status IN ('awaiting_checkpoint', 'failed')
             LEFT JOIN roles ro ON ro.key = s.role
             WHERE r.status = 'paused'
             ORDER BY r.id, s.position",
        )?;
        let rows = stmt.query_map([], |r| {
            let status: Option<String> = r.get(2)?;
            let stage = match status {
                Some(status) => {
                    let error: Option<String> = r.get(7)?;
                    Some(ParkedStage {
                        status,
                        title: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                        started: r.get(4)?,
                        asked: r.get(5)?,
                        // An approved hold no longer holds the stage.
                        secret_held: r
                            .get::<_, Option<String>>(6)?
                            .and_then(|j| serde_json::from_str::<crate::secret_scan::SecretHold>(&j).ok())
                            .is_some_and(|h| !h.acknowledged),
                        plan_limited: error.as_deref().is_some_and(crate::orchestrator::cli_runner::is_plan_limit),
                        error,
                    })
                }
                None => None,
            };
            Ok(ParkedStageRow { run_id: r.get(0)?, workspace_name: r.get(1)?, stage })
        })?;
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
                    reference_model, linked_issue_key, created_at, finished_at, budget_usd, detached,
                    plan_window, plan_resets_at, plan_resume_at, plan_resume_count, EXISTS (SELECT 1 FROM run_stages s WHERE s.run_id = runs.id
                      AND (s.status = 'awaiting_checkpoint'
                           OR (s.status = 'failed' AND instr(COALESCE(s.error, ''), '(plan_limit)') = 0))),
                    plan_stale_count
             FROM runs WHERE status IN ('completed', 'aborted') ORDER BY created_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], row_to_run)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Runs that reached `completed`/`aborted` strictly AFTER `since` (an
    /// RFC 3339 instant), across all workspaces, newest finish first, capped at
    /// 50. Drives Mission Control's "While you were away" seed. `finished_at`
    /// is always `Utc::now().to_rfc3339()`, so `since` is normalised to the
    /// same UTC form and a string `>` is chronological. An unparseable `since`
    /// yields nothing rather than everything.
    pub fn list_runs_settled_since(&self, since: &str) -> AppResult<Vec<RunRow>> {
        let Ok(since) = DateTime::parse_from_rfc3339(since) else {
            return Ok(Vec::new());
        };
        let since = since.with_timezone(&Utc).to_rfc3339();
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, pipeline_id, task, status, cost_usd, baseline_usd,
                    reference_model, linked_issue_key, created_at, finished_at, budget_usd, detached,
                    plan_window, plan_resets_at, plan_resume_at, plan_resume_count, EXISTS (SELECT 1 FROM run_stages s WHERE s.run_id = runs.id
                      AND (s.status = 'awaiting_checkpoint'
                           OR (s.status = 'failed' AND instr(COALESCE(s.error, ''), '(plan_limit)') = 0))),
                    plan_stale_count
             FROM runs
             WHERE status IN ('completed', 'aborted') AND finished_at IS NOT NULL AND finished_at > ?1
             ORDER BY finished_at DESC LIMIT 50",
        )?;
        let rows = stmt.query_map(params![since], row_to_run)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Stamp `last_quit_at` (written as the app exits). The next launch shows
    /// what settled after it.
    pub fn mark_quit(&self, at: DateTime<Utc>) -> AppResult<()> {
        self.meta_set("last_quit_at", &at.to_rfc3339())
    }

    /// When the user was last away from: the `last_quit_at` marker, or 24 h
    /// before `now` when it's missing or unreadable (first launch with this
    /// build, or a crash that skipped the quit hook).
    pub fn away_since(&self, now: DateTime<Utc>) -> AppResult<String> {
        if let Some(v) = self.meta_get("last_quit_at")? {
            if DateTime::parse_from_rfc3339(&v).is_ok() {
                return Ok(v);
            }
        }
        Ok((now - chrono::Duration::hours(24)).to_rfc3339())
    }

    // ── app_meta: tiny key/value store for app-global scalars ────────────────

    /// Read a scalar from `app_meta`; `None` if the key was never set.
    /// Run one or more SQL statements with no parameters (savepoints,
    /// pragmas). For callers outside this module that need a transaction
    /// bracket around several `Db` calls.
    pub fn execute_batch(&self, sql: &str) -> AppResult<()> {
        self.conn.execute_batch(sql).map_err(Into::into)
    }

    pub fn meta_get(&self, key: &str) -> AppResult<Option<String>> {
        self.conn
            .query_row("SELECT value FROM app_meta WHERE key = ?1", params![key], |r| r.get(0))
            .optional()
            .map_err(Into::into)
    }

    /// Every `app_meta` row whose key starts with `prefix`, as (key, value).
    pub fn meta_list_prefix(&self, prefix: &str) -> AppResult<Vec<(String, String)>> {
        let escaped = prefix.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        let mut stmt = self
            .conn
            .prepare("SELECT key, value FROM app_meta WHERE key LIKE ?1 ESCAPE '\\' ORDER BY key")?;
        let rows = stmt
            .query_map(params![format!("{escaped}%")], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Upsert several `app_meta` scalars in one transaction: all or none.
    pub fn meta_set_many(&self, pairs: &[(String, String)]) -> AppResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        for (k, v) in pairs {
            tx.execute(
                "INSERT INTO app_meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![k, v],
            )?;
        }
        tx.commit()?;
        Ok(())
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

    /// Atomically CLAIM a genesis project's one-shot post-build rename (G6),
    /// resolved from one of its workspaces. Returns `Some((project_id, prompt))`
    /// exactly once — the first caller after a prompt-born project's first crew
    /// ships — and `None` thereafter (already claimed), for a non-genesis
    /// project, or an unknown workspace. Check-and-set under a single lock so two
    /// runs of the same project completing at once can't both offer.
    pub fn claim_genesis_rename(&self, workspace_id: &str) -> AppResult<Option<(String, String)>> {
        let project_id: Option<String> = self
            .conn
            .query_row(
                "SELECT project_id FROM workspaces WHERE id = ?1",
                params![workspace_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(project_id) = project_id else { return Ok(None) };
        if self.meta_get(&format!("genesis_renamed:{project_id}"))?.is_some() {
            return Ok(None);
        }
        let Some(prompt) = self.meta_get(&format!("genesis_prompt:{project_id}"))? else {
            return Ok(None);
        };
        // Claim it now (before the slow name generation), so a concurrent
        // completion sees it already offered.
        self.meta_set(&format!("genesis_renamed:{project_id}"), "1")?;
        Ok(Some((project_id, prompt)))
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
                loop_max_iterations: clamp_loop_iterations(r.get(5)?),
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
        // A pipeline saved before the loop cap may arrive with a larger count:
        // clamp it rather than skip the item forever.
        let stages: Vec<StageDraft> = sp
            .stages
            .iter()
            .cloned()
            .map(|mut st| {
                st.loop_max_iterations = clamp_loop_iterations(st.loop_max_iterations);
                st
            })
            .collect();
        self.validate_pipeline_stages(&stages)?;
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO pipelines (id, name, description, is_builtin, created_at, updated_at)
             VALUES (?1, ?2, ?3, 0, ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET name = ?2, description = ?3, updated_at = ?4
             WHERE pipelines.is_builtin = 0",
            params![sp.id, sp.name, sp.description, sp.updated_at],
        )?;
        tx.execute("DELETE FROM pipeline_stages WHERE pipeline_id = ?1", params![sp.id])?;
        for (i, st) in stages.iter().enumerate() {
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
                    escalate_model, escalate_effort, escalated, blocked_transcript, secret_hold
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
                blocked_transcript: r.get(34)?,
                secret_hold: r
                    .get::<_, Option<String>>(35)?
                    .and_then(|j| serde_json::from_str(&j).ok()),
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

    // ── Claude plan limit park (#731) ────────────────────────────────────────

    /// Park the run at a Claude plan limit: the window, its reset, and the
    /// automatic resume (`None` = the director resumes), and how many reports
    /// in a row came with their reset already past (`stale_count`, #1109).
    pub fn set_run_plan_wait(
        &self,
        run_id: &str,
        window: &str,
        resets_at: i64,
        resume_at: Option<i64>,
        stale_count: i64,
    ) -> AppResult<()> {
        self.conn.execute(
            "UPDATE runs SET plan_window = ?2, plan_resets_at = ?3, plan_resume_at = ?4, plan_stale_count = ?5
             WHERE id = ?1",
            params![run_id, window, resets_at, resume_at, stale_count],
        )?;
        Ok(())
    }

    /// The run is no longer parked by its plan (resumed, resolved, aborted).
    /// The automatic-resume count is kept: see [`Db::reset_plan_resume_count`].
    /// So is the stale-report count: the next report must know it came in a row.
    pub fn clear_run_plan_wait(&self, run_id: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE runs SET plan_window = NULL, plan_resets_at = NULL, plan_resume_at = NULL WHERE id = ?1",
            params![run_id],
        )?;
        Ok(())
    }

    /// The director turned the automatic resume off: the run stays parked by
    /// its plan and waits for a manual Resume. Returns whether one was due.
    pub fn cancel_plan_resume(&self, run_id: &str) -> AppResult<bool> {
        let n = self.conn.execute(
            "UPDATE runs SET plan_resume_at = NULL WHERE id = ?1 AND plan_resume_at IS NOT NULL",
            params![run_id],
        )?;
        Ok(n > 0)
    }

    /// Claim the automatic resume of a plan-parked run whose time has come:
    /// a compare-and-set, so the app's tick and a waiting detached worker can
    /// race and exactly one of them resumes. Counts the resume, unless the
    /// park came from a stale report (`plan_stale_count`, #1109): that one
    /// resume is Claude Code's error, not the plan's wall.
    ///
    /// The claim does NOT clear the resume time: it moves it to `retry_at`.
    /// Applying the Resume ends the park (`clear_run_plan_wait`); until then
    /// the park stays due again at `retry_at`, so a claimant that fails or
    /// dies between the claim and the apply can never lose the resume.
    pub fn claim_plan_resume(&self, run_id: &str, now: i64, retry_at: i64) -> AppResult<bool> {
        let n = self.conn.execute(
            "UPDATE runs SET plan_resume_at = ?3,
                 plan_resume_count = plan_resume_count + (CASE WHEN plan_stale_count > 0 THEN 0 ELSE 1 END)
             WHERE id = ?1 AND status = 'paused' AND plan_resume_at IS NOT NULL AND plan_resume_at <= ?2",
            params![run_id, now, retry_at],
        )?;
        Ok(n > 0)
    }

    /// Undo a claim whose Resume couldn't be applied: the run is parked by its
    /// plan again, its automatic resume due at `resume_at` (`None` = it now
    /// waits for the director), and the claim no longer counts against the cap.
    ///
    /// Only the claim's own park is put back: the schedule must still be the
    /// `claimed_at` the claim set, or the park must be gone entirely (the
    /// failed apply cleared it). A park whose schedule changed meanwhile (the
    /// director turned the automatic resume off, which keeps the window but
    /// clears `plan_resume_at`) is left as the director left it. Returns
    /// whether the park was put back.
    pub fn restore_plan_resume(
        &self,
        run_id: &str,
        window: &str,
        resets_at: i64,
        resume_at: Option<i64>,
        claimed_at: i64,
    ) -> AppResult<bool> {
        let n = self.conn.execute(
            "UPDATE runs SET plan_window = ?2, plan_resets_at = ?3, plan_resume_at = ?4,
                 plan_resume_count = MAX(plan_resume_count - (CASE WHEN plan_stale_count > 0 THEN 0 ELSE 1 END), 0)
             WHERE id = ?1 AND status = 'paused'
               AND (plan_resume_at = ?5 OR (plan_window IS NULL AND plan_resume_at IS NULL))",
            params![run_id, window, resets_at, resume_at, claimed_at],
        )?;
        Ok(n > 0)
    }

    /// A fresh allowance of automatic resumes (the director acted, or a stage
    /// finished: the run got past the wall). Failed claims and stale reports
    /// start over too.
    pub fn reset_plan_resume_count(&self, run_id: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE runs SET plan_resume_count = 0, plan_retry_count = 0, plan_stale_count = 0
             WHERE id = ?1 AND (plan_resume_count <> 0 OR plan_retry_count <> 0 OR plan_stale_count <> 0)",
            params![run_id],
        )?;
        Ok(())
    }

    /// Count one more automatic resume that was claimed but couldn't be
    /// applied, by any process; returns the consecutive count.
    pub fn bump_plan_retry_count(&self, run_id: &str) -> AppResult<i64> {
        self.conn.execute(
            "UPDATE runs SET plan_retry_count = plan_retry_count + 1 WHERE id = ?1",
            params![run_id],
        )?;
        self.plan_retry_count(run_id)
    }

    /// Consecutive automatic resumes claimed but not applied.
    pub fn plan_retry_count(&self, run_id: &str) -> AppResult<i64> {
        Ok(self
            .conn
            .query_row("SELECT plan_retry_count FROM runs WHERE id = ?1", params![run_id], |r| r.get(0))
            .optional()?
            .unwrap_or(0))
    }

    /// An automatic resume applied (or handed to the director): failed
    /// claims start over.
    pub fn reset_plan_retry_count(&self, run_id: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE runs SET plan_retry_count = 0 WHERE id = ?1 AND plan_retry_count <> 0",
            params![run_id],
        )?;
        Ok(())
    }

    /// Automatic plan resumes since the director last acted or a stage finished.
    pub fn plan_resume_count(&self, run_id: &str) -> AppResult<i64> {
        Ok(self
            .conn
            .query_row("SELECT plan_resume_count FROM runs WHERE id = ?1", params![run_id], |r| r.get(0))
            .optional()?
            .unwrap_or(0))
    }

    /// Plan-limit reports in a row whose reset was already past (#1109),
    /// since the director last acted or a stage finished.
    pub fn plan_stale_count(&self, run_id: &str) -> AppResult<i64> {
        Ok(self
            .conn
            .query_row("SELECT plan_stale_count FROM runs WHERE id = ?1", params![run_id], |r| r.get(0))
            .optional()?
            .unwrap_or(0))
    }

    /// Paused runs whose automatic plan resume is due at `now`.
    pub fn list_due_plan_resumes(&self, now: i64) -> AppResult<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM runs WHERE status = 'paused' AND plan_resume_at IS NOT NULL
             AND plan_resume_at <= ?1 ORDER BY plan_resume_at",
        )?;
        let rows = stmt.query_map(params![now], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
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

    /// The name of the Routine whose last fired run is `run_id`
    /// (`last_run_id`), if any — how "Notify me elsewhere" (#964) tells a
    /// Routine's crew from one the director started, and what it calls it. A
    /// Routine never fires again while its run is live (the fire guards), so
    /// its run is still `last_run_id` when it ends.
    pub fn routine_name_for_run(&self, run_id: &str) -> AppResult<Option<String>> {
        let name: Option<String> = self
            .conn
            .query_row(
                "SELECT name FROM routines WHERE last_run_id = ?1 LIMIT 1",
                params![run_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(name)
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

    /// Persist (or clear, with `None`) the secret guard's hold on a stage (#730).
    pub fn set_stage_secret_hold(&self, stage_id: &str, hold: Option<&crate::secret_scan::SecretHold>) -> AppResult<()> {
        let json = hold.map(serde_json::to_string).transpose()?;
        self.conn.execute(
            "UPDATE run_stages SET secret_hold = ?2 WHERE id = ?1",
            params![stage_id, json],
        )?;
        Ok(())
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

    /// Set/clear the stage's persisted ask_director conversation transcript.
    pub fn set_stage_blocked_transcript(&self, stage_id: &str, json: Option<&str>) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET blocked_transcript = ?2 WHERE id = ?1",
            params![stage_id, json],
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

    /// Mark a run-stage whose CLI stopped before reporting usage (sticky; see
    /// the `usage_unreported` column), and its current attempt.
    pub fn set_run_stage_usage_unreported(&self, stage_id: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET usage_unreported = 1, attempt_usage_unreported = 1 WHERE id = ?1",
            params![stage_id],
        )?;
        Ok(())
    }

    /// Record the model a stage's attempt actually ran on (`None` = the one
    /// it asked for). Set before the attempt's completion is recorded, so its
    /// spend event is attributed to that model (`record_direct_spend`).
    pub fn set_run_stage_ran_model(&self, stage_id: &str, ran_model: Option<&str>) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET ran_model = ?2 WHERE id = ?1",
            params![stage_id, ran_model],
        )?;
        Ok(())
    }

    /// The run's stages that ran on another model than they asked for:
    /// stage id → the model that ran.
    pub fn ran_models(&self, run_id: &str) -> AppResult<std::collections::HashMap<String, String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, ran_model FROM run_stages WHERE run_id = ?1 AND ran_model IS NOT NULL")?;
        let rows = stmt.query_map(params![run_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<Result<_, _>>().map_err(Into::into)
    }

    /// Record a Claude CLI stage's latest context reading (#895): the context
    /// size of its latest top-level assistant message and the window of the
    /// model that answered it (`None` when the catalog doesn't know it).
    /// Written by `PersistingSink`, at most once per message.
    pub fn set_run_stage_context(&self, stage_id: &str, tokens: i64, window: Option<i64>) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET context_tokens = ?2, context_window = ?3 WHERE id = ?1",
            params![stage_id, tokens, window],
        )?;
        Ok(())
    }

    /// The run's stages with a context reading: stage id → (tokens, window).
    pub fn stage_contexts(&self, run_id: &str) -> AppResult<std::collections::HashMap<String, (i64, Option<i64>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, context_tokens, context_window FROM run_stages
             WHERE run_id = ?1 AND context_tokens IS NOT NULL",
        )?;
        let rows = stmt.query_map(params![run_id], |r| {
            Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)?, r.get::<_, Option<i64>>(2)?)))
        })?;
        rows.collect::<Result<_, _>>().map_err(Into::into)
    }

    /// Record how many tool calls Claude Code refused in a stage's attempt
    /// (`0` clears an earlier attempt's).
    pub fn set_run_stage_refused_calls(&self, stage_id: &str, count: u32) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET refused_calls = ?2 WHERE id = ?1",
            params![stage_id, count],
        )?;
        Ok(())
    }

    /// The run's stages whose last attempt had tool calls refused: stage id →
    /// how many.
    pub fn refused_call_counts(&self, run_id: &str) -> AppResult<std::collections::HashMap<String, u32>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, refused_calls FROM run_stages WHERE run_id = ?1 AND refused_calls > 0")?;
        let rows = stmt.query_map(params![run_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?)))?;
        rows.collect::<Result<_, _>>().map_err(Into::into)
    }

    /// Ids of the run's stages flagged `usage_unreported`.
    pub fn usage_unreported_stage_ids(&self, run_id: &str) -> AppResult<std::collections::HashSet<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM run_stages WHERE run_id = ?1 AND usage_unreported != 0")?;
        let rows = stmt.query_map(params![run_id], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<std::collections::HashSet<_>, _>>().map_err(Into::into)
    }

    pub fn set_run_stage_status(&self, stage_id: &str, status: &str) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        // Stamp started_at the first time it goes running. A (re)start also
        // forgets the last attempt's context reading (#895): the new attempt's
        // first message brings its own, and the last attempt's unreported
        // usage (#860): the sticky `usage_unreported` keeps it.
        self.conn.execute(
            "UPDATE run_stages SET status = ?2,
                started_at = COALESCE(started_at, CASE WHEN ?2 = 'running' THEN ?3 ELSE started_at END),
                context_tokens = CASE WHEN ?2 = 'running' THEN NULL ELSE context_tokens END,
                context_window = CASE WHEN ?2 = 'running' THEN NULL ELSE context_window END,
                attempt_usage_unreported = CASE WHEN ?2 = 'running' THEN 0 ELSE attempt_usage_unreported END
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
        cache_read_tokens: i64,
        cache_creation_tokens: i64,
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
        // Mirror the burned spend into the canonical ledger so DIRECT shows up in
        // Settings→Usage and counts against USD budgets (Phase 2). This is the
        // single choke point for every stage completion (done / failed-with-usage
        // / accept-partial), so all DIRECT spend flows through here exactly once
        // per completion. A re-run is a fresh completion with a new `now`, hence a
        // new idempotency key — every burned attempt stays counted (matching the
        // retire-inclusive run meter). Best-effort: a ledger hiccup must not fail
        // the run itself, and the authoritative run figure is still runs.cost_usd.
        if cost_usd > 0.0 || input_tokens > 0 || output_tokens > 0 {
            if let Err(e) = self.record_direct_spend(
                stage_id,
                &now,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_creation_tokens,
                cost_usd,
            ) {
                tracing::warn!(stage_id, error = %e, "failed to mirror DIRECT stage spend to the ledger");
            }
        }
        Ok(())
    }

    /// Re-close a halted stage as `done` with a director-accepted artifact,
    /// keeping the token/cost columns the failed attempt already burned. Does
    /// NOT mirror to the ledger: that spend was recorded when the attempt
    /// completed, and re-completing through `complete_run_stage` would insert
    /// a second `direct` row under a fresh timestamp key (double-counting the
    /// stage in Usage and budgets).
    pub fn accept_run_stage_partial(&self, stage_id: &str, artifact_json: &str) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE run_stages SET status = 'done', artifact = ?2, finished_at = ?3 WHERE id = ?1",
            params![stage_id, artifact_json, now],
        )?;
        Ok(())
    }

    /// Tokens of the `limit` most recent stages of `role` at `effort` in
    /// completed runs, each summed over every attempt the ledger recorded
    /// (loop-backs and re-runs included — that is what the stage cost).
    /// Every stage keys by its stored effort: Codex CLI stages that ran before
    /// they took one had it cleared by a one-time migration (#613), so they
    /// count as no effort, as they ran. Read-only; feeds the pre-run estimate.
    pub fn stage_token_samples(
        &self,
        role: &str,
        effort: Option<&str>,
        limit: usize,
    ) -> AppResult<Vec<crate::orchestrator::cost::TokenSample>> {
        let mut stmt = self.conn.prepare(
            "SELECT SUM(se.input_tokens), SUM(se.output_tokens),
                    SUM(se.cache_read_tokens), SUM(se.cache_creation_tokens)
             FROM spend_events se
             JOIN run_stages s ON s.id = se.source_id
             JOIN runs r ON r.id = s.run_id
             WHERE se.surface = 'direct' AND r.status = 'completed' AND s.role = ?1
               AND s.effort IS ?2
             GROUP BY s.id
             HAVING SUM(se.input_tokens + se.output_tokens + se.cache_read_tokens + se.cache_creation_tokens) > 0
             ORDER BY MAX(se.ts_utc) DESC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![role, effort, limit as i64], |r| {
            Ok(crate::orchestrator::cost::TokenSample {
                input: r.get::<_, i64>(0)?.max(0) as u64,
                output: r.get::<_, i64>(1)?.max(0) as u64,
                cache_read: r.get::<_, i64>(2)?.max(0) as u64,
                cache_creation: r.get::<_, i64>(3)?.max(0) as u64,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Every stage of `pipeline_id`'s settled runs (completed, failed or
    /// aborted), newest run first, with its archived failed attempts and the
    /// direct spend of each model that ran it. Read-only; feeds the crew
    /// report (`orchestrator::crew_report`), which picks the windows.
    pub fn stage_outcomes(&self, pipeline_id: &str) -> AppResult<Vec<crate::orchestrator::crew_report::StageRunSample>> {
        use crate::orchestrator::crew_report::{ModelSpend, StageRunSample};
        let mut stmt = self.conn.prepare(
            "SELECT s.id, s.run_id, r.status, s.position, s.role, s.status, s.escalated != 0,
                    (SELECT COUNT(*) FROM stage_iterations i WHERE i.stage_id = s.id AND i.status = 'failed'),
                    s.loop_target_position, s.loop_iterations
             FROM run_stages s JOIN runs r ON r.id = s.run_id
             WHERE r.pipeline_id = ?1 AND r.status IN ('completed', 'failed', 'aborted')
             ORDER BY r.created_at DESC, r.rowid DESC, s.position",
        )?;
        let rows = stmt.query_map(params![pipeline_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                StageRunSample {
                    run_id: r.get(1)?,
                    run_status: r.get(2)?,
                    position: r.get(3)?,
                    role: r.get(4)?,
                    status: r.get(5)?,
                    escalated: r.get(6)?,
                    failed_attempts: r.get(7)?,
                    loop_target_position: r.get(8)?,
                    loop_iterations: r.get(9)?,
                    spend: Vec::new(),
                },
            ))
        })?;
        let mut samples = rows.collect::<Result<Vec<_>, _>>()?;
        let mut stmt = self.conn.prepare(
            "SELECT se.source_id, se.model, SUM(se.cost_usd), MAX(se.cost_basis = 'unpriced'),
                    SUM(se.input_tokens), SUM(se.output_tokens),
                    SUM(se.cache_read_tokens), SUM(se.cache_creation_tokens)
             FROM spend_events se
             JOIN run_stages s ON s.id = se.source_id
             JOIN runs r ON r.id = s.run_id
             WHERE se.surface = 'direct' AND r.pipeline_id = ?1
             GROUP BY se.source_id, se.model
             ORDER BY MIN(se.ts_utc)",
        )?;
        let spend = stmt.query_map(params![pipeline_id], |r| {
            let n = |i: usize| r.get::<_, i64>(i).map(|v| v.max(0) as u64);
            Ok((
                r.get::<_, String>(0)?,
                ModelSpend {
                    model: r.get(1)?,
                    cost_usd: r.get(2)?,
                    unpriced: r.get(3)?,
                    tokens: crate::orchestrator::cost::TokenSample {
                        input: n(4)?,
                        output: n(5)?,
                        cache_read: n(6)?,
                        cache_creation: n(7)?,
                    },
                },
            ))
        })?;
        let mut by_stage: std::collections::HashMap<String, Vec<ModelSpend>> = std::collections::HashMap::new();
        for row in spend {
            let (id, m) = row?;
            by_stage.entry(id).or_default().push(m);
        }
        for (id, s) in &mut samples {
            s.spend = by_stage.remove(id.as_str()).unwrap_or_default();
        }
        Ok(samples.into_iter().map(|(_, s)| s).collect())
    }

    /// Resolve a stage's workspace/project/model and append a `direct` spend
    /// event. `finished_at`-derived idempotency key = one row per completion.
    #[allow(clippy::too_many_arguments)]
    fn record_direct_spend(
        &self,
        stage_id: &str,
        ts_utc: &str,
        input_tokens: i64,
        output_tokens: i64,
        cache_read_tokens: i64,
        cache_creation_tokens: i64,
        cost_usd: f64,
    ) -> AppResult<()> {
        let attr: Option<(String, Option<String>, String, Option<String>, bool)> = self
            .conn
            .query_row(
                "SELECT r.workspace_id, w.project_id, COALESCE(s.ran_model, s.agent_model), r.mission_id, s.attempt_usage_unreported != 0
                 FROM run_stages s
                 JOIN runs r ON r.id = s.run_id
                 LEFT JOIN workspaces w ON w.id = r.workspace_id
                 WHERE s.id = ?1",
                params![stage_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()?;
        let Some((workspace_id, project_id, model, mission_id, usage_unreported)) = attr else {
            return Ok(()); // stage vanished — nothing to attribute
        };
        // Logbook: a stage that burned spend is active DIRECT work on the mission.
        let _ = self.record_activity(&workspace_id, "direct", "stage");
        let tokens = input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens;
        // $0 with tokens on an attempt flagged `usage_unreported` (its
        // streamed tokens were all on message models with no price, e.g. an
        // unknown subagent model under a priced stage model): unknown, never
        // free — even though the stage's own model has a price. An earlier
        // attempt's flag doesn't count (#860).
        let cost_basis = if usage_unreported && cost_usd == 0.0 && tokens > 0 {
            "unpriced"
        } else {
            crate::token_engine::ledger_cost_basis(&model, cost_usd, tokens)
        };
        self.insert_spend_event(&SpendEvent {
            ts_utc: ts_utc.to_string(),
            surface: "direct".into(),
            project_id,
            workspace_id: Some(workspace_id),
            mission_id,
            source_id: Some(stage_id.to_string()),
            attempt: 1,
            model_raw: model.clone(),
            model,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            provider_cost_usd: None,
            computed_cost_usd: Some(cost_usd),
            cost_usd,
            cost_basis: cost_basis.into(),
            idempotency_key: Some(format!("direct:{stage_id}:{ts_utc}")),
            thread_id: None,
            origin: None,
            // A stage aggregates many requests.
            speed: None,
        })
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
    /// Replace a stage's pending re-run feedback in place (no reset). Used by
    /// the same-batch loop-back merge: a sibling review appends its findings
    /// to a target another review already reset.
    pub fn set_stage_feedback(&self, stage_id: &str, feedback: Option<&str>) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET feedback = ?2 WHERE id = ?1",
            params![stage_id, feedback],
        )?;
        Ok(())
    }

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
                 blocked_questions = NULL, secret_hold = NULL, ran_model = NULL, refused_calls = 0,
                 context_tokens = NULL, context_window = NULL,
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
        // The retired token counters feed only the run's all-premium
        // baseline. An attempt that burned tokens at $0 (an unpriced model —
        // or a free one; both have no cost to save against) must not count
        // as saved, so its tokens stay out of them.
        let (input_tokens, output_tokens) = if cost_usd == 0.0 && input_tokens + output_tokens > 0 {
            (0, 0)
        } else {
            (input_tokens, output_tokens)
        };
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

    /// `(retired_cost_usd, retired_input_tokens, retired_output_tokens)` for
    /// the run. The token counters hold only attempts that carried a cost
    /// (see `retire_stage_cost`), so baseline math over them never counts an
    /// unpriced attempt as saved.
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
        if let Some(sid) = session_id {
            self.record_direct_cli_session(stage_id, sid)?;
        }
        Ok(())
    }

    /// Remember for good that `session_id` is a Direct stage's CLI session
    /// (#861): its spend is the stage's `direct` row, so the transcript
    /// ingestor must never meter its transcript as RUN spend. Idempotent.
    pub fn record_direct_cli_session(&self, stage_id: &str, session_id: &str) -> AppResult<()> {
        if session_id.is_empty() {
            return Ok(());
        }
        self.conn.execute(
            "INSERT OR IGNORE INTO direct_cli_sessions (session_id, run_id, stage_id, created_at)
             VALUES (?1, (SELECT run_id FROM run_stages WHERE id = ?2), ?2, ?3)",
            params![session_id, stage_id, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Every CLI session id a Direct stage has run (see
    /// [`Self::record_direct_cli_session`]).
    pub fn direct_cli_session_ids(&self) -> AppResult<std::collections::HashSet<String>> {
        let mut stmt = self.conn.prepare("SELECT session_id FROM direct_cli_sessions")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<std::collections::HashSet<_>, _>>().map_err(Into::into)
    }

    /// Whether any of `ids` is a recorded Direct-stage CLI session (#890).
    pub fn any_direct_cli_session(&self, ids: &[String]) -> AppResult<bool> {
        let mut stmt = self.conn.prepare_cached("SELECT 1 FROM direct_cli_sessions WHERE session_id = ?1")?;
        for id in ids {
            if stmt.exists(params![id])? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Delete the transcript-ingested RUN rows with these idempotency keys —
    /// the duplicates a Direct stage's transcript produced (#861). Only
    /// `surface = 'run'` rows: the stage's own `direct` row is never touched.
    pub fn delete_run_spend_by_keys(&self, keys: &[String]) -> AppResult<usize> {
        let mut n = 0usize;
        for k in keys {
            n += self.conn.execute(
                "DELETE FROM spend_events WHERE surface = 'run' AND idempotency_key = ?1",
                params![k],
            )?;
        }
        Ok(n)
    }

    /// Mark that the next run of this stage should `--resume` its session_id.
    pub fn set_stage_resume_pending(&self, stage_id: &str, pending: bool) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET resume_pending = ?2 WHERE id = ?1",
            params![stage_id, pending as i64],
        )?;
        Ok(())
    }

    /// Mark that the stage's pending `--resume` drops its deferred call (read
    /// back by [`Self::get_stage_drop_deferred`]).
    pub fn set_stage_drop_deferred(&self, stage_id: &str, drop_call: bool) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET drop_deferred_pending = ?2 WHERE id = ?1",
            params![stage_id, drop_call as i64],
        )?;
        Ok(())
    }

    pub fn get_stage_drop_deferred(&self, stage_id: &str) -> AppResult<bool> {
        let v: Option<i64> = self
            .conn
            .query_row(
                "SELECT drop_deferred_pending FROM run_stages WHERE id = ?1",
                params![stage_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(v.unwrap_or(0) != 0)
    }

    /// Record the spend the session had reported when `resume_pending` was
    /// set (read back by [`Self::get_stage_resume_prior_cost`]).
    pub fn set_stage_resume_prior_cost(&self, stage_id: &str, cost_usd: f64) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET resume_prior_cost_usd = ?2 WHERE id = ?1",
            params![stage_id, cost_usd],
        )?;
        Ok(())
    }

    /// Record what `session_id` had reported by the end of the stage's last
    /// attempt (`None` usage ⇒ unknown, stored as NULL).
    pub fn set_stage_session_usage(
        &self,
        stage_id: &str,
        session_id: &str,
        usage: Option<&crate::orchestrator::types::SessionUsage>,
    ) -> AppResult<()> {
        let json = usage.map(|u| serde_json::json!({ "session": session_id, "usage": u }).to_string());
        self.conn.execute(
            "UPDATE run_stages SET session_usage = ?2 WHERE id = ?1",
            params![stage_id, json],
        )?;
        Ok(())
    }

    /// The reported total recorded for `session_id` on this stage; `None` when
    /// none is recorded or it belongs to another session.
    pub fn get_stage_session_usage(
        &self,
        stage_id: &str,
        session_id: &str,
    ) -> AppResult<Option<crate::orchestrator::types::SessionUsage>> {
        let raw: Option<String> = self
            .conn
            .query_row("SELECT session_usage FROM run_stages WHERE id = ?1", params![stage_id], |r| r.get(0))
            .optional()?
            .flatten();
        Ok(raw
            .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
            .filter(|v| v.get("session").and_then(|s| s.as_str()) == Some(session_id))
            .and_then(|v| serde_json::from_value(v.get("usage")?.clone()).ok()))
    }

    /// Keep the stage's current context reading for its resumed run (read
    /// back by [`Self::get_stage_resume_context`]); called before the reset
    /// that clears `context_tokens`. NULL when it has none.
    pub fn keep_stage_resume_context(&self, stage_id: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET resume_context_tokens = context_tokens WHERE id = ?1",
            params![stage_id],
        )?;
        Ok(())
    }

    pub fn get_stage_resume_context(&self, stage_id: &str) -> AppResult<Option<u64>> {
        let tokens: Option<i64> = self
            .conn
            .query_row(
                "SELECT resume_context_tokens FROM run_stages WHERE id = ?1",
                params![stage_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        Ok(tokens.and_then(|t| u64::try_from(t).ok()))
    }

    pub fn get_stage_resume_prior_cost(&self, stage_id: &str) -> AppResult<f64> {
        self.conn
            .query_row(
                "SELECT resume_prior_cost_usd FROM run_stages WHERE id = ?1",
                params![stage_id],
                |r| r.get(0),
            )
            .map_err(Into::into)
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
    /// The workspace-scope rail group this workspace sits in, if any. Kept
    /// through archive and restore.
    pub group_id: Option<String>,
}

/// One `list_projects` / `list_closed_projects` row: id, name, path,
/// last_opened, jira_project_key, pinned, tint, group_id.
pub type ProjectListRow =
    (String, String, String, String, Option<String>, bool, Option<String>, Option<String>);

/// The tints a rail group may carry: the monogram tints of
/// `src/lib/monogram.ts` (`TINT_NAMES`), in the same order.
pub const GROUP_TINTS: [&str; 7] =
    ["brass", "verdigris", "rouge", "indigo", "lavender", "smoke", "bone"];

/// A rail group (`groups`): a named, optionally tinted, one-level container.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GroupRow {
    pub id: String,
    /// `project` (holds projects) or `workspace` (holds one project's workspaces).
    pub scope: String,
    /// The owning project of a `workspace` group; None for a `project` group.
    pub project_id: Option<String>,
    pub name: String,
    /// One of [`GROUP_TINTS`], or None.
    pub tint: Option<String>,
    /// Position among the groups of the same scope (and, for `workspace`
    /// groups, the same project). Ascending; not necessarily dense.
    pub sort_order: i64,
    pub created_at: String,
}

/// A mission's prerequisite ("Starts after", #960): `workspace_id` waits on
/// `after_workspace_id`, a mission of the same project.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrerequisiteRow {
    pub workspace_id: String,
    pub after_workspace_id: String,
    /// One of [`PREREQUISITE_CONDITIONS`].
    pub after_condition: String,
    /// Branch the waiting mission from the prerequisite's branch, not the base.
    pub branch_from_prerequisite: bool,
    /// Start the waiting mission's run on its own once the condition holds.
    pub auto_start: bool,
}

/// One queued Claude Code hook signal (`hook_signals`).
#[derive(Clone, Debug, PartialEq)]
pub struct HookSignalRow {
    pub id: i64,
    pub terminal_id: String,
    /// `agent_adapter::HookSignal::as_str`.
    pub signal: String,
    pub session_id: Option<String>,
    pub created_at: String,
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
    /// Prompt tokens the turn's rounds read from / wrote to the cache.
    pub cache_read_tokens: Option<i64>,
    pub cache_creation_tokens: Option<i64>,
    /// Size of the turn's LAST prompt (the context the next turn carries).
    pub context_tokens: Option<i64>,
    /// A user row's `@` context blocks (#1150); NULL renders and replays as
    /// before.
    pub context_blocks: Option<String>,
    /// The transcript's columns (`context::transcript`, B2). For the
    /// backend only: the webview never receives them.
    #[serde(skip)]
    pub raw_json: Option<String>,
    #[serde(skip)]
    pub tool_use_id: Option<String>,
    #[serde(skip)]
    pub model_view: Option<String>,
    /// How an `error` row's turn failed (`ProviderErrorKind::as_str`); NULL
    /// on other rows and on error rows from before it was kept.
    pub error_kind: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatThreadRow {
    pub id: String,
    pub workspace_id: String,
    /// The mission this conversation belongs to, stamped at birth from the
    /// workspace's active mission. Nullable when the workspace has no mission.
    /// Drives mission-first thread scoping (a shared checkout can carry threads
    /// from more than one mission).
    #[serde(default)]
    pub mission_id: Option<String>,
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

/// Result of the backend budget gate ([`Db::check_budget`]).
#[derive(Clone, Debug, PartialEq)]
pub enum BudgetVerdict {
    Allow,
    /// A configured budget is at or over its limit. `scope` is a human string
    /// like "workspace daily"; `spent`/`limit` are USD.
    Block { scope: String, spent: f64, limit: f64 },
}

/// Start-of-period cutoff as an RFC3339 UTC string, computed in the user's LOCAL
/// timezone so "daily"/"monthly" reset at local midnight rather than 00:00 UTC
/// (F13). The format matches the stored `to_rfc3339()` timestamps so the SQL
/// `timestamp >= ?` string comparison stays correct.
fn period_since_utc(period: &str) -> String {
    use chrono::{Datelike, Local, TimeZone, Utc};
    let now = Local::now();
    let start_date = if period == "monthly" {
        now.date_naive()
            .with_day(1)
            .unwrap_or_else(|| now.date_naive())
    } else {
        now.date_naive()
    };
    let start_naive = start_date.and_hms_opt(0, 0, 0).unwrap_or_else(|| {
        now.naive_local()
    });
    Local
        .from_local_datetime(&start_naive)
        .earliest()
        .map(|dt| dt.with_timezone(&Utc).to_rfc3339())
        .unwrap_or_else(|| Utc::now().to_rfc3339())
}

/// A finished sub-agent's saved conversation (see `chat_agent_runs`).
#[derive(Clone, Debug)]
pub struct ChatAgentRun {
    pub call_id: String,
    pub thread_id: String,
    pub workspace_id: String,
    pub message_id: Option<i64>,
    pub spec_json: String,
    pub transcript_json: String,
    pub model: String,
}

/// A ledger row the re-pricer may change (see `Db::reprice_candidates`).
#[derive(Clone, Debug, PartialEq)]
pub struct RepriceCandidate {
    pub id: i64,
    pub model: String,
    pub surface: String,
    pub origin: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    /// `usage.speed` (`"fast"` re-prices at the fast rate, or stays unpriced).
    pub speed: Option<String>,
}

impl RepriceCandidate {
    fn from_row(r: &rusqlite::Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            model: r.get(1)?,
            surface: r.get(2)?,
            origin: r.get(3)?,
            input_tokens: r.get(4)?,
            output_tokens: r.get(5)?,
            cache_read_tokens: r.get(6)?,
            cache_creation_tokens: r.get(7)?,
            speed: r.get(8)?,
        })
    }

    /// Whether the row is ONE provider request (so per-request price tiers
    /// apply): RUN transcript lines, one-shot REVIEW/adhoc calls and Talk
    /// director rounds are; DIRECT stages and sub-agent attempts aggregate.
    pub fn single_request(&self) -> bool {
        match self.surface.as_str() {
            "run" | "review" | "adhoc" => true,
            "talk" => !self.origin.as_deref().is_some_and(|o| o.starts_with("subagent:")),
            _ => false,
        }
    }
}

/// What `Db::apply_reprice` writes: new costs, rows to mark `'unpriced'`,
/// and rows whose model now has an explicit $0 price (back to `'computed'`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RepricePlan {
    pub priced: Vec<(i64, f64)>,
    pub unpriced: Vec<i64>,
    pub free: Vec<i64>,
}

impl RepricePlan {
    pub fn is_empty(&self) -> bool {
        self.priced.is_empty() && self.unpriced.is_empty() && self.free.is_empty()
    }
}

/// Plan a re-price without touching the DB: resolve each distinct model
/// once with `price` (callers resolve OUTSIDE the DB lock), apply
/// per-request tiers to single-request rows and the fast-mode rate to fast
/// rows (a fast row on a model without one stays unpriced).
pub fn plan_reprice(
    rows: &[RepriceCandidate],
    price: &dyn Fn(&str) -> Option<crate::token_engine::ModelPrices>,
) -> RepricePlan {
    let mut book: std::collections::HashMap<&str, Option<crate::token_engine::ModelPrices>> =
        std::collections::HashMap::new();
    let mut plan = RepricePlan::default();
    for r in rows {
        let base = *book.entry(r.model.as_str()).or_insert_with(|| price(&r.model));
        let prices = crate::token_engine::prices_at_speed(&r.model, base, r.speed.as_deref());
        let Some(p) = prices else {
            plan.unpriced.push(r.id);
            continue;
        };
        let (i, o, cr, cc) = (
            r.input_tokens.max(0) as u64,
            r.output_tokens.max(0) as u64,
            r.cache_read_tokens.max(0) as u64,
            r.cache_creation_tokens.max(0) as u64,
        );
        let cost = if r.single_request() {
            crate::token_engine::request_cost(&r.model, p, i, o, cr, cc)
        } else {
            p.cost(i, o, cr, cc)
        };
        if cost > 0.0 {
            plan.priced.push((r.id, cost));
        } else {
            plan.free.push(r.id);
        }
    }
    plan
}

/// One Talk thread's cost from the ledger (see `thread_cost`).
#[derive(serde::Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCost {
    pub spent_usd: f64,
    /// The part of `spent_usd` sub-agents billed.
    pub subagents_usd: f64,
    /// The same tokens priced on the strong tier's model; 0 when unpriced.
    pub baseline_usd: f64,
    pub strong_priced: bool,
    pub calls: i64,
    pub cache_hit_pct: Option<f64>,
    /// Rows whose model had no price — excluded from `spent_usd` and
    /// `baseline_usd` (so from the saving), counted and named here.
    pub unpriced_calls: i64,
    pub unpriced_models: Vec<String>,
}

/// How long an ended Claude Code session is remembered
/// (`ended_claude_sessions`), in days.
pub const ENDED_SESSION_DAYS: i64 = 30;

/// One Claude Code session's RUN rows in the ledger (see
/// `run_session_ledger`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RunSessionLedger {
    pub calls: i64,
    /// Rows whose model had no price — left out of `spent_usd`.
    pub unpriced_calls: i64,
    pub spent_usd: f64,
    /// See [`cache_hit_pct`].
    pub cache_hit_pct: Option<f64>,
    /// Model and timestamp of the newest row.
    pub last_model: String,
    pub last_ts: String,
}

// ─── Usage report types ────────────────────────────────────────────────

/// One aggregate of the ledger — the whole range, one surface, one model or
/// one workspace/session.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSlice {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cost_usd: f64,
    /// Ledger rows (billed calls) in the slice.
    pub calls: i64,
    /// `cache_read / (input + cache_read + cache_create)` × 100, or `None`
    /// when the slice's rows carry no cache data at all.
    pub cache_hit_pct: Option<f64>,
    /// Whether any row in the slice reported cache tokens.
    pub cache_tracked: bool,
}

impl UsageSlice {
    pub fn new(
        input_tokens: i64,
        output_tokens: i64,
        cache_read_tokens: i64,
        cache_creation_tokens: i64,
        cost_usd: f64,
        calls: i64,
    ) -> Self {
        let (cache_hit_pct, cache_tracked) =
            cache_hit_pct(input_tokens, cache_read_tokens, cache_creation_tokens);
        Self {
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            cost_usd,
            calls,
            cache_hit_pct,
            cache_tracked,
        }
    }
}

/// The honest cache hit ratio: the share of prompt tokens read from cache.
/// A cache write is a miss (paid at a premium), so it sits in the
/// denominator only. `(None, false)` when nothing about the cache was ever
/// reported for these rows.
pub fn cache_hit_pct(input: i64, cache_read: i64, cache_create: i64) -> (Option<f64>, bool) {
    let tracked = cache_read + cache_create > 0;
    let prompt = input + cache_read + cache_create;
    if !tracked || prompt <= 0 {
        return (None, tracked);
    }
    (Some(cache_read as f64 / prompt as f64 * 100.0), true)
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceUsage {
    pub surface: String,
    #[serde(flatten)]
    pub usage: UsageSlice,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    #[serde(flatten)]
    pub usage: UsageSlice,
    /// Rows of this model the ledger could not price (`cost_basis =
    /// 'unpriced'`) — the UI shows "unpriced" rather than "$0.00".
    pub unpriced_calls: i64,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceCost {
    pub surface: String,
    pub cost_usd: f64,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceUsage {
    /// Workspace id, RUN session id, or a raw source id.
    pub id: String,
    /// The workspace's or session's name; the id when neither is known.
    pub label: String,
    /// `workspace` | `session` | `other`
    pub kind: String,
    /// Project name (workspaces only).
    pub project: Option<String>,
    pub last_ts: String,
    #[serde(flatten)]
    pub usage: UsageSlice,
    /// Cost split by surface, largest first — the stacked bar.
    pub surfaces: Vec<SurfaceCost>,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageTrendPoint {
    /// Local-time bucket: `YYYY-MM-DDTHH:00` (hour) or `YYYY-MM-DD` (day).
    pub bucket: String,
    pub cost_usd: f64,
    pub tokens: u64,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub start: String,
    pub end: String,
    pub surface: Option<String>,
    pub totals: UsageSlice,
    pub by_surface: Vec<SurfaceUsage>,
    pub by_model: Vec<ModelUsage>,
    pub by_source: Vec<SourceUsage>,
    pub trend: Vec<UsageTrendPoint>,
    /// `hour` | `day`
    pub trend_bucket: String,
    /// Local calendar days in the range with any spend.
    pub active_days: i64,
    /// `totals.cost_usd / active_days` — what a working day costs.
    pub per_active_day_usd: f64,
    /// Spend in the rolling last 24 hours (independent of the range).
    pub last_24h_usd: f64,
    /// Rows with tokens but $0 — a model the catalog could not price.
    pub unpriced_calls: i64,
    /// When the pricing catalog was last refreshed (filled by the command).
    pub pricing_refreshed_at: Option<String>,
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

/// The most loop-backs a review stage may take. The builder's "Max loop-backs"
/// stepper uses the same bound (`MAX_LOOP_ITERATIONS` in
/// `src/components/builder/graph.ts`); keep the two in sync.
pub const MAX_LOOP_ITERATIONS: i64 = 9;

/// A stored loop count brought under [`MAX_LOOP_ITERATIONS`]. Pipelines saved
/// before the cap (or synced from such a Mac) may hold a larger count; they are
/// clamped when read or synced so they keep loading, re-saving and syncing.
/// New input (builder, MCP, crew import) is still rejected above the cap.
pub fn clamp_loop_iterations(n: i64) -> i64 {
    n.min(MAX_LOOP_ITERATIONS)
}

/// The workspace tools a stage's agent may be granted. Keep in sync with
/// `tool_definitions()` in chat_engine.rs and the role default_tools seeded in orchestrator/roles.rs.
/// `grep`/`glob` are implied by read access and `edit_file` by `write_file`
/// (see the allowlist expansion in orchestrator/agentic.rs), so allowlists
/// saved before these tools existed keep working unchanged.
pub const KNOWN_TOOLS: &[&str] = &[
    "read_file",
    "list_files",
    "grep",
    "glob",
    "write_file",
    "edit_file",
    "run_command",
];


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
    match self.pipeline_stage_issues(stages, &[])?.into_iter().next() {
        Some((_, msg)) => Err(crate::error::AppError::Other(msg)),
        None => Ok(()),
    }
}

/// Every stage's first contract violation as (position, message), in stage
/// order — the rules [`Db::validate_pipeline_stages`] enforces, so a crew
/// import can show a per-stage error. `extra` roles count as existing (an
/// import's custom roles, before they are saved).
pub fn pipeline_stage_issues(
    &self,
    stages: &[StageDraft],
    extra: &[crate::orchestrator::roles::RoleDef],
) -> crate::error::AppResult<Vec<(usize, String)>> {
    use crate::error::AppError;
    if stages.is_empty() {
        return Err(AppError::Other("a pipeline needs at least one stage".into()));
    }
    // An authored graph records parents; a legacy/linear draft does not. The
    // loop-target-is-ancestor rule only applies to authored graphs (a linear
    // draft has no parents, so "earlier position" is the right contract there).
    let authored = stages.iter().any(|s| !s.parents.is_empty());
    let mut issues = Vec::new();
    for i in 0..stages.len() {
        if let Some(msg) = self.stage_issue(stages, i, authored, extra)? {
            issues.push((i, msg));
        }
    }
    Ok(issues)
}

/// The first rule stage `i` breaks, or `None`.
fn stage_issue(
    &self,
    stages: &[StageDraft],
    i: usize,
    authored: bool,
    extra: &[crate::orchestrator::roles::RoleDef],
) -> crate::error::AppResult<Option<String>> {
    let s = &stages[i];
    let role = match extra.iter().find(|r| r.key == s.role) {
        Some(r) => Some(r.clone()),
        None => self.get_role(&s.role)?,
    };
    let Some(role) = role else {
        return Ok(Some(format!("unknown stage role '{}'", s.role)));
    };
    if !matches!(s.substrate.as_str(), "api" | "cli") {
        return Ok(Some(format!("unknown substrate '{}'", s.substrate)));
    }
    if s.agent_model.trim().is_empty() {
        return Ok(Some(format!("stage {} has no model", i + 1)));
    }
    if !(1..=100).contains(&s.max_iterations) {
        return Ok(Some(format!(
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
                return Ok(Some(format!(
                    "stage {} has an upstream link to a non-earlier stage — the flow must be acyclic",
                    i + 1
                )));
            }
            if !seen.insert(p) {
                return Ok(Some(format!("stage {} lists the same upstream stage twice", i + 1)));
            }
        }
    }
    // Tool allowlist, when set, must be a non-empty subset of the known
    // workspace tools — an empty list would leave the agent unable to act.
    if let Some(tools) = &s.tools {
        if tools.is_empty() {
            return Ok(Some(format!(
                "stage {} has an empty tool list — give it at least one tool",
                i + 1
            )));
        }
        for t in tools {
            if !KNOWN_TOOLS.contains(&t.as_str()) {
                return Ok(Some(format!("unknown tool '{t}'")));
            }
        }
    }
    if let Some(instr) = &s.instructions {
        if instr.chars().count() > MAX_INSTRUCTIONS_CHARS {
            return Ok(Some(format!(
                "stage {} instructions are too long (max {MAX_INSTRUCTIONS_CHARS} characters)",
                i + 1
            )));
        }
    }
    match s.loop_target_position {
        Some(target) => {
            if !role.can_loop {
                return Ok(Some(format!("stage '{}' cannot carry a loop (not a review role)", s.role)));
            }
            if target < 0 || target >= i as i64 {
                return Ok(Some("loop target must be an earlier stage".into()));
            }
            // In an authored graph the loop must return to a stage on the
            // review's own path; otherwise loop_back can't re-run it (the
            // dossier and reset both follow ancestry, not raw position).
            if authored && !draft_ancestors(stages, i).contains(&target) {
                return Ok(Some("loop target must be an earlier stage on the review's own path".into()));
            }
            if !(1..=MAX_LOOP_ITERATIONS).contains(&s.loop_max_iterations) {
                return Ok(Some(format!(
                    "loop max iterations must be between 1 and {MAX_LOOP_ITERATIONS} (got {})",
                    s.loop_max_iterations
                )));
            }
            if !matches!(s.loop_mode.as_deref(), Some("gated") | Some("auto")) {
                return Ok(Some("loop mode must be 'gated' or 'auto'".into()));
            }
        }
        None => {
            if s.loop_max_iterations != 0 || s.loop_mode.is_some() {
                return Ok(Some("loop fields set without a loop target".into()));
            }
        }
    }
    Ok(None)
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

/// A row for the canonical `spend_events` ledger.
#[derive(Clone, Debug)]
pub struct SpendEvent {
    pub ts_utc: String,
    /// 'talk' | 'run' | 'direct' | 'review' | 'adhoc'
    pub surface: String,
    pub project_id: Option<String>,
    pub workspace_id: Option<String>,
    /// The mission this spend belongs to (denormalized, nullable). Populated when
    /// `workspace_id` resolves to an active mission; NULL for RUN/adhoc.
    pub mission_id: Option<String>,
    pub source_id: Option<String>,
    pub attempt: i64,
    pub model_raw: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub provider_cost_usd: Option<f64>,
    pub computed_cost_usd: Option<f64>,
    pub cost_usd: f64,
    /// 'provider' | 'computed' | 'subscription' | 'unpriced' | 'estimated'
    pub cost_basis: String,
    pub idempotency_key: Option<String>,
    /// The Talk thread the row was billed in (talk rows only).
    pub thread_id: Option<String>,
    /// `director` or `subagent:<call id>` for talk rows; NULL elsewhere.
    pub origin: Option<String>,
    /// The request's `usage.speed` (`"fast"` for a fast-mode turn); NULL
    /// when it wasn't reported or the row aggregates several requests.
    pub speed: Option<String>,
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
    /// Set while the run is parked by a Claude plan limit (#731).
    pub plan_wait: Option<PlanWait>,
}

/// One row of [`Db::list_parked_stages`]: a paused run and one of its blocked
/// stages (`None` when none is blocked).
#[derive(Clone, Debug, PartialEq)]
pub struct ParkedStageRow {
    pub run_id: String,
    pub workspace_name: Option<String>,
    pub stage: Option<ParkedStage>,
}

/// A blocked stage, as the menu bar Octo reads it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ParkedStage {
    /// `awaiting_checkpoint` or `failed`.
    pub status: String,
    /// The custom name, else the role's label.
    pub title: String,
    /// The stage ran (a gate or a question); `false` = parked before it began
    /// (a budget park, the director's pause, a secret-guard hold).
    pub started: bool,
    /// It asked the director questions (`ask_director`).
    pub asked: bool,
    /// The secret guard holds it and the director hasn't approved.
    pub secret_held: bool,
    /// A Claude plan limit stopped it.
    pub plan_limited: bool,
    /// Its error, for a failed stage: transient (`stalled`) or standing
    /// (`halted`), by `fleet_status::is_transient_halt`.
    pub error: Option<String>,
}

/// A run parked at a Claude plan limit. Epoch seconds.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanWait {
    /// The plan window that stopped the stage (`five_hour`, `seven_day`, …).
    pub window: String,
    /// When that window resets.
    pub resets_at: i64,
    /// When the automatic resume is due; `None` = parked for the director.
    pub resume_at: Option<i64>,
    /// Automatic resumes since the director last acted or a stage finished.
    pub resume_count: i64,
    /// Another stage of the run also waits for the director: a real halt, a
    /// gate or a question (anything resolvable that isn't a plan limit). The
    /// run then needs you, even with an automatic resume scheduled.
    pub other_hold: bool,
    /// Reports in a row whose reset was already past when they came (#1109):
    /// 1 = this park resumes once, uncounted; 2 = it waits for the director
    /// (`plan_wait::DirectorReason::StaleReport`).
    pub stale_count: i64,
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

/// A per-surface worked-time breakdown for the Logbook (display-only; the sum
/// of these can exceed the union total when surfaces overlap).
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LogbookSurfaceSecs {
    pub surface: String,
    pub secs: i64,
}

/// One Logbook row: worked hours (span union) + cost + savings + counts for a
/// mission over a period.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LogbookMissionRow {
    pub mission_id: String,
    pub title: String,
    pub intent: String,
    pub status: String,
    pub hours_secs: i64,
    pub cost_usd: f64,
    pub savings_usd: f64,
    pub runs_count: i64,
    pub messages_count: i64,
    pub per_surface: Vec<LogbookSurfaceSecs>,
}

/// RFC3339 → epoch seconds (0 on parse failure — callers pass Utc timestamps).
fn parse_epoch(s: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|d| d.timestamp())
        .unwrap_or(0)
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
        plan_wait: {
            let window: Option<String> = r.get(13)?;
            let resets_at: Option<i64> = r.get(14)?;
            let resume_at: Option<i64> = r.get(15)?;
            let resume_count: i64 = r.get(16)?;
            let other_hold = r.get::<_, i64>(17)? != 0;
            let stale_count: i64 = r.get(18)?;
            resets_at.map(|resets_at| PlanWait {
                window: window.unwrap_or_default(),
                resets_at,
                resume_at,
                resume_count,
                other_hold,
                stale_count,
            })
        },
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
    /// Serialized ask_director conversation transcript (API substrate). Set
    /// while the stage is parked on a block; consumed by the answered re-run.
    /// Never serialized to the frontend (internal continuation state).
    #[serde(skip_serializing)]
    pub blocked_transcript: Option<String>,
    /// The secret guard's hold on this (Action) stage, if any (#730): what it
    /// found (file, line, kind — never a value) and whether the director
    /// approved proceeding. Unparseable ⇒ `None`.
    pub secret_hold: Option<crate::secret_scan::SecretHold>,
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
        token_budget: row.get::<_, Option<i64>>("token_budget")?.map(|v| v as u64),
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
