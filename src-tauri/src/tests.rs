//! Unit tests for the Octopush core.
//!
//! Run with `cargo test` from `src-tauri/`.

#[cfg(test)]
mod db_tests {
    use crate::db::Db;
    use crate::session::{AgentConfig, CreateSessionArgs, Session, SessionStatus};
    use crate::token_engine::{compute_cost, TokenEvent, TokenEngine};
    use parking_lot::Mutex;
    use std::sync::Arc;
    use tempfile::NamedTempFile;

    fn test_db() -> Db {
        let tmp = NamedTempFile::new().unwrap();
        Db::open(tmp.path()).unwrap()
    }

    fn test_session(name: &str) -> Session {
        Session::from_args(
            uuid::Uuid::new_v4().to_string(),
            CreateSessionArgs {
                name: name.to_string(),
                project_root: "/tmp".to_string(),
                color: None,
                icon: None,
                agent: None,
                token_budget: None,
                tags: vec!["test".into()],
                context_files: vec![],
            },
        )
    }

    #[test]
    fn session_crud() {
        let db = test_db();
        let s = test_session("crud-test");

        // Insert
        db.upsert_session(&s).unwrap();
        let got = db.get_session(&s.id).unwrap().expect("session not found");
        assert_eq!(got.name, "crud-test");
        assert_eq!(got.tags, vec!["test"]);

        // Update status
        db.update_status(&s.id, SessionStatus::Active).unwrap();
        let got = db.get_session(&s.id).unwrap().unwrap();
        assert_eq!(got.status, SessionStatus::Active);

        // List
        let all = db.list_sessions().unwrap();
        assert_eq!(all.len(), 1);

        // Delete
        db.delete_session(&s.id).unwrap();
        assert!(db.get_session(&s.id).unwrap().is_none());
    }

    #[test]
    fn session_serde_roundtrip() {
        let s = test_session("roundtrip");
        let json = serde_json::to_string(&s).unwrap();
        let back: Session = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, s.id);
        assert_eq!(back.name, "roundtrip");
    }

    #[test]
    fn agent_config_defaults() {
        let cfg = AgentConfig::default();
        assert_eq!(cfg.model, "claude-opus-4-6");
        assert_eq!(cfg.temperature, 1.0);
        assert_eq!(cfg.max_tokens, 8192);
    }

    #[test]
    fn token_event_insert_and_report() {
        let db = Arc::new(Mutex::new(test_db()));
        let engine = TokenEngine::new(Arc::clone(&db));

        // Must have a session first (FK constraint).
        let s = test_session("token-test");
        db.lock().upsert_session(&s).unwrap();

        let ev = TokenEvent {
            id: None,
            session_id: s.id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_tokens: 200,
            cache_creation_tokens: 0,
            model: "claude-sonnet-4-6".to_string(),
            cost_usd: 0.0, // will be computed
        };
        engine.record(ev).unwrap();

        let report = engine.report(Some(&s.id)).unwrap();
        assert_eq!(report.total_input, 1000);
        assert_eq!(report.total_output, 500);
        assert!(report.total_cost_usd > 0.0);

        // Session aggregates should be updated too.
        let updated = db.lock().get_session(&s.id).unwrap().unwrap();
        assert_eq!(updated.tokens_input, 1000);
        assert_eq!(updated.tokens_output, 500);
    }

    #[test]
    fn budget_set_and_check() {
        let db = Arc::new(Mutex::new(test_db()));
        let engine = TokenEngine::new(Arc::clone(&db));

        let s = test_session("budget-test");
        db.lock().upsert_session(&s).unwrap();

        engine.set_budget(&s.id, Some(10_000)).unwrap();
        let status = engine.budget_status(&s.id).unwrap();
        assert_eq!(status.budget, Some(10_000));
        assert_eq!(status.used, 0);
        assert_eq!(status.remaining, Some(10_000));
    }

    #[test]
    fn pricing_known_models() {
        let cost = compute_cost("claude-opus-4-6", 1_000_000, 100_000, 0, 0);
        // $15 input + $7.50 output = $22.50
        assert!((cost - 22.5).abs() < 0.01);

        let free = compute_cost("llama-3-local", 1_000_000, 1_000_000, 0, 0);
        assert_eq!(free, 0.0);
    }

    #[test]
    fn session_budget_increment() {
        let db = test_db();
        let s = test_session("incr-test");
        db.upsert_session(&s).unwrap();

        db.increment_session_tokens(&s.id, 500, 300).unwrap();
        db.increment_session_tokens(&s.id, 200, 100).unwrap();

        let updated = db.get_session(&s.id).unwrap().unwrap();
        assert_eq!(updated.tokens_input, 700);
        assert_eq!(updated.tokens_output, 400);
        assert_eq!(updated.tokens_used, 1100);
    }
}

#[cfg(test)]
mod workspace_tests {
    use crate::db::Db;
    use tempfile::NamedTempFile;

    fn test_db() -> Db {
        let tmp = NamedTempFile::new().unwrap();
        Db::open(tmp.path()).unwrap()
    }

    fn setup_workspace(db: &Db, project_id: &str, workspace_id: &str) {
        db.insert_project(project_id, "Test Project", &format!("/tmp/{}", project_id))
            .unwrap();
        db.insert_workspace(workspace_id, project_id, "ws", "", "main", None, "")
            .unwrap();
    }

    #[test]
    fn update_workspace_customization_persists_glyph_and_tint() {
        let db = test_db();
        setup_workspace(&db, "proj-1", "ws-1");

        db.update_workspace_customization("ws-1", Some("§"), Some("verdigris"))
            .unwrap();

        let workspaces = db.list_workspaces("proj-1").unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].glyph.as_deref(), Some("§"));
        assert_eq!(workspaces[0].tint.as_deref(), Some("verdigris"));
    }

    #[test]
    fn update_workspace_customization_clears_with_none() {
        let db = test_db();
        setup_workspace(&db, "proj-1", "ws-1");

        db.update_workspace_customization("ws-1", Some("X"), Some("brass"))
            .unwrap();
        db.update_workspace_customization("ws-1", None, None)
            .unwrap();

        let workspaces = db.list_workspaces("proj-1").unwrap();
        assert_eq!(workspaces[0].glyph, None);
        assert_eq!(workspaces[0].tint, None);
    }

    #[test]
    fn list_workspaces_orders_by_creation_ascending() {
        let db = test_db();
        db.insert_project("proj-1", "Test Project", "/tmp/proj-1")
            .unwrap();
        // Insert with gaps so created_at timestamps are distinct, then prove the
        // order is stable creation-ascending (new at end) regardless of which
        // one was touched most recently.
        for id in ["ws-a", "ws-b", "ws-c"] {
            db.insert_workspace(id, "proj-1", "ws", "", "main", None, "")
                .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }

        let workspaces = db.list_workspaces("proj-1").unwrap();
        let ids: Vec<&str> = workspaces.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, ["ws-a", "ws-b", "ws-c"]);
    }

    #[test]
    fn archive_hides_workspace_but_keeps_row() {
        let db = test_db();
        db.insert_project("p", "P", "/tmp/octo-arch-p").unwrap();
        db.insert_workspace("w1", "p", "ws", "", "main", None, "")
            .unwrap();
        db.insert_workspace("w2", "p", "ws", "", "feat/keep", None, "")
            .unwrap();
        assert_eq!(db.list_workspaces("p").unwrap().len(), 2);

        db.archive_workspace("w1").unwrap();

        let rows = db.list_workspaces("p").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "w2");
        // The archived row still exists, just hidden from the rail.
        assert!(db.get_workspace("w1").unwrap().is_some());
    }

    #[test]
    fn archive_then_list_archived_and_restore() {
        let db = test_db();
        db.insert_project("p", "P", "/tmp/octo-arch2-p").unwrap();
        db.insert_workspace("w1", "p", "alpha", "", "feat/a", Some("/tmp/x/a"), "").unwrap();

        db.archive_workspace("w1").unwrap();
        assert!(db.list_workspaces("p").unwrap().is_empty());
        let archived = db.list_archived_workspaces("p").unwrap();
        assert_eq!(archived.len(), 1);
        assert_eq!(archived[0].id, "w1");

        db.restore_workspace("w1").unwrap();
        assert_eq!(db.list_workspaces("p").unwrap().len(), 1);
        assert!(db.list_archived_workspaces("p").unwrap().is_empty());
    }

    #[test]
    fn rename_workspace_updates_name() {
        let db = test_db();
        db.insert_project("p", "P", "/tmp/octo-rn-p").unwrap();
        db.insert_workspace("w1", "p", "old", "", "main", None, "")
            .unwrap();
        db.rename_workspace("w1", "new name").unwrap();
        let rows = db.list_workspaces("p").unwrap();
        assert_eq!(rows[0].name, "new name");
    }

    #[test]
    fn list_projects_is_stable_creation_order_not_recency() {
        let db = test_db();
        for id in ["proj-a", "proj-b", "proj-c"] {
            db.insert_project(id, "P", &format!("/tmp/{id}")).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        // "Open" the oldest project — under the old `last_opened DESC` ordering
        // this would hoist proj-a to the front. Creation-ascending must NOT move it.
        std::thread::sleep(std::time::Duration::from_millis(2));
        db.reopen_project("proj-a").unwrap();

        let projects = db.list_projects().unwrap();
        let ids: Vec<&str> = projects.iter().map(|p| p.0.as_str()).collect();
        assert_eq!(ids, ["proj-a", "proj-b", "proj-c"]);
    }

    #[test]
    fn update_project_sets_name_and_tint_without_error() {
        let db = test_db();
        db.insert_project("p", "Old", "/tmp/octo-upd-p").unwrap();
        // Before the tint migration this errored ("no such column: tint").
        db.update_project("p", Some("New"), Some("verdigris")).unwrap();
        let row = db.list_projects().unwrap().into_iter().find(|t| t.0 == "p").unwrap();
        assert_eq!(row.1, "New");
    }

    #[test]
    fn list_projects_returns_tint() {
        let db = test_db();
        db.insert_project("p", "P", "/tmp/octo-tint-p").unwrap();
        db.update_project("p", None, Some("verdigris")).unwrap();
        let row = db.list_projects().unwrap().into_iter().find(|t| t.0 == "p").unwrap();
        assert_eq!(row.6, Some("verdigris".to_string()));
    }

    #[test]
    fn soft_close_hides_then_reopen_restores_project() {
        let db = test_db();
        db.insert_project("p1", "Proj One", "/tmp/octo-p1").unwrap();

        // Open by default: in list_projects, absent from closed list.
        assert!(db.list_projects().unwrap().iter().any(|(id, ..)| id == "p1"));
        assert!(db.list_closed_projects().unwrap().is_empty());

        // Soft-close: gone from the rail list, present in closed list, row survives.
        db.close_project("p1").unwrap();
        assert!(!db.list_projects().unwrap().iter().any(|(id, ..)| id == "p1"));
        assert!(db.list_closed_projects().unwrap().iter().any(|(id, ..)| id == "p1"));
        assert!(db.get_project_by_id("p1").unwrap().is_some());

        // Reopen: back in the rail list, gone from closed list.
        db.reopen_project("p1").unwrap();
        assert!(db.list_projects().unwrap().iter().any(|(id, ..)| id == "p1"));
        assert!(db.list_closed_projects().unwrap().is_empty());
    }

    #[test]
    fn pin_and_order_projects() {
        let db = test_db();
        db.insert_project("a", "A", "/tmp/octo-a").unwrap();
        db.insert_project("b", "B", "/tmp/octo-b").unwrap();
        db.insert_project("c", "C", "/tmp/octo-c").unwrap();

        let ids: Vec<String> = db.list_projects().unwrap().into_iter().map(|t| t.0).collect();
        assert_eq!(ids, ["a", "b", "c"]);

        db.set_project_order(&["c".into(), "a".into(), "b".into()]).unwrap();
        let ids: Vec<String> = db.list_projects().unwrap().into_iter().map(|t| t.0).collect();
        assert_eq!(ids, ["c", "a", "b"]);

        db.set_project_pinned("b", true).unwrap();
        let rows = db.list_projects().unwrap();
        assert_eq!(rows[0].0, "b");
        assert!(rows[0].5);
        assert!(!rows[1].5);

        db.set_project_pinned("b", false).unwrap();
        let ids: Vec<String> = db.list_projects().unwrap().into_iter().map(|t| t.0).collect();
        assert_eq!(ids, ["c", "a", "b"]);
    }

    #[test]
    fn workspace_link_round_trip() {
        let db = test_db();
        db.insert_project("proj-link", "Test Project", "/tmp/proj-link")
            .unwrap();
        db.insert_workspace("ws-link", "proj-link", "ws", "", "main", None, "")
            .unwrap();

        // Set linked_issue_key, then read back.
        db.update_workspace_link("ws-link", Some("PROJ-42".into()))
            .unwrap();
        let ws = db.get_workspace("ws-link").unwrap().unwrap();
        assert_eq!(ws.linked_issue_key.as_deref(), Some("PROJ-42"));

        // Clear link.
        db.update_workspace_link("ws-link", None).unwrap();
        let ws = db.get_workspace("ws-link").unwrap().unwrap();
        assert_eq!(ws.linked_issue_key, None);
    }

    #[test]
    fn migrate_adds_contextual_issue_tracker_columns() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Db::open(tmp.path()).unwrap();
        // After migrate() the new columns must exist on their tables.
        let has_col = |table: &str, col: &str| -> bool {
            let q = format!("PRAGMA table_info({})", table);
            let mut stmt = db.conn_ref().prepare(&q).unwrap();
            let mut rows = stmt.query([]).unwrap();
            while let Some(row) = rows.next().unwrap() {
                let name: String = row.get(1).unwrap();
                if name == col {
                    return true;
                }
            }
            false
        };
        assert!(has_col("projects", "jira_project_key"), "projects.jira_project_key missing");
        assert!(has_col("workspaces", "linked_issue_key"), "workspaces.linked_issue_key missing");
        assert!(has_col("workspaces", "issue_link_dismissed"), "workspaces.issue_link_dismissed missing");
    }

    #[test]
    fn project_jira_key_round_trip() {
        let db = test_db();
        db.insert_project("proj-jira", "Test Project", "/tmp/proj-jira")
            .unwrap();

        db.update_project_jira_key("proj-jira", Some("CLPNSNS".into()))
            .unwrap();
        let p = db.get_project("proj-jira").unwrap().unwrap();
        assert_eq!(p.jira_project_key.as_deref(), Some("CLPNSNS"));

        db.update_project_jira_key("proj-jira", None).unwrap();
        let p = db.get_project("proj-jira").unwrap().unwrap();
        assert_eq!(p.jira_project_key, None);
    }

    #[test]
    fn insert_and_list_error_message() {
        let db = test_db();
        db.insert_project("proj-err", "Test Project", "/tmp/proj-err")
            .unwrap();
        db.insert_workspace("ws-err", "proj-err", "ws", "", "main", None, "")
            .unwrap();

        db.insert_chat_message("ws-err", "user", "hello", None, None, None, None)
            .unwrap();
        db.insert_chat_message(
            "ws-err",
            "error",
            "401 unauthorized — API key not configured",
            None,
            None,
            None,
            None,
        )
        .unwrap();

        let messages = db.list_chat_messages("ws-err").unwrap();
        assert_eq!(messages.len(), 2);
        assert!(
            messages.iter().any(|m| m.role == "error"),
            "expected a row with role=error, got: {:?}",
            messages.iter().map(|m| &m.role).collect::<Vec<_>>()
        );
        let err_msg = messages.iter().find(|m| m.role == "error").unwrap();
        assert!(err_msg.content.contains("401 unauthorized"));
    }
}

#[cfg(test)]
mod terminal_tests {
    use crate::db::Db;
    use tempfile::NamedTempFile;

    fn test_db() -> Db {
        let tmp = NamedTempFile::new().unwrap();
        Db::open(tmp.path()).unwrap()
    }

    fn setup_workspace(db: &Db, project_id: &str, workspace_id: &str) {
        db.insert_project(project_id, "Test Project", &format!("/tmp/{}", project_id))
            .unwrap();
        db.insert_workspace(workspace_id, project_id, "ws", "", "main", None, "")
            .unwrap();
    }

    #[test]
    fn terminals_table_persists() {
        let db = test_db();
        setup_workspace(&db, "proj-t1", "ws-t1");

        let ts = chrono::Utc::now().timestamp();
        db.create_terminal("term-a", "ws-t1", "Main", 0, ts).unwrap();
        db.create_terminal("term-b", "ws-t1", "Terminal 2", 1, ts).unwrap();
        db.create_terminal("term-c", "ws-t1", "Terminal 3", 2, ts).unwrap();

        let list = db.list_terminals("ws-t1").unwrap();
        assert_eq!(list.len(), 3);
        // Positions must be in ascending order
        let positions: Vec<u32> = list.iter().map(|t| t.position).collect();
        assert_eq!(positions, vec![0, 1, 2]);
        assert_eq!(list[0].label, "Main");
        assert_eq!(list[1].label, "Terminal 2");
        assert_eq!(list[2].label, "Terminal 3");
    }

