//! Unit tests for the Octopus sh core.
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
        let mut pty = crate::pty_manager::PtyManager::new();
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
