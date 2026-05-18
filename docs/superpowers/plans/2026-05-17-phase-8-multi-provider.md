# Phase 8 — Multi-Provider LLM Support

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make Octopus actually multi-provider as its UI implies. Today the AgentBar shows "GPT-4o" and "Haiku" buttons but `chat_engine.rs` is hardcoded to Anthropic — selecting GPT-4o sends a request to `api.anthropic.com` with `model: "gpt-4o"`, which 404s. After this phase, users can pick Anthropic (Claude), OpenAI (GPT-4o), DeepSeek (cheap), Ollama (free/local), or any self-hosted model that speaks the OpenAI Chat Completions protocol, and Octopus dispatches each request to the correct backend.

**Architecture:** Introduce an `LlmProvider` trait in Rust with a single async method `complete(req) -> response`. Provide two implementations: `AnthropicProvider` (extracted from the existing code) and `OpenAICompatibleProvider` (one implementation that handles OpenAI, DeepSeek, Ollama, and any self-hosted server speaking the OpenAI Chat Completions API). `provider_router.rs` gets a `protocol` field per provider so `chat_engine.rs` can pick the right implementation at runtime. Settings goes from hardcoded `anthropicApiKey`/`openaiApiKey` fields to a generic `providerKeys: Record<provider_name, key>` map (with backward-compat migration).

**Tech stack:** Rust (`async_trait` already implicitly available via the existing tokio/reqwest setup, but if we need it as a direct dep we'll add it), reqwest for HTTP, serde for JSON, existing Zustand stores on the frontend.

---

## File structure

**Created**

| Path | Responsibility |
|------|----------------|
| `src-tauri/src/providers/mod.rs` | Public module exports + the `LlmProvider` trait + normalized request/response types. |
| `src-tauri/src/providers/anthropic.rs` | `AnthropicProvider`: extracted Anthropic-specific request/response handling. |
| `src-tauri/src/providers/openai_compat.rs` | `OpenAICompatibleProvider`: handles OpenAI, DeepSeek, Ollama, and any OpenAI-compatible self-hosted server. |
| `src-tauri/src/providers/tests.rs` | Pure-function unit tests for request building + response parsing per provider. |

**Modified**

| Path | Why |
|------|-----|
| `src-tauri/src/lib.rs` | Register the new `providers` module. |
| `src-tauri/src/settings.rs` | Replace `anthropicApiKey/openaiApiKey` fields with `providerKeys: HashMap<String, String>` + `providerBaseUrls: HashMap<String, String>` (for Ollama / self-hosted). Migration: if old fields present in legacy settings.json, fold into new map on read. |
| `src-tauri/src/provider_router.rs` | Add `protocol: "anthropic" \| "openai-compatible"` and `local: bool` to `ProviderConfig`. Add DeepSeek to builtins. Ensure Ollama has the right `api_base` and `protocol`. |
| `src-tauri/src/chat_engine.rs` | Remove hardcoded Anthropic logic. Build normalized `LlmRequest`. Call `provider_router.find_model()` → dispatch via trait. The agentic loop becomes provider-agnostic. |
| `src-tauri/src/commands.rs` | Add `get_settings`/`save_settings` to use the new shape. Optionally add a new command to test a provider key. |
| `src/lib/types.ts` | `AppSettings` updates: `providerKeys: Record<string, string>` + `providerBaseUrls: Record<string, string>`. |
| `src/lib/ipc.ts` | Match new settings shape. |
| `src/components/AgentBar.tsx` | Load real models from `ipc.listModels()` dynamically. Group by provider. Replace the 4 hardcoded buttons. |
| `src/components/Settings.tsx` | The `ModelsPane` lists ALL providers (Anthropic, OpenAI, DeepSeek, Ollama, plus a "custom OpenAI-compatible" placeholder). Per-provider: API key input (when applicable) + optional base URL input (for Ollama / custom). |

**Not touched in Phase 8**

- `agent_adapter.rs` (separate abstraction for CLI agents — not the chat-API path).
- Token cost computation (`token_engine.rs`) — works off the model id which still maps to a `ModelInfo` with cost fields.

---

## Architecture: the `LlmProvider` trait

Normalized types (provider-neutral):

```rust
// src-tauri/src/providers/mod.rs

use crate::error::AppResult;
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct LlmRequest {
    pub model: String,
    pub max_tokens: u32,
    pub system: String,
    pub messages: Vec<LlmMessage>,
    pub tools: Vec<LlmTool>,
}

#[derive(Serialize, Clone, Debug)]
pub struct LlmMessage {
    pub role: LlmRole,
    pub content: LlmContent,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub enum LlmRole {
    User,
    Assistant,
}

#[derive(Serialize, Clone, Debug)]
pub enum LlmContent {
    /// Plain text (most common — user prompts, simple assistant replies).
    Text(String),
    /// Assistant turn that called one or more tools.
    /// Also carries any text the assistant emitted alongside the tool calls.
    AssistantWithTools {
        text: String,
        tool_uses: Vec<LlmToolUse>,
    },
    /// User-role turn carrying the results of previously-called tools.
    ToolResults(Vec<LlmToolResult>),
}

#[derive(Serialize, Clone, Debug)]
pub struct LlmToolUse {
    /// Provider-assigned id used to correlate tool_result back to tool_use.
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

#[derive(Serialize, Clone, Debug)]
pub struct LlmToolResult {
    pub tool_use_id: String,
    pub content: String,
    pub is_error: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct LlmTool {
    pub name: String,
    pub description: String,
    /// JSON schema for the tool input.
    pub input_schema: serde_json::Value,
}

#[derive(Debug)]
pub struct LlmResponse {
    pub text: String,
    pub tool_uses: Vec<LlmToolUse>,
    pub stop_reason: LlmStopReason,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, PartialEq, Clone)]
pub enum LlmStopReason {
    EndTurn,
    ToolUse,
    MaxTokens,
    Other(String),
}

#[async_trait::async_trait]
pub trait LlmProvider: Send + Sync {
    async fn complete(
        &self,
        api_base: &str,
        api_key: Option<&str>,
        req: &LlmRequest,
        client: &reqwest::Client,
    ) -> AppResult<LlmResponse>;
}

pub mod anthropic;
pub mod openai_compat;

#[cfg(test)]
mod tests;
```

Note on `async_trait`: it's a tiny crate that lets us declare `async fn` in trait methods. If it's not already in `Cargo.toml`, add it as a dependency (`async_trait = "0.1"`).

---

## Tasks

### Task 1: Settings refactor (Rust + frontend)

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/commands.rs` (if get_settings/save_settings live there)
- Modify: `src/lib/types.ts`
- Modify: `src/lib/ipc.ts`

**Goal:** From hardcoded API key fields to a generic `providerKeys` map, with auto-migration of any legacy settings file.

- [ ] **Step 1: Read the current `src-tauri/src/settings.rs`**

Find: the `AppSettings` struct (with `anthropic_api_key` + `openai_api_key`), the load/save functions, and `get_anthropic_key()` / `get_openai_key()` helpers used by `chat_engine.rs`.

- [ ] **Step 2: Update `AppSettings` struct**

Replace the hardcoded fields with a generic map. New shape:

```rust
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// API keys keyed by provider name (e.g. "anthropic", "openai", "deepseek").
    /// Empty/missing entry = not configured.
    #[serde(default)]
    pub provider_keys: HashMap<String, String>,
    /// Optional base URL overrides per provider (Ollama: "http://localhost:11434/v1";
    /// self-hosted: user-supplied). Empty = use the provider's default api_base.
    #[serde(default)]
    pub provider_base_urls: HashMap<String, String>,

    // ─── Legacy fields, kept for one-time migration on read ───
    #[serde(default, rename = "anthropicApiKey", skip_serializing)]
    pub legacy_anthropic_api_key: Option<String>,
    #[serde(default, rename = "openaiApiKey", skip_serializing)]
    pub legacy_openai_api_key: Option<String>,
}
```

Notes:
- `skip_serializing` means new writes never include the legacy fields — the migration is one-way.
- On load: if `legacy_anthropic_api_key` or `legacy_openai_api_key` are present, fold them into `provider_keys` and let the next save persist the new shape.

Update `load_settings()` to perform migration:

```rust
pub fn load_settings() -> AppResult<AppSettings> {
    let path = settings_path();
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let content = std::fs::read_to_string(&path)?;
    let mut settings: AppSettings = serde_json::from_str(&content).unwrap_or_default();

    // Migrate legacy single-provider fields.
    if let Some(k) = settings.legacy_anthropic_api_key.take() {
        if !k.is_empty() && !settings.provider_keys.contains_key("anthropic") {
            settings.provider_keys.insert("anthropic".to_string(), k);
        }
    }
    if let Some(k) = settings.legacy_openai_api_key.take() {
        if !k.is_empty() && !settings.provider_keys.contains_key("openai") {
            settings.provider_keys.insert("openai".to_string(), k);
        }
    }

    Ok(settings)
}
```

Add a generic helper to replace `get_anthropic_key`/`get_openai_key`:

```rust
/// Look up an API key for the given provider name.
/// Returns None if not configured.
pub fn get_provider_key(provider: &str) -> Option<String> {
    load_settings().ok()
        .and_then(|s| s.provider_keys.get(provider).cloned())
        .filter(|k| !k.is_empty())
}

