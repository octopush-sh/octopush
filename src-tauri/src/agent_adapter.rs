//! Agent adapters — abstraction over different CLI-based coding agents.
//!
//! Each adapter knows how to:
//! - Build the shell command to launch the agent
//! - Parse token usage from the agent's output
//! - Report whether it supports mid-session model swapping

use crate::token_engine::TokenEvent;
use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};

/// Trait for pluggable agent adapters.
pub trait AgentAdapter: Send + Sync {
    fn name(&self) -> &str;
    fn display_name(&self) -> &str;
    fn build_command(&self, model: &str, cwd: &str) -> CommandBuilder;
    fn parse_token_usage(&self, session_id: &str, output: &str) -> Option<TokenEvent>;
    fn supports_hot_swap(&self) -> bool;
}

/// Adapter metadata for the frontend.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AdapterInfo {
    pub name: String,
    pub display_name: String,
    pub supports_hot_swap: bool,
}

// ─── Claude Code ──────────────────────────────────────────────────

pub struct ClaudeCodeAdapter;

impl AgentAdapter for ClaudeCodeAdapter {
    fn name(&self) -> &str {
        "claude-code"
    }
    fn display_name(&self) -> &str {
        "Claude Code"
    }
    fn build_command(&self, model: &str, cwd: &str) -> CommandBuilder {
        let mut cmd = CommandBuilder::new("claude");
        cmd.arg("--model");
        cmd.arg(model);
        cmd.cwd(cwd);
        cmd
    }
    fn parse_token_usage(&self, session_id: &str, output: &str) -> Option<TokenEvent> {
        // Delegate to the shared scanner which already handles Claude Code format.
        crate::token_engine::scan_pty_output(session_id, output.as_bytes())
    }
    fn supports_hot_swap(&self) -> bool {
        // Claude Code sessions can be restarted with a different --model.
        false
    }
}

// ─── Aider ────────────────────────────────────────────────────────

pub struct AiderAdapter;

impl AgentAdapter for AiderAdapter {
    fn name(&self) -> &str {
        "aider"
    }
    fn display_name(&self) -> &str {
        "Aider"
    }
    fn build_command(&self, model: &str, cwd: &str) -> CommandBuilder {
        let mut cmd = CommandBuilder::new("aider");
        cmd.arg("--model");
        cmd.arg(model);
        cmd.cwd(cwd);
        cmd
    }
    fn parse_token_usage(&self, session_id: &str, output: &str) -> Option<TokenEvent> {
        // Aider prints "Tokens: NNN sent, NNN received" — parse if present.
        parse_aider_tokens(session_id, output)
    }
    fn supports_hot_swap(&self) -> bool {
        // Aider supports /model command mid-session.
        true
    }
}

fn parse_aider_tokens(session_id: &str, output: &str) -> Option<TokenEvent> {
    // Pattern: "Tokens: 1,234 sent, 567 received"
    let idx = output.find("Tokens:")?;
    let line = output[idx..].lines().next()?;
    let sent = extract_number_before(line, "sent")?;
    let recv = extract_number_before(line, "received")?;
    Some(TokenEvent {
        id: None,
        session_id: session_id.to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        input_tokens: sent,
        output_tokens: recv,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        model: "unknown".to_string(),
        cost_usd: 0.0,
    })
}

fn extract_number_before(s: &str, keyword: &str) -> Option<u64> {
    let idx = s.find(keyword)?;
    let before = s[..idx].trim_end().trim_end_matches(',');
    // Walk backwards to find the number.
    let num_str: String = before
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit() || *c == ',')
        .collect::<String>()
        .chars()
        .rev()
        .filter(|c| *c != ',')
        .collect();
    num_str.parse().ok()
}

// ─── Custom Agent ─────────────────────────────────────────────────

pub struct CustomAgentAdapter {
    pub agent_name: String,
    pub command: String,
    pub args: Vec<String>,
}

impl AgentAdapter for CustomAgentAdapter {
    fn name(&self) -> &str {
        &self.agent_name
    }
    fn display_name(&self) -> &str {
        &self.agent_name
    }
    fn build_command(&self, _model: &str, cwd: &str) -> CommandBuilder {
        let mut cmd = CommandBuilder::new(&self.command);
        for arg in &self.args {
            cmd.arg(arg);
        }
        cmd.cwd(cwd);
        cmd
    }
    fn parse_token_usage(&self, _session_id: &str, _output: &str) -> Option<TokenEvent> {
        // Custom agents: rely on JSON usage block interception.
        None
    }
    fn supports_hot_swap(&self) -> bool {
        false
    }
}

// ─── Registry ─────────────────────────────────────────────────────

pub fn builtin_adapters() -> Vec<Box<dyn AgentAdapter>> {
    vec![
        Box::new(ClaudeCodeAdapter),
        Box::new(AiderAdapter),
    ]
}

pub fn adapter_info_list() -> Vec<AdapterInfo> {
    builtin_adapters()
        .iter()
        .map(|a| AdapterInfo {
            name: a.name().to_string(),
            display_name: a.display_name().to_string(),
            supports_hot_swap: a.supports_hot_swap(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_code_command() {
        let adapter = ClaudeCodeAdapter;
        let cmd = adapter.build_command("claude-opus-4-6", "/tmp");
        let argv = cmd.get_argv();
        assert!(argv.iter().any(|a| a.to_str().map_or(false, |s| s == "claude")));
    }

    #[test]
    fn aider_command() {
        let adapter = AiderAdapter;
        let cmd = adapter.build_command("gpt-4o", "/home/user/project");
        let argv = cmd.get_argv();
        assert!(argv.iter().any(|a| a.to_str().map_or(false, |s| s == "aider")));
        assert!(argv.iter().any(|a| a.to_str().map_or(false, |s| s == "gpt-4o")));
    }

    #[test]
    fn parse_aider_output() {
        let output = "Tokens: 1,234 sent, 567 received. Cost: $0.05";
        let ev = parse_aider_tokens("sess-1", output).unwrap();
        assert_eq!(ev.input_tokens, 1234);
        assert_eq!(ev.output_tokens, 567);
    }

    #[test]
    fn parse_aider_no_match() {
        assert!(parse_aider_tokens("x", "no tokens here").is_none());
    }

    #[test]
    fn adapter_info_list_has_entries() {
        let list = adapter_info_list();
        assert!(list.len() >= 2);
        assert!(list.iter().any(|a| a.name == "claude-code"));
        assert!(list.iter().any(|a| a.name == "aider"));
    }

    #[test]
    fn custom_adapter() {
        let adapter = CustomAgentAdapter {
            agent_name: "my-agent".into(),
            command: "/usr/local/bin/my-agent".into(),
            args: vec!["--verbose".into()],
        };
        assert_eq!(adapter.name(), "my-agent");
        assert!(!adapter.supports_hot_swap());
    }
}
