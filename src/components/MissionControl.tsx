// Mission Control — the fleet cockpit. Every Direct run across every workspace
// as a live crew card in one full-screen room: triage bands (Needs you / In
// flight / Settled), a live activity ticker per crew, and the fleet ledger.
// Design record: docs/superpowers/plans/2026-07-09-mission-control-design.md.
//
// Deliberate non-goals (v1): no checkpoint resolution on-card (approving a gate
// without the artifact/diff is rubber-stamping — the card jumps to the Direct
// canvas instead), no launching, no history (HistorySheet owns the past).
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Plus, Square, X } from "lucide-react";
import type { Run, RunStage } from "../lib/ipc";
import { useRunsStore } from "../stores/runsStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { runStatusMeta, isTransientHalt } from "../lib/runStatus";
import { lastActivity } from "../lib/liveLine";
import { ROMAN, stageTitle } from "../lib/stageMeta";
import { OverlayRoom, RoomClose } from "./primitives/OverlayRoom";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Jump to a run's workspace + Direct surface (App closes the room first). */
  onJumpToRun: (workspaceId: string) => void;
  /** "Send out a crew" — Direct mode in the current workspace. */
  onDispatch: () => void;
}

/** A run's board band. `paused` always means a human must act in this engine
 *  (gate / halted stage / budget park / director pause) — that IS "needs you". */
type Band = "needs-you" | "in-flight" | "settled";

const EMPTY_STAGES: RunStage[] = [];

export function MissionControl({ open, onClose, onJumpToRun, onDispatch }: Props) {
  const runsByWs = useRunsStore((s) => s.runsByWs);
  const settledAt = useRunsStore((s) => s.settledAt);
  const statusSince = useRunsStore((s) => s.statusSince);
  const refreshDetail = useRunsStore((s) => s.refreshDetail);

  // The board: active runs everywhere + this session's settled (undismissed).
  const board = useMemo(() => {
    const all = Object.values(runsByWs).flat();
    const active = all.filter((r) => r.status === "running" || r.status === "paused");
    const settled = all.filter((r) => r.id in settledAt);
    const since = (r: Run) => {
      if (statusSince[r.id] !== undefined) return statusSince[r.id];
      const t = Date.parse(r.createdAt);
      return Number.isNaN(t) ? 0 : t;
    };
    const fifo = (a: Run, b: Run) => since(a) - since(b);
    return {
      needsYou: active.filter((r) => r.status === "paused").sort(fifo),
      inFlight: active.filter((r) => r.status === "running").sort(fifo),
      settled: settled.sort(fifo),
    };
  }, [runsByWs, settledAt, statusSince]);

  const boardRuns = useMemo(
    () => [...board.needsYou, ...board.inFlight, ...board.settled],
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
  const activeRuns = [...board.needsYou, ...board.inFlight];
  const spent = activeRuns.reduce((sum, r) => sum + r.costUsd, 0);
  const baseline = activeRuns.reduce((sum, r) => sum + r.baselineUsd, 0);
  const saved = Math.max(0, baseline - spent);
  const savedPct = baseline > 0 ? Math.round((saved / baseline) * 100) : 0;

  const counts: Array<{ n: number; label: string; cls: string }> = [
    { n: board.needsYou.length, label: "need you", cls: "text-octo-brass" },
    { n: board.inFlight.length, label: "in flight", cls: "text-octo-verdigris" },
    { n: board.settled.length, label: "settled", cls: "text-octo-mute" },
  ];

  return (
    <OverlayRoom onClose={onClose} ariaLabel="Mission Control">
      <header className="flex items-baseline gap-4 border-b border-octo-hairline px-8 py-6">
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
      </header>

      {boardRuns.length === 0 ? (
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
          <BandSection title="Needs you" runs={board.needsYou} band="needs-you" onJumpToRun={onJumpToRun} />
          <BandSection title="In flight" runs={board.inFlight} band="in-flight" onJumpToRun={onJumpToRun} />
          <BandSection title="Settled" runs={board.settled} band="settled" onJumpToRun={onJumpToRun} />
        </div>
      )}
    </OverlayRoom>
  );
}

function BandSection({
  title,
  runs,
  band,
  onJumpToRun,
}: {
  title: string;
  runs: Run[];
  band: Band;
  onJumpToRun: (workspaceId: string) => void;
}) {
  if (runs.length === 0) return null;
  return (
    <section>
      <div className="flex h-11 items-center font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">
        {title}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(380px,1fr))] gap-4">
        {runs.map((run, i) => (
          <CrewCard key={run.id} run={run} band={band} index={i} onJumpToRun={onJumpToRun} />
        ))}
      </div>
    </section>
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
  const failedStage = stages.find((s) => s.status === "failed");
  const stalled = !!failedStage && isTransientHalt(failedStage.error);
  const runningStage = stages.find((s) => s.status === "running");

  const glyph =
    band === "needs-you" && stalled
      ? { label: "⟳", cls: "text-octo-warning", word: "stalled" }
      : band === "needs-you" && failedStage
        ? { label: "✕", cls: "text-octo-rouge", word: "halted" }
        : band === "needs-you" && gateStage
          ? { label: "⟜", cls: "text-octo-brass", word: "at the gate" }
          : { label: meta.glyph, cls: meta.className, word: meta.word };

  // Needs-you cards carry the brass border + calm pulse — the same "needs the
  // human" convention as an awaiting stage card. Everything else stays hairline
  // (position in the band is the salience).
  const skin =
    band === "needs-you"
      ? "border-octo-brass octo-stage-pulse"
      : "border-octo-hairline hover:border-[var(--brass-dim)]";

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
      className={`octo-rise-in group relative flex flex-col gap-1.5 rounded-lg border bg-octo-panel px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass ${canJump ? "cursor-pointer" : ""} ${skin}`}
    >
      {/* Row 1 — status glyph · word · time-in-state. */}
      <span className="flex h-4 items-center gap-1.5 font-mono text-[10px]">
        <span key={glyph.word} className={`octo-pop-in ${glyph.cls}`}>{glyph.label}</span>
        <span className="truncate uppercase tracking-[0.25em] text-octo-mute">{glyph.word}</span>
        <span
          className="octo-tabular ml-auto w-[7ch] shrink-0 text-right text-octo-mute"
          title="Time in this state"
        >
          {inState}
        </span>
      </span>

      {/* Row 2 — workspace. */}
      <span className="flex h-5 items-baseline gap-2">
        <span className="min-w-0 truncate font-serif text-[15px] text-octo-ivory" title={wsName ?? undefined}>
          {wsName ?? "workspace"}
        </span>
      </span>

      {/* Row 3 — the brief. */}
      <span className="block h-4 truncate text-[12px] leading-4 text-octo-sage" title={run.task}>
        {run.task}
      </span>

      {/* Row 4 — micro-track: numerals + connectors, the run at a glance. */}
      <MicroTrack stages={stages} />

      {/* Row 5 — the live slot: ticker / gate / halt / savings. */}
      <LiveSlot run={run} band={band} gate={gateStage} failed={failedStage} stalled={stalled} running={runningStage} />

      {/* Row 6 — ledger foot + actions. */}
      <CardFoot run={run} band={band} />
    </div>
  );
}