/// Look up a base URL override for the given provider name.
/// Returns None if not overridden — caller should use the provider's default.
pub fn get_provider_base_url(provider: &str) -> Option<String> {
    load_settings().ok()
        .and_then(|s| s.provider_base_urls.get(provider).cloned())
        .filter(|u| !u.is_empty())
}
```

Keep the old `get_anthropic_key()` as a thin alias for backward compatibility for now (or delete it once `chat_engine.rs` is refactored in Task 5):

```rust
#[deprecated(note = "Use get_provider_key(\"anthropic\") instead")]
pub fn get_anthropic_key() -> Option<String> {
    get_provider_key("anthropic")
}
```

- [ ] **Step 3: Update Tauri commands `get_settings` / `save_settings`**

Their return types now reflect the new shape (TypeScript will pick it up via the same serde `rename_all = "camelCase"`).

- [ ] **Step 4: Update `src/lib/types.ts`**

```typescript
export interface AppSettings {
  /** Per-provider API keys. Keyed by provider name. */
  providerKeys: Record<string, string>;
  /** Per-provider base URL overrides (for Ollama / self-hosted endpoints). */
  providerBaseUrls: Record<string, string>;
}
```

- [ ] **Step 5: Update `src/lib/ipc.ts`**

```typescript
getSettings: () => invoke<AppSettings>("get_settings"),
saveSettings: (settings: AppSettings) =>
  invoke<void>("save_settings", { settings }),
```

(Probably already correct; just verify the type alignment.)

- [ ] **Step 6: Typecheck + tests**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm run typecheck
cd src-tauri && cargo test
```

Expected: Rust tests still pass; TS typecheck temporarily warns that `Settings.tsx`'s `ModelsPane` uses `anthropicApiKey` / `openaiApiKey` (legacy field names). That will be fixed in Task 7. For now, fix only what's needed to compile — the legacy compatibility layer in `settings.rs` does the heavy lifting.

If TypeScript fails, add the legacy field aliases:

```typescript
export interface AppSettings {
  providerKeys: Record<string, string>;
  providerBaseUrls: Record<string, string>;
  /** @deprecated use providerKeys.anthropic */
  anthropicApiKey?: string | null;
  /** @deprecated use providerKeys.openai */
  openaiApiKey?: string | null;
}
```

This keeps `Settings.tsx`'s current code compiling until Task 7 refactors it.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(settings): generic providerKeys/providerBaseUrls map with legacy migration"
```

---

### Task 2: Extend ProviderConfig + register DeepSeek and Ollama

**Files:**
- Modify: `src-tauri/src/provider_router.rs`

- [ ] **Step 1: Add fields to `ProviderConfig`**

Insert after the existing fields:

```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub name: String,
    pub api_base: String,
    pub api_key_env: String,
    pub models: Vec<ModelInfo>,
    #[serde(default)]
    pub rate_limits: RateLimits,
    #[serde(default)]
    pub enabled: bool,

    /// Wire protocol the provider speaks: "anthropic" or "openai-compatible".
    /// "openai-compatible" covers OpenAI, DeepSeek, Ollama, and any
    /// self-hosted server (vllm, llama.cpp server, LMStudio, etc.) that
    /// implements the OpenAI Chat Completions API.
    #[serde(default = "default_protocol")]
    pub protocol: String,

    /// True for providers running on this machine (Ollama, self-hosted).
    /// Affects the UI: no API key field, base URL is editable.
    #[serde(default)]
    pub local: bool,
}

