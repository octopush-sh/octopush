// The crew card — one Talk response's sub-agents (`Agent`/`Task` calls) as a
// single surface: header with the CREW eyebrow, StageDots and an aggregate
// line; one row per sub-agent with its role glyph, live activity line,
// tokens and duration. Exactly ONE row pulses brass while the crew runs (the
// longest-running one — the beacon law, spec §2); the rest hold a static
// dot. A row opens the sub-agent's work journal in the Companion; a finished
// row can also unfold its report inline.
//
// Renders in the timeline shell (outside react-markdown), so it uses design
// tokens directly — like LiveToolCard, unlike ToolCallCard.
import { useEffect, useMemo, useState } from "react";
import { Bot, ScrollText } from "lucide-react";
import { useChatStore, isAgentToolName, type AgentMeta, type LiveTool, type ToolExecution } from "../../stores/chatStore";
import type { ChatMessage } from "../../lib/types";
import type { LiveEntry } from "../../lib/ipc";
import { iconForRole } from "../../lib/roleIcons";
import { lastActivity } from "../../lib/liveLine";
import { formatDuration } from "../../lib/duration";
import { fmtTokens } from "../../lib/stageMeta";
import { prefersReducedMotion } from "../../lib/motion";
import { formatTierMix, tierMix } from "../../lib/policy";
import { StageDots } from "../direct/StageDots";
import { Reveal } from "../primitives/Reveal";
import { ChatMarkdown } from "./ChatMarkdown";

export type CrewAgentStatus = "running" | "done" | "failed";

/** One sub-agent as the card sees it — the same shape whether it comes from
 *  a live tool (running) or a resolved tool row (finished). */
