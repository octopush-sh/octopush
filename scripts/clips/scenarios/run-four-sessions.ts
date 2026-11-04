// `run-four-sessions` — `default`, with four terminal sessions (a shell,
// Claude Code, a test watcher and a dev server) in the active workspace, so
// Run can show three and then four panes.
import type { Scenario } from "./types";
import type { TerminalRecord } from "../../../src/lib/types";
import { defaultScenario, DEFAULT_FIXTURES } from "./default";

const ACTIVE = DEFAULT_FIXTURES.WORKSPACES[1];
const AT = Date.parse("2026-11-03T09:00:00Z");

const SESSIONS: TerminalRecord[] = [
  { id: "term-shell", workspaceId: ACTIVE.id, label: "zsh", position: 0, createdAt: AT },
  { id: "term-claude", workspaceId: ACTIVE.id, label: "claude", position: 1, createdAt: AT + 1 },
  { id: "term-tests", workspaceId: ACTIVE.id, label: "tests", position: 2, createdAt: AT + 2 },
  { id: "term-dev", workspaceId: ACTIVE.id, label: "dev", position: 3, createdAt: AT + 3 },
];

export const runFourSessions: Scenario = {
  ...defaultScenario,
  name: "run-four-sessions",
  description: "`default` with four sessions (zsh, claude, tests and dev) in the active workspace.",
  commands: {
    ...defaultScenario.commands,
    list_terminals: (a) => (a.workspaceId === ACTIVE.id ? SESSIONS : []),
  },
};
