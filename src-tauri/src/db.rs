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
fn add_column_if_missing(conn: &rusqlite::Connection, alter_sql: &str) -> rusqlite::Result<()> {
    match conn.execute(alter_sql, []) {
        Ok(_) => Ok(()),
        Err(e) if e.to_string().contains("duplicate column name") => Ok(()),
        Err(e) => Err(e),
    }
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
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let db = Db { conn };
        db.migrate()?;
        Ok(db)
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
        self.conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, created_at);",
        )?;
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
        let workspaces: Vec<String> = {
            let mut stmt = self
                .conn
                .prepare("SELECT DISTINCT workspace_id FROM chat_messages WHERE thread_id IS NULL")?;
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
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO workspaces (id, project_id, name, task, branch, worktree_path, setup_script, created_at, last_active, from_branch)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![id, project_id, name, task, branch, worktree_path, setup_script, now, now, from_branch],
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

    pub fn delete_workspace(&self, id: &str) -> AppResult<()> {
        self.conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Mark a workspace archived (worktree removed, branch kept). The row
    /// survives but is hidden from the rail.
    pub fn archive_workspace(&self, id: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE workspaces SET status = 'archived' WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Un-archive a workspace (status back to active).
    pub fn restore_workspace(&self, id: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE workspaces SET status = 'active' WHERE id = ?1",
            params![id],
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
        })
    }

    /// List a workspace's threads, most-recently-active first.
    pub fn list_chat_threads(&self, workspace_id: &str) -> AppResult<Vec<ChatThreadRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, title, created_at, updated_at
             FROM chat_threads WHERE workspace_id = ?1 ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map(params![workspace_id], |r| {
            Ok(ChatThreadRow {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                title: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
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
                    pos_x, pos_y, parents, tools, custom_name, instructions
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
        validate_pipeline_stages(stages)?;

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
                    "UPDATE pipelines SET name = ?2, description = ?3 WHERE id = ?1",
                    params![id, name, description],
                )?;
                tx.execute("DELETE FROM pipeline_stages WHERE pipeline_id = ?1", params![id])?;
                id
            }
            // Create (no target) or fork (builtin target): a fresh custom pipeline.
            _ => {
                let id = Uuid::new_v4().to_string();
                let now = Utc::now().to_rfc3339();
                tx.execute(
                    "INSERT INTO pipelines (id, name, description, is_builtin, created_at)
                     VALUES (?1,?2,?3,0,?4)",
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
                     pos_x, pos_y, parents, tools, custom_name, instructions)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
                params![Uuid::new_v4().to_string(), saved_id, i as i64, s.role, s.agent_model,
                        s.substrate, s.checkpoint as i64,
                        s.loop_target_position, s.loop_max_iterations, s.loop_mode,
                        s.max_iterations,
                        s.pos_x, s.pos_y, parents_json, tools_json, custom_name, instructions],
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
                     parents, tools, custom_name, instructions)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8,?9,?10,?11,?12,?13,?14,?15)",
                params![sid, id, s.position, s.role, model, s.substrate, s.checkpoint as i64,
                        s.loop_target_position, s.loop_max_iterations, s.loop_mode,
                        s.max_iterations,
                        parents_json, tools_json, s.custom_name, s.instructions],
            )?;
        }
        Ok(id)
    }

    pub fn get_run(&self, run_id: &str) -> AppResult<Option<RunRow>> {
        self.conn
            .query_row(
                "SELECT id, workspace_id, pipeline_id, task, status, cost_usd, baseline_usd,
                        reference_model, linked_issue_key, created_at, finished_at, budget_usd
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
                    reference_model, linked_issue_key, created_at, finished_at, budget_usd
             FROM runs WHERE workspace_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(params![workspace_id], row_to_run)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn list_run_stages(&self, run_id: &str) -> AppResult<Vec<RunStageRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, run_id, position, role, agent_model, substrate, checkpoint, status,
                    input_tokens, output_tokens, cost_usd, artifact, feedback, error, started_at, finished_at,
                    loop_target_position, loop_max_iterations, loop_mode, loop_iterations, diff_snapshot,
                    max_iterations, parents, tools, custom_name, instructions
             FROM run_stages WHERE run_id = ?1 ORDER BY position",
        )?;
        let rows = stmt.query_map(params![run_id], |r| {
            Ok(RunStageRow {
                id: r.get(0)?,
                run_id: r.get(1)?,
                position: r.get(2)?,
                role: r.get(3)?,
                agent_model: r.get(4)?,
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
    pub fn recover_interrupted_runs(&self) -> AppResult<usize> {
        let now = Utc::now().to_rfc3339();
        let mut n = self.conn.execute(
            "UPDATE run_stages SET status = 'failed', error = ?1, finished_at = ?2
             WHERE status = 'running'",
            params![Self::INTERRUPTED_STAGE_ERROR, now],
        )?;

        let run_ids: Vec<String> = {
            let mut stmt = self
                .conn
                .prepare("SELECT id FROM runs WHERE status = 'running'")?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for run_id in run_ids {
            let stages = self.list_run_stages(&run_id)?;
            if !stages.is_empty() && stages.iter().all(|s| s.status == "done") {
                // Died after the last stage finished but before the run was
                // stamped — it IS complete.
                self.set_run_status(&run_id, "completed", true)?;
                continue;
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
            self.set_run_status(&run_id, "paused", false)?;
        }
        Ok(n)
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
    /// recording reviewer feedback. Clears the prior artifact/error/finish time.
    pub fn reset_run_stage(
        &self,
        stage_id: &str,
        model_override: Option<&str>,
        feedback: Option<&str>,
    ) -> AppResult<()> {
        if let Some(model) = model_override {
            self.conn.execute(
                "UPDATE run_stages SET agent_model = ?2 WHERE id = ?1",
                params![stage_id, model],
            )?;
        }
        self.conn.execute(
            "UPDATE run_stages
             SET status = 'pending', artifact = NULL, error = NULL,
                 started_at = NULL, finished_at = NULL, diff_snapshot = NULL,
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
}

fn default_max_iterations() -> i64 {
    25
}

/// Hard cap on free-form stage instructions (defensive: keeps a pasted essay
/// from blowing up every prompt this stage runs).
const MAX_INSTRUCTIONS_CHARS: usize = 8_000;

/// The workspace tools a stage's agent may be granted. Keep in sync with
/// `tool_definitions()` in chat_engine.rs and `ARCHETYPES` in the builder.
pub const KNOWN_TOOLS: &[&str] = &["read_file", "list_files", "write_file", "run_command"];

// Keep in sync with ALL_ROLES/REVIEW_ROLES in src/components/PipelineBuilder.tsx and the role match arms in orchestrator/runner.rs (artifact_kind_for / system_prompt_for).
const KNOWN_ROLES: &[&str] = &[
    "plan", "plan_review", "implement", "code_review", "test",
    "repro", "fix", "verify", "critique", "refine",
];
const REVIEW_ROLES: &[&str] = &["plan_review", "code_review", "critique", "verify"];

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

/// Validate a pipeline's stage drafts (the §3.7 builder contract). Pure.
pub fn validate_pipeline_stages(stages: &[StageDraft]) -> crate::error::AppResult<()> {
    use crate::error::AppError;
    if stages.is_empty() {
        return Err(AppError::Other("a pipeline needs at least one stage".into()));
    }
    // An authored graph records parents; a legacy/linear draft does not. The
    // loop-target-is-ancestor rule only applies to authored graphs (a linear
    // draft has no parents, so "earlier position" is the right contract there).
    let authored = stages.iter().any(|s| !s.parents.is_empty());
    for (i, s) in stages.iter().enumerate() {
        if !KNOWN_ROLES.contains(&s.role.as_str()) {
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
                if !REVIEW_ROLES.contains(&s.role.as_str()) {
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
