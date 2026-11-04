// `run-two-sessions` — `default`, with two terminal sessions (a shell and
// Claude Code) in the active workspace, so Run offers Open beside.
import type { Scenario } from "./types";
import type { TerminalRecord } from "../../../src/lib/types";
import { defaultScenario, DEFAULT_FIXTURES } from "./default";

const ACTIVE = DEFAULT_FIXTURES.WORKSPACES[1];
const AT = Date.parse("2026-11-03T09:00:00Z");

const SESSIONS: TerminalRecord[] = [
  { id: "term-shell", workspaceId: ACTIVE.id, label: "zsh", position: 0, createdAt: AT },
  { id: "term-claude", workspaceId: ACTIVE.id, label: "claude", position: 1, createdAt: AT + 1 },
];

export const runTwoSessions: Scenario = {
  ...defaultScenario,
  name: "run-two-sessions",
  description: "`default` with two sessions (zsh and claude) in the active workspace.",
  commands: {
    ...defaultScenario.commands,
    list_terminals: (a) => (a.workspaceId === ACTIVE.id ? SESSIONS : []),
  },
};
