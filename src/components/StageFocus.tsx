import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { ChevronLeft, ChevronRight, SlidersHorizontal, RotateCcw } from "lucide-react";
import type { LiveEntry, Run, RunStage, RunStagePatch, StageIteration } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useRunsStore } from "../stores/runsStore";
import { isTransientHalt } from "../lib/runStatus";
import { iconForRole, iconForTool } from "../lib/roleIcons";
import { stageTitle, fmtTokens } from "../lib/stageMeta";
import { DiffViewer } from "./DiffViewer";
import { FadeSwap } from "./primitives/FadeSwap";
import { Reveal } from "./primitives/Reveal";
import { IconButton } from "./controls/IconButton";
import { TogglePill } from "./controls/TogglePill";
import { Stepper } from "./controls/Stepper";
import { SegmentedControl } from "./controls/SegmentedControl";
import { ModelPicker } from "./ModelPicker";
import { ModalShell } from "./ModalShell";

const EMPTY_ENTRIES: LiveEntry[] = [];

const ROLE_VERBS: Record<string, string> = {
  plan: "planning…", plan_review: "reviewing…", implement: "implementing…",
  code_review: "reviewing…", test: "testing…", repro: "reproducing…",
  fix: "fixing…", verify: "verifying…", critique: "critiquing…", refine: "refining…",
};

interface ParsedArtifact {
  kind: string;
  text: string;
  refsWorktree?: boolean;
}

/** Extract the display text from a stage/iteration artifact JSON string. */
function parseArtifactText(artifact: string | null): string {
  if (!artifact) return "";
  try {
    return (JSON.parse(artifact) as ParsedArtifact).text ?? "";
  } catch {
    return "";
  }
}

/** Split the persisted stage log on `{kind:"reset"}` markers. Segment i is
 *  attempt i+1's journal; the segment after the last marker is the current one. */
function splitLogSegments(raw: unknown[]): LiveEntry[][] {
  const segments: LiveEntry[][] = [[]];
  for (const item of raw) {
    const e = item as { kind?: unknown } | null;
    if (!e || typeof e.kind !== "string") continue;
    if (e.kind === "reset") segments.push([]);
    else segments[segments.length - 1].push(item as LiveEntry);
  }
  return segments;
}

/** Render live-journal entries as elements — prose lines, brass notices, and
 *  flat tool lines with their paired results. Shared by the live view and the
 *  archived-attempt view so both journals read identically. */
function buildJournalItems(entries: LiveEntry[]): ReactElement[] {
  const items: ReactElement[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.kind === "text") {
      items.push(<div key={i} className="octo-rise-in text-octo-sage">{e.text}</div>);
    } else if (e.kind === "notice") {
      items.push(<div key={i} className="octo-rise-in font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">{e.text}</div>);
    } else if (e.kind === "tool") {
      const next = entries[i + 1];
      const res = next && next.kind === "tool_result" ? next : null;
      if (res) i++; // consume the paired result
      const ToolIcon = iconForTool(e.tool);
      items.push(
        <div key={i} className="octo-rise-in flex items-baseline gap-2 font-mono text-[12px]">
          <span className="translate-y-[1px] shrink-0 text-octo-mute" title={e.tool}>
            <ToolIcon size={11} strokeWidth={1.75} />
          </span>
          <span className="shrink-0 text-octo-ivory">{e.tool}</span>
          {e.hint && (
            <span className="min-w-0 truncate text-octo-sage" title={e.hint}>
              {e.hint}
            </span>
          )}
          {res && (
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px]">
              <span className={res.ok ? "text-octo-verdigris" : "text-octo-rouge"}>{res.ok ? "✓" : "✕"}</span>
              <span className="max-w-[28ch] truncate text-octo-mute" title={res.detail}>
                {res.detail}
              </span>
            </span>
          )}
        </div>,
      );
    } else if (e.kind === "tool_result") {
      // orphan result (no preceding tool in buffer) — render compactly
      items.push(
        <div key={i} className="octo-rise-in flex items-center gap-1.5 font-mono text-[11px] text-octo-mute">
          <span className={e.ok ? "text-octo-verdigris" : "text-octo-rouge"}>{e.ok ? "✓" : "✕"}</span>
          <span>{e.detail}</span>
        </div>,
      );
    }
  }
  return items;
}

/** A finished stage's frozen worktree diff. The label is deliberately honest:
 *  the snapshot is the cumulative worktree state when the stage finished, not
 *  the stage's isolated contribution. */