    #[test]
    fn rename_terminal_updates_label() {
        let db = test_db();
        setup_workspace(&db, "proj-t2", "ws-t2");

        let ts = chrono::Utc::now().timestamp();
        db.create_terminal("term-r", "ws-t2", "Old Label", 0, ts).unwrap();
        db.rename_terminal("term-r", "New Label").unwrap();

        let list = db.list_terminals("ws-t2").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].label, "New Label");
    }

    #[test]
    fn delete_terminal_kills_pty_gracefully() {
        // This tests that delete_terminal works even when the PTY id isn't
        // registered in PtyManager (no panic, no error propagation for "not found").
        let db = test_db();
        setup_workspace(&db, "proj-t3", "ws-t3");

        let ts = chrono::Utc::now().timestamp();
        db.create_terminal("term-d", "ws-t3", "Doomed", 0, ts).unwrap();

        // Simulate the command-level behaviour: ignore "not found" from pty.kill,
        // then delete from DB.
        let mut pty = crate::pty_manager::PtyManager::new(crate::pty_client::DaemonClient::stub());
        let _ = pty.kill("term-d"); // must not panic

        db.delete_terminal("term-d").unwrap();

        let list = db.list_terminals("ws-t3").unwrap();
        assert!(list.is_empty());
    }

    #[test]
    fn max_terminal_position_returns_none_when_empty() {
        let db = test_db();
        setup_workspace(&db, "proj-t4", "ws-t4");

        let max = db.max_terminal_position("ws-t4").unwrap();
        assert_eq!(max, None);
    }

    #[test]
    fn max_terminal_position_returns_highest() {
        let db = test_db();
        setup_workspace(&db, "proj-t5", "ws-t5");

        let ts = chrono::Utc::now().timestamp();
        db.create_terminal("term-p1", "ws-t5", "A", 0, ts).unwrap();
        db.create_terminal("term-p2", "ws-t5", "B", 1, ts).unwrap();
        db.create_terminal("term-p3", "ws-t5", "C", 5, ts).unwrap();

        let max = db.max_terminal_position("ws-t5").unwrap();
        assert_eq!(max, Some(5));
    }
}

/// Tests for Feature 5 v2 — cache token tracking and LiteLLM pricing parse.
#[cfg(test)]
mod budgets_v2_tests {
    use crate::db::Db;
    use crate::provider_router::{builtin_providers, ProviderRouter};
    use crate::token_engine::{compute_cost, compute_cost_with_prices, TokenEngine, TokenEvent};
    use parking_lot::Mutex;
    use std::sync::Arc;
    use tempfile::NamedTempFile;

    fn test_db() -> Db {
        let tmp = NamedTempFile::new().unwrap();
        Db::open(tmp.path()).unwrap()
    }

    fn test_engine() -> (Arc<Mutex<Db>>, TokenEngine) {
        let db = Arc::new(Mutex::new(test_db()));
        let engine = TokenEngine::new(Arc::clone(&db));
        (db, engine)
    }

    /// cache_read/creation values from LlmResponse are persisted into TokenEvent.
    #[test]
    fn cache_tokens_are_recorded() {
        let (db, engine) = test_engine();
        // token_events doesn't enforce session FK, so no session needed.
        let ev = TokenEvent {
            id: None,
            session_id: "ws-cache-test".to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            input_tokens: 500,
            output_tokens: 200,
            cache_read_tokens: 1000,
            cache_creation_tokens: 500,
            model: "claude-sonnet-4-6".to_string(),
            cost_usd: 0.0, // let engine compute
        };
        engine.record(ev).unwrap();

        let events = db.lock().list_token_events("ws-cache-test").unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].cache_read_tokens, 1000);
        assert_eq!(events[0].cache_creation_tokens, 500);
        // Cost should be > 0 because model is known.
        assert!(events[0].cost_usd > 0.0, "cost should be computed");
    }

    /// Cache-read tokens are cheaper than regular input tokens for Anthropic models.
    #[test]
    fn cache_pricing_is_cheaper_than_regular_input() {
        let providers = builtin_providers();
        let sonnet = providers["anthropic"]
            .models
            .iter()
            .find(|m| m.id == "claude-sonnet-4-6")
            .unwrap();

        let regular_cost = compute_cost_with_prices(
            sonnet.input_cost_per_m,
            sonnet.output_cost_per_m,
            sonnet.cache_read_cost_per_m,
            sonnet.cache_creation_cost_per_m,
            10_000, 0, 0, 0,
        );
        let cache_read_cost = compute_cost_with_prices(
            sonnet.input_cost_per_m,
            sonnet.output_cost_per_m,
            sonnet.cache_read_cost_per_m,
            sonnet.cache_creation_cost_per_m,
            0, 0, 10_000, 0,
        );
        let cache_creation_cost = compute_cost_with_prices(
            sonnet.input_cost_per_m,
            sonnet.output_cost_per_m,
            sonnet.cache_read_cost_per_m,
            sonnet.cache_creation_cost_per_m,
            0, 0, 0, 10_000,
        );

        assert!(
            cache_read_cost < regular_cost,
            "cache read (${:.6}) should be cheaper than regular input (${:.6})",
            cache_read_cost,
            regular_cost
        );
        assert!(
            cache_creation_cost > regular_cost,
            "cache creation (${:.6}) should be more expensive than regular input (${:.6})",
            cache_creation_cost,
            regular_cost
        );
    }

    /// Anthropic builtin models have non-zero cache pricing fields.
    #[test]
    fn anthropic_models_have_cache_pricing() {
        let providers = builtin_providers();
        for m in &providers["anthropic"].models {
            assert!(
                m.cache_read_cost_per_m > 0.0,
                "model {} should have cache_read_cost_per_m > 0",
                m.id
            );
            assert!(
                m.cache_creation_cost_per_m > 0.0,
                "model {} should have cache_creation_cost_per_m > 0",
                m.id
            );
        }
    }

    /// Non-Anthropic models have zero cache pricing (no caching support).
    #[test]
    fn non_anthropic_models_have_zero_cache_pricing() {
        let providers = builtin_providers();
        for (name, p) in &providers {
            if name == "anthropic" { continue; }
            for m in &p.models {
                assert_eq!(
                    m.cache_read_cost_per_m, 0.0,
                    "provider {name} model {} should have cache_read_cost_per_m == 0",
                    m.id
                );
            }
        }
    }

    /// `parse_litellm_pricing` correctly maps token costs from the JSON fixture.
    #[test]
    fn parse_litellm_pricing_fixture() {
        let json = r#"{
            "claude-3-5-sonnet-20241022": {
                "input_cost_per_token": 0.000003,
                "output_cost_per_token": 0.000015,
                "cache_read_input_token_cost": 0.0000003,
                "cache_creation_input_token_cost": 0.00000375
            },
            "gpt-4o": {
                "input_cost_per_token": 0.0000025,
                "output_cost_per_token": 0.00001
            },
            "provider/sample-model": {
                "input_cost_per_token": 0.0
            }
        }"#;

        let prices = crate::commands::parse_litellm_pricing(json);
        // provider/sample-model has 0 input cost → filtered out
        assert!(!prices.contains_key("provider/sample-model"), "zero-cost entries should be dropped");

        let sonnet = prices.get("claude-3-5-sonnet-20241022").unwrap();
        assert!((sonnet.input_cost_per_token - 0.000003).abs() < 1e-10);
        assert!((sonnet.output_cost_per_token - 0.000015).abs() < 1e-10);
        assert!((sonnet.cache_read_input_token_cost - 0.0000003).abs() < 1e-12);
        assert!((sonnet.cache_creation_input_token_cost - 0.00000375).abs() < 1e-11);

        let gpt4o = prices.get("gpt-4o").unwrap();
        assert!((gpt4o.input_cost_per_token - 0.0000025).abs() < 1e-10);
        assert_eq!(gpt4o.cache_read_input_token_cost, 0.0);
    }

    /// usage_breakdown correctly splits cloud vs local tokens.
    #[test]
    fn usage_breakdown_splits_cloud_and_local() {
        let db = test_db();
        let router = ProviderRouter::from_map(builtin_providers());
        let now = chrono::Utc::now().to_rfc3339();

        // Cloud model event
        db.insert_token_event(&TokenEvent {
            id: None,
            session_id: "ws-cloud".to_string(),
            timestamp: now.clone(),
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            model: "claude-sonnet-4-6".to_string(),
            cost_usd: 2.00,
        }).unwrap();

        // Local model event
        db.insert_token_event(&TokenEvent {
            id: None,
            session_id: "ws-local".to_string(),
            timestamp: now.clone(),
            input_tokens: 5000,
            output_tokens: 2000,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            model: "llama3.3".to_string(),
            cost_usd: 0.0,
        }).unwrap();

        let start = "2020-01-01T00:00:00Z";
        let end = "2099-12-31T23:59:59Z";
        let breakdown = db.usage_breakdown(&router, start, end).unwrap();

        assert!((breakdown.cloud_cost_usd - 2.00).abs() < 0.001);
        assert_eq!(breakdown.cloud_tokens, 1500);
        assert_eq!(breakdown.local_tokens, 7000);
        assert!(breakdown.estimated_local_savings_usd > 0.0, "savings should be positive");
    }
}

/// Tests for Token Budgets & Governance (Feature 5).
#[cfg(test)]
mod budget_tests {
    use crate::db::Db;
    use crate::token_engine::TokenEvent;
    use tempfile::NamedTempFile;

    fn test_db() -> Db {
        let tmp = NamedTempFile::new().unwrap();
        Db::open(tmp.path()).unwrap()
    }

    fn setup_project_and_workspace(db: &Db, project_id: &str, workspace_id: &str) {
        db.insert_project(project_id, "Test Project", &format!("/tmp/{}", project_id))
            .unwrap();
        db.insert_workspace(workspace_id, project_id, "ws", "", "main", None, "")
            .unwrap();
    }

    #[test]
    fn upsert_budget_round_trip() {
        let db = test_db();
        db.upsert_budget("global", "", "daily", 5.0).unwrap();
        db.upsert_budget("global", "", "monthly", 80.0).unwrap();
        db.upsert_budget("workspace", "ws-1", "daily", 2.0).unwrap();

        let budgets = db.list_budgets().unwrap();
        assert_eq!(budgets.len(), 3);

        // Update
        db.upsert_budget("global", "", "daily", 10.0).unwrap();
        let budgets2 = db.list_budgets().unwrap();
        assert_eq!(budgets2.len(), 3); // no new row
        let global_daily = budgets2.iter().find(|b| b.scope_type == "global" && b.period == "daily").unwrap();
        assert!((global_daily.limit_usd - 10.0).abs() < 0.001);
    }

    #[test]
    fn delete_budget() {
        let db = test_db();
        db.upsert_budget("global", "", "daily", 5.0).unwrap();
        db.upsert_budget("global", "", "monthly", 80.0).unwrap();

        db.delete_budget("global", "", "daily").unwrap();
        let remaining = db.list_budgets().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].period, "monthly");
    }

    #[test]
    fn period_spend_global() {
        let db = test_db();
        setup_project_and_workspace(&db, "proj-spend", "ws-spend");

        // Insert a token event with today's timestamp
        let now = chrono::Utc::now().to_rfc3339();
        db.insert_token_event(&TokenEvent {
            id: None,
            session_id: "ws-spend".to_string(),
            timestamp: now.clone(),
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            model: "claude-sonnet-4-6".to_string(),
            cost_usd: 1.23,
        }).unwrap();

        let (cost, tokens) = db.period_spend("global", "", "daily").unwrap();
        assert!((cost - 1.23).abs() < 0.001);
        assert_eq!(tokens, 1500);
    }

    #[test]
    fn period_spend_workspace_scope() {
        let db = test_db();
        setup_project_and_workspace(&db, "proj-ws-scope", "ws-scope-a");
        setup_project_and_workspace(&db, "proj-ws-scope2", "ws-scope-b");

        let now = chrono::Utc::now().to_rfc3339();
        db.insert_token_event(&TokenEvent {
            id: None,
            session_id: "ws-scope-a".to_string(),
            timestamp: now.clone(),
            input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            model: "claude-sonnet-4-6".to_string(),
            cost_usd: 0.50,
        }).unwrap();
        db.insert_token_event(&TokenEvent {
            id: None,
            session_id: "ws-scope-b".to_string(),
            timestamp: now.clone(),
            input_tokens: 200,
            output_tokens: 100,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            model: "claude-sonnet-4-6".to_string(),
            cost_usd: 1.00,
        }).unwrap();

        // ws-scope-a only
        let (cost_a, tokens_a) = db.period_spend("workspace", "ws-scope-a", "daily").unwrap();
        assert!((cost_a - 0.50).abs() < 0.001);
        assert_eq!(tokens_a, 150);

        // global sees both
        let (cost_all, _) = db.period_spend("global", "", "daily").unwrap();
        assert!((cost_all - 1.50).abs() < 0.001);
    }

    #[test]
    fn period_spend_project_scope() {
        let db = test_db();
        setup_project_and_workspace(&db, "proj-scope", "ws-in-proj");
        setup_project_and_workspace(&db, "proj-other", "ws-other-proj");

        let now = chrono::Utc::now().to_rfc3339();
        db.insert_token_event(&TokenEvent {
            id: None,
            session_id: "ws-in-proj".to_string(),
            timestamp: now.clone(),
            input_tokens: 500,
            output_tokens: 250,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            model: "claude-sonnet-4-6".to_string(),
            cost_usd: 2.00,
        }).unwrap();
        db.insert_token_event(&TokenEvent {
            id: None,
            session_id: "ws-other-proj".to_string(),
            timestamp: now.clone(),
            input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            model: "claude-sonnet-4-6".to_string(),
            cost_usd: 0.50,
        }).unwrap();

        let (cost, tokens) = db.period_spend("project", "proj-scope", "daily").unwrap();
        assert!((cost - 2.00).abs() < 0.001);
        assert_eq!(tokens, 750);
    }

    #[test]
    fn export_csv_shape() {
        let db = test_db();
        setup_project_and_workspace(&db, "proj-csv", "ws-csv");

        let now = chrono::Utc::now().to_rfc3339();
        db.insert_token_event(&TokenEvent {
            id: None,
            session_id: "ws-csv".to_string(),
            timestamp: now.clone(),
            input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            model: "claude-sonnet-4-6".to_string(),
            cost_usd: 0.25,
        }).unwrap();

        let start = "2020-01-01T00:00:00Z";
        let end = "2099-12-31T23:59:59Z";
        let csv = db.export_token_events_csv(start, end).unwrap();
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], "timestamp,workspace_id,model,input_tokens,output_tokens,cost_usd");
        assert_eq!(lines.len(), 2); // header + 1 row
        assert!(lines[1].contains("ws-csv"));
        assert!(lines[1].contains("claude-sonnet-4-6"));
        assert!(lines[1].contains("100"));
    }
}

/// Tests for Review Mode Rethink — file_edits table, hunk ops, test command detection.
#[cfg(test)]
mod review_rethink_tests {
    use crate::db::Db;
    use tempfile::NamedTempFile;
    use tempfile::TempDir;
    use std::fs;

    fn test_db() -> Db {
        let tmp = NamedTempFile::new().unwrap();
        Db::open(tmp.path()).unwrap()
    }

    fn setup_workspace(db: &Db) {
        db.insert_project("proj-r", "Test Project", "/tmp/proj-r").unwrap();
        db.insert_workspace("ws-r", "proj-r", "ws", "", "feat/test", None, "").unwrap();
    }

    // ── file_edits CRUD ────────────────────────────────────────────

    #[test]
    fn file_edits_insert_and_list() {
        let db = test_db();
        setup_workspace(&db);

        let id1 = db.insert_file_edit("ws-r", "src/foo.ts", "write_file", Some(10)).unwrap();
        let id2 = db.insert_file_edit("ws-r", "src/bar.ts", "write_file", None).unwrap();
        assert!(id2 > id1);

        let edits = db.list_file_edits_for_workspace("ws-r").unwrap();
        assert_eq!(edits.len(), 2);
        // list is ordered by created_at DESC, so bar.ts is first
        assert_eq!(edits[0].file_path, "src/bar.ts");
        assert_eq!(edits[0].message_id, None);
        assert_eq!(edits[1].file_path, "src/foo.ts");
        assert_eq!(edits[1].message_id, Some(10));
    }

    #[test]
    fn file_edits_latest_for_file() {
        let db = test_db();
        setup_workspace(&db);

        db.insert_file_edit("ws-r", "src/foo.ts", "write_file", Some(1)).unwrap();
        db.insert_file_edit("ws-r", "src/foo.ts", "write_file", Some(2)).unwrap();

        let latest = db.latest_edit_for_file("ws-r", "src/foo.ts").unwrap();
        assert!(latest.is_some());
        // message_id 2 was inserted last, but since timestamps are the same
        // within a test, we just verify we get one back with the right path.
        assert_eq!(latest.unwrap().file_path, "src/foo.ts");
    }