export interface CrewAgent {
  callId: string;
  description: string;
  subagentType: string | null;
  /** The model the run USES (resolved id), known from the first second. */
  model: string | null;
  /** Its tier (`fast` / `balanced` / `strong`) and effort, when planned. */
  tier: string | null;
  effort: string | null;
  /** The `model` the director put on the call when it differed from what
   *  the run uses, and whether that ask was honored (under Auto a typed
   *  role keeps its tier). */
  askedModel: string | null;
  askedHonored: boolean;
  status: CrewAgentStatus;
  /** Backend start timestamp (live only) — the elapsed timer measures from here. */
  startedAt: string | null;
  durationMs: number | null;
  /** The final report (resolved only). */
  report: string | null;
  meta: AgentMeta | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** `claude-sonnet-4-6` → `sonnet-4-6`: the vendor prefix earns no space on a row. */
export function shortModel(id: string): string {
  return id.replace(/^claude-/, "");
}

/** `sonnet-4-6 · medium` — what the row says the run is on; the tier rides
 *  in the tooltip. Pure so the wording is tested. */
export function runLine(agent: Pick<CrewAgent, "model" | "effort">): string {
  const parts: string[] = [];
  if (agent.model) parts.push(shortModel(agent.model));
  if (agent.effort) parts.push(agent.effort);
  return parts.join(" · ");
}

/** Resolved `Agent` rows (one crew item of the timeline) → card rows. */
export function crewAgentsFromTools(rows: Array<{ id: number; tool: ToolExecution }>): CrewAgent[] {
  return rows.map(({ id, tool }) => {
    const meta = tool.agent ?? null;
    return {
      callId: tool.callId ?? `row-${id}`,
      description: str(tool.toolInput?.description) ?? "Sub-agent",
      subagentType: str(tool.toolInput?.subagentType),
      model: meta?.model ?? str(tool.toolInput?.model) ?? null,
      tier: meta?.tier ?? str(tool.toolInput?.tier),
      effort: meta?.effort ?? str(tool.toolInput?.effort),
      askedModel: str(tool.toolInput?.askedModel),
      askedHonored: tool.toolInput?.askedHonored !== false,
      status: meta ? (meta.ok ? "done" : "failed") : "done",
      startedAt: null,
      durationMs: meta?.durationMs ?? null,
      report: tool.result ?? "",
      meta,
    };
  });
}

/** Live `Agent` tools (between tool-start and the resolved row) → card rows. */
export function crewAgentsFromLive(tools: LiveTool[]): CrewAgent[] {
  return tools.map((t) => ({
    callId: t.callId,
    description: str(t.toolInput?.description) ?? "Sub-agent",
    subagentType: str(t.toolInput?.subagentType),
    model: str(t.toolInput?.model),
    tier: str(t.toolInput?.tier),
    effort: str(t.toolInput?.effort),
    askedModel: str(t.toolInput?.askedModel),
    askedHonored: t.toolInput?.askedHonored !== false,
    status: t.done ? (t.ok ? "done" : "failed") : "running",
    startedAt: t.startedAt,
    durationMs: t.durationMs,
    report: null,
    meta: null,
  }));
}

/** Locate one sub-agent by call id: a resolved tool row first, else a live
 *  tool. Null when the thread no longer holds it (switched, deleted). */
export function findCrewAgent(
  messages: ChatMessage[],
  live: Array<{ callId: string; toolName: string; toolInput: Record<string, unknown>; startedAt: string; done: boolean; ok: boolean; durationMs: number | null }>,
  callId: string,
): CrewAgent | null {
  for (const m of messages) {
    if (m.role !== "tool") continue;
    try {
      const tool = JSON.parse(m.content) as ToolExecution;
      if (tool.callId === callId && isAgentToolName(tool.toolName)) {
        return crewAgentsFromTools([{ id: m.id, tool }])[0];
      }
    } catch {
      /* not a tool row */
    }
  }
  const t = live.find((l) => l.callId === callId);
  return t ? crewAgentsFromLive([t as LiveTool])[0] : null;
}

/** The one row that pulses: the running sub-agent that started first (the
 *  longest-waiting, FIFO — mirrors the fleet beacon). Null when none runs. */
export function beaconCallId(agents: CrewAgent[]): string | null {
  let best: CrewAgent | null = null;
  for (const a of agents) {
    if (a.status !== "running") continue;
    if (!best) {
      best = a;
      continue;
    }
    const t = a.startedAt ? Date.parse(a.startedAt) : Number.POSITIVE_INFINITY;
    const b = best.startedAt ? Date.parse(best.startedAt) : Number.POSITIVE_INFINITY;
    if (t < b) best = a;
  }
  return best?.callId ?? null;
}

/** `2 running · 3 done · 1 failed · 61k tokens · $0.42 · 72% fast · 28% strong`
 *  — only the parts that apply. Tokens/cost come from resolved meta, so a
 *  live crew shows counts. The tier mix is the share of the crew's tokens
 *  per tier (the economy director's receipt: how much of the work ran
 *  cheap), shown once at least one row's model maps to a tier. */
export function crewSummary(agents: CrewAgent[]): string {
  const running = agents.filter((a) => a.status === "running").length;
  const done = agents.filter((a) => a.status === "done").length;
  const failed = agents.filter((a) => a.status === "failed").length;
  const parts: string[] = [];
  if (running) parts.push(`${running} running`);
  if (done) parts.push(`${done} done`);
  if (failed) parts.push(`${failed} failed`);
  const tokens = agents.reduce((n, a) => n + (a.meta ? a.meta.inputTokens + a.meta.outputTokens : 0), 0);
  const cost = agents.reduce((n, a) => n + (a.meta?.costUsd ?? 0), 0);
  if (tokens > 0) parts.push(`${fmtTokens(tokens)} tokens`);
  if (cost > 0) parts.push(`$${cost.toFixed(2)}`);
  const mix = tierMix(
    agents.map((a) => ({ tier: a.meta?.tier ?? null, tokens: a.meta ? a.meta.inputTokens + a.meta.outputTokens : 0 })),
  );
  if (mix.some(([t]) => t !== "other")) parts.push(formatTierMix(mix));
  return parts.join(" · ");
}

interface Props {
  workspaceId: string;
  agents: CrewAgent[];
}

export function CrewCard({ workspaceId, agents }: Props) {
  const [open, setOpen] = useState(true);
  const focused = useChatStore((s) => s.crewFocusByWs[workspaceId] ?? null);
  const focusCrewAgent = useChatStore((s) => s.focusCrewAgent);
  const ensureAgentLog = useChatStore((s) => s.ensureAgentLog);

  const anyRunning = agents.some((a) => a.status === "running");
  const beacon = useMemo(() => beaconCallId(agents), [agents]);
  const summary = crewSummary(agents);
  const dots = agents.map((a) => ({
    status: a.status === "running" ? "running" : a.status === "failed" ? "failed" : "done",
    title: a.description,
  }));

  // One clock for every running row (reduced motion: computed once per render).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!anyRunning || prefersReducedMotion()) return;
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, [anyRunning]);

