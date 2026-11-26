// `talk-outcomes` — `default`, with a Talk thread whose tool calls end every
// way a call can: a `cargo test` that fails (exit 101), the fix and a pass, a
// `git push --force` the user denied, and a round of six calls (it folds) with
// one failure in it. Shows a resolved row's verdict: rouge for a failure, mute
// for a denial, nothing for a pass, and the folded round's count.
import type { Scenario } from "./types";
import type { ChatMessage } from "../../../src/lib/types";
import { defaultScenario, DEFAULT_FIXTURES } from "./default";

const { THREAD } = DEFAULT_FIXTURES;
const WS = THREAD.workspaceId;
const MODEL = "claude-sonnet-4-6";

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

type Outcome = { ok: boolean; outcome: "ok" | "failed" | "denied"; exitCode?: number };
const PASS: Outcome = { ok: true, outcome: "ok" };
const tool = (id: number, toolName: string, toolInput: Record<string, unknown>, result: string, minutesAgo: number, verdict: Outcome = PASS) =>
  row(id, "tool", JSON.stringify({ callId: `c${id}`, toolName, toolInput, result, ...verdict }), minutesAgo);

const FAILING_TEST = [
  "running 9 tests",
  "test sync::tests::uploads_only_when_opted_in ... FAILED",
  "",
  "failures:",
  "    sync::tests::uploads_only_when_opted_in: assertion failed: !should_upload(&prefs, &run)",
  "",
  "test result: FAILED. 8 passed; 1 failed",
  "(exit code 101)",
].join("\n");

const DENIED_PUSH =
  "Command not run — the user declined to approve it (flagged: rewrites published history). " +
  "Ask the user how to proceed or try a safer alternative.";

const MESSAGES: ChatMessage[] = [
  row(1, "user", "Make run-history sync opt-in and push the branch.", 42),
  row(2, "assistant_tool_use", "I'll gate the upload on the preference and run the sync tests.", 42),
  tool(3, "edit_file", { path: "src-tauri/src/sync.rs" }, "ok", 41),
  tool(4, "run_command", { command: "cargo test sync" }, FAILING_TEST, 41, { ok: false, outcome: "failed", exitCode: 101 }),
  row(5, "assistant_tool_use", "The default still uploads. I'll default the preference to off and run the whole suite.", 40),
  tool(6, "edit_file", { path: "src-tauri/src/settings.rs" }, "ok", 40),
  tool(7, "read_file", { path: "src-tauri/src/settings.rs" }, "…", 40),
  tool(8, "grep", { pattern: "history_sync" }, "src-tauri/src/settings.rs:12", 40),
  tool(9, "run_command", { command: "npm run lint" }, "✖ 1 problem (1 error)\n(exit code 1)", 39, { ok: false, outcome: "failed", exitCode: 1 }),
  tool(10, "edit_file", { path: "src/components/settings/AccountPane.tsx" }, "ok", 39),
  tool(11, "run_command", { command: "cargo test sync" }, "test result: ok. 9 passed", 38, { ok: true, outcome: "ok", exitCode: 0 }),
  row(12, "assistant_tool_use", "Tests pass. The branch was rebased, so it needs a force push.", 38),
  tool(13, "run_command", { command: "git push --force origin sync-opt-in" }, DENIED_PUSH, 37, { ok: false, outcome: "denied" }),
  row(14, "assistant", "Sync is opt-in and the tests pass. I didn't push: you declined the force push. Say if you want a regular push to a new branch instead.", 37, {
    inputTokens: 3_100, outputTokens: 640, cacheReadTokens: 120_000, cacheCreationTokens: 4_000, contextTokens: 128_000, costUsd: 0.21,
  }),
];

export const talkOutcomes: Scenario = {
  ...defaultScenario,
  name: "talk-outcomes",
  description: "`default` with a Talk thread whose calls fail, pass and are denied, and a folded round with a failure in it.",
  commands: {
    ...defaultScenario.commands,
    list_chat_messages: (a) => (a.threadId === THREAD.id ? MESSAGES : []),
  },
};
