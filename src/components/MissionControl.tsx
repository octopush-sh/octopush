// Mission Control — the fleet cockpit. Every Direct run across every workspace
// as a live crew card in one full-screen room: triage bands (Needs you / In
// flight / Settled), a live activity ticker per crew, and the fleet ledger.
// Design record: docs/superpowers/plans/2026-07-09-mission-control-design.md.
//
// Deliberate non-goals (v1): no checkpoint resolution on-card (approving a gate
// without the artifact/diff is rubber-stamping — the card jumps to the Direct
// canvas instead), no launching, no history (HistorySheet owns the past). The
// one on-card decision is an `ask_director` question-block: the director can
// read the questions and accept the crew's recommended defaults in place (the
// acceptance is journaled); any other answer still opens the full form.
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronRight, Hammer, MessageSquare, Moon, Plus, Square, Terminal, X } from "lucide-react";
import type { Run, RunStage } from "../lib/ipc";
import { useRunsStore } from "../stores/runsStore";
import { useWorkspaceStore, findWorkspaceName } from "../stores/workspaceStore";
import { useAttentionStore } from "../stores/attentionStore";
import { useMissionsStore } from "../stores/missionsStore";
import { INTENT_ICON } from "../lib/missionIntent";
import { runStatusMeta, isTransientHalt } from "../lib/runStatus";
import { lastActivity } from "../lib/liveLine";
import { stageTitle } from "../lib/stageMeta";
import { OverlayRoom, RoomClose } from "./primitives/OverlayRoom";
import { StageDots } from "./direct/StageDots";
import { Reveal } from "./primitives/Reveal";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Jump to a run's workspace + Direct surface (App closes the room first). */
  onJumpToRun: (workspaceId: string) => void;
  /** Jump to a mission's Talk (chat) or terminal (run) surface that's waiting. */
  onJumpToAttention: (workspaceId: string, kind: "chat" | "terminal") => void;
  /** "Send out a crew" — Direct mode in the current workspace. */
  onDispatch: () => void;
}

/** A run's board band. `paused` always means a human must act in this engine
 *  (gate / halted stage / budget park / director pause) — that IS "needs you". */
type Band = "needs-you" | "in-flight" | "settled";

/** A non-run mission surface waiting on the director: a Talk conversation that
 *  finished streaming, or a terminal that rang its bell. Always "needs you". */
type AttentionItem = {
  kind: "attention";
  workspaceId: string;
  missionTitle: string | null;
  flag: "chat" | "terminal";
  at: number;
};
/** The board renders a discriminated union so runs and attention surfaces share
 *  one FIFO-sorted needs-you band under the single-beacon law. */
type BoardItem = { kind: "run"; run: Run } | AttentionItem;

const EMPTY_STAGES: RunStage[] = [];