fn default_protocol() -> String {
    "anthropic".into()
}
```

The `default_protocol` returning `"anthropic"` is intentional: any existing `providers.json` from before this change will be read as if every provider were Anthropic-compatible. Since the only existing providers are Anthropic and OpenAI, the OpenAI entry needs its protocol explicitly set in the migration path (Step 3).

- [ ] **Step 2: Migrate existing providers.json files on load**

In `ProviderRouter::load`, after parsing the file, ensure protocols and known fields are set:

```rust
pub fn load() -> AppResult<Self> {
    let path = config_path();
    let providers = if path.exists() {
        let content = std::fs::read_to_string(&path)?;
        let mut list: Vec<ProviderConfig> = serde_json::from_str(&content)?;

        // Migration: fix known protocols for previously-stored providers.
        for p in &mut list {
            if p.protocol.is_empty() || p.protocol == "anthropic" {
                match p.name.as_str() {
                    "openai" | "deepseek" => p.protocol = "openai-compatible".into(),
                    "ollama" => {
                        p.protocol = "openai-compatible".into();
                        p.local = true;
                    }
                    _ => {} // anthropic stays anthropic, custom stays as configured
                }
            }
        }

        // If file is missing newer builtins (DeepSeek, Ollama), splice them in.
        let defaults = builtin_providers();
        for (name, def) in &defaults {
            if !list.iter().any(|p| p.name == *name) {
                list.push(def.clone());
            }
        }

        // Persist migrated form.
        let snapshot: Vec<&ProviderConfig> = list.iter().collect();
        let _ = std::fs::write(&path, serde_json::to_string_pretty(&snapshot)?);

        list.into_iter().map(|p| (p.name.clone(), p)).collect()
    } else {
        let defaults = builtin_providers();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let list: Vec<&ProviderConfig> = defaults.values().collect();
        let _ = std::fs::write(&path, serde_json::to_string_pretty(&list)?);
        defaults
    };
    Ok(Self { providers })
}
```

- [ ] **Step 3: Update `builtin_providers()` to include DeepSeek + Ollama**

```rust
fn builtin_providers() -> HashMap<String, ProviderConfig> {
    let mut m = HashMap::new();

    m.insert("anthropic".into(), ProviderConfig {
        name: "anthropic".into(),
        api_base: "https://api.anthropic.com".into(),
        api_key_env: "ANTHROPIC_API_KEY".into(),
        protocol: "anthropic".into(),
        local: false,
        enabled: true,
        rate_limits: RateLimits::default(),
        models: vec![
            ModelInfo {
                id: "claude-opus-4-7".into(),
                display_name: "Claude Opus 4.7".into(),
                input_cost_per_m: 15.0,
                output_cost_per_m: 75.0,
                max_context: 200_000,
                supports_vision: true,
                supports_tools: true,
            },
            ModelInfo {
                id: "claude-sonnet-4-6".into(),
                display_name: "Claude Sonnet 4.6".into(),
                input_cost_per_m: 3.0,
                output_cost_per_m: 15.0,
                max_context: 200_000,
                supports_vision: true,
                supports_tools: true,
            },
            ModelInfo {
                id: "claude-haiku-4-5".into(),
                display_name: "Claude Haiku 4.5".into(),
                input_cost_per_m: 1.0,
                output_cost_per_m: 5.0,
                max_context: 200_000,
                supports_vision: true,
                supports_tools: true,
            },
        ],
    });

    m.insert("openai".into(), ProviderConfig {
        name: "openai".into(),
        api_base: "https://api.openai.com/v1".into(),
        api_key_env: "OPENAI_API_KEY".into(),
        protocol: "openai-compatible".into(),
        local: false,
        enabled: true,
        rate_limits: RateLimits::default(),
        models: vec![
            ModelInfo {
                id: "gpt-4o".into(),
                display_name: "GPT-4o".into(),
                input_cost_per_m: 2.5,
                output_cost_per_m: 10.0,
                max_context: 128_000,
                supports_vision: true,
                supports_tools: true,
            },
            ModelInfo {
                id: "gpt-4o-mini".into(),
                display_name: "GPT-4o mini".into(),
                input_cost_per_m: 0.15,
                output_cost_per_m: 0.60,
                max_context: 128_000,
                supports_vision: true,
                supports_tools: true,
            },
        ],
    });

    m.insert("deepseek".into(), ProviderConfig {
        name: "deepseek".into(),
        api_base: "https://api.deepseek.com/v1".into(),
        api_key_env: "DEEPSEEK_API_KEY".into(),
        protocol: "openai-compatible".into(),
        local: false,
        enabled: true,
        rate_limits: RateLimits::default(),
        models: vec![
            ModelInfo {
                id: "deepseek-chat".into(),
                display_name: "DeepSeek Chat".into(),
                input_cost_per_m: 0.27,
                output_cost_per_m: 1.10,
                max_context: 64_000,
                supports_vision: false,
                supports_tools: true,
            },
            ModelInfo {
                id: "deepseek-reasoner".into(),
                display_name: "DeepSeek Reasoner".into(),
                input_cost_per_m: 0.55,
                output_cost_per_m: 2.19,
                max_context: 64_000,
                supports_vision: false,
                supports_tools: true,
            },
        ],
    });

    m.insert("ollama".into(), ProviderConfig {
        name: "ollama".into(),
        api_base: "http://localhost:11434/v1".into(),
        api_key_env: "".into(),
        protocol: "openai-compatible".into(),
        local: true,
        enabled: true,
        rate_limits: RateLimits::default(),
        models: vec![
            ModelInfo {
                id: "llama3.3".into(),
                display_name: "Llama 3.3 70B (local)".into(),
                input_cost_per_m: 0.0,
                output_cost_per_m: 0.0,
                max_context: 128_000,
                supports_vision: false,
                supports_tools: true,
            },
            ModelInfo {
                id: "qwen2.5-coder".into(),
                display_name: "Qwen 2.5 Coder (local)".into(),
                input_cost_per_m: 0.0,
                output_cost_per_m: 0.0,
                max_context: 128_000,
                supports_vision: false,
                supports_tools: true,
            },
        ],
    });

    m
}
```

- [ ] **Step 4: Update / add tests**

In `provider_router.rs`'s test module:

```rust
#[test]
fn builtin_providers_includes_all_four() {
    let providers = builtin_providers();
    assert!(providers.contains_key("anthropic"));
    assert!(providers.contains_key("openai"));
    assert!(providers.contains_key("deepseek"));
    assert!(providers.contains_key("ollama"));
}

#[test]
fn protocols_are_set_correctly() {
    let providers = builtin_providers();
    assert_eq!(providers["anthropic"].protocol, "anthropic");
    assert_eq!(providers["openai"].protocol, "openai-compatible");
    assert_eq!(providers["deepseek"].protocol, "openai-compatible");
    assert_eq!(providers["ollama"].protocol, "openai-compatible");
}

#[test]
fn ollama_is_local() {
    let providers = builtin_providers();
    assert!(providers["ollama"].local);
    assert!(!providers["anthropic"].local);
}

#[test]
fn find_model_returns_provider_with_protocol() {
    let router = ProviderRouter { providers: builtin_providers() };
    let (p, m) = router.find_model("gpt-4o").expect("gpt-4o must be findable");
    assert_eq!(p.name, "openai");
    assert_eq!(p.protocol, "openai-compatible");
    assert_eq!(m.id, "gpt-4o");

    let (p, _) = router.find_model("deepseek-chat").expect("deepseek-chat must be findable");
    assert_eq!(p.name, "deepseek");
}
```

- [ ] **Step 5: Run cargo test + commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh/src-tauri
cargo test provider_router
git add provider_router.rs
git commit -m "feat: register DeepSeek + Ollama; add protocol/local fields to ProviderConfig"
```

---

### Task 3: LlmProvider trait + AnthropicProvider extraction

