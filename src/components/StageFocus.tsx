import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { LiveEntry, RunStage, StageIteration } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useRunsStore } from "../stores/runsStore";
import { labelForRole } from "./RunTrack";
import { DiffViewer } from "./DiffViewer";
import { FadeSwap } from "./primitives/FadeSwap";
import { Reveal } from "./primitives/Reveal";
import { IconButton } from "./controls/IconButton";

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
 *  § tool cards with their paired results. Shared by the live view and the
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
      items.push(
        <div key={i} className="octo-rise-in rounded-md border border-octo-hairline bg-octo-panel-2 px-3 py-2">
          <div className="flex items-center gap-2 font-mono text-[12px]">
            <span className="text-octo-brass">§</span>
            <span className="text-octo-ivory">{e.tool}</span>
            {e.hint && <><span className="text-octo-sage">·</span><span className="text-octo-sage">{e.hint}</span></>}
          </div>
          {res && (
            <div className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-octo-mute">
              <span className={res.ok ? "text-octo-verdigris" : "text-octo-rouge"}>{res.ok ? "✓" : "✕"}</span>
              <span>{res.detail}</span>
            </div>
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

interface Props {
  stage: RunStage | null;
  workspacePath: string;
}

export function StageFocus({ stage, workspacePath }: Props) {
  const [diff, setDiff] = useState<string>("");
  const [diffLoading, setDiffLoading] = useState(false);
  // D5 — archived attempts + the persisted log split into per-attempt segments.
  const [iterations, setIterations] = useState<StageIteration[]>([]);
  const [logSegments, setLogSegments] = useState<LiveEntry[][]>([]);
  /** 1-based archived attempt being viewed; null = the current attempt. */
  const [viewedAttempt, setViewedAttempt] = useState<number | null>(null);
  const liveEntries = useRunsStore((s) => s.liveByStage[stage?.id ?? ""] ?? EMPTY_ENTRIES);
  const scrollRef = useRef<HTMLDivElement>(null);

  const artifact = useMemo<ParsedArtifact | null>(() => {
    if (!stage?.artifact) return null;
    try {
      return JSON.parse(stage.artifact) as ParsedArtifact;
    } catch {
      return null;
    }
  }, [stage?.artifact]);

  useEffect(() => {
    let cancelled = false;
    if (stage && artifact?.refsWorktree && workspacePath) {
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
  }, [stage?.id, stage?.status, artifact?.refsWorktree, workspacePath]);

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
    const terminal = stage.status === "done" || stage.status === "failed";
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-octo-hairline px-4 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
          § {stage.role.replace(/_/g, " ").toUpperCase()}
        </span>
        <span className="font-serif text-sm text-octo-ivory">{labelForRole(stage.role)}</span>
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
        <span className="octo-tabular ml-auto font-mono text-xs text-octo-brass">${stage.costUsd.toFixed(2)}</span>
      </div>
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
              <div className="octo-rise-in rounded-md border-l-2 border-octo-rouge bg-[var(--rouge-ghost)] px-3 py-2">
                <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-rouge">✕ stage halted</div>
                <div className="whitespace-pre-wrap text-octo-rouge">{stage.error}</div>
              </div>
              {journal.length > 0 && <div className="flex flex-col gap-2">{journal}</div>}
            </>
          ) : mode === "artifact" ? (
            <>
              <div className="whitespace-pre-wrap">
                {artifact!.text || "(no output text)"}
                {artifact!.refsWorktree && (
                  <FadeSwap swapKey={diffLoading ? "loading" : "diff"}>
                    {diffLoading ? (
                      <div className="py-4 font-mono text-xs text-octo-mute">fetching the diff…</div>
                    ) : (
                      <DiffViewer diff={diff} />
                    )}
                  </FadeSwap>
                )}
              </div>
              {journal.length > 0 && <JournalDrawer key={stage.id} items={journal} />}
            </>
          ) : mode === "running" ? (
            <>
              {journal}
              <div className="flex items-center gap-2 font-mono text-[11px] text-octo-brass">
                <span className="octo-stage-pulse inline-block h-1.5 w-1.5 rounded-full bg-octo-brass" />
                <span>{ROLE_VERBS[stage.role] ?? "working…"}</span>
              </div>
            </>
          ) : (
            <span className="text-octo-mute">Nothing produced yet.</span>
          )}
        </FadeSwap>
      </div>
    </div>
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
        <span className="text-octo-brass">§</span>
        <span>work journal · <span className="octo-tabular tracking-normal">{items.length}</span></span>
        <span>{open ? "▾" : "▸"}</span>
      </button>
      <Reveal open={open}>
        <div className="flex flex-col gap-2 pt-2">{items}</div>
      </Reveal>
    </div>
  );
}