export function MissionControl({ open, onClose, onJumpToRun, onJumpToAttention, onDispatch }: Props) {
  const runsByWs = useRunsStore((s) => s.runsByWs);
  const settledAt = useRunsStore((s) => s.settledAt);
  const statusSince = useRunsStore((s) => s.statusSince);
  const refreshDetail = useRunsStore((s) => s.refreshDetail);
  const awayRunIds = useRunsStore((s) => s.awayRunIds);
  const flagsByWs = useAttentionStore((s) => s.flagsByWs);
  const missionByWorkspaceId = useMissionsStore((s) => s.missionByWorkspaceId);

  // The board: paused runs + attention (chats/terminals waiting on you) in
  // "needs you", running runs in flight, and this session's settled
  // (undismissed). Attention items are always needs-you — a human is waiting.
  const board = useMemo(() => {
    const all = Object.values(runsByWs).flat();
    const paused = all.filter((r) => r.status === "paused");
    const running = all.filter((r) => r.status === "running");
    const settled = all.filter((r) => r.id in settledAt);
    const runSince = (r: Run) => {
      if (statusSince[r.id] !== undefined) return statusSince[r.id];
      const t = Date.parse(r.createdAt);
      return Number.isNaN(t) ? 0 : t;
    };
    const attention: AttentionItem[] = Object.entries(flagsByWs).map(([workspaceId, flag]) => ({
      kind: "attention" as const,
      workspaceId,
      missionTitle: missionByWorkspaceId[workspaceId]?.title ?? null,
      flag: flag.kind,
      at: flag.at,
    }));
    const itemSince = (it: BoardItem) => (it.kind === "run" ? runSince(it.run) : it.at);
    const needsYou: BoardItem[] = [
      ...paused.map((r) => ({ kind: "run" as const, run: r })),
      ...attention,
    ].sort((a, b) => itemSince(a) - itemSince(b));
    return {
      needsYou,
      inFlight: running.sort((a, b) => runSince(a) - runSince(b)),
      settled: settled.sort((a, b) => runSince(a) - runSince(b)),
      paused,
    };
  }, [runsByWs, settledAt, statusSince, flagsByWs, missionByWorkspaceId]);

  // Runs only, for stage hydration + the fleet ledger (attention items carry no
  // run/cost of their own).
  const boardRuns = useMemo(
    () => [...board.paused, ...board.inFlight, ...board.settled],
    [board],
  );

  // Hydrate stage detail for any board run that hasn't streamed one yet (e.g.
  // background runs restored at launch) so the micro-track can render. Reads
  // detailByRun imperatively — subscribing to the whole map here would churn
  // this component on every stage event even while the room is closed.
  const boardIds = boardRuns.map((r) => r.id).join(",");
  useEffect(() => {
    if (!open) return;
    const detailByRun = useRunsStore.getState().detailByRun;
    for (const run of boardRuns) {
      if (!detailByRun[run.id]) void refreshDetail(run.id);
    }
    // boardIds is the identity of boardRuns; detail arrival must not re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, boardIds]);

  if (!open) return null;

  // Fleet ledger over the ACTIVE crews — the A3 "combined live cost" semantics:
  // a live burn-rate figure, never inflated by this session's settled runs
  // (each settled card carries its own cost). Savings-first, per the Direct
  // ledger convention.
  const activeRuns = [...board.paused, ...board.inFlight];
  const spent = activeRuns.reduce((sum, r) => sum + r.costUsd, 0);
  const baseline = activeRuns.reduce((sum, r) => sum + r.baselineUsd, 0);
  const saved = Math.max(0, baseline - spent);
  const savedPct = baseline > 0 ? Math.round((saved / baseline) * 100) : 0;

  const counts: Array<{ n: number; label: string; cls: string }> = [
    { n: board.needsYou.length, label: "need you", cls: "text-octo-brass" },
    { n: board.inFlight.length, label: "in flight", cls: "text-octo-verdigris" },
    { n: board.settled.length, label: "settled", cls: "text-octo-mute" },
  ];

  // Empty covers runs AND attention — an attention-only board is not "quiet".
  const isEmpty =
    board.needsYou.length === 0 && board.inFlight.length === 0 && board.settled.length === 0;

  // "While you were away" — the settled cards seeded at launch that are still
  // on the board. Dismissing a card takes it off this line too.
  const away = awayLine(board.settled, awayRunIds);

  return (
    <OverlayRoom onClose={onClose} ariaLabel="Mission Control">
      <header className="border-b border-octo-hairline px-8 py-6">
        <div className="flex items-baseline gap-4">
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
            Mission Control
          </span>
          <span className="flex min-w-0 items-baseline gap-2 font-mono text-[11px]">
            {counts
              .filter((c) => c.n > 0)
              .map((c, i) => (
                <span key={c.label} className="flex items-baseline gap-2 whitespace-nowrap">
                  {i > 0 && <span className="text-octo-mute">·</span>}
                  <span className={`octo-tabular ${c.cls}`}>
                    {c.n} {c.label}
                  </span>
                </span>
              ))}
          </span>
          <span className="ml-auto flex shrink-0 items-baseline gap-3">
            {activeRuns.length > 0 && (
              <span
                className="hidden items-baseline gap-2 font-mono text-[11px] sm:flex"
                title="Combined live cost across all active runs"
              >
                {baseline > 0 && (
                  <>
                    <span className="octo-tabular text-octo-verdigris">saved ${saved.toFixed(2)}</span>
                    <span className="text-octo-mute">· {savedPct}% under all-premium ·</span>
                  </>
                )}
                <span className="octo-tabular text-octo-brass">spent ${spent.toFixed(2)}</span>
              </span>
            )}
            <button
              type="button"
              onClick={onDispatch}
              aria-label="Send out a crew"
              title="Send out a crew"
              className="flex shrink-0 items-center justify-center self-center rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
            >
              <Plus size={12} />
            </button>
            <RoomClose onClose={onClose} label="Close Mission Control" />
          </span>
        </div>
        {away && (
          <p
            data-tour="mission-control-away"
            className="octo-rise-in mt-2 font-mono text-[11px] text-octo-sage"
            title="Runs that settled while Octopush was closed"
          >
            While you were away · <span className="octo-tabular">{away.count}</span> settled ·{" "}
            <span className="octo-tabular">{away.saved}</span>
          </p>
        )}
      </header>

      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-5 p-8">
          <p className="font-serif text-[22px] tracking-[-0.005em] text-octo-sage">
            The floor is quiet.
          </p>
          <button
            type="button"
            onClick={onDispatch}
            className="rounded-lg border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-4 py-2 font-serif text-sm text-octo-brass"
          >
            Send out a crew
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-8 pb-8">
          <BandSection title="Needs you" items={board.needsYou} band="needs-you" onJumpToRun={onJumpToRun} onJumpToAttention={onJumpToAttention} />
          <BandSection title="In flight" items={board.inFlight.map((r) => ({ kind: "run" as const, run: r }))} band="in-flight" onJumpToRun={onJumpToRun} onJumpToAttention={onJumpToAttention} />
          <BandSection title="Settled" items={board.settled.map((r) => ({ kind: "run" as const, run: r }))} band="settled" onJumpToRun={onJumpToRun} onJumpToAttention={onJumpToAttention} />
        </div>
      )}
    </OverlayRoom>
  );
}

