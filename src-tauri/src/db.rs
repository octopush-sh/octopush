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
    ) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO workspaces (id, project_id, name, task, branch, worktree_path, setup_script, created_at, last_active)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![id, project_id, name, task, branch, worktree_path, setup_script, now, now],
        )?;
        Ok(())
    }

    pub fn list_workspaces(&self, project_id: &str) -> AppResult<Vec<WorkspaceRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project_id, name, task, branch, worktree_path, setup_script, status, created_at, last_active, glyph, tint, test_command, linked_issue_key
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
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn get_workspace(&self, workspace_id: &str) -> AppResult<Option<WorkspaceRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project_id, name, task, branch, worktree_path, setup_script, status, created_at, last_active, glyph, tint, test_command, linked_issue_key
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
            "SELECT id, project_id, name, task, branch, worktree_path, setup_script, status, created_at, last_active, glyph, tint, test_command, linked_issue_key
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
        role: &str,
        content: &str,
        model: Option<&str>,
        input_tokens: Option<i64>,
        output_tokens: Option<i64>,
        cost: Option<f64>,
    ) -> AppResult<i64> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO chat_messages (workspace_id, role, content, model, input_tokens, output_tokens, cost_usd, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![workspace_id, role, content, model, input_tokens, output_tokens, cost, now],
        )?;
        Ok(self.conn.last_insert_rowid())
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

    pub fn list_chat_messages(&self, workspace_id: &str) -> AppResult<Vec<ChatMessageRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, role, content, model, input_tokens, output_tokens, cost_usd, created_at
             FROM chat_messages WHERE workspace_id = ?1 ORDER BY created_at",
        )?;
        let rows = stmt.query_map(params![workspace_id], |r| {
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
            "SELECT id, pipeline_id, position, role, agent_model, substrate, checkpoint
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

    pub fn insert_pipeline_stage(
        &self,
        pipeline_id: &str,
        position: i64,
        role: &str,
        agent_model: &str,
        substrate: &str,
        checkpoint: bool,
    ) -> AppResult<String> {
        let id = Uuid::new_v4().to_string();
        self.conn.execute(
            "INSERT INTO pipeline_stages (id, pipeline_id, position, role, agent_model, substrate, checkpoint)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![id, pipeline_id, position, role, agent_model, substrate, checkpoint as i64],
        )?;
        Ok(id)
    }

    /// Insert the three curated pipelines if they are not already present.
    /// Idempotent: keyed on the builtin name.
    pub fn seed_builtin_pipelines(&self) -> AppResult<()> {
        // (name, description, [(role, model, substrate, checkpoint)])
        let defs: &[(&str, &str, &[(&str, &str, &str, bool)])] = &[
            (
                "Feature Factory",
                "Full build: plan, review, implement, review, test.",
                &[
                    ("plan", "claude-haiku-4-5", "api", false),
                    ("plan_review", "claude-haiku-4-5", "api", false),
                    ("implement", "claude-sonnet-4-6", "api", true),
                    ("code_review", "claude-haiku-4-5", "api", true),
                    ("test", "claude-haiku-4-5", "api", true),
                ],
            ),
            (
                "Bugfix relay",
                "Reproduce, fix, verify. Lean and fast.",
                &[
                    ("repro", "claude-haiku-4-5", "api", false),
                    ("fix", "claude-sonnet-4-6", "api", true),
                    ("verify", "claude-haiku-4-5", "api", true),
                ],
            ),
            (
                "Plan & review",
                "Thinking only — no code is written.",
                &[
                    ("plan", "claude-sonnet-4-6", "api", false),
                    ("critique", "claude-haiku-4-5", "api", false),
                    ("refine", "claude-sonnet-4-6", "api", true),
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
            for (i, (role, model, substrate, checkpoint)) in stages.iter().enumerate() {
                self.insert_pipeline_stage(&pid, i as i64, role, model, substrate, *checkpoint)?;
            }
        }
        Ok(())
    }

    // ─── Runs ─────────────────────────────────────────────────────

    /// Create a run and copy the pipeline's stages into `run_stages` (a private copy
    /// so later edits to the template don't mutate run history).
    pub fn create_run(
        &self,
        workspace_id: &str,
        pipeline_id: &str,
        task: &str,
        reference_model: Option<&str>,
        linked_issue_key: Option<&str>,
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
            let sid = Uuid::new_v4().to_string();
            self.conn.execute(
                "INSERT INTO run_stages (id, run_id, position, role, agent_model, substrate, checkpoint, status)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,'pending')",
                params![sid, id, s.position, s.role, s.agent_model, s.substrate, s.checkpoint as i64],
            )?;
        }
        Ok(id)
    }

    pub fn get_run(&self, run_id: &str) -> AppResult<Option<RunRow>> {
        self.conn
            .query_row(
                "SELECT id, workspace_id, pipeline_id, task, status, cost_usd, baseline_usd,
                        reference_model, linked_issue_key, created_at, finished_at
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
                    reference_model, linked_issue_key, created_at, finished_at
             FROM runs WHERE workspace_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(params![workspace_id], row_to_run)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn list_run_stages(&self, run_id: &str) -> AppResult<Vec<RunStageRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, run_id, position, role, agent_model, substrate, checkpoint, status,
                    input_tokens, output_tokens, cost_usd, artifact, feedback, error, started_at, finished_at
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

    pub fn set_run_reference_model(&self, run_id: &str, model: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE runs SET reference_model = ?2 WHERE id = ?1",
            params![run_id, model],
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
                 started_at = NULL, finished_at = NULL,
                 input_tokens = 0, output_tokens = 0, cost_usd = 0, feedback = ?2
             WHERE id = ?1",
            params![stage_id, feedback],
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