    #[test]
    fn file_edits_latest_returns_none_for_unknown_file() {
        let db = test_db();
        setup_workspace(&db);

        let result = db.latest_edit_for_file("ws-r", "nonexistent.ts").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn workspace_test_command_set_and_get() {
        let db = test_db();
        setup_workspace(&db);

        // Initially None
        let cmd = db.get_workspace_test_command("ws-r").unwrap();
        assert_eq!(cmd, None);

        // Set it
        db.set_workspace_test_command("ws-r", "npm test").unwrap();
        let cmd = db.get_workspace_test_command("ws-r").unwrap();
        assert_eq!(cmd, Some("npm test".to_string()));

        // Overwrite
        db.set_workspace_test_command("ws-r", "cargo test").unwrap();
        let cmd = db.get_workspace_test_command("ws-r").unwrap();
        assert_eq!(cmd, Some("cargo test".to_string()));
    }

    #[test]
    fn file_edits_cascade_delete_with_workspace() {
        let db = test_db();
        setup_workspace(&db);

        db.insert_file_edit("ws-r", "src/foo.ts", "write_file", None).unwrap();
        assert_eq!(db.list_file_edits_for_workspace("ws-r").unwrap().len(), 1);

        // Deleting the workspace cascades to file_edits.
        db.delete_workspace("ws-r").unwrap();
        assert_eq!(db.list_file_edits_for_workspace("ws-r").unwrap().len(), 0);
    }

    // ── detect_default_test_command ────────────────────────────────

    #[tokio::test]
    async fn detect_npm_project() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("package.json"), r#"{"name":"test"}"#).unwrap();

        let result = crate::commands::detect_default_test_command(
            tmp.path().to_string_lossy().to_string()
        ).await.unwrap();
        assert_eq!(result, Some("npm test".to_string()));
    }

    #[tokio::test]
    async fn detect_cargo_project() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("Cargo.toml"), "[package]\nname=\"test\"\nversion=\"0.1.0\"").unwrap();

        let result = crate::commands::detect_default_test_command(
            tmp.path().to_string_lossy().to_string()
        ).await.unwrap();
        assert_eq!(result, Some("cargo test".to_string()));
    }

    #[tokio::test]
    async fn detect_pytest_project() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("pytest.ini"), "[pytest]").unwrap();

        let result = crate::commands::detect_default_test_command(
            tmp.path().to_string_lossy().to_string()
        ).await.unwrap();
        assert_eq!(result, Some("pytest".to_string()));
    }

    #[tokio::test]
    async fn detect_no_project_returns_none() {
        let tmp = TempDir::new().unwrap();

        let result = crate::commands::detect_default_test_command(
            tmp.path().to_string_lossy().to_string()
        ).await.unwrap();
        assert_eq!(result, None);
    }

    // ── revert_hunk with a real git repo ──────────────────────────

    #[tokio::test]
    async fn revert_hunk_undoes_a_change() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        // Init a git repo
        let init = std::process::Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(root)
            .output();
        if init.is_err() { return; } // git not available in this env

        std::process::Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(root).output().ok();
        std::process::Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(root).output().ok();

        // Create initial file + commit
        fs::write(root.join("foo.txt"), "line1\nline2\nline3\n").unwrap();
        std::process::Command::new("git")
            .args(["add", "foo.txt"])
            .current_dir(root).output().ok();
        std::process::Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(root).output().ok();

        // Modify the file
        fs::write(root.join("foo.txt"), "line1\nLINE2_MODIFIED\nline3\n").unwrap();

        // Get the diff to build a hunk
        let diff_out = std::process::Command::new("git")
            .args(["diff"])
            .current_dir(root)
            .output()
            .unwrap();
        let diff_text = String::from_utf8_lossy(&diff_out.stdout).to_string();

        if diff_text.is_empty() { return; } // shouldn't happen but be safe

        // revert_hunk should restore the original content
        let result = crate::commands::revert_hunk(
            root.to_string_lossy().to_string(),
            diff_text,
        ).await;

        assert!(result.is_ok(), "revert_hunk failed: {:?}", result.err());

        let content = fs::read_to_string(root.join("foo.txt")).unwrap();
        assert_eq!(content, "line1\nline2\nline3\n");
    }
}

/// Tests for the Phase 3 `spawn_or_attach` logic in [`crate::pty_manager`].
///
/// These tests start the real daemon binary so we can verify the
/// "attach when session already exists" vs "spawn fresh" code paths.
/// They mirror the pattern used in `pty_client.rs` integration tests and
/// require the daemon to have been compiled first:
///   `cargo build --bin octopush-pty-server`
#[cfg(test)]
mod pty_manager_reattach_tests {
    use crate::pty_client::DaemonClient;
    use crate::pty_manager::PtyManager;
    use serial_test::serial;
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::time::Duration;
    use tempfile::TempDir;

    fn find_daemon_bin() -> PathBuf {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                let c = parent.join("octopush-pty-server");
                if c.exists() { return c; }
                if let Some(gp) = parent.parent() {
                    let c = gp.join("octopush-pty-server");
                    if c.exists() { return c; }
                }
            }
        }
        for rel in &[
            "target/debug/octopush-pty-server",
            "../target/debug/octopush-pty-server",
        ] {
            if let Ok(cwd) = std::env::current_dir() {
                let c = cwd.join(rel);
                if c.exists() { return c; }
            }
        }
        panic!("octopush-pty-server binary not found — run `cargo build --bin octopush-pty-server` first");
    }

    fn start_daemon(home: &std::path::Path) -> std::process::Child {
        let bin = find_daemon_bin();
        Command::new(&bin)
            .env("HOME", home)
            .env("OCTOPUSH_PTY_AUTO_EXIT_SECS", "10")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn daemon")
    }

    fn wait_for_socket(sock: &PathBuf, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if sock.exists() && std::os::unix::net::UnixStream::connect(sock).is_ok() {
                return true;
            }
            if std::time::Instant::now() >= deadline { return false; }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// When the daemon already has a running PTY for the requested id,
    /// `list_live_sessions` must report it as running = true — which is the
    /// signal `spawn_or_attach` uses to choose the `Reattached` path.
    ///
    /// We can't easily call `spawn_or_attach` in a test because it needs a
    /// `tauri::AppHandle`, so we exercise the decision logic through
    /// `list_live_sessions` + a manual `attach` call, which covers the same
    /// code path without the UI layer.
    #[test]
    #[serial]
    fn pty_manager_attach_when_daemon_has_session() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let sock_path = home.join(".octopush").join("pty-server.sock");
        fs::create_dir_all(home.join(".octopush")).unwrap();

        let mut daemon = start_daemon(home);
        assert!(
            wait_for_socket(&sock_path, Duration::from_secs(5)),
            "daemon socket did not appear"
        );

        let client = DaemonClient::connect_to(sock_path.to_str().unwrap()).unwrap();

        // Pre-spawn a PTY directly via the client (simulating a previous Octopush session).
        let env = HashMap::new();
        client.spawn("reattach-test", "/tmp", &env, Some("/bin/sh"), 24, 80)
            .expect("pre-spawn");

        // Now create a fresh PtyManager (simulating new Octopush process connecting
        // to the same daemon) and call list_live_sessions.
        // DaemonClient::connect_to already returns Arc<DaemonClient>.
        let pty = PtyManager::new(
            DaemonClient::connect_to(sock_path.to_str().unwrap()).unwrap(),
        );

        let sessions = pty.list_live_sessions().expect("list_live_sessions");
        let found = sessions.iter().find(|s| s.id == "reattach-test");
        assert!(found.is_some(), "expected 'reattach-test' in live sessions");
        assert!(found.unwrap().running, "expected session to be running");

        // The spawn_or_attach logic: since it IS running, mode should be Reattached.
        // We verify this by calling the client attach ourselves to confirm the daemon
        // accepts it, which is exactly what spawn_or_attach's reattach branch does.
        let rx = pty.client.attach("reattach-test", 0);
        assert!(rx.is_ok(), "attach to running session must succeed");

        daemon.kill().ok();
    }

    /// When the daemon has no PTY for the id, `list_live_sessions` returns an
    /// empty list (or a list that doesn't contain the id), which triggers the
    /// `Spawned` branch.
    #[test]
    #[serial]
    fn pty_manager_spawn_when_daemon_doesnt_have_session() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let sock_path = home.join(".octopush").join("pty-server.sock");
        fs::create_dir_all(home.join(".octopush")).unwrap();

        let mut daemon = start_daemon(home);
        assert!(
            wait_for_socket(&sock_path, Duration::from_secs(5)),
            "daemon socket did not appear"
        );

        let pty = PtyManager::new(
            DaemonClient::connect_to(sock_path.to_str().unwrap()).unwrap(),
        );

        let sessions = pty.list_live_sessions().expect("list_live_sessions");

        // Fresh daemon — no sessions at all.
        assert!(
            !sessions.iter().any(|s| s.id == "fresh-id"),
            "expected 'fresh-id' NOT in live sessions on a brand-new daemon"
        );

        // Verify the SpawnMode discriminant reflects "not running → Spawned".
        // (The spawn_or_attach's 'else' branch fires because the session is absent.)
        // We verify the mode semantics by confirming the session is absent before spawn.
        let is_running = sessions.iter().any(|s| s.id == "fresh-id" && s.running);
        assert!(!is_running, "fresh-id should not be running before any spawn");

        // Spawn the PTY directly to prove the client + daemon work.
        let env = HashMap::new();
        let pid = pty.client.spawn("fresh-id", "/tmp", &env, Some("/bin/sh"), 24, 80)
            .expect("spawn fresh-id");
        assert!(pid > 0, "spawned PID must be positive, got {pid}");

        // Now it should appear as running.
        let sessions2 = pty.list_live_sessions().expect("list_live_sessions again");
        let found = sessions2.iter().find(|s| s.id == "fresh-id");
        assert!(found.is_some(), "fresh-id must appear after spawn");
        assert!(found.unwrap().running, "fresh-id must be running after spawn");

        daemon.kill().ok();
    }
}

#[cfg(test)]
mod clone_progress_tests {
    use crate::commands::parse_clone_progress;

    fn pct(v: &serde_json::Value) -> u64 {
        v["percent"].as_u64().unwrap()
    }
    fn cur(v: &serde_json::Value) -> u64 {
        v["current"].as_u64().unwrap()
    }
    fn tot(v: &serde_json::Value) -> u64 {
        v["total"].as_u64().unwrap()
    }
    fn phase(v: &serde_json::Value) -> &str {
        v["phase"].as_str().unwrap()
    }

    #[test]
    fn receiving_objects_mid_progress() {
        let line = "Receiving objects:  47% (118/250), 1.23 MiB | 512.00 KiB/s";
        let v = parse_clone_progress(line).unwrap();
        assert_eq!(phase(&v), "Receiving objects");
        assert_eq!(pct(&v), 47);
        assert_eq!(cur(&v), 118);
        assert_eq!(tot(&v), 250);
    }

    #[test]
    fn receiving_objects_complete() {
        let line = "Receiving objects: 100% (250/250), 5.00 MiB | 1.00 MiB/s, done.";
        let v = parse_clone_progress(line).unwrap();
        assert_eq!(phase(&v), "Receiving objects");
        assert_eq!(pct(&v), 100);
        assert_eq!(cur(&v), 250);
        assert_eq!(tot(&v), 250);
    }

    #[test]
    fn resolving_deltas_done() {
        let line = "Resolving deltas: 100% (50/50), done.";
        let v = parse_clone_progress(line).unwrap();
        assert_eq!(phase(&v), "Resolving deltas");
        assert_eq!(pct(&v), 100);
        assert_eq!(cur(&v), 50);
        assert_eq!(tot(&v), 50);
    }

    #[test]
    fn counting_objects() {
        let line = "Counting objects: 100% (250/250), done.";
        let v = parse_clone_progress(line).unwrap();
        assert_eq!(phase(&v), "Counting objects");
        assert_eq!(pct(&v), 100);
        assert_eq!(cur(&v), 250);
        assert_eq!(tot(&v), 250);
    }

    #[test]
    fn compressing_objects() {
        let line = "Compressing objects:  60% (30/50)";
        let v = parse_clone_progress(line).unwrap();
        assert_eq!(phase(&v), "Compressing objects");
        assert_eq!(pct(&v), 60);
        assert_eq!(cur(&v), 30);
        assert_eq!(tot(&v), 50);
    }

    #[test]
    fn remote_counting_with_leading_remote_prefix() {
        // git sometimes prefixes lines with "remote: "
        let line = "remote: Counting objects: 100% (4/4), done.";
        // This should NOT match because "remote: Counting" starts with "remote" not a phase word
        // (the regex requires the line to start with the phase name)
        assert!(parse_clone_progress(line).is_none());
    }

    #[test]
    fn non_progress_lines_return_none() {
        assert!(parse_clone_progress("").is_none());
        assert!(parse_clone_progress("Cloning into 'myrepo'...").is_none());
        assert!(parse_clone_progress("Permission denied (publickey).").is_none());
        assert!(parse_clone_progress("fatal: Could not read from remote repository.").is_none());
        assert!(parse_clone_progress("remote: Enumerating objects: 4, done.").is_none());
    }
}

#[cfg(test)]
mod scanner_tests {
    use crate::token_engine::scan_pty_output;

    #[test]
    fn parse_api_usage_json() {
        let payload = r#"some prefix {"model":"claude-sonnet-4-6","usage":{"input_tokens":1500,"output_tokens":800,"cache_read_input_tokens":100}} some suffix"#;
        let ev = scan_pty_output("sess-1", payload.as_bytes()).unwrap();
        assert_eq!(ev.input_tokens, 1500);
        assert_eq!(ev.output_tokens, 800);
        assert_eq!(ev.cache_read_tokens, 100);
        assert_eq!(ev.model, "claude-sonnet-4-6");
        assert!(ev.cost_usd > 0.0);
    }

    #[test]
    fn parse_claude_code_summary() {
        let line = "Total cost: $1.23 | Input: 45.2K | Output: 12.1K";
        let ev = scan_pty_output("sess-2", line.as_bytes()).unwrap();
        assert!((ev.cost_usd - 1.23).abs() < 0.001);
        assert_eq!(ev.input_tokens, 45200);
        assert_eq!(ev.output_tokens, 12100);
    }

    #[test]
    fn no_match_returns_none() {
        assert!(scan_pty_output("x", b"hello world").is_none());
        assert!(scan_pty_output("x", b"").is_none());
    }
}

#[cfg(test)]
mod read_directory_tests {
    use crate::commands::read_directory;
    use std::fs;
    use tempfile::TempDir;

    #[tokio::test]
    async fn lists_entries_respecting_gitignore() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();

        // Create subdir, a normal file, an ignored file, and a .gitignore.
        fs::create_dir(tmp.path().join("subdir")).unwrap();
        fs::write(tmp.path().join("file.txt"), "hello").unwrap();
        fs::write(tmp.path().join("ignored.txt"), "nope").unwrap();
        fs::write(tmp.path().join(".gitignore"), "ignored.txt\n").unwrap();

        let entries = read_directory(root, None).await.expect("should succeed");

        // Should NOT include ignored.txt or .git
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(!names.contains(&"ignored.txt"), "ignored.txt must be filtered");
        assert!(!names.contains(&".git"), ".git must be filtered");

        // Should include subdir, file.txt, .gitignore
        assert!(names.contains(&"subdir"), "subdir must appear");
        assert!(names.contains(&"file.txt"), "file.txt must appear");

        // Dirs sort before files
        let first = &entries[0];
        assert!(first.is_dir, "first entry must be a directory");

        // Within files, alphabetical
        let files: Vec<&str> = entries.iter().filter(|e| !e.is_dir).map(|e| e.name.as_str()).collect();
        let mut sorted = files.clone();
        sorted.sort_by_key(|s| s.to_lowercase());
        assert_eq!(files, sorted, "files must be sorted alphabetically");
    }

    #[tokio::test]
    async fn returns_error_for_nonexistent_path() {
        let result = read_directory("/nonexistent/path/abc123".to_string(), None).await;
        assert!(result.is_err(), "should return error for missing directory");
    }

    #[tokio::test]
    async fn one_level_only() {
        let tmp = TempDir::new().unwrap();
        let nested = tmp.path().join("a").join("b");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("deep.txt"), "x").unwrap();

        let entries = read_directory(tmp.path().to_string_lossy().to_string(), None)
            .await
            .unwrap();

        // Should only see "a", not "a/b" or "a/b/deep.txt"
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "a");
    }

    #[tokio::test]
    async fn show_ignored_includes_and_flags_gitignored_entries() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("target")).unwrap();
        fs::write(tmp.path().join("target").join("app.war"), "x").unwrap();
        fs::write(tmp.path().join("main.rs"), "fn main() {}").unwrap();
        fs::write(tmp.path().join(".gitignore"), "target/\nsecret.txt\n").unwrap();
        fs::write(tmp.path().join("secret.txt"), "s").unwrap();
        let root = tmp.path().to_string_lossy().to_string();

        // Default mode: target absent, nothing flagged.
        let entries = read_directory(root.clone(), None).await.unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(!names.contains(&"target"), "default mode must hide gitignored dirs");
        assert!(!names.contains(&"secret.txt"), "default mode must hide gitignored files");
        assert!(entries.iter().all(|e| !e.is_ignored), "default mode never flags");

        // Show-ignored mode: target present, flagged, still sorted dirs-first.
        let entries = read_directory(root, Some(true)).await.unwrap();
        let target = entries
            .iter()
            .find(|e| e.name == "target")
            .expect("target must be visible in show-ignored mode");
        assert!(target.is_ignored, "target must be flagged ignored");
        assert!(target.is_dir);
        let secret = entries
            .iter()
            .find(|e| e.name == "secret.txt")
            .expect("secret.txt visible");
        assert!(secret.is_ignored, "gitignored plain file must be flagged");
        assert!(!secret.is_dir);
        let main = entries.iter().find(|e| e.name == "main.rs").unwrap();
        assert!(!main.is_ignored, "tracked files must not be flagged");
        assert!(entries[0].is_dir, "dirs still sort before files");
    }

    #[tokio::test]
    async fn git_dir_excluded_in_both_modes() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join(".git")).unwrap();
        fs::write(tmp.path().join(".git").join("HEAD"), "ref").unwrap();
        fs::write(tmp.path().join("a.txt"), "x").unwrap();
        let root = tmp.path().to_string_lossy().to_string();

        for mode in [None, Some(false), Some(true)] {
            let entries = read_directory(root.clone(), mode).await.unwrap();
            assert!(
                entries.iter().all(|e| e.name != ".git"),
                ".git must be excluded for mode {mode:?}"
            );
        }
    }
}