function BandSection({
  title,
  items,
  band,
  onJumpToRun,
  onJumpToAttention,
}: {
  title: string;
  items: BoardItem[];
  band: Band;
  onJumpToRun: (workspaceId: string) => void;
  onJumpToAttention: (workspaceId: string, kind: "chat" | "terminal") => void;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <div className="flex h-11 items-center font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">
        {title}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(380px,1fr))] items-start gap-4">
        {items.map((item, i) =>
          item.kind === "run" ? (
            <CrewCard key={item.run.id} run={item.run} band={band} index={i} onJumpToRun={onJumpToRun} />
          ) : (
            <AttentionCard
              key={`att:${item.workspaceId}:${item.flag}`}
              item={item}
              index={i}
              onJump={onJumpToAttention}
            />
          ),
        )}
      </div>
    </section>
  );
}

/** A non-run mission waiting on the director (a finished Talk conversation or a
 *  terminal bell). Same card geometry family as CrewCard, minus the run-only
 *  rows. Lives only in the needs-you band, so it carries the brass border and
 *  joins the single-beacon law (index 0 of the band pulses). */
function AttentionCard({
  item,
  index,
  onJump,
}: {
  item: AttentionItem;
  index: number;
  onJump: (workspaceId: string, kind: "chat" | "terminal") => void;
}) {
  const wsName = useWorkspaceName(item.workspaceId);
  const inState = useTimeInState(new Date(item.at).toISOString());
  const title = item.missionTitle || wsName || "mission";
  const Icon = item.flag === "chat" ? MessageSquare : Terminal;
  const word = item.flag === "chat" ? "waiting in Talk" : "terminal bell";
  const brief =
    item.flag === "chat" ? "A conversation finished — your move." : "A terminal is asking for input.";
  const isLongestWaiting = index === 0;
  // Mirror CrewCard's guard: a workspace whose project is closed still shows,
  // but jump-to is disabled — we can't navigate to an unloaded workspace.
  const canJump = wsName !== null;
  const jump = () => onJump(item.workspaceId, item.flag);
  const jumpProps = canJump
    ? {
        role: "button" as const,
        tabIndex: 0,
        onClick: jump,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            jump();
          }
        },
        "aria-label": `Open ${title} — ${word}`,
      }
    : { title: "Open this mission's project to view it" };

  return (
    <div
      {...jumpProps}
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
      className={`octo-rise-in group relative flex flex-col gap-1.5 rounded-lg border border-octo-brass bg-octo-panel px-4 py-3 text-left transition duration-[180ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass ${canJump ? "cursor-pointer" : ""} ${isLongestWaiting ? "octo-stage-pulse" : ""}`}
    >
      {/* Row 1 — glyph · word · time waiting. */}
      <span className="flex h-4 items-center gap-1.5 font-mono text-[10px]">
        <Icon size={11} aria-hidden className="text-octo-brass" />
        <span className="truncate uppercase tracking-[0.25em] text-octo-mute">{word}</span>
        <span
          className="octo-tabular ml-auto w-[7ch] shrink-0 text-right text-octo-mute"
          title="Time waiting"
        >
          {inState}
        </span>
      </span>

      {/* Row 2 — mission. */}
      <span className="flex h-5 items-baseline gap-2">
        <span className="min-w-0 truncate font-serif text-[15px] text-octo-ivory" title={title}>
          {title}
        </span>
      </span>

      {/* Row 3 — the brief. */}
      <span className="block h-4 truncate text-[12px] leading-4 text-octo-sage">{brief}</span>
    </div>
  );
}

