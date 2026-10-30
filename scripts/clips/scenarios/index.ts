// Registry of demo scenarios (docs/WHATS-NEW.md §4). A changeset's
// `scenario:` must name one of these keys; omitted means "default".
import type { Scenario } from "./types";
import { defaultScenario } from "./default";
import { empty } from "./empty";

export const SCENARIOS: Record<string, Scenario> = {
  default: defaultScenario,
  empty,
};