#[cfg(test)]
mod file_io_tests {
    use crate::commands::{read_file, write_file};
    use std::fs;
    use tempfile::TempDir;

    #[tokio::test]
    async fn read_file_returns_content() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("hello.txt");
        fs::write(&path, "hello world").unwrap();

        let content = read_file(path.to_string_lossy().to_string())
            .await
            .expect("read_file should succeed");
        assert_eq!(content, "hello world");
    }

    #[tokio::test]
    async fn write_file_persists() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("out.txt");

        write_file(path.to_string_lossy().to_string(), "written".to_string())
            .await
            .expect("write_file should succeed");

        let on_disk = fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk, "written");
    }

    #[tokio::test]
    async fn read_file_errors_on_missing() {
        let result = read_file("/nonexistent/path/missing_abc123.txt".to_string()).await;
        assert!(result.is_err());
        let msg = format!("{:?}", result.unwrap_err());
        assert!(
            msg.contains("missing_abc123.txt"),
            "error message should mention the path, got: {msg}"
        );
    }

    #[tokio::test]
    async fn write_file_creates_parent_file_on_existing_dir() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("newfile.txt");

        write_file(path.to_string_lossy().to_string(), "content".to_string())
            .await
            .unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "content");
    }
}

#[cfg(test)]
mod provider_catalog_tests {
    use crate::provider_router::{
        default_providers_list, validate_providers, write_providers, ProviderRouter, ProviderConfig, ModelInfo,
    };
    use serial_test::serial;
    use tempfile::TempDir;

    fn prov(name: &str, protocol: &str, local: bool, models: Vec<ModelInfo>) -> ProviderConfig {
        ProviderConfig {
            name: name.into(),
            api_base: if local { String::new() } else { "https://x".into() },
            api_key_env: String::new(),
            models,
            rate_limits: Default::default(),
            enabled: true,
            protocol: protocol.into(),
            local,
        }
    }
    fn model(id: &str) -> ModelInfo {
        ModelInfo {
            id: id.into(), display_name: id.into(),
            input_cost_per_m: 1.0, output_cost_per_m: 2.0,
            cache_read_cost_per_m: 0.0, cache_creation_cost_per_m: 0.0,
            max_context: 200_000, supports_vision: false, supports_tools: true, tags: vec![],
        }
    }

    #[test]
    fn validate_rejects_dupes_and_empties() {
        assert!(validate_providers(&[prov("", "anthropic", false, vec![])]).is_err());
        assert!(validate_providers(&[prov("a", "anthropic", false, vec![]), prov("A", "anthropic", false, vec![])]).is_err());
        assert!(validate_providers(&[prov("a", "weird", false, vec![])]).is_err());
        assert!(validate_providers(&[prov("a", "anthropic", false, vec![model("m"), model("m")])]).is_err());
        assert!(validate_providers(&[prov("a", "anthropic", false, vec![model("ok")])]).is_ok());
    }

    #[test]
    #[serial]
    fn write_then_load_roundtrips() {
        let tmp = TempDir::new().unwrap();
        std::env::set_var("HOME", tmp.path());
        let list = vec![prov("sonatype", "anthropic", false, vec![model("claude-x")])];
        write_providers(&list).unwrap();
        let router = ProviderRouter::load().unwrap();
        let names: Vec<String> = router.list_providers().iter().map(|p| p.name.clone()).collect();
        assert!(names.contains(&"sonatype".to_string()));
        // The built-ins are also re-seeded by load(); our custom one persists.
        assert!(router.find_model("claude-x").is_some());
    }

    #[test]
    fn defaults_list_has_builtins() {
        let d = default_providers_list();
        let names: Vec<&str> = d.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"anthropic"));
        assert!(names.contains(&"openai"));
    }
}

#[cfg(test)]
mod editor_detection_tests {
    #[test]
    fn split_editor_command_parses_program_and_args() {
        use crate::commands::split_editor_command;
        assert_eq!(
            split_editor_command("code"),
            Some(("code".to_string(), vec![]))
        );
        assert_eq!(
            split_editor_command("code -n"),
            Some(("code".to_string(), vec!["-n".to_string()]))
        );
        assert_eq!(split_editor_command("   "), None);
    }

    #[test]
    fn binary_on_path_finds_a_known_shell() {
        use crate::commands::binary_on_path;
        #[cfg(unix)]
        assert!(binary_on_path("sh"));
        assert!(!binary_on_path("definitely-not-a-real-binary-xyz"));
    }
}

#[cfg(test)]
mod pr_state_tests {
    #[test]
    fn pr_state_open_when_open_not_draft() {
        let raw = serde_json::json!({
            "number": 42, "html_url": "https://x/pr/42", "title": "Add",
            "state": "open", "draft": false, "merged_at": null
        });
        let pr = crate::github::pr_from_json(&raw);
        assert_eq!(pr.state, crate::github::PrState::Open);
    }

    #[test]
    fn pr_state_draft_when_open_and_draft() {
        let raw = serde_json::json!({
            "number": 43, "html_url": "https://x/pr/43", "title": "WIP",
            "state": "open", "draft": true, "merged_at": null
        });
        let pr = crate::github::pr_from_json(&raw);
        assert_eq!(pr.state, crate::github::PrState::Draft);
    }

    #[test]
    fn pr_state_merged_when_closed_and_merged_at_set() {
        let raw = serde_json::json!({
            "number": 41, "html_url": "https://x/pr/41", "title": "Ship",
            "state": "closed", "draft": false, "merged_at": "2026-05-30T15:00:00Z"
        });
        let pr = crate::github::pr_from_json(&raw);
        assert_eq!(pr.state, crate::github::PrState::Merged);
    }

    #[test]
    fn pr_state_closed_when_closed_and_merged_at_null() {
        let raw = serde_json::json!({
            "number": 40, "html_url": "https://x/pr/40", "title": "Nope",
            "state": "closed", "draft": false, "merged_at": null
        });
        let pr = crate::github::pr_from_json(&raw);
        assert_eq!(pr.state, crate::github::PrState::Closed);
    }

    #[test]
    fn pr_state_merged_when_gh_cli_returns_merged_state_directly() {
        // The gh CLI returns state="MERGED" (normalized to lowercase before
        // calling pr_from_json) — distinct from the REST API which reports
        // state="closed" + merged_at. This regression check ensures both
        // shapes resolve to PrState::Merged.
        let raw = serde_json::json!({
            "number": 41, "html_url": "https://x/pr/41", "title": "Ship",
            "state": "merged", "draft": false, "merged_at": "2026-05-30T15:00:00Z"
        });
        let pr = crate::github::pr_from_json(&raw);
        assert_eq!(pr.state, crate::github::PrState::Merged);
    }

    #[test]
    fn parse_open_pr_list_maps_branch_and_normalises_state() {
        use crate::commands::parse_open_pr_list;
        let json = serde_json::json!([
            { "number": 7, "title": "Feat", "url": "https://x/7", "state": "OPEN", "isDraft": false, "headRefName": "feat/a" },
            { "number": 8, "title": "WIP",  "url": "https://x/8", "state": "OPEN", "isDraft": true,  "headRefName": "feat/b" },
            { "number": 9, "title": "no-branch", "url": "https://x/9", "state": "OPEN", "isDraft": false }
        ]);
        let out = parse_open_pr_list(json.as_array().unwrap());
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].branch, "feat/a");
        assert_eq!(out[0].pr.number, 7);
        assert_eq!(out[1].branch, "feat/b");
    }

    #[test]
    fn apply_hunk_restores_a_reverted_change() {
        use std::fs;
        let dir = tempfile::tempdir().unwrap();
        crate::git_ops::init_repo(dir.path()).unwrap();
        fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        std::process::Command::new("git").args(["add","."]).current_dir(dir.path()).output().unwrap();
        std::process::Command::new("git").args(["-c","user.email=t@t","-c","user.name=t","commit","-m","x"]).current_dir(dir.path()).output().unwrap();
        fs::write(dir.path().join("a.txt"), "two\n").unwrap();
        let diff = crate::git_ops::get_diff_text(dir.path(), false).unwrap();
        tauri::async_runtime::block_on(crate::commands::revert_hunk(dir.path().to_string_lossy().into(), diff.clone())).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "one\n");
        tauri::async_runtime::block_on(crate::commands::apply_hunk(dir.path().to_string_lossy().into(), diff)).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "two\n");
    }
}

#[cfg(test)]
mod orchestrator_types_tests {
    use crate::orchestrator::types::*;

    #[test]
    fn status_strings_round_trip() {
        for s in [
            StageStatus::Pending,
            StageStatus::Running,
            StageStatus::AwaitingCheckpoint,
            StageStatus::Done,
            StageStatus::Failed,
        ] {
            assert_eq!(StageStatus::from_db(s.as_db()), Some(s.clone()));
        }
        for s in [
            RunStatus::Draft,
            RunStatus::Running,
            RunStatus::Paused,
            RunStatus::Completed,
            RunStatus::Aborted,
            RunStatus::Failed,
        ] {
            assert_eq!(RunStatus::from_db(s.as_db()), Some(s.clone()));
        }
        assert_eq!(StageStatus::from_db("nonsense"), None);
    }

    #[test]
    fn artifact_serializes_camel_case() {
        let a = StageArtifact {
            kind: ArtifactKind::Plan,
            text: "do the thing".into(),
            payload: None,
            refs_worktree: false,
        };
        let json = serde_json::to_string(&a).unwrap();
        assert!(json.contains("\"kind\":\"plan\""));
        assert!(json.contains("\"refsWorktree\":false"));
    }

    #[test]
    fn substrate_strings() {
        assert_eq!(AgentSubstrate::Api.as_db(), "api");
        assert_eq!(AgentSubstrate::from_db("cli"), Some(AgentSubstrate::Cli));
    }
}

#[cfg(test)]
mod agentic_loop_tests {
    use crate::orchestrator::agentic::run_agentic_loop;
    use crate::orchestrator::events::EventSink;
    use crate::orchestrator::live::LiveEmitter;
    use crate::providers::{
        LlmProvider, LlmRequest, LlmResponse, LlmStopReason, LlmToolUse,
    };
    use parking_lot::Mutex;
    use serde_json::Value;

    struct NoopSink;
    impl EventSink for NoopSink {
        fn emit(&self, _event: &str, _payload: Value) {}
    }

    /// A provider that returns a scripted sequence of responses.
    struct ScriptedProvider {
        responses: Mutex<Vec<LlmResponse>>,
    }

    #[async_trait::async_trait]
    impl LlmProvider for ScriptedProvider {
        async fn complete(
            &self,
            _api_base: &str,
            _api_key: Option<&str>,
            _req: &LlmRequest,
            _client: &reqwest::Client,
        ) -> crate::error::AppResult<LlmResponse> {
            Ok(self.responses.lock().remove(0))
        }
    }

    #[tokio::test]
    async fn runs_tool_then_returns_final_text() {
        let tmp = tempfile::tempdir().unwrap();
        // 1st response: call list_files. 2nd: final text, end turn.
        let provider = ScriptedProvider {
            responses: Mutex::new(vec![
                LlmResponse {
                    text: String::new(),
                    tool_uses: vec![LlmToolUse {
                        id: "t1".into(),
                        name: "list_files".into(),
                        input: serde_json::json!({ "path": "." }),
                    }],
                    stop_reason: LlmStopReason::ToolUse,
                    input_tokens: 100,
                    output_tokens: 10,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                },
                LlmResponse {
                    text: "All done.".into(),
                    tool_uses: vec![],
                    stop_reason: LlmStopReason::EndTurn,
                    input_tokens: 50,
                    output_tokens: 5,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                },
            ]),
        };
        let client = reqwest::Client::new();
        let sink = NoopSink;
        let emitter = LiveEmitter::new(&sink, "test-run", "test-stage");
        let result = run_agentic_loop(
            &provider,
            "http://unused",
            None,
            &client,
            "test-model",
            "you are a test",
            "do something",
            tmp.path(),
            25,
            &emitter,
        )
        .await
        .unwrap();

        assert_eq!(result.text, "All done.");
        assert_eq!(result.input_tokens, 150);
        assert_eq!(result.output_tokens, 15);
        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.tool_calls[0].name, "list_files");
    }
}

#[cfg(test)]
mod cost_tests {
    use crate::orchestrator::cost::{baseline_cost, stage_cost};

    #[test]
    fn stage_cost_matches_token_engine() {
        // claude-opus-4-6: $15/M input, $75/M output.
        let c = stage_cost("claude-opus-4-6", 1_000_000, 100_000, 0, 0);
        assert!((c - (15.0 + 7.5)).abs() < 0.01);
    }

    #[test]
    fn baseline_uses_reference_prices_on_actual_tokens() {
        // Same tokens, premium reference model → baseline >= actual for a cheaper model.
        let actual = stage_cost("claude-haiku-4-5", 1_000_000, 100_000, 0, 0);
        let base = baseline_cost("claude-opus-4-6", 1_000_000, 100_000);
        assert!(base > actual);
    }
}

#[cfg(test)]
mod runner_helpers_tests {
    use crate::orchestrator::runner::{artifact_kind_for, system_prompt_for, user_input_for};
    use crate::orchestrator::types::{ArtifactKind, StageArtifact};

    #[test]
    fn role_maps_to_artifact_kind() {
        assert_eq!(artifact_kind_for("plan"), ArtifactKind::Plan);
        assert_eq!(artifact_kind_for("plan_review"), ArtifactKind::Review);
        assert_eq!(artifact_kind_for("code_review"), ArtifactKind::Review);
        assert_eq!(artifact_kind_for("implement"), ArtifactKind::Diff);
        assert_eq!(artifact_kind_for("test"), ArtifactKind::Tests);
        assert_eq!(artifact_kind_for("anything-else"), ArtifactKind::Note);
    }

    #[test]
    fn system_prompt_is_role_specific() {
        assert!(system_prompt_for("plan").to_lowercase().contains("plan"));
        assert!(system_prompt_for("implement").to_lowercase().contains("implement"));
    }

    #[test]
    fn system_prompt_frames_agent_as_non_interactive_pipeline_worker() {
        // Every stage, regardless of role, gets the autonomous/no-questions framing.
        for role in ["plan", "implement", "code_review", "test", "anything"] {
            let p = system_prompt_for(role).to_lowercase();
            assert!(p.contains("never ask"), "role {role} missing no-questions directive");
            assert!(p.contains("pipeline"), "role {role} missing pipeline framing");
            assert!(p.contains("git"), "role {role} missing git-ownership note");
        }
    }

    #[test]
    fn auto_review_prompt_requests_a_verdict() {
        use crate::orchestrator::runner::system_prompt_with_loop;
        use crate::orchestrator::types::LoopMode;
        let auto = system_prompt_with_loop("code_review", Some(LoopMode::Auto));
        assert!(auto.contains("VERDICT:"));
        let gated = system_prompt_with_loop("code_review", Some(LoopMode::Gated));
        assert!(!gated.contains("VERDICT:"));
        let plain = system_prompt_with_loop("implement", None);
        assert!(!plain.contains("VERDICT:"));
    }

    #[test]
    fn user_input_includes_task_and_prior_artifact() {
        let prior = StageArtifact {
            kind: ArtifactKind::Plan,
            text: "Step 1: do X".into(),
            payload: None,
            refs_worktree: false,
        };
        let input = user_input_for("implement", "Build feature Y", &prior, None);
        assert!(input.contains("Build feature Y"));
        assert!(input.contains("Step 1: do X"));

        let with_fb = user_input_for("implement", "Build Y", &prior, Some("be more careful"));
        assert!(with_fb.contains("be more careful"));
    }

    #[test]
    fn feedback_reruns_say_revise_dont_restart() {
        let prior = StageArtifact {
            kind: ArtifactKind::Plan,
            text: "Step 1".into(),
            payload: None,
            refs_worktree: false,
        };
        // With feedback: the prompt warns the previous attempt may still be in
        // the workspace and asks for a revision, not a restart.
        let with_fb = user_input_for("implement", "Build Y", &prior, Some("fix it"));
        assert!(with_fb.contains("revise them rather than starting over"));
        // Without feedback: no such line.
        let without = user_input_for("implement", "Build Y", &prior, None);
        assert!(!without.contains("revise them rather than starting over"));
    }
}

#[cfg(test)]
mod direct_schema_tests {
    use crate::db::Db;
    use tempfile::NamedTempFile;

    fn test_db() -> Db {
        let tmp = NamedTempFile::new().unwrap();
        Db::open(tmp.path()).unwrap()
    }

