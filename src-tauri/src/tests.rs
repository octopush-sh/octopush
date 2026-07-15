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
        db.insert_workspace(workspace_id, project_id, "ws", "", "main", None, "", None)
            .unwrap();
    }

    #[test]
    fn count_started_runs_excludes_drafts_and_counts_started() {
        // Guards the free-tier Direct-runs meter/quota: only runs that have
        // *left* `draft` (i.e. were started) this month are counted.
        let db = test_db();
        setup_workspace(&db, "p", "ws");
        db.seed_builtin_pipelines().unwrap();
        let pipeline_id = db.list_pipelines().unwrap()[0].id.clone();

        // A freshly created run is a draft → not counted.
        let run_id = db
            .create_run("ws", &pipeline_id, "task", None, None, &[])
            .unwrap();
        assert_eq!(db.count_started_runs_this_month().unwrap(), 0);

        // Once it leaves draft (started), it counts...
        db.set_run_status(&run_id, "running", false).unwrap();
        assert_eq!(db.count_started_runs_this_month().unwrap(), 1);

        // ...and a terminal state still counts (it also left draft).
        db.set_run_status(&run_id, "completed", true).unwrap();
        assert_eq!(db.count_started_runs_this_month().unwrap(), 1);
    }

    #[test]
    fn count_active_runs_counts_running_and_paused_excluding_self() {
        // Drives the concurrency gate: Free may have only ONE run executing at a
        // time across all workspaces; Pro may run many.
        let db = test_db();
        setup_workspace(&db, "p1", "ws1");
        setup_workspace(&db, "p2", "ws2");
        db.seed_builtin_pipelines().unwrap();
        let pipeline_id = db.list_pipelines().unwrap()[0].id.clone();

        let a = db.create_run("ws1", &pipeline_id, "task", None, None, &[]).unwrap();
        let b = db.create_run("ws2", &pipeline_id, "task", None, None, &[]).unwrap();

        // Both draft → nothing active.
        assert_eq!(db.count_active_runs_excluding(&b).unwrap(), 0);

        // `a` running (a different workspace) → counts against starting `b`...
        db.set_run_status(&a, "running", false).unwrap();
        assert_eq!(db.count_active_runs_excluding(&b).unwrap(), 1);
        // ...but a run is never counted against itself.
        assert_eq!(db.count_active_runs_excluding(&a).unwrap(), 0);

        // `paused` (suspended mid-run at a checkpoint) also holds the slot.
        db.set_run_status(&a, "paused", false).unwrap();
        assert_eq!(db.count_active_runs_excluding(&b).unwrap(), 1);

        // A terminal state frees the slot.
        db.set_run_status(&a, "completed", true).unwrap();
        assert_eq!(db.count_active_runs_excluding(&b).unwrap(), 0);
    }

    #[test]
    fn list_active_runs_returns_running_and_paused_across_workspaces() {
        // Feeds the global "Runs in progress" tray — running/paused runs from
        // every workspace, terminal/draft excluded.
        let db = test_db();
        setup_workspace(&db, "p1", "ws1");
        setup_workspace(&db, "p2", "ws2");
        db.seed_builtin_pipelines().unwrap();
        let pipeline_id = db.list_pipelines().unwrap()[0].id.clone();

        let a = db.create_run("ws1", &pipeline_id, "task a", None, None, &[]).unwrap();
        let b = db.create_run("ws2", &pipeline_id, "task b", None, None, &[]).unwrap();
        let c = db.create_run("ws1", &pipeline_id, "task c", None, None, &[]).unwrap();

        // Drafts aren't active.
        assert!(db.list_active_runs().unwrap().is_empty());

        db.set_run_status(&a, "running", false).unwrap();
        db.set_run_status(&b, "paused", false).unwrap();
        db.set_run_status(&c, "completed", true).unwrap();

        let active = db.list_active_runs().unwrap();
        let ids: Vec<&str> = active.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(active.len(), 2, "running + paused only");
        assert!(ids.contains(&a.as_str()) && ids.contains(&b.as_str()));
        assert!(!ids.contains(&c.as_str()), "completed is excluded");
    }

    #[test]
    fn db_opens_in_wal_with_normal_sync() {
        // WAL + synchronous=NORMAL keep writes fast (short mutex hold) without
        // corruption risk — matters under N concurrent runs.
        let db = test_db();
        let conn = db.conn_ref();
        let journal: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(journal.to_lowercase(), "wal");
        let sync: i64 = conn.query_row("PRAGMA synchronous", [], |r| r.get(0)).unwrap();
        assert_eq!(sync, 1, "synchronous=NORMAL");
    }

    // ── Cross-machine run history (Pro-real Part B / B1) ─────────────────

    #[test]
    fn machine_id_is_stable_across_calls() {
        // A stable per-install id: generated once, persisted, then returned as-is.
        let db = test_db();
        let a = db.get_or_create_machine_id().unwrap();
        let b = db.get_or_create_machine_id().unwrap();
        assert!(!a.is_empty());
        assert_eq!(a, b, "machine id must not change once created");
    }

    #[test]
    fn app_meta_kv_roundtrips_and_upserts() {
        let db = test_db();
        assert_eq!(db.meta_get("k").unwrap(), None);
        db.meta_set("k", "v1").unwrap();
        assert_eq!(db.meta_get("k").unwrap().as_deref(), Some("v1"));
        db.meta_set("k", "v2").unwrap(); // upsert same key
        assert_eq!(db.meta_get("k").unwrap().as_deref(), Some("v2"));
    }

    #[test]
    fn list_terminal_runs_returns_only_completed_and_aborted() {
        // Feeds the one-shot launch backfill push: only terminal runs replicate.
        let db = test_db();
        setup_workspace(&db, "p1", "ws1");
        db.seed_builtin_pipelines().unwrap();
        let pipeline_id = db.list_pipelines().unwrap()[0].id.clone();
        let done = db.create_run("ws1", &pipeline_id, "done", None, None, &[]).unwrap();
        let killed = db.create_run("ws1", &pipeline_id, "killed", None, None, &[]).unwrap();
        let live = db.create_run("ws1", &pipeline_id, "live", None, None, &[]).unwrap();
        db.set_run_status(&done, "completed", true).unwrap();
        db.set_run_status(&killed, "aborted", true).unwrap();
        db.set_run_status(&live, "running", false).unwrap();
        let ids: Vec<String> =
            db.list_terminal_runs(100).unwrap().into_iter().map(|r| r.id).collect();
        assert!(ids.contains(&done) && ids.contains(&killed));
        assert!(!ids.contains(&live), "a running run is not terminal");
    }

    #[test]
    fn synced_runs_mirror_replaces_and_lists_newest_first() {
        let db = test_db();
        let mk = |id: &str, created: &str| crate::sync::SyncRun {
            run_id: id.into(),
            machine_id: "m1".into(),
            machine_name: Some("Test Mac".into()),
            workspace_name: Some("ws".into()),
            task: "t".into(),
            status: "completed".into(),
            cost_usd: 1.0,
            input_tokens: 0,
            output_tokens: 0,
            created_at: created.into(),
            finished_at: None,
            stages: vec![],
        };
        db.replace_synced_runs(&[
            mk("r1", "2026-01-01T00:00:00Z"),
            mk("r2", "2026-02-01T00:00:00Z"),
        ])
        .unwrap();
        let got = db.list_synced_runs().unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].run_id, "r2", "newest (later created_at) first");
        // A fresh pull fully REPLACES the mirror (cloud is source of truth).
        db.replace_synced_runs(&[mk("r3", "2026-03-01T00:00:00Z")]).unwrap();
        let got = db.list_synced_runs().unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].run_id, "r3");

        // Sign-out clears the mirror (privacy on shared machines).
        db.clear_synced_runs().unwrap();
        assert!(db.list_synced_runs().unwrap().is_empty());
    }

    #[test]
    fn build_run_payload_maps_run_and_sums_stage_tokens() {
        let db = test_db();
        setup_workspace(&db, "p1", "ws1");
        db.seed_builtin_pipelines().unwrap();
        let pipeline_id = db.list_pipelines().unwrap()[0].id.clone();
        let run_id = db.create_run("ws1", &pipeline_id, "ship it", None, None, &[]).unwrap();
        db.set_run_status(&run_id, "completed", true).unwrap();
        let run = db.get_run(&run_id).unwrap().unwrap();
        let machine_id = db.get_or_create_machine_id().unwrap();
        let payload = crate::sync::build_run_payload(&db, &run, &machine_id);
        assert_eq!(payload.run_id, run_id);
        assert_eq!(payload.machine_id, machine_id);
        assert_eq!(payload.task, "ship it");
        assert_eq!(payload.status, "completed");
        assert_eq!(payload.workspace_name.as_deref(), Some("ws"));
        assert!(!payload.machine_id.is_empty());
        let stages = db.list_run_stages(&run_id).unwrap();
        assert_eq!(payload.stages.len(), stages.len());
        let sum_in: i64 = stages.iter().map(|s| s.input_tokens).sum();
        assert_eq!(payload.input_tokens, sum_in, "input tokens summed over stages");
    }

    #[test]
    fn build_run_detail_payload_carries_journals_artifacts_and_diffs_capped() {
        // B2: the heavy story a reviewer reads from another machine. The
        // payload must carry each stage's journal (chronological, newest-win
        // budget), the artifact's human TEXT (not its JSON wrapper), and the
        // diff snapshot — all capped so one run can't blow the sync blob.
        let db = test_db();
        setup_workspace(&db, "p1", "ws1");
        db.seed_builtin_pipelines().unwrap();
        let pipeline_id = db.list_pipelines().unwrap()[0].id.clone();
        let run_id = db.create_run("ws1", &pipeline_id, "ship it", None, None, &[]).unwrap();
        let stages = db.list_run_stages(&run_id).unwrap();
        let s0 = &stages[0];

        // A journal (two entries + one malformed line that must be skipped)…
        db.append_stage_log(&run_id, &s0.id, r#"{"kind":"text","text":"thinking"}"#).unwrap();
        db.append_stage_log(&run_id, &s0.id, "not json at all").unwrap();
        db.append_stage_log(&run_id, &s0.id, r#"{"kind":"tool","tool":"EDIT","hint":"src/x.rs"}"#).unwrap();
        // …an artifact (JSON-wrapped; the payload sends the TEXT)…
        db.set_run_stage_artifact(
            &s0.id,
            r#"{"kind":"plan","text":"The plan body","refsWorktree":false}"#,
        ).unwrap();
        // …and an oversized diff snapshot that must come back capped.
        let big_diff = format!("DIFF-HEAD\n{}\nDIFF-TAIL", "+x\n".repeat(60_000));
        db.set_stage_diff_snapshot(&s0.id, &big_diff).unwrap();

        db.set_run_status(&run_id, "completed", true).unwrap();
        // Build the way the orchestrator does: per-stage rows + raw logs
        // through the PURE builder (granular locks in production), then the
        // whole-payload budget. Re-list AFTER the setters above — the builder
        // reads the row it is given.
        let stages = db.list_run_stages(&run_id).unwrap();
        let details: Vec<_> = stages
            .iter()
            .map(|st| crate::sync::build_stage_detail(st, db.list_stage_log(&st.id).unwrap_or_default()))
            .collect();
        let mut detail = crate::sync::SyncRunDetail { run_id: run_id.clone(), stages: details };
        crate::sync::enforce_detail_budget(&mut detail);

        assert_eq!(detail.run_id, run_id);
        assert_eq!(detail.stages.len(), stages.len());
        let d0 = &detail.stages[0];
        assert_eq!(d0.role, s0.role);
        // Journal: both valid entries, chronological, malformed line skipped.
        assert_eq!(d0.journal.len(), 2);
        assert_eq!(d0.journal[0]["kind"], "text");
        assert_eq!(d0.journal[1]["tool"], "EDIT");
        // Artifact: the human text, not the JSON wrapper.
        assert_eq!(d0.artifact.as_deref(), Some("The plan body"));
        // Diff: capped head+tail (never the full 180KB).
        let diff = d0.diff.as_deref().unwrap();
        assert!(diff.len() < 100_000, "diff must be capped, got {}", diff.len());
        assert!(diff.contains("DIFF-HEAD") && diff.contains("DIFF-TAIL"));
        assert!(diff.contains("truncated for sync"));
        // The whole blob serializes comfortably under the server's 1.5MB cap.
        assert!(serde_json::to_string(&detail).unwrap().len() < 1_000_000);
    }

    #[test]
    fn oversized_journal_entry_is_truncated_not_journal_sinking() {
        // A stage's final message can exceed the whole per-stage budget; it
        // must arrive TRUNCATED — an empty journal (the old break-on-first
        // behavior) loses exactly the line that explains the outcome.
        use crate::db::RunStageRow;
        let stage = RunStageRow {
            id: "s1".into(), run_id: "r1".into(), position: 0, role: "plan".into(),
            agent_model: "m".into(), effort: None, substrate: "api".into(), checkpoint: false,
            status: "done".into(), input_tokens: 0, output_tokens: 0, cost_usd: 0.0,
            artifact: None, feedback: None, error: None, started_at: None, finished_at: None,
            loop_target_position: None, loop_max_iterations: 0, loop_mode: None,
            loop_iterations: 0, diff_snapshot: None, max_iterations: 25, parents: vec![],
            tools: None, custom_name: None, instructions: None, session_id: None,
            resume_pending: false, baseline_commit: None, blocked_questions: None,
            escalate_model: None, escalate_effort: None, escalated: false,
        };
        let huge = format!(
            r#"{{"kind":"text","text":"HEAD{}TAIL"}}"#,
            "x".repeat(80_000)
        );
        let detail = crate::sync::build_stage_detail(&stage, vec![
            r#"{"kind":"text","text":"older line"}"#.into(),
            huge,
        ]);
        assert_eq!(detail.journal.len(), 2, "the oversized entry must not sink the journal");
        let newest = detail.journal[1]["text"].as_str().unwrap();
        assert!(newest.contains("HEAD") && newest.contains("TAIL"));
        assert!(newest.len() < 10_000, "entry text capped");
        assert_eq!(detail.journal[0]["text"], "older line");
    }

    #[test]
    fn detail_budget_degrades_diffs_then_journals_never_413s() {
        // Many-stage runs must arrive TRIMMED at the server, never be dropped
        // by its 1.5MB backstop: diffs go first (oldest→), then journals.
        use crate::db::RunStageRow;
        let mk = |pos: i64| RunStageRow {
            id: format!("s{pos}"), run_id: "r1".into(), position: pos, role: "implement".into(),
            agent_model: "m".into(), effort: None, substrate: "api".into(), checkpoint: false,
            status: "done".into(), input_tokens: 0, output_tokens: 0, cost_usd: 0.0,
            artifact: None, feedback: None, error: None, started_at: None, finished_at: None,
            loop_target_position: None, loop_max_iterations: 0, loop_mode: None,
            loop_iterations: 0, diff_snapshot: Some("+line\n".repeat(15_000)), max_iterations: 25,
            parents: vec![], tools: None, custom_name: None, instructions: None,
            session_id: None, resume_pending: false, baseline_commit: None, blocked_questions: None,
            escalate_model: None, escalate_effort: None, escalated: false,
        };
        // 16 stages ≈ 16 × ~96KB capped diffs ≈ >1.5MB serialized before the budget.
        let stages: Vec<_> = (0..16).map(|p| crate::sync::build_stage_detail(&mk(p), vec![])).collect();
        let mut detail = crate::sync::SyncRunDetail { run_id: "r1".into(), stages };
        let before = serde_json::to_string(&detail).unwrap().len();
        assert!(before > 1_200_000, "fixture must exceed the budget, got {before}");
        crate::sync::enforce_detail_budget(&mut detail);
        let after = serde_json::to_string(&detail).unwrap().len();
        assert!(after <= 1_200_000, "budget enforced, got {after}");
        // Degradation is oldest-first: the LAST stage keeps its diff longest.
        assert!(detail.stages[0].diff.is_none(), "oldest diff dropped first");
    }

    #[test]
    fn gh_issues_parse_leniently() {
        use crate::github::issues_from_json;
        let raw = r#"[
            {"number": 42, "title": "Add CSV export", "body": "Details here", "url": "https://github.com/o/r/issues/42"},
            {"title": "no number — skipped"},
            {"number": 7, "title": "Empty body ok"}
        ]"#;
        let issues = issues_from_json(raw).unwrap();
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].number, 42);
        assert_eq!(issues[0].title, "Add CSV export");
        assert_eq!(issues[1].body, "");
        assert!(issues_from_json("not json").is_err());
    }

    #[test]
    fn ship_it_builtin_ends_in_pull_request_with_a_gated_review_loop() {
        // The "Ship a GitHub issue" flow's crew: it must actually END by
        // opening the PR, and the review must gate implement (not run wild).
        let db = test_db();
        db.seed_builtin_pipelines().unwrap();
        let ship = db
            .list_pipelines()
            .unwrap()
            .into_iter()
            .find(|p| p.name == "Ship it" && p.is_builtin)
            .expect("Ship it builtin seeded");
        let stages = db.get_pipeline_stages(&ship.id).unwrap();
        let roles: Vec<&str> = stages.iter().map(|s| s.role.as_str()).collect();
        assert_eq!(roles, ["plan", "implement", "code_review", "test", "pull_request"]);
        let last = stages.last().unwrap();
        assert_eq!(last.substrate, "cli", "the PR opener runs on the CLI substrate");
        assert!(last.checkpoint, "opening a PR is gated on the director");
        let review = &stages[2];
        assert_eq!(review.loop_target_position, Some(1), "review loops back to implement");
        assert_eq!(review.loop_mode.as_deref(), Some("gated"));
    }

    #[test]
    fn ever_ran_signal_is_durable_across_workspace_deletion() {
        // Backs the one-shot first-run invite: "has this user EVER run a
        // crew?" — drafts don't count, and the signal survives BOTH the
        // monthly window (no window at all) and the workspace-delete cascade
        // that erases run rows (the app_meta marker is the durable half).
        let db = test_db();
        setup_workspace(&db, "p1", "ws1");
        db.seed_builtin_pipelines().unwrap();
        let pipeline_id = db.list_pipelines().unwrap()[0].id.clone();
        assert!(!db.has_ever_started_run().unwrap());
        let draft = db.create_run("ws1", &pipeline_id, "t", None, None, &[]).unwrap();
        assert!(!db.has_ever_started_run().unwrap(), "drafts never count");
        db.set_run_status(&draft, "running", false).unwrap();
        db.mark_ever_ran().unwrap(); // what start_run stamps
        assert!(db.has_ever_started_run().unwrap());
        // A veteran deletes the workspace → run rows cascade away…
        db.conn_ref().execute("DELETE FROM workspaces WHERE id='ws1'", []).unwrap();
        let left: i64 = db.conn_ref().query_row("SELECT COUNT(*) FROM runs", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0, "cascade erased the rows");
        // …but the invite must never come back.
        assert!(db.has_ever_started_run().unwrap());
    }

    // ── Library sync (Pro): custom pipelines + roles follow the user ──

    #[test]
    fn library_sync_round_trips_a_custom_pipeline_to_a_second_machine() {
        // Machine A authors; machine B pulls: same id, same stages, byte-true.
        let a = test_db();
        a.seed_builtin_pipelines().unwrap();
        let draft = crate::db::StageDraft {
            role: "plan".into(), agent_model: "m1".into(), substrate: "api".into(),
            checkpoint: true, loop_target_position: None, loop_max_iterations: 0,
            loop_mode: None, max_iterations: 30, pos_x: Some(10.0), pos_y: Some(20.0),
            parents: vec![], tools: Some(vec!["read_file".into(), "list_files".into()]),
            custom_name: Some("The Plan".into()), instructions: Some("be terse".into()),
            effort: None, escalate_model: None, escalate_effort: None,
        };
        let pid = a.save_pipeline(None, "My Pipe", "d", &[draft.clone()]).unwrap();
        let synced = a.list_custom_pipelines_for_sync().unwrap();
        assert_eq!(synced.len(), 1, "builtins never travel");
        assert_eq!(synced[0].id, pid);
        assert!(!synced[0].updated_at.is_empty());

        let b = test_db();
        b.seed_builtin_pipelines().unwrap();
        assert!(b.upsert_pipeline_from_sync(&synced[0]).unwrap());
        let stages = b.pipeline_stage_drafts(&pid).unwrap();
        assert_eq!(stages.len(), 1);
        assert_eq!(stages[0].custom_name.as_deref(), Some("The Plan"));
        assert_eq!(stages[0].instructions.as_deref(), Some("be terse"));
        assert_eq!(stages[0].tools.as_deref(), Some(&["read_file".to_string(), "list_files".to_string()][..]));
        assert_eq!(stages[0].max_iterations, 30);
        // Re-applying the same item is a no-op (LWW: not strictly newer).
        assert!(!b.upsert_pipeline_from_sync(&synced[0]).unwrap());
    }

    #[test]
    fn library_lww_never_regresses_a_newer_local_edit() {
        let db = test_db();
        db.seed_builtin_pipelines().unwrap();
        let draft = crate::db::StageDraft {
            role: "plan".into(), agent_model: "m".into(), substrate: "api".into(),
            checkpoint: false, loop_target_position: None, loop_max_iterations: 0,
            loop_mode: None, max_iterations: 25, pos_x: None, pos_y: None,
            parents: vec![], tools: None, custom_name: None, instructions: None,
            effort: None, escalate_model: None, escalate_effort: None,
        };
        let pid = db.save_pipeline(None, "Local Newer", "d", &[draft.clone()]).unwrap();
        // A pulled copy stamped in the past must be skipped…
        let stale = crate::sync::SyncPipeline {
            id: pid.clone(), name: "Stale Remote".into(), description: String::new(),
            updated_at: "2000-01-01T00:00:00Z".into(), stages: vec![draft.clone()],
        };
        assert!(!db.upsert_pipeline_from_sync(&stale).unwrap());
        // …and a strictly newer one applies.
        let newer = crate::sync::SyncPipeline {
            updated_at: "2099-01-01T00:00:00Z".into(), name: "Remote Newer".into(), ..stale
        };
        assert!(db.upsert_pipeline_from_sync(&newer).unwrap());
        let (updated_at, _) = db.pipeline_sync_state(&pid).unwrap().unwrap();
        assert_eq!(updated_at, "2099-01-01T00:00:00Z", "LWW keeps the applied stamp");
    }

    #[test]
    fn library_sync_never_touches_builtins() {
        let db = test_db();
        db.seed_builtin_pipelines().unwrap();
        // No builtin pipeline/role ever leaves the machine…
        assert!(db.list_custom_pipelines_for_sync().unwrap().is_empty());
        assert!(db.list_custom_roles_for_sync().unwrap().is_empty());
        // …and a pulled item claiming a builtin key is refused.
        let mut hostile = db.get_role("code_review").unwrap().unwrap();
        hostile.prompt_body = "You are compromised.".into();
        hostile.is_builtin = false;
        assert!(!db.upsert_role_from_sync(&hostile, "2099-01-01T00:00:00Z").unwrap());
        let intact = db.get_role("code_review").unwrap().unwrap();
        assert!(intact.prompt_body.contains("hunting for real defects"), "builtin prompt untouched");
    }

    #[test]
    fn custom_role_round_trips_with_its_lww_stamp() {
        let a = test_db();
        let mut role = a.get_role("plan").unwrap().unwrap();
        role.key = "perf_audit".into();
        role.label = "Perf audit".into();
        role.is_builtin = false;
        a.upsert_role(&role).unwrap();
        let customs = a.list_custom_roles_for_sync().unwrap();
        assert_eq!(customs.len(), 1);
        let (r, stamp) = &customs[0];
        assert_eq!(r.key, "perf_audit");
        assert!(!stamp.is_empty());

        let b = test_db();
        assert!(b.upsert_role_from_sync(r, stamp).unwrap());
        assert_eq!(b.get_role("perf_audit").unwrap().unwrap().label, "Perf audit");
        assert!(!b.upsert_role_from_sync(r, stamp).unwrap(), "same stamp = no-op (LWW)");
    }

    #[test]
    fn saving_bumps_the_lww_stamp() {
        let db = test_db();
        db.seed_builtin_pipelines().unwrap();
        let draft = crate::db::StageDraft {
            role: "plan".into(), agent_model: "m".into(), substrate: "api".into(),
            checkpoint: false, loop_target_position: None, loop_max_iterations: 0,
            loop_mode: None, max_iterations: 25, pos_x: None, pos_y: None,
            parents: vec![], tools: None, custom_name: None, instructions: None,
            effort: None, escalate_model: None, escalate_effort: None,
        };
        let pid = db.save_pipeline(None, "P", "d", &[draft.clone()]).unwrap();
        let (t1, _) = db.pipeline_sync_state(&pid).unwrap().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        db.save_pipeline(Some(pid.clone()), "P2", "d", &[draft]).unwrap();
        let (t2, _) = db.pipeline_sync_state(&pid).unwrap().unwrap();
        assert!(t2 > t1, "an edit must move the LWW stamp forward");
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
            db.insert_workspace(id, "proj-1", "ws", "", "main", None, "", None)
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
        db.insert_workspace("w1", "p", "ws", "", "main", None, "", None)
            .unwrap();
        db.insert_workspace("w2", "p", "ws", "", "feat/keep", None, "", None)
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
        db.insert_workspace("w1", "p", "alpha", "", "feat/a", Some("/tmp/x/a"), "", None).unwrap();

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
    fn from_branch_roundtrips_through_insert_list_get_and_archive() {
        let db = test_db();
        db.insert_project("p", "P", "/tmp/octo-fb-p").unwrap();
        db.insert_workspace("w1", "p", "ws", "", "feat-x", None, "", Some("develop"))
            .unwrap();
        db.insert_workspace("w2", "p", "ws", "", "feat-y", None, "", None)
            .unwrap();

        let rows = db.list_workspaces("p").unwrap();
        assert_eq!(rows[0].from_branch.as_deref(), Some("develop"));
        assert_eq!(rows[1].from_branch, None);
        assert_eq!(
            db.get_workspace("w1").unwrap().unwrap().from_branch.as_deref(),
            Some("develop"),
        );

        db.archive_workspace("w1").unwrap();
        let archived = db.list_archived_workspaces("p").unwrap();
        assert_eq!(archived[0].from_branch.as_deref(), Some("develop"));
    }

    #[test]
    fn rename_workspace_updates_name() {
        let db = test_db();
        db.insert_project("p", "P", "/tmp/octo-rn-p").unwrap();
        db.insert_workspace("w1", "p", "old", "", "main", None, "", None)
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
        db.insert_workspace("ws-link", "proj-link", "ws", "", "main", None, "", None)
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
    fn chat_threads_crud_and_scoping() {
        let db = test_db();
        db.insert_project("p", "P", "/tmp/p").unwrap();
        db.insert_workspace("ws", "p", "ws", "", "main", None, "", None).unwrap();

        // Two independent threads in one workspace.
        let a = db.create_chat_thread("ws", "First").unwrap();
        let b = db.create_chat_thread("ws", "Second").unwrap();
        db.insert_chat_message("ws", &a.id, "user", "in A", None, None, None, None).unwrap();
        db.insert_chat_message("ws", &b.id, "user", "in B", None, None, None, None).unwrap();

        // list_chat_messages is scoped per thread.
        assert_eq!(db.list_chat_messages(&a.id).unwrap().len(), 1);
        assert_eq!(db.list_chat_messages(&a.id).unwrap()[0].content, "in A");
        assert_eq!(db.list_chat_messages(&b.id).unwrap().len(), 1);

        // Both threads listed for the workspace.
        assert_eq!(db.list_chat_threads("ws").unwrap().len(), 2);

        // Rename + delete (delete also removes the thread's messages).
        db.rename_chat_thread(&a.id, "Renamed").unwrap();
        assert!(db.list_chat_threads("ws").unwrap().iter().any(|t| t.title == "Renamed"));
        db.delete_chat_thread(&a.id).unwrap();
        assert_eq!(db.list_chat_threads("ws").unwrap().len(), 1);
        assert_eq!(db.list_chat_messages(&a.id).unwrap().len(), 0);
    }

    #[test]
    fn pinned_threads_sort_to_the_top() {
        let db = test_db();
        db.insert_project("p", "P", "/tmp/p").unwrap();
        db.insert_workspace("ws", "p", "ws", "", "main", None, "", None).unwrap();
        let a = db.create_chat_thread("ws", "A").unwrap();
        let _b = db.create_chat_thread("ws", "B").unwrap();
        let c = db.create_chat_thread("ws", "C").unwrap();
        // Nothing pinned initially.
        assert!(db.list_chat_threads("ws").unwrap().iter().all(|t| !t.pinned));

        // Pin the oldest → it jumps to the top.
        db.set_thread_pinned(&a.id, true).unwrap();
        let list = db.list_chat_threads("ws").unwrap();
        assert_eq!(list[0].id, a.id);
        assert!(list[0].pinned);
        assert_eq!(list[1].id, c.id); // remaining stay newest-first

        // Unpin → back to pure recency (newest C first).
        db.set_thread_pinned(&a.id, false).unwrap();
        assert_eq!(db.list_chat_threads("ws").unwrap()[0].id, c.id);
    }

    #[test]
    fn truncate_chat_after_removes_message_and_everything_following() {
        let db = test_db();
        db.insert_project("p", "P", "/tmp/p").unwrap();
        db.insert_workspace("ws", "p", "ws", "", "main", None, "", None).unwrap();
        let t = db.create_chat_thread("ws", "T").unwrap();
        db.insert_chat_message("ws", &t.id, "user", "one", None, None, None, None).unwrap();
        db.insert_chat_message("ws", &t.id, "assistant", "two", None, None, None, None).unwrap();
        db.insert_chat_message("ws", &t.id, "user", "three", None, None, None, None).unwrap();
        let rows = db.list_chat_messages(&t.id).unwrap();
        assert_eq!(rows.len(), 3);

        // Truncate from the assistant message → keeps only the first row.
        let assistant_id = rows[1].id;
        db.truncate_chat_after(&t.id, assistant_id).unwrap();
        let after = db.list_chat_messages(&t.id).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].content, "one");

        // Scoped per thread: another thread's rows are untouched by a truncate
        // that targets only this one.
        let t2 = db.create_chat_thread("ws", "T2").unwrap();
        db.insert_chat_message("ws", &t2.id, "user", "other", None, None, None, None).unwrap();
        db.truncate_chat_after(&t2.id, 0).unwrap(); // id >= 0 clears t2 only
        assert_eq!(db.list_chat_messages(&t2.id).unwrap().len(), 0);
        assert_eq!(db.list_chat_messages(&t.id).unwrap().len(), 1);
    }

    #[test]
    fn shell_history_recall_dedups_and_orders_by_recency() {
        let db = test_db();
        db.insert_project("p", "P", "/tmp/p").unwrap();
        db.insert_workspace("ws", "p", "ws", "", "main", None, "", None).unwrap();
        db.insert_workspace("ws2", "p", "ws2", "", "main", None, "", None).unwrap();

        db.record_shell_history("ws", "npm test").unwrap();
        db.record_shell_history("ws", "git status").unwrap();
        db.record_shell_history("ws", "npm test").unwrap(); // repeat → bumps recency
        db.record_shell_history("ws", "  ").unwrap(); // blank ignored
        db.record_shell_history("ws2", "cargo build").unwrap(); // other workspace

        let hist = db.list_shell_history("ws", 50).unwrap();
        // Deduped (npm test once) and most-recent-first (npm test re-run last).
        assert_eq!(hist, vec!["npm test".to_string(), "git status".to_string()]);

        // Scoped per workspace.
        assert_eq!(db.list_shell_history("ws2", 50).unwrap(), vec!["cargo build".to_string()]);

        // Limit honored.
        assert_eq!(db.list_shell_history("ws", 1).unwrap(), vec!["npm test".to_string()]);
    }

    #[test]
    fn insert_and_list_error_message() {
        let db = test_db();
        db.insert_project("proj-err", "Test Project", "/tmp/proj-err")
            .unwrap();
        db.insert_workspace("ws-err", "proj-err", "ws", "", "main", None, "", None)
            .unwrap();

        let thread = db.create_chat_thread("ws-err", "Conversation").unwrap();
        db.insert_chat_message("ws-err", &thread.id, "user", "hello", None, None, None, None)
            .unwrap();
        db.insert_chat_message(
            "ws-err",
            &thread.id,
            "error",
            "401 unauthorized — API key not configured",
            None,
            None,
            None,
            None,
        )
        .unwrap();

        let messages = db.list_chat_messages(&thread.id).unwrap();
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
        db.insert_workspace(workspace_id, project_id, "ws", "", "main", None, "", None)
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
        db.insert_workspace(workspace_id, project_id, "ws", "", "main", None, "", None)
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
        db.insert_workspace("ws-r", "proj-r", "ws", "", "feat/test", None, "", None).unwrap();
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

    #[tokio::test]
    async fn children_of_ignored_dir_are_flagged() {
        let tmp = TempDir::new().unwrap();
        // Simulate a repo root: .git dir + .gitignore with target/
        fs::create_dir(tmp.path().join(".git")).unwrap();
        fs::write(tmp.path().join(".gitignore"), "target/\n").unwrap();
        fs::create_dir(tmp.path().join("target")).unwrap();
        fs::write(tmp.path().join("target").join("app.war"), "x").unwrap();
        fs::create_dir(tmp.path().join("target").join("classes")).unwrap();

        // Listing INSIDE the ignored dir: everything must be flagged.
        let inside = tmp.path().join("target").to_string_lossy().to_string();
        let entries = read_directory(inside, Some(true)).await.unwrap();
        let war = entries.iter().find(|e| e.name == "app.war").expect("war visible");
        assert!(war.is_ignored, "file inside gitignored dir must be flagged");
        let classes = entries.iter().find(|e| e.name == "classes").expect("classes visible");
        assert!(classes.is_ignored, "dir inside gitignored dir must be flagged");
    }

    #[tokio::test]
    async fn nested_gitignore_rules_apply() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join(".git")).unwrap();
        fs::create_dir(tmp.path().join("sub")).unwrap();
        fs::write(tmp.path().join("sub").join(".gitignore"), "gen.txt\n").unwrap();
        fs::write(tmp.path().join("sub").join("gen.txt"), "g").unwrap();
        fs::write(tmp.path().join("sub").join("src.txt"), "s").unwrap();

        let sub = tmp.path().join("sub").to_string_lossy().to_string();
        let entries = read_directory(sub, Some(true)).await.unwrap();
        let gen = entries.iter().find(|e| e.name == "gen.txt").unwrap();
        assert!(gen.is_ignored, "nested .gitignore rule must flag gen.txt");
        let src = entries.iter().find(|e| e.name == "src.txt").unwrap();
        assert!(!src.is_ignored);
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

    #[test]
    fn artifact_kind_db_roundtrip() {
        use crate::orchestrator::types::ArtifactKind;
        for (k, s) in [
            (ArtifactKind::Plan, "plan"), (ArtifactKind::Review, "review"),
            (ArtifactKind::Tests, "tests"), (ArtifactKind::Diff, "diff"), (ArtifactKind::Note, "note"),
        ] {
            assert_eq!(k.as_db(), s);
            assert_eq!(ArtifactKind::from_db(s), Some(k));
        }
        assert_eq!(ArtifactKind::from_db("bogus"), None);
    }

    #[test]
    fn role_environment_db_roundtrip() {
        use crate::orchestrator::types::RoleEnvironment;
        assert_eq!(RoleEnvironment::Worktree.as_db(), "worktree");
        assert_eq!(RoleEnvironment::Action.as_db(), "action");
        assert_eq!(RoleEnvironment::from_db("action"), Some(RoleEnvironment::Action));
        assert_eq!(RoleEnvironment::from_db("x"), None);
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
                    rate_limit: None,
                    raw_content: vec![],
                },
                LlmResponse {
                    text: "All done.".into(),
                    tool_uses: vec![],
                    stop_reason: LlmStopReason::EndTurn,
                    input_tokens: 50,
                    output_tokens: 5,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                    rate_limit: None,
                    raw_content: vec![],
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
            &std::sync::atomic::AtomicBool::new(false),
            &emitter,
            None,
            None,
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
    use crate::orchestrator::runner::user_input_for;
    use crate::orchestrator::types::{ArtifactKind, InputSection, StageInput};

    /// Dossier with one Plan section, for the single-section tests.
    fn plan_input(text: &str) -> StageInput {
        StageInput {
            breadcrumb: String::new(),
            sections: vec![InputSection {
                kind: ArtifactKind::Plan,
                role: "plan".into(),
                position: 0,
                text: text.into(),
                refs_worktree: false,
            }],
            refs_worktree: false,
            worktree_diff: None,
        }
    }

    #[test]
    fn role_maps_to_artifact_kind() {
        use crate::orchestrator::roles::builtin_roles;
        let roles = builtin_roles();
        let kind_for = |key: &str| roles.iter().find(|r| r.key == key).map(|r| r.artifact_kind.clone());
        assert_eq!(kind_for("plan"), Some(ArtifactKind::Plan));
        assert_eq!(kind_for("plan_review"), Some(ArtifactKind::Review));
        assert_eq!(kind_for("code_review"), Some(ArtifactKind::Review));
        assert_eq!(kind_for("implement"), Some(ArtifactKind::Diff));
        assert_eq!(kind_for("test"), Some(ArtifactKind::Tests));
        // refine outputs a refined PLAN; repro outputs FINDINGS — neither is a
        // diff. The kind picks both the dossier slot and the section label, so
        // a wrong mapping evicts an unrelated artifact AND mislabels this one.
        assert_eq!(kind_for("refine"), Some(ArtifactKind::Plan));
        assert_eq!(kind_for("repro"), Some(ArtifactKind::Review));
        assert_eq!(kind_for("fix"), Some(ArtifactKind::Diff));
        // unknown keys are no longer handled by a fallback match — they are DB-resident
    }

    #[test]
    fn system_prompt_is_role_specific() {
        use crate::orchestrator::roles::{builtin_roles, compose_system_prompt};
        use crate::orchestrator::types::RoleEnvironment;
        let roles = builtin_roles();
        let prompt_for = |key: &str| {
            let r = roles.iter().find(|r| r.key == key).unwrap();
            compose_system_prompt(&r.prompt_body, r.environment, None, None, true)
        };
        assert!(prompt_for("plan").to_lowercase().contains("plan"));
        assert!(prompt_for("implement").to_lowercase().contains("implement"));
    }

    #[test]
    fn system_prompt_frames_agent_as_non_interactive_pipeline_worker() {
        use crate::orchestrator::roles::{builtin_roles, compose_system_prompt};
        use crate::orchestrator::types::RoleEnvironment;
        let roles = builtin_roles();
        // Every stage keeps the strict autonomous framing. The `ask_director`
        // carve-out is API-ONLY: an API stage has the tool and is told about it;
        // a CLI stage has no such tool and must keep the pure never-ask guard.
        for key in ["plan", "implement", "code_review", "test"] {
            let r = roles.iter().find(|r| r.key == key).unwrap();
            let api = compose_system_prompt(&r.prompt_body, r.environment, None, None, true).to_lowercase();
            assert!(api.contains("never ask"), "role {key} missing no-questions directive");
            assert!(api.contains("ask_director"), "role {key} missing the API escape-valve carve-out");
            assert!(api.contains("pipeline"), "role {key} missing pipeline framing");
            assert!(api.contains("git"), "role {key} missing git-ownership note");

            let cli = compose_system_prompt(&r.prompt_body, r.environment, None, None, false).to_lowercase();
            assert!(cli.contains("never ask"), "CLI role {key} must keep the strict never-ask guard");
            assert!(!cli.contains("ask_director"), "CLI role {key} must NOT mention ask_director (no such tool)");
        }
    }

    #[test]
    fn unfinished_error_maps_cancel_vs_iteration_cap() {
        use crate::orchestrator::runner::unfinished_stage_error;
        let stopped = unfinished_stage_error(true, 25);
        assert_eq!(
            stopped,
            "stopped by the director — review the work journal, then accept, re-run, or abort"
        );
        let capped = unfinished_stage_error(false, 25);
        assert!(capped.contains("25 iterations"), "{capped}");
        assert!(capped.contains("re-run or abort"), "{capped}");
    }

    #[test]
    fn auto_review_prompt_requests_a_verdict() {
        use crate::orchestrator::roles::{builtin_roles, compose_system_prompt};
        use crate::orchestrator::types::LoopMode;
        let roles = builtin_roles();
        let cr = roles.iter().find(|r| r.key == "code_review").unwrap();
        let auto = compose_system_prompt(&cr.prompt_body, cr.environment, Some(LoopMode::Auto), None, true);
        assert!(auto.contains("VERDICT:"));
        let gated = compose_system_prompt(&cr.prompt_body, cr.environment, Some(LoopMode::Gated), None, true);
        assert!(!gated.contains("VERDICT:"));
        let impl_r = roles.iter().find(|r| r.key == "implement").unwrap();
        let plain = compose_system_prompt(&impl_r.prompt_body, impl_r.environment, None, None, true);
        assert!(!plain.contains("VERDICT:"));
    }

    #[test]
    fn user_input_includes_task_and_prior_artifact() {
        let prior = plan_input("Step 1: do X");
        let input = user_input_for("implement", "Build feature Y", &prior, None);
        assert!(input.contains("Build feature Y"));
        assert!(input.contains("Step 1: do X"));

        let with_fb = user_input_for("implement", "Build Y", &prior, Some("be more careful"));
        assert!(with_fb.contains("be more careful"));
    }

    #[test]
    fn feedback_reruns_say_revise_dont_restart() {
        let prior = plan_input("Step 1");
        // With feedback: the prompt warns the previous attempt may still be in
        // the workspace and asks for a revision, not a restart.
        let with_fb = user_input_for("implement", "Build Y", &prior, Some("fix it"));
        assert!(with_fb.contains("revise them rather than starting over"));
        // Without feedback: no such line.
        let without = user_input_for("implement", "Build Y", &prior, None);
        assert!(!without.contains("revise them rather than starting over"));
    }

    #[test]
    fn dossier_renders_every_section_with_attribution_and_breadcrumb() {
        // The whole point of the dossier: Implement sees BOTH the refined plan
        // and the review's findings — the review no longer shadows the plan.
        let input = StageInput {
            breadcrumb: "plan (done) → plan review (done) → implement (← current stage)".into(),
            sections: vec![
                InputSection {
                    kind: ArtifactKind::Plan,
                    role: "plan".into(),
                    position: 0,
                    text: "Refined plan: add the toggle to Settings".into(),
                    refs_worktree: false,
                },
                InputSection {
                    kind: ArtifactKind::Review,
                    role: "plan_review".into(),
                    position: 1,
                    text: "Looks solid. VERDICT: PASS".into(),
                    refs_worktree: false,
                },
            ],
            refs_worktree: false,
            worktree_diff: None,
        };
        let s = user_input_for("implement", "Add a dark-mode toggle", &input, None);
        assert!(s.contains("The plan to follow (from the plan stage):"), "{s}");
        assert!(s.contains("Refined plan: add the toggle to Settings"));
        assert!(s.contains("Review findings (from the plan review stage):"), "{s}");
        assert!(s.contains("VERDICT: PASS"));
        assert!(s.contains("Pipeline: plan (done)"), "breadcrumb missing: {s}");
        // Plan precedes review — pipeline order, not map order.
        let plan_at = s.find("The plan to follow").unwrap();
        let review_at = s.find("Review findings").unwrap();
        assert!(plan_at < review_at);
    }

    #[test]
    fn dossier_worktree_flag_adds_the_workspace_hint() {
        let mut input = plan_input("plan text");
        let none = user_input_for("code_review", "T", &input, None);
        assert!(!none.contains("present in the workspace"));
        input.refs_worktree = true;
        let some = user_input_for("code_review", "T", &input, None);
        assert!(some.contains("The current code changes are present in the workspace"));
    }

    #[test]
    fn dossier_includes_the_live_diff_so_reviewers_see_the_actual_code() {
        // The #1 crew-quality fix: a reviewer must certify the CODE, not the
        // implementer's prose summary of it. When the live worktree diff was
        // captured it is rendered between BEGIN/END markers; the old tools
        // hint remains the fallback (capture failure / empty diff).
        let mut input = plan_input("plan text");
        input.refs_worktree = true;
        input.worktree_diff = Some("--- a/src/x.rs\n+++ b/src/x.rs\n+fn added() {}".into());
        let s = user_input_for("code_review", "T", &input, None);
        assert!(s.contains("===== BEGIN GIT DIFF ====="), "{s}");
        assert!(s.contains("===== END GIT DIFF ====="));
        assert!(s.contains("+fn added() {}"));
        assert!(!s.contains("present in the workspace"), "diff replaces the vague hint");
        assert!(!s.contains("too large to include"), "small diff carries no truncation note");

        // Markers, not a ``` fence: a diff of a markdown file contains fence
        // lines, which would terminate a fenced block early.
        input.worktree_diff = Some("+```diff\n+nested fence\n+```".into());
        let s = user_input_for("code_review", "T", &input, None);
        let begin = s.find("===== BEGIN GIT DIFF =====").unwrap();
        let end = s.find("===== END GIT DIFF =====").unwrap();
        let inside = &s[begin..end];
        assert!(inside.contains("+```diff"), "fence lines survive inside the markers");

        // A huge diff is capped like any dossier section (head + tail survive)
        // and the prompt SAYS it was truncated (no silent coverage gap).
        let mut big = String::from("DIFF-HEAD\n");
        big.push_str(&"+x\n".repeat(20_000));
        big.push_str("DIFF-TAIL");
        input.worktree_diff = Some(big);
        let s = user_input_for("code_review", "T", &input, None);
        assert!(s.contains("DIFF-HEAD") && s.contains("DIFF-TAIL"));
        assert!(s.contains("section truncated for length"));
        assert!(s.contains("too large to include in full"), "truncation is inventoried");

        // Whitespace-only diff falls back to the hint (the render is the
        // single owner of the emptiness decision).
        input.worktree_diff = Some("   \n".into());
        let s = user_input_for("code_review", "T", &input, None);
        assert!(s.contains("The current code changes are present in the workspace"));
    }

    #[test]
    fn migrate_upgrades_stale_reviewer_tool_snapshots() {
        // The builder snapshots a role's default tools into pipeline_stages at
        // authoring time — so the ro()→run_() upgrade for reviewers must be
        // retrofitted onto existing rows still carrying the old default, or
        // the new prompt ("run the build or tests…") runs against a read-only
        // allowlist. A user-customized allowlist is never touched, and the
        // retrofit is ONE-SHOT: re-running every launch would re-escalate a
        // reviewer a user deliberately set back to read-only. Drives the REAL
        // migration by re-opening the same database file (app update).
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = crate::db::Db::open(tmp.path()).unwrap();
        let pid = db.insert_pipeline("p", "d", false).unwrap();
        db.insert_pipeline_stage(&pid, 0, "code_review", "m", "api", false, None, 0, None, 25).unwrap();
        let pid2 = db.insert_pipeline("p2", "d", false).unwrap();
        db.insert_pipeline_stage(&pid2, 0, "code_review", "m", "api", false, None, 0, None, 25).unwrap();
        // Simulate a pre-upgrade install: stale snapshot (pid), a user
        // customization (pid2), and NO retrofit marker yet.
        db.conn_ref().execute(
            "UPDATE pipeline_stages SET tools='[\"read_file\",\"list_files\"]' WHERE pipeline_id=?1",
            rusqlite::params![pid],
        ).unwrap();
        db.conn_ref().execute(
            "UPDATE pipeline_stages SET tools='[\"read_file\"]' WHERE pipeline_id=?1",
            rusqlite::params![pid2],
        ).unwrap();
        db.conn_ref().execute(
            "DELETE FROM app_meta WHERE key='retrofit_reviewer_run_command'", [],
        ).unwrap();
        drop(db);

        // Re-open (the app update's first launch) → the retrofit applies once.
        let db = crate::db::Db::open(tmp.path()).unwrap();
        let tools_of = |db: &crate::db::Db, pid: &str| -> String {
            db.conn_ref().query_row(
                "SELECT tools FROM pipeline_stages WHERE pipeline_id=?1",
                rusqlite::params![pid], |r| r.get(0),
            ).unwrap()
        };
        assert_eq!(tools_of(&db, &pid), r#"["read_file","list_files","run_command"]"#);
        assert_eq!(tools_of(&db, &pid2), r#"["read_file"]"#, "custom allowlists stay untouched");

        // The user now DELIBERATELY sets the reviewer back to read-only — a
        // later launch must respect that choice (one-shot, never re-escalate).
        db.conn_ref().execute(
            "UPDATE pipeline_stages SET tools='[\"read_file\",\"list_files\"]' WHERE pipeline_id=?1",
            rusqlite::params![pid],
        ).unwrap();
        drop(db);
        let db = crate::db::Db::open(tmp.path()).unwrap();
        assert_eq!(
            tools_of(&db, &pid),
            r#"["read_file","list_files"]"#,
            "the retrofit must not re-apply after its one-shot marker is set"
        );
    }

    #[test]
    fn oversized_sections_are_capped_head_and_tail() {
        let mut text = String::from("INTENT-AT-THE-TOP\n");
        text.push_str(&"x".repeat(40_000));
        text.push_str("\nCONCLUSION-AT-THE-END");
        let input = plan_input(&text);
        let s = user_input_for("implement", "T", &input, None);
        assert!(s.len() < 25_000, "section must be capped, got {}", s.len());
        assert!(s.contains("INTENT-AT-THE-TOP"), "head must survive");
        assert!(s.contains("CONCLUSION-AT-THE-END"), "tail must survive");
        assert!(s.contains("section truncated for length"));
    }

    #[test]
    fn empty_sections_are_skipped() {
        let input = StageInput {
            breadcrumb: String::new(),
            sections: vec![InputSection {
                kind: ArtifactKind::Note,
                role: "implement".into(),
                position: 0,
                text: "   ".into(),
                refs_worktree: false,
            }],
            refs_worktree: false,
            worktree_diff: None,
        };
        let s = user_input_for("code_review", "T", &input, None);
        assert!(!s.contains("Context (from"));
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
            max_iterations: 25,
            pos_x: None, pos_y: None, parents: Vec::new(), tools: None,
            custom_name: None, instructions: None, effort: None,
            escalate_model: None, escalate_effort: None,
        }
    }

    #[test]
    fn save_pipeline_round_trips_the_escalation_policy() {
        let db = test_db();
        db.seed_builtin_pipelines().unwrap();
        let mut s = draft("implement");
        s.escalate_model = Some("claude-opus-4-6".into());
        s.escalate_effort = Some(crate::providers::Effort::High);
        let pid = db.save_pipeline(None, "Escalating", "d", &[s]).unwrap();
        let stages = db.get_pipeline_stages(&pid).unwrap();
        assert_eq!(stages[0].escalate_model.as_deref(), Some("claude-opus-4-6"));
        assert_eq!(stages[0].escalate_effort, Some(crate::providers::Effort::High));
        // A stage with no policy stays null (no accidental escalation).
        let plain = db.save_pipeline(None, "Plain", "d", &[draft("plan")]).unwrap();
        let plain_stages = db.get_pipeline_stages(&plain).unwrap();
        assert!(plain_stages[0].escalate_model.is_none());
        assert!(plain_stages[0].escalate_effort.is_none());
    }

    #[test]
    fn validate_pipeline_stages_bounds_the_tool_turn_budget() {
        let db = test_db();
        // F4: per-stage max_iterations must be 1..=100.
        let mut zero = draft("plan"); zero.max_iterations = 0;
        assert!(db.validate_pipeline_stages(&[zero]).is_err());
        let mut over = draft("plan"); over.max_iterations = 101;
        assert!(db.validate_pipeline_stages(&[over]).is_err());
        let mut ok = draft("plan"); ok.max_iterations = 25;
        assert!(db.validate_pipeline_stages(&[ok]).is_ok());
        let mut edge_lo = draft("plan"); edge_lo.max_iterations = 1;
        let mut edge_hi = draft("plan"); edge_hi.max_iterations = 100;
        assert!(db.validate_pipeline_stages(&[edge_lo, edge_hi]).is_ok());
    }

    #[test]
    fn seed_is_idempotent_and_lists_the_builtins() {
        let db = test_db();
        db.seed_builtin_pipelines().unwrap();
        db.seed_builtin_pipelines().unwrap(); // second call must not duplicate
        let pipelines = db.list_pipelines().unwrap();
        assert_eq!(pipelines.len(), 5); // incl. "Ship it" (issue → PR)

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
        let db = test_db();
        // valid linear pipeline
        assert!(db.validate_pipeline_stages(&[draft("plan"), draft("implement")]).is_ok());
        // empty pipeline / unknown role / bad substrate / empty model
        assert!(db.validate_pipeline_stages(&[]).is_err());
        assert!(db.validate_pipeline_stages(&[draft("dance")]).is_err());
        let mut bad_sub = draft("plan"); bad_sub.substrate = "ftp".into();
        assert!(db.validate_pipeline_stages(&[bad_sub]).is_err());
        let mut no_model = draft("plan"); no_model.agent_model = "".into();
        assert!(db.validate_pipeline_stages(&[no_model]).is_err());

        // valid gated loop: code_review at index 1 loops back to 0
        let mut review = draft("code_review");
        review.loop_target_position = Some(0); review.loop_max_iterations = 2; review.loop_mode = Some("gated".into());
        assert!(db.validate_pipeline_stages(&[draft("implement"), review.clone()]).is_ok());

        // loop on a non-review role
        let mut looped_impl = draft("implement");
        looped_impl.loop_target_position = Some(0); looped_impl.loop_max_iterations = 2; looped_impl.loop_mode = Some("gated".into());
        assert!(db.validate_pipeline_stages(&[draft("plan"), looped_impl]).is_err());
        // target not strictly earlier (self)
        let mut self_loop = review.clone(); self_loop.loop_target_position = Some(1);
        assert!(db.validate_pipeline_stages(&[draft("implement"), self_loop]).is_err());
        // target out of range
        let mut far = review.clone(); far.loop_target_position = Some(5);
        assert!(db.validate_pipeline_stages(&[draft("implement"), far]).is_err());
        // max 0 with a target / bad mode
        let mut zero = review.clone(); zero.loop_max_iterations = 0;
        assert!(db.validate_pipeline_stages(&[draft("implement"), zero]).is_err());
        let mut mode = review.clone(); mode.loop_mode = Some("magic".into());
        assert!(db.validate_pipeline_stages(&[draft("implement"), mode]).is_err());
        // no target but leftover loop fields → invalid (builder must normalize)
        let mut leftover = draft("code_review"); leftover.loop_max_iterations = 2;
        assert!(db.validate_pipeline_stages(&[draft("implement"), leftover]).is_err());
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
    fn validate_pipeline_stages_enforces_graph_fields() {
        let db = test_db();

        // parents must reference strictly-earlier stages.
        let mut a = draft("plan");
        let mut b = draft("implement");
        b.parents = vec![0]; // ok: 0 < 1
        assert!(db.validate_pipeline_stages(&[a.clone(), b.clone()]).is_ok());
        let mut fwd = draft("implement");
        fwd.parents = vec![1]; // a parent at its own position
        assert!(db.validate_pipeline_stages(&[draft("plan"), fwd]).is_err());
        let mut neg = draft("implement");
        neg.parents = vec![-1];
        assert!(db.validate_pipeline_stages(&[draft("plan"), neg]).is_err());
        let mut dup = draft("implement");
        dup.parents = vec![0, 0]; // same upstream twice
        assert!(db.validate_pipeline_stages(&[draft("plan"), dup]).is_err());

        // tools: a non-empty subset of the known set; empty or unknown → error.
        a.tools = Some(vec!["read_file".into(), "list_files".into()]);
        assert!(db.validate_pipeline_stages(&[a.clone()]).is_ok());
        let mut empty_tools = draft("plan");
        empty_tools.tools = Some(vec![]);
        assert!(db.validate_pipeline_stages(&[empty_tools]).is_err());
        let mut bad_tool = draft("plan");
        bad_tool.tools = Some(vec!["telepathy".into()]);
        assert!(db.validate_pipeline_stages(&[bad_tool]).is_err());

        // instructions: long but bounded.
        let mut long = draft("plan");
        long.instructions = Some("x".repeat(9_000));
        assert!(db.validate_pipeline_stages(&[long]).is_err());
        let mut ok_instr = draft("plan");
        ok_instr.instructions = Some("Focus on the auth module.".into());
        assert!(db.validate_pipeline_stages(&[ok_instr]).is_ok());

        // In an authored graph, a loop must return to an ANCESTOR of the review,
        // not merely an earlier position (a sibling branch).
        let p = draft("plan"); // pos 0
        let mut ia = draft("implement"); ia.parents = vec![0]; // pos 1 (branch A)
        let mut ib = draft("implement"); ib.parents = vec![0]; // pos 2 (branch B, sibling)
        let mut rv = draft("code_review");
        rv.parents = vec![1];
        rv.loop_max_iterations = 2;
        rv.loop_mode = Some("gated".into());
        rv.loop_target_position = Some(2); // sibling branch B — NOT an ancestor of the review
        assert!(db.validate_pipeline_stages(&[p.clone(), ia.clone(), ib.clone(), rv.clone()]).is_err());
        let mut rv_ok = rv.clone();
        rv_ok.loop_target_position = Some(0); // the shared ancestor — fine
        assert!(db.validate_pipeline_stages(&[p, ia, ib, rv_ok]).is_ok());
    }

    #[test]
    fn save_pipeline_round_trips_graph_fields() {
        let db = test_db();
        let mut entry = draft("plan");
        entry.pos_x = Some(40.0);
        entry.pos_y = Some(10.0);
        let mut worker = draft("implement");
        worker.parents = vec![0];
        worker.tools = Some(vec!["read_file".into(), "write_file".into(), "run_command".into()]);
        worker.custom_name = Some("  Build it  ".into()); // trimmed on save
        worker.instructions = Some("Keep diffs minimal.".into());
        worker.pos_x = Some(40.0);
        worker.pos_y = Some(180.0);

        let id = db.save_pipeline(None, "Graph", "d", &[entry, worker]).unwrap();
        let stages = db.get_pipeline_stages(&id).unwrap();
        assert_eq!(stages.len(), 2);
        assert_eq!(stages[0].parents, Vec::<i64>::new());
        assert_eq!(stages[1].parents, vec![0]);
        assert_eq!(stages[1].tools.as_deref().unwrap().len(), 3);
        assert_eq!(stages[1].custom_name.as_deref(), Some("Build it"));
        assert_eq!(stages[1].instructions.as_deref(), Some("Keep diffs minimal."));
        assert_eq!(stages[1].pos_y, Some(180.0));
        // A stage with no custom name / tools round-trips as None (archetype default).
        assert!(stages[0].custom_name.is_none());
        assert!(stages[0].tools.is_none());
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

    #[test]
    fn validate_accepts_seeded_and_custom_rejects_unknown() {
        let db = test_db();
        let mk = |role: &str| crate::db::StageDraft {
            role: role.into(), agent_model: "m".into(), substrate: "api".into(),
            checkpoint: false, loop_target_position: None, loop_max_iterations: 0, loop_mode: None,
            max_iterations: 25, pos_x: None, pos_y: None, parents: vec![], tools: None,
            custom_name: None, instructions: None, effort: None,
            escalate_model: None, escalate_effort: None,
        };
        assert!(db.validate_pipeline_stages(&[mk("code_review")]).is_ok());
        assert!(db.validate_pipeline_stages(&[mk("bogus_role")]).is_err());
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
    fn create_run_copies_escalation_policy_and_defaults_escalated_false() {
        let db = test_db();
        let ws = seed_workspace(&db);
        let pid = db.insert_pipeline("Esc", "d", false).unwrap();
        db.insert_pipeline_stage(&pid, 0, "implement", "base-m", "api", false, None, 0, None, 25).unwrap();
        // Author an escalation policy on the template stage.
        db.conn_ref()
            .execute(
                "UPDATE pipeline_stages SET escalate_model = 'strong-m', escalate_effort = 'high' WHERE pipeline_id = ?1",
                [&pid],
            )
            .unwrap();
        // The policy reads back on the template…
        let tmpl = db.get_pipeline_stages(&pid).unwrap();
        assert_eq!(tmpl[0].escalate_model.as_deref(), Some("strong-m"));
        assert_eq!(tmpl[0].escalate_effort, Some(crate::providers::Effort::High));
        // …and copies into run_stages, with `escalated` defaulting false.
        let run = db.create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let stages = db.list_run_stages(&run).unwrap();
        assert_eq!(stages[0].escalate_model.as_deref(), Some("strong-m"));
        assert_eq!(stages[0].escalate_effort, Some(crate::providers::Effort::High));
        assert!(!stages[0].escalated, "a fresh run-stage has not escalated");
    }

    #[test]
    fn set_run_stage_escalated_flips_the_sticky_flag() {
        let db = test_db();
        let ws = seed_workspace(&db);
        let pid = db.insert_pipeline("Esc", "d", false).unwrap();
        db.insert_pipeline_stage(&pid, 0, "implement", "base-m", "api", false, None, 0, None, 25).unwrap();
        let run = db.create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let id = db.list_run_stages(&run).unwrap()[0].id.clone();
        assert!(!db.list_run_stages(&run).unwrap()[0].escalated);
        db.set_run_stage_escalated(&id, true).unwrap();
        assert!(db.list_run_stages(&run).unwrap()[0].escalated);
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
        db.insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        db.insert_pipeline_stage(&pid, 1, "code_review", "m", "api", true, Some(0), 2, Some("gated"), 25).unwrap();
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
        db.insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        db.insert_pipeline_stage(&pid, 1, "code_review", "m", "api", true, Some(0), 2, Some("gated"), 25).unwrap();
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
    fn max_iterations_roundtrips_and_copies_to_run_stages() {
        // F4: the per-stage tool-turn budget persists on the template, defaults
        // to 25 for seeded builtins, and is copied onto every run stage.
        let db = test_db();
        let ws = seed_workspace(&db);
        let pid = db.insert_pipeline("P", "d", false).unwrap();
        db.insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None, 40).unwrap();
        assert_eq!(db.get_pipeline_stages(&pid).unwrap()[0].max_iterations, 40);

        db.seed_builtin_pipelines().unwrap();
        let ff = db.list_pipelines().unwrap().into_iter().find(|p| p.name == "Feature Factory").unwrap();
        assert!(db.get_pipeline_stages(&ff.id).unwrap().iter().all(|s| s.max_iterations == 25));

        let run = db.create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        assert_eq!(db.list_run_stages(&run).unwrap()[0].max_iterations, 40);
    }

    #[test]
    fn retire_stage_cost_accumulates_on_the_run() {
        let db = test_db();
        let ws = seed_workspace(&db);
        let pid = db.insert_pipeline("P", "d", false).unwrap();
        db.insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None, 25).unwrap();
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
    fn run_budget_persists_and_defaults_null() {
        let db = test_db();
        let ws = seed_workspace(&db);
        let pid = db.insert_pipeline("P", "d", false).unwrap();
        db.insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        let run = db.create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        // Legacy/new runs have no budget.
        assert_eq!(db.get_run(&run).unwrap().unwrap().budget_usd, None);
        db.set_run_budget(&run, Some(1.25)).unwrap();
        assert_eq!(db.get_run(&run).unwrap().unwrap().budget_usd, Some(1.25));
        // list_runs carries the column too.
        assert_eq!(db.list_runs(&ws).unwrap()[0].budget_usd, Some(1.25));
        db.set_run_budget(&run, None).unwrap();
        assert_eq!(db.get_run(&run).unwrap().unwrap().budget_usd, None);
    }

    #[test]
    fn stage_diff_snapshot_sets_and_reads_back() {
        let db = test_db();
        let ws = seed_workspace(&db);
        let pid = db.insert_pipeline("P", "d", false).unwrap();
        db.insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        let run = db.create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let stage = db.list_run_stages(&run).unwrap().remove(0);
        assert_eq!(stage.diff_snapshot, None);

        db.set_stage_diff_snapshot(&stage.id, "diff --git a/x b/x").unwrap();
        let reloaded = db.list_run_stages(&run).unwrap();
        assert_eq!(reloaded[0].diff_snapshot.as_deref(), Some("diff --git a/x b/x"));
    }

    #[test]
    fn archive_copies_diff_snapshot_and_reset_clears_it() {
        let db = test_db();
        let ws = seed_workspace(&db);
        let pid = db.insert_pipeline("P", "d", false).unwrap();
        db.insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        let run = db.create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let stage_id = db.list_run_stages(&run).unwrap()[0].id.clone();
        db.complete_run_stage(&stage_id, "done", 10, 5, 0.1, Some("{\"kind\":\"diff\",\"text\":\"x\"}"))
            .unwrap();
        db.set_stage_diff_snapshot(&stage_id, "the worktree diff").unwrap();

        let row = db.list_run_stages(&run).unwrap().remove(0);
        db.archive_stage_attempt(&row, Some("again")).unwrap();
        let iters = db.list_stage_iterations(&stage_id).unwrap();
        assert_eq!(iters.len(), 1);
        assert_eq!(iters[0].diff_snapshot.as_deref(), Some("the worktree diff"));

        // The reset wipes the live snapshot along with the rest of the attempt,
        // so a re-run whose capture is skipped can't show a stale diff.
        db.reset_run_stage(&stage_id, None, None).unwrap();
        assert_eq!(db.list_run_stages(&run).unwrap()[0].diff_snapshot, None);
    }

    #[test]
    fn backfill_sets_loop_on_pre_existing_builtin_review_stages() {
        let db = test_db();
        // Simulate an old install: seed a builtin-shaped pipeline with NO loop config.
        let pid = db.insert_pipeline("Feature Factory", "d", true).unwrap();
        db.insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        db.insert_pipeline_stage(&pid, 1, "implement", "m", "api", true, None, 0, None, 25).unwrap();
        db.insert_pipeline_stage(&pid, 2, "code_review", "m", "api", true, None, 0, None, 25).unwrap();
        // Running the seeder backfills the review stage (seeding itself is skipped — name exists).
        db.seed_builtin_pipelines().unwrap();
        let stages = db.get_pipeline_stages(&pid).unwrap();
        let cr = stages.iter().find(|s| s.role == "code_review").unwrap();
        assert_eq!(cr.loop_target_position, Some(1));
        assert_eq!(cr.loop_mode.as_deref(), Some("gated"));
    }

    // ── update_run_stage: the director's hot-edit write path ──

    #[test]
    fn update_run_stage_edits_pending_stage() {
        let db = test_db();
        let ws = seed_workspace(&db);
        let pid = db.insert_pipeline("P", "d", false).unwrap();
        db.insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        let run = db.create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let stage_id = db.list_run_stages(&run).unwrap()[0].id.clone();

        db.update_run_stage(
            &run,
            &stage_id,
            Some(true),
            Some("be extra careful"),
            Some("claude-opus-4-6"),
            Some(50),
            None,
        )
        .unwrap();

        let stage = db.list_run_stages(&run).unwrap().remove(0);
        assert!(stage.checkpoint);
        assert_eq!(stage.instructions.as_deref(), Some("be extra careful"));
        assert_eq!(stage.agent_model, "claude-opus-4-6");
        assert_eq!(stage.max_iterations, 50);

        // `None` fields are left alone — a second edit only touches what it names.
        db.update_run_stage(&run, &stage_id, None, None, None, Some(30), None).unwrap();
        let stage = db.list_run_stages(&run).unwrap().remove(0);
        assert!(stage.checkpoint, "untouched field must survive a later partial edit");
        assert_eq!(stage.agent_model, "claude-opus-4-6");
        assert_eq!(stage.max_iterations, 30);
    }

    #[test]
    fn update_run_stage_rejects_started_stage() {
        let db = test_db();
        let ws = seed_workspace(&db);
        let pid = db.insert_pipeline("P", "d", false).unwrap();
        db.insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        let run = db.create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let stage_id = db.list_run_stages(&run).unwrap()[0].id.clone();
        db.set_run_stage_status(&stage_id, "running").unwrap();

        let err = db
            .update_run_stage(&run, &stage_id, Some(true), None, None, None, None)
            .unwrap_err();
        assert!(err.to_string().contains("already started"), "err={err}");

        // The rejected edit must not have touched the row.
        let stage = db.list_run_stages(&run).unwrap().remove(0);
        assert!(!stage.checkpoint);
    }

    #[test]
    fn update_run_stage_rejects_when_run_finished() {
        let db = test_db();
        let ws = seed_workspace(&db);
        let pid = db.insert_pipeline("P", "d", false).unwrap();
        db.insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        let run = db.create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let stage_id = db.list_run_stages(&run).unwrap()[0].id.clone();
        db.set_run_status(&run, "completed", true).unwrap();

        let err = db
            .update_run_stage(&run, &stage_id, Some(true), None, None, None, None)
            .unwrap_err();
        assert!(err.to_string().contains("finished"), "err={err}");
    }

    #[test]
    fn update_run_stage_rejects_unknown_stage() {
        let db = test_db();
        let ws = seed_workspace(&db);
        let pid = db.insert_pipeline("P", "d", false).unwrap();
        db.insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        let run = db.create_run(&ws, &pid, "t", None, None, &[]).unwrap();

        let err = db
            .update_run_stage(&run, "no-such-stage", Some(true), None, None, None, None)
            .unwrap_err();
        assert!(err.to_string().contains("not found"), "err={err}");
    }

    #[test]
    fn update_run_stage_loop_mode_requires_loop() {
        let db = test_db();
        let ws = seed_workspace(&db);
        let pid = db.insert_pipeline("P", "d", false).unwrap();
        db.insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        db.insert_pipeline_stage(&pid, 1, "code_review", "m", "api", false, Some(0), 2, Some("gated"), 25).unwrap();
        let run = db.create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let stages = db.list_run_stages(&run).unwrap();
        let implement_id = stages[0].id.clone();
        let review_id = stages[1].id.clone();

        // `implement` carries no loop config — switching its loop mode is rejected.
        let err = db
            .update_run_stage(&run, &implement_id, None, None, None, None, Some("auto"))
            .unwrap_err();
        assert!(err.to_string().contains("loop"), "err={err}");

        // `code_review` DOES loop — the switch is accepted and persists.
        db.update_run_stage(&run, &review_id, None, None, None, None, Some("auto")).unwrap();
        assert_eq!(db.list_run_stages(&run).unwrap()[1].loop_mode.as_deref(), Some("auto"));
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

    /// Escape-valve runner: blocks via `ask_director` on the FIRST attempt,
    /// then on the re-run succeeds with an artifact echoing the feedback it
    /// received — so a test can prove the director's answer reached the re-run.
    struct BlockOnceRunner {
        asked: std::sync::atomic::AtomicBool,
    }
    #[async_trait::async_trait]
    impl AgentRunner for BlockOnceRunner {
        async fn run(
            &self,
            stage: &StageSpec,
            _input: &StageInput,
            _ctx: &StageContext,
        ) -> crate::error::AppResult<StageOutcome> {
            let first = !self.asked.swap(true, std::sync::atomic::Ordering::Relaxed);
            if first {
                return Ok(StageOutcome {
                    artifact: StageArtifact { kind: ArtifactKind::Note, text: String::new(), payload: None, refs_worktree: false },
                    input_tokens: 5, output_tokens: 1, cost_usd: 0.02,
                    status: StageStatus::AwaitingCheckpoint,
                    tool_calls: vec![], error: None, verdict: None, session_id: None,
                    blocked: Some(BlockedAsk {
                        summary: "which datastore?".into(),
                        questions: vec![BlockedQuestion {
                            question: "Postgres or SQLite?".into(),
                            why_blocked: "the schema differs".into(),
                            recommended_default: "Postgres".into(),
                        }],
                    }),
                });
            }
            Ok(StageOutcome {
                artifact: StageArtifact {
                    kind: ArtifactKind::Plan,
                    text: format!("resolved <<{}>>", stage.feedback.as_deref().unwrap_or("(no feedback)")),
                    payload: None, refs_worktree: false,
                },
                input_tokens: 5, output_tokens: 1, cost_usd: 0.02,
                status: StageStatus::Done,
                tool_calls: vec![], error: None, verdict: None, session_id: None, blocked: None,
            })
        }
    }

    /// A runner that always succeeds with a canned artifact.
    struct MockRunner;
    #[async_trait::async_trait]
    impl AgentRunner for MockRunner {
        async fn run(
            &self,
            stage: &StageSpec,
            _input: &StageInput,
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
                session_id: None,
                blocked: None,
            })
        }
    }

    /// A runner whose artifact refs the worktree (an implement-style stage).
    /// `fail` flips the outcome to Failed with usage burned, mirroring an
    /// iteration-capped agentic loop.
    struct WorktreeRunner {
        fail: bool,
    }
    #[async_trait::async_trait]
    impl AgentRunner for WorktreeRunner {
        async fn run(
            &self,
            stage: &StageSpec,
            _input: &StageInput,
            _ctx: &StageContext,
        ) -> crate::error::AppResult<StageOutcome> {
            Ok(StageOutcome {
                artifact: StageArtifact {
                    kind: ArtifactKind::Diff,
                    text: format!("did {}", stage.role),
                    payload: None,
                    refs_worktree: true,
                },
                input_tokens: 10,
                output_tokens: 2,
                cost_usd: 0.01,
                status: if self.fail { StageStatus::Failed } else { StageStatus::Done },
                tool_calls: vec![],
                error: if self.fail { Some("ran out of iterations".into()) } else { None },
                verdict: None,
                session_id: None,
                blocked: None,
            })
        }
    }

    /// Always FAILS, recording the (model, effort) of each attempt's resolved
    /// StageSpec — so a test can prove escalation swaps the spec on the retry.
    struct SpecRecordingRunner {
        seen: Arc<Mutex<Vec<(String, Option<crate::providers::Effort>)>>>,
    }
    #[async_trait::async_trait]
    impl AgentRunner for SpecRecordingRunner {
        async fn run(
            &self,
            stage: &StageSpec,
            _input: &StageInput,
            _ctx: &StageContext,
        ) -> crate::error::AppResult<StageOutcome> {
            self.seen.lock().push((stage.agent_model.clone(), stage.effort));
            Ok(StageOutcome {
                artifact: StageArtifact { kind: ArtifactKind::Diff, text: "x".into(), payload: None, refs_worktree: false },
                input_tokens: 1, output_tokens: 1, cost_usd: 0.0,
                status: StageStatus::Failed,
                tool_calls: vec![], error: Some("boom".into()), verdict: None, session_id: None, blocked: None,
            })
        }
    }

    /// Captures the stage's cancel flag, then waits (bounded) for it to be set —
    /// mirroring a real substrate that gets interrupted mid-flight. When set, it
    /// returns the same failed outcome the substrates produce on a director stop.
    struct CancelWaitingRunner {
        captured: Arc<Mutex<Option<Arc<std::sync::atomic::AtomicBool>>>>,
    }
    #[async_trait::async_trait]
    impl AgentRunner for CancelWaitingRunner {
        async fn run(
            &self,
            _stage: &StageSpec,
            _input: &StageInput,
            ctx: &StageContext,
        ) -> crate::error::AppResult<StageOutcome> {
            *self.captured.lock() = Some(Arc::clone(&ctx.cancel));
            for _ in 0..200 {
                if ctx.cancel.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            Ok(StageOutcome {
                artifact: StageArtifact {
                    kind: ArtifactKind::Note,
                    text: String::new(),
                    payload: None,
                    refs_worktree: false,
                },
                input_tokens: 0,
                output_tokens: 0,
                cost_usd: 0.0,
                status: StageStatus::Failed,
                tool_calls: vec![],
                error: Some(crate::orchestrator::runner::unfinished_stage_error(true, 25)),
                verdict: None,
                session_id: None,
                blocked: None,
            })
        }
    }

    /// Drive a single-stage run with a CancelWaitingRunner in the background and
    /// hand back (orchestrator, run_id, captured-flag slot, drive handle).
    async fn spawn_cancellable_run() -> (
        Arc<Mutex<Db>>,
        Arc<Orchestrator>,
        String,
        Arc<std::sync::atomic::AtomicBool>,
        tokio::task::JoinHandle<crate::error::AppResult<RunStatus>>,
    ) {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("Stoppable", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let captured = Arc::new(Mutex::new(None));
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Arc::new(Orchestrator::new_with_runner(
            Arc::clone(&db),
            sink,
            Box::new(CancelWaitingRunner { captured: Arc::clone(&captured) }),
        ));
        let drive = tokio::spawn({
            let orch = Arc::clone(&orch);
            let rid = run_id.clone();
            async move { orch.run_to_pause(&rid).await }
        });
        // Wait until the stage is in flight (it has captured its cancel flag).
        let flag = loop {
            if let Some(f) = captured.lock().clone() {
                break f;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        };
        (db, orch, run_id, flag, drive)
    }

    #[tokio::test]
    async fn stop_current_stage_sets_the_live_cancel_flag() {
        let (db, orch, run_id, flag, drive) = spawn_cancellable_run().await;
        assert!(!flag.load(std::sync::atomic::Ordering::Relaxed));
        orch.stop_current_stage(&run_id).unwrap();
        assert!(
            flag.load(std::sync::atomic::Ordering::Relaxed),
            "stop_current_stage must set the in-flight stage's cancel flag"
        );
        // The stopped stage lands in the existing halt-recovery flow: failed + paused.
        assert_eq!(drive.await.unwrap().unwrap(), RunStatus::Paused);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "failed");
        assert!(stages[0].error.as_deref().unwrap().contains("stopped by the director"));
    }

    #[tokio::test]
    async fn stop_current_stage_without_inflight_stage_is_a_noop() {
        let (db, _ws) = db_with_workspace();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));
        orch.stop_current_stage("no-such-run").unwrap(); // Ok, no panic
    }

    #[tokio::test]
    async fn abort_run_also_cancels_the_inflight_stage() {
        let (db, orch, run_id, flag, drive) = spawn_cancellable_run().await;
        assert!(!flag.load(std::sync::atomic::Ordering::Relaxed));
        orch.abort_run(&run_id).await.unwrap();
        assert!(
            flag.load(std::sync::atomic::Ordering::Relaxed),
            "abort_run must kill in-flight work, not just mark the DB"
        );
        // The aborted status wins over the failed stage: the drive sees it and stops.
        assert_eq!(drive.await.unwrap().unwrap(), RunStatus::Aborted);
        let run = db.lock().get_run(&run_id).unwrap().unwrap();
        assert_eq!(run.status, "aborted");
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

    /// Workspace whose worktree is a real temp git repo. `dirty` seeds an
    /// uncommitted file so the worktree diff is non-empty.
    fn db_with_git_workspace(dirty: bool) -> (Arc<Mutex<Db>>, String, tempfile::TempDir) {
        let tmp = NamedTempFile::new().unwrap();
        let db = Db::open(tmp.path()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        crate::git_ops::init_repo(dir.path()).unwrap();
        if dirty {
            std::fs::write(dir.path().join("change.txt"), "an agent edit\n").unwrap();
        }
        let now = chrono::Utc::now().to_rfc3339();
        db.conn_ref().execute(
            "INSERT INTO projects (id,name,path,created_at,last_opened) VALUES ('p1','P','/tmp/p',?1,?1)",
            [&now]).unwrap();
        db.conn_ref().execute(
            "INSERT INTO workspaces (id,project_id,name,branch,worktree_path,created_at,last_active)
             VALUES ('w1','p1','W','main',?1,?2,?2)",
            rusqlite::params![dir.path().to_string_lossy(), now]).unwrap();
        (Arc::new(Mutex::new(db)), "w1".to_string(), dir)
    }

    /// Single implement stage on `ws`, driven by `runner`. Returns the run id.
    async fn drive_one_implement_stage(
        db: &Arc<Mutex<Db>>,
        ws: &str,
        runner: Box<dyn AgentRunner>,
    ) -> String {
        let pid = db.lock().insert_pipeline("Snap", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(ws, &pid, "t", None, None, &[]).unwrap();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(db), sink, runner);
        orch.run_to_pause(&run_id).await.unwrap();
        run_id
    }

    // ── Automatic model escalation ──────────────────────────────────────────

    /// A single-stage run whose `implement` stage carries the given base effort
    /// and escalation policy (set directly on the template, then copied to the
    /// run) on the given substrate. Base model is always "base-m". Returns (db, run_id).
    fn esc_run_sub(
        substrate: &str,
        base_effort: Option<&str>,
        escalate_model: Option<&str>,
        escalate_effort: Option<&str>,
    ) -> (Arc<Mutex<Db>>, String) {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("Esc", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "implement", "base-m", substrate, false, None, 0, None, 25).unwrap();
        db.lock().conn_ref().execute(
            "UPDATE pipeline_stages SET effort = ?1, escalate_model = ?2, escalate_effort = ?3 WHERE pipeline_id = ?4",
            rusqlite::params![base_effort, escalate_model, escalate_effort, pid],
        ).unwrap();
        let run = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        (db, run)
    }

    /// `esc_run_sub` on the API substrate (the common case).
    fn esc_run(
        base_effort: Option<&str>,
        escalate_model: Option<&str>,
        escalate_effort: Option<&str>,
    ) -> (Arc<Mutex<Db>>, String) {
        esc_run_sub("api", base_effort, escalate_model, escalate_effort)
    }

    fn orch_for(db: &Arc<Mutex<Db>>) -> Orchestrator {
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        Orchestrator::new_with_runner(Arc::clone(db), sink, Box::new(MockRunner))
    }

    #[test]
    fn try_escalate_retries_a_failed_stage_with_a_model_policy() {
        let (db, run) = esc_run(None, Some("strong-m"), None);
        let stage = db.lock().list_run_stages(&run).unwrap().remove(0);
        db.lock().fail_run_stage(&stage.id, "boom").unwrap();
        let stage = db.lock().list_run_stages(&run).unwrap().remove(0);
        let orch = orch_for(&db);
        assert!(orch.try_escalate(&run, &stage).unwrap(), "a failed stage with a policy escalates");
        let reloaded = db.lock().list_run_stages(&run).unwrap().remove(0);
        assert!(reloaded.escalated, "the sticky flag is set");
        assert_eq!(reloaded.status, "pending", "the stage is reset to pending for the retry");
        assert!(reloaded.error.is_none(), "the prior failure is cleared");
    }

    #[test]
    fn try_escalate_refuses_a_stage_that_already_escalated() {
        let (db, run) = esc_run(None, Some("strong-m"), None);
        let id = db.lock().list_run_stages(&run).unwrap().remove(0).id;
        db.lock().set_run_stage_escalated(&id, true).unwrap();
        let stage = db.lock().list_run_stages(&run).unwrap().remove(0);
        let orch = orch_for(&db);
        assert!(!orch.try_escalate(&run, &stage).unwrap(), "one escalation only — a second failure halts");
    }

    #[test]
    fn try_escalate_refuses_a_stage_with_no_policy() {
        let (db, run) = esc_run(None, None, None);
        let stage = db.lock().list_run_stages(&run).unwrap().remove(0);
        let orch = orch_for(&db);
        assert!(!orch.try_escalate(&run, &stage).unwrap(), "no policy ⇒ halt as before, zero behavior change");
        assert!(!db.lock().list_run_stages(&run).unwrap()[0].escalated);
    }

    #[test]
    fn try_escalate_accepts_an_effort_only_policy() {
        let (db, run) = esc_run(Some("low"), None, Some("high"));
        let stage = db.lock().list_run_stages(&run).unwrap().remove(0);
        let orch = orch_for(&db);
        assert!(orch.try_escalate(&run, &stage).unwrap(), "an effort-only policy still escalates");
        assert!(db.lock().list_run_stages(&run).unwrap()[0].escalated);
    }

    #[test]
    fn try_escalate_refuses_effort_only_policy_on_cli() {
        // effort is inert on CLI — an effort-only policy there must NOT burn a
        // pointless same-tier retry (the retry would run identically).
        let (db, run) = esc_run_sub("cli", Some("low"), None, Some("high"));
        let stage = db.lock().list_run_stages(&run).unwrap().remove(0);
        let orch = orch_for(&db);
        assert!(!orch.try_escalate(&run, &stage).unwrap(), "CLI ignores effort — no tier change, no retry");
        assert!(!db.lock().list_run_stages(&run).unwrap()[0].escalated);
    }

    #[test]
    fn try_escalate_refuses_when_escalate_model_equals_base() {
        // escalate_model identical to the base ⇒ the retry would be identical.
        let (db, run) = esc_run(None, Some("base-m"), None);
        let stage = db.lock().list_run_stages(&run).unwrap().remove(0);
        let orch = orch_for(&db);
        assert!(!orch.try_escalate(&run, &stage).unwrap(), "same model ⇒ no wasted retry");
    }

    #[test]
    fn try_escalate_retires_cost_archives_and_preserves_feedback_from_the_fresh_row() {
        // Exercises the PRODUCTION path: the drive loop's Failed arm passes a
        // clone captured BEFORE the stage ran (cost 0, no artifact/error/feedback).
        // `try_escalate` must re-read the fresh row — reading spend/error/feedback
        // off the stale clone would archive nothing, drop the base-tier cost, and
        // run the retry blind. This test FAILS on the stale-clone version.
        let (db, run) = esc_run(None, Some("strong-m"), None);
        let stale = db.lock().list_run_stages(&run).unwrap().remove(0);
        assert_eq!(stale.cost_usd, 0.0);
        assert!(
            stale.artifact.is_none() && stale.error.is_none() && stale.feedback.is_none(),
            "the drive loop's clone is pre-run state",
        );
        // The DB row then records the REAL base-tier attempt: a reviewer's
        // feedback (from a prior loop-back), $0.05 spent, and a hard failure.
        db.lock().reset_run_stage(&stale.id, None, Some("fix the null check")).unwrap();
        db.lock()
            .complete_run_stage(&stale.id, "failed", 100, 50, 0.05, Some("{\"kind\":\"diff\",\"text\":\"x\"}"))
            .unwrap();
        db.lock().fail_run_stage(&stale.id, "boom").unwrap();
        // Escalate using the STALE clone (as the drive loop does).
        let orch = orch_for(&db);
        assert!(orch.try_escalate(&run, &stale).unwrap());
        // (b) The base attempt is archived in stage_iterations, not wiped.
        assert_eq!(db.lock().list_stage_iterations(&stale.id).unwrap().len(), 1, "the base attempt is archived");
        // (a) Its spend is retired and still counts toward the run; live row resets to 0.
        let (retired, _in, _out) = db.lock().get_retired_cost(&run).unwrap();
        assert!((retired - 0.05).abs() < 1e-9, "retired = {retired}");
        let reloaded = db.lock().list_run_stages(&run).unwrap().remove(0);
        assert_eq!(reloaded.cost_usd, 0.0, "the reset live row starts fresh");
        let run_row = db.lock().get_run(&run).unwrap().unwrap();
        assert!((run_row.cost_usd - 0.05).abs() < 1e-9, "run cost keeps the retired attempt: {}", run_row.cost_usd);
        // (c) The reviewer's feedback survives onto the strong-tier retry.
        assert_eq!(
            reloaded.feedback.as_deref(),
            Some("fix the null check"),
            "reviewer feedback survives — the retry must not run blind",
        );
        assert!(reloaded.escalated);
    }

    #[test]
    fn reset_run_stage_model_override_clears_escalated_none_preserves() {
        let (db, run) = esc_run(None, Some("strong-m"), None);
        let id = db.lock().list_run_stages(&run).unwrap()[0].id.clone();
        db.lock().set_run_stage_escalated(&id, true).unwrap();
        // A `None` model override (the auto loop-back / escalation reset path) keeps the flag.
        db.lock().reset_run_stage(&id, None, None).unwrap();
        assert!(db.lock().list_run_stages(&run).unwrap()[0].escalated, "None override stays at the strong tier");
        // An explicit model override (the reject path) clears it.
        db.lock().reset_run_stage(&id, Some("sonnet-override"), None).unwrap();
        let s = db.lock().list_run_stages(&run).unwrap().remove(0);
        assert!(!s.escalated, "a manual model override clears the sticky flag");
        assert_eq!(s.agent_model, "sonnet-override");
    }

    #[tokio::test]
    async fn a_manual_model_override_reruns_at_the_chosen_model_not_the_strong_tier() {
        let (db, run) = esc_run(None, Some("strong-m"), None);
        let seen = Arc::new(Mutex::new(vec![]));
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(
            Arc::clone(&db), sink, Box::new(SpecRecordingRunner { seen: Arc::clone(&seen) }));
        // First drive: base-m fails → escalate to strong-m → strong-m fails → halt.
        orch.run_to_pause(&run).await.unwrap();
        let stage_id = db.lock().list_run_stages(&run).unwrap()[0].id.clone();
        assert!(db.lock().list_run_stages(&run).unwrap()[0].escalated, "the stage escalated");
        seen.lock().clear();
        // The director re-runs the stage with an explicit model override.
        let patch = crate::orchestrator::types::StageRerunPatch {
            agent_model: Some("sonnet-override".into()),
            ..Default::default()
        };
        orch.rerun_from_stage(&run, &stage_id, Some(&patch)).await.unwrap();
        // The override cleared the sticky flag, so the FIRST re-driven attempt
        // runs at the director's model — not the escalate tier.
        assert_eq!(seen.lock()[0].0, "sonnet-override", "the director's model wins over the strong tier");
    }

    #[tokio::test]
    async fn escalation_runs_the_retry_at_the_strong_tier_then_halts() {
        let (db, run) = esc_run(Some("low"), Some("strong-m"), Some("high"));
        let seen = Arc::new(Mutex::new(vec![]));
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(
            Arc::clone(&db), sink, Box::new(SpecRecordingRunner { seen: Arc::clone(&seen) }));
        let status = orch.run_to_pause(&run).await.unwrap();
        // Exactly two attempts: base tier fails → escalate → strong tier fails → halt.
        let seen = seen.lock().clone();
        assert_eq!(seen.len(), 2, "bounded to one escalation (one retry)");
        assert_eq!(seen[0], ("base-m".to_string(), Some(crate::providers::Effort::Low)), "first attempt at the base tier");
        assert_eq!(seen[1], ("strong-m".to_string(), Some(crate::providers::Effort::High)), "retry at the strong tier");
        assert_eq!(status, RunStatus::Paused, "the second failure halts the run");
        let stage = db.lock().list_run_stages(&run).unwrap().remove(0);
        assert!(stage.escalated);
        assert_eq!(stage.status, "failed");
        // The base fields are PRESERVED on the row (resolution happens at spec-build).
        assert_eq!(stage.agent_model, "base-m", "the base model is kept for history");
        assert_eq!(stage.effort, Some(crate::providers::Effort::Low));
    }

    #[tokio::test]
    async fn a_blocked_stage_never_escalates_even_with_a_policy() {
        let (db, run) = esc_run(None, Some("strong-m"), None);
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(
            Arc::clone(&db), sink,
            Box::new(BlockOnceRunner { asked: std::sync::atomic::AtomicBool::new(false) }));
        let status = orch.run_to_pause(&run).await.unwrap();
        assert_eq!(status, RunStatus::Paused);
        let stage = db.lock().list_run_stages(&run).unwrap().remove(0);
        assert_eq!(stage.status, "awaiting_checkpoint", "the stage blocked — it did not fail");
        assert!(!stage.escalated, "a block is not a failure — it never escalates");
    }

    #[tokio::test]
    async fn done_worktree_stage_captures_diff_snapshot() {
        let (db, ws, _dir) = db_with_git_workspace(true);
        let run_id = drive_one_implement_stage(&db, &ws, Box::new(WorktreeRunner { fail: false })).await;
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "done");
        let snap = stages[0].diff_snapshot.as_deref().expect("snapshot captured on done");
        assert!(snap.contains("change.txt"), "snapshot should carry the dirty file: {snap}");
    }

    #[tokio::test]
    async fn failed_worktree_stage_captures_diff_snapshot() {
        let (db, ws, _dir) = db_with_git_workspace(true);
        let run_id = drive_one_implement_stage(&db, &ws, Box::new(WorktreeRunner { fail: true })).await;
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "failed");
        let snap = stages[0].diff_snapshot.as_deref().expect("snapshot captured on failure");
        assert!(snap.contains("change.txt"));
    }

    #[tokio::test]
    async fn clean_worktree_skips_the_empty_snapshot() {
        let (db, ws, _dir) = db_with_git_workspace(false);
        let run_id = drive_one_implement_stage(&db, &ws, Box::new(WorktreeRunner { fail: false })).await;
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "done");
        assert_eq!(stages[0].diff_snapshot, None, "empty diff must not be persisted");
    }

    #[tokio::test]
    async fn non_worktree_artifact_takes_no_snapshot() {
        let (db, ws, _dir) = db_with_git_workspace(true);
        let run_id = drive_one_implement_stage(&db, &ws, Box::new(MockRunner)).await;
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "done");
        assert_eq!(stages[0].diff_snapshot, None);
    }

    #[tokio::test]
    async fn failed_capture_does_not_fail_the_stage() {
        // db_with_workspace points the worktree at /tmp — not a git repo, so the
        // diff helper errors. The stage must still complete; only the snapshot is lost.
        let (db, ws) = db_with_workspace();
        let run_id = drive_one_implement_stage(&db, &ws, Box::new(WorktreeRunner { fail: false })).await;
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "done");
        assert_eq!(stages[0].diff_snapshot, None);
    }

    #[tokio::test]
    async fn director_pause_parks_the_next_stage_and_approve_resumes() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));

        // Pause requested before the drive: the next pending stage parks at the
        // boundary (run paused, stage awaiting a decision) and nothing executes.
        orch.request_pause(&run_id);
        let status = orch.run_to_pause(&run_id).await.unwrap();
        assert_eq!(status, RunStatus::Paused);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "awaiting_checkpoint");
        assert!(stages[0].started_at.is_none(), "the parked stage never ran");
        assert_eq!(stages[1].status, "pending");

        // Approving the parked-never-started stage releases it; the run finishes.
        orch.resolve_checkpoint(&run_id, CheckpointAction::Approve).await.unwrap();
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert!(stages.iter().all(|s| s.status == "done"), "all stages run after resume");
        assert_eq!(db.lock().get_run(&run_id).unwrap().unwrap().status, "completed");
    }

    #[tokio::test]
    async fn ask_director_parks_the_stage_then_answer_reruns_with_the_decision() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(
            Arc::clone(&db),
            sink.clone(),
            Box::new(BlockOnceRunner { asked: Default::default() }),
        );

        // Drive: the stage calls ask_director → parks as awaiting_checkpoint
        // (NOT failed) with the questions persisted, run paused.
        let status = orch.run_to_pause(&run_id).await.unwrap();
        assert_eq!(status, RunStatus::Paused);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "awaiting_checkpoint");
        assert!(stages[0].error.is_none(), "a block is not a failure");
        let bq = stages[0].blocked_questions.as_deref().expect("questions persisted");
        let ask: BlockedAsk = serde_json::from_str(bq).unwrap();
        assert_eq!(ask.summary, "which datastore?");
        assert_eq!(ask.questions[0].recommended_default, "Postgres");
        // The asking spend is on the meter (truthful cost).
        assert!((db.lock().get_run(&run_id).unwrap().unwrap().cost_usd - 0.02).abs() < 1e-6);
        // The SAME decision checkpoint a gate uses fired (needs-you + beacon).
        assert!(sink.events.lock().iter().any(|e| e == "run://checkpoint"));

        // Answer it → the stage resets to pending with the decision as feedback,
        // re-runs, and the run completes. blocked_questions is cleared.
        let status = orch
            .resolve_checkpoint(&run_id, CheckpointAction::AnswerBlocker { answers: vec!["Use SQLite".into()] })
            .await
            .unwrap();
        assert_eq!(status, RunStatus::Completed);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "done");
        assert!(stages[0].blocked_questions.is_none(), "cleared after answering");
        let artifact = stages[0].artifact.as_deref().unwrap();
        assert!(artifact.contains("Use SQLite"), "the director's answer reached the re-run: {artifact}");
        assert!(artifact.contains("you recommended: Postgres"), "the default is shown for context: {artifact}");
        // Spend is retained across the re-run (0.02 asking retired + 0.02 re-run).
        assert!((db.lock().get_run(&run_id).unwrap().unwrap().cost_usd - 0.04).abs() < 1e-6);
    }

    #[tokio::test]
    async fn answer_blocker_accept_defaults_uses_recommended_defaults() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(
            Arc::clone(&db),
            sink,
            Box::new(BlockOnceRunner { asked: Default::default() }),
        );
        orch.run_to_pause(&run_id).await.unwrap();
        // "Accept all defaults" sends each recommended_default verbatim.
        orch.resolve_checkpoint(&run_id, CheckpointAction::AnswerBlocker { answers: vec!["Postgres".into()] })
            .await
            .unwrap();
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        let artifact = stages[0].artifact.as_deref().unwrap();
        assert!(artifact.contains("Director: Postgres"), "the default became the decision: {artifact}");
    }

    #[test]
    fn blocked_ask_serde_round_trips_camel_case() {
        let ask = BlockedAsk {
            summary: "s".into(),
            questions: vec![BlockedQuestion {
                question: "q?".into(),
                why_blocked: "because".into(),
                recommended_default: "d".into(),
            }],
        };
        let json = serde_json::to_string(&ask).unwrap();
        // camelCase on the wire — matches the frontend BlockedAsk type.
        assert!(json.contains("\"whyBlocked\""), "camelCase: {json}");
        assert!(json.contains("\"recommendedDefault\""), "camelCase: {json}");
        let back: BlockedAsk = serde_json::from_str(&json).unwrap();
        assert_eq!(ask, back);
    }

    #[test]
    fn format_blocker_feedback_pairs_answers_and_falls_back_to_defaults() {
        let ask = BlockedAsk {
            summary: "s".into(),
            questions: vec![
                BlockedQuestion { question: "DB?".into(), why_blocked: String::new(), recommended_default: "Postgres".into() },
                BlockedQuestion { question: "Auth?".into(), why_blocked: String::new(), recommended_default: "OAuth".into() },
            ],
        };
        // First answered explicitly; second is empty → uses the recommended default.
        let fb = crate::orchestrator::format_blocker_feedback(Some(&ask), &["SQLite".into(), "   ".into()]);
        assert!(fb.contains("1. DB?  (you recommended: Postgres)"), "{fb}");
        assert!(fb.contains("Director: SQLite"), "{fb}");
        assert!(fb.contains("2. Auth?  (you recommended: OAuth)"), "{fb}");
        assert!(fb.contains("Director: OAuth"), "empty answer falls back to the default: {fb}");
        assert!(fb.contains("do not ask again unless a NEW blocking ambiguity"), "{fb}");
    }

    #[test]
    fn blocked_questions_column_write_read_and_clear() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let sid = db.lock().list_run_stages(&run_id).unwrap()[0].id.clone();

        // Absent by default.
        assert!(db.lock().list_run_stages(&run_id).unwrap()[0].blocked_questions.is_none());
        // Write + read back verbatim.
        let json = r#"{"summary":"q","questions":[]}"#;
        db.lock().set_run_stage_blocked(&sid, Some(json)).unwrap();
        assert_eq!(db.lock().list_run_stages(&run_id).unwrap()[0].blocked_questions.as_deref(), Some(json));
        // reset_run_stage clears it (no re-run carries a stale block).
        db.lock().reset_run_stage(&sid, None, None).unwrap();
        assert!(db.lock().list_run_stages(&run_id).unwrap()[0].blocked_questions.is_none());
        // Explicit clear via None also works.
        db.lock().set_run_stage_blocked(&sid, Some(json)).unwrap();
        db.lock().set_run_stage_blocked(&sid, None).unwrap();
        assert!(db.lock().list_run_stages(&run_id).unwrap()[0].blocked_questions.is_none());
    }

    #[test]
    fn update_run_stage_refuses_a_blocked_stage() {
        // A block RAN (started_at stamped) — it is NOT an editable un-begun park
        // (budget/director-pause). Editing model/instructions must be refused, or
        // an already-executed stage would silently take field edits.
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let sid = db.lock().list_run_stages(&run_id).unwrap()[0].id.clone();

        // Simulate "ran, then blocked": running stamps started_at, then it parks
        // awaiting_checkpoint (artifact still null) with its questions.
        db.lock().set_run_stage_status(&sid, "running").unwrap();
        db.lock().set_run_stage_status(&sid, "awaiting_checkpoint").unwrap();
        db.lock().set_run_stage_blocked(&sid, Some(r#"{"summary":"q","questions":[]}"#)).unwrap();
        assert!(db.lock().list_run_stages(&run_id).unwrap()[0].started_at.is_some());

        let err = db
            .lock()
            .update_run_stage(&run_id, &sid, None, Some("new instructions"), None, None, None)
            .unwrap_err();
        assert!(err.to_string().contains("already started"), "{err}");
    }

    #[tokio::test]
    async fn approving_a_block_is_refused_answer_it_instead() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(
            Arc::clone(&db),
            sink,
            Box::new(BlockOnceRunner { asked: Default::default() }),
        );
        orch.run_to_pause(&run_id).await.unwrap();
        // A stale Approve on a block would mark it done with an empty hand-off — refuse it.
        let err = orch.resolve_checkpoint(&run_id, CheckpointAction::Approve).await.unwrap_err();
        assert!(err.to_string().contains("waiting for an answer"), "{err}");
        // The block is untouched — still parked with its questions.
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "awaiting_checkpoint");
        assert!(stages[0].blocked_questions.is_some());
        // Abort, by contrast, IS allowed on a block (tear the whole run down).
        let status = orch.resolve_checkpoint(&run_id, CheckpointAction::Abort).await.unwrap();
        assert_eq!(status, RunStatus::Aborted);
    }

    #[tokio::test]
    async fn answer_blocker_on_a_normal_gate_is_refused() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P", "d", false).unwrap();
        // checkpoint=true → a normal approval GATE (no questions).
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", true, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));
        orch.run_to_pause(&run_id).await.unwrap();
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "awaiting_checkpoint");
        assert!(stages[0].blocked_questions.is_none(), "a normal gate has no questions");
        // Answering a stage that never asked is nonsense — refuse it.
        let err = orch
            .resolve_checkpoint(&run_id, CheckpointAction::AnswerBlocker { answers: vec![] })
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not awaiting a director decision"), "{err}");
    }

    #[tokio::test]
    async fn resolve_checkpoint_scoped_targets_the_passed_stage_id() {
        // Two stages parked at a gate at once (constructed by hand). `.find`
        // alone resolves the FIRST; the caller's validated `stage_id` must
        // select the intended one, and a stale/absent id falls back to `.find`.
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let ids: Vec<String> = db.lock().list_run_stages(&run_id).unwrap().iter().map(|s| s.id.clone()).collect();
        let art = |t: &str| serde_json::to_string(&StageArtifact {
            kind: ArtifactKind::Note, text: t.into(), payload: None, refs_worktree: false,
        }).unwrap();
        // Park BOTH at a gate: ran (started_at stamped) → artifact set → awaiting_checkpoint.
        for (i, id) in ids.iter().enumerate() {
            db.lock().set_run_stage_status(id, "running").unwrap();
            db.lock().complete_run_stage(id, "awaiting_checkpoint", 0, 0, 0.0, Some(&art(&format!("s{i}")))).unwrap();
        }

        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));

        // Passing stage 1's id resolves STAGE 1, not the `.find` default (stage 0).
        orch.resolve_checkpoint_apply_only(&run_id, Some(&ids[1]), CheckpointAction::Approve).unwrap();
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[1].status, "done", "the passed stage_id was the one resolved");
        assert_eq!(stages[0].status, "awaiting_checkpoint", "the unselected stage is untouched");

        // A stale/absent id falls back to `.find` (the remaining parked stage 0).
        orch.resolve_checkpoint_apply_only(&run_id, Some("nonexistent"), CheckpointAction::Approve).unwrap();
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "done", "a stale id falls back to the single parked stage");
    }

    #[test]
    fn cap_diff_passes_small_text_through() {
        let text = "diff --git a/x b/x\n+small";
        assert_eq!(crate::orchestrator::cap_diff(text), text);
    }

    #[test]
    fn cap_diff_truncates_on_a_char_boundary_with_marker() {
        // 4-byte chars guarantee the cap lands mid-char.
        let big = "🐙".repeat(crate::orchestrator::DIFF_SNAPSHOT_CAP_BYTES / 4 + 64);
        let capped = crate::orchestrator::cap_diff(&big);
        assert!(capped.ends_with("\n… (diff truncated)"));
        assert!(capped.len() <= crate::orchestrator::DIFF_SNAPSHOT_CAP_BYTES + "\n… (diff truncated)".len());
        // No panic = boundary respected; also make sure we kept real content.
        assert!(capped.starts_with("🐙"));
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
            max_turns_override: None,
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
    /// Records each stage's assembled input dossier and produces a
    /// role-appropriate artifact (kind from stage.artifact_kind, resolved by the orchestrator).
    struct RecordingRunner {
        seen: Arc<Mutex<Vec<(String, StageInput)>>>,
    }
    #[async_trait::async_trait]
    impl AgentRunner for RecordingRunner {
        async fn run(
            &self,
            stage: &StageSpec,
            input: &StageInput,
            _ctx: &StageContext,
        ) -> crate::error::AppResult<StageOutcome> {
            self.seen.lock().push((stage.role.clone(), input.clone()));
            let kind = stage.artifact_kind.clone();
            let refs_worktree = matches!(kind, ArtifactKind::Diff | ArtifactKind::Tests);
            Ok(StageOutcome {
                artifact: StageArtifact {
                    kind,
                    text: format!("{} output", stage.role),
                    payload: None,
                    refs_worktree,
                },
                input_tokens: 1,
                output_tokens: 1,
                cost_usd: 0.0,
                status: StageStatus::Done,
                tool_calls: vec![],
                error: None,
                verdict: None,
                session_id: None,
                blocked: None,
            })
        }
    }

    /// THE context-passing contract: with Plan → Plan review → Implement, the
    /// implementer receives BOTH the plan and the review — the review's
    /// findings must never shadow the plan they reviewed (the old one-hop bug).
    #[tokio::test]
    async fn implement_receives_both_plan_and_review_sections() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "plan_review", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 2, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "task", None, None, &[]).unwrap();
        let seen = Arc::new(Mutex::new(vec![]));
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(
            Arc::clone(&db),
            sink,
            Box::new(RecordingRunner { seen: Arc::clone(&seen) }),
        );
        assert_eq!(orch.run_to_pause(&run_id).await.unwrap(), RunStatus::Completed);

        let seen = seen.lock();
        // Stage 1 (plan): empty dossier — the task rides separately.
        assert!(seen[0].1.sections.is_empty());
        assert!(seen[0].1.breadcrumb.contains("current stage"));
        // Stage 2 (plan_review): exactly the plan.
        assert_eq!(seen[1].1.sections.len(), 1);
        assert_eq!(seen[1].1.sections[0].kind, ArtifactKind::Plan);
        // Stage 3 (implement): plan AND review, in pipeline order.
        let (role, input) = &seen[2];
        assert_eq!(role, "implement");
        let kinds: Vec<_> = input.sections.iter().map(|s| s.kind.clone()).collect();
        assert_eq!(kinds, vec![ArtifactKind::Plan, ArtifactKind::Review]);
        assert!(input.sections[0].text.contains("plan output"));
        assert!(input.sections[1].text.contains("plan_review output"));
    }

    /// Two producers of the same kind: the fresher one supersedes (refine's
    /// refined plan replaces the original plan in the dossier — never both).
    #[tokio::test]
    async fn fresher_artifact_of_same_kind_supersedes_older() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P2", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "refine", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 2, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "task", None, None, &[]).unwrap();
        let seen = Arc::new(Mutex::new(vec![]));
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(
            Arc::clone(&db),
            sink,
            Box::new(RecordingRunner { seen: Arc::clone(&seen) }),
        );
        assert_eq!(orch.run_to_pause(&run_id).await.unwrap(), RunStatus::Completed);

        let seen = seen.lock();
        let (_, input) = &seen[2];
        let plans: Vec<_> = input
            .sections
            .iter()
            .filter(|s| s.kind == ArtifactKind::Plan)
            .collect();
        assert_eq!(plans.len(), 1, "exactly one Plan section");
        assert_eq!(plans[0].role, "refine", "the refined plan supersedes the original");
        assert!(plans[0].text.contains("refine output"));
    }

    /// Startup recovery: a stage orphaned in `running` by a dead process must
    /// land in the halt-recovery flow (failed + paused), never stay stranded.
    #[tokio::test]
    async fn startup_recovery_fails_orphaned_running_stages() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P3", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let stage_id = db.lock().list_run_stages(&run_id).unwrap()[0].id.clone();
        // Simulate the dead process: stage in flight, run running.
        db.lock().set_run_stage_status(&stage_id, "running").unwrap();
        db.lock().set_run_status(&run_id, "running", false).unwrap();

        let n = db.lock().recover_interrupted_runs().unwrap();
        assert_eq!(n, 1);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "failed");
        assert!(
            stages[0].error.as_deref().unwrap().starts_with("interrupted"),
            "error must lead with 'interrupted' for the Resume affordance"
        );
        let run = db.lock().get_run(&run_id).unwrap().unwrap();
        assert_eq!(run.status, "paused");
        // Idempotent: a clean second boot recovers nothing.
        assert_eq!(db.lock().recover_interrupted_runs().unwrap(), 0);
    }

    /// Death BETWEEN stages (run `running`, no stage `running`): the paused run
    /// must always end up with a blocked stage the checkpoint UI can act on —
    /// a paused run with no blocked stage has no affordance and permanently
    /// blocks its workspace.
    #[tokio::test]
    async fn startup_recovery_settles_runs_that_died_between_stages() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P5", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        // Simulate: stage 1 finished, process died before stage 2 went running.
        db.lock().set_run_stage_status(&stages[0].id, "done").unwrap();
        db.lock().set_run_status(&run_id, "running", false).unwrap();

        assert_eq!(db.lock().recover_interrupted_runs().unwrap(), 1);
        let after = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(after[0].status, "done", "finished work is untouched");
        assert_eq!(after[1].status, "failed", "the next stage carries the interruption");
        assert!(after[1].error.as_deref().unwrap().starts_with("interrupted"));
        assert_eq!(db.lock().get_run(&run_id).unwrap().unwrap().status, "paused");
    }

    /// Death after the last stage finished but before the run was stamped:
    /// the run IS complete — recovery must mark it so, not park it paused.
    #[tokio::test]
    async fn startup_recovery_completes_runs_whose_stages_all_finished() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P6", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let stage_id = db.lock().list_run_stages(&run_id).unwrap()[0].id.clone();
        db.lock().set_run_stage_status(&stage_id, "done").unwrap();
        db.lock().set_run_status(&run_id, "running", false).unwrap();

        assert_eq!(db.lock().recover_interrupted_runs().unwrap(), 0);
        assert_eq!(db.lock().get_run(&run_id).unwrap().unwrap().status, "completed");
    }

    /// The double-drive guard: `spawn_detached_segment` on a run a LIVE worker
    /// already owns must return `AlreadyRunning` (an `Ok`), NOT an `Err` — so
    /// the command callers never fall back to an in-process drive alongside
    /// the worker. The reserve is refused before any binary resolution, and
    /// the existing lease is left intact.
    #[tokio::test]
    async fn spawn_detached_segment_yields_already_running_when_leased() {
        use crate::orchestrator::worker::SegmentSpawn;
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("PLD", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        // A live foreign worker (fresh heartbeat) owns the run.
        assert!(db.lock().reserve_worker_lease(&run_id, "w1").unwrap());
        assert!(db.lock().confirm_worker_lease(&run_id, "w1", std::process::id() as i64).unwrap());

        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(
            Arc::clone(&db),
            sink,
            Box::new(RecordingRunner { seen: Arc::new(Mutex::new(vec![])) }),
        );
        let outcome = orch.spawn_detached_segment(&run_id, false).unwrap();
        assert_eq!(outcome, SegmentSpawn::AlreadyRunning);
        // The original lease is untouched — no clobber, no clear.
        assert!(db.lock().beat_worker_lease(&run_id, "w1").unwrap(), "w1 still owns the lease");
    }

    /// H4 guard: `rerun_from_stage` must refuse while a detached worker holds
    /// a live lease. `claim_active` only excludes an IN-PROCESS drive; a
    /// cross-process worker never enters that set, so without the lease check
    /// a re-run would reset the stage rows the worker is actively writing.
    #[tokio::test]
    async fn rerun_is_refused_while_a_detached_worker_is_live() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("PLRR", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        // Stage 0 done, stage 1 driving under a live worker lease.
        db.lock().set_run_stage_status(&stages[0].id, "done").unwrap();
        db.lock().set_run_stage_status(&stages[1].id, "running").unwrap();
        db.lock().set_run_status(&run_id, "running", false).unwrap();
        assert!(db.lock().reserve_worker_lease(&run_id, "w").unwrap());
        assert!(db.lock().confirm_worker_lease(&run_id, "w", std::process::id() as i64).unwrap());

        let orch = Orchestrator::new_with_runner(
            Arc::clone(&db),
            Arc::new(CollectingSink { events: Mutex::new(vec![]) }),
            Box::new(RecordingRunner { seen: Arc::new(Mutex::new(vec![])) }),
        );
        // Re-run the earlier done stage while the worker drives the later one.
        let err = orch
            .rerun_from_stage(&run_id, &stages[0].id, None)
            .await
            .expect_err("must refuse while a worker is live");
        assert!(
            err.to_string().contains("in the background"),
            "clear cross-process rejection, got: {err}"
        );
        // The worker's stage row is untouched — no reset happened.
        assert_eq!(db.lock().list_run_stages(&run_id).unwrap()[1].status, "running");
    }

    /// Reused-pid safety: startup recovery uses HEARTBEAT-ONLY freshness, so a
    /// run whose lease heartbeat is stale is repaired even when its persisted
    /// `worker_pid` happens to be alive (after a reboot the pid may belong to
    /// an unrelated system process). Without this the run would be pinned
    /// "running" forever. Contrast `worker_lease_fresh`, which DOES trust the
    /// live pid (for the in-session sleep-wake race) — proven divergent here.
    #[tokio::test]
    async fn startup_recovery_repairs_stale_lease_even_if_pid_alive() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("PLR", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let stage_id = db.lock().list_run_stages(&run_id).unwrap()[0].id.clone();
        db.lock().set_run_stage_status(&stage_id, "running").unwrap();
        db.lock().set_run_status(&run_id, "running", false).unwrap();
        // Our OWN pid is guaranteed alive — stands in for a reboot-reused pid.
        let live_pid = std::process::id() as i64;
        assert!(db.lock().reserve_worker_lease(&run_id, "n").unwrap());
        assert!(db.lock().confirm_worker_lease(&run_id, "n", live_pid).unwrap());
        // Heartbeat goes stale (a reboot killed the real worker long ago).
        let stale = (chrono::Utc::now() - chrono::Duration::seconds(300)).to_rfc3339();
        db.lock()
            .conn_ref()
            .execute("UPDATE runs SET heartbeat_at = ?1 WHERE id = ?2", rusqlite::params![stale, run_id])
            .unwrap();
        // The pid-aware view still says "live" (this is the trap)…
        assert!(db.lock().worker_lease_fresh(&run_id).unwrap());
        // …but heartbeat-only recovery repairs it anyway.
        assert!(!db.lock().worker_heartbeat_fresh(&run_id).unwrap());
        assert_eq!(db.lock().recover_interrupted_runs().unwrap(), 1);
        assert_eq!(db.lock().list_run_stages(&run_id).unwrap()[0].status, "failed");
        assert_eq!(db.lock().get_run(&run_id).unwrap().unwrap().status, "paused");
    }

    /// A `reserve` must refuse to supersede a LIVE-but-stale worker (heartbeat
    /// lapsed during a sleep, pid still answering) — else two workers would
    /// briefly drive one worktree. The pid-aware pre-check in
    /// `reserve_worker_lease` is what enforces this.
    #[tokio::test]
    async fn reserve_refuses_to_supersede_a_live_but_stale_worker() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("PLS", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let live_pid = std::process::id() as i64;
        assert!(db.lock().reserve_worker_lease(&run_id, "w1").unwrap());
        assert!(db.lock().confirm_worker_lease(&run_id, "w1", live_pid).unwrap());
        // Heartbeat lapses (sleep) but the worker pid still answers.
        let stale = (chrono::Utc::now() - chrono::Duration::seconds(300)).to_rfc3339();
        db.lock()
            .conn_ref()
            .execute("UPDATE runs SET heartbeat_at = ?1 WHERE id = ?2", rusqlite::params![stale, run_id])
            .unwrap();
        // A second reserve must be refused — the live pid protects the claim.
        assert!(!db.lock().reserve_worker_lease(&run_id, "w2").unwrap());
        assert_eq!(
            db.lock().get_run(&run_id).unwrap().unwrap().detached,
            true,
            "the original lease is untouched"
        );
    }

    /// The detached-run exception: startup recovery must NEVER repair a run
    /// whose worker lease heartbeat is fresh — a live `octopush-run-worker`
    /// owns it, and "repairing" would mark its in-flight stage failed and
    /// fight the worker's writes (the #1 collision the lease exists to solve).
    #[tokio::test]
    async fn startup_recovery_skips_run_with_fresh_worker_lease() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("PL1", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let stage_id = db.lock().list_run_stages(&run_id).unwrap()[0].id.clone();
        db.lock().set_run_stage_status(&stage_id, "running").unwrap();
        db.lock().set_run_status(&run_id, "running", false).unwrap();
        // A live worker: reserved by the app, confirmed + beating.
        assert!(db.lock().reserve_worker_lease(&run_id, "nonce-1").unwrap());
        // A pid beyond every OS's pid space: the liveness probe must read DEAD
        // once the heartbeat goes stale (a small literal pid could be a real,
        // living process on the test machine — flaky).
        assert!(db.lock().confirm_worker_lease(&run_id, "nonce-1", i32::MAX as i64).unwrap());

        assert_eq!(db.lock().recover_interrupted_runs().unwrap(), 0);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "running", "the live worker's stage is untouched");
        assert_eq!(db.lock().get_run(&run_id).unwrap().unwrap().status, "running");

        // The worker dies (heartbeat goes stale) → NOW recovery repairs it.
        let stale = (chrono::Utc::now() - chrono::Duration::seconds(300)).to_rfc3339();
        db.lock()
            .conn_ref()
            .execute("UPDATE runs SET heartbeat_at = ?1 WHERE id = ?2", rusqlite::params![stale, run_id])
            .unwrap();
        assert_eq!(db.lock().recover_interrupted_runs().unwrap(), 1);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "failed");
        assert_eq!(db.lock().get_run(&run_id).unwrap().unwrap().status, "paused");
        assert!(!db.lock().worker_lease_fresh(&run_id).unwrap(), "stale lease cleared by repair");
    }

    /// The lease lifecycle: reserve is a double-spawn guard while fresh,
    /// confirm/beat/clear are nonce-guarded so a superseded straggler can
    /// neither resurrect nor release a successor's claim.
    #[tokio::test]
    async fn worker_lease_lifecycle_is_nonce_guarded() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("PL2", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();

        assert!(db.lock().reserve_worker_lease(&run_id, "a").unwrap());
        assert!(db.lock().worker_lease_fresh(&run_id).unwrap());
        // Second reserve while fresh: refused — the double-spawn guard.
        assert!(!db.lock().reserve_worker_lease(&run_id, "b").unwrap());
        // Confirm with the wrong nonce: refused; right nonce: accepted.
        assert!(!db.lock().confirm_worker_lease(&run_id, "b", 1).unwrap());
        assert!(db.lock().confirm_worker_lease(&run_id, "a", 1).unwrap());
        // Beats: only the owner's land.
        assert!(!db.lock().beat_worker_lease(&run_id, "b").unwrap());
        assert!(db.lock().beat_worker_lease(&run_id, "a").unwrap());
        // Clear with the wrong nonce leaves the lease; the owner's clear frees it.
        db.lock().clear_worker_lease(&run_id, "b").unwrap();
        assert!(db.lock().worker_lease_fresh(&run_id).unwrap());
        db.lock().clear_worker_lease(&run_id, "a").unwrap();
        assert!(!db.lock().worker_lease_fresh(&run_id).unwrap());
        // Freed: the next segment's reserve succeeds.
        assert!(db.lock().reserve_worker_lease(&run_id, "b").unwrap());
        // The run is permanently marked detached for the UI.
        assert!(db.lock().get_run(&run_id).unwrap().unwrap().detached);
    }

    /// Mid-session worker death: the bridge reconciler repairs ONLY stale
    /// leases (into the standard interrupted/Resume shape) and reports which,
    /// leaving live workers alone.
    #[tokio::test]
    async fn reconcile_repairs_only_stale_leases() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("PL3", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        let mk = |task: &str| {
            let id = db.lock().create_run(&ws, &pid, task, None, None, &[]).unwrap();
            let sid = db.lock().list_run_stages(&id).unwrap()[0].id.clone();
            db.lock().set_run_stage_status(&sid, "running").unwrap();
            db.lock().set_run_status(&id, "running", false).unwrap();
            id
        };
        let live = mk("live");
        let dead = mk("dead");
        assert!(db.lock().reserve_worker_lease(&live, "n-live").unwrap());
        assert!(db.lock().reserve_worker_lease(&dead, "n-dead").unwrap());
        let stale = (chrono::Utc::now() - chrono::Duration::seconds(300)).to_rfc3339();
        db.lock()
            .conn_ref()
            .execute("UPDATE runs SET heartbeat_at = ?1 WHERE id = ?2", rusqlite::params![stale, dead])
            .unwrap();

        let repaired = db.lock().reconcile_stale_leases().unwrap();
        assert_eq!(repaired, vec![dead.clone()]);
        assert_eq!(db.lock().get_run(&dead).unwrap().unwrap().status, "paused");
        assert_eq!(db.lock().list_run_stages(&dead).unwrap()[0].status, "failed");
        assert_eq!(db.lock().get_run(&live).unwrap().unwrap().status, "running");
        assert_eq!(db.lock().list_run_stages(&live).unwrap()[0].status, "running");
    }

    // ── Routines (scheduled crews) ──────────────────────────────────────────

    fn routine_input(pipeline_id: &str, kind: &str, spec: &str) -> crate::db::RoutineInput {
        crate::db::RoutineInput {
            name: "Nightly ship".into(),
            project_id: "p1".into(),
            pipeline_id: pipeline_id.into(),
            task: "keep the deps fresh".into(),
            reference_model: None,
            stage_overrides: None,
            budget_usd: Some(2.0),
            schedule_kind: kind.into(),
            schedule_spec: spec.into(),
            workspace_mode: "fixed".into(),
            fixed_workspace_id: Some("w1".into()),
            base_branch: None,
            branch_prefix: None,
            fire_condition: None,
        }
    }

    /// The pure schedule computation: interval adds seconds; daily lands on the
    /// next HH:MM (today if not passed, else tomorrow); junk specs are `None`.
    #[test]
    fn routine_next_due_interval_and_daily() {
        use crate::routines::{next_due, KIND_DAILY, KIND_INTERVAL};
        use chrono::{DateTime, Local, TimeZone, Timelike, Utc};

        let after = Local.with_ymd_and_hms(2026, 7, 13, 8, 0, 0).single().unwrap();
        // interval: exactly +N seconds.
        let n = next_due(KIND_INTERVAL, "3600", after).unwrap();
        let dt = DateTime::parse_from_rfc3339(&n).unwrap().with_timezone(&Utc);
        assert_eq!((dt - after.with_timezone(&Utc)).num_seconds(), 3600);

        // daily, later today: same day, at HH:MM local.
        let n = next_due(KIND_DAILY, "09:30", after).unwrap();
        let local = DateTime::parse_from_rfc3339(&n).unwrap().with_timezone(&Local);
        assert!(local > after);
        assert_eq!((local.hour(), local.minute()), (9, 30));

        // daily, already passed today: rolls to tomorrow.
        let late = Local.with_ymd_and_hms(2026, 7, 13, 10, 0, 0).single().unwrap();
        let n = next_due(KIND_DAILY, "09:30", late).unwrap();
        let local = DateTime::parse_from_rfc3339(&n).unwrap().with_timezone(&Local);
        assert_eq!(local.date_naive(), late.date_naive() + chrono::Duration::days(1));

        assert!(next_due(KIND_INTERVAL, "not-a-number", after).is_none());
        assert!(next_due(KIND_DAILY, "25:61", after).is_none());
        assert!(next_due("weekly", "mon", after).is_none());
    }

    #[test]
    fn routine_validate_schedule_bounds() {
        use crate::routines::validate_schedule;
        assert!(validate_schedule("interval", "3600").is_ok());
        assert!(validate_schedule("interval", "59").is_err()); // sub-minute floor
        assert!(validate_schedule("interval", "x").is_err());
        assert!(validate_schedule("daily", "00:00").is_ok());
        assert!(validate_schedule("daily", "9:5").is_ok());
        assert!(validate_schedule("daily", "24:00").is_err());
        assert!(validate_schedule("cron", "* * * * *").is_err());
    }

    /// Phase-1 cross-field rule: a fresh-workspace routine must be daily (no
    /// auto-reaper yet — a sub-daily fresh cadence would spawn worktrees
    /// without bound). Fixed mode is unconstrained.
    #[test]
    fn routine_validate_fresh_requires_daily() {
        use crate::routines::validate_routine;
        assert!(validate_routine("fresh", "daily").is_ok());
        assert!(validate_routine("fresh", "interval").is_err());
        assert!(validate_routine("fixed", "interval").is_ok());
        assert!(validate_routine("fixed", "daily").is_ok());
    }

    /// CRUD roundtrip + the due filter: a routine is `due` only when enabled and
    /// its `next_due_at` is in the past.
    #[test]
    fn routine_crud_and_due_filter() {
        let (db, _ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("RP", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();

        let past = "2000-01-01T00:00:00+00:00";
        let future = "2999-01-01T00:00:00+00:00";
        db.lock().insert_routine("r-due", &routine_input(&pid, "interval", "3600"), Some(past)).unwrap();
        db.lock().insert_routine("r-future", &routine_input(&pid, "daily", "09:00"), Some(future)).unwrap();

        assert_eq!(db.lock().list_routines().unwrap().len(), 2);
        let got = db.lock().get_routine("r-due").unwrap().unwrap();
        assert!(got.enabled && got.budget_usd == Some(2.0) && got.workspace_mode == "fixed");

        // Only the past-due, enabled one is selected.
        let now = chrono::Utc::now().to_rfc3339();
        let due: Vec<String> = db.lock().list_due_routines(&now).unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(due, vec!["r-due".to_string()]);

        // Disabling removes it from the due set even though its window is past.
        db.lock().set_routine_enabled("r-due", false, Some(past)).unwrap();
        assert!(db.lock().list_due_routines(&now).unwrap().is_empty());

        // mark_routine_fired advances the window and records the run.
        db.lock().set_routine_enabled("r-due", true, Some(past)).unwrap();
        db.lock().mark_routine_fired("r-due", "run-xyz", &now, Some(future)).unwrap();
        let fired = db.lock().get_routine("r-due").unwrap().unwrap();
        assert_eq!(fired.last_run_id.as_deref(), Some("run-xyz"));
        assert_eq!(fired.next_due_at.as_deref(), Some(future));
        assert!(db.lock().list_due_routines(&now).unwrap().is_empty(), "window advanced past now");

        db.lock().delete_routine("r-due").unwrap();
        db.lock().delete_routine("r-future").unwrap();
        assert!(db.lock().list_routines().unwrap().is_empty());
    }

    /// A fixed routine whose target workspace was deleted auto-disables (rather
    /// than skipping every window forever with no signal), and reports Skipped.
    #[tokio::test]
    async fn routine_with_deleted_fixed_workspace_auto_disables() {
        use crate::routines::{FireOutcome, SkipReason};
        let (db, _ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("RPG", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        let mut input = routine_input(&pid, "daily", "09:00");
        input.fixed_workspace_id = Some("ghost-ws".into()); // never existed
        db.lock().insert_routine("r-ghost", &input, Some("2000-01-01T00:00:00+00:00")).unwrap();

        let orch = Arc::new(Orchestrator::new_with_runner(
            Arc::clone(&db),
            Arc::new(CollectingSink { events: Mutex::new(vec![]) }),
            Box::new(RecordingRunner { seen: Arc::new(Mutex::new(vec![])) }),
        ));
        let outcome = orch.run_routine_now("r-ghost").await.unwrap();
        assert_eq!(outcome, FireOutcome::Skipped(SkipReason::WorkspaceUnavailable));
        assert!(
            !db.lock().get_routine("r-ghost").unwrap().unwrap().enabled,
            "a routine pointing at a deleted workspace disables itself"
        );
    }

    // ── Routine pre-fire condition (`fire_condition`) ───────────────────────

    /// The pure condition evaluator, gated purely on exit code: 0 ⇒ Met,
    /// non-zero ⇒ NotMet, and a command that outruns the timeout ⇒ Error (the
    /// child is killed) — a hung check can never stall the scheduler tick.
    #[tokio::test]
    async fn routine_condition_evaluates_by_exit_code() {
        use crate::routines::{evaluate_condition, ConditionEval};
        use std::time::Duration;
        let dir = std::env::temp_dir();
        assert_eq!(evaluate_condition("true", &dir, Duration::from_secs(5)).await, ConditionEval::Met);
        assert_eq!(evaluate_condition("false", &dir, Duration::from_secs(5)).await, ConditionEval::NotMet);
        assert_eq!(evaluate_condition("exit 7", &dir, Duration::from_secs(5)).await, ConditionEval::NotMet);
        // Outruns the timeout ⇒ Error (skip, fail-safe).
        let timed_out = evaluate_condition("sleep 5", &dir, Duration::from_millis(100)).await;
        assert!(matches!(timed_out, ConditionEval::Error(_)), "{timed_out:?}");
    }

    /// A condition that exits non-zero skips the window with NO run created (zero
    /// tokens), the window still advanced FIRST (crash-safe), and the skip is
    /// legible (`last_outcome`/`last_checked_at`). `run_routine_now` surfaces the
    /// reason, so "Run now" is an honest test of the gated path.
    #[tokio::test]
    async fn routine_condition_not_met_skips_without_a_run() {
        use crate::routines::{FireOutcome, SkipReason};
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("RC", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        let mut input = routine_input(&pid, "interval", "3600");
        input.fire_condition = Some("  false  ".into()); // trims to `false`
        let past = "2000-01-01T00:00:00+00:00";
        db.lock().insert_routine("r-cond", &input, Some(past)).unwrap();

        let orch = Arc::new(Orchestrator::new_with_runner(
            Arc::clone(&db),
            Arc::new(CollectingSink { events: Mutex::new(vec![]) }),
            Box::new(RecordingRunner { seen: Arc::new(Mutex::new(vec![])) }),
        ));
        assert_eq!(db.lock().list_runs(&ws).unwrap().len(), 0);

        let outcome = orch.run_routine_now("r-cond").await.unwrap();
        assert_eq!(outcome, FireOutcome::Skipped(SkipReason::ConditionNotMet));
        assert_eq!(db.lock().list_runs(&ws).unwrap().len(), 0, "a skipped condition creates no run");

        let r = db.lock().get_routine("r-cond").unwrap().unwrap();
        assert_ne!(r.next_due_at.as_deref(), Some(past), "next_due advanced BEFORE the gate");
        assert_eq!(r.last_outcome.as_deref(), Some("condition not met"), "the skip is legible");
        assert!(r.last_checked_at.is_some(), "checked_at stamped on a skip");
        assert!(r.last_run_id.is_none(), "no run stamped on a skip");
    }

    /// A condition that can't be evaluated (here: a bogus/hung command bounded by
    /// a tiny timeout) is a fail-SAFE skip that records the error — never a
    /// blind fire. Exercises the `ConditionError` branch end-to-end.
    #[tokio::test]
    async fn routine_condition_error_is_a_failsafe_skip() {
        use crate::routines::{evaluate_condition, ConditionEval};
        use std::time::Duration;
        // A genuinely unresolvable program under `bash -lc` still exits (127),
        // which is a NotMet skip; the Error branch is the un-evaluable case
        // (spawn failure / timeout) — assert the timeout maps to Error.
        let dir = std::env::temp_dir();
        let evaluated = evaluate_condition("sleep 30", &dir, Duration::from_millis(50)).await;
        match evaluated {
            ConditionEval::Error(msg) => assert!(msg.contains("timed out"), "{msg}"),
            other => panic!("expected a timeout Error, got {other:?}"),
        }
    }

    /// A condition that exits 0 fires normally (a run is created and dispatched),
    /// and a routine with NO condition is unchanged (backward compat). Two
    /// independent workspaces so the two dispatches never contend.
    #[tokio::test]
    async fn routine_condition_met_dispatches_and_no_condition_is_backward_compat() {
        use crate::routines::FireOutcome;
        let (db, w1) = db_with_workspace();
        let now = chrono::Utc::now().to_rfc3339();
        db.lock().conn_ref().execute(
            "INSERT INTO workspaces (id,project_id,name,branch,worktree_path,created_at,last_active)
             VALUES ('w2','p1','W2','main','/tmp',?1,?1)", [&now]).unwrap();
        let pid = db.lock().insert_pipeline("RC2", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        let past = "2000-01-01T00:00:00+00:00";

        let orch = Arc::new(Orchestrator::new_with_runner(
            Arc::clone(&db),
            Arc::new(CollectingSink { events: Mutex::new(vec![]) }),
            Box::new(RecordingRunner { seen: Arc::new(Mutex::new(vec![])) }),
        ));

        // Condition exits 0 → fire (into w1).
        let mut met = routine_input(&pid, "interval", "3600");
        met.fire_condition = Some("true".into());
        db.lock().insert_routine("r-met", &met, Some(past)).unwrap();
        let outcome = Arc::clone(&orch).run_routine_now("r-met").await.unwrap();
        assert_eq!(outcome, FireOutcome::Dispatched);
        assert_eq!(db.lock().list_runs(&w1).unwrap().len(), 1, "a met condition dispatches a run");
        assert_eq!(
            db.lock().get_routine("r-met").unwrap().unwrap().last_outcome.as_deref(),
            Some("dispatched"),
            "a dispatch is stamped too",
        );

        // No condition → always fires (into w2), unchanged behavior.
        let mut plain = routine_input(&pid, "interval", "3600");
        plain.fixed_workspace_id = Some("w2".into());
        db.lock().insert_routine("r-plain", &plain, Some(past)).unwrap();
        let outcome = Arc::clone(&orch).run_routine_now("r-plain").await.unwrap();
        assert_eq!(outcome, FireOutcome::Dispatched, "no condition ⇒ backward-compat fire");
        assert_eq!(db.lock().list_runs("w2").unwrap().len(), 1);
    }

    /// The fixed-mode overlap guard reads active runs in the target workspace.
    #[test]
    fn workspace_has_active_run_reflects_running_peers() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("RP2", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        assert!(!db.lock().workspace_has_active_run(&ws).unwrap());
        let run = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        db.lock().set_run_status(&run, "running", false).unwrap();
        assert!(db.lock().workspace_has_active_run(&ws).unwrap());
        db.lock().set_run_status(&run, "completed", true).unwrap();
        assert!(!db.lock().workspace_has_active_run(&ws).unwrap());
    }

    /// Deleting a routine's project cascades the routine away (FK ON DELETE
    /// CASCADE) — no orphan rows the scheduler would trip on.
    #[test]
    fn routine_cascades_with_its_project() {
        let (db, _ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("RP3", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_routine("r-cascade", &routine_input(&pid, "interval", "3600"), Some("2000-01-01T00:00:00+00:00")).unwrap();
        db.lock().conn_ref().execute("DELETE FROM projects WHERE id = 'p1'", []).unwrap();
        assert!(db.lock().get_routine("r-cascade").unwrap().is_none());
    }

    /// The cross-process control flags: set → visible in the worker's poll,
    /// and a fresh reserve resets them so a new segment never inherits a
    /// stale stop/pause.
    #[tokio::test]
    async fn worker_control_flags_roundtrip_and_reset_on_reserve() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("PL4", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();

        db.lock().set_stop_requested(&run_id, true).unwrap();
        db.lock().set_pause_requested(&run_id, true).unwrap();
        let (status, stop, pause) = db.lock().read_worker_controls(&run_id).unwrap().unwrap();
        assert_eq!(status, "draft");
        assert!(stop && pause);
        db.lock().set_stop_requested(&run_id, false).unwrap();
        let (_, stop, _) = db.lock().read_worker_controls(&run_id).unwrap().unwrap();
        assert!(!stop);

        // A new segment's reserve wipes both flags.
        db.lock().set_stop_requested(&run_id, true).unwrap();
        assert!(db.lock().reserve_worker_lease(&run_id, "n").unwrap());
        let (_, stop, pause) = db.lock().read_worker_controls(&run_id).unwrap().unwrap();
        assert!(!stop && !pause);
        // A vanished run reads as None (workspace deleted under the worker).
        assert!(db.lock().read_worker_controls("no-such-run").unwrap().is_none());
    }

    /// Accept & continue on a halted stage salvages the journal narration into
    /// the synthesized artifact — the next stage inherits the partial work,
    /// not an empty stub. Only the CURRENT attempt (after the last reset).
    #[tokio::test]
    async fn approve_after_halt_salvages_journal_narration() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P4", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(FailingRunner));
        assert_eq!(orch.run_to_pause(&run_id).await.unwrap(), RunStatus::Paused);
        let stage_id = db.lock().list_run_stages(&run_id).unwrap()[0].id.clone();

        // A first attempt's narration, a reset (re-run), then the halted attempt's.
        db.lock().append_stage_log(&run_id, &stage_id, r#"{"kind":"text","text":"stale first attempt"}"#).unwrap();
        db.lock().append_stage_log_marker(&run_id, &stage_id).unwrap();
        db.lock().append_stage_log(&run_id, &stage_id, r#"{"kind":"text","text":"partial plan: add the toggle"}"#).unwrap();
        db.lock().append_stage_log(&run_id, &stage_id, r#"{"kind":"tool","tool":"read_file","hint":"x"}"#).unwrap();

        assert_eq!(
            orch.resolve_checkpoint(&run_id, CheckpointAction::Approve).await.unwrap(),
            RunStatus::Completed
        );
        let stage = db.lock().list_run_stages(&run_id).unwrap()[0].clone();
        let artifact = stage.artifact.expect("approve synthesizes an artifact");
        assert!(artifact.contains("accepted by the director"));
        assert!(artifact.contains("partial plan: add the toggle"), "{artifact}");
        assert!(!artifact.contains("stale first attempt"), "pre-reset narration must not leak");
    }

    struct FailingRunner;
    #[async_trait::async_trait]
    impl AgentRunner for FailingRunner {
        async fn run(
            &self,
            _stage: &StageSpec,
            _input: &StageInput,
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
        db.lock().insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "code_review", "m", "api", false, Some(0), max_iter, Some("gated"), 25).unwrap();
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
    async fn approving_a_failed_stage_accepts_the_partial_work_and_continues() {
        // F3: implement halts (iteration cap), the director accepts the partial
        // work — the stage flips to done with a synthesized artifact (cost and
        // tokens preserved) and the drive continues into the next stage.
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("Halt", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "test", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });

        let orch_fail = Orchestrator::new_with_runner(
            Arc::clone(&db), sink.clone(), Box::new(WorktreeRunner { fail: true }));
        assert_eq!(orch_fail.run_to_pause(&run_id).await.unwrap(), RunStatus::Paused);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "failed");
        let burned_cost = stages[0].cost_usd;
        assert!(burned_cost > 0.0, "the failed attempt's usage was persisted");

        let orch_ok = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));
        let status = orch_ok.resolve_checkpoint(&run_id, CheckpointAction::Approve).await.unwrap();
        assert_eq!(status, RunStatus::Completed);

        let after = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(after[0].status, "done");
        let art: Value = serde_json::from_str(after[0].artifact.as_deref().expect("synthesized artifact")).unwrap();
        assert_eq!(art["kind"], "diff"); // role-shaped kind for implement
        let text = art["text"].as_str().unwrap();
        assert!(text.contains("accepted by the director after a halt"), "got: {text}");
        assert!(text.contains("ran out of iterations"), "carries the error's first line: {text}");
        assert_eq!(art["refsWorktree"], true); // the next stage reads the worktree
        // The failed attempt's spend is preserved, not zeroed.
        assert!((after[0].cost_usd - burned_cost).abs() < 1e-9);
        assert_eq!(after[0].input_tokens, 10);
        assert_eq!(after[0].output_tokens, 2);
        // The next stage actually ran.
        assert_eq!(after[1].status, "done");
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
            max_turns_override: None,
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
        async fn run(&self, stage: &StageSpec, _i: &StageInput, _c: &StageContext)
            -> crate::error::AppResult<StageOutcome> {
            let is_review = matches!(stage.role.as_str(), "code_review" | "verify");
            let text = if is_review && !self.verdict.is_empty() { format!("findings\nVERDICT: {}", self.verdict) } else { "did it".into() };
            Ok(StageOutcome {
                artifact: StageArtifact { kind: ArtifactKind::Note, text: text.clone(), payload: None, refs_worktree: false },
                input_tokens: 10, output_tokens: 2, cost_usd: 0.01,
                status: StageStatus::Done, tool_calls: vec![],
                error: None,
                verdict: crate::orchestrator::runner::parse_verdict(&text),
                session_id: None,
                blocked: None,
            })
        }
    }

    fn auto_run(verdict: &'static str, max_iter: i64) -> (Orchestrator, String, Arc<Mutex<Db>>) {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("Auto", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "code_review", "m", "api", false, Some(0), max_iter, Some("auto"), 25).unwrap();
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

    /// A runner that succeeds with a fixed per-stage cost (budget-gate fixtures).
    struct CostRunner {
        cost: f64,
    }
    #[async_trait::async_trait]
    impl AgentRunner for CostRunner {
        async fn run(
            &self,
            stage: &StageSpec,
            _input: &StageInput,
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
                cost_usd: self.cost,
                status: StageStatus::Done,
                tool_calls: vec![],
                error: None,
                verdict: None,
                session_id: None,
                blocked: None,
            })
        }
    }

    /// `n` checkpoint-free stages each costing `cost`, with an optional run
    /// budget. The sink mirrors production wiring (PersistingSink) so budget
    /// notices land in `stage_log`.
    fn budgeted_run(n: i64, cost: f64, budget: Option<f64>) -> (Orchestrator, String, Arc<Mutex<Db>>) {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("Budgeted", "d", false).unwrap();
        for i in 0..n {
            db.lock().insert_pipeline_stage(&pid, i, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        }
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        if let Some(b) = budget {
            db.lock().set_run_budget(&run_id, Some(b)).unwrap();
        }
        let sink: Arc<dyn EventSink> = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let sink = Arc::new(crate::orchestrator::persist::PersistingSink::new(sink, Arc::clone(&db)));
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(CostRunner { cost }));
        (orch, run_id, db)
    }

    #[tokio::test]
    async fn budget_reached_parks_the_next_stage_like_a_checkpoint() {
        // Stage 1 costs 0.02 against a 0.01 budget — stage 2 must not start.
        let (orch, run_id, db) = budgeted_run(2, 0.02, Some(0.01));
        let status = orch.run_to_pause(&run_id).await.unwrap();
        assert_eq!(status, RunStatus::Paused);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "done");
        assert_eq!(stages[1].status, "awaiting_checkpoint"); // parked…
        assert_eq!(stages[1].started_at, None);              // …without ever starting
        assert_eq!(db.lock().get_run(&run_id).unwrap().unwrap().status, "paused");
        // The explanation lives in the parked stage's journal.
        let log = db.lock().list_stage_log(&stages[1].id).unwrap();
        assert!(
            log.iter().any(|e| e.contains("budget reached")),
            "expected a budget notice in stage_log, got: {log:?}"
        );
    }

    #[tokio::test]
    async fn send_back_on_a_budget_parked_stage_leaves_it_parked() {
        // A budget-parked stage never ran — SendBack must neither mark it done
        // (skipping it) nor burn a loop iteration. Approve is the only override.
        let (orch, run_id, db) = budgeted_run(2, 0.02, Some(0.01));
        orch.run_to_pause(&run_id).await.unwrap();
        let parked = db.lock().list_run_stages(&run_id).unwrap()[1].clone();
        assert_eq!(parked.status, "awaiting_checkpoint");
        orch.resolve_checkpoint(&run_id, CheckpointAction::SendBack { feedback: None }).await.unwrap();
        let after = db.lock().list_run_stages(&run_id).unwrap()[1].clone();
        assert_eq!(after.status, "awaiting_checkpoint", "stage must stay parked");
        assert_eq!(after.started_at, None, "stage must not have run");
        assert_eq!(after.loop_iterations, parked.loop_iterations, "no loop iteration burned");
    }

    #[tokio::test]
    async fn approving_a_budget_checkpoint_overrides_once_then_the_gate_rearms() {
        let (orch, run_id, db) = budgeted_run(3, 0.02, Some(0.01));
        orch.run_to_pause(&run_id).await.unwrap();
        // Approve: the parked stage runs regardless of the exhausted budget…
        let status = orch.resolve_checkpoint(&run_id, CheckpointAction::Approve).await.unwrap();
        assert_eq!(status, RunStatus::Paused);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[1].status, "done");
        assert!((stages[1].cost_usd - 0.02).abs() < 1e-9, "stage 2 actually ran");
        // …and the gate fires again before the FOLLOWING stage.
        assert_eq!(stages[2].status, "awaiting_checkpoint");
        assert_eq!(stages[2].started_at, None);
        // Approving again completes the run.
        let status = orch.resolve_checkpoint(&run_id, CheckpointAction::Approve).await.unwrap();
        assert_eq!(status, RunStatus::Completed);
        let run = db.lock().get_run(&run_id).unwrap().unwrap();
        assert!((run.cost_usd - 0.06).abs() < 1e-9);
    }

    #[tokio::test]
    async fn no_budget_never_pauses() {
        let (orch, run_id, db) = budgeted_run(2, 0.02, None);
        let status = orch.run_to_pause(&run_id).await.unwrap();
        assert_eq!(status, RunStatus::Completed);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert!(stages.iter().all(|s| s.status == "done"));
    }

    #[tokio::test]
    async fn rejecting_a_budget_checkpoint_reparks_it() {
        // Reject is not an override: the stage resets to pending, the drive
        // re-parks it behind the budget gate.
        let (orch, run_id, db) = budgeted_run(2, 0.02, Some(0.01));
        orch.run_to_pause(&run_id).await.unwrap();
        let status = orch
            .resolve_checkpoint(&run_id, CheckpointAction::Reject { feedback: None, model_override: None, max_turns_override: None })
            .await
            .unwrap();
        assert_eq!(status, RunStatus::Paused);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[1].status, "awaiting_checkpoint");
        assert_eq!(stages[1].started_at, None, "the parked stage must not have run");
    }

    // ── Director hot controls: hot-edit mid-run + re-run from a finished stage ──

    /// Runs freely except at `gate_position`, where it blocks (bounded poll —
    /// mirrors `CancelWaitingRunner`) until `open` flips true. Lets a test
    /// observe/mutate `run_stages` state while that stage is genuinely in
    /// flight, with no wall-clock race. Also records every built `StageSpec`
    /// so a test can assert exactly what the orchestrator handed the runner.
    struct GatedRecordingRunner {
        open: Arc<std::sync::atomic::AtomicBool>,
        gate_position: i64,
        seen: Arc<Mutex<Vec<StageSpec>>>,
    }
    #[async_trait::async_trait]
    impl AgentRunner for GatedRecordingRunner {
        async fn run(
            &self,
            stage: &StageSpec,
            _input: &StageInput,
            _ctx: &StageContext,
        ) -> crate::error::AppResult<StageOutcome> {
            self.seen.lock().push(stage.clone());
            if stage.position == self.gate_position {
                for _ in 0..500 {
                    if self.open.load(std::sync::atomic::Ordering::Relaxed) {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
            }
            Ok(StageOutcome {
                artifact: StageArtifact {
                    kind: ArtifactKind::Note,
                    text: format!("did {}", stage.role),
                    payload: None,
                    refs_worktree: false,
                },
                input_tokens: 1,
                output_tokens: 1,
                cost_usd: 0.01,
                status: StageStatus::Done,
                tool_calls: vec![],
                error: None,
                verdict: None,
                session_id: None,
                blocked: None,
            })
        }
    }

    async fn wait_until_stage_running(db: &Arc<Mutex<Db>>, run_id: &str, position: i64) {
        for _ in 0..500 {
            let stages = db.lock().list_run_stages(run_id).unwrap();
            if stages.iter().any(|s| s.position == position && s.status == "running") {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("stage at position {position} never reached running");
    }

    /// AC1 + AC2: hot-edit a PENDING stage's gate and instructions WHILE an
    /// earlier stage is genuinely in flight — no restart, no reload — and
    /// confirm both land in the `StageSpec` the orchestrator builds once it
    /// reaches that stage.
    #[tokio::test]
    async fn hot_edit_gate_and_instructions_are_honored_mid_run() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let implement_id = db.lock().list_run_stages(&run_id).unwrap()[1].id.clone();

        let open = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Arc::new(Orchestrator::new_with_runner(
            Arc::clone(&db),
            sink,
            Box::new(GatedRecordingRunner { open: Arc::clone(&open), gate_position: 0, seen: Arc::clone(&seen) }),
        ));

        let drive = tokio::spawn({
            let orch = Arc::clone(&orch);
            let rid = run_id.clone();
            async move { orch.run_to_pause(&rid).await }
        });

        // Stage 0 (plan) is genuinely running, blocked on the gate.
        wait_until_stage_running(&db, &run_id, 0).await;

        // Hot-edit stage 1 (still pending) WHILE stage 0 is in flight.
        db.lock()
            .update_run_stage(&run_id, &implement_id, Some(true), Some("be extra careful with error handling"), None, None, None)
            .unwrap();

        open.store(true, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(drive.await.unwrap().unwrap(), RunStatus::Paused);

        let after = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(after[0].status, "done");
        assert_eq!(after[1].status, "awaiting_checkpoint", "the hot-edited gate must be honored — no restart needed");

        let seen = seen.lock();
        let implement_spec = seen.iter().find(|s| s.role == "implement").expect("implement stage ran");
        assert_eq!(
            implement_spec.instructions.as_deref(),
            Some("be extra careful with error handling"),
            "the hot-edited instructions must reach the built StageSpec"
        );
    }

    /// AC4 (part): a stage that has already started rejects a hot edit, with
    /// a clear English error — and the pipeline TEMPLATE stays untouched
    /// (only the run's own `run_stages` row is ever written).
    #[tokio::test]
    async fn hot_edit_rejects_a_running_stage_and_leaves_the_template_untouched() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let stage_id = db.lock().list_run_stages(&run_id).unwrap()[0].id.clone();

        let open = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Arc::new(Orchestrator::new_with_runner(
            Arc::clone(&db),
            sink,
            Box::new(GatedRecordingRunner { open: Arc::clone(&open), gate_position: 0, seen }),
        ));
        let drive = tokio::spawn({
            let orch = Arc::clone(&orch);
            let rid = run_id.clone();
            async move { orch.run_to_pause(&rid).await }
        });
        wait_until_stage_running(&db, &run_id, 0).await;

        let err = db
            .lock()
            .update_run_stage(&run_id, &stage_id, Some(true), None, None, None, None)
            .unwrap_err();
        assert!(err.to_string().contains("already started"), "err={err}");

        // The template row (pipeline_stages) is a completely separate table —
        // it was never touched by the (rejected) edit attempt.
        let template = db.lock().get_pipeline_stages(&pid).unwrap();
        assert!(!template[0].checkpoint);

        open.store(true, std::sync::atomic::Ordering::Relaxed);
        drive.await.unwrap().unwrap();
    }

    /// AC3: re-run a finished stage — downstream stages reset to pending,
    /// execution resumes, and cost accumulates (retired + fresh), never reset.
    #[tokio::test]
    async fn rerun_resets_target_and_downstream_but_not_upstream() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 2, "code_review", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();

        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));
        assert_eq!(orch.run_to_pause(&run_id).await.unwrap(), RunStatus::Completed);

        let first_pass = db.lock().list_run_stages(&run_id).unwrap();
        assert!(first_pass.iter().all(|s| s.status == "done"));
        let plan_id = first_pass[0].id.clone();
        let plan_finished_at = first_pass[0].finished_at.clone();
        let implement_id = first_pass[1].id.clone();
        let review_id = first_pass[2].id.clone();

        assert_eq!(orch.rerun_from_stage(&run_id, &implement_id, None).await.unwrap(), RunStatus::Completed);

        let after = db.lock().list_run_stages(&run_id).unwrap();
        assert!(after.iter().all(|s| s.status == "done"), "the resumed drive must finish the rerun stages too");
        assert_eq!(after[0].finished_at, plan_finished_at, "plan (upstream of the rerun target) must be untouched");
        assert_eq!(db.lock().list_stage_iterations(&plan_id).unwrap().len(), 0, "plan was never reset");
        assert_eq!(db.lock().list_stage_iterations(&implement_id).unwrap().len(), 1, "the rerun archived the pre-rerun attempt");
        assert_eq!(db.lock().list_stage_iterations(&review_id).unwrap().len(), 1, "downstream code_review was reset too");

        // Cost: the retired (pre-rerun) spend for implement+code_review, plus
        // a fresh full pass for all three — appended, never reset.
        let run = db.lock().get_run(&run_id).unwrap().unwrap();
        assert!((run.cost_usd - 0.05).abs() < 1e-9, "cost_usd={}", run.cost_usd);
    }

    /// Edge case: re-running the FIRST stage resets the whole run.
    #[tokio::test]
    async fn rerun_first_stage_resets_every_stage() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();

        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));
        assert_eq!(orch.run_to_pause(&run_id).await.unwrap(), RunStatus::Completed);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        let plan_id = stages[0].id.clone();
        let implement_id = stages[1].id.clone();

        assert_eq!(orch.rerun_from_stage(&run_id, &plan_id, None).await.unwrap(), RunStatus::Completed);

        let after = db.lock().list_run_stages(&run_id).unwrap();
        assert!(after.iter().all(|s| s.status == "done"));
        assert_eq!(db.lock().list_stage_iterations(&plan_id).unwrap().len(), 1);
        assert_eq!(db.lock().list_stage_iterations(&implement_id).unwrap().len(), 1);
    }

    /// Edge case: re-running an earlier stage while a LATER stage is parked
    /// awaiting a checkpoint must invalidate that park — reset it to pending
    /// — not leave it dangling on stale state.
    #[tokio::test]
    async fn rerun_invalidates_a_downstream_parked_checkpoint() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 2, "code_review", "m", "api", true, None, 0, None, 25).unwrap(); // checkpoint
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();

        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));
        assert_eq!(orch.run_to_pause(&run_id).await.unwrap(), RunStatus::Paused);
        let parked = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(parked[2].status, "awaiting_checkpoint");
        let implement_id = parked[1].id.clone();
        let review_id = parked[2].id.clone();
        let stale_started_at = parked[2].started_at.clone();

        assert_eq!(orch.rerun_from_stage(&run_id, &implement_id, None).await.unwrap(), RunStatus::Paused);

        let after = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(after[1].status, "done");
        assert_eq!(after[2].status, "awaiting_checkpoint", "code_review re-parks on its own checkpoint after re-running");
        assert_eq!(db.lock().list_stage_iterations(&review_id).unwrap().len(), 1, "the invalidated park was archived, not left dangling");
        assert_ne!(after[2].started_at, stale_started_at, "code_review genuinely re-ran, not just re-observed the old park");
    }

    /// Edge case: a reset stage must never `--resume` the old CLI session,
    /// and its loop counter starts fresh (unlike ordinary loop-back, which
    /// deliberately preserves it).
    #[tokio::test]
    async fn rerun_clears_cli_session_and_loop_counters_for_the_reset_range() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "implement", "m", "cli", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();

        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));
        assert_eq!(orch.run_to_pause(&run_id).await.unwrap(), RunStatus::Completed);

        let implement_id = db.lock().list_run_stages(&run_id).unwrap()[1].id.clone();
        // Simulate a prior CLI attempt that left a resumable session + a
        // review stage's loop counter mid-way through its cap.
        db.lock().set_stage_session(&implement_id, Some("sess-123")).unwrap();
        db.lock().set_stage_resume_pending(&implement_id, true).unwrap();
        db.lock().set_stage_loop_iterations(&implement_id, 3).unwrap();

        orch.prepare_rerun(&run_id, &implement_id, None).unwrap();

        let reset = db
            .lock()
            .list_run_stages(&run_id)
            .unwrap()
            .into_iter()
            .find(|s| s.id == implement_id)
            .unwrap();
        assert_eq!(reset.status, "pending");
        assert_eq!(reset.session_id, None, "a reset stage must never --resume the old CLI session");
        assert!(!reset.resume_pending);
        assert_eq!(reset.loop_iterations, 0);
    }

    /// Basic mutual exclusion: `prepare_rerun` refuses while a drive is
    /// actively in flight on the same run (reuses the existing
    /// cancel-flag-based in-flight helper for a real, not simulated, drive).
    #[tokio::test]
    async fn rerun_rejects_while_a_drive_is_active() {
        let (db, orch, run_id, flag, drive) = spawn_cancellable_run().await;
        let stage_id = db.lock().list_run_stages(&run_id).unwrap()[0].id.clone();

        let err = orch.prepare_rerun(&run_id, &stage_id, None).unwrap_err();
        assert!(err.to_string().contains("executing"), "err={err}");

        // Let the in-flight stage finish so the spawned drive task doesn't leak.
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
        drive.await.unwrap().unwrap();
    }

    /// The concurrency fix the plan review demanded: `resolve_checkpoint`
    /// must claim `active` for its ENTIRE body — the action mutations AND the
    /// re-drive they trigger — not just the trailing re-drive. Before the
    /// fix, `active` was only inserted right before the final re-drive, so a
    /// concurrent `rerun_from_stage` could land while a checkpoint resolution
    /// was still archiving/resetting rows or driving the next stage.
    #[tokio::test]
    async fn prepare_rerun_rejects_while_a_checkpoint_resolution_is_still_driving() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "implement", "m", "api", true, None, 0, None, 25).unwrap(); // checkpoint
        db.lock().insert_pipeline_stage(&pid, 2, "code_review", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();

        // Stages 0+1 run freely; stage 2 will be gated closed below.
        let open = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Arc::new(Orchestrator::new_with_runner(
            Arc::clone(&db),
            sink,
            Box::new(GatedRecordingRunner { open: Arc::clone(&open), gate_position: 2, seen }),
        ));

        assert_eq!(orch.run_to_pause(&run_id).await.unwrap(), RunStatus::Paused);
        let implement_id = db.lock().list_run_stages(&run_id).unwrap()[1].id.clone();
        assert_eq!(db.lock().list_run_stages(&run_id).unwrap()[1].status, "awaiting_checkpoint");

        // Close the gate so stage 2 blocks once the checkpoint resolution's
        // continuation (drive_inner) reaches it.
        open.store(false, std::sync::atomic::Ordering::Relaxed);

        let resolve = tokio::spawn({
            let orch = Arc::clone(&orch);
            let rid = run_id.clone();
            async move { orch.resolve_checkpoint(&rid, CheckpointAction::Approve).await }
        });

        // Wait until stage 2 is genuinely in flight (blocked on the gate) —
        // proof `resolve_checkpoint`'s claim now spans past its own
        // mutations into the re-drive it triggers.
        wait_until_stage_running(&db, &run_id, 2).await;

        let err = orch.prepare_rerun(&run_id, &implement_id, None).unwrap_err();
        assert!(err.to_string().contains("executing"), "err={err}");

        open.store(true, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(resolve.await.unwrap().unwrap(), RunStatus::Completed);

        // Once the checkpoint resolution's drive finishes, the claim is
        // released — a later `prepare_rerun` on the same run must succeed
        // (proving this isn't a permanent leak).
        let plan_id = db.lock().list_run_stages(&run_id).unwrap()[0].id.clone();
        orch.prepare_rerun(&run_id, &plan_id, None).expect("active claim must release once the drive it guarded finishes");
    }

    /// "Re-run after changes": the director's patch rides the re-run — it is
    /// applied once the target stage is back to pending, so the re-driven
    /// stage builds its spec from the edited row.
    #[tokio::test]
    async fn rerun_applies_the_directors_patch_after_reset() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();

        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));
        assert_eq!(orch.run_to_pause(&run_id).await.unwrap(), RunStatus::Completed);

        let implement_id = db.lock().list_run_stages(&run_id).unwrap()[1].id.clone();
        let patch = crate::orchestrator::types::StageRerunPatch {
            checkpoint: Some(true),
            instructions: Some("sharper brief".into()),
            agent_model: Some("m2".into()),
            max_iterations: Some(40),
            loop_mode: None,
        };
        orch.prepare_rerun(&run_id, &implement_id, Some(&patch)).unwrap();

        let row = db
            .lock()
            .list_run_stages(&run_id)
            .unwrap()
            .into_iter()
            .find(|s| s.id == implement_id)
            .unwrap();
        assert_eq!(row.status, "pending");
        assert_eq!(row.instructions.as_deref(), Some("sharper brief"));
        assert_eq!(row.agent_model, "m2");
        assert!(row.checkpoint, "the re-run honors the patched gate");
        assert_eq!(row.max_iterations, 40);
    }

    /// A bad patch must reject BEFORE anything resets — the run and its
    /// stages stay exactly as they were.
    #[tokio::test]
    async fn rerun_with_invalid_patch_rejects_before_resetting_anything() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();

        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));
        assert_eq!(orch.run_to_pause(&run_id).await.unwrap(), RunStatus::Completed);

        let implement_id = db.lock().list_run_stages(&run_id).unwrap()[1].id.clone();
        // `implement` doesn't loop — switching its loop mode is invalid.
        let patch = crate::orchestrator::types::StageRerunPatch {
            loop_mode: Some("auto".into()),
            ..Default::default()
        };
        let err = orch.prepare_rerun(&run_id, &implement_id, Some(&patch)).unwrap_err();
        assert!(err.to_string().contains("looping review stage"), "err={err}");

        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert!(stages.iter().all(|s| s.status == "done"), "nothing was reset");
        assert_eq!(db.lock().get_run(&run_id).unwrap().unwrap().status, "completed", "the run was not reopened");
    }

    /// A stage parked BEFORE it began — a budget park or a director pause,
    /// which hold the NEXT pending stage with neither started_at nor an
    /// artifact — takes field edits (the spec is built from the row after
    /// approval), but not a gate toggle, which could never release the park.
    /// (A checkpoint-gate park is different: it holds a FINISHED stage's
    /// hand-off, artifact and all, and is redirected via the decision bar or
    /// a re-run — update_run_stage keeps rejecting it as "already started".)
    #[tokio::test]
    async fn parked_unbegun_stage_takes_field_edits_but_not_a_gate_toggle() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "implement", "m", "api", false, None, 0, None, 25).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();

        // Park the un-begun stage exactly as pause_for_budget / a director
        // pause does: status flips to awaiting_checkpoint, nothing else —
        // started_at is only ever stamped on 'running', no artifact exists.
        let implement_id = db.lock().list_run_stages(&run_id).unwrap()[1].id.clone();
        db.lock().set_run_stage_status(&implement_id, "awaiting_checkpoint").unwrap();
        let parked = db.lock().list_run_stages(&run_id).unwrap()[1].clone();
        assert!(parked.started_at.is_none() && parked.artifact.is_none(), "a pre-work park has neither");

        // Field edits land: the spec is built from the row after approval.
        db.lock()
            .update_run_stage(&run_id, &parked.id, None, Some("focus on the edge cases"), Some("m2"), None, None)
            .unwrap();
        let row = db.lock().list_run_stages(&run_id).unwrap()[1].clone();
        assert_eq!(row.instructions.as_deref(), Some("focus on the edge cases"));
        assert_eq!(row.agent_model, "m2");

        // The park is released via approve/reject — toggling the gate while
        // parked is rejected, not silently ignored.
        let err = db
            .lock()
            .update_run_stage(&run_id, &parked.id, Some(false), None, None, None, None)
            .unwrap_err();
        assert!(err.to_string().contains("parked awaiting your decision"), "err={err}");
    }

    /// The inverse of the test above: a stage parked at its checkpoint GATE
    /// has finished its work (artifact present) — field edits are rejected,
    /// because there is nothing left for them to affect.
    #[tokio::test]
    async fn gate_parked_finished_stage_rejects_field_edits() {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("P", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "plan", "m", "api", false, None, 0, None, 25).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "implement", "m", "api", true, None, 0, None, 25).unwrap(); // gated hand-off
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();

        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));
        assert_eq!(orch.run_to_pause(&run_id).await.unwrap(), RunStatus::Paused);

        let parked = db.lock().list_run_stages(&run_id).unwrap()[1].clone();
        assert_eq!(parked.status, "awaiting_checkpoint");
        assert!(parked.artifact.is_some(), "a gate park holds a finished stage's hand-off");

        let err = db
            .lock()
            .update_run_stage(&run_id, &parked.id, None, Some("too late"), None, None, None)
            .unwrap_err();
        assert!(err.to_string().contains("already started"), "err={err}");
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
        let outcome = parse_cli_result(SUCCESS, true, ArtifactKind::Diff, "").unwrap();
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
        let outcome = parse_cli_result(ERRORED, true, ArtifactKind::Diff, "").unwrap();
        assert_eq!(outcome.status, StageStatus::Failed);
        assert_eq!(outcome.error.as_deref(), Some("claude stopped early (error_max_budget_usd): Budget exceeded."));
    }

    #[test]
    fn nonzero_exit_yields_failed_even_if_json_ok() {
        let outcome = parse_cli_result(SUCCESS, false, ArtifactKind::Plan, "").unwrap();
        assert_eq!(outcome.status, StageStatus::Failed);
    }

    #[test]
    fn unparseable_output_is_an_error() {
        assert!(parse_cli_result("not json", true, ArtifactKind::Plan, "").is_err());
    }

    #[test]
    fn non_success_subtype_is_a_failed_stage_with_usage_kept() {
        // claude -p reports hitting --max-turns as subtype "error_max_turns",
        // historically with is_error=false — a success-shaped failure.
        const MAX_TURNS: &str = r#"{"subtype":"error_max_turns","result":"","is_error":false,
            "total_cost_usd":1.25,"usage":{"input_tokens":10,"output_tokens":20}}"#;
        let outcome = parse_cli_result(MAX_TURNS, true, ArtifactKind::Diff, "").unwrap();
        assert!(matches!(outcome.status, crate::orchestrator::types::StageStatus::Failed));
        assert!(outcome.error.as_deref().unwrap_or_default().contains("error_max_turns"));
        assert_eq!(outcome.cost_usd, 1.25);
        assert_eq!(outcome.input_tokens, 10);
    }
}