function SnapshotDiff({ diff }: { diff: string }) {
  return (
    <>
      <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">
        worktree when this stage finished
      </div>
      <DiffViewer diff={diff} />
    </>
  );
}

const TERMINAL_RUN_STATUSES = new Set(["completed", "aborted"]);
/** Rerun affordance only shows when the run isn't actively driving — the
 *  backend also enforces this (rejecting a rerun while another drive holds
 *  the run's exclusion claim), this just keeps the button from appearing in
 *  a state where clicking it would only bounce off a guard error. `failed`
 *  belongs here: a run halted by a failed stage is exactly the moment the
 *  director wants to fix the stage and re-run it. A `running` run qualifies
 *  too when it is PARKED at a checkpoint rather than actively driving — the
 *  caller signals that via `runBlocked`. */
const RERUNNABLE_RUN_STATUSES = new Set(["paused", "completed", "failed"]);

interface Props {
  stage: RunStage | null;
  workspacePath: string;
  /** The stage's run — enables the director controls below (gate toggle,
   *  edit, re-run). Omit (or pass null) to render read-only, as every
   *  existing caller before this feature did. */
  run?: Run | null;
  /** True when the run is parked at a checkpoint / failed stage instead of
   *  actively driving — earlier finished stages are re-runnable then even
   *  though the run's status still reads "running". */
  runBlocked?: boolean;
  /** Hot-edit the shown stage (only called while it hasn't started). */
  onUpdateStage?: (patch: RunStagePatch) => Promise<void>;
  /** Re-run the shown stage — and everything downstream — in place. The
   *  patch carries the director's edits ("re-run after changes"). */
  onRerunFromStage?: (patch?: RunStagePatch) => Promise<void>;
}