function CrewCard({
  run,
  band,
  index,
  onJumpToRun,
}: {
  run: Run;
  band: Band;
  index: number;
  onJumpToRun: (workspaceId: string) => void;
}) {
  const stages = useRunsStore((s) => s.detailByRun[run.id]?.stages ?? EMPTY_STAGES);
  const statusSinceMs = useRunsStore((s) => s.statusSince[run.id]);
  const wsName = useWorkspaceName(run.workspaceId);
  const missionIntent = useMissionsStore(
    (s) => s.missionByWorkspaceId[run.workspaceId]?.intent ?? null,
  );
  // A run whose workspace isn't loaded (project closed/removed) still shows —
  // and can be aborted — but jump-to is disabled: we can't navigate to an
  // unloaded workspace. (Same guard the old tray popover carried.)
  const canJump = wsName !== null;

  // Time-in-state — session-observed transition time, falling back to the
  // run's start for launch-hydrated rows. Fixed-width tabular slot (S2);
  // rolls to hours so long-lived background runs never overflow it.
  const sinceIso = useMemo(() => {
    const ms = statusSinceMs ?? Date.parse(run.createdAt);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }, [statusSinceMs, run.createdAt]);
  const inState = useTimeInState(band === "settled" ? null : sinceIso);

  const meta = runStatusMeta(run.status);

  // What the paused run is actually waiting on — enriches glyph/word/ticker.
  const gateStage = stages.find((s) => s.status === "awaiting_checkpoint");
  // A stage parked via `ask_director` is a QUESTION-block, not an approval gate:
  // an answer form is waiting, not an approve/reject. Distinguish it so the
  // director can tell the two apart at a glance on the fleet board.
  const askedStage = gateStage?.blockedQuestions ? gateStage : undefined;
  const failedStage = stages.find((s) => s.status === "failed");
  const stalled = !!failedStage && isTransientHalt(failedStage.error);
  const runningStage = stages.find((s) => s.status === "running");

  const glyph =
    band === "needs-you" && stalled
      ? { label: "⟳", cls: "text-octo-warning", word: "stalled" }
      : band === "needs-you" && failedStage
        ? { label: "✕", cls: "text-octo-rouge", word: "halted" }
        : band === "needs-you" && askedStage
          ? { label: "?", cls: "text-octo-brass", word: "asked you" }
          : band === "needs-you" && gateStage
            ? { label: "⟜", cls: "text-octo-brass", word: "at the gate" }
            : { label: meta.glyph, cls: meta.className, word: meta.word };

  // Needs-you cards carry the brass border; everything else stays hairline
  // (position in the band is the salience). Law 2 fleet scope: exactly one
  // card pulses at a time — the longest-waiting needs-you card (index 0; the
  // band's runs arrive fifo-sorted, oldest first). Every other needs-you card
  // keeps the brass border, calm, no pulse.
  const isLongestWaiting = band === "needs-you" && index === 0;
  const skin =
    band === "needs-you"
      ? `border-octo-brass ${isLongestWaiting ? "octo-stage-pulse" : ""}`
      : "border-octo-hairline hover:border-[var(--brass-dim)]";

  // Law 1 ink grading by band: needs-you full ink, in-flight 75%, settled 45%
  // rising to 85% on hover/focus (progressive disclosure, nothing removed).
  const ink =
    band === "in-flight"
      ? "opacity-75"
      : band === "settled"
        ? "opacity-45 hover:opacity-85 focus-within:opacity-85"
        : "";

  // The whole card jumps to the crew's workspace. A div-with-role (not a
  // <button>) so inner action buttons stay valid HTML and child `title`
  // tooltips (truncated task, per-stage track) keep working. Cards for
  // unloaded workspaces render inert (no role/click) with an explaining title.
  const jump = () => onJumpToRun(run.workspaceId);
  const jumpProps = canJump
    ? {
        role: "button" as const,
        tabIndex: 0,
        onClick: jump,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.target !== e.currentTarget) return; // inner buttons keep their keys
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            jump();
          }
        },
        "aria-label": `Open ${wsName} — ${run.task}`,
        title: undefined,
      }
    : { title: "Open this run's project to view it" };

  return (
    <div
      {...jumpProps}
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
      className={`octo-rise-in group relative flex flex-col gap-1.5 rounded-lg border bg-octo-panel px-4 py-3 text-left transition duration-[180ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass ${canJump ? "cursor-pointer" : ""} ${skin} ${ink}`}
    >
      {/* Row 1 — status glyph · word · workspace · time-in-state. The status
          word never truncates; the workspace name gives way first. */}
      <span className="flex h-4 items-center gap-1.5 font-mono text-[10px]">
        <span key={glyph.word} className={`octo-pop-in ${glyph.cls}`}>{glyph.label}</span>
        <span className="shrink-0 uppercase tracking-[0.25em] text-octo-mute">{glyph.word}</span>
        {wsName && (
          <>
            <span aria-hidden className="shrink-0 text-octo-mute">·</span>
            <span
              data-tour="mission-control-card-workspace"
              className="min-w-0 truncate text-octo-mute"
              title={`Workspace: ${wsName}`}
            >
              {wsName}
            </span>
          </>
        )}
        {run.detached && run.status === "running" && (
          <span
            title="Working detached — this crew keeps going even if you quit Octopush"
            className="octo-pop-in flex shrink-0 items-center text-octo-mute"
          >
            <Moon size={11} aria-label="Working detached" />
          </span>
        )}
        <span
          className="octo-tabular ml-auto w-[7ch] shrink-0 text-right text-octo-mute"
          title="Time in this state"
        >
          {inState}
        </span>
      </span>

      {/* Row 2 — the title: intent glyph + the run's task. The task is what
          tells crews apart (many runs share one workspace), so it carries the
          serif; the full task is on the tooltip. */}
      <span className="flex h-5 items-center gap-1.5">
        {missionIntent &&
          (() => {
            const Icon = INTENT_ICON[missionIntent] ?? Hammer;
            return (
              <span title={`${missionIntent} mission`} className="flex shrink-0 items-center">
                <Icon size={11} aria-hidden className="text-octo-mute" />
              </span>
            );
          })()}
        <span
          data-tour="mission-control-card-task"
          className="min-w-0 truncate font-serif text-[15px] text-octo-ivory"
          title={run.task}
        >
          {run.task}
        </span>
      </span>

      {/* Row 3 — micro-track: the run's shape at a glance. */}
      <MicroTrack stages={stages} />

      {/* Row 4 — the live slot: ticker / gate / halt / savings. */}
      <LiveSlot run={run} band={band} gate={gateStage} failed={failedStage} stalled={stalled} running={runningStage} />

      {/* A question-block (not a gate) can be answered on-card with the crew's
          own recommended defaults; anything else goes to the full form. */}
      {glyph.word === "asked you" && askedStage && (
        <AskPanel run={run} stage={askedStage} onAnswer={canJump ? jump : undefined} />
      )}

      {/* Row 5 — ledger foot + actions. */}
      <CardFoot run={run} band={band} />
    </div>
  );
}