    #[test]
    fn new_tables_exist() {
        let db = test_db();
        let conn = db.conn_ref();
        for table in ["pipelines", "pipeline_stages", "runs", "run_stages", "run_events"] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "table {table} should exist");
        }
    }
}

#[cfg(test)]
mod pipeline_crud_tests {
    use crate::db::Db;
    use tempfile::NamedTempFile;

    fn test_db() -> Db {
        let tmp = NamedTempFile::new().unwrap();
        Db::open(tmp.path()).unwrap()
    }

    fn draft(role: &str) -> crate::db::StageDraft {
        crate::db::StageDraft {
            role: role.into(), agent_model: "claude-haiku-4-5".into(), substrate: "api".into(),
            checkpoint: false, loop_target_position: None, loop_max_iterations: 0, loop_mode: None,
        }
    }

    #[test]
    fn seed_is_idempotent_and_lists_three() {
        let db = test_db();
        db.seed_builtin_pipelines().unwrap();
        db.seed_builtin_pipelines().unwrap(); // second call must not duplicate
        let pipelines = db.list_pipelines().unwrap();
        assert_eq!(pipelines.len(), 4);

        let feature = pipelines.iter().find(|p| p.name == "Feature Factory").unwrap();
        let stages = db.get_pipeline_stages(&feature.id).unwrap();
        assert_eq!(stages.len(), 5);
        assert_eq!(stages[0].position, 0);
        assert_eq!(stages[0].role, "plan");
        // implement/code_review/test default to checkpoint=on, plan/plan_review off.
        let implement = stages.iter().find(|s| s.role == "implement").unwrap();
        assert!(implement.checkpoint);
        let plan = stages.iter().find(|s| s.role == "plan").unwrap();
        assert!(!plan.checkpoint);
    }

    #[test]
    fn validate_pipeline_stages_enforces_roles_substrates_and_loop_contract() {
        use crate::db::validate_pipeline_stages;
        // valid linear pipeline
        assert!(validate_pipeline_stages(&[draft("plan"), draft("implement")]).is_ok());
        // empty pipeline / unknown role / bad substrate / empty model
        assert!(validate_pipeline_stages(&[]).is_err());
        assert!(validate_pipeline_stages(&[draft("dance")]).is_err());
        let mut bad_sub = draft("plan"); bad_sub.substrate = "ftp".into();
        assert!(validate_pipeline_stages(&[bad_sub]).is_err());
        let mut no_model = draft("plan"); no_model.agent_model = "".into();
        assert!(validate_pipeline_stages(&[no_model]).is_err());

        // valid gated loop: code_review at index 1 loops back to 0
        let mut review = draft("code_review");
        review.loop_target_position = Some(0); review.loop_max_iterations = 2; review.loop_mode = Some("gated".into());
        assert!(validate_pipeline_stages(&[draft("implement"), review.clone()]).is_ok());

        // loop on a non-review role
        let mut looped_impl = draft("implement");
        looped_impl.loop_target_position = Some(0); looped_impl.loop_max_iterations = 2; looped_impl.loop_mode = Some("gated".into());
        assert!(validate_pipeline_stages(&[draft("plan"), looped_impl]).is_err());
        // target not strictly earlier (self)
        let mut self_loop = review.clone(); self_loop.loop_target_position = Some(1);
        assert!(validate_pipeline_stages(&[draft("implement"), self_loop]).is_err());
        // target out of range
        let mut far = review.clone(); far.loop_target_position = Some(5);
        assert!(validate_pipeline_stages(&[draft("implement"), far]).is_err());
        // max 0 with a target / bad mode
        let mut zero = review.clone(); zero.loop_max_iterations = 0;
        assert!(validate_pipeline_stages(&[draft("implement"), zero]).is_err());
        let mut mode = review.clone(); mode.loop_mode = Some("magic".into());
        assert!(validate_pipeline_stages(&[draft("implement"), mode]).is_err());
        // no target but leftover loop fields → invalid (builder must normalize)
        let mut leftover = draft("code_review"); leftover.loop_max_iterations = 2;
        assert!(validate_pipeline_stages(&[draft("implement"), leftover]).is_err());
    }

    #[test]
    fn save_pipeline_creates_forks_builtins_and_updates_customs() {
        let db = test_db();
        db.seed_builtin_pipelines().unwrap();
        let ff = db.list_pipelines().unwrap().into_iter().find(|p| p.name == "Feature Factory").unwrap();
        let ff_stages_before = db.get_pipeline_stages(&ff.id).unwrap();

        // CREATE: no id → new custom pipeline.
        let created = db.save_pipeline(None, "Mine", "d", &[draft("plan"), draft("implement")]).unwrap();
        let mine = db.list_pipelines().unwrap().into_iter().find(|p| p.id == created).unwrap();
        assert!(!mine.is_builtin);
        assert_eq!(db.get_pipeline_stages(&created).unwrap().len(), 2);

        // FORK: saving a builtin returns a NEW id; the builtin is untouched.
        let forked = db.save_pipeline(Some(ff.id.clone()), "Feature Factory (custom)", "my copy", &[draft("plan")]).unwrap();
        assert_ne!(forked, ff.id);
        let ff_stages_after = db.get_pipeline_stages(&ff.id).unwrap();
        assert_eq!(ff_stages_before.len(), ff_stages_after.len()); // builtin intact
        assert_eq!(db.get_pipeline_stages(&forked).unwrap().len(), 1);
        assert!(!db.list_pipelines().unwrap().iter().find(|p| p.id == forked).unwrap().is_builtin);

        // UPDATE: saving a custom updates in place (same id, replaced stages + meta).
        let updated = db.save_pipeline(Some(created.clone()), "Mine v2", "d2", &[draft("plan"), draft("implement"), draft("test")]).unwrap();
        assert_eq!(updated, created);
        let row = db.list_pipelines().unwrap().into_iter().find(|p| p.id == created).unwrap();
        assert_eq!(row.name, "Mine v2");
        assert_eq!(db.get_pipeline_stages(&created).unwrap().len(), 3);

        // INVALID draft → error AND the custom's prior stages survive (transactional).
        let err = db.save_pipeline(Some(created.clone()), "Mine v3", "d3", &[draft("dance")]);
        assert!(err.is_err());
        assert_eq!(db.get_pipeline_stages(&created).unwrap().len(), 3); // unchanged
        assert_eq!(db.list_pipelines().unwrap().into_iter().find(|p| p.id == created).unwrap().name, "Mine v2");

        // Unknown id → error.
        assert!(db.save_pipeline(Some("nope".into()), "x", "d", &[draft("plan")]).is_err());
        // Empty name → error.
        assert!(db.save_pipeline(None, "   ", "d", &[draft("plan")]).is_err());
    }

    #[test]
    fn delete_pipeline_rejects_builtins_and_removes_customs_with_stages() {
        let db = test_db();
        db.seed_builtin_pipelines().unwrap();
        let ff = db.list_pipelines().unwrap().into_iter().find(|p| p.name == "Feature Factory").unwrap();
        assert!(db.delete_pipeline(&ff.id).is_err()); // builtin protected

        let id = db.save_pipeline(None, "Mine", "d", &[draft("plan")]).unwrap();
        db.delete_pipeline(&id).unwrap();
        assert!(db.list_pipelines().unwrap().iter().all(|p| p.id != id));
        assert!(db.get_pipeline_stages(&id).unwrap().is_empty()); // stages gone too
    }
}

#[cfg(test)]
mod run_crud_tests {
    use crate::db::Db;
    use tempfile::NamedTempFile;

    fn test_db() -> Db {
        let tmp = NamedTempFile::new().unwrap();
        Db::open(tmp.path()).unwrap()
    }

    // Minimal project+workspace so the runs FK is satisfied.
    fn seed_workspace(db: &Db) -> String {
        let now = chrono::Utc::now().to_rfc3339();
        db.conn_ref()
            .execute(
                "INSERT INTO projects (id,name,path,created_at,last_opened) VALUES ('p1','P','/tmp/p',?1,?1)",
                [&now],
            )
            .unwrap();
        db.conn_ref()
            .execute(
                "INSERT INTO workspaces (id,project_id,name,branch,created_at,last_active)
                 VALUES ('w1','p1','W','main',?1,?1)",
                [&now],
            )
            .unwrap();
        "w1".to_string()
    }

    #[test]
    fn create_run_copies_stages_and_lists() {
        let db = test_db();
        let ws = seed_workspace(&db);
        db.seed_builtin_pipelines().unwrap();
        let pipelines = db.list_pipelines().unwrap();
        let ff = pipelines.iter().find(|p| p.name == "Feature Factory").unwrap();

        let run_id = db
            .create_run(&ws, &ff.id, "build the thing", Some("claude-opus-4-6"), None, &[])
            .unwrap();

        let run = db.get_run(&run_id).unwrap().unwrap();
        assert_eq!(run.status, "draft");
        assert_eq!(run.task, "build the thing");

        let stages = db.list_run_stages(&run_id).unwrap();
        assert_eq!(stages.len(), 5);
        assert_eq!(stages[0].status, "pending");

        let runs = db.list_runs(&ws).unwrap();
        assert_eq!(runs.len(), 1);
    }

    #[test]
    fn complete_stage_persists_outcome_and_status() {
        let db = test_db();
        let ws = seed_workspace(&db);
        db.seed_builtin_pipelines().unwrap();
        let ff = db.list_pipelines().unwrap().into_iter().find(|p| p.name == "Feature Factory").unwrap();
        let run_id = db.create_run(&ws, &ff.id, "t", None, None, &[]).unwrap();
        let stages = db.list_run_stages(&run_id).unwrap();
        let first = &stages[0];

        db.complete_run_stage(&first.id, "done", 100, 20, 0.5, Some("{\"kind\":\"plan\",\"text\":\"x\"}"))
            .unwrap();
        let reloaded = db.list_run_stages(&run_id).unwrap();
        assert_eq!(reloaded[0].status, "done");
        assert_eq!(reloaded[0].input_tokens, 100);
        assert!((reloaded[0].cost_usd - 0.5).abs() < 1e-9);

        db.set_run_status(&run_id, "completed", true).unwrap();
        assert_eq!(db.get_run(&run_id).unwrap().unwrap().status, "completed");
    }

    #[test]
    fn create_run_rejects_unknown_pipeline() {
        let db = test_db();
        let ws = seed_workspace(&db);
        let err = db.create_run(&ws, "no-such-pipeline", "t", None, None, &[]);
        assert!(err.is_err());
    }

    #[test]
    fn create_run_applies_stage_model_overrides() {
        let db = test_db();
        let ws = seed_workspace(&db);
        db.seed_builtin_pipelines().unwrap();
        let ff = db.list_pipelines().unwrap().into_iter().find(|p| p.name == "Feature Factory").unwrap();
        let overrides = vec![(2_i64, "claude-opus-4-6".to_string())];
        let run_id = db.create_run(&ws, &ff.id, "t", None, None, &overrides).unwrap();
        let stages = db.list_run_stages(&run_id).unwrap();
        let implement = stages.iter().find(|s| s.position == 2).unwrap();
        assert_eq!(implement.agent_model, "claude-opus-4-6");
        let plan = stages.iter().find(|s| s.position == 0).unwrap();
        assert_ne!(plan.agent_model, "claude-opus-4-6");
    }

    #[test]
    fn pipeline_stage_loop_config_roundtrips() {
        let db = test_db();
        let pid = db.insert_pipeline("P", "d", false).unwrap();
        db.insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None).unwrap();
        db.insert_pipeline_stage(&pid, 1, "code_review", "m", "api", true, Some(0), 2, Some("gated")).unwrap();
        let stages = db.get_pipeline_stages(&pid).unwrap();
        assert_eq!(stages[0].loop_target_position, None);
        assert_eq!(stages[0].loop_max_iterations, 0);
        assert_eq!(stages[0].loop_mode, None);
        assert_eq!(stages[1].loop_target_position, Some(0));
        assert_eq!(stages[1].loop_max_iterations, 2);
        assert_eq!(stages[1].loop_mode.as_deref(), Some("gated"));
    }

    #[test]
    fn create_run_copies_loop_config_and_counter_increments() {
        let db = test_db();
        let ws = seed_workspace(&db);
        let pid = db.insert_pipeline("P", "d", false).unwrap();
        db.insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None).unwrap();
        db.insert_pipeline_stage(&pid, 1, "code_review", "m", "api", true, Some(0), 2, Some("gated")).unwrap();
        let run = db.create_run(&ws, &pid, "t", None, None, &[]).unwrap();

        let stages = db.list_run_stages(&run).unwrap();
        assert_eq!(stages[1].loop_target_position, Some(0));
        assert_eq!(stages[1].loop_max_iterations, 2);
        assert_eq!(stages[1].loop_mode.as_deref(), Some("gated"));
        assert_eq!(stages[1].loop_iterations, 0);

        db.increment_loop_iteration(&stages[1].id).unwrap();
        let after = db.list_run_stages(&run).unwrap();
        assert_eq!(after[1].loop_iterations, 1);
    }

    #[test]
    fn retire_stage_cost_accumulates_on_the_run() {
        let db = test_db();
        let ws = seed_workspace(&db);
        let pid = db.insert_pipeline("P", "d", false).unwrap();
        db.insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None).unwrap();
        let run = db.create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        assert_eq!(db.get_retired_cost(&run).unwrap(), (0.0, 0, 0));

        db.retire_stage_cost(&run, 0.5, 100, 40).unwrap();
        db.retire_stage_cost(&run, 0.25, 50, 10).unwrap();
        let (cost, inp, out) = db.get_retired_cost(&run).unwrap();
        assert!((cost - 0.75).abs() < 1e-9);
        assert_eq!(inp, 150);
        assert_eq!(out, 50);
    }

    #[test]
    fn builtins_seed_gated_loop_on_review_stages() {
        let db = test_db();
        db.seed_builtin_pipelines().unwrap();
        let ff = db.list_pipelines().unwrap().into_iter().find(|p| p.name == "Feature Factory").unwrap();
        let stages = db.get_pipeline_stages(&ff.id).unwrap();
        let cr = stages.iter().find(|s| s.role == "code_review").unwrap();
        assert_eq!(cr.loop_target_position, Some(2));        // back to implement
        assert_eq!(cr.loop_max_iterations, 2);
        assert_eq!(cr.loop_mode.as_deref(), Some("gated"));
        // A non-review stage stays linear.
        let imp = stages.iter().find(|s| s.role == "implement").unwrap();
        assert_eq!(imp.loop_target_position, None);
    }

    #[test]
    fn backfill_sets_loop_on_pre_existing_builtin_review_stages() {
        let db = test_db();
        // Simulate an old install: seed a builtin-shaped pipeline with NO loop config.
        let pid = db.insert_pipeline("Feature Factory", "d", true).unwrap();
        db.insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None).unwrap();
        db.insert_pipeline_stage(&pid, 1, "implement", "m", "api", true, None, 0, None).unwrap();
        db.insert_pipeline_stage(&pid, 2, "code_review", "m", "api", true, None, 0, None).unwrap();
        // Running the seeder backfills the review stage (seeding itself is skipped — name exists).
        db.seed_builtin_pipelines().unwrap();
        let stages = db.get_pipeline_stages(&pid).unwrap();
        let cr = stages.iter().find(|s| s.role == "code_review").unwrap();
        assert_eq!(cr.loop_target_position, Some(1));
        assert_eq!(cr.loop_mode.as_deref(), Some("gated"));
    }
}

#[cfg(test)]
mod orchestrator_tests {
    use crate::db::Db;
    use crate::orchestrator::events::EventSink;
    use crate::orchestrator::runner::{AgentRunner, StageContext};
    use crate::orchestrator::types::*;
    use crate::orchestrator::Orchestrator;
    use parking_lot::Mutex;
    use serde_json::Value;
    use std::sync::Arc;
    use tempfile::NamedTempFile;

    struct CollectingSink {
        events: Mutex<Vec<String>>,
    }
    impl EventSink for CollectingSink {
        fn emit(&self, event: &str, _payload: Value) {
            self.events.lock().push(event.to_string());
        }
    }

    /// A runner that always succeeds with a canned artifact.
    struct MockRunner;
    #[async_trait::async_trait]
    impl AgentRunner for MockRunner {
        async fn run(
            &self,
            stage: &StageSpec,
            _input: &StageArtifact,
            _ctx: &StageContext,
        ) -> crate::error::AppResult<StageOutcome> {
            Ok(StageOutcome {
                artifact: StageArtifact {
                    kind: ArtifactKind::Note,
                    text: format!("did {}", stage.role),
                    payload: None,
                    refs_worktree: false,
                },
                input_tokens: 10,
                output_tokens: 2,
                cost_usd: 0.01,
                status: StageStatus::Done,
                tool_calls: vec![],
                error: None,
                verdict: None,
            })
        }
    }

