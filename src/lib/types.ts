// Mirror of the Rust `Session` model. Kept in sync manually for Phase 1;
// Phase 2 will consider generating from Rust via `ts-rs` or `specta`.

export type SessionStatus =
  | "active"
  | "idle"
  | "paused"
  | "completed"
  | "error";

export type Provider =
  | { type: "anthropic" }
  | { type: "anthropic_bedrock" }
  | { type: "open_ai" }
  | { type: "google" }
  | { type: "ollama" }
  | { type: "custom"; value: string };

export interface AgentConfig {
  provider: Provider;
  model: string;
  temperature: number;
  maxTokens: number;
  systemPromptOverride: string | null;
}

export interface Session {
  id: string;
  name: string;
  color: string;
  icon: string;
  projectRoot: string;
  agent: AgentConfig;
  tokenBudget: number | null;
  tokensUsed: number;
  tokensInput: number;
  tokensOutput: number;
  status: SessionStatus;
  contextFiles: string[];
  tags: string[];
  createdAt: string;
  lastActive: string;
}

export interface CreateSessionArgs {
  name: string;
  projectRoot: string;
  color?: string;
  icon?: string;
  agent?: AgentConfig;
  tokenBudget?: number;
  tags?: string[];
  contextFiles?: string[];
}

export interface PtyDataEvent {
  sessionId: string;
  bytes: number[];
}

export interface PtyExitEvent {
  sessionId: string;
  code: number | null;
}