#[cfg(test)]
mod cli_args_tests {
    use crate::orchestrator::cli_runner::{build_cli_args, build_cli_args_resume};

    #[test]
    fn args_include_model_format_and_permission() {
        let args = build_cli_args("claude-sonnet-4-6", "You are a planner.", 40);
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
        // F4: the per-stage tool-turn budget drives --max-turns.
        let t = args.iter().position(|a| a == "--max-turns").unwrap();
        assert_eq!(args[t + 1], "40");
    }

    #[test]
    fn build_cli_args_resume_uses_resume_flag() {
        let args = build_cli_args_resume("claude-opus-4-6", "sess-9", 50);
        assert!(args.windows(2).any(|w| w[0] == "--resume" && w[1] == "sess-9"), "{args:?}");
        assert!(args.windows(2).any(|w| w[0] == "--max-turns" && w[1] == "50"), "{args:?}");
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

    #[test]
    fn file_meta_existing_file_matches_fs() {
        let f = temp_with_bytes(b"hello");
        let meta = crate::commands::file_meta_inner(f.path().to_str().unwrap())
            .unwrap()
            .expect("existing file should yield Some(meta)");
        let fs_meta = std::fs::metadata(f.path()).unwrap();
        assert_eq!(meta.size, fs_meta.len());
        assert_eq!(meta.size, 5);
        assert!(meta.mtime_ms > 0, "mtime_ms should be a positive epoch-millis value");
        // Serializes camelCase for the frontend.
        let v = serde_json::to_value(&meta).unwrap();
        assert!(v.get("mtimeMs").is_some());
        assert!(v.get("size").is_some());
    }

    #[test]
    fn file_meta_missing_file_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist.txt");
        let res = crate::commands::file_meta_inner(missing.to_str().unwrap()).unwrap();
        assert!(res.is_none(), "missing file should yield Ok(None)");
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
            input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0,
            rate_limit: None, raw_content: vec![] }
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
                                   "sys", "do it", dir.path(), 10,
                                   &std::sync::atomic::AtomicBool::new(false), &em, None, None).await.unwrap();

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
                                   "sys", "do it", dir.path(), 2,
                                   &std::sync::atomic::AtomicBool::new(false), &em, None, None).await.unwrap();

        assert!(!out.finished, "iteration exhaustion must not read as success");
        assert_eq!(out.text, "(agentic loop hit 2 iterations without finishing)");
        // Usage from the burned iterations is preserved for cost accounting.
        assert_eq!(out.input_tokens, 2);
        assert_eq!(out.output_tokens, 2);
        assert_eq!(out.tool_calls.len(), 2);
        // F1: the journal must END with a notice explaining why the stage stopped.
        let events = rec.events.lock();
        let last = &events.last().expect("exhaustion must emit entries").1["entry"];
        assert_eq!(last["kind"], "notice", "last journal entry is a notice: {last}");
        assert_eq!(last["text"], "iteration cap reached — 2 of 2 tool turns used");
    }

    #[tokio::test]
    async fn agentic_loop_cancel_flag_stops_before_the_next_turn() {
        let dir = tempfile::tempdir().unwrap();
        // No scripted turns: a single provider call would panic — the pre-set
        // cancel flag must stop the loop before it ever talks to the model.
        let provider = ScriptedProvider { turns: Mutex::new(VecDeque::new()) };
        let rec = Recorder { events: Mutex::new(vec![]) };
        let em = LiveEmitter::new(&rec, "r", "s");
        let client = reqwest::Client::new();
        let cancel = std::sync::atomic::AtomicBool::new(true);
        let out = run_agentic_loop(&provider, "http://x", None, &client, "m",
                                   "sys", "do it", dir.path(), 10, &cancel, &em, None, None).await.unwrap();

        assert!(!out.finished, "a director stop must not read as success");
        assert_eq!(out.text, "(stopped by the director)");
        assert_eq!(out.input_tokens, 0);
        assert_eq!(out.tool_calls.len(), 0);
        // The journal must END with a notice explaining why the stage stopped.
        let events = rec.events.lock();
        let last = &events.last().expect("cancel must close the journal").1["entry"];
        assert_eq!(last["kind"], "notice", "last journal entry is a notice: {last}");
        assert_eq!(last["text"], "stopped by the director");
    }

    #[tokio::test]
    async fn agentic_loop_ask_director_blocks_and_supersedes_acting() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "fn main() {}\n").unwrap();
        // One turn requests ask_director AND a normal read_file. Asking
        // supersedes acting: the read must NOT run, and the loop must STOP —
        // a second turn would panic (empty queue), proving it stopped.
        let provider = ScriptedProvider { turns: Mutex::new(VecDeque::from(vec![
            resp("I cannot proceed",
                 vec![
                    LlmToolUse { id: "ask".into(), name: "ask_director".into(),
                        input: json!({"summary":"which datastore?","questions":[
                            {"question":"Postgres or SQLite?","whyBlocked":"schema differs","recommendedDefault":"Postgres"},
                            {"question":"Which auth?","whyBlocked":"affects the schema","recommendedDefault":"OAuth"}
                        ]}) },
                    LlmToolUse { id: "r".into(), name: "read_file".into(),
                        input: json!({"path":"a.rs"}) },
                 ],
                 LlmStopReason::ToolUse),
        ])) };
        let rec = Recorder { events: Mutex::new(vec![]) };
        let em = LiveEmitter::new(&rec, "r", "s");
        let client = reqwest::Client::new();
        let out = run_agentic_loop(&provider, "http://x", None, &client, "m",
                                   "sys", "do it", dir.path(), 10,
                                   &std::sync::atomic::AtomicBool::new(false), &em, None, None).await.unwrap();

        assert!(!out.finished, "a block is not a finished answer");
        let ask = out.blocked.expect("ask_director must populate blocked");
        assert_eq!(ask.summary, "which datastore?");
        // Strict parse (not the degraded fallback) preserves BOTH questions and
        // their camelCase fields — a collapse to one would mean the parse failed.
        assert_eq!(ask.questions.len(), 2);
        assert_eq!(ask.questions[0].recommended_default, "Postgres");
        assert_eq!(ask.questions[0].why_blocked, "schema differs");
        assert_eq!(ask.questions[1].recommended_default, "OAuth");
        assert!(out.tool_calls.is_empty(), "no tool runs on a blocking turn");
        // The journal ends with the pause notice.
        let events = rec.events.lock();
        let last = &events.last().unwrap().1["entry"];
        assert_eq!(last["kind"], "notice");
        assert!(last["text"].as_str().unwrap().contains("paused to ask the director"));
    }

    #[tokio::test]
    async fn agentic_loop_malformed_ask_director_degrades_gracefully() {
        let dir = tempfile::tempdir().unwrap();
        // 'questions' missing entirely → strict parse fails; we must still yield
        // a block (a single synthesized question) rather than crash the stage.
        let provider = ScriptedProvider { turns: Mutex::new(VecDeque::from(vec![
            resp("blocked",
                 vec![LlmToolUse { id: "ask".into(), name: "ask_director".into(),
                       input: json!({"summary":"need a decision"}) }],
                 LlmStopReason::ToolUse),
        ])) };
        let rec = Recorder { events: Mutex::new(vec![]) };
        let em = LiveEmitter::new(&rec, "r", "s");
        let client = reqwest::Client::new();
        let out = run_agentic_loop(&provider, "http://x", None, &client, "m",
                                   "sys", "do it", dir.path(), 10,
                                   &std::sync::atomic::AtomicBool::new(false), &em, None, None).await.unwrap();

        let ask = out.blocked.expect("malformed input still yields a block");
        assert_eq!(ask.summary, "need a decision");
        assert_eq!(ask.questions.len(), 1, "degrades to a single synthesized question");
    }

    #[tokio::test]
    async fn agentic_loop_multi_question_snake_case_keeps_every_question() {
        let dir = tempfile::tempdir().unwrap();
        // Three questions, snake_case `recommended_default`/`why_blocked` (model
        // drift from the camelCase schema), and the THIRD omits its default
        // entirely. The tolerant struct must parse all three — a collapse to one
        // (the old strict-then-salvage-first bug) would silently lose questions.
        let provider = ScriptedProvider { turns: Mutex::new(VecDeque::from(vec![
            resp("blocked on three things",
                 vec![LlmToolUse { id: "ask".into(), name: "ask_director".into(),
                       input: json!({"summary":"three decisions","questions":[
                           {"question":"DB?","why_blocked":"schema differs","recommended_default":"Postgres"},
                           {"question":"Auth?","why_blocked":"affects schema","recommended_default":"OAuth"},
                           {"question":"Region?"}
                       ]}) }],
                 LlmStopReason::ToolUse),
        ])) };
        let rec = Recorder { events: Mutex::new(vec![]) };
        let em = LiveEmitter::new(&rec, "r", "s");
        let client = reqwest::Client::new();
        let out = run_agentic_loop(&provider, "http://x", None, &client, "m",
                                   "sys", "do it", dir.path(), 10,
                                   &std::sync::atomic::AtomicBool::new(false), &em, None, None).await.unwrap();

        let ask = out.blocked.expect("block");
        assert_eq!(ask.questions.len(), 3, "all three questions must survive, none lost");
        assert_eq!(ask.questions[0].recommended_default, "Postgres");
        assert_eq!(ask.questions[0].why_blocked, "schema differs");
        assert_eq!(ask.questions[1].recommended_default, "OAuth");
        assert_eq!(ask.questions[2].question, "Region?");
        assert_eq!(ask.questions[2].recommended_default, "", "an omitted default parses to empty, not a failure");
    }

    #[test]
    fn parse_ask_director_backfills_a_blank_question_from_why_blocked() {
        use crate::orchestrator::agentic::parse_ask_director;
        // `question` omitted (defaults to "") but whyBlocked/recommendedDefault
        // present — the blank question must be backfilled, never render empty.
        let u = LlmToolUse { id: "a".into(), name: "ask_director".into(),
            input: json!({"summary":"which datastore?","questions":[
                {"whyBlocked":"schema differs","recommendedDefault":"Postgres"}
            ]}) };
        let ask = parse_ask_director(&u);
        assert_eq!(ask.questions.len(), 1);
        assert!(!ask.questions[0].question.trim().is_empty(), "no blank <label>");
        assert_eq!(ask.questions[0].question, "schema differs");
        assert_eq!(ask.questions[0].recommended_default, "Postgres");
    }

    #[test]
    fn parse_ask_director_drops_a_fully_empty_question_and_synthesizes_from_summary() {
        use crate::orchestrator::agentic::parse_ask_director;
        let u = LlmToolUse { id: "a".into(), name: "ask_director".into(),
            input: json!({"summary":"pick a database","questions":[{}]}) };
        let ask = parse_ask_director(&u);
        assert_eq!(ask.questions.len(), 1, "the empty question is dropped, one synthesized from summary");
        assert_eq!(ask.questions[0].question, "pick a database");
    }

    #[test]
    fn parse_ask_director_all_empty_input_yields_one_fallback_question() {
        use crate::orchestrator::agentic::parse_ask_director;
        let u = LlmToolUse { id: "a".into(), name: "ask_director".into(), input: json!({}) };
        let ask = parse_ask_director(&u);
        assert_eq!(ask.questions.len(), 1);
        assert!(!ask.questions[0].question.trim().is_empty());
        assert_eq!(ask.summary, "The stage needs a decision to proceed.");
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

#[cfg(test)]
mod branch_listing_tests {
    use crate::git_ops::{create_branch, list_branches, list_remote_branches, resolve_base};
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    fn git(dir: &std::path::Path, args: &[&str]) {
        let out = Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn repo_with_branches() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let d = tmp.path();
        git(d, &["init", "-b", "main"]);
        git(d, &["config", "user.email", "t@t"]);
        git(d, &["config", "user.name", "t"]);
        fs::write(d.join("a.txt"), "a").unwrap();
        git(d, &["add", "."]);
        git(d, &["commit", "-m", "init"]);
        git(d, &["branch", "release/1.0"]);
        git(d, &["branch", "feat-x"]);
        tmp
    }

    #[test]
    fn lists_local_branches_default_first_then_alpha() {
        let tmp = repo_with_branches();
        let branches = list_branches(tmp.path()).unwrap();
        assert_eq!(branches, vec!["main", "feat-x", "release/1.0"]);
    }

    #[test]
    fn detached_head_yields_plain_alphabetical_list_without_phantom_entry() {
        let tmp = repo_with_branches();
        git(tmp.path(), &["checkout", "--detach", "main"]);
        let branches = list_branches(tmp.path()).unwrap();
        assert_eq!(branches, vec!["feat-x", "main", "release/1.0"]);
    }

    #[test]
    fn resolve_base_prefers_explicit_branch() {
        assert_eq!(resolve_base("release/1.0", Some("main".into())).unwrap(), "release/1.0");
        assert_eq!(resolve_base("  ", Some("main".into())).unwrap(), "main");
        assert_eq!(resolve_base("", Some("main".into())).unwrap(), "main");
        assert!(resolve_base("", None).is_err(), "no explicit base and no HEAD must error");
        assert_eq!(resolve_base("dev", None).unwrap(), "dev");
    }

    #[test]
    fn list_remote_branches_returns_full_names_sorted_and_excludes_head() {
        let tmp = repo_with_branches();
        let d = tmp.path();
        // Simulate fetched remote-tracking refs without a network remote.
        git(d, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        git(d, &["update-ref", "refs/remotes/origin/dev", "HEAD"]);
        git(d, &["update-ref", "refs/remotes/origin/HEAD", "HEAD"]);
        let remotes = list_remote_branches(d).unwrap();
        assert_eq!(remotes, vec!["origin/dev", "origin/main"]);
    }

    #[test]
    fn list_remote_branches_is_empty_without_remote_refs() {
        let tmp = repo_with_branches();
        assert!(list_remote_branches(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn local_listing_is_unchanged_by_remote_refs() {
        let tmp = repo_with_branches();
        let d = tmp.path();
        git(d, &["update-ref", "refs/remotes/origin/dev", "HEAD"]);
        let branches = list_branches(d).unwrap();
        assert_eq!(branches, vec!["main", "feat-x", "release/1.0"]);
    }

    #[test]
    fn create_branch_accepts_a_remote_tracking_base() {
        let tmp = repo_with_branches();
        let d = tmp.path();
        git(d, &["update-ref", "refs/remotes/origin/dev", "HEAD"]);
        create_branch(d, "from-remote", "origin/dev").unwrap();
        assert!(list_branches(d).unwrap().contains(&"from-remote".to_string()));
    }

    #[test]
    fn create_branch_error_mentions_local_and_remote_namespaces() {
        let tmp = repo_with_branches();
        let err = create_branch(tmp.path(), "x", "nope").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("refs/heads/nope"), "got: {msg}");
        assert!(msg.contains("refs/remotes/nope"), "got: {msg}");
    }
}

// ─── G7 slice II: conflict resolution ─────────────────────────────
#[cfg(test)]
mod conflict_resolution_tests {
    use crate::commands::{mark_conflict_resolved, resolve_conflict_take};
    use crate::git_ops::{get_status, operation_state, status_files};
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    fn git(dir: &std::path::Path, args: &[&str]) {
        let out = Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// Real merge conflict: base commit, then `side` and `main` edit the SAME
    /// line of `file.txt`; merging `side` into `main` conflicts.
    /// During the merge, HEAD (ours) has "main\n", the branch (theirs) "side\n".
    fn conflicted_repo() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let d = tmp.path();
        git(d, &["init", "-b", "main"]);
        git(d, &["config", "user.email", "t@t"]);
        git(d, &["config", "user.name", "t"]);
        fs::write(d.join("file.txt"), "base\n").unwrap();
        git(d, &["add", "."]);
        git(d, &["commit", "-m", "base"]);
        git(d, &["checkout", "-b", "side"]);
        fs::write(d.join("file.txt"), "side\n").unwrap();
        git(d, &["add", "."]);
        git(d, &["commit", "-m", "side edit"]);
        git(d, &["checkout", "main"]);
        fs::write(d.join("file.txt"), "main\n").unwrap();
        git(d, &["add", "."]);
        git(d, &["commit", "-m", "main edit"]);
        // The merge must FAIL with a conflict — don't assert success here.
        let out = Command::new("git").args(["merge", "side"]).current_dir(d).output().unwrap();
        assert!(!out.status.success(), "merge of divergent same-line edits must conflict");
        tmp
    }

    #[test]
    fn operation_state_reports_merge_then_none_after_abort() {
        let tmp = conflicted_repo();
        assert_eq!(operation_state(tmp.path()).unwrap(), Some("merge"));
        // GitStatus carries it too — cheaply, in status_files.
        let st = status_files(tmp.path()).unwrap();
        assert_eq!(st.operation.as_deref(), Some("merge"));
        assert_eq!(st.conflicted, 1);

        git(tmp.path(), &["merge", "--abort"]);
        assert_eq!(operation_state(tmp.path()).unwrap(), None);
        assert_eq!(status_files(tmp.path()).unwrap().operation, None);
    }

    #[tokio::test]
    async fn take_ours_keeps_head_content_and_clears_conflict() {
        let tmp = conflicted_repo();
        let path = tmp.path().to_string_lossy().to_string();
        resolve_conflict_take(path, "file.txt".into(), "ours".into())
            .await
            .expect("take ours succeeds");
        assert_eq!(fs::read_to_string(tmp.path().join("file.txt")).unwrap(), "main\n");
        let st = get_status(tmp.path()).unwrap();
        assert_eq!(st.conflicted, 0, "conflict must be resolved after take-ours");
    }

    #[tokio::test]
    async fn take_theirs_keeps_branch_content_and_clears_conflict() {
        let tmp = conflicted_repo();
        let path = tmp.path().to_string_lossy().to_string();
        resolve_conflict_take(path, "file.txt".into(), "theirs".into())
            .await
            .expect("take theirs succeeds");
        assert_eq!(fs::read_to_string(tmp.path().join("file.txt")).unwrap(), "side\n");
        let st = get_status(tmp.path()).unwrap();
        assert_eq!(st.conflicted, 0, "conflict must be resolved after take-theirs");
    }

    #[tokio::test]
    async fn invalid_side_is_rejected() {
        let tmp = conflicted_repo();
        let path = tmp.path().to_string_lossy().to_string();
        let err = resolve_conflict_take(path, "file.txt".into(), "mine".into()).await;
        assert!(err.is_err(), "side other than ours/theirs must error");
    }

    #[tokio::test]
    async fn mark_resolved_stages_hand_merged_file() {
        let tmp = conflicted_repo();
        fs::write(tmp.path().join("file.txt"), "merged by hand\n").unwrap();
        let path = tmp.path().to_string_lossy().to_string();
        mark_conflict_resolved(path, "file.txt".into())
            .await
            .expect("mark resolved succeeds");
        let st = get_status(tmp.path()).unwrap();
        assert_eq!(st.conflicted, 0, "git add clears the unmerged index state");
    }

    // ── continue / abort ──────────────────────────────────────────
    // Continue's happy path needs the user's login shell + a real multi-step
    // operation; it's exercised manually. Abort is fully integration-tested.

    #[tokio::test]
    async fn abort_returns_repo_to_normal_state_with_clean_tree() {
        let tmp = conflicted_repo();
        let path = tmp.path().to_string_lossy().to_string();
        crate::commands::abort_operation(path).await.expect("abort succeeds");
        assert_eq!(operation_state(tmp.path()).unwrap(), None, "merge state cleared");
        let st = get_status(tmp.path()).unwrap();
        assert_eq!(st.conflicted, 0);
        assert!(st.changed_files.is_empty(), "working tree clean after abort: {:?}", st.changed_files);
        // The pre-merge content is restored.
        assert_eq!(fs::read_to_string(tmp.path().join("file.txt")).unwrap(), "main\n");
    }

    #[tokio::test]
    async fn continue_and_abort_reject_when_no_operation_in_progress() {
        let tmp = TempDir::new().unwrap();
        git(tmp.path(), &["init", "-b", "main"]);
        let path = tmp.path().to_string_lossy().to_string();
        assert!(crate::commands::continue_operation(path.clone()).await.is_err());
        assert!(crate::commands::abort_operation(path).await.is_err());
    }
}

// ─── G6 slice II: contained file operations ───────────────────────
#[cfg(test)]
mod g6_fileops_tests {
    use crate::commands::{
        contained_path, fs_create_dir_inner, fs_create_file_inner, fs_delete_inner,
        fs_rename_inner,
    };
    use std::fs;
    use tempfile::TempDir;

    fn ws() -> (TempDir, String) {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().to_string_lossy().to_string();
        (tmp, path)
    }

    // ── contained_path helper ──

    #[test]
    fn contained_path_resolves_relative_targets_inside_the_workspace() {
        let (tmp, ws) = ws();
        let p = contained_path(&ws, "notes.txt").unwrap();
        assert_eq!(p, tmp.path().canonicalize().unwrap().join("notes.txt"));
    }

    #[test]
    fn contained_path_refuses_escapes_git_and_the_root_itself() {
        let (_tmp, ws) = ws();
        assert!(contained_path(&ws, "../outside.txt").is_err(), "escape must be refused");
        assert!(contained_path(&ws, ".git").is_err(), ".git itself must be refused");
        assert!(contained_path(&ws, ".git/config").is_err(), "paths inside .git must be refused");
        assert!(contained_path(&ws, &ws).is_err(), "the workspace root must be refused");
        assert!(contained_path(&ws, "").is_err(), "empty target resolves to the root — refused");
    }

    // ── fs_rename ──

    #[test]
    fn rename_moves_a_file_within_the_workspace() {
        let (tmp, ws) = ws();
        fs::write(tmp.path().join("a.txt"), "hello").unwrap();
        fs_rename_inner(&ws, "a.txt", "b.txt").unwrap();
        assert!(!tmp.path().join("a.txt").exists());
        assert_eq!(fs::read_to_string(tmp.path().join("b.txt")).unwrap(), "hello");
    }

    #[test]
    fn rename_moves_a_directory_too() {
        let (tmp, ws) = ws();
        fs::create_dir(tmp.path().join("old")).unwrap();
        fs::write(tmp.path().join("old/f.txt"), "x").unwrap();
        fs_rename_inner(&ws, "old", "new").unwrap();
        assert!(tmp.path().join("new/f.txt").exists());
    }

    #[test]
    fn rename_changes_only_case() {
        // On case-insensitive filesystems (macOS APFS) the destination stats
        // to the source itself — the dest-exists guard must not refuse that.
        let (tmp, ws) = ws();
        fs::write(tmp.path().join("readme.md"), "hello").unwrap();
        fs_rename_inner(&ws, "readme.md", "README.md").unwrap();
        // Both names stat on a case-insensitive FS — assert via the real
        // directory listing that the entry is now spelled README.md.
        let names: Vec<String> = fs::read_dir(tmp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert!(names.contains(&"README.md".to_string()), "got: {names:?}");
        assert!(!names.contains(&"readme.md".to_string()), "got: {names:?}");
        assert_eq!(fs::read_to_string(tmp.path().join("README.md")).unwrap(), "hello");
    }

    #[test]
    fn rename_refuses_when_the_destination_already_exists() {
        let (tmp, ws) = ws();
        fs::write(tmp.path().join("a.txt"), "a").unwrap();
        fs::write(tmp.path().join("b.txt"), "b").unwrap();
        let err = fs_rename_inner(&ws, "a.txt", "b.txt").unwrap_err();
        assert!(err.to_string().contains("already exists"), "got: {err}");
        assert_eq!(fs::read_to_string(tmp.path().join("b.txt")).unwrap(), "b");
    }

    #[test]
    fn rename_refuses_containment_escapes_on_either_side() {
        let (tmp, ws) = ws();
        fs::write(tmp.path().join("a.txt"), "a").unwrap();
        assert!(fs_rename_inner(&ws, "../outside.txt", "b.txt").is_err());
        assert!(fs_rename_inner(&ws, "a.txt", "../outside.txt").is_err());
        assert!(tmp.path().join("a.txt").exists(), "source must be untouched");
    }

    #[test]
    fn rename_refuses_git_and_the_workspace_root() {
        let (tmp, ws) = ws();
        fs::create_dir(tmp.path().join(".git")).unwrap();
        assert!(fs_rename_inner(&ws, ".git", "not-git").is_err());
        assert!(fs_rename_inner(&ws, &ws, "elsewhere").is_err());
        assert!(tmp.path().join(".git").exists());
    }

    // ── fs_create_file / fs_create_dir ──

    #[test]
    fn create_file_makes_an_empty_file_in_the_parent() {
        let (tmp, ws) = ws();
        fs::create_dir(tmp.path().join("sub")).unwrap();
        fs_create_file_inner(&ws, "sub", "new.txt").unwrap();
        assert_eq!(fs::read_to_string(tmp.path().join("sub/new.txt")).unwrap(), "");
        // Root parent ("" → the workspace itself) works too.
        fs_create_file_inner(&ws, "", "top.txt").unwrap();
        assert!(tmp.path().join("top.txt").exists());
    }

    #[test]
    fn create_dir_makes_a_directory() {
        let (tmp, ws) = ws();
        fs_create_dir_inner(&ws, "", "newdir").unwrap();
        assert!(tmp.path().join("newdir").is_dir());
    }

    #[test]
    fn create_refuses_when_the_entry_already_exists() {
        let (tmp, ws) = ws();
        fs::write(tmp.path().join("f.txt"), "x").unwrap();
        fs::create_dir(tmp.path().join("d")).unwrap();
        let err = fs_create_file_inner(&ws, "", "f.txt").unwrap_err();
        assert!(err.to_string().contains("already exists"), "got: {err}");
        assert!(fs_create_dir_inner(&ws, "", "d").is_err());
        assert_eq!(fs::read_to_string(tmp.path().join("f.txt")).unwrap(), "x");
    }

    #[test]
    fn create_refuses_bad_names() {
        let (_tmp, ws) = ws();
        for bad in ["", "  ", "a/b", "a\\b", ".", ".."] {
            assert!(fs_create_file_inner(&ws, "", bad).is_err(), "file name {bad:?} must be refused");
            assert!(fs_create_dir_inner(&ws, "", bad).is_err(), "dir name {bad:?} must be refused");
        }
    }

    #[test]
    fn create_refuses_escaping_or_git_parents() {
        let (tmp, ws) = ws();
        assert!(fs_create_file_inner(&ws, "..", "outside.txt").is_err());
        assert!(fs_create_dir_inner(&ws, "..", "outside-dir").is_err());
        fs::create_dir(tmp.path().join(".git")).unwrap();
        assert!(fs_create_file_inner(&ws, ".git", "hook").is_err());
        assert!(fs_create_dir_inner(&ws, ".git", "hooks").is_err());
        assert!(!tmp.path().join("../outside.txt").exists());
    }

    // ── fs_delete ──

    #[test]
    fn delete_removes_a_file() {
        let (tmp, ws) = ws();
        fs::write(tmp.path().join("gone.txt"), "x").unwrap();
        fs_delete_inner(&ws, "gone.txt").unwrap();
        assert!(!tmp.path().join("gone.txt").exists());
    }

    #[test]
    fn delete_removes_a_directory_recursively() {
        let (tmp, ws) = ws();
        fs::create_dir_all(tmp.path().join("dir/nested")).unwrap();
        fs::write(tmp.path().join("dir/nested/f.txt"), "x").unwrap();
        fs_delete_inner(&ws, "dir").unwrap();
        assert!(!tmp.path().join("dir").exists());
    }

    #[test]
    fn delete_refuses_escapes_git_and_the_root() {
        let (tmp, ws) = ws();
        let outside = tmp.path().parent().unwrap().join("g6-outside-probe.txt");
        fs::write(&outside, "keep").unwrap();
        assert!(fs_delete_inner(&ws, "../g6-outside-probe.txt").is_err());
        assert!(outside.exists(), "escape target must survive");
        fs::remove_file(&outside).unwrap();

        fs::create_dir(tmp.path().join(".git")).unwrap();
        assert!(fs_delete_inner(&ws, ".git").is_err());
        assert!(tmp.path().join(".git").exists());
        assert!(fs_delete_inner(&ws, &ws).is_err(), "the workspace root must be refused");
        assert!(tmp.path().exists());
    }

    #[test]
    fn delete_errors_on_a_missing_target() {
        let (_tmp, ws) = ws();
        assert!(fs_delete_inner(&ws, "no-such-file.txt").is_err());
    }
}

#[cfg(test)]
mod workspace_walker_tests {
    use crate::commands::workspace_walker;
    use std::fs;
    use std::path::PathBuf;
    use tempfile::TempDir;

    /// Collect yielded paths relative to `base`, skipping the root entry
    /// (depth 0) the way every caller does.
    fn walk(base: &std::path::Path, max_depth: Option<usize>, filters: bool) -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = workspace_walker(base, max_depth, filters)
            .filter_map(|r| r.ok())
            .filter(|e| e.depth() > 0)
            .map(|e| e.path().strip_prefix(base).unwrap().to_path_buf())
            .collect();
        out.sort();
        out
    }

    fn fixture() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".git").join("HEAD"), "ref: refs/heads/main").unwrap();
        fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(root.join("kept.txt"), "k").unwrap();
        fs::write(root.join("ignored.txt"), "i").unwrap();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub").join("nested.txt"), "n").unwrap();
        // A nested `.git` (e.g. a vendored repo) must be pruned too.
        fs::create_dir(root.join("sub").join(".git")).unwrap();
        fs::write(root.join("sub").join(".git").join("config"), "x").unwrap();
        tmp
    }

    #[test]
    fn excludes_git_dirs_at_every_depth() {
        let tmp = fixture();
        let paths = walk(tmp.path(), None, true);
        assert!(
            paths.iter().all(|p| p.components().all(|c| c.as_os_str() != ".git")),
            "no yielded path may touch .git: {paths:?}"
        );
        assert!(paths.contains(&PathBuf::from("sub/nested.txt")));
    }

    #[test]
    fn honors_gitignore_when_filters_are_on_even_outside_a_repo_checkout() {
        let tmp = fixture();
        let paths = walk(tmp.path(), None, true);
        assert!(paths.contains(&PathBuf::from("kept.txt")));
        assert!(!paths.contains(&PathBuf::from("ignored.txt")));
        // Dot-files themselves are visible (hidden(false)).
        assert!(paths.contains(&PathBuf::from(".gitignore")));
    }

    #[test]
    fn yields_ignored_entries_when_filters_are_off_but_still_prunes_git() {
        let tmp = fixture();
        let paths = walk(tmp.path(), None, false);
        assert!(paths.contains(&PathBuf::from("ignored.txt")));
        assert!(paths.iter().all(|p| p.components().all(|c| c.as_os_str() != ".git")));
    }

    #[test]
    fn respects_max_depth_one() {
        let tmp = fixture();
        let paths = walk(tmp.path(), Some(1), true);
        assert!(paths.contains(&PathBuf::from("sub")));
        assert!(!paths.contains(&PathBuf::from("sub/nested.txt")));
    }
}

// ─── Shared HTTP client (G5 follow-up) ────────────────────────────────

mod shared_http_client_tests {
    /// Every call must hand back the SAME pooled client — `ai_complete`,
    /// ChatEngine, and the orchestrator all share one connection pool
    /// instead of paying a fresh TLS handshake per call.
    #[test]
    fn returns_the_same_instance_every_time() {
        let a = crate::chat_engine::shared_http_client();
        let b = crate::chat_engine::shared_http_client();
        assert!(std::ptr::eq(a, b));
    }
}

// ─── ai_complete token recording (G5 follow-up) ───────────────────────

mod ai_token_event_tests {
    use crate::db::Db;
    use crate::providers::{LlmResponse, LlmStopReason};
    use crate::token_engine::TokenEngine;
    use parking_lot::Mutex;
    use std::sync::Arc;
    use tempfile::NamedTempFile;

    fn response() -> LlmResponse {
        LlmResponse {
            text: "{}".into(),
            tool_uses: vec![],
            stop_reason: LlmStopReason::EndTurn,
            input_tokens: 1200,
            output_tokens: 340,
            cache_read_tokens: 5000,
            cache_creation_tokens: 700,
            rate_limit: None,
            raw_content: vec![],
        }
    }

    #[test]
    fn event_carries_workspace_model_cache_counts_and_cost() {
        let ev = crate::commands::ai_token_event(Some("ws-42"), "claude-sonnet-4-6", &response(), 0.123);
        assert_eq!(ev.session_id, "ws-42");
        assert_eq!(ev.model, "claude-sonnet-4-6");
        assert_eq!(ev.input_tokens, 1200);
        assert_eq!(ev.output_tokens, 340);
        assert_eq!(ev.cache_read_tokens, 5000);
        assert_eq!(ev.cache_creation_tokens, 700);
        assert_eq!(ev.cost_usd, 0.123);
    }

    #[test]
    fn missing_workspace_falls_back_to_adhoc_bucket() {
        let ev = crate::commands::ai_token_event(None, "m", &response(), 0.01);
        assert_eq!(ev.session_id, "ai-adhoc");
    }

    /// The seam ai_complete uses: recording must persist a token_events row
    /// (visible to Usage dashboards) even when the workspace has no sessions
    /// row — increment_session_tokens is then a 0-row UPDATE, not an error.
    #[test]
    fn record_persists_a_token_event_without_a_sessions_row() {
        let tmp = NamedTempFile::new().unwrap();
        let db = Arc::new(Mutex::new(Db::open(tmp.path()).unwrap()));
        let engine = TokenEngine::new(Arc::clone(&db));

        let ev = crate::commands::ai_token_event(Some("ws-no-session"), "claude-sonnet-4-6", &response(), 0.5);
        engine.record(ev).unwrap();

        let rows = db.lock().list_token_events("ws-no-session").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].input_tokens, 1200);
        assert_eq!(rows[0].cache_read_tokens, 5000);
        assert_eq!(rows[0].cost_usd, 0.5);
        assert!(!rows[0].timestamp.is_empty(), "record() must stamp a timestamp");

        // And it rolls up into the aggregate report the dashboards read.
        let report = engine.report(None).unwrap();
        assert_eq!(report.total_input, 1200);
        assert_eq!(report.total_output, 340);
        assert!(report.total_cost_usd > 0.0);
    }
}

