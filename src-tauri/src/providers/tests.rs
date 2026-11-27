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
        cache: false,
        cache_key: None,
    }
}

#[test]
fn anthropic_messages_url_plain_base() {
    assert_eq!(
        anthropic::messages_url("https://api.anthropic.com"),
        "https://api.anthropic.com/v1/messages"
    );
}

#[test]
fn anthropic_messages_url_trailing_slash() {
    assert_eq!(
        anthropic::messages_url("https://api.anthropic.com/"),
        "https://api.anthropic.com/v1/messages"
    );
}

#[test]
fn anthropic_messages_url_base_already_has_v1() {
    // Moonshot-style paste: the user copies the OpenAI-flavored base ending in
    // /v1. Appending another /v1 produced /v1/v1/messages → provider 404.
    assert_eq!(
        anthropic::messages_url("https://api.moonshot.ai/v1"),
        "https://api.moonshot.ai/v1/messages"
    );
    assert_eq!(
        anthropic::messages_url("https://api.moonshot.ai/v1/"),
        "https://api.moonshot.ai/v1/messages"
    );
}

#[test]
fn anthropic_messages_url_base_is_full_endpoint() {
    // Pasting the complete endpoint URL must also work.
    assert_eq!(
        anthropic::messages_url("https://api.anthropic.com/v1/messages"),
        "https://api.anthropic.com/v1/messages"
    );
}

#[test]
fn anthropic_messages_url_gateway_subpath_preserved() {
    // Gateways mount the Anthropic surface under a subpath (e.g. Moonshot's
    // /anthropic) — that path segment must survive.
    assert_eq!(
        anthropic::messages_url("https://api.moonshot.ai/anthropic"),
        "https://api.moonshot.ai/anthropic/v1/messages"
    );
}

#[test]
fn openai_chat_completions_url_conventional_base() {
    assert_eq!(
        openai_compat::chat_completions_url("https://api.openai.com/v1"),
        "https://api.openai.com/v1/chat/completions"
    );
    assert_eq!(
        openai_compat::chat_completions_url("http://localhost:11434/v1/"),
        "http://localhost:11434/v1/chat/completions"
    );
}

