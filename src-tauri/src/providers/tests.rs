//! Unit tests for provider request builders and response parsers.
//! These are pure functions — no HTTP, no async, fast.

use super::{
    LlmBlock, LlmContent, LlmMessage, LlmRequest, LlmRole, LlmStopReason,
    LlmTool, LlmToolResult, LlmToolUse,
};
use super::{anthropic, openai_compat};
use serde_json::json;

fn sample_request() -> LlmRequest {
    LlmRequest {
        model: "test-model".into(),
        max_tokens: 1024,
        system: "You are helpful.".into(),
        messages: vec![
            LlmMessage {
                role: LlmRole::User,
                content: LlmContent::Text("Hi there.".into()),
            },
        ],
        tools: vec![
            LlmTool {
                name: "read_file".into(),
                description: "Read a file.".into(),
                input_schema: json!({ "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }),
            },
        ],
        tool_choice: None,
    }
}

#[test]
fn anthropic_build_request_shape() {
    let body = anthropic::build_request(&sample_request());
    assert_eq!(body["model"], "test-model");
    assert_eq!(body["system"], "You are helpful.");
    assert!(body["messages"].is_array());
    assert_eq!(body["messages"][0]["role"], "user");
    assert_eq!(body["messages"][0]["content"], "Hi there.");
    assert_eq!(body["tools"][0]["name"], "read_file");
    assert_eq!(body["tools"][0]["description"], "Read a file.");
    assert!(body["tools"][0]["input_schema"].is_object());
}

#[test]
fn anthropic_multimodal_serializes_image_blocks() {
    let mut req = sample_request();
    req.messages = vec![LlmMessage {
        role: LlmRole::User,
        content: LlmContent::Multimodal(vec![
            LlmBlock::Text("what is this?".into()),
            LlmBlock::Image { media_type: "image/png".into(), data: "QUJD".into() },
        ]),
    }];
    let body = anthropic::build_request(&req);
    let content = &body["messages"][0]["content"];
    assert!(content.is_array());
    assert_eq!(content[0]["type"], "text");
    assert_eq!(content[0]["text"], "what is this?");
    assert_eq!(content[1]["type"], "image");
    assert_eq!(content[1]["source"]["type"], "base64");
    assert_eq!(content[1]["source"]["media_type"], "image/png");
    assert_eq!(content[1]["source"]["data"], "QUJD");
}

#[test]
fn openai_multimodal_serializes_image_url() {
    let mut req = sample_request();
    req.messages = vec![LlmMessage {
        role: LlmRole::User,
        content: LlmContent::Multimodal(vec![
            LlmBlock::Text("hi".into()),
            LlmBlock::Image { media_type: "image/jpeg".into(), data: "ZZ".into() },
        ]),
    }];
    let body = openai_compat::build_request(&req);
    let parts = &body["messages"].as_array().unwrap();
    // First user message (after the system message) carries the content parts.
    let user = parts.iter().find(|m| m["role"] == "user").unwrap();
    assert_eq!(user["content"][0]["type"], "text");
    assert_eq!(user["content"][1]["type"], "image_url");
    assert_eq!(user["content"][1]["image_url"]["url"], "data:image/jpeg;base64,ZZ");
}

#[test]
fn anthropic_parse_response_text_only() {
    let resp = anthropic::parse_response(json!({
        "content": [{ "type": "text", "text": "Hello back." }],
        "stop_reason": "end_turn",
        "usage": { "input_tokens": 10, "output_tokens": 5 }
    }));
    assert_eq!(resp.text, "Hello back.");
    assert!(resp.tool_uses.is_empty());
    assert_eq!(resp.stop_reason, LlmStopReason::EndTurn);
    assert_eq!(resp.input_tokens, 10);
    assert_eq!(resp.output_tokens, 5);
}

#[test]
fn anthropic_parse_response_tool_use() {
    let resp = anthropic::parse_response(json!({
        "content": [
            { "type": "text", "text": "Reading file." },
            { "type": "tool_use", "id": "tu_1", "name": "read_file", "input": { "path": "a.ts" } }
        ],
        "stop_reason": "tool_use",
        "usage": { "input_tokens": 20, "output_tokens": 10 }
    }));
    assert_eq!(resp.text, "Reading file.");
    assert_eq!(resp.tool_uses.len(), 1);
    assert_eq!(resp.tool_uses[0].id, "tu_1");
    assert_eq!(resp.tool_uses[0].name, "read_file");
    assert_eq!(resp.tool_uses[0].input, json!({ "path": "a.ts" }));
    assert_eq!(resp.stop_reason, LlmStopReason::ToolUse);
}

#[test]
fn openai_parse_response_splits_cached_input() {
    // Regression (F11): OpenAI-style `prompt_tokens` INCLUDES cached tokens.
    // We must surface the cached slice as cache_read and bill only the fresh
    // remainder as input, or cached input is charged at the full input rate.
    let resp = openai_compat::parse_response(json!({
        "choices": [{ "message": { "content": "hi" }, "finish_reason": "stop" }],
        "usage": {
            "prompt_tokens": 1000,
            "completion_tokens": 200,
            "prompt_tokens_details": { "cached_tokens": 400 }
        }
    }));
    assert_eq!(resp.input_tokens, 600, "billable input = prompt - cached");
    assert_eq!(resp.cache_read_tokens, 400);
    assert_eq!(resp.cache_creation_tokens, 0);
    assert_eq!(resp.output_tokens, 200);
}

#[test]
fn openai_parse_response_no_cache_field() {
    // Providers that omit the details block report 0 cached (no change).
    let resp = openai_compat::parse_response(json!({
        "choices": [{ "message": { "content": "hi" }, "finish_reason": "stop" }],
        "usage": { "prompt_tokens": 1000, "completion_tokens": 200 }
    }));
    assert_eq!(resp.input_tokens, 1000);
    assert_eq!(resp.cache_read_tokens, 0);
}

#[test]
fn openai_build_request_puts_system_in_messages() {
    let body = openai_compat::build_request(&sample_request());
    assert_eq!(body["model"], "test-model");
    let msgs = body["messages"].as_array().unwrap();
    assert_eq!(msgs[0]["role"], "system");
    assert_eq!(msgs[0]["content"], "You are helpful.");
    assert_eq!(msgs[1]["role"], "user");
    assert_eq!(msgs[1]["content"], "Hi there.");
}

#[test]
fn openai_build_request_tools_use_function_wrapper() {
    let body = openai_compat::build_request(&sample_request());
    let tool = &body["tools"][0];
    assert_eq!(tool["type"], "function");
    assert_eq!(tool["function"]["name"], "read_file");
    assert_eq!(tool["function"]["description"], "Read a file.");
    assert!(tool["function"]["parameters"].is_object());
}

#[test]
fn openai_assistant_with_tools_emits_tool_calls() {
    let req = LlmRequest {
        model: "m".into(),
        max_tokens: 1,
        system: "".into(),
        messages: vec![LlmMessage {
            role: LlmRole::Assistant,
            content: LlmContent::AssistantWithTools {
                text: "let me read it".into(),
                tool_uses: vec![LlmToolUse {
                    id: "call_1".into(),
                    name: "read_file".into(),
                    input: json!({ "path": "x" }),
                }],
            },
        }],
        tools: vec![],
        tool_choice: None,
    };
    let body = openai_compat::build_request(&req);
    let m = &body["messages"][0];
    assert_eq!(m["role"], "assistant");
    assert_eq!(m["content"], "let me read it");
    assert_eq!(m["tool_calls"][0]["id"], "call_1");
    assert_eq!(m["tool_calls"][0]["function"]["name"], "read_file");
    // arguments are a JSON-string per OpenAI spec
    let args: serde_json::Value = serde_json::from_str(
        m["tool_calls"][0]["function"]["arguments"].as_str().unwrap(),
    ).unwrap();
    assert_eq!(args, json!({ "path": "x" }));
}

#[test]
fn openai_tool_results_become_role_tool_messages() {
    let req = LlmRequest {
        model: "m".into(),
        max_tokens: 1,
        system: "".into(),
        messages: vec![LlmMessage {
            role: LlmRole::User,
            content: LlmContent::ToolResults(vec![
                LlmToolResult { tool_use_id: "call_1".into(), content: "ok".into(), is_error: false },
                LlmToolResult { tool_use_id: "call_2".into(), content: "ok2".into(), is_error: false },
            ]),
        }],
        tools: vec![],
        tool_choice: None,
    };
    let body = openai_compat::build_request(&req);
    let msgs = body["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0]["role"], "tool");
    assert_eq!(msgs[0]["tool_call_id"], "call_1");
    assert_eq!(msgs[0]["content"], "ok");
    assert_eq!(msgs[1]["tool_call_id"], "call_2");
}

#[test]
fn openai_parse_response_text() {
    let resp = openai_compat::parse_response(json!({
        "choices": [{
            "message": { "content": "Hello." },
            "finish_reason": "stop"
        }],
        "usage": { "prompt_tokens": 12, "completion_tokens": 4 }
    }));
    assert_eq!(resp.text, "Hello.");
    assert!(resp.tool_uses.is_empty());
    assert_eq!(resp.stop_reason, LlmStopReason::EndTurn);
    assert_eq!(resp.input_tokens, 12);
    assert_eq!(resp.output_tokens, 4);
}

#[test]
fn openai_parse_response_tool_calls() {
    let resp = openai_compat::parse_response(json!({
        "choices": [{
            "message": {
                "content": null,
                "tool_calls": [{
                    "id": "call_99",
                    "type": "function",
                    "function": {
                        "name": "write_file",
                        "arguments": "{\"path\":\"a.ts\",\"content\":\"hello\"}"
                    }
                }]
            },
            "finish_reason": "tool_calls"
        }],
        "usage": { "prompt_tokens": 30, "completion_tokens": 5 }
    }));
    assert_eq!(resp.text, "");
    assert_eq!(resp.tool_uses.len(), 1);
    assert_eq!(resp.tool_uses[0].id, "call_99");
    assert_eq!(resp.tool_uses[0].name, "write_file");
    assert_eq!(resp.tool_uses[0].input, json!({ "path": "a.ts", "content": "hello" }));
    assert_eq!(resp.stop_reason, LlmStopReason::ToolUse);
}

#[test]
fn openai_parse_response_ollama_no_finish_reason() {
    // Ollama returns finish_reason: null in some cases.
    let resp = openai_compat::parse_response(json!({
        "choices": [{
            "message": { "content": "ok" },
        }]
    }));
    assert_eq!(resp.text, "ok");
    assert_eq!(resp.stop_reason, LlmStopReason::EndTurn);
}

// ─── tool_choice (forced structured output, G5 follow-up) ───────────────

#[test]
fn anthropic_build_request_omits_tool_choice_by_default() {
    let body = anthropic::build_request(&sample_request());
    assert!(body.get("tool_choice").is_none());
}

#[test]
fn anthropic_build_request_forces_named_tool() {
    let mut req = sample_request();
    req.tool_choice = Some("emit_result".into());
    let body = anthropic::build_request(&req);
    assert_eq!(body["tool_choice"]["type"], "tool");
    assert_eq!(body["tool_choice"]["name"], "emit_result");
}

#[test]
fn openai_build_request_omits_tool_choice_by_default() {
    let body = openai_compat::build_request(&sample_request());
    assert!(body.get("tool_choice").is_none());
}

#[test]
fn openai_build_request_forces_named_function() {
    let mut req = sample_request();
    req.tool_choice = Some("emit_result".into());
    let body = openai_compat::build_request(&req);
    assert_eq!(body["tool_choice"]["type"], "function");
    assert_eq!(body["tool_choice"]["function"]["name"], "emit_result");
}

// ─── complete_with_retry: transient-failure resilience ──────────────────────────

mod retry {
    use super::super::{complete_with_retry, LlmProvider, LlmResponse, LlmStopReason};
    use crate::error::{AppError, AppResult, ProviderErrorKind};
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Mutex;

    /// One scripted outcome per call: `Ok` succeeds, `Err(kind, retry_after)`
    /// fails as a classified provider error.
    type Turn = Result<(), (ProviderErrorKind, Option<u64>)>;

    struct ScriptedProvider {
        turns: Mutex<VecDeque<Turn>>,
        calls: AtomicU32,
    }

    impl ScriptedProvider {
        fn new(turns: Vec<Turn>) -> Self {
            Self {
                turns: Mutex::new(turns.into()),
                calls: AtomicU32::new(0),
            }
        }
    }

    fn ok_response() -> LlmResponse {
        LlmResponse {
            text: "done".into(),
            tool_uses: vec![],
            stop_reason: LlmStopReason::EndTurn,
            input_tokens: 1,
            output_tokens: 1,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            rate_limit: None,
        }
    }

    #[async_trait::async_trait]
    impl LlmProvider for ScriptedProvider {
        async fn complete(
            &self,
            _api_base: &str,
            _api_key: Option<&str>,
            _req: &super::super::LlmRequest,
            _client: &reqwest::Client,
        ) -> AppResult<LlmResponse> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            match self.turns.lock().unwrap().pop_front().expect("scripted provider ran out of turns") {
                Ok(()) => Ok(ok_response()),
                Err((kind, retry_after)) => Err(AppError::Provider {
                    kind,
                    retry_after,
                    message: format!("{kind:?}"),
                }),
            }
        }
    }

    async fn drive(provider: &ScriptedProvider, cancel: &AtomicBool, max_retries: u32) -> (AppResult<LlmResponse>, u32) {
        let client = reqwest::Client::new();
        let retries = AtomicU32::new(0);
        let mut on_retry = |_a: u32, _d: u64, _k: ProviderErrorKind| {
            retries.fetch_add(1, Ordering::Relaxed);
        };
        let req = super::sample_request();
        let res = complete_with_retry(
            provider, "http://x", None, &req, &client, cancel, max_retries, &mut on_retry,
        )
        .await;
        (res, retries.load(Ordering::Relaxed))
    }

    // retry_after: Some(0) keeps the backoff wait at zero so these stay fast.
    #[tokio::test]
    async fn retries_transient_then_succeeds() {
        let p = ScriptedProvider::new(vec![
            Err((ProviderErrorKind::RateLimit, Some(0))),
            Err((ProviderErrorKind::Overloaded, Some(0))),
            Ok(()),
        ]);
        let cancel = AtomicBool::new(false);
        let (res, retries) = drive(&p, &cancel, 5).await;
        assert!(res.is_ok());
        assert_eq!(p.calls.load(Ordering::Relaxed), 3);
        assert_eq!(retries, 2, "two waits narrated before the success");
    }

    #[tokio::test]
    async fn gives_up_after_max_retries() {
        let p = ScriptedProvider::new(vec![
            Err((ProviderErrorKind::RateLimit, Some(0))),
            Err((ProviderErrorKind::RateLimit, Some(0))),
            Err((ProviderErrorKind::RateLimit, Some(0))),
        ]);
        let cancel = AtomicBool::new(false);
        let (res, _retries) = drive(&p, &cancel, 2).await;
        assert!(matches!(res, Err(AppError::Provider { .. })));
        // initial attempt + 2 retries = 3 calls
        assert_eq!(p.calls.load(Ordering::Relaxed), 3);
    }

    #[tokio::test]
    async fn non_transient_returns_immediately() {
        let p = ScriptedProvider::new(vec![Err((ProviderErrorKind::Auth, None))]);
        let cancel = AtomicBool::new(false);
        let (res, retries) = drive(&p, &cancel, 5).await;
        assert!(res.is_err());
        assert_eq!(p.calls.load(Ordering::Relaxed), 1, "auth failures are not retried");
        assert_eq!(retries, 0);
    }

    #[tokio::test]
    async fn cancel_aborts_the_backoff() {
        // A long retry_after would normally park the call; a raised cancel must
        // break out of the wait without further attempts.
        let p = ScriptedProvider::new(vec![Err((ProviderErrorKind::RateLimit, Some(300)))]);
        let cancel = AtomicBool::new(true);
        let (res, _retries) = drive(&p, &cancel, 5).await;
        assert!(res.is_err());
        assert_eq!(p.calls.load(Ordering::Relaxed), 1, "no retry after a cancel");
    }
}