**Files:**
- Create: `src-tauri/src/providers/mod.rs`
- Create: `src-tauri/src/providers/anthropic.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod providers;`)
- Modify: `src-tauri/Cargo.toml` (add `async_trait` if missing)

- [ ] **Step 1: Check `Cargo.toml` for `async_trait`**

```bash
grep -i async.trait /Users/jonathan/TYPEFY/octopus/octopus-sh/src-tauri/Cargo.toml
```

If missing, add to `[dependencies]`:

```toml
async-trait = "0.1"
```

- [ ] **Step 2: Create `src-tauri/src/providers/mod.rs`**

Use the full content shown in the "Architecture" section of this plan above. (The `LlmRequest`/`LlmResponse`/`LlmTool`/`LlmContent`/`LlmToolUse`/`LlmToolResult`/`LlmStopReason` types + trait.)

- [ ] **Step 3: Create `src-tauri/src/providers/anthropic.rs`**

Extract the existing Anthropic logic from `chat_engine.rs` into a provider impl:

```rust
//! Anthropic Messages API implementation of the LlmProvider trait.

use super::{
    LlmContent, LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmRole,
    LlmStopReason, LlmToolUse,
};
use crate::error::{AppError, AppResult};
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct AnthropicProvider;

#[async_trait]
impl LlmProvider for AnthropicProvider {
    async fn complete(
        &self,
        api_base: &str,
        api_key: Option<&str>,
        req: &LlmRequest,
        client: &reqwest::Client,
    ) -> AppResult<LlmResponse> {
        let key = api_key.ok_or_else(|| {
            AppError::Other("Anthropic API key not configured.".into())
        })?;

        let body = build_request(req);
        let url = format!("{}/v1/messages", api_base.trim_end_matches('/'));

        let resp = client
            .post(&url)
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .header("anthropic-beta", "output-128k-2025-02-19")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Other(format!("Anthropic request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::Other(format!("Anthropic API error {status}: {text}")));
        }

        let response: Value = resp.json().await
            .map_err(|e| AppError::Other(format!("JSON parse error: {e}")))?;

        Ok(parse_response(response))
    }
}

pub fn build_request(req: &LlmRequest) -> Value {
    let messages: Vec<Value> = req.messages.iter().map(message_to_anthropic).collect();
    let tools: Vec<Value> = req.tools.iter().map(|t| json!({
        "name": t.name,
        "description": t.description,
        "input_schema": t.input_schema,
    })).collect();

    json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "system": req.system,
        "tools": tools,
        "messages": messages,
    })
}

fn message_to_anthropic(msg: &LlmMessage) -> Value {
    let role = match msg.role {
        LlmRole::User => "user",
        LlmRole::Assistant => "assistant",
    };
    let content = match &msg.content {
        LlmContent::Text(t) => Value::String(t.clone()),
        LlmContent::AssistantWithTools { text, tool_uses } => {
            let mut arr: Vec<Value> = Vec::new();
            if !text.is_empty() {
                arr.push(json!({ "type": "text", "text": text }));
            }
            for u in tool_uses {
                arr.push(json!({
                    "type": "tool_use",
                    "id": u.id,
                    "name": u.name,
                    "input": u.input,
                }));
            }
            Value::Array(arr)
        }
        LlmContent::ToolResults(results) => {
            let arr: Vec<Value> = results.iter().map(|r| json!({
                "type": "tool_result",
                "tool_use_id": r.tool_use_id,
                "content": r.content,
                "is_error": r.is_error,
            })).collect();
            Value::Array(arr)
        }
    };
    json!({ "role": role, "content": content })
}

pub fn parse_response(response: Value) -> LlmResponse {
    let mut text = String::new();
    let mut tool_uses = Vec::new();

    if let Some(content) = response.get("content").and_then(|c| c.as_array()) {
        for block in content {
            match block.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                        text.push_str(t);
                    }
                }
                Some("tool_use") => {
                    let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let input = block.get("input").cloned().unwrap_or(json!({}));
                    tool_uses.push(LlmToolUse { id, name, input });
                }
                _ => {}
            }
        }
    }

    let stop_reason = match response.get("stop_reason").and_then(|s| s.as_str()) {
        Some("end_turn") => LlmStopReason::EndTurn,
        Some("tool_use") => LlmStopReason::ToolUse,
        Some("max_tokens") => LlmStopReason::MaxTokens,
        Some(other) => LlmStopReason::Other(other.to_string()),
        None => LlmStopReason::EndTurn,
    };

    let input_tokens = response.get("usage")
        .and_then(|u| u.get("input_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let output_tokens = response.get("usage")
        .and_then(|u| u.get("output_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    LlmResponse {
        text,
        tool_uses,
        stop_reason,
        input_tokens,
        output_tokens,
    }
}
```

- [ ] **Step 4: Register the module in `lib.rs`**

Add `pub mod providers;` near the other `pub mod` declarations.

- [ ] **Step 5: Cargo build**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh/src-tauri
cargo build 2>&1 | tail -10
```

Expected: clean. The module is defined but no caller yet — that comes in Task 5.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/providers/ src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat: LlmProvider trait + AnthropicProvider implementation"
```

---

### Task 4: OpenAICompatibleProvider

**Files:**
- Create: `src-tauri/src/providers/openai_compat.rs`

- [ ] **Step 1: Create the file**