#[test]
fn openai_chat_completions_url_base_is_full_endpoint() {
    assert_eq!(
        openai_compat::chat_completions_url("https://api.openai.com/v1/chat/completions"),
        "https://api.openai.com/v1/chat/completions"
    );
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

// ── F7: Anthropic prompt-cache breakpoints ────────────────────────────────

#[test]
fn anthropic_cache_enabled_marks_tools_system_and_last_message() {
    // A repeated-prefix context (cache=true) drops one ephemeral breakpoint at
    // the tail of each cache region: last tool, system, last message. That's the
    // whole F7 win — re-sent context bills at ~0.1× on a hit.
    let mut req = sample_request();
    req.cache = true;
    let body = anthropic::build_request(&req);

    // System is promoted to a text-block array so it can carry a breakpoint.
    assert!(body["system"].is_array(), "cached system must be a block array");
    assert_eq!(body["system"][0]["type"], "text");
    assert_eq!(body["system"][0]["text"], "You are helpful.");
    assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");

    // Last tool carries a breakpoint.
    let tools = body["tools"].as_array().unwrap();
    assert_eq!(tools.last().unwrap()["cache_control"]["type"], "ephemeral");

    // The plain-string message body is wrapped into a text block that carries one.
    let content = body["messages"][0]["content"].as_array().unwrap();
    assert_eq!(content.last().unwrap()["type"], "text");
    assert_eq!(content.last().unwrap()["text"], "Hi there.");
    assert_eq!(content.last().unwrap()["cache_control"]["type"], "ephemeral");

    // Exactly 3 breakpoints — Anthropic allows at most 4.
    let count = serde_json::to_string(&body).unwrap().matches("cache_control").count();
    assert_eq!(count, 3, "tools + system + message = 3 breakpoints (≤4)");
}

#[test]
fn anthropic_cache_disabled_emits_no_breakpoints() {
    // One-shot (cache=false): system stays a plain string and nothing is marked,
    // so we never pay a 1.25× cache write we won't read back.
    let body = anthropic::build_request(&sample_request());
    assert!(body["system"].is_string());
    assert_eq!(body["messages"][0]["content"], "Hi there.");
    let json = serde_json::to_string(&body).unwrap();
    assert!(!json.contains("cache_control"), "no breakpoints when cache is off");
}

#[test]
fn anthropic_cache_empty_system_still_marks_tools_and_message() {
    // With no system text there's no block to cache, but the two prefixes that
    // actually recur — tools and the conversation head — are still marked.
    let mut req = sample_request();
    req.cache = true;
    req.system = "".into();
    let body = anthropic::build_request(&req);
    assert_eq!(body["system"], "", "empty system stays a plain string");
    let tools = body["tools"].as_array().unwrap();
    assert_eq!(tools.last().unwrap()["cache_control"]["type"], "ephemeral");
    let content = body["messages"][0]["content"].as_array().unwrap();
    assert_eq!(content.last().unwrap()["cache_control"]["type"], "ephemeral");
    let count = serde_json::to_string(&body).unwrap().matches("cache_control").count();
    assert_eq!(count, 2, "tools + message only");
}

#[test]
fn anthropic_cache_marks_only_last_block_of_an_array_message() {
    // When the last message is already block-form (tool results), the breakpoint
    // attaches to the LAST block, not every block — the prefix is what's cached.
    let mut req = sample_request();
    req.cache = true;
    req.messages = vec![LlmMessage {
        role: LlmRole::User,
        content: LlmContent::ToolResults(vec![
            LlmToolResult { tool_use_id: "a".into(), content: "r1".into(), is_error: false },
            LlmToolResult { tool_use_id: "b".into(), content: "r2".into(), is_error: false },
        ]),
    }];
    let body = anthropic::build_request(&req);
    let content = body["messages"][0]["content"].as_array().unwrap();
    assert!(content[0].get("cache_control").is_none(), "not the first block");
    assert_eq!(content.last().unwrap()["cache_control"]["type"], "ephemeral");
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
fn openai_parse_response_splits_cache_writes() {
    // GPT-5.6+ bills cache writes and reports them, inside `prompt_tokens`, as
    // `prompt_tokens_details.cache_write_tokens` (Chat Completions reference).
    let resp = openai_compat::parse_response(json!({
        "choices": [{ "message": { "content": "hi" }, "finish_reason": "stop" }],
        "usage": {
            "prompt_tokens": 15000,
            "completion_tokens": 200,
            "prompt_tokens_details": { "cached_tokens": 12000, "cache_write_tokens": 2500 }
        }
    }));
    assert_eq!(resp.input_tokens, 500, "billable input = prompt - cached - written");
    assert_eq!(resp.cache_read_tokens, 12000);
    assert_eq!(resp.cache_creation_tokens, 2500);
    // Never more writes than the uncached remainder.
    let resp = openai_compat::parse_response(json!({
        "choices": [{ "message": { "content": "hi" }, "finish_reason": "stop" }],
        "usage": {
            "prompt_tokens": 1000,
            "completion_tokens": 0,
            "prompt_tokens_details": { "cached_tokens": 800, "cache_write_tokens": 500 }
        }
    }));
    assert_eq!((resp.input_tokens, resp.cache_read_tokens, resp.cache_creation_tokens), (0, 800, 200));
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
        cache: false,
        cache_key: None,
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
        cache: false,
        cache_key: None,
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

#[test]
fn openai_parse_response_refusal_is_visible() {
    let resp = openai_compat::parse_response(json!({
        "choices": [{
            "message": { "content": null, "refusal": "I can't help with that." },
            "finish_reason": "stop"
        }]
    }));
    assert_eq!(resp.text, "I can't help with that.");
    assert_eq!(resp.stop_reason, LlmStopReason::Other("refusal".into()), "never an empty EndTurn");
    let mixed = openai_compat::parse_response(json!({
        "choices": [{ "message": { "content": "Partly.", "refusal": "Not the rest." } }]
    }));
    assert_eq!(mixed.text, "Partly.\n\nNot the rest.");
    assert_eq!(mixed.stop_reason, LlmStopReason::Other("refusal".into()));
    // A cut turn keeps its reason; a null refusal changes nothing.
    let cut = openai_compat::parse_response(json!({
        "choices": [{ "message": { "content": "", "refusal": "No." }, "finish_reason": "length" }]
    }));
    assert_eq!(cut.stop_reason, LlmStopReason::MaxTokens);
    let plain = openai_compat::parse_response(json!({
        "choices": [{ "message": { "content": "Hello.", "refusal": null }, "finish_reason": "stop" }]
    }));
    assert_eq!((plain.text.as_str(), plain.stop_reason), ("Hello.", LlmStopReason::EndTurn));
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
            "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
            "claude-sonnet-5", "claude-sonnet-4-6", "claude-fable-5", "claude-mythos-5",
        ] {
            let (thinking, oc) = plan(m);
            assert_eq!(thinking.unwrap(), json!({ "type": "adaptive" }), "{m} = effort model");
            assert!(oc.is_some(), "{m} must carry output_config");
        }
        // Budget models → budget_tokens, no output_config. Opus 4.5 is one:
        // it rejects `adaptive` with a 400.
        for m in ["claude-opus-4-5", "claude-opus-4-5-20251101", "claude-haiku-4-5", "claude-sonnet-4-5", "claude-sonnet-4-0"] {
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
    fn fable_5_2_and_mythos_5_2_take_the_effort_path_with_xhigh() {
        for m in ["claude-fable-5-2", "claude-mythos-5-2"] {
            let (thinking, oc) = plan(m);
            assert_eq!(thinking.unwrap(), json!({ "type": "adaptive" }), "{m} = effort model");
            assert!(oc.is_some(), "{m} must carry output_config");
            assert_eq!(effective_effort_level(m, Effort::Xhigh), "xhigh", "{m}");
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
        // An unknown effort-path id: cap at high (xhigh AND max fold down).
        assert_eq!(effective_effort_level("some-unknown-model", Effort::Max), "high");
        assert_eq!(effective_effort_level("some-unknown-model", Effort::Xhigh), "high");
        // Lower levels are never touched, on any model.
        assert_eq!(effective_effort_level("claude-sonnet-4-6", Effort::High), "high");
        assert_eq!(effective_effort_level("some-unknown-model", Effort::Low), "low");
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
    fn opus_5_takes_the_effort_path_up_to_xhigh() {
        let (thinking, output_config) = thinking_json("claude-opus-5", Some(Effort::Low), 32768);
        assert_eq!(thinking, Some(json!({ "type": "adaptive" })));
        assert_eq!(output_config, Some(json!({ "effort": "low" })));
        let (_t, oc) = thinking_json("claude-opus-5", Some(Effort::Xhigh), 64000);
        assert_eq!(oc, Some(json!({ "effort": "xhigh" })));
        // Without an effort the request carries no thinking params at all —
        // on Opus 5 that means the API's own default (adaptive, high).
        assert_eq!(thinking_json("claude-opus-5", None, 32768), (None, None));
    }

    #[test]
    fn haiku_5_5_takes_the_effort_path_up_to_max() {
        // platform.claude.com/docs/en/build-with-claude/effort (2026-11-04):
        // "Claude Haiku 5.5 supports all five effort levels".
        let (thinking, output_config) = thinking_json("claude-haiku-5-5", Some(Effort::Low), 32768);
        assert_eq!(thinking, Some(json!({ "type": "adaptive" })));
        assert_eq!(output_config, Some(json!({ "effort": "low" })));
        let (_t, oc) = thinking_json("claude-haiku-5-5", Some(Effort::Xhigh), 64000);
        assert_eq!(oc, Some(json!({ "effort": "xhigh" })));
        // Haiku 4.5 keeps the budget path.
        let (t45, oc45) = thinking_json("claude-haiku-4-5", Some(Effort::Medium), 32768);
        assert_eq!(t45, Some(json!({ "type": "enabled", "budget_tokens": 8192 })));
        assert_eq!(oc45, None);
    }

    #[test]
    fn low_effort_on_a_budget_model_means_no_thinking() {
        // The fast tier's sub-agents run `low` on Haiku: that must not turn
        // on a thinking budget the model never had.
        assert_eq!(thinking_json("claude-haiku-4-5", Some(Effort::Low), 32768), (None, None));
        let (thinking, _) = thinking_json("claude-haiku-4-5", Some(Effort::Medium), 32768);
        assert_eq!(thinking, Some(json!({ "type": "enabled", "budget_tokens": 8192 })));
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

    #[test]
    fn message_to_anthropic_never_replays_openai_responses_raw() {
        // A GPT-6 turn's raw (OpenAI output items) is not Anthropic content.
        let gpt = openai_compat::parse_responses_response(
            json!({
                "status": "completed",
                "output": [
                    { "type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "enc" },
                    { "type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "read_file", "arguments": "{}" }
                ]
            }),
            "gpt-6-sol",
            "openai",
            "https://api.openai.com/v1",
        );
        assert!(!gpt.raw_content.is_empty());
        let mut req = sample_request();
        req.messages = vec![LlmMessage {
            role: LlmRole::Assistant,
            content: LlmContent::AssistantWithTools {
                raw: gpt.raw_content,
                text: String::new(),
                tool_uses: gpt.tool_uses,
            },
        }];
        let body = build_request(&req);
        let content = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "tool_use");
        assert_eq!(content[0]["id"], "call_1");
    }

    // ─── OpenAI-compat effort gating + token-cap key ────────────────────

    #[test]
    fn openai_reasoning_effort_only_on_reasoning_models() {
        // Reasoning models get reasoning_effort…
        for m in ["o1", "o3-mini", "o4-mini", "gpt-5", "gpt-5-mini", "gpt-6.1-terra"] {
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
        for m in ["o1", "o3-mini", "o4-mini", "gpt-5", "gpt-6.1-terra"] {
            let mut req = sample_request();
            req.model = m.into();
            req.max_tokens = 48000;
            let body = openai_compat::build_request(&req);
            assert_eq!(body["max_completion_tokens"], 48000, "{m} uses max_completion_tokens");
            assert!(body.get("max_tokens").is_none(), "{m} must NOT send max_tokens");
        }
    }

    #[test]
    fn openai_effort_passes_xhigh_and_max_through_on_gpt6_only() {
        // Every GPT-6 model page accepts xhigh and max (#689).
        for m in ["gpt-6-sol", "gpt-6-luna", "gpt-6-astra", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6.2-astra", "gpt-6.2-sol"] {
            for e in [Effort::Xhigh, Effort::Max] {
                assert_eq!(openai_compat::reasoning_effort_level(m, e), e.as_str(), "{m}");
            }
        }
        // The older reasoning models stop at high.
        for m in ["o3-mini", "gpt-5"] {
            assert_eq!(openai_compat::reasoning_effort_level(m, Effort::Xhigh), "high", "{m}");
            assert_eq!(openai_compat::reasoning_effort_level(m, Effort::Max), "high", "{m}");
            assert_eq!(openai_compat::reasoning_effort_level(m, Effort::Low), "low", "{m}");
        }
        let mut req = sample_request();
        req.model = "gpt-5".into();
        req.effort = Some(Effort::Max);
        assert_eq!(openai_compat::build_request(&req)["reasoning_effort"], "high");
    }

    #[test]
    fn openai_gpt6_through_a_gateway_carries_effort_but_not_off() {
        // Behind a gateway a GPT-6 id stays on Chat Completions, which sends
        // the stage's effort as-is; Off sends nothing (`none` is Responses-only).
        for m in ["gpt-6-sol", "gpt-6-astra", "gpt-6.2-sol", "openai/gpt-6.1-terra"] {
            assert!(!openai_compat::uses_responses_api(m, "https://litellm.corp:4000/v1"), "{m}");
            let mut req = sample_request();
            req.model = m.into();
            req.effort = Some(Effort::Max);
            assert_eq!(openai_compat::build_request(&req)["reasoning_effort"], "max", "{m}");
            req.effort = None;
            assert!(openai_compat::build_request(&req).get("reasoning_effort").is_none(), "{m}");
        }
    }

    #[test]
    fn openai_responses_request_carries_effort_unfolded() {
        let mut req = sample_request();
        req.model = "gpt-6.1-terra".into();
        req.effort = Some(Effort::Max);
        let body = openai_compat::build_responses_request(&req, "openai", "https://api.openai.com/v1");
        assert_eq!(body["reasoning"], json!({ "effort": "max" }));
        assert!(body.get("reasoning_effort").is_none(), "Chat Completions key must not leak");
        // No effort on GPT-6.1 Terra → `none`, not the API's default `medium`.
        req.effort = None;
        assert_eq!(openai_compat::build_responses_request(&req, "openai", "https://api.openai.com/v1")["reasoning"], json!({ "effort": "none" }));
    }

    #[test]
    fn openai_responses_effort_off_is_none_only_where_accepted() {
        // GPT-6 Sol, GPT-6 Luna and GPT-6.1 Terra take `none` (dated snapshots too).
        for m in ["gpt-6-sol", "gpt-6-luna", "gpt-6.1-terra", "GPT-6-Sol", "gpt-6-sol-2026-08-01"] {
            assert_eq!(openai_compat::effort_off_level(m), Some("none"), "{m}");
            let mut req = sample_request();
            req.model = m.into();
            let body = openai_compat::build_responses_request(&req, "openai", "https://api.openai.com/v1");
            assert_eq!(body["reasoning"], json!({ "effort": "none" }), "{m}");
        }
        // GPT-6 Astra, GPT-6.1 Sol and GPT-6.2 Astra/Sol 400 on it: omitted, so
        // they run at `medium`. Only a dated snapshot suffix counts: another
        // variant may not take `none`.
        for m in [
            "gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-sol-2026-10-01", "gpt-6.2-astra", "gpt-6.2-sol",
            "openai/gpt-6.2-sol", "gpt-6.2-astra-2026-11-17", "gpt-6-solar", "gpt-6.2-terra",
            "gpt-6-sol-pro", "gpt-6-luna-mini", "gpt-6-sol-2026-08", "gpt-6.1-terra-2026-08-01-pro",
        ] {
            assert_eq!(openai_compat::effort_off_level(m), None, "{m}");
            let mut req = sample_request();
            req.model = m.into();
            assert!(openai_compat::build_responses_request(&req, "openai", "https://api.openai.com/v1").get("reasoning").is_none(), "{m}");
        }
        // A real effort is never replaced by `none`.
        let mut req = sample_request();
        req.model = "gpt-6-sol".into();
        req.effort = Some(Effort::Low);
        assert_eq!(openai_compat::build_responses_request(&req, "openai", "https://api.openai.com/v1")["reasoning"], json!({ "effort": "low" }));
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

// ─── OpenAI Responses API (GPT-6 tool calls, #689) ───────────────────────────

const OPENAI_V1: &str = "https://api.openai.com/v1";

fn parse_responses(body: serde_json::Value) -> super::LlmResponse {
    openai_compat::parse_responses_response(body, "gpt-6-sol", "openai", OPENAI_V1)
}

/// The Responses body for `req` sent through the `openai` provider.
fn responses_body(req: &LlmRequest) -> serde_json::Value {
    openai_compat::build_responses_request(req, "openai", OPENAI_V1)
}

/// A GPT-6 tool turn: reasoning, a short message, then two calls.
fn gpt6_reasoning_turn() -> serde_json::Value {
    json!({
        "status": "completed",
        "output": [
            { "type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "enc-1" },
            { "type": "message", "id": "msg_1", "role": "assistant", "status": "completed",
              "content": [{ "type": "output_text", "text": "Reading both.", "annotations": [] }] },
            { "type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "read_file",
              "arguments": "{\"path\":\"x\"}", "status": "completed" },
            { "type": "reasoning", "id": "rs_2", "summary": [], "encrypted_content": "enc-2" },
            { "type": "function_call", "id": "fc_2", "call_id": "call_2", "name": "read_file",
              "arguments": "{\"path\":\"y\"}", "status": "completed" }
        ]
    })
}

/// A request whose history holds `resp` as an assistant tool turn (with
/// `raw`) and its two results, sent to `model`.
fn replay_request(resp: &super::LlmResponse, raw: Vec<serde_json::Value>, model: &str) -> LlmRequest {
    let mut req = sample_request();
    req.model = model.into();
    req.messages.push(LlmMessage {
        role: LlmRole::Assistant,
        content: LlmContent::AssistantWithTools {
            raw,
            text: resp.text.clone(),
            tool_uses: resp.tool_uses.clone(),
        },
    });
    req.messages.push(LlmMessage {
        role: LlmRole::User,
        content: LlmContent::ToolResults(
            resp.tool_uses
                .iter()
                .map(|u| LlmToolResult { tool_use_id: u.id.clone(), content: "ok".into(), is_error: false })
                .collect(),
        ),
    });
    req
}

#[test]
fn openai_responses_request_includes_encrypted_reasoning() {
    let mut req = sample_request();
    req.model = "gpt-6-sol".into();
    let body = openai_compat::build_responses_request(&req, "openai", "https://api.openai.com/v1");
    assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
    assert_eq!(body["store"], false);
    // Chat Completions never gets it.
    assert!(openai_compat::build_request(&req).get("include").is_none());
}

#[test]
fn openai_responses_reasoning_round_trips_in_order() {
    let resp = parse_responses(gpt6_reasoning_turn());
    assert_eq!(resp.text, "Reading both.");
    assert_eq!(resp.tool_uses.len(), 2);
    // An origin item, then every reasoning / message / call item as returned.
    assert_eq!(resp.raw_content.len(), 6);
    assert!(openai_compat::is_responses_raw(&resp.raw_content));
    assert_eq!(resp.raw_content[0]["model"], "gpt-6-sol");
    assert_eq!(resp.raw_content[0]["provider"], "openai");
    assert_eq!(resp.raw_content[0]["base"], "https://api.openai.com/v1/responses");

    let raw = resp.raw_content.clone();
    let body = responses_body(&replay_request(&resp, raw, "gpt-6-sol"));
    let input = body["input"].as_array().unwrap();
    let output = gpt6_reasoning_turn()["output"].as_array().unwrap().clone();
    // developer, user, the five items verbatim (fc ids kept), then the two outputs.
    assert_eq!(input.len(), 9);
    assert_eq!(input[0]["role"], "developer");
    assert_eq!(input.iter().filter(|i| i["role"] == "developer").count(), 1);
    assert_eq!(&input[2..7], &output[..]);
    assert_eq!(input[4]["id"], "fc_1");
    assert_eq!(input[7], json!({ "type": "function_call_output", "call_id": "call_1", "output": "ok" }));
    assert_eq!(input[8]["call_id"], "call_2");
    let text = body.to_string();
    assert!(!text.contains("octopush."), "the origin item is never sent");
}

#[test]
fn openai_responses_replay_dropped_for_another_model_or_empty_raw() {
    let resp = parse_responses(gpt6_reasoning_turn());
    // Escalated to another model, or the truncation retry's empty raw: the
    // turn is rebuilt (text + calls, no fc ids) and no reasoning is sent.
    for (raw, model) in [
        (resp.raw_content.clone(), "gpt-6.1-terra"),
        (resp.raw_content.clone(), "gpt-6-astra"),
        (vec![], "gpt-6-sol"),
    ] {
        let body = responses_body(&replay_request(&resp, raw, model));
        let input = body["input"].as_array().unwrap();
        assert_eq!(input.len(), 7, "{model}: developer, user, text, 2 calls, 2 outputs");
        assert_eq!(input[2], json!({ "role": "assistant", "content": "Reading both." }));
        assert!(input[3].get("id").is_none() && input[4].get("id").is_none(), "{model}");
        assert!(!body.to_string().contains("enc-1"), "{model}");
        assert!(input.iter().all(|i| i["type"] != "reasoning"), "{model}");
    }
    // An Anthropic turn's raw (content blocks) is never sent to OpenAI either.
    let blocks = vec![json!({ "type": "thinking", "thinking": "t", "signature": "s" })];
    let body = responses_body(&replay_request(&resp, blocks, "gpt-6-sol"));
    assert!(!body.to_string().contains("signature"));
}

#[test]
fn openai_responses_replay_dropped_for_another_provider_or_endpoint() {
    let resp = parse_responses(gpt6_reasoning_turn());
    let req = replay_request(&resp, resp.raw_content.clone(), "gpt-6-sol");
    // Same model, same endpoint (any pasted form of it): replayed.
    let body = openai_compat::build_responses_request(&req, "openai", "https://api.openai.com/v1/responses");
    assert!(body.to_string().contains("enc-1"));
    // Same model under another provider's key (maybe another org), or
    // another endpoint: the reasoning might not decrypt, so it is dropped.
    for (provider, base) in [("openai-work", OPENAI_V1), ("openai", "https://api.openai.com/v2")] {
        let body = openai_compat::build_responses_request(&req, provider, base);
        assert!(!body.to_string().contains("enc-1"), "{provider} {base}");
        assert!(body["input"].as_array().unwrap().iter().all(|i| i["type"] != "reasoning"));
    }
    // An origin without provider or endpoint (written before they were
    // recorded) is never trusted.
    let mut old = resp.raw_content.clone();
    old[0] = json!({ "type": "octopush.responses_origin", "model": "gpt-6-sol" });
    assert!(openai_compat::is_responses_raw(&old));
    let body = responses_body(&replay_request(&resp, old, "gpt-6-sol"));
    assert!(!body.to_string().contains("enc-1"));
}

#[test]
fn openai_responses_raw_size_counts_encrypted_content_decoded() {
    let big = "A".repeat(100_000);
    let resp = parse_responses(json!({
        "status": "completed",
        "output": [
            { "type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": big },
            { "type": "function_call", "id": "fc_1", "call_id": "c", "name": "n", "arguments": "{}" }
        ]
    }));
    let size = openai_compat::responses_raw_chars(&resp.raw_content);
    // Reasoning occupies context: it counts at its decoded size (3/4 of the
    // base64 length), plus the small visible part of the items.
    assert!((75_000..75_500).contains(&size), "{size}");
}

#[test]
fn openai_responses_keeps_no_raw_without_replayable_reasoning() {
    // No reasoning at all: nothing to pass back.
    let plain = parse_responses(json!({
        "status": "completed",
        "output": [{ "type": "function_call", "id": "fc_1", "call_id": "c", "name": "n", "arguments": "{}" }]
    }));
    assert!(plain.raw_content.is_empty());
    // Reasoning without encrypted content can't be replayed statelessly.
    let unencrypted = parse_responses(json!({
        "status": "completed",
        "output": [
            { "type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "enc" },
            { "type": "reasoning", "id": "rs_2", "summary": [] },
            { "type": "function_call", "id": "fc_1", "call_id": "c", "name": "n", "arguments": "{}" }
        ]
    }));
    assert!(unencrypted.raw_content.is_empty());
}

#[test]
fn openai_gpt6_models_use_the_responses_api() {
    let openai = "https://api.openai.com/v1";
    for m in ["gpt-6-sol", "gpt-6-luna", "gpt-6-astra", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6.2-astra", "gpt-6.2-sol", "GPT-6-Sol"] {
        assert!(openai_compat::uses_responses_api(m, openai), "{m} needs the Responses API for tools");
    }
    for m in ["gpt-4o", "gpt-5", "o3-mini", "deepseek-chat", "llama3.1"] {
        assert!(!openai_compat::uses_responses_api(m, openai), "{m} stays on Chat Completions");
    }
}

#[test]
fn openai_gpt6_routes_to_responses_only_on_api_openai_com() {
    assert!(openai_compat::uses_responses_api("gpt-6.1-terra", "https://api.openai.com/v1"));
    // Host compared case-insensitively; a pasted full endpoint still counts.
    assert!(openai_compat::uses_responses_api("gpt-6-sol", "https://API.OpenAI.com/v1/"));
    assert!(openai_compat::uses_responses_api("gpt-6-sol", "https://api.openai.com/v1/chat/completions"));
    // Gateways and overrides keep Chat Completions: they may not speak Responses.
    for base in [
        "http://localhost:4000/v1",
        "https://openrouter.ai/api/v1",
        "https://my-litellm.example.com/v1",
        "https://api.openai.com.evil.example/v1",
        "https://proxy.example/api.openai.com/v1",
        "api.openai.com/v1",
        "",
    ] {
        assert!(!openai_compat::uses_responses_api("gpt-6-sol", base), "{base} stays on Chat Completions");
    }
}

#[test]
fn openai_responses_url_from_any_pasted_base() {
    for base in [
        "https://api.openai.com/v1",
        "https://api.openai.com/v1/",
        "https://api.openai.com/v1/chat/completions",
        "https://api.openai.com/v1/responses",
    ] {
        assert_eq!(openai_compat::responses_url(base), "https://api.openai.com/v1/responses", "{base}");
    }
}

#[test]
fn openai_responses_request_shape() {
    let mut req = sample_request();
    req.model = "gpt-6-sol".into();
    req.max_tokens = 48000;
    let body = openai_compat::build_responses_request(&req, "openai", "https://api.openai.com/v1");
    assert_eq!(body["model"], "gpt-6-sol");
    assert_eq!(body["input"][0]["role"], "developer");
    assert_eq!(body["input"][1], json!({ "role": "user", "content": "Hi there." }));
    assert_eq!(body["max_output_tokens"], 48000);
    assert_eq!(body["store"], false, "nothing is kept server-side");
    assert!(body.get("messages").is_none() && body.get("max_completion_tokens").is_none());
    // Responses tools are flat: no `function` wrapper.
    let tool = &body["tools"][0];
    assert_eq!(tool["type"], "function");
    assert_eq!(tool["name"], "read_file");
    assert_eq!(tool["description"], "Read a file.");
    assert!(tool["parameters"].is_object());
    assert_eq!(tool["strict"], false, "omitted strict would attempt strict mode");
    assert!(tool.get("function").is_none());
    assert!(body.get("tool_choice").is_none());
    req.tool_choice = Some("emit_result".into());
    let body = openai_compat::build_responses_request(&req, "openai", "https://api.openai.com/v1");
    assert_eq!(body["tool_choice"], json!({ "type": "function", "name": "emit_result" }));
}

#[test]
fn openai_responses_system_prompt_is_the_first_developer_item() {
    // GPT-6.2 appends top-level `instructions` after `input`, outside the
    // cacheable prefix, so the system prompt leads `input` instead.
    let mut req = sample_request();
    req.model = "gpt-6.2-sol".into();
    let body = responses_body(&req);
    assert!(body.get("instructions").is_none());
    assert_eq!(body["input"][0], json!({
        "role": "developer",
        "content": [{ "type": "input_text", "text": "You are helpful." }],
    }));
    assert_eq!(body["input"][1], json!({ "role": "user", "content": "Hi there." }));
    // Chat Completions keeps its system message.
    assert_eq!(openai_compat::build_request(&req)["messages"][0]["role"], "system");
    // No system prompt: no developer item, no `instructions`.
    req.system = String::new();
    let body = responses_body(&req);
    assert!(body.get("instructions").is_none());
    let input = body["input"].as_array().unwrap();
    assert_eq!(input.len(), 1);
    assert_eq!(input[0], json!({ "role": "user", "content": "Hi there." }));
}

#[test]
fn openai_responses_replays_tool_turns_by_call_id() {
    let mut req = sample_request();
    req.model = "gpt-6.1-terra".into();
    req.messages.push(LlmMessage {
        role: LlmRole::Assistant,
        content: LlmContent::AssistantWithTools {
            raw: vec![],
            text: "let me read it".into(),
            tool_uses: vec![
                LlmToolUse { id: "call_1".into(), name: "read_file".into(), input: json!({ "path": "x" }) },
                LlmToolUse { id: "call_2".into(), name: "read_file".into(), input: json!({ "path": "y" }) },
            ],
        },
    });
    req.messages.push(LlmMessage {
        role: LlmRole::User,
        content: LlmContent::ToolResults(vec![
            LlmToolResult { tool_use_id: "call_1".into(), content: "ok".into(), is_error: false },
            LlmToolResult { tool_use_id: "call_2".into(), content: "ok2".into(), is_error: false },
        ]),
    });
    let body = openai_compat::build_responses_request(&req, "openai", "https://api.openai.com/v1");
    let input = body["input"].as_array().unwrap();
    assert_eq!(input.len(), 7, "developer, user, assistant text, 2 calls, 2 outputs");
    assert_eq!(input[2], json!({ "role": "assistant", "content": "let me read it" }));
    assert_eq!(input[3]["type"], "function_call");
    assert_eq!(input[3]["call_id"], "call_1");
    assert_eq!(input[3]["name"], "read_file");
    assert!(input[3].get("id").is_none(), "an fc_ id would demand its reasoning item");
    let args: serde_json::Value = serde_json::from_str(input[4]["arguments"].as_str().unwrap()).unwrap();
    assert_eq!(args, json!({ "path": "y" }));
    assert_eq!(input[5], json!({ "type": "function_call_output", "call_id": "call_1", "output": "ok" }));
    assert_eq!(input[6]["call_id"], "call_2");
}

#[test]
fn openai_responses_multimodal_uses_input_parts() {
    let mut req = sample_request();
    req.model = "gpt-6.1-terra".into();
    req.messages = vec![LlmMessage {
        role: LlmRole::User,
        content: LlmContent::Multimodal(vec![
            LlmBlock::Text("hi".into()),
            LlmBlock::Image { media_type: "image/png".into(), data: "ZZ".into() },
        ]),
    }];
    let body = openai_compat::build_responses_request(&req, "openai", "https://api.openai.com/v1");
    let content = &body["input"][1]["content"];
    assert_eq!(content[0], json!({ "type": "input_text", "text": "hi" }));
    assert_eq!(content[1], json!({ "type": "input_image", "image_url": "data:image/png;base64,ZZ" }));
}

#[test]
fn openai_parse_responses_tool_calls() {
    let resp = parse_responses(json!({
        "status": "completed",
        "output": [
            { "type": "reasoning", "id": "rs_1", "summary": [] },
            { "type": "message", "role": "assistant", "content": [
                { "type": "output_text", "text": "Reading." }
            ]},
            { "type": "function_call", "id": "fc_1", "call_id": "call_9", "name": "write_file",
              "arguments": "{\"path\":\"a.ts\",\"content\":\"hello\"}" }
        ],
        "usage": { "input_tokens": 30, "output_tokens": 5 }
    }));
    assert_eq!(resp.text, "Reading.");
    assert_eq!(resp.tool_uses.len(), 1);
    assert_eq!(resp.tool_uses[0].id, "call_9", "keyed by call_id, not the item id");
    assert_eq!(resp.tool_uses[0].name, "write_file");
    assert_eq!(resp.tool_uses[0].input, json!({ "path": "a.ts", "content": "hello" }));
    assert_eq!(resp.stop_reason, LlmStopReason::ToolUse);
    assert_eq!((resp.input_tokens, resp.output_tokens), (30, 5));
    assert!(resp.raw_content.is_empty());
}

#[test]
fn openai_parse_responses_stop_reasons() {
    let text_only = parse_responses(json!({
        "status": "completed",
        "output": [{ "type": "message", "content": [{ "type": "output_text", "text": "Done." }] }]
    }));
    assert_eq!(text_only.text, "Done.");
    assert_eq!(text_only.stop_reason, LlmStopReason::EndTurn);
    // Cut at the token cap, even mid tool call.
    let cut = parse_responses(json!({
        "status": "incomplete",
        "incomplete_details": { "reason": "max_output_tokens" },
        "output": [{ "type": "function_call", "call_id": "c", "name": "n", "arguments": "{" }]
    }));
    assert_eq!(cut.stop_reason, LlmStopReason::MaxTokens);
    assert_eq!(cut.tool_uses[0].input, json!({}), "truncated arguments parse to {{}}");
    let filtered = parse_responses(json!({
        "status": "incomplete",
        "incomplete_details": { "reason": "content_filter" },
        "output": []
    }));
    assert_eq!(filtered.stop_reason, LlmStopReason::Other("content_filter".into()));
}

#[test]
fn openai_parse_responses_refusal_is_visible() {
    let resp = parse_responses(json!({
        "status": "completed",
        "output": [{ "type": "message", "role": "assistant", "content": [
            { "type": "refusal", "refusal": "I can't help with that." }
        ]}]
    }));
    assert_eq!(resp.text, "I can't help with that.");
    assert_eq!(resp.stop_reason, LlmStopReason::Other("refusal".into()), "never an empty EndTurn");
    let mixed = parse_responses(json!({
        "status": "completed",
        "output": [{ "type": "message", "content": [
            { "type": "output_text", "text": "Partly." },
            { "type": "refusal", "refusal": "Not the rest." }
        ]}]
    }));
    assert_eq!(mixed.text, "Partly.\n\nNot the rest.");
    assert_eq!(mixed.stop_reason, LlmStopReason::Other("refusal".into()));
}

#[test]
fn openai_parse_responses_splits_cached_input() {
    let resp = parse_responses(json!({
        "status": "completed",
        "output": [],
        "usage": {
            "input_tokens": 15000,
            "output_tokens": 200,
            "input_tokens_details": { "cached_tokens": 12000, "cache_write_tokens": 2500 }
        }
    }));
    assert_eq!(resp.input_tokens, 500, "billable input = input - cached - written");
    assert_eq!(resp.cache_read_tokens, 12000);
    assert_eq!(resp.cache_creation_tokens, 2500);
    assert_eq!(resp.output_tokens, 200);
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
            ..Default::default()
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
        let mut on_retry = |_a: u32, _of: u32, _d: u64, _k: ProviderErrorKind| {
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

// ─── complete_cancellable: the Talk director's call ─────────────────────────────

mod cancellable {
    use super::super::{
        anthropic::AnthropicProvider, client_for, complete_cancellable, final_failure_text, is_loopback_base, retry_notice,
        Completion, LlmProvider, LlmRequest, LlmResponse, LlmStopReason, DEFAULT_MAX_RETRIES, LOCAL_CONNECT_RETRIES,
    };
    use crate::error::{AppError, AppResult, ProviderErrorKind};
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    /// What one scripted call does.
    enum Step {
        Answer,
        Fail(ProviderErrorKind, Option<u64>),
        /// Never answers, like a request on a connection that died silently.
        /// Sets the flag when its future is dropped (the request abandoned).
        Hang(Arc<AtomicBool>),
    }

    struct FakeProvider {
        steps: Mutex<VecDeque<Step>>,
        calls: AtomicU32,
    }

    impl FakeProvider {
        fn new(steps: Vec<Step>) -> Self {
            Self { steps: Mutex::new(steps.into()), calls: AtomicU32::new(0) }
        }
    }

    /// Raises its flag on drop: proof a hung request was abandoned, not left
    /// running in the background.
    struct DropFlag(Arc<AtomicBool>);
    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    fn answer() -> LlmResponse {
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
            ..Default::default()
        }
    }

    #[async_trait::async_trait]
    impl LlmProvider for FakeProvider {
        async fn complete(
            &self,
            _api_base: &str,
            _api_key: Option<&str>,
            _req: &LlmRequest,
            _client: &reqwest::Client,
        ) -> AppResult<LlmResponse> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let step = self.steps.lock().unwrap().pop_front().expect("fake provider ran out of steps");
            match step {
                Step::Answer => Ok(answer()),
                Step::Fail(kind, retry_after) => Err(AppError::Provider {
                    kind,
                    retry_after,
                    message: format!("Anthropic API error {kind:?}"),
                }),
                Step::Hang(dropped) => {
                    let _guard = DropFlag(dropped);
                    std::future::pending::<()>().await;
                    unreachable!()
                }
            }
        }
    }

    /// Each announced wait: (attempt, of, delay, kind).
    type Retries = Arc<Mutex<Vec<(u32, u32, u64, ProviderErrorKind)>>>;

    async fn call(
        provider: &dyn LlmProvider,
        client: &reqwest::Client,
        api_base: &str,
        cancel: &AtomicBool,
        max_retries: u32,
    ) -> (Completion, Retries) {
        let seen: Retries = Arc::default();
        let log = Arc::clone(&seen);
        let mut on_retry = move |a: u32, of: u32, d: u64, k: ProviderErrorKind| log.lock().unwrap().push((a, of, d, k));
        let req = super::sample_request();
        let out = complete_cancellable(provider, api_base, Some("key"), &req, client, cancel, max_retries, &mut on_retry).await;
        (out, seen)
    }

    /// Raise `cancel` after `ms`, as the Stop button does from another task.
    fn stop_after(cancel: &Arc<AtomicBool>, ms: u64) {
        let cancel = Arc::clone(cancel);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            cancel.store(true, Ordering::SeqCst);
        });
    }

    #[tokio::test]
    async fn a_529_then_an_answer_is_retried_with_a_notice() {
        let p = FakeProvider::new(vec![Step::Fail(ProviderErrorKind::Overloaded, Some(0)), Step::Answer]);
        let cancel = AtomicBool::new(false);
        let (out, retries) = call(&p, &reqwest::Client::new(), "http://x", &cancel, 5).await;
        assert!(matches!(out, Completion::Done(ref r) if r.text == "done"), "{out:?}");
        assert_eq!(p.calls.load(Ordering::SeqCst), 2);
        assert_eq!(*retries.lock().unwrap(), vec![(1, 5, 0, ProviderErrorKind::Overloaded)]);
        // The words the turn shows are the sub-agents' journal words.
        assert_eq!(retry_notice(1, 5, 8, ProviderErrorKind::Overloaded), "model overloaded — retrying in 8s (retry 1 of 5)");
    }

    #[tokio::test]
    async fn stop_abandons_a_request_in_flight() {
        let dropped = Arc::new(AtomicBool::new(false));
        let p = FakeProvider::new(vec![Step::Hang(Arc::clone(&dropped))]);
        let cancel = Arc::new(AtomicBool::new(false));
        stop_after(&cancel, 150);
        let started = Instant::now();
        let (out, _) = tokio::time::timeout(Duration::from_secs(5), call(&p, &reqwest::Client::new(), "http://x", &cancel, 5))
            .await
            .expect("Stop must end a hung request");
        assert!(matches!(out, Completion::Cancelled), "{out:?}");
        assert!(started.elapsed() < Duration::from_millis(1000), "Stop took {:?}", started.elapsed());
        assert!(dropped.load(Ordering::SeqCst), "the request future was dropped, not left running");
        assert_eq!(p.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn stop_during_a_backoff_is_a_stop_not_a_failure() {
        let p = FakeProvider::new(vec![Step::Fail(ProviderErrorKind::RateLimit, Some(30))]);
        let cancel = Arc::new(AtomicBool::new(false));
        stop_after(&cancel, 150);
        let started = Instant::now();
        let (out, retries) = call(&p, &reqwest::Client::new(), "http://x", &cancel, 5).await;
        assert!(matches!(out, Completion::Cancelled), "{out:?}");
        assert!(started.elapsed() < Duration::from_secs(2), "the 30s wait was cut short");
        assert_eq!(retries.lock().unwrap().len(), 1, "the wait was announced");
        assert_eq!(p.calls.load(Ordering::SeqCst), 1, "no attempt after the stop");
    }

    #[tokio::test]
    async fn exhausted_retries_fail_with_a_clear_message() {
        let p = FakeProvider::new(vec![
            Step::Fail(ProviderErrorKind::Overloaded, Some(0)),
            Step::Fail(ProviderErrorKind::Overloaded, Some(0)),
            Step::Fail(ProviderErrorKind::Overloaded, Some(0)),
        ]);
        let cancel = AtomicBool::new(false);
        let (out, _) = call(&p, &reqwest::Client::new(), "http://x", &cancel, 2).await;
        let (error, retries) = match out {
            Completion::Failed { error, retries } => (error, retries),
            other => panic!("expected a failure, got {other:?}"),
        };
        assert_eq!(retries, 2);
        let text = final_failure_text(&error, retries);
        assert!(text.starts_with("Model overloaded, still failing after 2 retries."), "{text}");
        assert!(text.contains("The conversation is saved"), "{text}");
        assert!(text.ends_with("(Anthropic API error Overloaded)"), "the provider's own words stay: {text}");
    }

    #[tokio::test]
    async fn a_non_transient_error_fails_at_once_with_its_own_text() {
        let p = FakeProvider::new(vec![Step::Fail(ProviderErrorKind::Auth, None)]);
        let cancel = AtomicBool::new(false);
        let (out, retries) = call(&p, &reqwest::Client::new(), "http://x", &cancel, 5).await;
        let (error, n) = match out {
            Completion::Failed { error, retries } => (error, retries),
            other => panic!("expected a failure, got {other:?}"),
        };
        assert_eq!(n, 0);
        assert!(retries.lock().unwrap().is_empty());
        assert_eq!(final_failure_text(&error, n), error.to_string());
    }

    /// What a test server does once it has read the request head.
    #[derive(Clone, Copy)]
    enum Reply {
        /// Never answers: a proxy holding a dead upstream, a peer gone silent.
        Nothing,
        /// Sends the head and part of the body, then goes silent.
        PartThenSilence,
        /// Sends the head and part of the body, then closes the connection.
        PartThenClose,
        /// Sends this whole response (status line, headers, body) and closes.
        Whole(&'static str),
    }

    /// A local test server, and the address to resolve a REMOTE-looking host
    /// to it (`remote_client`): the stall guards and the retry rules under
    /// test apply to remote providers, and a loopback base would get the
    /// loopback client instead.
    async fn test_server(reply: Reply) -> std::net::SocketAddr {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut seen = Vec::new();
                    let mut buf = [0u8; 8192];
                    while !String::from_utf8_lossy(&seen).contains("\r\n\r\n") {
                        match sock.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => seen.extend_from_slice(&buf[..n]),
                        }
                    }
                    if let Reply::Whole(response) = reply {
                        let _ = sock.write_all(response.as_bytes()).await;
                        let _ = sock.shutdown().await;
                        // Read the rest of the request until the client hangs
                        // up, so closing with unread bytes can't reset the
                        // answer away.
                        let drain = async { while matches!(sock.read(&mut buf).await, Ok(n) if n > 0) {} };
                        let _ = tokio::time::timeout(Duration::from_secs(2), drain).await;
                        return;
                    }
                    if !matches!(reply, Reply::Nothing) {
                        let head = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 4000\r\n\r\n{\"content\":[{\"type\":\"text\",";
                        let _ = sock.write_all(head.as_bytes()).await;
                        let _ = sock.flush().await;
                    }
                    if matches!(reply, Reply::PartThenClose) {
                        let _ = sock.shutdown().await;
                        return;
                    }
                    tokio::time::sleep(Duration::from_secs(60)).await;
                });
            }
        });
        addr
    }

    /// The production stall guards with a short idle bound (the real one is
    /// `LLM_READ_TIMEOUT`), with `llm.test` resolved to `addr`.
    fn remote_client(addr: std::net::SocketAddr) -> reqwest::Client {
        crate::tls::with_stall_guards(reqwest::Client::builder().no_proxy().resolve("llm.test", addr), Duration::from_millis(300))
            .build()
            .unwrap()
    }

    async fn send(client: &reqwest::Client, base: &str) -> AppError {
        tokio::time::timeout(
            Duration::from_secs(10),
            AnthropicProvider.complete(base, Some("key"), &super::sample_request(), client),
        )
        .await
        .expect("the request must end")
        .expect_err("no full answer means an error")
    }

    #[tokio::test]
    async fn a_read_timeout_after_the_request_went_out_is_final() {
        let addr = test_server(Reply::Nothing).await;
        let (client, base) = (remote_client(addr), format!("http://llm.test:{}", addr.port()));
        let started = Instant::now();
        let err = send(&client, &base).await;
        assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
        assert_eq!(err.transient_retry(), None, "never retried: {err}");
        let text = err.to_string();
        assert!(text.contains("no answer before the read timeout"), "{text}");
        assert!(text.contains("It was not retried"), "{text}");

        // The director's call returns it at once, with no retry.
        let cancel = AtomicBool::new(false);
        let (out, retries) = call(&AnthropicProvider, &client, &base, &cancel, 5).await;
        assert!(matches!(out, Completion::Failed { retries: 0, .. }), "{out:?}");
        assert!(retries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_answer_that_went_silent_mid_body_is_not_a_json_error_and_is_final() {
        let addr = test_server(Reply::PartThenSilence).await;
        let err = send(&remote_client(addr), &format!("http://llm.test:{}", addr.port())).await;
        let text = err.to_string();
        assert!(!text.contains("JSON parse error"), "{text}");
        assert!(text.contains("the connection went silent while the answer was arriving"), "{text}");
        assert!(text.contains("It was not retried"), "{text}");
        assert_eq!(err.transient_retry(), None, "{text}");
    }

    #[tokio::test]
    async fn body_read_error_is_transient() {
        // A 200 whose connection resets mid-body: the answer is gone, so the
        // request is sent again, as a network error.
        let addr = test_server(Reply::PartThenClose).await;
        let err = send(&remote_client(addr), &format!("http://llm.test:{}", addr.port())).await;
        let text = err.to_string();
        assert!(!text.contains("JSON parse error"), "{text}");
        assert!(text.contains("the connection was lost while the answer was arriving"), "{text}");
        assert!(!text.contains("It was not retried"), "{text}");
        assert_eq!(err.transient_retry().map(|(k, _)| k), Some(ProviderErrorKind::Network), "{text}");
    }

    /// The director's call against a server that answers every request
    /// with `response`, and how many requests it made.
    async fn call_answered_with(response: &'static str) -> (Completion, Retries) {
        let addr = test_server(Reply::Whole(response)).await;
        let (client, base) = (remote_client(addr), format!("http://llm.test:{}", addr.port()));
        let cancel = AtomicBool::new(false);
        tokio::time::timeout(Duration::from_secs(5), call(&AnthropicProvider, &client, &base, &cancel, DEFAULT_MAX_RETRIES))
            .await
            .expect("a final error returns at once, with no backoff")
    }

    #[tokio::test]
    async fn should_retry_false_is_not_retried() {
        let (out, retries) = call_answered_with(
            "HTTP/1.1 529 Site Overloaded\r\nx-should-retry: false\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        )
        .await;
        assert!(retries.lock().unwrap().is_empty(), "no wait announced");
        let error = match out {
            Completion::Failed { error, retries: 0 } => error,
            other => panic!("expected a failure with no retry, got {other:?}"),
        };
        assert_eq!(error.provider_kind(), ProviderErrorKind::Other, "{error}");
        assert!(error.to_string().starts_with("Anthropic API error 529"), "{error}");
    }

    #[tokio::test]
    async fn spend_cap_429_without_retry_after_fails_fast() {
        let (out, retries) = call_answered_with(concat!(
            // No Content-Length: the body runs to the close.
            "HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
            r#"{"type":"error","error":{"type":"rate_limit_error","message":"You have reached your specified API usage limits. You will regain access on 2026-12-01."}}"#,
        ))
        .await;
        assert!(retries.lock().unwrap().is_empty(), "a cap no wait can lift is not retried");
        let error = match out {
            Completion::Failed { error, retries: 0 } => error,
            other => panic!("expected a failure with no retry, got {other:?}"),
        };
        assert_eq!(error.provider_kind(), ProviderErrorKind::SpendCap, "{error}");
        assert!(error.to_string().contains("usage limits"), "the provider's words stay: {error}");
    }

    #[test]
    fn statuses_are_classified_with_what_the_provider_says_about_retrying() {
        use super::super::classify_status;
        use ProviderErrorKind::*;
        let capped = r#"{"error":{"type":"rate_limit_error","message":"You have reached your specified API usage limits."}}"#;
        let quota = r#"{"error":{"message":"You exceeded your current quota.","type":"insufficient_quota"}}"#;
        assert_eq!(classify_status(429, None, None, capped), SpendCap);
        assert_eq!(classify_status(429, None, None, quota), SpendCap);
        // A per-minute limit stays a rate limit: it has a retry-after, or
        // its body names no cap.
        assert_eq!(classify_status(429, Some(20), None, capped), RateLimit);
        assert_eq!(classify_status(429, None, None, r#"{"error":{"message":"Number of request tokens has exceeded your per-minute rate limit"}}"#), RateLimit);
        // The provider's own word.
        assert_eq!(classify_status(529, None, Some(false), "{}"), Other);
        assert_eq!(classify_status(500, None, Some(false), "{}"), Other);
        assert_eq!(classify_status(529, None, Some(true), "{}"), Overloaded);
        assert_eq!(classify_status(401, None, Some(true), "{}"), Auth);
    }

    #[test]
    fn should_retry_header_is_read_as_a_boolean() {
        use super::super::parse_should_retry;
        let mut headers = reqwest::header::HeaderMap::new();
        assert_eq!(parse_should_retry(&headers), None);
        headers.insert("x-should-retry", " False ".parse().unwrap());
        assert_eq!(parse_should_retry(&headers), Some(false));
        headers.insert("x-should-retry", "true".parse().unwrap());
        assert_eq!(parse_should_retry(&headers), Some(true));
        headers.insert("x-should-retry", "maybe".parse().unwrap());
        assert_eq!(parse_should_retry(&headers), None);
    }

    /// A port nothing listens on.
    fn closed_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    #[tokio::test]
    async fn a_refused_connection_to_a_remote_provider_is_retryable() {
        let port = closed_port();
        let addr: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
        let err = send(&remote_client(addr), &format!("http://llm.test:{port}")).await;
        assert_eq!(err.transient_retry().map(|(k, _)| k), Some(ProviderErrorKind::Network), "{err}");
    }

    #[tokio::test]
    async fn a_local_server_that_is_not_running_fails_fast_and_says_so() {
        let base = format!("http://127.0.0.1:{}", closed_port());
        let cancel = AtomicBool::new(false);
        let started = Instant::now();
        let (out, retries) = call(&AnthropicProvider, &reqwest::Client::new(), &base, &cancel, DEFAULT_MAX_RETRIES).await;
        // One retry after a 2s wait, not five over about a minute.
        assert!(started.elapsed() < Duration::from_secs(6), "took {:?}", started.elapsed());
        assert_eq!(retries.lock().unwrap().len(), LOCAL_CONNECT_RETRIES as usize);
        // Announced against the local budget: "retry 1 of 1", not "of 5".
        let (attempt, of, delay, kind) = retries.lock().unwrap()[0];
        assert_eq!((attempt, of), (1, LOCAL_CONNECT_RETRIES));
        assert_eq!(retry_notice(attempt, of, delay, kind), "network error — retrying in 2s (retry 1 of 1)");
        let (error, n) = match out {
            Completion::Failed { error, retries } => (error, retries),
            other => panic!("expected a failure, got {other:?}"),
        };
        assert_eq!(n, 1);
        let text = final_failure_text(&error, n);
        assert!(text.starts_with(&format!("The model server on this Mac at {base} isn't reachable. Is it running?")), "{text}");
        assert_eq!(text, error.to_string(), "shown as it is, with no \"still failing\" prefix");
    }

    #[test]
    fn loopback_bases_are_recognised_by_their_url() {
        for base in [
            "http://localhost:11434/v1",
            "http://LOCALHOST:1234",
            "http://ollama.localhost:11434",
            "http://127.0.0.1:8080/v1",
            "http://127.1.2.3",
            "http://[::1]:11434/v1",
            " http://localhost:4000/anthropic ",
        ] {
            assert!(is_loopback_base(base), "{base}");
        }
        for base in ["https://api.anthropic.com", "http://192.168.1.10:11434", "http://localhost.example.com", "not a url", ""] {
            assert!(!is_loopback_base(base), "{base}");
        }
    }

    #[test]
    fn a_loopback_base_gets_the_client_with_no_read_bound() {
        let remote = reqwest::Client::new();
        assert!(std::ptr::eq(client_for("http://localhost:11434/v1", &remote), crate::tls::local_llm_client()));
        assert!(std::ptr::eq(client_for("https://api.anthropic.com", &remote), &remote));
    }
}

// ─── Streaming: SSE, the Anthropic stream, stream_with_retry ────────────────────
// Fixture transcripts follow the documented Messages streaming format
// (event types and fields); their ids and text are made up.

mod streaming {
    use super::super::anthropic;
    use super::super::sse::{ByteSource, SseEvent, SseParser};
    use super::super::{stream_with_retry, Completion, LlmProvider, LlmRequest, LlmResponse, StreamEvent};
    use crate::error::{AppError, AppResult, ProviderErrorKind};
    use bytes::Bytes;
    use serde_json::{json, Value};
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    /// A body in chunks; a `None` chunk goes silent for good.
    pub(super) struct Chunks(pub(super) VecDeque<Option<Vec<u8>>>);

    #[async_trait::async_trait]
    impl ByteSource for Chunks {
        async fn next_chunk(&mut self) -> AppResult<Option<Bytes>> {
            match self.0.pop_front() {
                Some(Some(bytes)) => Ok(Some(Bytes::from(bytes))),
                Some(None) => {
                    std::future::pending::<()>().await;
                    unreachable!()
                }
                None => Ok(None),
            }
        }
    }

    pub(super) fn chunks(text: &str, size: usize) -> Chunks {
        Chunks(text.as_bytes().chunks(size).map(|c| Some(c.to_vec())).collect())
    }

    /// Events as the wire carries them: the event name is the data's `type`.
    pub(super) fn sse(events: &[Value]) -> String {
        events.iter().map(|e| format!("event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap())).collect()
    }

    fn start() -> Value {
        json!({"type": "message_start", "message": {"id": "msg_fixture", "type": "message", "role": "assistant",
            "model": "claude-test", "content": [], "stop_reason": null, "stop_sequence": null,
            "usage": {"input_tokens": 120, "cache_creation_input_tokens": 30, "cache_read_input_tokens": 900, "output_tokens": 1}}})
    }
    fn block_start(index: usize, block: Value) -> Value { json!({"type": "content_block_start", "index": index, "content_block": block}) }
    fn delta(index: usize, delta: Value) -> Value { json!({"type": "content_block_delta", "index": index, "delta": delta}) }
    fn block_stop(index: usize) -> Value { json!({"type": "content_block_stop", "index": index}) }

    /// Thinking, text, then a tool call whose input arrives in pieces.
    fn answer_events() -> Vec<Value> {
        vec![
            start(),
            block_start(0, json!({"type": "thinking", "thinking": "", "signature": ""})),
            delta(0, json!({"type": "thinking_delta", "thinking": "The config decides"})),
            delta(0, json!({"type": "thinking_delta", "thinking": " the port."})),
            delta(0, json!({"type": "signature_delta", "signature": "c2lnbmVkLWZpeHR1cmU="})),
            block_stop(0),
            block_start(1, json!({"type": "text", "text": ""})),
            json!({"type": "ping"}),
            delta(1, json!({"type": "text_delta", "text": "Reading the"})),
            delta(1, json!({"type": "text_delta", "text": " config first."})),
            block_stop(1),
            json!({"type": "an_event_added_later"}),
            block_start(2, json!({"type": "tool_use", "id": "toolu_fixture", "name": "read_file", "input": {}})),
            delta(2, json!({"type": "input_json_delta", "partial_json": ""})),
            delta(2, json!({"type": "input_json_delta", "partial_json": "{\"path\": \"src/con"})),
            delta(2, json!({"type": "input_json_delta", "partial_json": "fig.toml\", \"limit\": 4"})),
            delta(2, json!({"type": "input_json_delta", "partial_json": "0}"})),
            block_stop(2),
            // A null count never replaces the one `message_start` gave.
            json!({"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": null}, "usage": {"output_tokens": 57, "cache_read_input_tokens": null}}),
            json!({"type": "message_stop"}),
        ]
    }

    /// What the sink sees for `answer_events` (thinking isn't streamed).
    fn answer_stream() -> Vec<StreamEvent> {
        let input = |partial: &str| StreamEvent::ToolInput { index: 2, partial: partial.into() };
        vec![
            StreamEvent::Text("Reading the".into()),
            StreamEvent::Text(" config first.".into()),
            StreamEvent::ToolStart { index: 2, id: "toolu_fixture".into(), name: "read_file".into() },
            input("{\"path\": \"src/con"),
            input("fig.toml\", \"limit\": 4"),
            input("0}"),
            StreamEvent::ToolEnd { index: 2 },
        ]
    }

    /// The same answer as a non-streamed request returns it whole.
    fn whole_answer() -> LlmResponse {
        anthropic::parse_response(json!({
            "id": "msg_fixture", "type": "message", "role": "assistant", "model": "claude-test",
            "content": [
                {"type": "thinking", "thinking": "The config decides the port.", "signature": "c2lnbmVkLWZpeHR1cmU="},
                {"type": "text", "text": "Reading the config first."},
                {"type": "tool_use", "id": "toolu_fixture", "name": "read_file", "input": {"path": "src/config.toml", "limit": 40}}
            ],
            "stop_reason": "tool_use", "stop_sequence": null,
            "usage": {"input_tokens": 120, "cache_creation_input_tokens": 30, "cache_read_input_tokens": 900, "output_tokens": 57}
        }))
    }

    pub(super) fn assert_same(got: &LlmResponse, want: &LlmResponse) {
        assert_eq!(got.text, want.text);
        assert_eq!(serde_json::to_value(&got.tool_uses).unwrap(), serde_json::to_value(&want.tool_uses).unwrap());
        assert_eq!(got.stop_reason, want.stop_reason);
        assert_eq!(
            (got.input_tokens, got.output_tokens, got.cache_read_tokens, got.cache_creation_tokens),
            (want.input_tokens, want.output_tokens, want.cache_read_tokens, want.cache_creation_tokens),
        );
        assert_eq!(got.raw_content, want.raw_content);
        assert_eq!(got.usage_unreported, want.usage_unreported);
    }

    async fn read(source: Chunks) -> (AppResult<LlmResponse>, Vec<StreamEvent>) {
        let mut events = Vec::new();
        let mut sink = |e: StreamEvent| events.push(e);
        let out = anthropic::read_stream(source, Some(Duration::from_secs(5)), &mut sink).await;
        (out, events)
    }

    #[test]
    fn sse_parser_follows_the_format() {
        // A BOM, a comment, CRLF and CR line ends, `data` with and without
        // the space, an event with no data (not dispatched), and one left
        // unfinished at the end (dropped).
        let body = "\u{FEFF}: keep-alive\r\nevent: first\r\ndata: one\r\ndata:two\r\n\r\ndata\r\revent: no-data\n\ndata: never\n";
        let mut parser = SseParser::default();
        let mut events = Vec::new();
        for byte in body.as_bytes() {
            events.extend(parser.push(std::slice::from_ref(byte)));
        }
        let event = |event: &str, data: &str| SseEvent { event: event.into(), data: data.into() };
        assert_eq!(events, vec![event("first", "one\ntwo"), event("", "")]);
        assert!(parser.finish().is_empty(), "the unfinished event is dropped");

        // A character split across chunks arrives whole; a body whose last
        // blank line is a lone CR still dispatches its event at the end.
        let mut parser = SseParser::default();
        let body = "data: caf\u{e9} \u{2615}\r\r".as_bytes();
        let (head, tail) = body.split_at(10); // inside the two bytes of é
        assert!(parser.push(head).is_empty());
        assert!(parser.push(tail).is_empty(), "the CR may still be half a CRLF");
        assert_eq!(parser.finish(), vec![event("", "caf\u{e9} \u{2615}")]);
    }

    #[tokio::test]
    async fn anthropic_sse_text_tool_usage() {
        let (out, events) = read(chunks(&sse(&answer_events()), 4096)).await;
        let resp = out.unwrap();
        assert_eq!(resp.text, "Reading the config first.");
        assert_eq!(resp.tool_uses.len(), 1);
        assert_eq!((resp.tool_uses[0].id.as_str(), resp.tool_uses[0].name.as_str()), ("toolu_fixture", "read_file"));
        assert_eq!(resp.tool_uses[0].input, json!({"path": "src/config.toml", "limit": 40}));
        assert_eq!(resp.stop_reason, super::LlmStopReason::ToolUse);
        // Input and cache counts from `message_start`, the cumulative output from `message_delta`.
        assert_eq!((resp.input_tokens, resp.output_tokens), (120, 57));
        assert_eq!((resp.cache_read_tokens, resp.cache_creation_tokens), (900, 30));
        assert_eq!(events, answer_stream());
    }

    #[tokio::test]
    async fn partial_tool_json_assembles() {
        // One byte at a time, with CRLF line ends: the pieces of the input
        // split a key and a number, and only their whole parses.
        let body = sse(&answer_events()).replace('\n', "\r\n");
        let (out, events) = read(chunks(&body, 1)).await;
        let resp = out.unwrap();
        assert_eq!(resp.tool_uses[0].input, json!({"path": "src/config.toml", "limit": 40}));
        let sent: String =
            events.iter().filter_map(|e| if let StreamEvent::ToolInput { partial, .. } = e { Some(partial.as_str()) } else { None }).collect();
        assert_eq!(sent, "{\"path\": \"src/config.toml\", \"limit\": 40}");

        // Pieces that never add up to JSON fail the call; they never panic.
        let mut broken = answer_events();
        broken[16] = delta(2, json!({"type": "input_json_delta", "partial_json": "0"}));
        let (out, _) = read(chunks(&sse(&broken), 4096)).await;
        let err = out.err().expect("broken tool input is an error");
        assert!(err.to_string().contains("isn't valid JSON"), "{err}");
    }

    #[tokio::test]
    async fn stream_equals_complete_response() {
        let (out, _) = read(chunks(&sse(&answer_events()), 37)).await;
        assert_same(&out.unwrap(), &whole_answer());
    }

    /// Streams scripted bodies through the real Anthropic stream reader.
    struct Scripted(Mutex<VecDeque<Chunks>>, AtomicU32, Duration);

    #[async_trait::async_trait]
    impl LlmProvider for Scripted {
        async fn complete(&self, _b: &str, _k: Option<&str>, _r: &LlmRequest, _c: &reqwest::Client) -> AppResult<LlmResponse> {
            unreachable!("only streamed here")
        }

        async fn stream(
            &self,
            _b: &str,
            _k: Option<&str>,
            _r: &LlmRequest,
            _c: &reqwest::Client,
            sink: &mut (dyn FnMut(StreamEvent) + Send),
        ) -> AppResult<LlmResponse> {
            self.1.fetch_add(1, Ordering::SeqCst);
            let body = self.0.lock().unwrap().pop_front().expect("ran out of bodies");
            anthropic::read_stream(body, Some(self.2), sink).await.map_err(|e| match e {
                // No backoff wait in a test, as the retry tests above do.
                AppError::Provider { kind, message, .. } => AppError::Provider { kind, retry_after: Some(0), message },
                other => other,
            })
        }
    }

    #[tokio::test]
    async fn mid_stream_overloaded_resets_and_retries() {
        let overloaded = sse(&[
            start(),
            block_start(0, json!({"type": "text", "text": ""})),
            delta(0, json!({"type": "text_delta", "text": "Half an ans"})),
            json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}),
        ]);
        let bodies = [chunks(&overloaded, 4096), chunks(&sse(&answer_events()), 4096)];
        let p = Scripted(Mutex::new(bodies.into()), AtomicU32::new(0), Duration::from_secs(5));
        let cancel = AtomicBool::new(false);
        let mut retries = Vec::new();
        let mut on_retry = |a: u32, d: u64, k: ProviderErrorKind| retries.push((a, d, k));
        let mut events = Vec::new();
        let mut sink = |e: StreamEvent| events.push(e);
        let req = super::sample_request();
        let client = reqwest::Client::new();
        let out = stream_with_retry(&p, "https://api.test", Some("key"), &req, &client, &cancel, 5, &mut on_retry, &mut sink).await;
        let resp = match out { Completion::Done(resp) => resp, other => panic!("expected an answer, got {other:?}") };
        assert_same(&resp, &whole_answer());
        assert_eq!(p.1.load(Ordering::SeqCst), 2);
        assert_eq!(retries, vec![(1, 0, ProviderErrorKind::Overloaded)]);
        // The half answer, dropped by `Reset`, then the whole one.
        assert_eq!(events[..2], [StreamEvent::Text("Half an ans".into()), StreamEvent::Reset]);
        assert_eq!(events[2..], answer_stream()[..]);
    }

    #[tokio::test]
    async fn idle_gap_is_final_not_retried() {
        // Silent after its 200: the provider may still be generating, so the
        // call fails for good instead of hanging, and is never sent again.
        let silent = Chunks(vec![Some(sse(&[start()]).into_bytes()), None].into());
        let p = Scripted(Mutex::new([silent].into()), AtomicU32::new(0), Duration::from_millis(150));
        let (req, client, cancel) = (super::sample_request(), reqwest::Client::new(), AtomicBool::new(false));
        let mut retried = false;
        let mut on_retry = |_a: u32, _d: u64, _k: ProviderErrorKind| retried = true;
        let mut sink = |_e: StreamEvent| {};
        let started = Instant::now();
        let out = stream_with_retry(&p, "https://api.test", None, &req, &client, &cancel, 5, &mut on_retry, &mut sink).await;
        assert!(started.elapsed() < Duration::from_secs(2), "took {:?}", started.elapsed());
        let (err, retries) = match out { Completion::Failed { error, retries } => (error, retries), other => panic!("{other:?}") };
        assert_eq!((retries, p.1.load(Ordering::SeqCst), retried), (0, 1, false), "sent once, never retried");
        assert!(err.transient_retry().is_none(), "{err}");
        assert!(err.to_string().contains("the stream sent nothing for 150ms while the answer was arriving"), "{err}");
        assert!(err.to_string().contains("It was not retried"), "{err}");

        // A body that ends before `message_stop` was cut off: final, never sent again.
        let cut = anthropic::read_stream(chunks(&sse(&answer_events()[..10]), 64), None, &mut sink).await.err().expect("a cut-off stream");
        assert!(cut.transient_retry().is_none(), "{cut}");
        assert!(cut.to_string().contains("the stream ended before the answer was complete"), "{cut}");
    }

    #[tokio::test]
    async fn stop_abandons_a_stream_in_flight() {
        let silent = Chunks(vec![Some(sse(&[start()]).into_bytes()), None].into());
        let p = Scripted(Mutex::new([silent].into()), AtomicU32::new(0), Duration::from_secs(5));
        let cancel = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&cancel);
        tokio::spawn(async move { tokio::time::sleep(Duration::from_millis(150)).await; stop.store(true, Ordering::SeqCst) });
        let (req, client) = (super::sample_request(), reqwest::Client::new());
        let mut on_retry = |_a: u32, _d: u64, _k: ProviderErrorKind| {};
        let mut sink = |_e: StreamEvent| {};
        let started = Instant::now();
        let out = stream_with_retry(&p, "https://api.test", None, &req, &client, &cancel, 5, &mut on_retry, &mut sink).await;
        assert!(matches!(out, Completion::Cancelled), "{out:?}");
        assert!(started.elapsed() < Duration::from_secs(2), "took {:?}", started.elapsed());
    }

    /// A provider with no streaming of its own: `complete`'s answer.
    struct Whole;

    #[async_trait::async_trait]
    impl LlmProvider for Whole {
        async fn complete(&self, _b: &str, _k: Option<&str>, _r: &LlmRequest, _c: &reqwest::Client) -> AppResult<LlmResponse> {
            Ok(whole_answer())
        }
    }

    #[tokio::test]
    async fn a_provider_without_stream_answers_through_complete() {
        let mut events = Vec::new();
        let mut sink = |e: StreamEvent| events.push(e);
        let resp = Whole.stream("https://api.test", None, &super::sample_request(), &reqwest::Client::new(), &mut sink).await.unwrap();
        assert_same(&resp, &whole_answer());
        assert_eq!(events, vec![StreamEvent::Text("Reading the config first.".into())]);
    }
}

// ─── Streaming: OpenAI-compatible Chat Completions and Responses (A2) ───────────
// Fixture transcripts follow the documented streaming formats (chunk and
// event types and fields); their ids and text are made up.

mod openai_streaming {
    use super::super::openai_compat::{self, Api, OpenAICompatibleProvider};
    use super::super::{stream_with_retry, Completion, LlmProvider, LlmRequest, LlmResponse, LlmStopReason, StreamEvent};
    use super::streaming::{assert_same, chunks, sse, Chunks};
    use crate::error::{AppError, AppResult, ProviderErrorKind};
    use serde_json::{json, Value};
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;

    fn chunk(choices: Value) -> Value {
        json!({"id": "chatcmpl-fixture", "object": "chat.completion.chunk", "created": 1, "model": "gpt-test", "choices": choices, "usage": null})
    }
    fn delta(delta: Value) -> Value { chunk(json!([{"index": 0, "delta": delta, "finish_reason": null}])) }
    fn finished(reason: &str) -> Value { chunk(json!([{"index": 0, "delta": {}, "finish_reason": reason}])) }
    fn call(index: usize, id: &str, name: &str, arguments: &str) -> Value {
        json!({"index": index, "id": id, "type": "function", "function": {"name": name, "arguments": arguments}})
    }
    fn usage() -> Value {
        json!({"prompt_tokens": 1200, "completion_tokens": 64, "total_tokens": 1264, "prompt_tokens_details": {"cached_tokens": 900, "cache_write_tokens": 100}})
    }

    /// Text, then two tool calls: the first in pieces, the second whole in
    /// one piece (as some local servers send it), then the usage chunk.
    fn chat_events() -> Vec<Value> {
        let args = |partial: &str| delta(json!({"tool_calls": [{"index": 0, "function": {"arguments": partial}}]}));
        let mut last = chunk(json!([]));
        last["usage"] = usage();
        vec![
            delta(json!({"role": "assistant", "content": ""})),
            delta(json!({"content": "Reading the"})),
            delta(json!({"content": " config first."})),
            delta(json!({"tool_calls": [call(0, "call_fixture_a", "read_file", "")]})),
            args("{\"path\": \"src/con"),
            args("fig.toml\", \"limit\": 4"),
            args("0}"),
            delta(json!({"tool_calls": [call(1, "call_fixture_b", "list_dir", "{\"path\": \"src\"}")]})),
            finished("tool_calls"),
            last,
        ]
    }

    /// Chunks as the wire carries them, then `[DONE]` when `done`.
    fn chat_sse(events: &[Value], done: bool) -> String {
        let body: String = events.iter().map(|e| format!("data: {e}\n\n")).collect();
        if done { body + "data: [DONE]\n\n" } else { body }
    }

    /// The same answer as a request that doesn't stream returns it whole.
    fn chat_whole() -> Value {
        let calls = [
            call(0, "call_fixture_a", "read_file", "{\"path\": \"src/config.toml\", \"limit\": 40}"),
            call(1, "call_fixture_b", "list_dir", "{\"path\": \"src\"}"),
        ];
        json!({"id": "chatcmpl-fixture", "object": "chat.completion", "created": 1, "model": "gpt-test", "usage": usage(),
            "choices": [{"index": 0, "finish_reason": "tool_calls",
                "message": {"role": "assistant", "content": "Reading the config first.", "refusal": null, "tool_calls": calls}}]})
    }

    fn text(t: &str) -> StreamEvent { StreamEvent::Text(t.into()) }
    fn start(index: usize, id: &str, name: &str) -> StreamEvent { StreamEvent::ToolStart { index, id: id.into(), name: name.into() } }
    fn input(index: usize, partial: &str) -> StreamEvent { StreamEvent::ToolInput { index, partial: partial.into() } }

    /// What the sink sees for `chat_events`: every call ends with the choice.
    fn chat_stream() -> Vec<StreamEvent> {
        vec![
            text("Reading the"), text(" config first."),
            start(0, "call_fixture_a", "read_file"), input(0, "{\"path\": \"src/con"), input(0, "fig.toml\", \"limit\": 4"), input(0, "0}"),
            start(1, "call_fixture_b", "list_dir"), input(1, "{\"path\": \"src\"}"),
            StreamEvent::ToolEnd { index: 0 }, StreamEvent::ToolEnd { index: 1 },
        ]
    }

    const MODEL: &str = "gpt-6-sol";
    const BASE: &str = "https://api.openai.com/v1";

    fn responses_api() -> Api<'static> {
        Api::Responses { model: MODEL, provider: "openai", api_base: BASE }
    }
    /// Reasoning (encrypted, so it is kept for replay), the message, the call.
    fn items() -> [Value; 3] {
        [
            json!({"id": "rs_fixture", "type": "reasoning", "summary": [], "encrypted_content": "ZW5jcnlwdGVkLWZpeHR1cmU="}),
            json!({"id": "msg_fixture", "type": "message", "status": "completed", "role": "assistant",
                "content": [{"type": "output_text", "text": "Reading the config first.", "annotations": []}]}),
            json!({"id": "fc_fixture", "type": "function_call", "status": "completed", "call_id": "call_fixture", "name": "read_file",
                "arguments": "{\"path\": \"src/config.toml\"}"}),
        ]
    }
    fn final_response(output: &[Value]) -> Value {
        json!({"id": "resp_fixture", "object": "response", "status": "completed", "model": MODEL, "output": output,
            "usage": {"input_tokens": 1500, "input_tokens_details": {"cached_tokens": 1024}, "output_tokens": 80, "total_tokens": 1580}})
    }
    fn responses_whole() -> LlmResponse {
        openai_compat::parse_responses_response(final_response(&items()), MODEL, "openai", BASE)
    }

    /// Reasoning, text, then a function call whose arguments arrive in pieces.
    fn responses_events() -> Vec<Value> {
        let ev = |kind: &str, mut fields: Value| {
            fields["type"] = json!(kind);
            fields
        };
        let [reasoning, message, function_call] = items();
        let text_delta = |d: &str| ev("response.output_text.delta", json!({"item_id": "msg_fixture", "output_index": 1, "content_index": 0, "delta": d}));
        let args = |d: &str| ev("response.function_call_arguments.delta", json!({"item_id": "fc_fixture", "output_index": 2, "delta": d}));
        vec![
            ev("response.created", json!({"response": {"id": "resp_fixture", "status": "in_progress", "output": []}})),
            ev("response.output_item.added", json!({"output_index": 0, "item": {"id": "rs_fixture", "type": "reasoning", "summary": []}})),
            ev("response.output_item.done", json!({"output_index": 0, "item": reasoning})),
            ev("response.output_item.added", json!({"output_index": 1, "item": {"id": "msg_fixture", "type": "message", "role": "assistant", "content": []}})),
            text_delta("Reading the"),
            text_delta(" config first."),
            ev("response.output_text.done", json!({"item_id": "msg_fixture", "output_index": 1, "content_index": 0, "text": "Reading the config first."})),
            ev("response.output_item.done", json!({"output_index": 1, "item": message})),
            ev("response.output_item.added", json!({"output_index": 2, "item": {"id": "fc_fixture", "type": "function_call",
                "call_id": "call_fixture", "name": "read_file", "arguments": ""}})),
            args("{\"path\": \"src/con"),
            args("fig.toml\"}"),
            ev("response.output_item.done", json!({"output_index": 2, "item": function_call})),
            ev("response.completed", json!({"response": final_response(&items())})),
        ]
    }

    async fn read(api: &Api<'_>, source: Chunks) -> (AppResult<LlmResponse>, Vec<StreamEvent>) {
        let mut events = Vec::new();
        let mut sink = |e: StreamEvent| events.push(e);
        let out = openai_compat::read_stream(source, false, Some(Duration::from_secs(5)), api, &mut sink).await;
        (out, events)
    }

    async fn failure(api: &Api<'_>, body: &str) -> AppError {
        read(api, chunks(body, 4096)).await.0.expect_err("the stream fails")
    }

    fn kind_of(e: &AppError) -> Option<ProviderErrorKind> {
        if let AppError::Provider { kind, .. } = e { Some(*kind) } else { None }
    }

    #[tokio::test]
    async fn openai_sse_chat_text_tool_usage() {
        let (out, events) = read(&Api::Chat, chunks(&chat_sse(&chat_events(), true), 4096)).await;
        let resp = out.unwrap();
        assert_eq!(resp.text, "Reading the config first.");
        let calls: Vec<_> = resp.tool_uses.iter().map(|u| (u.id.as_str(), u.name.as_str(), u.input.clone())).collect();
        assert_eq!(calls, [
            ("call_fixture_a", "read_file", json!({"path": "src/config.toml", "limit": 40})),
            ("call_fixture_b", "list_dir", json!({"path": "src"})),
        ]);
        assert_eq!(resp.stop_reason, LlmStopReason::ToolUse);
        // From the usage chunk: the prompt count less its cached and written slices.
        assert_eq!((resp.input_tokens, resp.cache_read_tokens, resp.cache_creation_tokens, resp.output_tokens), (200, 900, 100, 64));
        assert!(!resp.usage_unreported);
        assert_eq!(events, chat_stream());
    }

    #[tokio::test]
    async fn openai_sse_parallel_calls_without_index() {
        // Two parallel calls in one chunk, neither with an `index`: each is the
        // call at its place in the array, never both call 0.
        let bare = |id: &str, path: &str| json!({"id": id, "type": "function", "function": {"name": "read_file", "arguments": format!("{{\"path\": \"{path}\"}}")}});
        let events = [delta(json!({"tool_calls": [bare("call_a", "a"), bare("call_b", "b")]})), finished("tool_calls")];
        let (out, events) = read(&Api::Chat, chunks(&chat_sse(&events, true), 4096)).await;
        let calls: Vec<_> = out.unwrap().tool_uses.iter().map(|u| (u.id.clone(), u.input.clone())).collect();
        assert_eq!(calls, [("call_a".to_string(), json!({"path": "a"})), ("call_b".to_string(), json!({"path": "b"}))]);
        let (a, b) = ("{\"path\": \"a\"}", "{\"path\": \"b\"}");
        let ends = [StreamEvent::ToolEnd { index: 0 }, StreamEvent::ToolEnd { index: 1 }];
        assert_eq!(events, [vec![start(0, "call_a", "read_file"), input(0, a), start(1, "call_b", "read_file"), input(1, b)], ends.to_vec()].concat());
    }

    #[tokio::test]
    async fn openai_sse_missing_usage_is_unreported_not_free() {
        // Finished, but without the usage chunk (a server that ignores
        // `include_usage`): the cost is unknown, never $0.
        let (out, _) = read(&Api::Chat, chunks(&chat_sse(&chat_events()[..9], true), 4096)).await;
        let resp = out.unwrap();
        assert_eq!((resp.usage_unreported, resp.input_tokens, resp.output_tokens), (true, 0, 0));
        assert_eq!(resp.tool_uses.len(), 2, "the answer itself is whole");
        // A Responses answer whose final response carries no usage, likewise.
        let mut events = responses_events();
        let last = events.len() - 1;
        events[last]["response"].as_object_mut().unwrap().remove("usage");
        assert!(read(&responses_api(), chunks(&sse(&events), 4096)).await.0.unwrap().usage_unreported);
        assert!(!read(&responses_api(), chunks(&sse(&responses_events()), 4096)).await.0.unwrap().usage_unreported);
    }

    #[tokio::test]
    async fn openai_sse_silence_is_final_after_its_adapter_bound() {
        // OpenAI-compatible servers promise no keep-alive: ten minutes, where
        // Anthropic (which pings) keeps one. A server on this Mac has none.
        use super::super::{anthropic, stream_idle};
        assert_eq!(stream_idle("https://api.openai.com/v1", openai_compat::STREAM_IDLE), Some(Duration::from_secs(600)));
        assert_eq!(stream_idle("https://api.anthropic.com", anthropic::STREAM_IDLE), Some(Duration::from_secs(60)));
        assert_eq!(stream_idle("http://127.0.0.1:11434/v1", openai_compat::STREAM_IDLE), None);
        // Silent past the bound: final, never retried (#1181's rule).
        let silent = Chunks(vec![Some(chat_sse(&chat_events()[..2], false).into_bytes()), None].into());
        let mut sink = |_e: StreamEvent| {};
        let idle = Some(Duration::from_millis(150));
        let err = openai_compat::read_stream(silent, false, idle, &Api::Chat, &mut sink).await.expect_err("a silent stream fails");
        assert!(err.transient_retry().is_none(), "{err}");
        assert!(err.to_string().contains("the stream sent nothing for 150ms"), "{err}");
    }

    #[tokio::test]
    async fn openai_sse_chat_equals_complete_response() {
        // One byte at a time, with CRLF line ends, after a comment and an empty keep-alive event.
        let body = format!(": keep-alive\n\ndata:\n\n{}", chat_sse(&chat_events(), true)).replace('\n', "\r\n");
        assert_same(&read(&Api::Chat, chunks(&body, 1)).await.0.unwrap(), &openai_compat::parse_response(chat_whole()));

        // A refusal after some text is set apart as `complete` sets it, and
        // the streamed text adds up to the answer's.
        let refusal = [
            delta(json!({"role": "assistant", "content": "I can read the config."})),
            delta(json!({"refusal": "I can't share"})),
            delta(json!({"refusal": " that key."})),
            finished("stop"),
            chat_events().pop().unwrap(),
        ];
        let whole = json!({"usage": usage(), "choices": [{"index": 0, "finish_reason": "stop",
            "message": {"role": "assistant", "content": "I can read the config.", "refusal": "I can't share that key."}}]});
        let (out, events) = read(&Api::Chat, chunks(&chat_sse(&refusal, true), 16)).await;
        let resp = out.unwrap();
        assert_same(&resp, &openai_compat::parse_response(whole));
        assert_eq!(resp.stop_reason, LlmStopReason::Other("refusal".into()));
        let streamed: String = events.iter().map(|e| if let StreamEvent::Text(t) = e { t.as_str() } else { "" }).collect();
        assert_eq!(streamed, resp.text);
    }

    #[tokio::test]
    async fn openai_sse_responses_equals_complete_response() {
        let api = responses_api();
        let (out, events) = read(&api, chunks(&sse(&responses_events()), 29)).await;
        let resp = out.unwrap();
        assert_same(&resp, &responses_whole());
        // The encrypted reasoning is kept for replay, behind its origin item.
        assert!(openai_compat::is_responses_raw(&resp.raw_content) && resp.raw_content.len() == 4);
        assert_eq!((resp.input_tokens, resp.cache_read_tokens, resp.output_tokens), (476, 1024, 80));
        assert_eq!(resp.stop_reason, LlmStopReason::ToolUse);
        let call = [start(2, "call_fixture", "read_file"), input(2, "{\"path\": \"src/con"), input(2, "fig.toml\"}"), StreamEvent::ToolEnd { index: 2 }];
        assert_eq!(events, [vec![text("Reading the"), text(" config first.")], call.to_vec()].concat());

        // A final response that leaves its output out gets the items as they closed.
        let mut events = responses_events();
        let last = events.len() - 1;
        events[last] = json!({"type": "response.completed", "response": final_response(&[])});
        assert_same(&read(&api, chunks(&sse(&events), 4096)).await.0.unwrap(), &responses_whole());

        // Cut at the output cap: `response.incomplete` stops as max tokens.
        events[last] = json!({"type": "response.incomplete", "response": {"status": "incomplete",
            "incomplete_details": {"reason": "max_output_tokens"}, "output": &items()[..2]}});
        let resp = read(&api, chunks(&sse(&events), 4096)).await.0.unwrap();
        assert_eq!((resp.stop_reason, resp.tool_uses.len()), (LlmStopReason::MaxTokens, 0));
    }

    /// Streams scripted bodies through the real Chat Completions reader.
    struct Scripted(Mutex<VecDeque<Chunks>>, AtomicU32);

    #[async_trait::async_trait]
    impl LlmProvider for Scripted {
        async fn complete(&self, _b: &str, _k: Option<&str>, _r: &LlmRequest, _c: &reqwest::Client) -> AppResult<LlmResponse> {
            unreachable!("only streamed here")
        }

        async fn stream(
            &self,
            _b: &str,
            _k: Option<&str>,
            _r: &LlmRequest,
            _c: &reqwest::Client,
            sink: &mut (dyn FnMut(StreamEvent) + Send),
        ) -> AppResult<LlmResponse> {
            self.1.fetch_add(1, Ordering::SeqCst);
            let body = self.0.lock().unwrap().pop_front().expect("ran out of bodies");
            openai_compat::read_stream(body, false, None, &Api::Chat, sink).await.map_err(|e| match e {
                // No backoff wait in a test.
                AppError::Provider { kind, message, .. } => AppError::Provider { kind, retry_after: Some(0), message },
                other => other,
            })
        }
    }

    #[tokio::test]
    async fn openai_sse_mid_stream_error_resets_and_retries() {
        let error = json!({"message": "The server had an error.", "type": "server_error", "param": null, "code": null});
        let failed = chat_sse(&[delta(json!({"content": "Half an ans"})), json!({"error": error})], false);
        let bodies = [chunks(&failed, 4096), chunks(&chat_sse(&chat_events(), true), 4096)];
        let p = Scripted(Mutex::new(bodies.into()), AtomicU32::new(0));
        let (req, client, cancel) = (super::sample_request(), reqwest::Client::new(), AtomicBool::new(false));
        let mut retries = Vec::new();
        let mut on_retry = |a: u32, d: u64, k: ProviderErrorKind| retries.push((a, d, k));
        let mut events = Vec::new();
        let mut sink = |e: StreamEvent| events.push(e);
        let out = stream_with_retry(&p, "https://api.test", Some("key"), &req, &client, &cancel, 5, &mut on_retry, &mut sink).await;
        let resp = match out { Completion::Done(resp) => resp, other => panic!("expected an answer, got {other:?}") };
        assert_same(&resp, &openai_compat::parse_response(chat_whole()));
        assert_eq!((p.1.load(Ordering::SeqCst), retries), (2, vec![(1, 0, ProviderErrorKind::ServerError)]));
        // The half answer, dropped by `Reset`, then the whole one.
        assert_eq!(events, [vec![text("Half an ans"), StreamEvent::Reset], chat_stream()].concat());

        // Each failure a stream reports is classified like its status: the
        // transient ones retry, the rest are final.
        let chat = |error: Value| chat_sse(&[delta(json!({"content": "Half"})), json!({"error": error})], false);
        let gateway = failure(&Api::Chat, &chat(json!({"code": 502, "message": "Upstream error"}))).await;
        assert_eq!(kind_of(&gateway), Some(ProviderErrorKind::ServerError));
        let unknown = failure(&Api::Chat, &chat(json!({"code": "something_new", "message": "?"}))).await;
        assert!(unknown.transient_retry().is_none(), "{unknown}");
        let mut limited = responses_events()[..6].to_vec();
        limited.push(json!({"type": "response.failed", "response": {"status": "failed", "error": {"code": "rate_limit_exceeded", "message": "Slow down."}}}));
        assert_eq!(kind_of(&failure(&responses_api(), &sse(&limited)).await), Some(ProviderErrorKind::RateLimit));
        let rejected = failure(&responses_api(), &sse(&[json!({"type": "error", "code": "invalid_prompt", "message": "Rejected."})])).await;
        assert_eq!(kind_of(&rejected), Some(ProviderErrorKind::BadRequest));
        assert!(rejected.to_string().contains("OpenAI-compat API error in the stream"), "{rejected}");
    }

    #[tokio::test]
    async fn openai_sse_cut_off_is_final() {
        // A Chat Completions body that ends before its choice finished, and a
        // Responses body without its final event.
        let events = responses_events();
        for (api, body) in [(Api::Chat, chat_sse(&chat_events()[..6], false)), (responses_api(), sse(&events[..events.len() - 1]))] {
            let cut = failure(&api, &body).await;
            assert!(cut.transient_retry().is_none(), "{cut}");
            assert!(cut.to_string().contains("the stream ended before the answer was complete"), "{cut}");
        }
        // One that finished and only left out `[DONE]` has answered in full.
        let (out, _) = read(&Api::Chat, chunks(&chat_sse(&chat_events(), false), 4096)).await;
        assert_same(&out.unwrap(), &openai_compat::parse_response(chat_whole()));
    }

    type Reply = (&'static str, &'static str, String);

    fn ok(content_type: &'static str, body: String) -> Reply {
        ("200 OK", content_type, body)
    }

    /// A local server that answers one request per reply, in order (status,
    /// content type, body), then hands back the requests it read.
    async fn serve(replies: Vec<Reply>) -> (std::net::SocketAddr, tokio::sync::oneshot::Receiver<Vec<String>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let mut requests = Vec::new();
            for (status, content_type, body) in replies {
                let (mut sock, _) = listener.accept().await.unwrap();
                let (mut seen, mut buf) = (Vec::new(), [0u8; 8192]);
                while !whole_request(&seen) {
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => seen.extend_from_slice(&buf[..n]),
                    }
                }
                let head = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = sock.write_all(format!("{head}{body}").as_bytes()).await;
                let _ = sock.shutdown().await;
                requests.push(String::from_utf8_lossy(&seen).into_owned());
            }
            let _ = tx.send(requests);
        });
        (addr, rx)
    }

    /// Whether `seen` holds a request's head and as much body as it announced.
    fn whole_request(seen: &[u8]) -> bool {
        let text = String::from_utf8_lossy(seen);
        let Some((head, body)) = text.split_once("\r\n\r\n") else { return false };
        let length = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)));
        body.len() >= length.unwrap_or(0)
    }

    fn request_json(seen: &str) -> Value {
        serde_json::from_str(seen.split_once("\r\n\r\n").expect("a request").1).expect("a JSON body")
    }

    #[tokio::test]
    async fn openai_sse_request_streams_and_asks_for_usage() {
        // Chat Completions, here on a model server on this Mac.
        let (addr, seen) = serve(vec![ok("text/event-stream", chat_sse(&chat_events(), true))]).await;
        let mut events = Vec::new();
        let mut sink = |e: StreamEvent| events.push(e);
        let provider = OpenAICompatibleProvider { provider: "custom".into() };
        let base = format!("http://127.0.0.1:{}/v1", addr.port());
        let resp = provider.stream(&base, None, &super::sample_request(), &reqwest::Client::new(), &mut sink).await.unwrap();
        assert_same(&resp, &openai_compat::parse_response(chat_whole()));
        assert_eq!(events, chat_stream());
        let seen = seen.await.unwrap().remove(0);
        assert!(seen.starts_with("POST /v1/chat/completions "), "{seen}");
        let body = request_json(&seen);
        assert_eq!((&body["stream"], &body["stream_options"]), (&json!(true), &json!({"include_usage": true})));

        // GPT-6 on OpenAI's own host goes to Responses, which reports usage unasked.
        let (addr, seen) = serve(vec![ok("text/event-stream; charset=utf-8", sse(&responses_events()))]).await;
        let client = reqwest::Client::builder().no_proxy().resolve("api.openai.com", addr).build().unwrap();
        let mut req = super::sample_request();
        req.model = MODEL.into();
        let base = format!("http://api.openai.com:{}/v1", addr.port());
        let mut sink = |_e: StreamEvent| {};
        let provider = OpenAICompatibleProvider { provider: "openai".into() };
        let resp = provider.stream(&base, Some("key"), &req, &client, &mut sink).await.unwrap();
        assert_eq!((resp.text.as_str(), resp.tool_uses.len()), ("Reading the config first.", 1));
        let seen = seen.await.unwrap().remove(0);
        assert!(seen.starts_with("POST /v1/responses "), "{seen}");
        assert!(seen.to_ascii_lowercase().contains("authorization: bearer key"), "{seen}");
        let body = request_json(&seen);
        assert_eq!(body["stream"], json!(true));
        assert!(body.get("stream_options").is_none(), "{body}");
    }

    #[tokio::test]
    async fn anthropic_requests_send_no_beta_header() {
        // The 128k-output beta served only Claude 3.7 Sonnet; no catalog model needs it.
        let body = json!({"content": [{"type": "text", "text": "hi"}], "stop_reason": "end_turn",
            "usage": {"input_tokens": 1, "output_tokens": 1}}).to_string();
        let (addr, seen) = serve(vec![ok("application/json", body)]).await;
        let base = format!("http://127.0.0.1:{}", addr.port());
        let provider = super::super::anthropic::AnthropicProvider;
        let resp = provider.complete(&base, Some("key"), &super::sample_request(), &reqwest::Client::new()).await.unwrap();
        assert_eq!(resp.text, "hi");
        let seen = seen.await.unwrap().remove(0).to_ascii_lowercase();
        assert!(seen.starts_with("post /v1/messages "), "{seen}");
        assert!(seen.contains("anthropic-version: 2023-06-01"), "{seen}");
        assert!(!seen.contains("anthropic-beta"), "{seen}");
    }

    #[tokio::test]
    async fn openai_sse_refused_stream_options_is_asked_once_without() {
        let refusal = json!({"error": {"message": "Unrecognized request argument supplied: stream_options",
            "type": "invalid_request_error", "param": "stream_options", "code": null}});
        let replies = vec![("400 Bad Request", "application/json", refusal.to_string()), ok("text/event-stream", chat_sse(&chat_events()[..9], true))];
        let (addr, seen) = serve(replies).await;
        let (provider, client) = (OpenAICompatibleProvider { provider: "custom".into() }, reqwest::Client::new());
        let mut sink = |_e: StreamEvent| {};
        let base = format!("http://127.0.0.1:{}/v1", addr.port());
        let resp = provider.stream(&base, None, &super::sample_request(), &client, &mut sink).await.unwrap();
        // Asked again without the field, the answer has no usage: unreported, never $0.
        assert_eq!((resp.text.as_str(), resp.usage_unreported), ("Reading the config first.", true));
        let asked: Vec<bool> = seen.await.unwrap().iter().map(|r| request_json(r).get("stream_options").is_some()).collect();
        assert_eq!(asked, [true, false]);

        // Any other 400 is never sent twice.
        let invalid = json!({"error": {"message": "Invalid model.", "type": "invalid_request_error", "param": "model"}});
        let (addr, seen) = serve(vec![("400 Bad Request", "application/json", invalid.to_string())]).await;
        let base = format!("http://127.0.0.1:{}/v1", addr.port());
        let err = provider.stream(&base, None, &super::sample_request(), &client, &mut sink).await.expect_err("a bad request");
        assert_eq!((kind_of(&err), seen.await.unwrap().len()), (Some(ProviderErrorKind::BadRequest), 1));
    }

    #[tokio::test]
    async fn provider_without_stream_falls_back() {
        // A server that ignores `stream` and answers with the whole body.
        let (addr, seen) = serve(vec![ok("application/json", chat_whole().to_string())]).await;
        let mut events = Vec::new();
        let mut sink = |e: StreamEvent| events.push(e);
        let provider = OpenAICompatibleProvider { provider: "custom".into() };
        let base = format!("http://127.0.0.1:{}/v1", addr.port());
        let resp = provider.stream(&base, None, &super::sample_request(), &reqwest::Client::new(), &mut sink).await.unwrap();
        assert_same(&resp, &openai_compat::parse_response(chat_whole()));
        assert_eq!(events, [text("Reading the config first.")]);
        assert_eq!(request_json(&seen.await.unwrap()[0])["stream"], json!(true));

        // The same for a whole Responses body.
        let mut events = Vec::new();
        let mut sink = |e: StreamEvent| events.push(e);
        let body = final_response(&items()).to_string();
        let resp = openai_compat::read_stream(chunks(&body, 64), true, None, &responses_api(), &mut sink).await.unwrap();
        assert_same(&resp, &responses_whole());
        assert_eq!(events, [text("Reading the config first.")]);
    }
}
