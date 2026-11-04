// Registry of demo scenarios (docs/WHATS-NEW.md §4). A changeset's
// `scenario:` must name one of these keys; omitted means "default".
import type { Scenario } from "./types";
import { defaultScenario } from "./default";
import { empty } from "./empty";
import { stress } from "./stress";
import { runTwoSessions } from "./run-two-sessions";
import { runFourSessions } from "./run-four-sessions";

export const SCENARIOS: Record<string, Scenario> = {
  default: defaultScenario,
  empty,
  stress,
  "run-two-sessions": runTwoSessions,
  "run-four-sessions": runFourSessions,
};
