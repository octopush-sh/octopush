// `talk-work` — `default`, with a longer Talk thread in the active workspace:
// an ask, the model's narration and two rounds of tool calls (the second has
// six calls, so it folds into one summary row), a long answer with code and a
// list, a short follow-up and its answer. Shows how turns read apart: the ask
// on the panel, the work on one hairline, the answer flush.
import type { Scenario } from "./types";
import type { ChatMessage } from "../../../src/lib/types";
import { defaultScenario, DEFAULT_FIXTURES } from "./default";

const { THREAD } = DEFAULT_FIXTURES;
const WS = THREAD.workspaceId;
const MODEL = "claude-sonnet-4-6";

// Minutes before the page loads, so each turn's header reads as today's time.
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const row = (id: number, role: string, content: string, minutesAgo: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  workspaceId: WS,
  role: role as ChatMessage["role"],
  content,
  model: role === "user" || role === "tool" ? null : MODEL,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  createdAt: at(minutesAgo),
  ...extra,
});
const tool = (id: number, toolName: string, toolInput: Record<string, unknown>, result: string, minutesAgo: number) =>
  row(id, "tool", JSON.stringify({ toolName, toolInput, result }), minutesAgo);

const ANSWER = [
  "The upload gate is `should_upload`, and it returned `true` for every finished run, so history synced whether or not you wanted it.",
  "",
  "It now reads the per-account `history_sync` preference, which defaults to off. Nothing leaves the Mac until you turn it on in Settings › Account:",
  "",
  "```rust",
  "pub fn should_upload(prefs: &SyncPrefs, run: &Run) -> bool {",
  "    // Opt-in: nothing leaves the machine until the user turns it on.",
  "    prefs.history_sync && run.is_finished()",
  "}",
  "```",
  "",
  "What changed:",
  "",
  "1. `src-tauri/src/sync.rs` gates uploads on the preference.",
  "2. `src-tauri/src/settings.rs` defaults `history_sync` to `false` for new and existing accounts.",
  "3. The Account pane says, under the toggle, what turning it off does.",
  "",
  "`cargo test sync` and the Account pane tests pass.",
].join("\n");

const FOLLOW_UP_ANSWER = [
  "No. Turning it off stops future uploads; runs that already synced stay where they are.",
  "",
  "- `should_upload` only decides what happens to the next finished run.",
  "- Nothing in this change deletes data that already left the Mac.",
].join("\n");

const MESSAGES: ChatMessage[] = [
  row(1, "user", "Make run-history sync opt-in: off by default. Add a note under the toggle that says what turning it off does.", 42),
  row(2, "assistant_tool_use", "Let me find where the app decides to upload a run.", 42),
  tool(3, "grep", { pattern: "should_upload" }, "src-tauri/src/sync.rs:18", 41),
  tool(4, "read_file", { path: "src-tauri/src/sync.rs" }, "pub fn should_upload(…) -> bool {\n    true\n}", 41),
  tool(5, "read_file", { path: "src/components/settings/AccountPane.tsx" }, "…", 41),
  row(6, "assistant_tool_use", "The gate returns true unconditionally. I'll read the preference, default it off, add the note and run the tests.", 40),
  tool(7, "edit_file", { path: "src-tauri/src/sync.rs" }, "ok", 40),
  tool(8, "edit_file", { path: "src-tauri/src/settings.rs" }, "ok", 40),
  tool(9, "edit_file", { path: "src/components/settings/AccountPane.tsx" }, "ok", 39),
  tool(10, "write_file", { path: "src/components/settings/AccountPane.test.tsx" }, "ok", 39),
  tool(11, "run_command", { command: "cargo test sync" }, "test result: ok. 9 passed", 38),
  tool(12, "run_command", { command: "npm test -- AccountPane" }, "Tests  4 passed (4)", 38),
  row(13, "assistant", ANSWER, 37, {
    inputTokens: 3_100, outputTokens: 2_100, cacheReadTokens: 200_000, cacheCreationTokens: 8_000, contextTokens: 211_000, costUsd: 0.42,
  }),
  row(14, "user", "Does turning it off delete what was already uploaded?", 12),
  row(15, "assistant", FOLLOW_UP_ANSWER, 11, {
    inputTokens: 900, outputTokens: 640, cacheReadTokens: 212_000, cacheCreationTokens: 0, contextTokens: 213_000, costUsd: 0.05,
  }),
];

export const talkWork: Scenario = {
  ...defaultScenario,
  name: "talk-work",
  description: "`default` with a longer Talk thread: two asks, narration, two rounds of tool calls (one folds), a long answer and a short one.",
  commands: {
    ...defaultScenario.commands,
    list_chat_messages: (a) => (a.threadId === THREAD.id ? MESSAGES : []),
  },
};