/** The run's stages compressed to one mono line: colored roman numerals joined
 *  by ⟶ (handoff) or ⟜ (gate). Fixed-height slot; renders reserved dots until
 *  the stage detail arrives (S1: the slot exists in every state). */
function MicroTrack({ stages }: { stages: RunStage[] }) {
  if (stages.length === 0) {
    return <span className="block h-4 font-mono text-[10px] leading-4 text-octo-mute">· · ·</span>;
  }
  const colorFor = (s: RunStage): string => {
    if (s.status === "done") return "text-octo-verdigris";
    if (s.status === "running") return "text-octo-verdigris octo-stage-pulse rounded-sm";
    if (s.status === "awaiting_checkpoint") return "text-octo-brass";
    if (s.status === "failed")
      return isTransientHalt(s.error) ? "text-octo-warning" : "text-octo-rouge";
    return "text-octo-mute";
  };
  return (
    <span className="flex h-4 items-center gap-1 overflow-hidden font-mono text-[10px] leading-4">
      {stages.map((s, i) => {
        const prev = stages[i - 1];
        return (
          <span key={s.id} className="flex shrink-0 items-center gap-1" title={`${stageTitle(s)} — ${s.status}`}>
            {i > 0 && (
              <span className={`text-octo-brass transition-opacity duration-[280ms] ${prev?.status === "done" ? "opacity-100" : "opacity-40"}`}>
                {prev?.checkpoint ? "⟜" : "⟶"}
              </span>
            )}
            <span className={colorFor(s)}>{ROMAN[i] ?? i + 1}</span>
          </span>
        );
      })}
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

/** The workspace's display name, from whichever project list holds it. */
function useWorkspaceName(workspaceId: string): string | null {
  return useWorkspaceStore(
    useShallow((s) => {
      for (const list of Object.values(s.workspacesByProjectId)) {
        const ws = list.find((w) => w.id === workspaceId);
        if (ws) return ws.name;
      }
      return null;
    }),
  );
}
