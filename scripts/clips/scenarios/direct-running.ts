// `direct-running` — `default`, plus a crew at work in the active workspace:
// its current stage (Implement) runs on Claude Code, the CLI substrate, and
// has reported a context reading of 142k of a 200k window (`ctx 71%`). It
// carries no effort, escalation or ran-on note, so the run card keeps the
// reading on its meta line instead of shedding it (#981).
import type { Scenario } from "./types";
import type { Run, RunDetail, RunStage } from "../../../src/lib/ipc";
import { defaultScenario, DEFAULT_FIXTURES } from "./default";

const { RUN, RUN_STAGES } = DEFAULT_FIXTURES;

// Started a few minutes before the page loads, so the timers read like a
// crew at work rather than a fixture from last week.
const STARTED = new Date(Date.now() - 6 * 60_000).toISOString();
const PLAN_DONE = new Date(Date.now() - 4 * 60_000).toISOString();

const LIVE_RUN: Run = {
  ...RUN,
  id: "run-live",
  task: "Show how full a running stage's context is",
  status: "running",
  costUsd: 0.21,
  baselineUsd: 0.94,
  createdAt: STARTED,
  finishedAt: null,
};

const CURRENT = 1;

const LIVE_STAGES: RunStage[] = RUN_STAGES.map((s, i) => ({
  ...s,
  id: `rs-live-${i}`,
  runId: LIVE_RUN.id,
  substrate: "cli",
  effort: null,
  escalateModel: null,
  escalated: false,
  ranModel: null,
  status: i < CURRENT ? "done" : i === CURRENT ? "running" : "pending",
  inputTokens: i < CURRENT ? s.inputTokens : 0,
  outputTokens: i < CURRENT ? s.outputTokens : 0,
  costUsd: i < CURRENT ? s.costUsd : 0,
  artifact: i < CURRENT ? s.artifact : null,
  diffSnapshot: null,
  startedAt: i <= CURRENT ? (i < CURRENT ? STARTED : PLAN_DONE) : null,
  finishedAt: i < CURRENT ? PLAN_DONE : null,
  contextTokens: i === CURRENT ? 142_000 : null,
  contextWindow: i === CURRENT ? 200_000 : null,
}));

const LIVE_DETAIL: RunDetail = { run: LIVE_RUN, stages: LIVE_STAGES };

export const directRunning: Scenario = {
  ...defaultScenario,
  name: "direct-running",
  description:
    "`default` with a crew at work in the active workspace: its Implement stage runs on Claude Code with a context reading of 142k / 200k (ctx 71%).",
  commands: {
    ...defaultScenario.commands,
    list_runs: (a) => (a.workspaceId === RUN.workspaceId ? [LIVE_RUN, RUN] : []),
    get_run: (a) =>
      a.runId === LIVE_RUN.id ? LIVE_DETAIL : a.runId === RUN.id ? { run: RUN, stages: RUN_STAGES } : { run: null, stages: [] },
    list_active_runs: [LIVE_RUN],
  },
};