```rust
//! OpenAI Chat Completions API implementation of the LlmProvider trait.
//!
//! Used by OpenAI proper, DeepSeek, Ollama (via /v1/chat/completions), and
//! any self-hosted server that speaks the OpenAI Chat Completions protocol
//! (vllm, llama.cpp server, LMStudio, LocalAI, etc.).

use super::{
    LlmContent, LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmRole,
    LlmStopReason, LlmToolUse,
};
use crate::error::{AppError, AppResult};
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct OpenAICompatibleProvider;

#[async_trait]
impl LlmProvider for OpenAICompatibleProvider {
    async fn complete(
        &self,
        api_base: &str,
        api_key: Option<&str>,
        req: &LlmRequest,
        client: &reqwest::Client,
    ) -> AppResult<LlmResponse> {
        let body = build_request(req);
        let url = format!("{}/chat/completions", api_base.trim_end_matches('/'));

        let mut request = client.post(&url)
            .header("content-type", "application/json")
            .json(&body);

        // Some local providers (Ollama) don't require an Authorization header.
        if let Some(key) = api_key {
            if !key.is_empty() {
                request = request.header("Authorization", format!("Bearer {}", key));
            }
        }

        let resp = request.send().await
            .map_err(|e| AppError::Other(format!("OpenAI-compat request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::Other(format!("OpenAI-compat API error {status}: {text}")));
        }

        let response: Value = resp.json().await
            .map_err(|e| AppError::Other(format!("JSON parse error: {e}")))?;

        Ok(parse_response(response))
    }
}

pub fn build_request(req: &LlmRequest) -> Value {
    // OpenAI puts system prompt as the first message with role="system" rather
    // than a top-level field.
    let mut messages: Vec<Value> = Vec::with_capacity(req.messages.len() + 1);
    if !req.system.is_empty() {
        messages.push(json!({
            "role": "system",
            "content": req.system,
        }));
    }
    for m in &req.messages {
        messages.extend(message_to_openai(m));
    }

    // OpenAI tools use a different wrapper shape.
    let tools: Vec<Value> = req.tools.iter().map(|t| json!({
        "type": "function",
        "function": {
            "name": t.name,
            "description": t.description,
            "parameters": t.input_schema,
        },
    })).collect();

    let mut body = json!({
        "model": req.model,
        "messages": messages,
        "max_tokens": req.max_tokens,
    });
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools);
    }
    body
}

/// Returns 1 or more OpenAI-format messages from a normalized LlmMessage.
/// A single ToolResults entry can produce multiple `role=tool` messages.
fn message_to_openai(msg: &LlmMessage) -> Vec<Value> {
    match (&msg.role, &msg.content) {
        (LlmRole::User, LlmContent::Text(t)) => vec![json!({
            "role": "user",
            "content": t,
        })],
        (LlmRole::Assistant, LlmContent::Text(t)) => vec![json!({
            "role": "assistant",
            "content": t,
        })],
        (LlmRole::Assistant, LlmContent::AssistantWithTools { text, tool_uses }) => {
            // Single assistant message with tool_calls array.
            let tool_calls: Vec<Value> = tool_uses.iter().map(|u| json!({
                "id": u.id,
                "type": "function",
                "function": {
                    "name": u.name,
                    // OpenAI expects arguments as a STRING containing JSON, not a
                    // structured object — undocumented but consistent across vendors.
                    "arguments": serde_json::to_string(&u.input).unwrap_or_else(|_| "{}".into()),
                },
            })).collect();
            let mut obj = json!({
                "role": "assistant",
                "tool_calls": tool_calls,
            });
            if !text.is_empty() {
                obj["content"] = Value::String(text.clone());
            } else {
                // OpenAI allows null content when tool_calls is set.
                obj["content"] = Value::Null;
            }
            vec![obj]
        }
        (LlmRole::User, LlmContent::ToolResults(results)) => {
            // Each tool result becomes its own role=tool message.
            results.iter().map(|r| json!({
                "role": "tool",
                "tool_call_id": r.tool_use_id,
                "content": r.content,
            })).collect()
        }
        // Defensive: malformed combinations
        _ => vec![json!({ "role": "user", "content": "" })],
    }
}

pub fn parse_response(response: Value) -> LlmResponse {
    let mut text = String::new();
    let mut tool_uses: Vec<LlmToolUse> = Vec::new();

    let choice = response.get("choices")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first());

    if let Some(choice) = choice {
        if let Some(msg) = choice.get("message") {
            if let Some(t) = msg.get("content").and_then(|c| c.as_str()) {
                text.push_str(t);
            }
            if let Some(calls) = msg.get("tool_calls").and_then(|c| c.as_array()) {
                for call in calls {
                    let id = call.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let func = call.get("function");
                    let name = func.and_then(|f| f.get("name")).and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let args_str = func.and_then(|f| f.get("arguments")).and_then(|v| v.as_str()).unwrap_or("{}");
                    let input: Value = serde_json::from_str(args_str).unwrap_or_else(|_| json!({}));
                    tool_uses.push(LlmToolUse { id, name, input });
                }
            }
        }
    }

    let stop_reason = match choice
        .and_then(|c| c.get("finish_reason"))
        .and_then(|s| s.as_str())
    {
        Some("stop") => LlmStopReason::EndTurn,
        Some("tool_calls") => LlmStopReason::ToolUse,
        Some("length") => LlmStopReason::MaxTokens,
        Some(other) => LlmStopReason::Other(other.to_string()),
        None => {
            // Ollama omits finish_reason but if tool_calls were present we treat as ToolUse.
            if !tool_uses.is_empty() {
                LlmStopReason::ToolUse
            } else {
                LlmStopReason::EndTurn
            }
        }
    };

    let input_tokens = response.get("usage")
        .and_then(|u| u.get("prompt_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let output_tokens = response.get("usage")
        .and_then(|u| u.get("completion_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    LlmResponse {
        text,
        tool_uses,
        stop_reason,
        input_tokens,
        output_tokens,
    }
}
```

- [ ] **Step 2: Cargo build**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh/src-tauri
cargo build 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/providers/openai_compat.rs
git commit -m "feat: OpenAICompatibleProvider (covers OpenAI, DeepSeek, Ollama, self-hosted)"
```

---

### Task 5: chat_engine refactor

**Files:**
- Modify: `src-tauri/src/chat_engine.rs`

This is the biggest change. The agentic loop becomes provider-agnostic.

- [ ] **Step 1: Read current `chat_engine.rs`**

Get a sense of the structure. The function to replace is `send_agentic`. Helper `tool_definitions()` becomes a builder of `Vec<LlmTool>`. The history-building loop builds `Vec<LlmMessage>`.

- [ ] **Step 2: Replace the agentic loop**

This is substantial. Use Write or carefully apply Edit. The strategy: keep `insert_and_emit_message` and `execute_tool` (those still belong here), but replace the loop body and history-builder.

```rust
// Add at top of chat_engine.rs:
use crate::providers::{
    anthropic::AnthropicProvider, openai_compat::OpenAICompatibleProvider,
    LlmContent, LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmRole,
    LlmStopReason, LlmTool, LlmToolResult, LlmToolUse,
};
use crate::provider_router::ProviderRouter;

// Helper: build the static tool list as normalized LlmTool[].
fn build_llm_tools() -> Vec<LlmTool> {
    let defs = tool_definitions();
    let arr = defs.as_array().cloned().unwrap_or_default();
    arr.into_iter().map(|t| LlmTool {
        name: t.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        description: t.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        input_schema: t.get("input_schema").cloned().unwrap_or(serde_json::json!({})),
    }).collect()
}