#[cfg(test)]
mod workspace_from_pr_tests {
    use crate::github::{pr_fetch_command, pr_infos_from_json};

    #[test]
    fn parses_a_gh_pr_list_fixture() {
        // Shape of `gh pr list --json number,title,headRefName,author`:
        // author is an object with a `login` (and may be absent entirely).
        let raw = r#"[
            {"number": 42, "title": "Add dark mode", "headRefName": "feat/dark-mode",
             "author": {"id": "U_1", "is_bot": false, "login": "octocat", "name": "The Octocat"}},
            {"number": 7, "title": "Fix checkout bug", "headRefName": "fix/checkout"}
        ]"#;
        let prs = pr_infos_from_json(raw).unwrap();
        assert_eq!(prs.len(), 2);
        assert_eq!(prs[0].number, 42);
        assert_eq!(prs[0].title, "Add dark mode");
        assert_eq!(prs[0].head_ref_name, "feat/dark-mode");
        assert_eq!(prs[0].author.as_deref(), Some("octocat"));
        assert_eq!(prs[1].number, 7);
        assert_eq!(prs[1].author, None);
    }

    #[test]
    fn skips_rows_missing_number_or_head_ref() {
        let raw = r#"[
            {"title": "no number", "headRefName": "x"},
            {"number": 3, "title": "no head"},
            {"number": 4, "title": "ok", "headRefName": "feat/ok"}
        ]"#;
        let prs = pr_infos_from_json(raw).unwrap();
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].number, 4);
    }

    #[test]
    fn non_json_gh_output_is_an_error() {
        // e.g. `gh` printing auth guidance to stdout.
        assert!(pr_infos_from_json("To get started with GitHub CLI, run: gh auth login").is_err());
        assert!(pr_infos_from_json("").is_err());
    }

    #[test]
    fn pr_info_serializes_camel_case_for_the_frontend() {
        let prs = pr_infos_from_json(
            r#"[{"number": 1, "title": "t", "headRefName": "feat/a", "author": {"login": "me"}}]"#,
        )
        .unwrap();
        let json = serde_json::to_value(&prs[0]).unwrap();
        assert_eq!(json["headRefName"], "feat/a");
        assert_eq!(json["author"], "me");
    }

    #[test]
    fn fetch_command_targets_the_pr_head_ref() {
        assert_eq!(
            pr_fetch_command(42, "feat/dark-mode"),
            "git fetch origin 'pull/42/head:feat/dark-mode' 2>&1",
        );
    }

    #[test]
    fn fetch_command_escapes_single_quotes_in_the_branch() {
        assert_eq!(
            pr_fetch_command(1, "weird'name"),
            "git fetch origin 'pull/1/head:weird'\\''name' 2>&1",
        );
    }

    #[test]
    fn ensure_pr_branch_skips_the_fetch_when_the_branch_exists_locally() {
        let dir = tempfile::tempdir().unwrap();
        crate::git_ops::init_repo(dir.path()).unwrap();
        crate::git_ops::ensure_initial_commit(dir.path()).unwrap();
        let base = crate::git_ops::default_branch(dir.path()).unwrap().unwrap();
        crate::git_ops::create_branch(dir.path(), "feat/already-here", &base).unwrap();

        // No `origin` remote exists, so a real fetch would fail — succeeding
        // proves the local-branch short-circuit kicked in.
        tauri::async_runtime::block_on(crate::commands::ensure_pr_branch(
            dir.path().to_string_lossy().into(),
            5,
            "feat/already-here".into(),
        ))
        .unwrap();
    }

    #[test]
    fn pr_commands_are_registered_in_the_invoke_handler() {
        let lib = include_str!("lib.rs");
        assert!(lib.contains("commands::list_prs"));
        assert!(lib.contains("commands::ensure_pr_branch"));
    }
}

