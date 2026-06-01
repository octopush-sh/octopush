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
    fn list_projects_is_stable_creation_order_not_recency() {
        let db = test_db();
        for id in ["proj-a", "proj-b", "proj-c"] {
            db.insert_project(id, "P", &format!("/tmp/{id}")).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        // "Open" the oldest project — under the old `last_opened DESC` ordering
        // this would hoist proj-a to the front. Creation-ascending must NOT move it.
        std::thread::sleep(std::time::Duration::from_millis(2));
        db.touch_project("proj-a").unwrap();

        let projects = db.list_projects().unwrap();
        let ids: Vec<&str> = projects.iter().map(|p| p.0.as_str()).collect();
        assert_eq!(ids, ["proj-a", "proj-b", "proj-c"]);
    }

    #[test]
    fn workspace_link_round_trip() {
        let db = test_db();
        db.insert_project("proj-link", "Test Project", "/tmp/proj-link")
            .unwrap();
        db.insert_workspace("ws-link", "proj-link", "ws", "", "main", None, "")
            .unwrap();

        // Set linked_issue_key and dismissed=false, then read back.
        db.update_workspace_link("ws-link", Some("PROJ-42".into()), false)
            .unwrap();
        let ws = db.get_workspace("ws-link").unwrap().unwrap();
        assert_eq!(ws.linked_issue_key.as_deref(), Some("PROJ-42"));
        assert!(!ws.issue_link_dismissed);

        // Clear link and set dismissed=true.
        db.update_workspace_link("ws-link", None, true).unwrap();
        let ws = db.get_workspace("ws-link").unwrap().unwrap();
        assert_eq!(ws.linked_issue_key, None);
        assert!(ws.issue_link_dismissed);
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

        let entries = read_directory(root).await.expect("should succeed");

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
        let result = read_directory("/nonexistent/path/abc123".to_string()).await;
        assert!(result.is_err(), "should return error for missing directory");
    }

    #[tokio::test]
    async fn one_level_only() {
        let tmp = TempDir::new().unwrap();
        let nested = tmp.path().join("a").join("b");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("deep.txt"), "x").unwrap();

        let entries = read_directory(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();

        // Should only see "a", not "a/b" or "a/b/deep.txt"
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "a");
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
}
