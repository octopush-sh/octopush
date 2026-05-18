//! SQLite persistence for sessions and token events.

use crate::error::AppResult;
use crate::session::{Session, SessionStatus};
use crate::token_engine::{CostEntry, TokenEvent, TokenReport, TrendPoint};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};

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

    pub fn default_path() -> PathBuf {
        let base = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("octopus-sh");
        base.join("octopus.db")
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
                cost_usd        REAL NOT NULL DEFAULT 0,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
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
            "#,
        )?;
        // Phase 2 — workspace customization columns (glyph + tint).
        // SQLite doesn't support ADD COLUMN IF NOT EXISTS, so we swallow the
        // duplicate-column error if the migration has already run.
        add_column_if_missing(&self.conn, "ALTER TABLE workspaces ADD COLUMN glyph TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE workspaces ADD COLUMN tint TEXT")?;
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

    pub fn list_projects(&self) -> AppResult<Vec<(String, String, String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path, last_opened FROM projects ORDER BY last_opened DESC LIMIT 20",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn touch_project(&self, id: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE projects SET last_opened = ?1 WHERE id = ?2",
            params![Utc::now().to_rfc3339(), id],
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
            "SELECT id, project_id, name, task, branch, worktree_path, setup_script, status, created_at, last_active, glyph, tint
             FROM workspaces WHERE project_id = ?1 ORDER BY last_active DESC",
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
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn delete_workspace(&self, id: &str) -> AppResult<()> {
        self.conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
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