    fn db_with_workspace() -> (Arc<Mutex<Db>>, String) {
        let tmp = NamedTempFile::new().unwrap();
        let db = Db::open(tmp.path()).unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        db.conn_ref().execute(
            "INSERT INTO projects (id,name,path,created_at,last_opened) VALUES ('p1','P','/tmp/p',?1,?1)",
            [&now]).unwrap();
        db.conn_ref().execute(
            "INSERT INTO workspaces (id,project_id,name,branch,worktree_path,created_at,last_active)
             VALUES ('w1','p1','W','main','/tmp',?1,?1)", [&now]).unwrap();
        db.seed_builtin_pipelines().unwrap();
        (Arc::new(Mutex::new(db)), "w1".to_string())
    }

    #[tokio::test]
    async fn run_pauses_at_first_checkpoint_then_completes() {
        let (db, ws) = db_with_workspace();
        let ff = db.lock().list_pipelines().unwrap().into_iter()
            .find(|p| p.name == "Feature Factory").unwrap();
        let run_id = db.lock().create_run(&ws, &ff.id, "build it", None, None, &[]).unwrap();

        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(
            Arc::clone(&db),
            sink.clone(),
            Box::new(MockRunner),
        );

        // Drive to the first pause. Feature Factory: plan(no cp), plan_review(no cp),
        // implement(cp) -> should pause after implement.
        let status = orch.run_to_pause(&run_id).await.unwrap();
        assert_eq!(status, RunStatus::Paused);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "done");           // plan
        assert_eq!(stages[1].status, "done");           // plan_review
        assert_eq!(stages[2].status, "awaiting_checkpoint"); // implement
        assert_eq!(stages[3].status, "pending");        // code_review

        // Approve the implement checkpoint -> runs code_review, pauses there (cp on).
        let status = orch
            .resolve_checkpoint(&run_id, CheckpointAction::Approve)
            .await
            .unwrap();
        assert_eq!(status, RunStatus::Paused);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[2].status, "done");
        assert_eq!(stages[3].status, "awaiting_checkpoint"); // code_review

        // Approve code_review -> test pauses (cp on).
        orch.resolve_checkpoint(&run_id, CheckpointAction::Approve).await.unwrap();
        // Approve test (last stage) -> completed.
        let status = orch.resolve_checkpoint(&run_id, CheckpointAction::Approve).await.unwrap();
        assert_eq!(status, RunStatus::Completed);
        assert_eq!(db.lock().get_run(&run_id).unwrap().unwrap().status, "completed");

        // Cost accumulated across 5 stages * 0.01.
        let run = db.lock().get_run(&run_id).unwrap().unwrap();
        assert!((run.cost_usd - 0.05).abs() < 1e-6);
    }

    #[tokio::test]
    async fn reject_reruns_same_stage() {
        let (db, ws) = db_with_workspace();
        let pr = db.lock().list_pipelines().unwrap().into_iter()
            .find(|p| p.name == "Plan & review").unwrap();
        let run_id = db.lock().create_run(&ws, &pr.id, "think", None, None, &[]).unwrap();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));

        // plan(no cp), critique(no cp), refine(cp) -> pause at refine.
        let status = orch.run_to_pause(&run_id).await.unwrap();
        assert_eq!(status, RunStatus::Paused);
        // Reject refine with feedback -> it returns to pending, then re-runs and pauses again.
        let status = orch.resolve_checkpoint(&run_id, CheckpointAction::Reject {
            feedback: Some("tighten it".into()),
            model_override: None,
        }).await.unwrap();
        assert_eq!(status, RunStatus::Paused);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[2].role, "refine");
        assert_eq!(stages[2].status, "awaiting_checkpoint"); // re-ran, awaiting again
        assert_eq!(stages[2].feedback.as_deref(), Some("tighten it"));
    }

    #[tokio::test]
    async fn abort_stops_the_run() {
        let (db, ws) = db_with_workspace();
        let ff = db.lock().list_pipelines().unwrap().into_iter()
            .find(|p| p.name == "Feature Factory").unwrap();
        let run_id = db.lock().create_run(&ws, &ff.id, "x", None, None, &[]).unwrap();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));
        orch.run_to_pause(&run_id).await.unwrap();
        let status = orch.resolve_checkpoint(&run_id, CheckpointAction::Abort).await.unwrap();
        assert_eq!(status, RunStatus::Aborted);
        assert_eq!(db.lock().get_run(&run_id).unwrap().unwrap().status, "aborted");
    }

    /// A runner that always returns a hard Err (simulates CliRunnerUnavailable / unresolved model).
    struct FailingRunner;
    #[async_trait::async_trait]
    impl AgentRunner for FailingRunner {
        async fn run(
            &self,
            _stage: &StageSpec,
            _input: &StageArtifact,
            _ctx: &StageContext,
        ) -> crate::error::AppResult<StageOutcome> {
            Err(crate::error::AppError::Other("boom".into()))
        }
    }

    #[tokio::test]
    async fn hard_runner_error_converges_to_failed_and_paused() {
        let (db, ws) = db_with_workspace();
        let ff = db.lock().list_pipelines().unwrap().into_iter()
            .find(|p| p.name == "Feature Factory").unwrap();
        let run_id = db.lock().create_run(&ws, &ff.id, "x", None, None, &[]).unwrap();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(FailingRunner));

        // The first stage's runner errors hard. The run must NOT bubble an Err; it must
        // pause with the stage marked failed (recoverable), never stuck in "running".
        let status = orch.run_to_pause(&run_id).await.unwrap();
        assert_eq!(status, RunStatus::Paused);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "failed");
        assert!(stages[0].error.is_some());
        assert_eq!(db.lock().get_run(&run_id).unwrap().unwrap().status, "paused");
    }

    #[tokio::test]
    async fn redriving_a_paused_run_keeps_it_paused() {
        let (db, ws) = db_with_workspace();
        let ff = db.lock().list_pipelines().unwrap().into_iter()
            .find(|p| p.name == "Feature Factory").unwrap();
        let run_id = db.lock().create_run(&ws, &ff.id, "x", None, None, &[]).unwrap();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));

        // First drive: pauses at the implement checkpoint, run status = paused.
        orch.run_to_pause(&run_id).await.unwrap();
        assert_eq!(db.lock().get_run(&run_id).unwrap().unwrap().status, "paused");

        // Re-drive without resolving the checkpoint (simulates start_run on a paused run).
        // It must return Paused AND leave the persisted run status as "paused", not "running".
        let status = orch.run_to_pause(&run_id).await.unwrap();
        assert_eq!(status, RunStatus::Paused);
        assert_eq!(db.lock().get_run(&run_id).unwrap().unwrap().status, "paused");
    }

    #[tokio::test]
    async fn start_run_on_completed_run_is_noop() {
        let (db, ws) = db_with_workspace();
        let ff = db.lock().list_pipelines().unwrap().into_iter().find(|p| p.name == "Plan & review").unwrap();
        let run_id = db.lock().create_run(&ws, &ff.id, "x", None, None, &[]).unwrap();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));
        // Drive to completion (Plan & review: plan,critique no-cp; refine cp -> approve).
        orch.run_to_pause(&run_id).await.unwrap();
        orch.resolve_checkpoint(&run_id, CheckpointAction::Approve).await.unwrap();
        assert_eq!(db.lock().get_run(&run_id).unwrap().unwrap().status, "completed");
        // Re-driving a completed run must be a no-op (still completed, no re-run).
        let status = orch.run_to_pause(&run_id).await.unwrap();
        assert_eq!(status, RunStatus::Completed);
    }

    /// (orch, run_id, db) for a pipeline: implement(pos 0, no loop) ->
    /// code_review(pos 1, gated loop back to 0, cap = `max_iter`).
    fn looped_run(max_iter: i64) -> (Orchestrator, String, Arc<Mutex<Db>>) {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("Looped", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "code_review", "m", "api", false, Some(0), max_iter, Some("gated")).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));
        (orch, run_id, db)
    }

    #[tokio::test]
    async fn gated_loop_review_stage_pauses_for_checkpoint() {
        let (orch, run_id, db) = looped_run(2);
        let status = orch.run_to_pause(&run_id).await.unwrap();
        assert_eq!(status, RunStatus::Paused);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "done");                  // implement
        assert_eq!(stages[1].status, "awaiting_checkpoint");   // code_review parked (gated loop)
    }

    #[tokio::test]
    async fn send_back_resets_range_increments_and_retires_cost() {
        let (orch, run_id, db) = looped_run(2);
        orch.run_to_pause(&run_id).await.unwrap();

        let before = db.lock().list_run_stages(&run_id).unwrap();
        let review_id = before[1].id.clone();
        let spent_before = db.lock().get_run(&run_id).unwrap().unwrap().cost_usd;

        let status = orch.resolve_checkpoint(
            &run_id,
            CheckpointAction::SendBack { feedback: Some("fix the bug".into()) },
        ).await.unwrap();

        let after = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(status, RunStatus::Paused);
        assert_eq!(after[1].status, "awaiting_checkpoint");
        let review = after.iter().find(|s| s.id == review_id).unwrap();
        assert_eq!(review.loop_iterations, 1);
        // D3: the target receives the review findings + the director's note.
        assert_eq!(
            after[0].feedback.as_deref(),
            Some("did code_review\n\nDirector's note: fix the bug"),
        );
        let spent_after = db.lock().get_run(&run_id).unwrap().unwrap().cost_usd;
        assert!(spent_after + 1e-9 >= spent_before);
    }

    #[tokio::test]
    async fn send_back_at_cap_does_not_loop() {
        let (orch, run_id, db) = looped_run(1);
        orch.run_to_pause(&run_id).await.unwrap();
        orch.resolve_checkpoint(&run_id, CheckpointAction::SendBack { feedback: None }).await.unwrap();
        let status = orch.resolve_checkpoint(&run_id, CheckpointAction::SendBack { feedback: None }).await.unwrap();
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[1].status, "done");
        assert_eq!(status, RunStatus::Completed);
    }

    #[tokio::test]
    async fn send_back_on_failed_review_is_noop() {
        let (orch, run_id, db) = looped_run(2);
        orch.run_to_pause(&run_id).await.unwrap();
        // Force the parked review stage into 'failed' instead of awaiting_checkpoint.
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        let review_id = stages[1].id.clone();
        db.lock().fail_run_stage(&review_id, "boom").unwrap();
        // SendBack must NOT loop-back a failed stage.
        orch.resolve_checkpoint(&run_id, CheckpointAction::SendBack { feedback: Some("x".into()) }).await.unwrap();
        let after = db.lock().list_run_stages(&run_id).unwrap();
        let review = after.iter().find(|s| s.id == review_id).unwrap();
        assert_eq!(review.status, "failed");   // unchanged — not looped, not approved
        assert_eq!(review.loop_iterations, 0); // no iteration burned
        assert_eq!(after[0].feedback, None);   // target stage not reset/feedback'd
    }

    #[tokio::test]
    async fn loop_back_archives_each_attempt_with_ordinals() {
        let (orch, run_id, db) = looped_run(2);
        orch.run_to_pause(&run_id).await.unwrap();
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        let (impl_id, review_id) = (stages[0].id.clone(), stages[1].id.clone());

        orch.resolve_checkpoint(
            &run_id,
            CheckpointAction::SendBack { feedback: Some("polish".into()) },
        ).await.unwrap();

        // Both reset stages were snapshotted before the wipe.
        let impl_iters = db.lock().list_stage_iterations(&impl_id).unwrap();
        assert_eq!(impl_iters.len(), 1);
        assert_eq!(impl_iters[0].iteration, 1);
        assert_eq!(impl_iters[0].status, "done");
        assert!(impl_iters[0].artifact.as_deref().unwrap().contains("did implement"));
        // The feedback that closed the attempt lives on the review row only.
        assert_eq!(impl_iters[0].closing_feedback, None);
        let rev_iters = db.lock().list_stage_iterations(&review_id).unwrap();
        assert_eq!(rev_iters.len(), 1);
        assert!(rev_iters[0].closing_feedback.is_some());

        // Second loop-back → ordinal 2.
        orch.resolve_checkpoint(&run_id, CheckpointAction::SendBack { feedback: None })
            .await.unwrap();
        let impl_iters = db.lock().list_stage_iterations(&impl_id).unwrap();
        assert_eq!(impl_iters.len(), 2);
        assert_eq!(impl_iters[1].iteration, 2);
    }

    #[tokio::test]
    async fn loop_back_does_not_archive_stages_without_an_attempt() {
        let (orch, run_id, db) = looped_run(2);
        orch.run_to_pause(&run_id).await.unwrap();
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        let impl_id = stages[0].id.clone();
        // Wipe the implement stage's outcome so it looks unstarted (no artifact/error).
        db.lock().reset_run_stage(&impl_id, None, None).unwrap();

        orch.resolve_checkpoint(&run_id, CheckpointAction::SendBack { feedback: None })
            .await.unwrap();

        // The artifactless stage was reset but never archived; its re-run is
        // attempt #1 when it eventually loops again.
        let from_first_loop: Vec<_> = db.lock().list_stage_iterations(&impl_id).unwrap()
            .into_iter().filter(|i| i.iteration == 1).collect();
        assert!(from_first_loop.is_empty(), "pending stage must not be archived");
    }

    #[tokio::test]
    async fn reject_archives_the_prior_attempt() {
        let (db, ws) = db_with_workspace();
        let pr = db.lock().list_pipelines().unwrap().into_iter()
            .find(|p| p.name == "Plan & review").unwrap();
        let run_id = db.lock().create_run(&ws, &pr.id, "think", None, None, &[]).unwrap();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));

        // plan, critique (no cp), refine (cp) -> pause at refine.
        orch.run_to_pause(&run_id).await.unwrap();
        let refine_id = db.lock().list_run_stages(&run_id).unwrap()[2].id.clone();
        orch.resolve_checkpoint(&run_id, CheckpointAction::Reject {
            feedback: Some("tighten it".into()),
            model_override: None,
        }).await.unwrap();

        let iters = db.lock().list_stage_iterations(&refine_id).unwrap();
        assert_eq!(iters.len(), 1);
        assert_eq!(iters[0].iteration, 1);
        assert!(iters[0].artifact.as_deref().unwrap().contains("did refine"));
        assert_eq!(iters[0].closing_feedback.as_deref(), Some("tighten it"));
    }

    #[tokio::test]
    async fn send_back_composes_findings_and_directors_note() {
        let (orch, run_id, db) = looped_run(3);
        orch.run_to_pause(&run_id).await.unwrap();
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        let (impl_id, review_id) = (stages[0].id.clone(), stages[1].id.clone());

        // Findings + note → both, joined by the Director's note marker.
        orch.resolve_checkpoint(
            &run_id,
            CheckpointAction::SendBack { feedback: Some("fix the bug".into()) },
        ).await.unwrap();
        // The composed feedback reached the target's feedback column. The target
        // has already re-run by now (feedback is consumed by the re-run), so read
        // it from the archived attempt's review row instead.
        let rev_iters = db.lock().list_stage_iterations(&review_id).unwrap();
        assert_eq!(
            rev_iters[0].closing_feedback.as_deref(),
            Some("did code_review\n\nDirector's note: fix the bug"),
        );
        // The re-run target consumed the same composed feedback.
        let impl_iters = db.lock().list_stage_iterations(&impl_id).unwrap();
        assert_eq!(impl_iters.len(), 1);

        // Findings alone when the note is empty.
        orch.resolve_checkpoint(&run_id, CheckpointAction::SendBack { feedback: None })
            .await.unwrap();
        let rev_iters = db.lock().list_stage_iterations(&review_id).unwrap();
        assert_eq!(rev_iters[1].closing_feedback.as_deref(), Some("did code_review"));

        // Note alone when the review somehow has no artifact.
        db.lock().conn_ref().execute(
            "UPDATE run_stages SET artifact = NULL WHERE id = ?1",
            [&review_id],
        ).unwrap();
        orch.resolve_checkpoint(
            &run_id,
            CheckpointAction::SendBack { feedback: Some("just a note".into()) },
        ).await.unwrap();
        // The third loop-back's target feedback is the bare note (it survives on
        // the row until the next reset), and the artifact-less review row was
        // not archived again (no attempt content to snapshot).
        let after = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(after[0].feedback.as_deref(), Some("just a note"));
        let impl_iters = db.lock().list_stage_iterations(&impl_id).unwrap();
        assert_eq!(impl_iters.len(), 3);
        let rev_iters = db.lock().list_stage_iterations(&review_id).unwrap();
        assert_eq!(rev_iters.len(), 2);
    }

    /// The target's feedback column receives the composed findings+note before
    /// the re-run starts (checked mid-flight via the archive-free path: a fresh
    /// loop with no auto-drive). Uses loop_back's persisted effect directly.
    #[tokio::test]
    async fn send_back_target_feedback_column_gets_composed_findings() {
        let (orch, run_id, db) = looped_run(1);
        orch.run_to_pause(&run_id).await.unwrap();
        // Stop the re-drive from consuming the feedback: abort the run after
        // the loop-back by checking the column straight after resolve starts is
        // racy — instead mark the run aborted so resolve_checkpoint's re-drive
        // is a no-op and the pending target keeps its feedback.
        db.lock().set_run_status(&run_id, "aborted", true).unwrap();
        orch.resolve_checkpoint(
            &run_id,
            CheckpointAction::SendBack { feedback: Some("polish".into()) },
        ).await.unwrap();
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(
            stages[0].feedback.as_deref(),
            Some("did code_review\n\nDirector's note: polish"),
        );
        assert_eq!(stages[0].status, "pending"); // reset, not re-run (aborted)
    }

    /// A runner whose review-role output carries a verdict; everything else Done.
    struct VerdictRunner { verdict: &'static str } // "PASS" | "CHANGES_REQUESTED" | "" (none)
    #[async_trait::async_trait]
    impl AgentRunner for VerdictRunner {
        async fn run(&self, stage: &StageSpec, _i: &StageArtifact, _c: &StageContext)
            -> crate::error::AppResult<StageOutcome> {
            let is_review = matches!(stage.role.as_str(), "code_review" | "verify");
            let text = if is_review && !self.verdict.is_empty() { format!("findings\nVERDICT: {}", self.verdict) } else { "did it".into() };
            Ok(StageOutcome {
                artifact: StageArtifact { kind: ArtifactKind::Note, text: text.clone(), payload: None, refs_worktree: false },
                input_tokens: 10, output_tokens: 2, cost_usd: 0.01,
                status: StageStatus::Done, tool_calls: vec![],
                error: None,
                verdict: crate::orchestrator::runner::parse_verdict(&text),
            })
        }
    }

    fn auto_run(verdict: &'static str, max_iter: i64) -> (Orchestrator, String, Arc<Mutex<Db>>) {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("Auto", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "code_review", "m", "api", false, Some(0), max_iter, Some("auto")).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(VerdictRunner { verdict }));
        (orch, run_id, db)
    }

    #[tokio::test]
    async fn auto_pass_completes_without_pausing() {
        let (orch, run_id, db) = auto_run("PASS", 2);
        let status = orch.run_to_pause(&run_id).await.unwrap();
        assert_eq!(status, RunStatus::Completed);
        assert_eq!(db.lock().list_run_stages(&run_id).unwrap()[1].status, "done");
    }

    #[tokio::test]
    async fn auto_changes_requested_loops_until_cap_then_gates() {
        // Review always asks for changes; after `max_iter` auto loop-backs it stops
        // looping and gates for a human (awaiting_checkpoint), never infinite.
        let (orch, run_id, db) = auto_run("CHANGES_REQUESTED", 2);
        let status = orch.run_to_pause(&run_id).await.unwrap();
        assert_eq!(status, RunStatus::Paused);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[1].status, "awaiting_checkpoint");
        assert_eq!(stages[1].loop_iterations, 2); // looped exactly `max_iter` times
    }

    #[tokio::test]
    async fn auto_unparseable_verdict_gates_instead_of_looping() {
        let (orch, run_id, db) = auto_run("", 2); // no VERDICT line
        let status = orch.run_to_pause(&run_id).await.unwrap();
        assert_eq!(status, RunStatus::Paused);
        assert_eq!(db.lock().list_run_stages(&run_id).unwrap()[1].status, "awaiting_checkpoint");
        assert_eq!(db.lock().list_run_stages(&run_id).unwrap()[1].loop_iterations, 0);
    }

    /// A concurrent run in the same workspace must be detected and rejected.
    /// The run whose status is already `running` or `paused` blocks a new start.
    /// A `draft` run must NOT count. A run must never block itself.
    #[tokio::test]
    async fn has_concurrent_run_detects_another_executing_run_in_the_workspace() {
        let (db, ws) = db_with_workspace();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));

        // Create two runs in the same workspace.
        let pipelines = db.lock().list_pipelines().unwrap();
        let pipeline_id = pipelines.first().unwrap().id.clone();
        let run_a = db.lock().create_run(&ws, &pipeline_id, "task-a", None, None, &[]).unwrap();
        let run_b = db.lock().create_run(&ws, &pipeline_id, "task-b", None, None, &[]).unwrap();

        // Both start as `draft` — neither should block the other.
        assert!(!orch.has_concurrent_run(&run_a).await.unwrap());
        assert!(!orch.has_concurrent_run(&run_b).await.unwrap());

        // Transition run_a to `running`.
        db.lock().set_run_status(&run_a, "running", false).unwrap();

        // run_a must not block itself.
        assert!(!orch.has_concurrent_run(&run_a).await.unwrap());
        // run_b sees run_a running → concurrent run detected.
        assert!(orch.has_concurrent_run(&run_b).await.unwrap());

        // Transition run_a to `paused` — still executing, still blocks run_b.
        db.lock().set_run_status(&run_a, "paused", false).unwrap();
        assert!(orch.has_concurrent_run(&run_b).await.unwrap());

        // Transition run_a to `completed` — no longer executing, run_b is free.
        db.lock().set_run_status(&run_a, "completed", true).unwrap();
        assert!(!orch.has_concurrent_run(&run_b).await.unwrap());
    }
}