export function StageFocus({ stage, workspacePath, run = null, runBlocked = false, onUpdateStage, onRerunFromStage }: Props) {
  const [diff, setDiff] = useState<string>("");
  const [diffLoading, setDiffLoading] = useState(false);
  // D5 — archived attempts + the persisted log split into per-attempt segments.
  const [iterations, setIterations] = useState<StageIteration[]>([]);
  const [logSegments, setLogSegments] = useState<LiveEntry[][]>([]);
  /** 1-based archived attempt being viewed; null = the current attempt. */
  const [viewedAttempt, setViewedAttempt] = useState<number | null>(null);
  const liveEntries = useRunsStore((s) => s.liveByStage[stage?.id ?? ""] ?? EMPTY_ENTRIES);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Director controls: gate toggle, edit-stage modal, re-run confirm ──
  const [editOpen, setEditOpen] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [draftInstructions, setDraftInstructions] = useState("");
  const [draftModel, setDraftModel] = useState("");
  const [draftMaxIterations, setDraftMaxIterations] = useState(25);
  const [draftLoopMode, setDraftLoopMode] = useState<"gated" | "auto">("gated");
  const [draftCheckpoint, setDraftCheckpoint] = useState(false);
  const [confirmRerun, setConfirmRerun] = useState(false);
  /** Surfaces a rejected gate toggle or re-run — both fire outside the edit
   *  modal (which has its own inline `editError`), so a bare `void` on their
   *  promises would otherwise fail silently. */
  const [directorError, setDirectorError] = useState<string | null>(null);

  // A different stage came into focus — close any director controls left
  // open on the previous one instead of carrying them over.
  useEffect(() => {
    setEditOpen(false);
    setConfirmRerun(false);
    setDirectorError(null);
  }, [stage?.id]);

  // The gate toggle needs a stage the run hasn't reached. A stage parked
  // BEFORE it began — a budget park or a director pause, which hold the
  // next stage with no work done — still takes field edits; the park itself
  // is released via approve/reject, not a toggle. "No artifact yet" is the
  // no-work-done signal: pre-work parks produce nothing, while a checkpoint
  // GATE park holds a FINISHED stage's hand-off (artifact present) and is
  // redirected via the decision bar or a re-run instead. The backend
  // enforces the same rule.
  const controllable = !!stage && !!run && !TERMINAL_RUN_STATUSES.has(run.status);
  const gateTogglable =
    controllable && stage.status === "pending" && stage.startedAt === null;
  const fieldsEditable =
    gateTogglable ||
    (controllable && stage.status === "awaiting_checkpoint" && stage.artifact === null);
  // NOTE: not `controllable` — a COMPLETED run can't take edits but its
  // stages can be re-run ("completed" is in the rerunnable set).
  const rerunnable =
    !!stage && !!run &&
    (RERUNNABLE_RUN_STATUSES.has(run.status) || (run.status === "running" && runBlocked)) &&
    (stage.status === "done" || stage.status === "failed");
  /** Finished stages open the same modal in "edit & re-run" mode — the only
   *  way an edit to a finished stage can mean anything. (rerunnable requires
   *  done/failed and fieldsEditable requires pending/awaiting, so the two
   *  never overlap for one stage.) */
  const editRerunsStage = rerunnable;
  const showsLoopMode = !!stage && stage.loopTargetPosition !== null && stage.loopMaxIterations > 0;

  function reportDirectorError(e: unknown) {
    setDirectorError(e instanceof Error ? e.message : String(e));
  }

  function openEdit() {
    if (!stage) return;
    setDraftInstructions(stage.instructions ?? "");
    setDraftModel(stage.agentModel);
    setDraftMaxIterations(stage.maxIterations);
    setDraftLoopMode(stage.loopMode === "auto" ? "auto" : "gated");
    setDraftCheckpoint(stage.checkpoint);
    setEditError(null);
    setEditOpen(true);
  }

  async function saveEdit() {
    const action = editRerunsStage ? onRerunFromStage : onUpdateStage;
    if (!stage || !action) return;
    setSaving(true);
    setEditError(null);
    const patch: RunStagePatch = {
      instructions: draftInstructions,
      agentModel: draftModel,
      maxIterations: draftMaxIterations,
      ...(showsLoopMode ? { loopMode: draftLoopMode } : {}),
      // The re-run path resets the stage to pending first, so the gate is
      // legitimately patchable there — offered as a field in the modal.
      ...(editRerunsStage ? { checkpoint: draftCheckpoint } : {}),
    };
    try {
      await action(patch);
      setEditOpen(false);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const artifact = useMemo<ParsedArtifact | null>(() => {
    if (!stage?.artifact) return null;
    try {
      return JSON.parse(stage.artifact) as ParsedArtifact;
    } catch {
      return null;
    }
  }, [stage?.artifact]);

  // A terminal stage with a captured snapshot renders the frozen diff instead —
  // the live worktree keeps mutating under later stages, so we never fetch it.
  const terminal = stage != null && stage.status !== "running";
  const snapshot = terminal ? stage?.diffSnapshot ?? null : null;

  useEffect(() => {
    let cancelled = false;
    if (stage && artifact?.refsWorktree && workspacePath && snapshot == null) {
      setDiff("");
      setDiffLoading(true);
      ipc.getGitDiff(workspacePath)
        .then((d) => { if (!cancelled) { setDiff(d); setDiffLoading(false); } })
        .catch(() => { if (!cancelled) { setDiff(""); setDiffLoading(false); } });
    } else {
      setDiff("");
      setDiffLoading(false);
    }
    return () => { cancelled = true; };
  }, [stage?.id, stage?.status, snapshot, artifact?.refsWorktree, workspacePath]);

  // Looking at a different stage = back to its current attempt.
  useEffect(() => { setViewedAttempt(null); }, [stage?.id]);

  // D5 + D1 — fetch the archive list and the persisted journal for this stage.
  // Re-fetched on status changes too: a loop-back both archives an attempt and
  // resets the live journal. Hydration fills the in-memory journal of a
  // terminal stage from the log's CURRENT segment — only when it's still
  // empty (hydrateLog never clobbers a live stream).
  useEffect(() => {
    let cancelled = false;
    setIterations([]);
    setLogSegments([]);
    if (!stage) return;
    const stageId = stage.id;
    // Any non-running stage may hydrate from the persisted log (done/failed,
    // and budget-parked awaiting_checkpoint stages whose only content is a notice).
    const terminal = stage.status !== "running";
    void ipc.listStageIterations(stageId)
      .then((rows) => { if (!cancelled) setIterations(rows); })
      .catch(() => {});
    void ipc.getStageLog(stageId)
      .then((raw) => {
        if (cancelled) return;
        const segments = splitLogSegments(raw);
        setLogSegments(segments);
        if (terminal) {
          const current = segments[segments.length - 1] ?? [];
          if (current.length > 0) useRunsStore.getState().hydrateLog(stageId, current);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [stage?.id, stage?.status]);

  // Keep the live journal pinned to the newest activity while a stage runs (S6: smooth).
  useEffect(() => {
    if (stage?.status === "running" && scrollRef.current) {
      scrollRef.current.scrollTo?.({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [liveEntries, stage?.status]);

  const journal = useMemo(() => buildJournalItems(liveEntries), [liveEntries]);

  const totalAttempts = iterations.length + 1;
  // Guard against a stale index if the archive list shrinks under us.
  const viewedRow =
    viewedAttempt !== null && viewedAttempt >= 1 && viewedAttempt <= iterations.length
      ? iterations[viewedAttempt - 1]
      : null;
  const attemptN = viewedRow ? viewedAttempt! : totalAttempts;

  const archivedJournal = useMemo(
    () => (viewedRow ? buildJournalItems(logSegments[attemptN - 1] ?? []) : []),
    [viewedRow, logSegments, attemptN],
  );

  if (!stage) {
    return (
      <div className="flex flex-1 items-center justify-center font-serif text-sm text-octo-mute">
        Pick a stage above to see its work.
      </div>
    );
  }

  const mode =
    stage.status === "failed" && stage.error ? "failed"
    : artifact ? "artifact"
    : stage.status === "running" ? "running"
    : "idle";
  const swapKey = viewedRow ? `${stage.id}:attempt-${attemptN}` : `${stage.id}:${mode}`;

  return (
    <>
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-col gap-1 border-b border-octo-hairline px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          {(() => {
            const RoleIcon = iconForRole(stage.role);
            return (
              <span className="shrink-0 text-octo-brass" title={stage.role.replace(/_/g, " ")}>
                <RoleIcon size={12} strokeWidth={1.75} />
              </span>
            );
          })()}
          <span
            className="min-w-0 truncate font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass"
            title={stage.role.replace(/_/g, " ")}
          >
            {stage.role.replace(/_/g, " ").toUpperCase()}
          </span>
          <span className="truncate font-mono text-[10px] text-octo-mute">{stage.agentModel}</span>
          {iterations.length > 0 && (
            <span className="flex shrink-0 items-center gap-1.5">
              <IconButton
                label="Previous attempt"
                onClick={() => setViewedAttempt(attemptN - 1)}
                disabled={attemptN <= 1}
              >
                <ChevronLeft size={12} />
              </IconButton>
              <span className="octo-tabular whitespace-nowrap font-mono text-[10px] text-octo-mute">
                attempt {attemptN} of {totalAttempts}
              </span>
              <IconButton
                label="Next attempt"
                onClick={() => setViewedAttempt(attemptN + 1 >= totalAttempts ? null : attemptN + 1)}
                disabled={attemptN >= totalAttempts}
              >
                <ChevronRight size={12} />
              </IconButton>
            </span>
          )}
          {(fieldsEditable || rerunnable) && (
            <span className="flex shrink-0 items-center gap-1.5">
              {gateTogglable && (
                <TogglePill
                  on={stage.checkpoint}
                  label="⟜ gate"
                  ariaLabel="Approval gate — pause before hand-off"
                  onChange={(v) => {
                    setDirectorError(null);
                    onUpdateStage?.({ checkpoint: v }).catch(reportDirectorError);
                  }}
                />
              )}
              <IconButton
                label={editRerunsStage ? "Edit & re-run stage" : "Edit stage"}
                onClick={openEdit}
              >
                <SlidersHorizontal size={12} />
              </IconButton>
              {rerunnable && (
                <IconButton label="Re-run from here" onClick={() => setConfirmRerun((v) => !v)}>
                  <RotateCcw size={12} />
                </IconButton>
              )}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2.5 font-mono">
            {(stage.inputTokens > 0 || stage.outputTokens > 0) && (
              <span className="octo-tabular text-[10px] text-octo-mute" title="input / output tokens">
                ↑{fmtTokens(stage.inputTokens)} ↓{fmtTokens(stage.outputTokens)}
              </span>
            )}
            <span className="octo-tabular text-xs text-octo-brass">${stage.costUsd.toFixed(2)}</span>
          </span>
        </div>
        <div className="truncate font-serif text-[15px] text-octo-ivory" title={stageTitle(stage)}>
          {stageTitle(stage)}
        </div>
      </div>
      {rerunnable && (
        <Reveal open={confirmRerun}>
          <div className="flex items-center gap-3 border-b border-octo-hairline bg-octo-panel-2 px-4 py-2">
            <span className="min-w-0 flex-1 font-serif text-[13px] text-octo-sage">
              Re-run from here? This discards results from this stage onward.
            </span>
            <button
              type="button"
              onClick={() => {
                setConfirmRerun(false);
                setDirectorError(null);
                onRerunFromStage?.().catch(reportDirectorError);
              }}
              className="shrink-0 rounded-md border border-octo-brass px-3 py-1.5 font-serif text-xs text-octo-brass transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)]"
            >
              Re-run · discards downstream
            </button>
            <button
              type="button"
              onClick={() => setConfirmRerun(false)}
              className="shrink-0 rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-xs text-octo-mute transition-colors duration-[180ms] hover:text-octo-ivory"
            >
              Cancel
            </button>
          </div>
        </Reveal>
      )}
      {directorError && (
        <div className="octo-rise-in border-b border-octo-hairline bg-[var(--rouge-ghost)] px-4 py-2 text-xs text-octo-rouge">
          {directorError}
        </div>
      )}
      <div
        ref={scrollRef}
        className="chat-selectable flex flex-1 flex-col gap-2 overflow-auto px-4 py-3 font-mono text-[12px] leading-relaxed text-octo-sage"
      >
        <FadeSwap swapKey={swapKey} className="flex flex-col gap-2">
          {viewedRow ? (
            <>
              <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">
                archived attempt
              </div>
              {viewedRow.status === "failed" && viewedRow.error ? (
                <div className="octo-rise-in rounded-md border-l-2 border-octo-rouge bg-[var(--rouge-ghost)] px-3 py-2">
                  <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-rouge">✕ stage halted</div>
                  <div className="whitespace-pre-wrap text-octo-rouge">{viewedRow.error}</div>
                </div>
              ) : (
                <div className="whitespace-pre-wrap">
                  {parseArtifactText(viewedRow.artifact) || "(no output text)"}
                </div>
              )}
              {viewedRow.diffSnapshot != null && <SnapshotDiff diff={viewedRow.diffSnapshot} />}
              <div className="octo-tabular font-mono text-[11px] text-octo-mute">
                ${viewedRow.costUsd.toFixed(2)}
              </div>
              {viewedRow.closingFeedback && (
                <div className="flex flex-col gap-1">
                  <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">
                    sent back with
                  </div>
                  <div className="whitespace-pre-wrap text-octo-sage">{viewedRow.closingFeedback}</div>
                </div>
              )}
              {archivedJournal.length > 0 && (
                <JournalDrawer key={`${stage.id}:${attemptN}`} items={archivedJournal} />
              )}
            </>
          ) : mode === "failed" ? (
            <>
              {/* Sticky: the halt stays visible however far the journal has scrolled.
                  The onyx layer keeps the ghost tint opaque over scrolled lines.
                  A transient fault (rate limit, overload, dropped connection) reads
                  in amber as a recoverable caution, not a rouge hard failure. */}
              <div className="sticky top-0 z-10 rounded-md bg-octo-onyx">
                {isTransientHalt(stage.error) ? (
                  <div className="octo-rise-in rounded-md border-l-2 border-octo-warning bg-[var(--warning-ghost)] px-3 py-2">
                    <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-warning">⟳ awaiting retry</div>
                    <div className="mb-2 font-serif text-[13px] leading-snug text-octo-sage">
                      The model substrate was briefly unavailable and automatic retries were exhausted. Your changes are preserved — resume the stage to pick up where it stalled.
                    </div>
                    <div className="whitespace-pre-wrap text-octo-warning">{stage.error}</div>
                  </div>
                ) : (
                  <div className="octo-rise-in rounded-md border-l-2 border-octo-rouge bg-[var(--rouge-ghost)] px-3 py-2">
                    <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-rouge">✕ stage halted</div>
                    <div className="whitespace-pre-wrap text-octo-rouge">{stage.error}</div>
                  </div>
                )}
              </div>
              {journal.length > 0 && <div className="flex flex-col gap-2">{journal}</div>}
              {snapshot != null && <SnapshotDiff diff={snapshot} />}
            </>
          ) : mode === "artifact" ? (
            <>
              <div className="whitespace-pre-wrap">
                {artifact!.text || "(no output text)"}
                {artifact!.refsWorktree && (
                  snapshot != null ? (
                    <SnapshotDiff diff={snapshot} />
                  ) : (
                    <FadeSwap swapKey={diffLoading ? "loading" : "diff"}>
                      {diffLoading ? (
                        <div className="py-4 font-mono text-xs text-octo-mute">fetching the diff…</div>
                      ) : (
                        <DiffViewer diff={diff} />
                      )}
                    </FadeSwap>
                  )
                )}
              </div>
              {journal.length > 0 && <JournalDrawer key={stage.id} items={journal} />}
            </>
          ) : mode === "running" ? (
            <>
              {journal}
              <div className="flex items-center gap-2 font-mono text-[11px] text-octo-brass">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-octo-brass" />
                <span>{ROLE_VERBS[stage.role] ?? "working…"}</span>
              </div>
            </>
          ) : journal.length > 0 ? (
            <div className="flex flex-col gap-2">{journal}</div>
          ) : (
            <span className="text-octo-mute">Nothing produced yet.</span>
          )}
        </FadeSwap>
      </div>
    </div>
    {editOpen && (
      <ModalShell
        onClose={() => !saving && setEditOpen(false)}
        closeOnBackdrop={!saving}
        ariaLabel="Edit stage"
        panelClassName="w-[480px] rounded-lg border border-octo-hairline bg-octo-panel p-6"
      >
        <p className="font-sans text-[15px] font-semibold text-octo-ivory">
          Edit {stageTitle(stage)}
        </p>
        <p className="mt-1 text-xs text-octo-mute">
          {editRerunsStage
            ? "Saving re-runs from this stage and discards results from here onward — the pipeline template is untouched."
            : "Changes apply when this stage starts — the pipeline template is untouched."}
        </p>
        <div className="mt-4 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">instructions</span>
            <textarea
              value={draftInstructions}
              onChange={(e) => setDraftInstructions(e.target.value)}
              placeholder="Additional guidance for this stage…"
              className="h-28 resize-none rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-xs text-octo-ivory placeholder:font-serif placeholder:text-octo-mute"
            />
          </label>
          <div className="flex flex-wrap items-center gap-4">
            <span className="flex items-center gap-2 font-mono text-[11px] text-octo-mute">
              model
              <ModelPicker activeModel={draftModel} onSelectModel={setDraftModel} />
            </span>
            <span className="flex items-center gap-2 font-mono text-[11px] text-octo-mute">
              turn budget
              <Stepper value={draftMaxIterations} min={1} max={100} step={5} ariaLabel="Turn budget" onChange={setDraftMaxIterations} />
            </span>
            {showsLoopMode && (
              <span className="flex items-center gap-2 font-mono text-[11px] text-octo-mute">
                loop mode
                <SegmentedControl
                  options={[{ value: "gated", label: "gated" }, { value: "auto", label: "auto" }]}
                  value={draftLoopMode}
                  onChange={setDraftLoopMode}
                  ariaLabel="Loop mode"
                />
              </span>
            )}
            {editRerunsStage && (
              <TogglePill
                on={draftCheckpoint}
                label="⟜ gate"
                ariaLabel="Approval gate — pause before hand-off on the re-run"
                onChange={setDraftCheckpoint}
              />
            )}
          </div>
          {editError && (
            <div className="rounded-md border-l-2 border-octo-rouge bg-[var(--rouge-ghost)] px-3 py-2 text-xs text-octo-rouge">
              {editError}
            </div>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setEditOpen(false)}
            disabled={saving}
            className="rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-xs text-octo-mute transition-colors duration-[180ms] hover:text-octo-ivory disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void saveEdit()}
            disabled={saving}
            className="rounded-md bg-octo-brass px-3 py-1.5 font-serif text-sm text-octo-onyx transition-colors duration-[180ms] hover:bg-octo-brass-hi disabled:opacity-40"
          >
            {editRerunsStage ? "Save & re-run from here" : "Save these changes"}
          </button>
        </div>
      </ModalShell>
    )}
    </>
  );
}

/** The work journal stays reachable after a stage finishes — it's the evidence
 *  of what the agent did. Collapsed by default so the artifact leads. */
function JournalDrawer({ items }: { items: ReactElement[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4 border-t border-octo-hairline pt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute transition-colors duration-[180ms] hover:text-octo-brass"
      >
        <span>work journal · <span className="octo-tabular tracking-normal">{items.length}</span></span>
        <span>{open ? "▾" : "▸"}</span>
      </button>
      <Reveal open={open}>
        <div className="flex flex-col gap-2 pt-2">{items}</div>
      </Reveal>
    </div>
  );
}