  const openJournal = (callId: string) => {
    focusCrewAgent(workspaceId, callId);
    void ensureAgentLog(callId);
  };

  return (
    <div
      data-testid="crew-card"
      className="octo-rise-in w-full rounded-md border"
      style={{ borderColor: "var(--brass-dim)", background: "var(--brass-ghost)" }}
      aria-live={anyRunning ? "polite" : undefined}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
      >
        <span title="Sub-agents" className="shrink-0 text-octo-brass">
          <Bot size={12} strokeWidth={1.75} />
        </span>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-brass">
          Crew · <span className="octo-tabular tracking-normal">{agents.length}</span>
        </span>
        <StageDots stages={dots} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute">
          {summary}
        </span>
        <span
          aria-hidden
          className="shrink-0 font-mono text-[10px] text-octo-mute transition-transform duration-[150ms]"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        >
          ▸
        </span>
      </button>

      <Reveal open={open}>
        <div className="flex flex-col border-t border-octo-hairline">
          {agents.map((a) => (
            <CrewRow
              key={a.callId}
              agent={a}
              beacon={a.callId === beacon}
              focused={a.callId === focused}
              nowMs={nowMs}
              onOpenJournal={() => openJournal(a.callId)}
            />
          ))}
        </div>
      </Reveal>
    </div>
  );
}

