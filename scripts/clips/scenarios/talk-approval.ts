// `talk-approval` — `default`, with a Talk turn parked on an approval card in
// the active workspace: the agent ran the tests, then asked to force-push a
// rebased branch. The card comes back the way a reloaded window gets it
// (`pending_approvals`), so it is on screen from the first frame and waits
// until it is answered.
import type { Scenario } from "./types";
import type { ChatMessage } from "../../../src/lib/types";
import { defaultScenario, DEFAULT_FIXTURES } from "./default";

const { THREAD } = DEFAULT_FIXTURES;
const WS = THREAD.workspaceId;
const MODEL = "claude-sonnet-4-6";

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const row = (id: number, role: string, content: string, minutesAgo: number): ChatMessage => ({
  id,
  workspaceId: WS,
  role: role as ChatMessage["role"],
  content,
  model: role === "user" || role === "tool" ? null : MODEL,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  createdAt: at(minutesAgo),
});
const tool = (id: number, toolName: string, toolInput: Record<string, unknown>, result: string, minutesAgo: number) =>
  row(id, "tool", JSON.stringify({ callId: `c${id}`, toolName, toolInput, result, ok: true, outcome: "ok" }), minutesAgo);

const MESSAGES: ChatMessage[] = [
  row(1, "user", "Rebase the sync branch on main, run the tests and push it.", 6),
  row(2, "assistant_tool_use", "I'll rebase, run the sync tests, then push.", 6),
  tool(3, "run_command", { command: "git rebase origin/main" }, "Successfully rebased and updated refs/heads/run-history-sync.", 5),
  tool(4, "run_command", { command: "cargo test sync" }, "test result: ok. 9 passed", 4),
  row(5, "assistant_tool_use", "Tests pass. The branch was rebased, so it needs a force push.", 3),
];

export const PENDING_APPROVAL = {
  workspaceId: WS,
  threadId: THREAD.id,
  callId: "toolu-push",
  command: "git push --force-with-lease origin run-history-sync",
  reason: "force push (rewrites remote history)",
};

export const talkApproval: Scenario = {
  ...defaultScenario,
  name: "talk-approval",
  description: "`default` with a Talk turn parked on an approval card (a force push) in the active workspace.",
  commands: {
    ...defaultScenario.commands,
    list_chat_messages: (a) => (a.threadId === THREAD.id ? MESSAGES : []),
    pending_approvals: (a) => (a.threadId === THREAD.id ? [PENDING_APPROVAL] : []),
  },
};
