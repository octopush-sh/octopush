// `talk-mcp` — `default`, with three MCP servers configured for the active
// workspace: `docs-server` connected with 12 tools, `example-remote` failed to
// start, `issue-tracker` not started yet and switched off in the open
// conversation. Shows the Companion's "can use" chips and their states.
import type { Scenario } from "./types";
import type { McpServerStatus } from "../../../src/lib/types";
import { defaultScenario, DEFAULT_FIXTURES } from "./default";

const { THREAD } = DEFAULT_FIXTURES;

const STATUS = [
  { name: "docs-server", state: "connected", tools: 12, reason: null },
  { name: "example-remote", state: "failed", tools: null, reason: "Octopush couldn't find `example-mcp` on the PATH Octopush searched." },
  { name: "issue-tracker", state: "idle", tools: null, reason: null },
] satisfies McpServerStatus[];

// Toggles last until the page reloads.
const off: Record<string, string[]> = { [THREAD.id]: ["issue-tracker"] };

export const talkMcp: Scenario = {
  ...defaultScenario,
  name: "talk-mcp",
  description: "`default` with three MCP servers in the Companion's \"can use\" row: one connected, one failed, one off in the open conversation.",
  commands: {
    ...defaultScenario.commands,
    list_mcp_server_status: STATUS,
    get_thread_mcp_disabled: (a) => off[String(a.threadId)] ?? [],
    set_thread_mcp_disabled: (a) => {
      off[String(a.threadId)] = a.servers as string[];
      return null;
    },
  },
};