#[cfg(test)]
mod cli_runner_tests {
    use crate::orchestrator::cli_runner::parse_cli_result;
    use crate::orchestrator::types::{ArtifactKind, StageStatus};

    const SUCCESS: &str = r#"{
        "type":"result","subtype":"success","is_error":false,
        "result":"Implemented the feature.","total_cost_usd":0.0123,
        "usage":{"input_tokens":1200,"output_tokens":340,
                 "cache_read_input_tokens":800,"cache_creation_input_tokens":100}
    }"#;

    const ERRORED: &str = r#"{
        "type":"result","subtype":"error_max_budget_usd","is_error":true,
        "result":"Budget exceeded.","total_cost_usd":5.0,
        "usage":{"input_tokens":10,"output_tokens":0,
                 "cache_read_input_tokens":0,"cache_creation_input_tokens":0}
    }"#;

    #[test]
    fn parses_success_into_done_outcome() {
        let outcome = parse_cli_result(SUCCESS, true, "implement").unwrap();
        assert_eq!(outcome.status, StageStatus::Done);
        assert_eq!(outcome.artifact.text, "Implemented the feature.");
        assert_eq!(outcome.artifact.kind, ArtifactKind::Diff);
        assert!(outcome.artifact.refs_worktree);
        assert_eq!(outcome.input_tokens, 1200);
        assert_eq!(outcome.output_tokens, 340);
        assert!((outcome.cost_usd - 0.0123).abs() < 1e-9);
        assert!(outcome.error.is_none());
    }

    #[test]
    fn is_error_flag_yields_failed_outcome() {
        let outcome = parse_cli_result(ERRORED, true, "implement").unwrap();
        assert_eq!(outcome.status, StageStatus::Failed);
        assert_eq!(outcome.error.as_deref(), Some("Budget exceeded."));
    }

    #[test]
    fn nonzero_exit_yields_failed_even_if_json_ok() {
        let outcome = parse_cli_result(SUCCESS, false, "plan").unwrap();
        assert_eq!(outcome.status, StageStatus::Failed);
    }

    #[test]
    fn unparseable_output_is_an_error() {
        assert!(parse_cli_result("not json", true, "plan").is_err());
    }
}

#[cfg(test)]
mod cli_args_tests {
    use crate::orchestrator::cli_runner::build_cli_args;

    #[test]
    fn args_include_model_format_and_permission() {
        let args = build_cli_args("claude-sonnet-4-6", "You are a planner.");
        assert!(args.contains(&"-p".to_string()));
        let i = args.iter().position(|a| a == "--output-format").unwrap();
        assert_eq!(args[i + 1], "stream-json");
        // stream-json requires --verbose, else claude refuses to start.
        assert!(args.contains(&"--verbose".to_string()));
        let m = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[m + 1], "claude-sonnet-4-6");
        let s = args.iter().position(|a| a == "--append-system-prompt").unwrap();
        assert_eq!(args[s + 1], "You are a planner.");
        assert!(args.contains(&"--permission-mode".to_string()));
        assert!(args.contains(&"bypassPermissions".to_string()));
        assert!(args.contains(&"--max-turns".to_string()));
    }
}

#[cfg(test)]
mod cli_stream_tests {
    use crate::orchestrator::cli_runner::is_result_event;
    use serde_json::json;

    #[test]
    fn result_event_is_detected() {
        let v = json!({"type":"result","subtype":"success","result":"done","is_error":false});
        assert!(is_result_event(&v));
    }

    #[test]
    fn non_result_event_is_not_detected() {
        let v = json!({
            "type":"assistant",
            "message":{"content":[{"type":"text","text":"  Reading the codebase.  "}]}
        });
        assert!(!is_result_event(&v));
    }

    #[test]
    fn system_and_user_events_are_not_result() {
        assert!(!is_result_event(&json!({"type":"system","subtype":"init"})));
        assert!(!is_result_event(&json!({"type":"user","message":{"content":[]}})));
    }
}

#[cfg(test)]
mod cli_template_tests {
    use crate::db::Db;
    use tempfile::NamedTempFile;

    fn test_db() -> Db {
        let tmp = NamedTempFile::new().unwrap();
        Db::open(tmp.path()).unwrap()
    }

    #[test]
    fn seeds_a_cli_pipeline() {
        let db = test_db();
        db.seed_builtin_pipelines().unwrap();
        let p = db.list_pipelines().unwrap().into_iter()
            .find(|p| p.name == "Claude Code build").expect("CLI template seeded");
        let stages = db.get_pipeline_stages(&p.id).unwrap();
        let implement = stages.iter().find(|s| s.role == "implement").unwrap();
        assert_eq!(implement.substrate, "cli");
        assert!(implement.agent_model.contains("claude") || implement.agent_model == "sonnet");
        assert!(implement.checkpoint);
    }
}

#[cfg(test)]
mod verdict_tests {
    use crate::orchestrator::runner::parse_verdict;
    use crate::orchestrator::types::ReviewVerdict;

    #[test]
    fn parses_pass_and_changes_and_handles_noise() {
        assert_eq!(parse_verdict("looks good\nVERDICT: PASS"), Some(ReviewVerdict::Pass));
        assert_eq!(parse_verdict("issues found\nVERDICT: CHANGES_REQUESTED\n"), Some(ReviewVerdict::ChangesRequested));
        // last verdict line wins
        assert_eq!(parse_verdict("VERDICT: PASS\n...\nVERDICT: CHANGES_REQUESTED"), Some(ReviewVerdict::ChangesRequested));
        // case/space tolerant
        assert_eq!(parse_verdict("  verdict:  pass  "), Some(ReviewVerdict::Pass));
        // missing / malformed → None (caller gates)
        assert_eq!(parse_verdict("no verdict here"), None);
        assert_eq!(parse_verdict("VERDICT: maybe"), None);
    }

    #[test]
    fn parses_verdict_tolerates_case_trailing_text_and_spacing() {
        use crate::orchestrator::runner::parse_verdict;
        use crate::orchestrator::types::ReviewVerdict;
        assert_eq!(parse_verdict("Verdict: PASS (looks good)"), Some(ReviewVerdict::Pass));
        assert_eq!(parse_verdict("VERDICT: CHANGES_REQUESTED — see notes"), Some(ReviewVerdict::ChangesRequested));
        assert_eq!(parse_verdict("VERDICT : pass"), Some(ReviewVerdict::Pass));
        assert_eq!(parse_verdict("VERDICTS: not a verdict line"), None);
    }
}

#[cfg(test)]
mod cli_path_tests {
    use crate::orchestrator::cli_runner::{merge_path_dirs, resolve_executable};
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn merge_path_dirs_dedups_and_keeps_first_order_dropping_empties() {
        let merged = merge_path_dirs(&["/a:/b", "", "/b:/c", ":/a:"]);
        assert_eq!(merged, "/a:/b:/c");
    }

    #[test]
    fn resolve_executable_finds_a_binary_on_the_path() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("claude");
        std::fs::write(&bin, b"#!/bin/sh\n").unwrap();
        let mut perms = std::fs::metadata(&bin).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&bin, perms).unwrap();

        let path_env = format!("/nonexistent/xyz:{}", dir.path().display());
        let found = resolve_executable("claude", &path_env).expect("should find claude");
        assert_eq!(found, bin);

        assert!(resolve_executable("does-not-exist-xyz", &path_env).is_none());
    }

    #[test]
    fn parse_env0_splits_pairs_skips_dir_vars_and_keeps_multiline() {
        use crate::orchestrator::cli_runner::parse_env0;
        let raw = b"PATH=/a:/b\0ANTHROPIC_AUTH_TOKEN=sk-secret\0PWD=/should/skip\0MULTI=line1\nline2\0BAD_NO_EQUALS\0ANTHROPIC_BASE_URL=https://litellm.example/v1\0";
        let pairs = parse_env0(raw);
        let get = |k: &str| pairs.iter().find(|(kk, _)| kk == k).map(|(_, v)| v.clone());
        assert_eq!(get("PATH").as_deref(), Some("/a:/b"));
        assert_eq!(get("ANTHROPIC_AUTH_TOKEN").as_deref(), Some("sk-secret"));
        assert_eq!(get("ANTHROPIC_BASE_URL").as_deref(), Some("https://litellm.example/v1"));
        assert_eq!(get("MULTI").as_deref(), Some("line1\nline2"));   // multiline preserved
        assert_eq!(get("PWD"), None);                                 // cwd vars skipped
        assert!(pairs.iter().all(|(k, _)| k != "BAD_NO_EQUALS"));     // malformed skipped
    }
}

