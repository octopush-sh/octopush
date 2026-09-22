// Companion → a sub-agent's room (Talk). Opens when a crew-card row is
// chosen and takes the whole panel: the sub-agent's description, role,
// ending and report, its work journal (the same JournalItems the Direct
// stage focus uses), and — once it has ended — a small composer to reply
// to it or give it more turns. A run cut at its cap, stopped, or blocked on
// a question is never lost work: it resumes where it left off.
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { useChatStore } from "../stores/chatStore";
import type { ChatMessage } from "../lib/types";
import { iconForRole } from "../lib/roleIcons";
import { fmtTokens } from "../lib/stageMeta";
import { formatDuration } from "../lib/duration";
import { buildJournalItems } from "./direct/JournalItems";
import { findCrewAgent, type CrewAgent } from "./chat/CrewCard";
import { ChatMarkdown } from "./chat/ChatMarkdown";

/** The turn budgets a continuation can be given. */
export const CONTINUE_TURN_OPTIONS = [5, 15, 30] as const;
export const DEFAULT_CONTINUE_TURNS = 15;

export { findCrewAgent };

/** The phrase on the continue control: an answer for a blocked run, a
 *  reply when the user typed one, plain more turns otherwise. Pure so the
 *  wording is tested. */
export function continueLabel(agent: CrewAgent, hasText: boolean, turns: number): string {
  if (agent.meta?.blocked) return hasText ? "Answer and continue" : "Continue without an answer";
  if (hasText) return "Reply and continue";
  return `Give it ${turns} more turn${turns === 1 ? "" : "s"}`;
}

/** Whether an assistant answer follows the sub-agent's tool row — i.e. the
 *  director already went on with whatever the row held. */
export function directorAnsweredAfter(messages: ChatMessage[], callId: string | null): boolean {
  if (!callId) return false;
  let seen = false;
  for (const m of messages) {
    if (!seen) {
      if (m.role === "tool" && m.content.includes(`"callId":"${callId}"`)) seen = true;
      continue;
    }
    if (m.role === "assistant") return true;
  }
  return false;
}

/** The one-line ending of a finished sub-agent, for the meta line. */
export function statusWordFor(agent: CrewAgent, continuing: boolean): string {
  if (continuing) return "continuing";
  if (agent.status === "running") return "running";
  if (agent.meta?.closedAtCap) return "done · turn limit";
  if (agent.meta?.blocked) return "needs a decision";
  return agent.status;
}