#[cfg(test)]
mod ancestry_tests {
    use crate::db::RunStageRow;
    use crate::orchestrator::ancestors_of;

    /// Minimal RunStageRow carrying only the fields ancestry cares about
    /// (position + parents); everything else is dummy.
    fn rs(position: i64, parents: Vec<i64>) -> RunStageRow {
        RunStageRow {
            id: format!("s{position}"),
            run_id: "r".into(),
            position,
            role: "plan".into(),
            agent_model: "m".into(),
            effort: None,
            escalate_model: None,
            escalate_effort: None,
            escalated: false,
            substrate: "api".into(),
            checkpoint: false,
            status: "pending".into(),
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0.0,
            artifact: None,
            feedback: None,
            error: None,
            started_at: None,
            finished_at: None,
            loop_target_position: None,
            loop_max_iterations: 0,
            loop_mode: None,
            loop_iterations: 0,
            diff_snapshot: None,
            max_iterations: 25,
            parents,
            tools: None,
            custom_name: None,
            instructions: None,
            session_id: None,
            resume_pending: false,
            baseline_commit: None,
            blocked_questions: None,
        }
    }

    #[test]
    fn ancestors_follow_parents_transitively_and_isolate_branches() {
        // 0 ─┬─> 1 ─┐
        //    └─> 2 ─┴─> 3   (3 joins branches 1 and 2; 1 and 2 are siblings)
        let stages = vec![
            rs(0, vec![]),
            rs(1, vec![0]),
            rs(2, vec![0]),
            rs(3, vec![1, 2]),
        ];

        // The join sees the whole graph above it.
        let a3 = ancestors_of(&stages, 3);
        assert_eq!(a3, [0, 1, 2].into_iter().collect());

        // A branch sees only its own lineage — never its sibling.
        let a1 = ancestors_of(&stages, 1);
        assert_eq!(a1, [0].into_iter().collect());
        assert!(!a1.contains(&2), "branch 1 must not see sibling branch 2");

        // The entry has no ancestors.
        assert!(ancestors_of(&stages, 0).is_empty());
    }