/** The run's stages compressed to the universal micro-track (spec §4.1) —
 *  one dot per stage, same status colour family everywhere a run is
 *  miniaturised. Fixed-height slot; renders a reserved placeholder until the
 *  stage detail arrives (S1: the slot exists in every state). Replaces the
 *  retired roman-numeral track. */
function MicroTrack({ stages }: { stages: RunStage[] }) {
  if (stages.length === 0) {
    return <span className="block h-4 font-mono text-[10px] leading-4 text-octo-mute">· · ·</span>;
  }
  return (
    <span className="flex h-4 items-center">
      <StageDots
        stages={stages.map((s) => ({ status: s.status, checkpoint: s.checkpoint, error: s.error, title: stageTitle(s) }))}
      />
    </span>
  );
}

/** ONE fixed-height live line; content picked by state, geometry constant (S1).
 *  Running → the crew's live activity ticker, updating in place (S5). */
function LiveSlot({
  run,
  band,
  gate,
  failed,
  stalled,
  running,
}: {
  run: Run;
  band: Band;
  gate?: RunStage;
  failed?: RunStage;
  stalled: boolean;
  running?: RunStage;
}) {
  const entries = useRunsStore((s) => (running ? s.liveByStage[running.id] : undefined));

  let text = "";
  let cls = "text-octo-mute";
  if (band === "in-flight") {
    text = (entries && lastActivity(entries)) || (running ? `${stageTitle(running)} at work` : "");
    cls = "text-octo-sage";
  } else if (band === "needs-you") {
    if (stalled && failed) {
      text = "stalled — resume when ready";
      cls = "text-octo-warning";
    } else if (failed) {
      text = failed.error?.split("\n")[0] ?? "stage halted";
      cls = "text-octo-rouge";
    } else if (gate && gate.blockedQuestions) {
      // The escape valve: an answer form is waiting, not an approval.
      text = `${stageTitle(gate)} asked you · waiting on your answer`;
      cls = "text-octo-brass";
    } else if (gate) {
      const loop = gate.loopTargetPosition !== null ? ` · loop ${gate.loopIterations}/${gate.loopMaxIterations}` : "";
      text = `${stageTitle(gate)} holds the gate${loop}`;
      cls = "text-octo-brass";
    } else {
      text = "paused at the boundary";
    }
  } else {
    // Settled — savings-first epitaph for a shipped crew; quiet for aborted.
    if (run.status === "completed") {
      const saved = Math.max(0, run.baselineUsd - run.costUsd);
      const pct = run.baselineUsd > 0 ? Math.round((saved / run.baselineUsd) * 100) : 0;
      text = run.baselineUsd > 0 ? `shipped · ${pct}% under all-premium` : "shipped";
      cls = "text-octo-verdigris";
    } else {
      text = "aborted";
    }
  }

  return (
    <span className={`block h-4 truncate font-mono text-[10px] leading-4 ${cls}`} title={text || undefined}>
      {text}
    </span>
  );
}

