// Companion → Crew journal (Talk). Opens when a crew-card row is chosen:
// the sub-agent's description, role, ending and report, then its work
// journal rendered by the same JournalItems the Direct stage focus uses —
// so the evidence of what a sub-agent did reads exactly like a stage's.
import { useEffect, useMemo } from "react";
import { X } from "lucide-react";
import { useChatStore, isAgentToolName, type ToolExecution } from "../stores/chatStore";
import type { ChatMessage } from "../lib/types";
import { iconForRole } from "../lib/roleIcons";
import { fmtTokens } from "../lib/stageMeta";
import { formatDuration } from "../lib/duration";
import { buildJournalItems } from "./direct/JournalItems";
import { crewAgentsFromLive, crewAgentsFromTools, type CrewAgent } from "./chat/CrewCard";
import { ChatMarkdown } from "./chat/ChatMarkdown";

/** Locate the focused sub-agent: a resolved tool row by call id, else a live
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
  return t ? crewAgentsFromLive([t])[0] : null;
}

export function CompanionCrewJournal({ workspaceId }: { workspaceId: string }) {
  const callId = useChatStore((s) => s.crewFocusByWs[workspaceId] ?? null);
  const messages = useChatStore((s) => s.getMessages(workspaceId));
  const liveTools = useChatStore((s) => s.getLiveTools(workspaceId));
  const entries = useChatStore((s) => (callId ? s.agentLogByCall[callId] : undefined));
  const focusCrewAgent = useChatStore((s) => s.focusCrewAgent);
  const ensureAgentLog = useChatStore((s) => s.ensureAgentLog);

  const agent = useMemo(
    () => (callId ? findCrewAgent(messages, liveTools, callId) : null),
    [messages, liveTools, callId],
  );

  useEffect(() => {
    if (callId) void ensureAgentLog(callId);
  }, [callId, ensureAgentLog]);

  const journal = useMemo(() => buildJournalItems(entries ?? []), [entries]);

  if (!callId || !agent) return null;
  const RoleIcon = iconForRole(agent.subagentType ?? "");
  const tokens = agent.meta ? agent.meta.inputTokens + agent.meta.outputTokens : 0;
  const statusWord =
    agent.status === "running"
      ? "running"
      : agent.meta?.closedAtCap
        ? "done · turn limit"
        : agent.meta?.blocked
          ? "needs a decision"
          : agent.status;

  return (
    <section data-testid="crew-journal" className="octo-fade-in border-t border-octo-hairline">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-octo-hairline px-4">
        <h3 className="min-w-0 flex-1 truncate font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
          Crew journal
        </h3>
        <button
          type="button"
          onClick={() => focusCrewAgent(workspaceId, null)}
          aria-label="Close the crew journal"
          title="Close"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-octo-mute transition-colors hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          <X size={12} />
        </button>
      </div>

      <div className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span title={agent.subagentType ?? "sub-agent"} className="shrink-0 text-octo-sage">
            <RoleIcon size={12} strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1 truncate font-serif text-[14px] text-octo-ivory">{agent.description}</div>
        </div>
        <div className="octo-tabular mt-1 font-mono text-[9px] uppercase tracking-[0.15em] text-octo-mute">
          {agent.subagentType && `${agent.subagentType} · `}
          {agent.model && `${agent.model} · `}
          {statusWord}
          {tokens > 0 && ` · ${fmtTokens(tokens)} tokens`}
          {agent.meta && agent.meta.costUsd > 0 && ` · $${agent.meta.costUsd.toFixed(2)}`}
          {agent.durationMs != null && ` · ${formatDuration(agent.durationMs)}`}
        </div>

        {agent.report != null && agent.report.length > 0 && (
          <>
            <div className="mt-3 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">report</div>
            <div
              data-testid="crew-report"
              className="octo-selectable mt-1 max-h-[40vh] overflow-auto rounded-md px-3 py-2 text-[12px] leading-[1.6] text-octo-sage"
              style={{ background: "var(--color-octo-onyx)", border: "1px solid var(--color-octo-hairline)" }}
            >
              <ChatMarkdown text={agent.report} />
            </div>
          </>
        )}

        <div className="mt-3 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">
          work journal · <span className="octo-tabular tracking-normal">{journal.length}</span>
        </div>
        {journal.length > 0 ? (
          <div className="mt-2 flex flex-col gap-2 text-[12px]">{journal}</div>
        ) : (
          <div className="mt-2 text-[11px] text-octo-mute">
            {agent.status === "running" ? "Waiting for the first entry." : "No journal was kept for this sub-agent."}
          </div>
        )}
      </div>
    </section>
  );
}