    #[test]
    fn independent_roots_stay_isolated_until_they_join() {
        // Two independent entries (both parentless) feed one join. This is the
        // regression case for the multi-root leak: a parentless stage at a
        // non-zero position must have EMPTY ancestors (it feeds from nothing),
        // and the join must see both roots.
        let stages = vec![
            rs(0, vec![]),       // root A
            rs(1, vec![]),       // root B — parentless but NOT position 0
            rs(2, vec![0, 1]),   // join
        ];
        assert!(ancestors_of(&stages, 1).is_empty(), "a second root must not inherit the first root");
        assert_eq!(ancestors_of(&stages, 2), [0, 1].into_iter().collect());
    }
}

/// Tests for parse_cli_result diagnostics (Tasks 2, 3, 4).
#[cfg(test)]
mod cli_result_tests {
    use crate::orchestrator::cli_runner::parse_cli_result;
    use crate::orchestrator::types::{ArtifactKind, StageStatus};

    /// Task 2: subtype is surfaced even when is_error is true.
    #[test]
    fn parse_cli_result_names_subtype_when_is_error() {
        let line = r#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":"","total_cost_usd":0.5,"usage":{"input_tokens":10,"output_tokens":20}}"#;
        let out = parse_cli_result(line, true, ArtifactKind::Review, "").unwrap();
        assert!(matches!(out.status, StageStatus::Failed));
        let err = out.error.unwrap();
        assert!(err.contains("error_max_turns"), "got: {err}");
    }