/** The `?` card's inline answer: a disclosure listing each question with the
 *  crew's recommended answer, then "Accept recommended" (answers every question
 *  with its default, logged in the journal as from Mission Control) and
 *  "Answer…" (opens the full form on the Direct canvas). Never auto-accepts. */
function AskPanel({
  run,
  stage,
  onAnswer,
}: {
  run: Run;
  stage: RunStage;
  /** Jump to the full answer form; undefined when the workspace isn't loaded. */
  onAnswer?: () => void;
}) {
  const answerBlocker = useRunsStore((s) => s.answerBlocker);
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const questions = stage.blockedQuestions?.questions ?? [];
  const panelId = `mc-ask-${stage.id}`;

  const accept = (e: React.MouseEvent) => {
    e.stopPropagation(); // don't trigger the card's jump
    if (sending) return;
    setSending(true);
    void answerBlocker(run.id, stage.id, questions.map((q) => q.recommendedDefault), "mission_control")
      .catch(console.error)
      .finally(() => setSending(false));
  };

  const count = questions.length === 1 ? "1 question" : `${questions.length} questions`;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        data-tour="mission-control-ask-toggle"
        onClick={(e) => {
          e.stopPropagation(); // don't trigger the card's jump
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex h-4 w-fit items-center gap-1.5 font-mono text-[10px] text-octo-mute transition-colors duration-[180ms] hover:text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
      >
        <ChevronRight
          size={11}
          aria-hidden
          className="transition-transform duration-[180ms]"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        />
        {count} · recommended answers
      </button>

      <Reveal open={open}>
        {/* Clicks inside the panel stay on the card (reading ≠ jumping). */}
        <div id={panelId} onClick={(e) => e.stopPropagation()} className="flex cursor-default flex-col gap-2 pt-2">
          {questions.map((q, i) => (
            <div key={i} className="flex flex-col gap-0.5">
              <span className="text-[12px] leading-4 text-octo-ivory">{q.question}</span>
              <span className="font-mono text-[10px] leading-4 text-octo-sage">
                <span className="text-octo-mute">recommended · </span>
                {q.recommendedDefault || "no default given"}
              </span>
            </div>
          ))}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              data-tour="mission-control-ask-accept"
              onClick={accept}
              disabled={sending}
              title="Answer every question with the crew's recommended default"
              className="rounded-md border border-[var(--brass-dim)] px-2.5 py-1 font-serif text-[13px] text-octo-brass transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass disabled:opacity-50"
            >
              {sending ? "Sending…" : "Accept recommended"}
            </button>
            {onAnswer && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onAnswer();
                }}
                title="Open the full answer form"
                className="rounded-md border border-octo-hairline px-2.5 py-1 font-mono text-[11px] text-octo-sage transition-colors duration-[180ms] hover:text-octo-ivory focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
              >
                Answer…
              </button>
            )}
          </div>
        </div>
      </Reveal>
    </div>
  );
}

