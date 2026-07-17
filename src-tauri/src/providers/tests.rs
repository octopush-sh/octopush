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
        effort: None,
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
                raw: vec![],
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
        effort: None,
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
        effort: None,
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

// ─── reasoning effort (per-stage thinking) ──────────────────────────────

mod effort {
    use super::super::anthropic::{
        build_request, effective_effort_level, parse_response, thinking_json,
    };
    use super::super::openai_compat;
    use super::super::{Effort, LlmContent, LlmMessage, LlmRole, LlmToolUse};
    use super::sample_request;
    use crate::orchestrator::agentic::max_tokens_for;
    use serde_json::json;

    /// Convenience: which branch of `thinking_json` a model+effort lands in.
    fn plan(model: &str) -> (Option<serde_json::Value>, Option<serde_json::Value>) {
        thinking_json(model, Some(Effort::High), 32768)
    }

    #[test]
    fn thinking_json_classifies_three_ways() {
        // Effort models → adaptive + output_config.
        for m in [
            "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5",
            "claude-sonnet-5", "claude-sonnet-4-6", "claude-fable-5", "claude-mythos-5",
        ] {
            let (thinking, oc) = plan(m);
            assert_eq!(thinking.unwrap(), json!({ "type": "adaptive" }), "{m} = effort model");
            assert!(oc.is_some(), "{m} must carry output_config");
        }
        // Budget models → budget_tokens, no output_config.
        for m in ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-sonnet-4-0"] {
            let (thinking, oc) = plan(m);
            assert_eq!(thinking.unwrap()["type"], "enabled", "{m} = budget model");
            assert!(oc.is_none(), "{m} must NOT carry output_config");
        }
        // Legacy / unknown → NO thinking params at all (never 400 a non-thinker).
        for m in ["claude-3-5-sonnet", "claude-3-opus", "foo-model"] {
            assert_eq!(plan(m), (None, None), "{m} = legacy/unknown → no thinking");
        }
    }

    #[test]
    fn thinking_json_opus_uses_adaptive_and_effort() {
        let (thinking, output_config) = thinking_json("claude-opus-4-8", Some(Effort::High), 32768);
        assert_eq!(thinking.unwrap(), json!({ "type": "adaptive" }));
        assert_eq!(output_config.unwrap(), json!({ "effort": "high" }));
    }

    #[test]
    fn thinking_json_xhigh_level_passes_through_on_capable_model() {
        let (_t, output_config) = thinking_json("claude-opus-4-8", Some(Effort::Xhigh), 64000);
        assert_eq!(output_config.unwrap(), json!({ "effort": "xhigh" }));
    }

    #[test]
    fn effective_effort_level_clamps_per_model() {
        // xhigh-capable: as-is.
        assert_eq!(effective_effort_level("claude-opus-4-8", Effort::Xhigh), "xhigh");
        assert_eq!(effective_effort_level("claude-opus-4-8", Effort::Max), "max");
        // Sonnet 4.6 / Opus 4.6: no xhigh (folds to high), but max is kept.
        assert_eq!(effective_effort_level("claude-sonnet-4-6", Effort::Xhigh), "high");
        assert_eq!(effective_effort_level("claude-sonnet-4-6", Effort::Max), "max");
        assert_eq!(effective_effort_level("claude-opus-4-6", Effort::Xhigh), "high");
        // Opus 4.5 / unknown effort-path: cap at high (xhigh AND max fold down).
        assert_eq!(effective_effort_level("claude-opus-4-5", Effort::Max), "high");
        assert_eq!(effective_effort_level("claude-opus-4-5", Effort::Xhigh), "high");
        assert_eq!(effective_effort_level("some-unknown-model", Effort::Max), "high");
        // Lower levels are never touched, on any model.
        assert_eq!(effective_effort_level("claude-sonnet-4-6", Effort::High), "high");
        assert_eq!(effective_effort_level("claude-opus-4-5", Effort::Low), "low");
    }

    #[test]
    fn build_request_clamps_effort_level_for_the_default_model() {
        // Sonnet 4.6 is the DEFAULT model and rejects xhigh — it must fold to high.
        let mut req = sample_request();
        req.model = "claude-sonnet-4-6".into();
        req.effort = Some(Effort::Xhigh);
        let body = build_request(&req);
        assert_eq!(body["output_config"]["effort"], "high");
    }

    #[test]
    fn thinking_json_haiku_uses_budget_under_max_and_no_output_config() {
        let (thinking, output_config) = thinking_json("claude-haiku-4-5", Some(Effort::High), 32768);
        let thinking = thinking.unwrap();
        assert_eq!(thinking["type"], "enabled");
        let budget = thinking["budget_tokens"].as_u64().unwrap();
        assert_eq!(budget, 16384, "high → 16384 on the budget path");
        assert!(budget < 32768, "budget must clear max_tokens");
        assert!(output_config.is_none(), "budget path must NOT send output_config");
    }

    #[test]
    fn thinking_json_haiku_clamps_budget_below_small_max_tokens() {
        // A tiny max_tokens forces the budget below it (and never under 1024).
        let (thinking, _) = thinking_json("claude-haiku-4-5", Some(Effort::Max), 2000);
        let budget = thinking.unwrap()["budget_tokens"].as_u64().unwrap();
        assert!(budget < 2000 && budget >= 1024, "clamped budget = {budget}");
    }

    #[test]
    fn thinking_json_none_effort_is_empty() {
        let (thinking, output_config) = thinking_json("claude-opus-4-8", None, 32768);
        assert!(thinking.is_none() && output_config.is_none());
    }

    #[test]
    fn build_request_effort_high_on_opus_emits_config_and_never_temperature() {
        let mut req = sample_request();
        req.model = "claude-opus-4-8".into();
        req.effort = Some(Effort::High);
        let body = build_request(&req);
        assert_eq!(body["thinking"], json!({ "type": "adaptive" }));
        assert_eq!(body["output_config"]["effort"], "high");
        // temperature must stay ABSENT — current models 400 on it with thinking.
        assert!(body.get("temperature").is_none(), "temperature must never be sent");
    }

    #[test]
    fn build_request_effort_on_haiku_emits_budget_tokens() {
        let mut req = sample_request();
        req.model = "claude-haiku-4-5".into();
        req.max_tokens = 32768;
        req.effort = Some(Effort::Medium);
        let body = build_request(&req);
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["thinking"]["budget_tokens"], 8192);
        assert!(body.get("output_config").is_none());
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn build_request_effort_none_emits_neither() {
        let body = build_request(&sample_request());
        assert!(body.get("thinking").is_none());
        assert!(body.get("output_config").is_none());
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn parse_response_keeps_raw_content_verbatim_and_in_order() {
        let resp = parse_response(json!({
            "content": [
                { "type": "thinking", "thinking": "let me reason", "signature": "sig-abc" },
                { "type": "redacted_thinking", "data": "enc-xyz" },
                { "type": "text", "text": "the answer" },
                { "type": "tool_use", "id": "tu_1", "name": "read_file", "input": { "path": "a.ts" } }
            ],
            "stop_reason": "tool_use",
            "usage": { "input_tokens": 5, "output_tokens": 3 }
        }));
        assert_eq!(resp.text, "the answer");
        assert_eq!(resp.tool_uses.len(), 1);
        // The FULL content array is kept verbatim, in original order.
        assert_eq!(resp.raw_content.len(), 4);
        assert_eq!(resp.raw_content[0]["type"], "thinking");
        assert_eq!(resp.raw_content[0]["signature"], "sig-abc");
        assert_eq!(resp.raw_content[1]["type"], "redacted_thinking");
        assert_eq!(resp.raw_content[1]["data"], "enc-xyz");
        assert_eq!(resp.raw_content[2]["type"], "text");
        assert_eq!(resp.raw_content[3]["type"], "tool_use");
    }

    #[test]
    fn message_to_anthropic_replays_raw_content_verbatim_in_order() {
        // Interleaved thinking/tool_use MUST replay in the SAME order — grouping
        // thinking-then-tool_use would reorder [think,tool,think,tool] and 400.
        let raw = vec![
            json!({ "type": "thinking", "thinking": "step 1", "signature": "s1" }),
            json!({ "type": "tool_use", "id": "tu_1", "name": "read_file", "input": { "path": "a" } }),
            json!({ "type": "thinking", "thinking": "step 2", "signature": "s2" }),
            json!({ "type": "tool_use", "id": "tu_2", "name": "read_file", "input": { "path": "b" } }),
        ];
        let mut req = sample_request();
        req.messages = vec![LlmMessage {
            role: LlmRole::Assistant,
            content: LlmContent::AssistantWithTools {
                raw: raw.clone(),
                text: "ignored when raw is present".into(),
                tool_uses: vec![LlmToolUse { id: "tu_1".into(), name: "read_file".into(), input: json!({}) }],
            },
        }];
        let body = build_request(&req);
        let content = body["messages"][0]["content"].as_array().unwrap();
        // Byte-for-byte the same array, same order.
        assert_eq!(content, &raw);
    }

    #[test]
    fn message_to_anthropic_rebuilds_from_text_and_tools_when_raw_empty() {
        // No captured raw (TALK / truncation / OpenAI-origin) → build from parts.
        let mut req = sample_request();
        req.messages = vec![LlmMessage {
            role: LlmRole::Assistant,
            content: LlmContent::AssistantWithTools {
                raw: vec![],
                text: "reading".into(),
                tool_uses: vec![LlmToolUse { id: "tu_1".into(), name: "read_file".into(), input: json!({ "path": "a" }) }],
            },
        }];
        let body = build_request(&req);
        let content = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "tool_use");
    }

    // ─── OpenAI-compat effort gating + token-cap key ────────────────────

    #[test]
    fn openai_reasoning_effort_only_on_reasoning_models() {
        // Reasoning models get reasoning_effort…
        for m in ["o1", "o3-mini", "o4-mini", "gpt-5", "gpt-5-mini"] {
            let mut req = sample_request();
            req.model = m.into();
            req.effort = Some(Effort::High);
            let body = openai_compat::build_request(&req);
            assert_eq!(body["reasoning_effort"], "high", "{m} should carry reasoning_effort");
        }
        // …a chat model like gpt-4o does NOT (it would no-op / 400).
        let mut req = sample_request();
        req.model = "gpt-4o".into();
        req.effort = Some(Effort::High);
        let body = openai_compat::build_request(&req);
        assert!(body.get("reasoning_effort").is_none(), "gpt-4o must omit reasoning_effort");
    }

    #[test]
    fn openai_passes_max_tokens_through_unclamped_on_chat_models() {
        // A chat model uses `max_tokens`, UNCLAMPED (TALK "deep" sends 64000).
        let mut req = sample_request();
        req.model = "gpt-4o".into();
        req.max_tokens = 64000;
        let body = openai_compat::build_request(&req);
        assert_eq!(body["max_tokens"], 64000, "no clamp on chat models");
        assert!(body.get("max_completion_tokens").is_none());
    }

    #[test]
    fn openai_reasoning_models_use_max_completion_tokens() {
        // Reasoning models reject `max_tokens` (400) — they want
        // `max_completion_tokens`, also unclamped.
        for m in ["o1", "o3-mini", "o4-mini", "gpt-5"] {
            let mut req = sample_request();
            req.model = m.into();
            req.max_tokens = 48000;
            let body = openai_compat::build_request(&req);
            assert_eq!(body["max_completion_tokens"], 48000, "{m} uses max_completion_tokens");
            assert!(body.get("max_tokens").is_none(), "{m} must NOT send max_tokens");
        }
    }

    #[test]
    fn max_tokens_for_floors_by_effort() {
        assert_eq!(max_tokens_for(None), 32768);
        assert_eq!(max_tokens_for(Some(Effort::Low)), 32768);
        assert_eq!(max_tokens_for(Some(Effort::Medium)), 32768);
        assert_eq!(max_tokens_for(Some(Effort::High)), 48000);
        assert_eq!(max_tokens_for(Some(Effort::Xhigh)), 64000);
        assert_eq!(max_tokens_for(Some(Effort::Max)), 64000);
    }
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
            raw_content: vec![],
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
