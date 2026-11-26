// Registry of demo scenarios (docs/WHATS-NEW.md §4). A changeset's
// `scenario:` must name one of these keys; omitted means "default".
import type { Scenario } from "./types";
import { defaultScenario } from "./default";
import { empty } from "./empty";
import { stress } from "./stress";
import { runTwoSessions } from "./run-two-sessions";
import { runFourSessions } from "./run-four-sessions";
import { railGroups } from "./rail-groups";
import { railProjectGroups } from "./rail-project-groups";
import { railGroupsEverywhere } from "./rail-groups-everywhere";
import { directRunning } from "./direct-running";
import { talkWork } from "./talk-work";
import { talkMcp } from "./talk-mcp";
import { talkOutcomes } from "./talk-outcomes";
import { talkApproval } from "./talk-approval";

export const SCENARIOS: Record<string, Scenario> = {
  default: defaultScenario,
  empty,
  stress,
  "run-two-sessions": runTwoSessions,
  "run-four-sessions": runFourSessions,
  "rail-groups": railGroups,
  "rail-project-groups": railProjectGroups,
  "rail-groups-everywhere": railGroupsEverywhere,
  "direct-running": directRunning,
  "talk-work": talkWork,
  "talk-mcp": talkMcp,
  "talk-outcomes": talkOutcomes,
  "talk-approval": talkApproval,
};