function CardFoot({ run, band }: { run: Run; band: Band }) {
  const abort = useRunsStore((s) => s.abort);
  const dismissSettled = useRunsStore((s) => s.dismissSettled);
  const [arming, setArming] = useState(false);
  const armTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
    },
    [],
  );

  // A completed crew's foot gets the one sanctioned ceremony: a single brass
  // sweep as it settles (only when it JUST settled — not on later re-opens).
  const settledJustNow = band === "settled" && run.status === "completed" && recentlySettled(run.id);

  const onAbort = (e: React.MouseEvent) => {
    e.stopPropagation(); // don't trigger the card's jump
    if (!arming) {
      setArming(true);
      armTimer.current = window.setTimeout(() => setArming(false), 3000);
      return;
    }
    if (armTimer.current !== null) window.clearTimeout(armTimer.current);
    setArming(false);
    void abort(run.id).catch(console.error);
  };

  return (
    <span className="relative flex h-5 items-center gap-2 font-mono text-[11px]">
      {settledJustNow && (
        <span aria-hidden className="octo-sweep absolute -top-1 left-0 h-px w-full bg-octo-brass" />
      )}
      <span className="octo-tabular text-octo-brass">${run.costUsd.toFixed(2)}</span>
      {run.baselineUsd > run.costUsd && band !== "settled" && (
        <span className="octo-tabular text-octo-verdigris">
          saved ${(run.baselineUsd - run.costUsd).toFixed(2)}
        </span>
      )}
      <span className="relative z-10 ml-auto flex items-center gap-1 opacity-0 transition-opacity duration-[180ms] group-hover:opacity-100 group-focus-within:opacity-100">
        {band !== "settled" ? (
          <button
            type="button"
            onClick={onAbort}
            aria-label={arming ? "Confirm abort" : "Abort run"}
            title={arming ? "Click again to abort" : "Abort run"}
            className={`flex items-center justify-center gap-1 rounded p-1 transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-rouge ${
              arming ? "text-octo-rouge" : "text-octo-mute hover:bg-[var(--brass-ghost)] hover:text-octo-rouge"
            }`}
          >
            <Square size={11} />
            {arming && <span className="text-[9px] uppercase tracking-[0.15em]">sure?</span>}
          </button>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation(); // don't trigger the card's jump
              dismissSettled(run.id);
            }}
            aria-label="Dismiss from the board"
            title="Dismiss from the board"
            className="flex items-center justify-center rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-ivory focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
          >
            <X size={11} />
          </button>
        )}
      </span>
    </span>
  );
}