// Resolve which provider implementation handles this model.
fn resolve_provider(model: &str) -> AppResult<(Box<dyn LlmProvider>, String, Option<String>)> {
    let router = ProviderRouter::load()?;
    let (provider_cfg, _model_info) = router.find_model(model)
        .ok_or_else(|| AppError::Other(format!("Unknown model: {model}. Configure it in Settings · Models & Providers.")))?;

    let key = crate::settings::get_provider_key(&provider_cfg.name);
    // Allow base_url override (Ollama, custom self-hosted).
    let api_base = crate::settings::get_provider_base_url(&provider_cfg.name)
        .unwrap_or_else(|| provider_cfg.api_base.clone());

    // Require key for non-local providers.
    if !provider_cfg.local && key.is_none() {
        return Err(AppError::Other(format!(
            "{} API key not configured. Open Settings · Models & Providers.",
            provider_cfg.name
        )));
    }

    let impl_: Box<dyn LlmProvider> = match provider_cfg.protocol.as_str() {
        "anthropic" => Box::new(AnthropicProvider),
        "openai-compatible" => Box::new(OpenAICompatibleProvider),
        other => return Err(AppError::Other(format!("Unsupported protocol: {other}"))),
    };

    Ok((impl_, api_base, key))
}
```

Then replace the body of `send_agentic`. The key transformation: instead of hand-building Anthropic JSON, build `LlmMessage` and `LlmTool` lists, call the provider, react to the normalized `LlmResponse`. The existing history reconstruction logic (reading the DB, threading tool summaries into assistant turns) is preserved but emits `LlmMessage` instead of provider-specific JSON.

```rust
pub async fn send_agentic(
    &self,
    app: AppHandle,
    request: ChatRequest,
) -> AppResult<()> {
    let (provider, api_base, api_key) = resolve_provider(&request.model)?;

    let workspace_path = std::path::PathBuf::from(&request.workspace_path);

    // Persist user message + emit message-added so frontend learns the DB id.
    self.insert_and_emit_message(
        &app,
        &request.workspace_id,
        "user",
        &request.user_message,
        None, None, None, None,
    )?;

    // Build conversation history as normalized LlmMessage[].
    let history = self.db.lock().list_chat_messages(&request.workspace_id)?;
    let mut messages: Vec<LlmMessage> = Vec::new();
    let mut pending_tool_summary = Vec::new();

    for msg in &history {
        if msg.role == "tool" {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&msg.content) {
                let name = parsed.get("toolName").and_then(|n| n.as_str()).unwrap_or("tool");
                let empty_obj = serde_json::json!({});
                let input = parsed.get("toolInput").unwrap_or(&empty_obj);
                let result = parsed.get("result").and_then(|r| r.as_str()).unwrap_or("");
                let short_result = if result.len() > 500 {
                    format!("{}...(truncated)", &result[..500])
                } else {
                    result.to_string()
                };
                pending_tool_summary.push(format!(
                    "[Tool: {} | Input: {} | Result: {}]",
                    name,
                    serde_json::to_string(input).unwrap_or_default(),
                    short_result,
                ));
            }
        } else if msg.role == "assistant" {
            let mut content = String::new();
            if !pending_tool_summary.is_empty() {
                content.push_str(&pending_tool_summary.join("\n"));
                content.push_str("\n\n");
                pending_tool_summary.clear();
            }
            content.push_str(&msg.content);
            messages.push(LlmMessage {
                role: LlmRole::Assistant,
                content: LlmContent::Text(content),
            });
        } else if msg.role == "user" {
            pending_tool_summary.clear();
            messages.push(LlmMessage {
                role: LlmRole::User,
                content: LlmContent::Text(msg.content.clone()),
            });
        }
    }

    let system_prompt = request.system.unwrap_or_else(|| {
        format!(
            "You are a helpful coding assistant working in the project at {}. \
             You have tools to run commands, read/write files, and list directories. \
             Use them to help the user with their tasks. Be concise and take action \
             rather than just explaining what to do.",
            request.workspace_path
        )
    });

    let tools = build_llm_tools();
    let mut total_input: u64 = 0;
    let mut total_output: u64 = 0;

    for iteration in 0..MAX_TOOL_ITERATIONS {
        let llm_req = LlmRequest {
            model: request.model.clone(),
            max_tokens: 32768_u32.max(request.max_tokens),
            system: system_prompt.clone(),
            messages: messages.clone(),
            tools: tools.clone(),
        };

        let response: LlmResponse = provider
            .complete(&api_base, api_key.as_deref(), &llm_req, &self.client)
            .await?;

        total_input += response.input_tokens;
        total_output += response.output_tokens;

        tracing::info!(
            iteration = iteration,
            stop_reason = ?response.stop_reason,
            text_len = response.text.len(),
            tool_count = response.tool_uses.len(),
            "agentic loop iteration"
        );

        let is_final = response.stop_reason != LlmStopReason::ToolUse
            || response.tool_uses.is_empty();

        // Emit intermediate text deltas only for the FINAL response.
        if is_final && !response.text.is_empty() {
            let _ = app.emit("chat://stream", &ChatStreamEvent {
                workspace_id: request.workspace_id.clone(),
                delta: response.text.clone(),
                done: false,
                input_tokens: None,
                output_tokens: None,
            });
        }

        // Handle max_tokens truncation during tool use.
        if matches!(response.stop_reason, LlmStopReason::MaxTokens) && !response.tool_uses.is_empty() {
            tracing::warn!("Response truncated at max_tokens during tool_use — providing error tool_results and retrying");
            messages.push(LlmMessage {
                role: LlmRole::Assistant,
                content: LlmContent::AssistantWithTools {
                    text: response.text.clone(),
                    tool_uses: response.tool_uses.clone(),
                },
            });
            let error_results: Vec<LlmToolResult> = response.tool_uses.iter().map(|u| LlmToolResult {
                tool_use_id: u.id.clone(),
                content: "ERROR: Your response was truncated because it exceeded the output token limit. The file content was cut off and NOT written. Please retry with smaller files — split into multiple files or keep each under 200 lines. Write one file at a time.".to_string(),
                is_error: true,
            }).collect();
            messages.push(LlmMessage {
                role: LlmRole::User,
                content: LlmContent::ToolResults(error_results),
            });
            continue;
        }

        if is_final {
            let final_text = response.text.trim().to_string();

            if !final_text.is_empty() {
                let cost = crate::token_engine::compute_cost(&request.model, total_input, total_output, 0, 0);
                self.insert_and_emit_message(
                    &app,
                    &request.workspace_id,
                    "assistant",
                    &final_text,
                    Some(&request.model),
                    Some(total_input as i64),
                    Some(total_output as i64),
                    Some(cost),
                )?;
            }

            let _ = app.emit("chat://stream", &ChatStreamEvent {
                workspace_id: request.workspace_id.clone(),
                delta: String::new(),
                done: true,
                input_tokens: Some(total_input),
                output_tokens: Some(total_output),
            });

            return Ok(());
        }

        // ─── Execute tools ───
        messages.push(LlmMessage {
            role: LlmRole::Assistant,
            content: LlmContent::AssistantWithTools {
                text: response.text.clone(),
                tool_uses: response.tool_uses.clone(),
            },
        });

        let mut tool_results: Vec<LlmToolResult> = Vec::new();
        for u in &response.tool_uses {
            tracing::info!(tool = %u.name, "executing tool");
            let result = execute_tool(&workspace_path, &u.name, &u.input);

            let input_for_display = if u.name == "write_file" {
                let mut display = u.input.clone();
                if let Some(content) = display.get("content").and_then(|c| c.as_str()) {
                    let len = content.len();
                    display["content"] = serde_json::json!(format!("({len} chars, written to disk)"));
                }
                display
            } else {
                u.input.clone()
            };

            let tool_record = serde_json::json!({
                "toolName": u.name,
                "toolInput": input_for_display,
                "result": result,
            });
            if let Err(e) = self.insert_and_emit_message(
                &app,
                &request.workspace_id,
                "tool",
                &tool_record.to_string(),
                None, None, None, None,
            ) {
                tracing::error!(tool = %u.name, error = %e, "failed to persist tool execution");
            }

            tool_results.push(LlmToolResult {
                tool_use_id: u.id.clone(),
                content: result,
                is_error: false,
            });
        }

        messages.push(LlmMessage {
            role: LlmRole::User,
            content: LlmContent::ToolResults(tool_results),
        });
    }

    Err(AppError::Other(format!(
        "Agentic loop exceeded max iterations ({MAX_TOOL_ITERATIONS})"
    )))
}
```

- [ ] **Step 3: Verify the file still compiles**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh/src-tauri
cargo build 2>&1 | tail -10
```