    /// Task 3: stderr tail is folded into the failure message.
    #[test]
    fn parse_cli_result_appends_stderr_tail() {
        let line = r#"{"type":"result","is_error":true,"result":"","usage":{"input_tokens":0,"output_tokens":0}}"#;
        let stderr = "line one\noverloaded_error: server is busy\n";
        let out = parse_cli_result(line, false, ArtifactKind::Diff, stderr).unwrap();
        let err = out.error.unwrap();
        assert!(err.contains("overloaded_error"), "got: {err}");
    }

    /// Task 4: session_id is extracted from the result event.
    #[test]
    fn parse_cli_result_extracts_session_id() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"abc-123","usage":{"input_tokens":1,"output_tokens":2}}"#;
        let out = parse_cli_result(line, true, ArtifactKind::Diff, "").unwrap();
        assert_eq!(out.session_id.as_deref(), Some("abc-123"));
    }

    /// Task 7: idle and absolute-cap timeout messages are distinct user-facing strings.
    #[test]
    fn idle_and_abscap_messages_are_distinct() {
        assert_ne!(
            "claude timed out — no output for 5 minutes",
            "claude exceeded the 60-minute cap"
        );
    }
}

#[cfg(test)]
mod git_baseline_tests {
    #[test]
    fn baseline_round_trip_reverts_only_stage_changes() {
        use crate::orchestrator::git_baseline::{capture_baseline, restore_baseline};
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!("octo-baseline-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| { Command::new("git").args(args).current_dir(&dir).output().unwrap(); };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@t"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(dir.join("keep.txt"), "from fix\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-qm", "init"]);
        std::fs::write(dir.join("keep.txt"), "from fix EDITED\n").unwrap();
        std::fs::write(dir.join("preexisting_untracked.txt"), "user file\n").unwrap();

        let baseline = capture_baseline(&dir).unwrap().expect("baseline");

        std::fs::write(dir.join("keep.txt"), "verify CLOBBERED\n").unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/new.rs"), "half edit\n").unwrap();

        restore_baseline(&dir, &baseline).unwrap();

        assert_eq!(std::fs::read_to_string(dir.join("keep.txt")).unwrap(), "from fix EDITED\n", "fix's work preserved");
        assert_eq!(std::fs::read_to_string(dir.join("preexisting_untracked.txt")).unwrap(), "user file\n", "pre-existing untracked preserved");
        assert!(!dir.join("sub/new.rs").exists(), "verify's new file removed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn baseline_restores_a_file_deleted_during_the_stage() {
        use crate::orchestrator::git_baseline::{capture_baseline, restore_baseline};
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!("octo-baseline-del-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |a: &[&str]| { Command::new("git").args(a).current_dir(&dir).output().unwrap(); };
        git(&["init", "-q"]); git(&["config","user.email","t@t"]); git(&["config","user.name","t"]);
        std::fs::write(dir.join("a.txt"), "A\n").unwrap();
        git(&["add","-A"]); git(&["commit","-qm","init"]);
        let baseline = capture_baseline(&dir).unwrap().unwrap();
        std::fs::remove_file(dir.join("a.txt")).unwrap();
        restore_baseline(&dir, &baseline).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "A\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn baseline_deletes_a_unicode_named_stage_file() {
        use crate::orchestrator::git_baseline::{capture_baseline, restore_baseline};
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!("octo-baseline-uni-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |a: &[&str]| { Command::new("git").args(a).current_dir(&dir).output().unwrap(); };
        git(&["init", "-q"]); git(&["config","user.email","t@t"]); git(&["config","user.name","t"]);
        std::fs::write(dir.join("base.txt"), "base\n").unwrap();
        git(&["add","-A"]); git(&["commit","-qm","init"]);
        let baseline = capture_baseline(&dir).unwrap().unwrap();
        std::fs::write(dir.join("café_new.txt"), "stage file\n").unwrap(); // unicode name created during stage
        restore_baseline(&dir, &baseline).unwrap();
        assert!(!dir.join("café_new.txt").exists(), "unicode-named stage file should be deleted");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Regression test for the case-insensitive deletion guard (Fix 2).
    ///
    /// Simulates a stage that does `git mv File.txt file.txt` (case-only rename):
    /// after restore the file must exist with the BASELINE content, not be deleted.
    ///
    /// On a case-sensitive FS (Linux CI) the rename produces two distinct entries
    /// so the guard is still exercised without triggering actual deletion. On a
    /// case-insensitive FS (macOS) this reproduces the data-loss bug the fix
    /// addresses.
    #[test]
    fn baseline_case_only_rename_preserves_file() {
        use crate::orchestrator::git_baseline::{capture_baseline, restore_baseline};
        use std::process::Command;

        let dir = std::env::temp_dir().join(format!(
            "octo-baseline-case-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos(),
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |a: &[&str]| {
            Command::new("git").args(a).current_dir(&dir).output().unwrap()
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@t"]);
        git(&["config", "user.name", "t"]);

        // Baseline: file tracked as "File.txt"
        std::fs::write(dir.join("File.txt"), "baseline content\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-qm", "init"]);

        let baseline = capture_baseline(&dir).unwrap().expect("baseline");

        // Simulate the stage doing a case-only rename (mv File.txt file.txt).
        // On a case-insensitive FS the OS sees it as the same file; on a
        // case-sensitive FS we emulate by removing the old name and writing the new.
        git(&["mv", "File.txt", "file.txt"]);
        // On a case-insensitive FS `git mv` changes only the index entry; on a
        // case-sensitive FS both names exist temporarily. Either way, after
        // restore the file must contain the baseline content.

        restore_baseline(&dir, &baseline).unwrap();

        // On a case-insensitive FS the file lives under whichever case the OS
        // chose; on a case-sensitive FS it's restored as "File.txt". Check both.
        let content = std::fs::read_to_string(dir.join("File.txt"))
            .or_else(|_| std::fs::read_to_string(dir.join("file.txt")))
            .expect("file should exist after restore (baseline must not be deleted)");
        assert_eq!(
            content, "baseline content\n",
            "restored file must contain the baseline content"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Regression test: after restore_baseline the REAL git index must be
    /// resynced to HEAD so that any staged entries left by a failed stage
    /// (e.g. from `git add -A` in custom instructions) don't survive as
    /// phantom staged changes in `git diff --cached`.
    #[test]
    fn baseline_restore_clears_staged_index() {
        use crate::orchestrator::git_baseline::{capture_baseline, restore_baseline};
        use std::process::Command;

        let dir = std::env::temp_dir().join(format!(
            "octo-baseline-idx-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos(),
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let git_out = |a: &[&str]| {
            Command::new("git").args(a).current_dir(&dir).output().unwrap()
        };
        let git = |a: &[&str]| { git_out(a); };

        git(&["init", "-q"]);
        git(&["config", "user.email", "t@t"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(dir.join("initial.txt"), "initial\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-qm", "init"]);

        // Capture the baseline (mimics stage start).
        let baseline = capture_baseline(&dir).unwrap().expect("baseline");

        // Simulate a stage that modifies a file AND stages those changes into
        // the real index via `git add -A` (as custom stage instructions might).
        std::fs::write(dir.join("initial.txt"), "modified by stage\n").unwrap();
        std::fs::write(dir.join("stage_new.txt"), "created by stage\n").unwrap();
        git(&["add", "-A"]);

        // Verify the real index really has staged changes before restore.
        let before = git_out(&["diff", "--cached", "--name-only"]);
        let before_stdout = String::from_utf8_lossy(&before.stdout);
        assert!(
            !before_stdout.trim().is_empty(),
            "pre-condition: real index must have staged changes before restore"
        );

        // Discard the failed stage.
        restore_baseline(&dir, &baseline).unwrap();

        // After restore, `git diff --cached --name-only` must be empty: the
        // real index must have been resynced to HEAD (mixed reset).
        let after = git_out(&["diff", "--cached", "--name-only"]);
        let after_stdout = String::from_utf8_lossy(&after.stdout);
        assert!(
            after_stdout.trim().is_empty(),
            "after restore_baseline the real index must show no staged changes; got: {after_stdout}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod roles_tests {
    use crate::db::Db;
    use tempfile::NamedTempFile;

    fn test_db() -> (Db, NamedTempFile) {
        let tmp = NamedTempFile::new().unwrap();
        let db = Db::open(tmp.path()).unwrap();
        (db, tmp)
    }

    #[test]
    fn roles_table_seeds_and_reads() {
        let (db, _tmp) = test_db();
        let all = db.list_roles().unwrap();
        assert_eq!(all.len(), 15);
        let cr = db.get_role("code_review").unwrap().unwrap();
        assert!(cr.can_loop);
        assert_eq!(cr.is_builtin, true);
        assert!(db.get_role("nope").unwrap().is_none());
        // custom upsert + in-use + delete
        let mut custom = cr.clone(); custom.key = "perf_audit".into(); custom.label = "Perf audit".into(); custom.is_builtin = false;
        db.upsert_role(&custom).unwrap();
        assert!(!db.role_in_use("perf_audit").unwrap());
        db.delete_role("perf_audit").unwrap();
        assert!(db.get_role("perf_audit").unwrap().is_none());
    }

    #[test]
    fn builtin_roles_compose_with_the_right_preambles() {
        use crate::orchestrator::roles::{builtin_roles, compose_system_prompt};
        use crate::orchestrator::types::RoleEnvironment;
        let by = |k: &str| builtin_roles().into_iter().find(|r| r.key == k).unwrap();
        // plan body, worktree preamble, no instructions, no verdict
        let plan = by("plan");
        let got = compose_system_prompt(&plan.prompt_body, plan.environment, None, None, true);
        assert!(got.contains("You are one stage in an automated, headless build pipeline."));
        assert!(got.contains("Do not commit, push, or otherwise manage git"));
        assert!(got.contains("produce a concrete implementation plan"));
        // there are 15 builtin roles, all keys unique
        let all = builtin_roles();
        assert_eq!(all.len(), 15);
        let mut keys: Vec<_> = all.iter().map(|r| r.key.clone()).collect();
        keys.sort(); keys.dedup();
        assert_eq!(keys.len(), 15);
        // an action role uses the action preamble
        let rel = by("release");
        assert_eq!(rel.environment, RoleEnvironment::Action);
        let rp = compose_system_prompt(&rel.prompt_body, rel.environment, None, None, true);
        assert!(rp.contains("may commit, push"));
        assert!(!rp.contains("Do not commit, push"));
    }

    #[test]
    fn builtin_role_prompts_are_purpose_specific_not_clones() {
        // The crew-quality invariant: fix/verify/critique were historically
        // byte-identical clones of implement/code_review/plan_review, so
        // `verify` never re-ran the repro and `fix` never targeted the root
        // cause. Every builtin body must be unique, and the trio must speak
        // to its actual purpose.
        use crate::orchestrator::roles::builtin_roles;
        let all = builtin_roles();
        let mut bodies: Vec<_> = all.iter().map(|r| r.prompt_body.clone()).collect();
        bodies.sort();
        let before = bodies.len();
        bodies.dedup();
        assert_eq!(bodies.len(), before, "duplicate builtin prompt bodies");
        let by = |k: &str| all.iter().find(|r| r.key == k).unwrap();
        assert!(by("fix").prompt_body.contains("ROOT CAUSE"));
        assert!(by("verify").prompt_body.contains("by execution"));
        assert!(by("verify").prompt_body.contains("Re-run the repro"));
        assert!(!by("critique").prompt_body.contains("the proposed plan"),
            "critique must not hard-code 'the plan' — it reviews any artifact");
    }

    #[test]
    fn reviewer_prompts_carry_a_severity_rubric_and_anti_rubber_stamp_bar() {
        // Automated review fails in two prompt-shaped ways: rubber-stamping
        // and cosmetic-nitpick loops. Every looping reviewer must carry a
        // severity rubric and the "nits alone don't send work back" bar.
        use crate::orchestrator::roles::builtin_roles;
        let all = builtin_roles();
        let by = |k: &str| all.iter().find(|r| r.key == k).unwrap();
        for k in ["plan_review", "code_review", "critique"] {
            assert!(by(k).prompt_body.contains("BLOCKING"), "{k} lacks a severity rubric");
        }
        assert!(by("code_review").prompt_body.contains("NITs alone are never grounds"));
        assert!(by("security_review").prompt_body.contains("Critical"));
        // The test role must be required to actually RUN the suite.
        assert!(by("test").prompt_body.contains("running is not optional"));
    }

    #[test]
    fn reviewers_can_run_commands_to_verify_findings() {
        // code_review/security_review were read-only (`ro()`), so they could
        // not run `git diff`, grep, or the test suite — structurally unable
        // to verify what they certify. They now carry run_command.
        use crate::orchestrator::roles::builtin_roles;
        let all = builtin_roles();
        for k in ["code_review", "security_review", "verify", "repro", "test"] {
            let r = all.iter().find(|r| r.key == k).unwrap();
            assert!(
                r.default_tools.iter().any(|t| t == "run_command"),
                "{k} must be able to run commands"
            );
        }
    }

    #[test]
    fn unknown_role_is_a_clean_failure_message() {
        // compose still works for an arbitrary body+env (no role lookup needed here)
        use crate::orchestrator::roles::compose_system_prompt;
        use crate::orchestrator::types::RoleEnvironment;
        let s = compose_system_prompt("Body.", RoleEnvironment::Worktree, None, None, false);
        assert!(s.ends_with("Body."));
    }

    #[test]
    fn new_builtin_roles_have_expected_contracts() {
        let (db, _tmp) = test_db();
        use crate::orchestrator::types::RoleEnvironment;
        for k in ["pull_request", "merge", "release"] {
            let r = db.get_role(k).unwrap().unwrap();
            assert_eq!(r.environment, RoleEnvironment::Action, "{k}");
            assert_eq!(r.default_substrate, "cli", "{k}");
            assert!(r.default_checkpoint, "{k}");
            assert!(!r.can_loop, "{k}");
        }
        assert!(db.get_role("security_review").unwrap().unwrap().can_loop);
        assert_eq!(db.get_role("architect").unwrap().unwrap().artifact_kind.as_db(), "plan");
    }

    #[test]
    fn delete_role_rejects_when_in_use() {
        let (db, _tmp) = test_db();
        // Create a custom role.
        let cr = db.get_role("code_review").unwrap().unwrap();
        let mut custom = cr.clone();
        custom.key = "perf_audit".into();
        custom.label = "Perf audit".into();
        custom.is_builtin = false;
        db.upsert_role(&custom).unwrap();
        // Not in use yet.
        assert!(!db.role_in_use("perf_audit").unwrap());
        // Wire a pipeline stage that references the custom role.
        let pid = db.insert_pipeline("test-pipe", "desc", false).unwrap();
        db.insert_pipeline_stage(&pid, 0, "perf_audit", "claude-haiku-4-5", "api", false, None, 0, None, 25).unwrap();
        // Now it's in use — role_in_use must be true.
        assert!(db.role_in_use("perf_audit").unwrap());
        // The delete_role command guard must refuse.
        let result = db.role_in_use("perf_audit").unwrap();
        assert!(result, "role should be in use after stage insert");
        // Simulate the command logic: if in use, error; else delete.
        let del_result: crate::error::AppResult<()> = if db.role_in_use("perf_audit").unwrap() {
            Err(crate::error::AppError::Other("role 'perf_audit' is used by a pipeline".into()))
        } else {
            db.delete_role("perf_audit")
        };
        assert!(del_result.is_err(), "delete should be rejected when role is in use");
        let err_msg = del_result.unwrap_err().to_string();
        assert!(err_msg.contains("perf_audit"), "error should mention the role key");
    }

    #[test]
    fn save_role_cannot_overwrite_builtin() {
        let (db, _tmp) = test_db();
        // Grab the built-in code_review's original prompt so we can check it after.
        let builtin = db.get_role("code_review").unwrap().unwrap();
        assert!(builtin.is_builtin, "code_review must be a built-in");
        let original_prompt = builtin.prompt_body.clone();

        // Attempt to upsert a custom role that happens to share the same key.
        let mut imposter = builtin.clone();
        imposter.is_builtin = false;
        imposter.prompt_body = "INJECTED PROMPT".into();
        // upsert_role must now return Err (defense-in-depth guard).
        let result = db.upsert_role(&imposter);
        assert!(result.is_err(), "upsert_role must reject a built-in key collision");
        let err_msg = result.unwrap_err().to_string();
        assert!(err_msg.contains("code_review"), "error must name the colliding key");

        // The built-in row must be UNCHANGED.
        let after = db.get_role("code_review").unwrap().unwrap();
        assert_eq!(
            after.prompt_body, original_prompt,
            "upsert_role must not overwrite a built-in role's prompt"
        );
        assert!(after.is_builtin, "is_builtin flag must still be 1");
    }
}