function CrewRow({
  agent,
  beacon,
  focused,
  nowMs,
  onOpenJournal,
}: {
  agent: CrewAgent;
  beacon: boolean;
  focused: boolean;
  nowMs: number;
  onOpenJournal: () => void;
}) {
  const [reportOpen, setReportOpen] = useState(false);
  const entries = useChatStore((s) => s.agentLogByCall[agent.callId]) as LiveEntry[] | undefined;
  // A resolved row being continued from its journal reads as running again
  // (brass dot, live activity) until the rewritten row lands.
  const continuing = useChatStore((s) => !!s.continuingCalls[agent.callId]);
  const RoleIcon = iconForRole(agent.subagentType ?? "");
  const running = agent.status === "running" || continuing;
  const startMs = agent.startedAt ? Date.parse(agent.startedAt) : NaN;
  const shownMs =
    agent.durationMs != null
      ? agent.durationMs
      : Number.isNaN(startMs)
        ? null
        : Math.max(0, nowMs - startMs);
  // A trailing notice (an escalation to a stronger model) is the row's
  // activity until the next tool call replaces it.
  const last = entries && entries.length > 0 ? entries[entries.length - 1] : undefined;
  const activity = !running ? "" : last?.kind === "notice" ? last.text : lastActivity(entries ?? []);
  const tokens = agent.meta ? agent.meta.inputTokens + agent.meta.outputTokens : 0;
  const ending =
    agent.meta?.closedAtCap ? "turn limit" : agent.meta?.blocked ? "needs a decision" : null;
  const escalatedFrom = agent.meta?.escalatedFrom ?? null;

  return (
    <div
      data-testid="crew-row"
      data-status={agent.status}
      className="flex flex-col border-b border-octo-hairline last:border-b-0"
      style={focused ? { background: "var(--brass-ghost)" } : undefined}
    >
      <div className="flex items-center gap-2.5 px-3 py-1.5">
        {/* Status dot — the beacon row pulses; every other running row holds
            a static brass dot; finished rows read their verdict colour. */}
        <span
          aria-hidden
          data-beacon={beacon ? "true" : undefined}
          className={`h-[6px] w-[6px] shrink-0 rounded-full ${beacon ? "animate-pulse" : ""}`}
          style={{
            background: running
              ? "var(--color-octo-brass)"
              : agent.status === "done"
                ? "var(--color-octo-verdigris)"
                : "var(--color-octo-rouge)",
          }}
        />
        <span title={agent.subagentType ?? "sub-agent"} className="shrink-0 text-octo-sage">
          <RoleIcon size={11} strokeWidth={1.75} />
        </span>
        <button
          type="button"
          onClick={onOpenJournal}
          aria-pressed={focused}
          title="Open the work journal in the Companion"
          className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden text-left transition-colors duration-[180ms] hover:text-octo-brass"
        >
          <span className="min-w-[6rem] truncate text-[12px] text-octo-ivory" title={agent.description}>
            {agent.description}
          </span>
          {agent.subagentType && (
            <span className="min-w-0 truncate font-mono text-[10px] text-octo-sage">{agent.subagentType}</span>
          )}
          {runLine(agent) && (
            <span
              data-testid="crew-run-line"
              className="min-w-0 truncate font-mono text-[10px] text-octo-mute"
              title={`Runs on ${agent.model}${agent.tier ? ` (${agent.tier} tier)` : ""}${agent.effort ? ` at effort ${agent.effort}` : ""}`}
            >
              {runLine(agent)}
            </span>
          )}
          {agent.askedModel && (
            <span
              data-testid="crew-asked"
              className={`min-w-0 truncate font-mono text-[9px] uppercase tracking-[0.15em] ${agent.askedHonored ? "text-octo-sage" : "text-octo-brass"}`}
              title={
                agent.askedHonored
                  ? `The director asked for ${agent.askedModel}; the run honors it`
                  : `The director asked for ${agent.askedModel}; under Auto a typed role keeps its tier`
              }
            >
              asked {agent.askedModel}
            </span>
          )}
          {activity && (
            <span className="min-w-0 truncate font-mono text-[11px] text-octo-sage" title={activity}>
              {activity}
            </span>
          )}
          {ending && (
            <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.15em] text-octo-warning">
              {ending}
            </span>
          )}
          {escalatedFrom && (
            <span
              className="shrink-0 font-mono text-[9px] uppercase tracking-[0.15em] text-octo-brass"
              title={`First attempt on ${escalatedFrom} did not finish; retried on ${agent.meta?.model ?? agent.model ?? "a stronger model"}`}
            >
              escalated
            </span>
          )}
          {agent.meta?.continued && !continuing && (
            <span
              className="shrink-0 font-mono text-[9px] uppercase tracking-[0.15em] text-octo-brass"
              title="Given more turns from its journal; the report covers every run"
            >
              continued
            </span>
          )}
        </button>
        <span className="octo-tabular shrink-0 font-mono text-[9px] uppercase tracking-[0.15em] text-octo-mute">
          {tokens > 0 && `${fmtTokens(tokens)} · `}
          {continuing ? "continuing" : agent.status === "running" ? "running" : agent.status}
          {shownMs != null && ` · ${formatDuration(shownMs)}`}
        </span>
        {agent.report != null && (
          <button
            type="button"
            onClick={() => setReportOpen((o) => !o)}
            aria-expanded={reportOpen}
            aria-label="Show report"
            title="Show report"
            className="shrink-0 rounded p-0.5 text-octo-mute transition-colors duration-[180ms] hover:text-octo-brass"
          >
            <ScrollText size={11} strokeWidth={1.75} />
          </button>
        )}
      </div>
      {agent.report != null && (
        <Reveal open={reportOpen}>
          {/* The report is the sub-agent's prose, so it reads as Markdown
              (tables, lists, code) — unlike a tool's raw output. */}
          <div
            data-testid="crew-report-inline"
            className="octo-selectable max-h-[256px] overflow-auto border-t border-octo-hairline px-3 py-2 text-[12px] leading-[1.6] text-octo-sage"
            style={{ background: "var(--color-octo-onyx)" }}
          >
            <ChatMarkdown text={agent.report} />
          </div>
        </Reveal>
      )}
    </div>
  );
}