Expected: clean. If there are unused imports (the old direct API call code is gone), remove them.

- [ ] **Step 4: Run all Rust tests**

```bash
cargo test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/chat_engine.rs
git commit -m "feat(chat): dispatch agentic loop via LlmProvider trait"
```

---

### Task 6: Provider unit tests

**Files:**
- Create: `src-tauri/src/providers/tests.rs`

- [ ] **Step 1: Create the file**

```rust
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
```

- [ ] **Step 2: Run cargo test**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh/src-tauri
cargo test providers
```

Expected: all 10 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/providers/tests.rs
git commit -m "test: provider request/response shape tests"
```

---

### Task 7: Frontend — Settings · Models & Providers

**Files:**
- Modify: `src/components/Settings.tsx`

Replace the hardcoded Anthropic+OpenAI key form with a dynamic per-provider section. Load providers from `provider_router` via IPC.

- [ ] **Step 1: Add an IPC wrapper for providers list**

Verify `src/lib/ipc.ts` has a way to list providers — there's already `listModels()` from earlier phases. Add (if missing):

```typescript
listProviders: () => invoke<ProviderConfig[]>("list_providers"),
```

And the corresponding Tauri command in `src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub async fn list_providers() -> AppResult<Vec<crate::provider_router::ProviderConfig>> {
    let router = crate::provider_router::ProviderRouter::load()?;
    Ok(router.list_providers().into_iter().cloned().collect())
}
```

Register in `lib.rs`'s invoke handler: `commands::list_providers,`.

Add the TS type in `src/lib/types.ts`:

```typescript
export interface ProviderConfig {
  name: string;
  apiBase: string;
  apiKeyEnv: string;
  models: ModelInfo[];
  enabled: boolean;
  protocol: string;
  local: boolean;
}
```

- [ ] **Step 2: Rewrite `ModelsPane` in `src/components/Settings.tsx`**

The new pane lists ALL providers loaded from the registry. For each:
- Display name + model count
- API key input (skipped if `local: true`)
- Base URL input (only if `local: true` OR user wants to override)
- Show/Hide toggle on the key

```tsx
function ModelsPane() {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [baseUrls, setBaseUrls] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    Promise.all([ipc.listProviders(), ipc.getSettings()]).then(([provs, settings]) => {
      setProviders(provs);
      setKeys(settings.providerKeys ?? {});
      setBaseUrls(settings.providerBaseUrls ?? {});
    });
  }, []);

  async function handleSave() {
    setSaving(true);
    await ipc.saveSettings({
      providerKeys: Object.fromEntries(
        Object.entries(keys).filter(([_, v]) => v && v.length > 0),
      ),
      providerBaseUrls: Object.fromEntries(
        Object.entries(baseUrls).filter(([_, v]) => v && v.length > 0),
      ),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <>
      <PaneHeader
        eyebrow="Models & Providers"
        title="Choose where your tokens go."
        subtitle="API keys live on this machine in ~/.octopus-sh/settings.json. They never leave the device except in requests to the providers themselves."
      />

      <div className="max-w-[680px] space-y-7">
        {providers.map((p) => (
          <ProviderRow
            key={p.name}
            provider={p}
            value={keys[p.name] ?? ""}
            baseUrl={baseUrls[p.name] ?? ""}
            show={shown[p.name] ?? false}
            onChange={(v) => setKeys((s) => ({ ...s, [p.name]: v }))}
            onChangeBaseUrl={(v) => setBaseUrls((s) => ({ ...s, [p.name]: v }))}
            onToggleShow={() => setShown((s) => ({ ...s, [p.name]: !s[p.name] }))}
          />
        ))}

        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-md px-4 py-2 font-serif italic text-[13px] text-octo-brass transition disabled:opacity-50"
            style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
          >
            {saved ? "✓ Saved" : saving ? "Saving…" : "Save changes"}
          </button>
          {saved && (
            <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-verdigris">
              Saved to disk
            </span>
          )}
        </div>
      </div>
    </>
  );
}

function ProviderRow({
  provider, value, baseUrl, show, onChange, onChangeBaseUrl, onToggleShow,
}: {
  provider: ProviderConfig;
  value: string;
  baseUrl: string;
  show: boolean;
  onChange: (v: string) => void;
  onChangeBaseUrl: (v: string) => void;
  onToggleShow: () => void;
}) {
  const displayName = provider.name[0].toUpperCase() + provider.name.slice(1);
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="font-serif italic text-[16px] text-octo-ivory">{displayName}</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-octo-mute">
          {provider.models.length} models · {provider.local ? "local" : "cloud"}
        </span>
      </div>
      <div className="mt-1 text-[12px] text-octo-sage">
        {providerDescription(provider)}
      </div>

      {!provider.local && (
        <div className="relative mt-3">
          <input
            type={show ? "text" : "password"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="API key"
            className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 pr-10 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
          />
          <button
            type="button"
            onClick={onToggleShow}
            className="absolute right-2 top-1/2 -translate-y-1/2 px-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute hover:text-octo-brass"
          >
            {show ? "Hide" : "Show"}
          </button>
        </div>
      )}

      <div className="mt-2">
        <div className="mb-1 font-mono text-[8px] uppercase tracking-[0.25em] text-octo-mute">
          BASE URL {provider.local ? "(required)" : "(optional override)"}
        </div>
        <input
          value={baseUrl}
          onChange={(e) => onChangeBaseUrl(e.target.value)}
          placeholder={provider.apiBase}
          className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[11px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
        />
      </div>
    </div>
  );
}

function providerDescription(p: ProviderConfig): string {
  switch (p.name) {
    case "anthropic": return "Claude models (Opus, Sonnet, Haiku). Get your key at console.anthropic.com.";
    case "openai": return "GPT-4o and friends. Get your key at platform.openai.com.";
    case "deepseek": return "Cheaper alternative with strong code performance. platform.deepseek.com.";
    case "ollama": return "Local models running on this machine. Install via ollama.com — no key required.";
    default: return `${p.protocol} provider at ${p.apiBase}.`;
  }
}
```