export function CompanionCrewJournal({ workspaceId }: { workspaceId: string }) {
  const callId = useChatStore((s) => s.crewFocusByWs[workspaceId] ?? null);
  const messages = useChatStore((s) => s.getMessages(workspaceId));
  const liveTools = useChatStore((s) => s.getLiveTools(workspaceId));
  const entries = useChatStore((s) => (callId ? s.agentLogByCall[callId] : undefined));
  const continuing = useChatStore((s) => (callId ? !!s.continuingCalls[callId] : false));
  const continueError = useChatStore((s) => (callId ? s.continueErrorByCall[callId] ?? null : null));
  const focusCrewAgent = useChatStore((s) => s.focusCrewAgent);
  const ensureAgentLog = useChatStore((s) => s.ensureAgentLog);
  const continueSubagent = useChatStore((s) => s.continueSubagent);

  const agent = useMemo(
    () => (callId ? findCrewAgent(messages, liveTools, callId) : null),
    [messages, liveTools, callId],
  );
  // The director already answered after this sub-agent's row: a continuation
  // from here lands in history for the NEXT turn, and may clash with what
  // the director did meanwhile. Said plainly on the composer.
  const directorMovedOn = useMemo(() => directorAnsweredAfter(messages, callId), [messages, callId]);

  useEffect(() => {
    if (callId) void ensureAgentLog(callId);
  }, [callId, ensureAgentLog]);

  const [text, setText] = useState("");
  const [turns, setTurns] = useState<number>(DEFAULT_CONTINUE_TURNS);
  // A fresh sub-agent gets a fresh composer.
  useEffect(() => {
    setText("");
    setTurns(DEFAULT_CONTINUE_TURNS);
  }, [callId]);

  const journal = useMemo(() => buildJournalItems(entries ?? []), [entries]);

  if (!callId || !agent) return null;
  const RoleIcon = iconForRole(agent.subagentType ?? "");
  const tokens = agent.meta ? agent.meta.inputTokens + agent.meta.outputTokens : 0;
  const statusWord = statusWordFor(agent, continuing);
  // A resolved row (it has meta) can be continued; a live one is still on
  // its first run.
  const canContinue = agent.meta != null && !continuing;
  const hasText = text.trim().length > 0;

  const submit = () => {
    if (!canContinue) return;
    void continueSubagent(callId, hasText ? text.trim() : null, turns);
    setText("");
  };

  return (
    <section data-testid="crew-journal" className="octo-fade-in flex min-h-0 flex-1 flex-col">
      {/* Eyebrow bar — the same 36px rule every Companion section hangs on;
          the back control returns to the conversation sections. */}
      <div className="flex h-9 shrink-0 items-center gap-1 pl-2 pr-3">
        <button
          type="button"
          onClick={() => focusCrewAgent(workspaceId, null)}
          aria-label="Close the crew journal"
          title="Back to the conversation"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-octo-mute transition-colors hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          <ChevronLeft size={13} />
        </button>
        <h3 className="min-w-0 flex-1 truncate font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
          Crew journal
        </h3>
        <span
          data-testid="crew-journal-status"
          className={`octo-tabular shrink-0 font-mono text-[9px] uppercase tracking-[0.15em] ${
            statusWord === "running" || continuing
              ? "text-octo-brass"
              : agent.status === "failed"
                ? "text-octo-rouge"
                : "text-octo-mute"
          }`}
        >
          {statusWord}
        </span>
      </div>

      <div className="min-h-0 flex-1 px-4 pb-3 pt-1">
        <div className="flex items-center gap-2">
          <span title={agent.subagentType ?? "sub-agent"} className="shrink-0 text-octo-sage">
            <RoleIcon size={12} strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1 truncate font-serif text-[14px] text-octo-ivory">{agent.description}</div>
        </div>
        <div className="octo-tabular mt-1 font-mono text-[9px] uppercase tracking-[0.15em] text-octo-mute">
          {agent.subagentType && `${agent.subagentType} · `}
          {agent.model && `${agent.model} · `}
          {agent.tier && `${agent.tier} · `}
          {agent.effort && `effort ${agent.effort} · `}
          {statusWord}
          {tokens > 0 && ` · ${fmtTokens(tokens)} tokens`}
          {agent.meta && agent.meta.costUsd > 0 && ` · $${agent.meta.costUsd.toFixed(2)}`}
          {agent.durationMs != null && ` · ${formatDuration(agent.durationMs)}`}
          {agent.meta?.continued && " · continued"}
        </div>

        {agent.report != null && agent.report.length > 0 && (
          <>
            <div className="mt-3 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">report</div>
            <div
              data-testid="crew-report"
              className="octo-selectable mt-1 max-h-[40vh] overflow-auto rounded-md px-3 py-2 text-[12px] leading-[1.6] text-octo-sage"
              style={{ background: "var(--color-octo-onyx)" }}
            >
              <ChatMarkdown text={agent.report} />
            </div>
          </>
        )}

        <div className="mt-3 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">
          work journal · <span className="octo-tabular tracking-normal">{journal.length}</span>
        </div>
        {journal.length > 0 ? (
          <div className="mt-2 flex flex-col gap-2 text-[12px]">{journal}</div>
        ) : (
          <div className="mt-2 text-[11px] text-octo-mute">
            {agent.status === "running" || continuing ? "Waiting for the first entry." : "No journal was kept for this sub-agent."}
          </div>
        )}
      </div>

      {/* The sub-agent's own thread: reply to it, answer the question it
          stopped on, or give it more turns. Sticks to the panel's foot so
          it is reachable however long the journal grows. */}
      {agent.meta != null && (
        <div
          data-testid="crew-continue"
          className="sticky bottom-0 shrink-0 border-t border-octo-hairline bg-octo-panel px-4 py-3"
        >
          {continuing ? (
            <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.2em] text-octo-brass">
              <span aria-hidden className="h-[6px] w-[6px] animate-pulse rounded-full bg-octo-brass" />
              continuing
            </div>
          ) : (
            <>
              {directorMovedOn && (
                <div data-testid="crew-moved-on" className="mb-2 text-[11px] leading-snug text-octo-mute">
                  The director already went on with this report. A continuation updates it for the next turn and may clash with what the director did since.
                </div>
              )}
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submit();
                  }
                }}
                rows={2}
                aria-label="Reply to this sub-agent"
                placeholder={agent.meta.blocked ? "Answer the sub-agent…" : "Reply to this sub-agent…"}
                className="octo-selectable w-full resize-none rounded-md bg-octo-onyx px-2.5 py-2 text-[12px] leading-[1.5] text-octo-ivory outline-none placeholder:font-serif placeholder:text-octo-mute focus-visible:ring-1 focus-visible:ring-octo-brass"
              />
              <div className="mt-2 flex items-center gap-2">
                <label className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
                  turns
                  <select
                    value={turns}
                    onChange={(e) => setTurns(Number(e.target.value))}
                    aria-label="More turns to give"
                    title="How many more tool turns the sub-agent may take"
                    className="rounded bg-octo-onyx px-1 py-0.5 font-mono text-[10px] tracking-normal text-octo-ivory outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                  >
                    {CONTINUE_TURN_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={submit}
                  disabled={!canContinue}
                  title="Resume this sub-agent where it left off (⌘↵)"
                  className="ml-auto rounded-md px-2.5 py-1 font-serif text-[12px] text-octo-brass transition-colors duration-[180ms] hover:text-octo-brass-hi disabled:opacity-50"
                  style={{ background: "var(--brass-ghost)" }}
                >
                  {continueLabel(agent, hasText, turns)}
                </button>
              </div>
            </>
          )}
          {continueError && (
            <div role="alert" className="mt-2 text-[11px] leading-snug text-octo-rouge">
              {continueError}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
