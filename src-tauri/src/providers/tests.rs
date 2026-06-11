//! Unit tests for provider request builders and response parsers.
//! These are pure functions — no HTTP, no async, fast.

use super::{
    LlmContent, LlmMessage, LlmRequest, LlmRole, LlmStopReason,
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
