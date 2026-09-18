/** `Agent` and its `Task` alias — the Talk sub-agent fan-out tool. Both names
 *  are one tool backend-side. Lives here (no store import) so leaf components
 *  such as the Player can ask without pulling the chat store's Tauri listeners
 *  into their module graph. */
export function isAgentToolName(name: string): boolean {
  return name === "Agent" || name === "Task";
}

/** Live journal entry of a Talk sub-agent: `{ workspaceId, threadId, callId, entry }`
 *  where `entry` is the same `LiveEntry` shape a Direct stage emits on `run://log`. */
export const CHAT_AGENT_LOG_EVENT = "chat://agent-log";