#[cfg(test)]
mod file_io_checked_tests {
    use crate::commands::{read_file_checked_inner, write_file_inner, FileReadResult};
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn temp_with_bytes(bytes: &[u8]) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(bytes).unwrap();
        f.flush().unwrap();
        f
    }

    #[test]
    fn reads_utf8_text() {
        let f = temp_with_bytes(b"hello world");
        match read_file_checked_inner(f.path().to_str().unwrap(), 1_000_000).unwrap() {
            FileReadResult::Text { content, size, mtime } => {
                assert_eq!(content, "hello world");
                assert_eq!(size, 11);
                assert!(mtime > 0, "mtime should be a positive epoch-millis value");
            }
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn detects_binary_via_nul_byte() {
        let f = temp_with_bytes(b"PK\x03\x04\x00\x00binary");
        match read_file_checked_inner(f.path().to_str().unwrap(), 1_000_000).unwrap() {
            FileReadResult::Binary { size, .. } => assert!(size > 0),
            other => panic!("expected Binary, got {other:?}"),
        }
    }

    #[test]
    fn detects_unsupported_encoding() {
        let f = temp_with_bytes(&[0xff, 0xfe, 0x41, 0x42]);
        match read_file_checked_inner(f.path().to_str().unwrap(), 1_000_000).unwrap() {
            FileReadResult::UnsupportedEncoding { size, .. } => assert_eq!(size, 4),
            other => panic!("expected UnsupportedEncoding, got {other:?}"),
        }
    }

    #[test]
    fn flags_too_large() {
        let f = temp_with_bytes(b"0123456789");
        match read_file_checked_inner(f.path().to_str().unwrap(), 4).unwrap() {
            FileReadResult::TooLarge { size } => assert_eq!(size, 10),
            other => panic!("expected TooLarge, got {other:?}"),
        }
    }

    #[test]
    fn serializes_kind_tag_as_camel_case() {
        let v = serde_json::to_value(FileReadResult::TooLarge { size: 9 }).unwrap();
        assert_eq!(v["kind"], "tooLarge");
        assert_eq!(v["size"], 9);
    }

    #[test]
    fn write_returns_mtime_and_persists() {
        let f = NamedTempFile::new().unwrap();
        let res = write_file_inner(f.path().to_str().unwrap(), "saved").unwrap();
        assert!(res.mtime > 0);
        assert_eq!(std::fs::read_to_string(f.path()).unwrap(), "saved");
    }
}

#[cfg(test)]
mod g4_staging_tests {
    use crate::commands::{discard_file_inner, friendly_git_error};
    use std::process::Command;
    use tempfile::tempdir;

    fn git(dir: &std::path::Path, args: &[&str]) {
        let ok = Command::new("git").args(args).current_dir(dir).status().unwrap().success();
        assert!(ok, "git {args:?} failed");
    }
    fn init_with_commit(dir: &std::path::Path) {
        git(dir, &["init", "-q"]);
        git(dir, &["config", "user.email", "t@t.dev"]);
        git(dir, &["config", "user.name", "T"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-qm", "first"]);
    }

    #[test]
    fn friendly_git_error_maps_known_failures() {
        assert!(friendly_git_error("error: patch does not apply").contains("no longer matches"));
        assert!(friendly_git_error("error: while searching for:\n...").contains("no longer matches"));
        assert!(friendly_git_error("already exists in working directory").contains("already exists"));
        assert_eq!(friendly_git_error("  boom  "), "boom");
    }

    #[test]
    fn discard_restores_tracked_file() {
        let dir = tempdir().unwrap();
        init_with_commit(dir.path());
        std::fs::write(dir.path().join("a.txt"), "modified\n").unwrap();
        discard_file_inner(dir.path().to_str().unwrap(), "a.txt").unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "one\n");
    }

    #[test]
    fn discard_deletes_untracked_file() {
        let dir = tempdir().unwrap();
        init_with_commit(dir.path());
        std::fs::write(dir.path().join("new.txt"), "x").unwrap();
        discard_file_inner(dir.path().to_str().unwrap(), "new.txt").unwrap();
        assert!(!dir.path().join("new.txt").exists(), "untracked file should be deleted");
    }

    #[test]
    fn discard_drains_staged_new_file() {
        let dir = tempdir().unwrap();
        init_with_commit(dir.path());
        std::fs::write(dir.path().join("new.txt"), "x").unwrap();
        git(dir.path(), &["add", "new.txt"]); // staged as new (status A)
        discard_file_inner(dir.path().to_str().unwrap(), "new.txt").unwrap();
        assert!(!dir.path().join("new.txt").exists(), "worktree copy deleted");
        // Index no longer lists it as staged.
        let out = std::process::Command::new("git")
            .args(["diff", "--cached", "--name-only"])
            .current_dir(dir.path()).output().unwrap();
        let staged = String::from_utf8_lossy(&out.stdout);
        assert!(!staged.contains("new.txt"), "staged index entry drained, got: {staged}");
    }

    #[test]
    fn discard_deletes_untracked_directory() {
        let dir = tempdir().unwrap();
        init_with_commit(dir.path());
        std::fs::create_dir(dir.path().join("feature")).unwrap();
        std::fs::write(dir.path().join("feature/a.txt"), "x").unwrap();
        std::fs::write(dir.path().join("feature/b.txt"), "y").unwrap();
        discard_file_inner(dir.path().to_str().unwrap(), "feature").unwrap();
        assert!(!dir.path().join("feature").exists(), "untracked dir should be removed");
    }
}

#[cfg(test)]
mod live_tests {
    use crate::orchestrator::events::EventSink;
    use crate::orchestrator::live::{entries_from_stream_event, summarize, tool_hint, LiveEmitter};
    use parking_lot::Mutex;
    use serde_json::{json, Value};
    use crate::orchestrator::agentic::run_agentic_loop;
    use crate::providers::{LlmProvider, LlmRequest, LlmResponse, LlmStopReason, LlmToolUse};
    use std::collections::VecDeque;

    struct ScriptedProvider { turns: Mutex<VecDeque<LlmResponse>> }
    #[async_trait::async_trait]
    impl LlmProvider for ScriptedProvider {
        async fn complete(&self, _b: &str, _k: Option<&str>, _r: &LlmRequest, _c: &reqwest::Client)
            -> crate::error::AppResult<LlmResponse> {
            Ok(self.turns.lock().pop_front().expect("ScriptedProvider ran out of turns"))
        }
    }
    fn resp(text: &str, tools: Vec<LlmToolUse>, stop: LlmStopReason) -> LlmResponse {
        LlmResponse { text: text.into(), tool_uses: tools, stop_reason: stop,
            input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }
    }

    #[tokio::test]
    async fn agentic_loop_streams_text_tool_and_result() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "fn main() {}\n").unwrap();

        let provider = ScriptedProvider { turns: Mutex::new(VecDeque::from(vec![
            resp("inspecting the change",
                 vec![LlmToolUse { id: "t1".into(), name: "read_file".into(),
                       input: serde_json::json!({"path": "a.rs"}) }],
                 LlmStopReason::ToolUse),
            resp("looks good", vec![], LlmStopReason::EndTurn),
        ])) };

        let rec = Recorder { events: Mutex::new(vec![]) };
        let em = LiveEmitter::new(&rec, "r", "s");
        let client = reqwest::Client::new();
        let out = run_agentic_loop(&provider, "http://x", None, &client, "m",
                                   "sys", "do it", dir.path(), 10, &em).await.unwrap();

        assert_eq!(out.text, "looks good"); // final answer is the artifact, not a live entry
        assert!(out.finished, "a final answer marks the result finished");
        let kinds: Vec<String> = rec.events.lock().iter()
            .map(|(_, p)| p["entry"]["kind"].as_str().unwrap().to_string()).collect();
        assert_eq!(kinds, vec!["text", "tool", "tool_result"]);
        // the tool entry carries the name + hint
        let tool = &rec.events.lock()[1].1["entry"];
        assert_eq!(tool["tool"], "read_file");
        assert_eq!(tool["hint"], "a.rs");
    }

    #[tokio::test]
    async fn agentic_loop_exhaustion_is_not_finished() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "fn main() {}\n").unwrap();

        // Every turn asks for another tool — the loop never reaches a final answer.
        let tool_turn = || resp("still digging",
            vec![LlmToolUse { id: "t".into(), name: "read_file".into(),
                  input: serde_json::json!({"path": "a.rs"}) }],
            LlmStopReason::ToolUse);
        let provider = ScriptedProvider { turns: Mutex::new(VecDeque::from(vec![tool_turn(), tool_turn()])) };

        let rec = Recorder { events: Mutex::new(vec![]) };
        let em = LiveEmitter::new(&rec, "r", "s");
        let client = reqwest::Client::new();
        let out = run_agentic_loop(&provider, "http://x", None, &client, "m",
                                   "sys", "do it", dir.path(), 2, &em).await.unwrap();

        assert!(!out.finished, "iteration exhaustion must not read as success");
        assert_eq!(out.text, "(agentic loop hit 2 iterations without finishing)");
        // Usage from the burned iterations is preserved for cost accounting.
        assert_eq!(out.input_tokens, 2);
        assert_eq!(out.output_tokens, 2);
        assert_eq!(out.tool_calls.len(), 2);
    }

    struct Recorder { events: Mutex<Vec<(String, Value)>> }
    impl EventSink for Recorder {
        fn emit(&self, event: &str, payload: Value) { self.events.lock().push((event.to_string(), payload)); }
    }

    #[test]
    fn live_emitter_emits_structured_run_log_entries() {
        let rec = Recorder { events: Mutex::new(vec![]) };
        let em = LiveEmitter::new(&rec, "run1", "stageA");
        em.text("  reading the code  ");
        em.tool("Edit", "src/auth.rs");
        em.tool_result(true, "12 lines");
        em.notice("Verdict: changes requested");
        em.text("   "); // blank → skipped

        let ev = rec.events.lock();
        assert_eq!(ev.len(), 4); // blank text skipped
        for (name, _) in ev.iter() { assert_eq!(name, "run://log"); }
        assert_eq!(ev[0].1, json!({"runId":"run1","stageId":"stageA","entry":{"kind":"text","text":"reading the code"}}));
        assert_eq!(ev[1].1, json!({"runId":"run1","stageId":"stageA","entry":{"kind":"tool","tool":"Edit","hint":"src/auth.rs"}}));
        assert_eq!(ev[2].1, json!({"runId":"run1","stageId":"stageA","entry":{"kind":"tool_result","ok":true,"detail":"12 lines"}}));
        assert_eq!(ev[3].1, json!({"runId":"run1","stageId":"stageA","entry":{"kind":"notice","text":"Verdict: changes requested"}}));
    }

    #[test]
    fn tool_hint_prefers_descriptive_keys_and_summarize_caps() {
        assert_eq!(tool_hint(&json!({"content":"AAAA","file_path":"src/x.rs"})), "src/x.rs");
        assert_eq!(tool_hint(&json!({"command":"cargo test"})), "cargo test");
        assert_eq!(tool_hint(&json!({})), "");
        // summarize: first line, capped at 120 chars
        assert_eq!(summarize("ok\nmore"), "ok");
        let long = "x".repeat(200);
        assert_eq!(summarize(&long).chars().count(), 120);
    }

    #[test]
    fn entries_from_stream_event_maps_assistant_and_skips_result() {
        // assistant text + tool_use → [text, tool]
        let asst = json!({"type":"assistant","message":{"content":[
            {"type":"text","text":"reviewing"},
            {"type":"tool_use","name":"Read","input":{"file_path":"src/a.rs"}}
        ]}});
        let es = entries_from_stream_event(&asst);
        assert_eq!(es.len(), 2);
        assert_eq!(es[0], json!({"kind":"text","text":"reviewing"}));
        assert_eq!(es[1], json!({"kind":"tool","tool":"Read","hint":"src/a.rs"}));
        // user tool_result → [tool_result]
        let user = json!({"type":"user","message":{"content":[
            {"type":"tool_result","is_error":false,"content":"42 lines"}
        ]}});
        let ue = entries_from_stream_event(&user);
        assert_eq!(ue.len(), 1);
        assert_eq!(ue[0], json!({"kind":"tool_result","ok":true,"detail":"42 lines"}));
        // result/system → none
        assert!(entries_from_stream_event(&json!({"type":"result","subtype":"success"})).is_empty());
        assert!(entries_from_stream_event(&json!({"type":"system","subtype":"init"})).is_empty());
    }

    #[test]
    fn cli_stream_tool_result_reflects_is_error() {
        let err = serde_json::json!({"type":"user","message":{"content":[
            {"type":"tool_result","is_error":true,"content":"boom: file not found"}
        ]}});
        let es = crate::orchestrator::live::entries_from_stream_event(&err);
        assert_eq!(es.len(), 1);
        assert_eq!(es[0]["kind"], "tool_result");
        assert_eq!(es[0]["ok"], false);
        assert_eq!(es[0]["detail"], "boom: file not found");
    }

    // Fix 1: tool_result content as array of blocks yields joined text.
    #[test]
    fn tool_result_array_content_is_joined() {
        let user = json!({"type":"user","message":{"content":[
            {"type":"tool_result","is_error":false,"content":[
                {"type":"text","text":"42 lines"}
            ]}
        ]}});
        let es = crate::orchestrator::live::entries_from_stream_event(&user);
        assert_eq!(es.len(), 1);
        assert_eq!(es[0]["kind"], "tool_result");
        assert_eq!(es[0]["ok"], true);
        assert_eq!(es[0]["detail"], "42 lines");
    }

    // Fix 2: looks_like_error correctly classifies error/success strings.
    #[test]
    fn looks_like_error_detects_failures() {
        use crate::orchestrator::live::looks_like_error;
        assert!(looks_like_error("Error: no such file"));
        assert!(looks_like_error("failed to open file"));
        assert!(looks_like_error("Could not parse input"));
        assert!(looks_like_error("Cannot write to path"));
        assert!(!looks_like_error("42 lines"));
        assert!(!looks_like_error("ok"));
        assert!(!looks_like_error("  \n42 lines changed"));
    }
}

#[cfg(test)]
mod g7_git_tests {
    use crate::git_ops::get_status;
    use std::process::Command;
    use tempfile::tempdir;

    fn git(dir: &std::path::Path, args: &[&str]) {
        let ok = Command::new("git").args(args).current_dir(dir).status().unwrap().success();
        assert!(ok, "git {args:?} failed");
    }

    #[test]
    fn get_status_reports_conflicted_files() {
        let dir = tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q"]);
        git(p, &["config", "user.email", "t@t.dev"]);
        git(p, &["config", "user.name", "T"]);
        std::fs::write(p.join("a.txt"), "base\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-qm", "base"]);
        git(p, &["checkout", "-qb", "feature"]);
        std::fs::write(p.join("a.txt"), "feature\n").unwrap();
        git(p, &["commit", "-qam", "feature"]);
        git(p, &["checkout", "-q", "-"]); // back to base branch (portable, no name assumption)
        std::fs::write(p.join("a.txt"), "main\n").unwrap();
        git(p, &["commit", "-qam", "main"]);
        let _ = Command::new("git").args(["merge", "feature"]).current_dir(p).output().unwrap();

        let st = get_status(p).unwrap();
        assert!(st.conflicted >= 1, "expected a conflicted file, got {}", st.conflicted);
        assert!(st.changed_files.iter().any(|f| f.path == "a.txt" && f.conflicted),
            "a.txt should be marked conflicted");
    }
}

#[cfg(test)]
mod git_lock_tests {
    use crate::git_lock::lock_for;
    use std::sync::Arc;

    #[test]
    fn same_path_shares_one_lock_distinct_paths_differ() {
        let a1 = lock_for("/repo/a");
        let a2 = lock_for("/repo/a");
        let b = lock_for("/repo/b");
        assert!(Arc::ptr_eq(&a1, &a2), "same path must share one mutex");
        assert!(!Arc::ptr_eq(&a1, &b), "distinct paths must have distinct mutexes");
    }
}

#[cfg(test)]
mod stage_log_tests {
    use crate::db::Db;
    use crate::orchestrator::events::EventSink;
    use crate::orchestrator::live::RUN_LOG_EVENT;
    use crate::orchestrator::persist::PersistingSink;
    use parking_lot::Mutex;
    use serde_json::{json, Value};
    use std::sync::Arc;
    use tempfile::NamedTempFile;

    /// Records every forwarded (event, payload) pair.
    struct Recorder {
        events: Mutex<Vec<(String, Value)>>,
    }
    impl EventSink for Recorder {
        fn emit(&self, event: &str, payload: Value) {
            self.events.lock().push((event.to_string(), payload));
        }
    }

    /// (db, recorder, persisting sink, tempfile guard).
    fn harness() -> (Arc<Mutex<Db>>, Arc<Recorder>, PersistingSink, NamedTempFile) {
        let tmp = NamedTempFile::new().unwrap();
        let db = Arc::new(Mutex::new(Db::open(tmp.path()).unwrap()));
        let rec = Arc::new(Recorder { events: Mutex::new(vec![]) });
        let sink = PersistingSink::new(rec.clone(), Arc::clone(&db));
        (db, rec, sink, tmp)
    }

    #[test]
    fn run_log_entry_is_persisted_and_forwarded() {
        let (db, rec, sink, _tmp) = harness();
        let entry = json!({ "kind": "text", "text": "hello" });
        sink.emit(
            RUN_LOG_EVENT,
            json!({ "runId": "r1", "stageId": "s1", "entry": entry }),
        );
        // Persisted, parseable, in order.
        let rows = db.lock().list_stage_log("s1").unwrap();
        assert_eq!(rows.len(), 1);
        let parsed: Value = serde_json::from_str(&rows[0]).unwrap();
        assert_eq!(parsed, entry);
        // Forwarded untouched.
        let fwd = rec.events.lock();
        assert_eq!(fwd.len(), 1);
        assert_eq!(fwd[0].0, RUN_LOG_EVENT);
        assert_eq!(fwd[0].1["entry"], entry);
    }

    #[test]
    fn reset_payload_persists_a_reset_marker_row() {
        let (db, rec, sink, _tmp) = harness();
        sink.emit(
            RUN_LOG_EVENT,
            json!({ "runId": "r1", "stageId": "s1", "entry": json!({"kind":"text","text":"old"}) }),
        );
        sink.emit(
            RUN_LOG_EVENT,
            json!({ "runId": "r1", "stageId": "s1", "reset": true }),
        );
        let rows = db.lock().list_stage_log("s1").unwrap();
        assert_eq!(rows.len(), 2);
        let marker: Value = serde_json::from_str(&rows[1]).unwrap();
        assert_eq!(marker, json!({ "kind": "reset" }));
        // The reset event itself still reaches the frontend.
        assert_eq!(rec.events.lock().len(), 2);
    }

    #[test]
    fn first_start_reset_writes_no_leading_marker() {
        // Every stage start emits reset — including the very first. A leading
        // marker would shift the attempt↔segment mapping by one, so the sink
        // only writes a marker once the stage already has rows.
        let (db, rec, sink, _tmp) = harness();
        sink.emit(RUN_LOG_EVENT, json!({ "runId": "r1", "stageId": "s1", "reset": true }));
        assert!(db.lock().list_stage_log("s1").unwrap().is_empty());
        sink.emit(
            RUN_LOG_EVENT,
            json!({ "runId": "r1", "stageId": "s1", "entry": json!({"kind":"text","text":"work"}) }),
        );
        sink.emit(RUN_LOG_EVENT, json!({ "runId": "r1", "stageId": "s1", "reset": true }));
        let rows = db.lock().list_stage_log("s1").unwrap();
        assert_eq!(rows.len(), 2);
        let marker: Value = serde_json::from_str(&rows[1]).unwrap();
        assert_eq!(marker, json!({ "kind": "reset" }));
        // Both resets + the entry were still forwarded.
        assert_eq!(rec.events.lock().len(), 3);
    }

    #[test]
    fn non_log_events_forward_without_persisting() {
        let (db, rec, sink, _tmp) = harness();
        let payload = json!({ "runId": "r1", "costUsd": 0.5 });
        sink.emit("run://cost", payload.clone());
        let count: i64 = db
            .lock()
            .conn_ref()
            .query_row("SELECT COUNT(*) FROM stage_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let fwd = rec.events.lock();
        assert_eq!(fwd.len(), 1);
        assert_eq!(fwd[0].0, "run://cost");
        assert_eq!(fwd[0].1, payload);
    }

    #[test]
    fn stage_log_rows_are_ordered_and_scoped_by_stage() {
        let (db, _rec, sink, _tmp) = harness();
        for i in 0..3 {
            sink.emit(
                RUN_LOG_EVENT,
                json!({ "runId": "r1", "stageId": "s1", "entry": json!({"kind":"text","text": format!("e{i}")}) }),
            );
        }
        sink.emit(
            RUN_LOG_EVENT,
            json!({ "runId": "r1", "stageId": "s2", "entry": json!({"kind":"text","text":"other"}) }),
        );
        let rows = db.lock().list_stage_log("s1").unwrap();
        assert_eq!(rows.len(), 3);
        let texts: Vec<String> = rows
            .iter()
            .map(|r| serde_json::from_str::<Value>(r).unwrap()["text"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(texts, vec!["e0", "e1", "e2"]);
    }
}

#[cfg(test)]
mod g7_timeout_tests {
    use crate::commands::run_with_timeout;
    use std::time::Duration;

    #[test]
    fn run_with_timeout_returns_value_when_fast_and_none_when_slow() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        let fast = rt.block_on(run_with_timeout(Duration::from_millis(500), || 42));
        assert_eq!(fast, Some(42));
        let slow = rt.block_on(run_with_timeout(Duration::from_millis(50), || {
            std::thread::sleep(Duration::from_millis(300));
            7
        }));
        assert_eq!(slow, None);
    }
}