Add the `ProviderConfig` import at the top of `Settings.tsx`:

```typescript
import type { ProviderConfig } from "../lib/types";
```

- [ ] **Step 3: Verify typecheck**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm run typecheck
```

Expected: clean (or warnings about legacy `anthropicApiKey` fields if anything else uses them — clean up).

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: 69+ pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(settings): dynamic per-provider Models & Providers pane"
```

---

### Task 8: Frontend — AgentBar dynamic models

**Files:**
- Modify: `src/components/AgentBar.tsx`

Replace the hardcoded 4 buttons with a dynamic list grouped by provider.

- [ ] **Step 1: Rewrite the component**

```tsx
import { useEffect, useState } from "react";
import { clsx } from "clsx";
import { ipc } from "../lib/ipc";
import type { ModelWithProvider } from "../lib/types";

interface Props {
  activeModel: string;
  onSelectModel: (model: string) => void;
}

// Provider → display color (used as the dot before the model name).
const PROVIDER_DOTS: Record<string, string> = {
  anthropic: "#cc785c",
  openai: "#74aa9c",
  deepseek: "#5c8acc",
  ollama: "#a8a8a8",
};

export function AgentBar({ activeModel, onSelectModel }: Props) {
  const [models, setModels] = useState<ModelWithProvider[]>([]);

  useEffect(() => {
    ipc.listModels().then(setModels).catch(() => {});
  }, []);

  // Group by provider, preserving the order returned by the backend (which
  // already sorts by cost).
  const grouped: Record<string, ModelWithProvider[]> = {};
  for (const m of models) {
    (grouped[m.provider] ??= []).push(m);
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-octo-hairline bg-octo-panel px-4 py-2">
      {Object.entries(grouped).map(([provider, list]) => (
        <div key={provider} className="flex items-center gap-1">
          <span className="mr-1 font-mono text-[8px] uppercase tracking-[0.25em] text-octo-mute">
            {provider}
          </span>
          {list.map((m) => {
            const isActive = activeModel === m.model.id;
            return (
              <button
                key={m.model.id}
                onClick={() => onSelectModel(m.model.id)}
                className={clsx(
                  "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] transition",
                  isActive
                    ? "border-octo-brass-dim text-octo-brass"
                    : "border-transparent text-octo-sage hover:text-octo-ivory",
                )}
                style={isActive ? { background: "var(--brass-ghost)" } : undefined}
                title={`${m.model.displayName} · $${m.model.inputCostPerM}/M in`}
              >
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: PROVIDER_DOTS[provider] ?? "var(--color-octo-mute)" }}
                />
                {m.model.displayName}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
```

The component now loads models on mount and lays them out grouped by provider. Each group has a small mono uppercase label (`ANTHROPIC`, `OPENAI`, `DEEPSEEK`, `OLLAMA`). Local models (Ollama) get a neutral grey dot. Active model has the brass-ghost background.

- [ ] **Step 2: Verify typecheck + tests**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm run typecheck
npm test
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/AgentBar.tsx
git commit -m "feat(chat): AgentBar loads models dynamically, grouped by provider"
```

---

### Task 9: End-to-end verification

**Files:** none.

- [ ] **Step 1: Full sweep**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git log --oneline -12
npm run typecheck && npm test
cd src-tauri && cargo test
```

Expected: typecheck clean, ~69 frontend tests, ~50+ Rust tests (39 before + provider tests added in Task 6 + provider_router tests added in Task 2).

- [ ] **Step 2: Boot dev server**

```bash
npm run dev 2>&1 | head -15
```

Expected: Vite ready.

- [ ] **Step 3: Visual verification (user)**

User builds + boots. Verify:

- **AgentBar** shows ALL providers grouped: ANTHROPIC (Opus 4.7, Sonnet 4.6, Haiku 4.5), OPENAI (GPT-4o, GPT-4o mini), DEEPSEEK (Chat, Reasoner), OLLAMA (Llama 3.3 70B, Qwen 2.5 Coder).
- **Settings · Models & Providers** lists all 4 providers with their respective API key inputs (Ollama has only Base URL since `local: true`).
- **Chat with Claude** (Anthropic): works as before.
- **Chat with GPT-4o** (OpenAI, with key configured): completes successfully — no more 404.
- **Chat with DeepSeek** (key configured): completes successfully.
- **Chat with Llama 3.3** (Ollama running locally on the default port): completes successfully.

For Ollama testing, the user needs `ollama serve` running and the model pulled (`ollama pull llama3.3`).

- [ ] **Step 4: Report blockers**

Each provider may surface its own quirks (different error shapes, rate limits, etc.). Fix any provider-specific bug as a targeted `fix(provider-<name>): …` commit.

---

## Self-review

**Scope coverage:**
- Anthropic: ✓ (unchanged behavior, refactored into provider impl)
- OpenAI: ✓ (new path via OpenAICompatibleProvider — fixes the reported bug)
- DeepSeek: ✓ (registered in providers; uses OpenAICompatibleProvider)
- Ollama: ✓ (registered + local: true → no API key required)
- Self-hosted: ✓ (any OpenAI-compatible endpoint works by setting `providerBaseUrls.<name>` — covered without further code)

**Migration safety:**
- Old `settings.json` files with `anthropicApiKey`/`openaiApiKey` are auto-migrated to `providerKeys` on first load.
- Old `providers.json` files without `protocol` get inferred protocols (anthropic → "anthropic", openai/deepseek → "openai-compatible", ollama → "openai-compatible" + local).
- Existing chat history is unaffected — `chat_messages` table format unchanged.

**Risks:**
- Subtle wire-format differences between OpenAI-compatibles (some models don't support tools, some have stricter system prompt rules). Defensive: when a model returns "model does not support tools", the user sees the Anthropic-style error directly from our error path; future work could detect this and disable tools per-request.
- DeepSeek's `deepseek-reasoner` model doesn't always return tool calls in the standard shape. Defensive: tests cover the common case; edge cases get debugged per-model.
- Ollama's tool support is recent and varies by underlying model. For models that don't support tools, the agentic loop will just get text responses without tools — graceful degradation.
- The `ChatMessage.model` field in the DB stores the model id (e.g. "deepseek-chat"). Existing token cost computation in `token_engine.rs` reads this id to look up cost — needs to handle new model ids gracefully (probably just zero cost if unknown, which is acceptable).

**Phase 8 ships when:**
- 8 implementation commits + plan commit land on the branch.
- typecheck + Rust tests + frontend tests pass.
- Manual smoke test confirms at least Anthropic, OpenAI, and one of (DeepSeek, Ollama) complete successful turns.

After Phase 8, Octopus actually delivers on the multi-provider promise its UI implies. Self-hosted support is "free" — users with vllm/llama.cpp servers just paste their endpoint into the Base URL field of the corresponding provider (or treat one of the existing providers as their custom endpoint).