/** The header's "While you were away" figures over the launch-seeded settled
 *  cards still on the board, or null when there are none. Only a settled
 *  status counts — a seeded run re-run this session is no longer "away". A
 *  run with no baseline can't be priced, so it stays out of the saving; when
 *  none can be priced the line reads "unpriced", never "$0.00". */
export function awayLine(settled: Run[], awayRunIds: string[]): { count: number; saved: string } | null {
  const ids = new Set(awayRunIds);
  const away = settled.filter(
    (r) => ids.has(r.id) && (r.status === "completed" || r.status === "aborted"),
  );
  if (away.length === 0) return null;
  const priced = away.filter((r) => r.baselineUsd > 0);
  if (priced.length === 0) return { count: away.length, saved: "unpriced" };
  const saved = priced.reduce((sum, r) => sum + Math.max(0, r.baselineUsd - r.costUsd), 0);
  return { count: away.length, saved: `saved $${saved.toFixed(2)}` };
}

/** True while the run settled within the last few seconds — gates the one-shot
 *  completion sweep so re-opening the room later doesn't replay ceremonies. */
function recentlySettled(runId: string): boolean {
  const at = useRunsStore.getState().settledAt[runId];
  return at !== undefined && Date.now() - at < 8000;
}

/** Time-in-state for a crew card — `mm:ss`, rolling to `Hh MMm` past an hour
 *  so long-lived background runs never overflow the fixed 7ch slot (S1/S2). */
function useTimeInState(sinceIso: string | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!sinceIso) return;
    setNow(Date.now()); // reset so the first paint is correct
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [sinceIso]);

  if (!sinceIso) return "";
  const start = new Date(sinceIso).getTime();
  if (Number.isNaN(start)) return "";
  const secs = Math.max(0, Math.floor((now - start) / 1000));
  if (secs < 3600) {
    const mm = Math.floor(secs / 60).toString().padStart(2, "0");
    const ss = (secs % 60).toString().padStart(2, "0");
    return `${mm}:${ss}`;
  }
  const h = Math.floor(secs / 3600);
  const mm = Math.floor((secs % 3600) / 60).toString().padStart(2, "0");
  return `${h}h ${mm}m`;
}

/** The workspace's display name — thin hook over the shared selector. */
function useWorkspaceName(workspaceId: string): string | null {
  return useWorkspaceStore(
    useShallow((s) => findWorkspaceName(s.workspacesByProjectId, workspaceId)),
  );
}
