/**
 * CompanionReview — the Review-mode companion ("change intelligence").
 *
 * The left navigator handles file-level Changes/Files and the diff hosts the
 * AI review, so the companion is free to answer the questions those surfaces
 * can't: *Is this ready?*, *How was this change built?*, and *What happens when
 * I publish?* — context that isn't visible anywhere else on screen.
 *
 *   1. Readiness — a one-line verdict synthesised from the working-tree state.
 *   2. Provenance — the agentic story of the diff: which agent turns shaped it,
 *      expandable to the turn's model + message. Octopush's signature.
 *   3. Branch & publish — upstream / ahead-behind / last commit at a glance,
 *      and the on-demand "Scan this branch's commits" for secrets.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Sparkles, GitBranch, GitCompareArrows, Loader2, ChevronDown, GitCommit, GitCompare, ShieldAlert, ShieldCheck } from "lucide-react";
import { ipc } from "../lib/ipc";
import type { LastCommit } from "../lib/ipc";
import type { GitStatus, FileEdit, ChatMessage } from "../lib/types";
import { PARTIAL_NOTE, PREVIEW_TIP, branchScanSummary, findingLocation, previewSummary, type SecretPreview } from "../lib/secretGuard";
import { formatRelTime } from "../lib/relTime";
import { collisionTooltip, notable, shownCount } from "../lib/collisions";
import { useCollisionStore } from "../stores/collisionStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useReviewSource } from "../stores/reviewSourceStore";
import { baseName, commitCount } from "../lib/reviewSource";
import { Reveal } from "./primitives/Reveal";
import { collisionTone, useWorkspaceCollisions } from "./CollisionMark";

interface Props {
  workspaceId: string;
  workspacePath: string;
  gitStatus: GitStatus | null;
  /** Jump to a file in the diff (scrolls + highlights). */
  onJump?: (file: string, line: number | null) => void;
}

export function CompanionReview({ workspaceId, workspacePath, gitStatus, onJump }: Props) {
  const files = gitStatus?.changedFiles ?? [];
  const staged = files.filter((f) => f.staged).length;
  const conflicted = gitStatus?.conflicted ?? 0;
  const fileCount = files.length;
  const secret = useStagedSecretPreview(workspacePath, gitStatus);
  const held = secret ? Math.max(secret.total, secret.findings.length) > 0 || secret.partial : false;

  // ── Verdict — deliberately AI-free; the AI review lives in the diff. ──
  // The file count and +/− stat live once, in the mode band's tail; the
  // verdict names its unit ("files") so it reads against the diff's hunks.
  const verdict =
    fileCount === 0
      ? { text: "Working tree is clean.", tone: "text-octo-mute" }
      : conflicted > 0
        ? { text: `Resolve ${conflicted} conflict${conflicted !== 1 ? "s" : ""} first.`, tone: "text-octo-rouge" }
        : staged > 0 && held
          ? { text: `${staged} staged · the secret guard will ask first.`, tone: "text-octo-rouge" }
          : staged > 0
            ? { text: `${staged} staged · ready to commit.`, tone: "text-octo-ivory" }
            : { text: `${fileCount} file${fileCount !== 1 ? "s" : ""} to review.`, tone: "text-octo-ivory" };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* ── Readiness hero ──────────────────────────────────────── */}
      <div className="border-b border-octo-hairline px-4 py-3">
        <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">Review</div>
        <div data-tour="review-companion-verdict" className={`mt-1.5 font-serif text-[15px] leading-snug ${verdict.tone}`}>{verdict.text}</div>
        <SecretVerdict preview={staged > 0 && conflicted === 0 ? secret : null} onJump={onJump} />
        <CollisionVerdict workspaceId={workspaceId} />
      </div>

      {/* ── Provenance ──────────────────────────────────────────── */}
      <Provenance workspaceId={workspaceId} files={files} onJump={onJump} />

      {/* ── Branch & publish ────────────────────────────────────── */}
      <BranchPublish workspaceId={workspaceId} workspacePath={workspacePath} gitStatus={gitStatus} />
    </div>
  );
}

// ─── Collision radar (#732) ───────────────────────────────────────

/** One line under the verdict when another live workspace of the project
 *  changes the same files — the moment the director decides what to land
 *  first — with a jump to that workspace. Warn only: nothing is blocked.
 *  Unfolds on the grid-rows Reveal; the last line stays mounted while it
 *  folds away so the text doesn't vanish mid-motion. */
export function CollisionVerdict({ workspaceId }: { workspaceId: string }) {
  const list = useWorkspaceCollisions(workspaceId);
  const projectId = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.projectId ?? null,
  );
  useEffect(() => {
    if (projectId) void useCollisionStore.getState().refresh(projectId);
  }, [projectId, workspaceId]);

  const current = useMemo(() => {
    const top = notable(list)[0];
    if (!top) return null;
    const n = shownCount(top);
    const files = `${n} file${n === 1 ? "" : "s"}`;
    return {
      top,
      text:
        top.severity === "conflict"
          ? `Will conflict with ${top.otherName} in ${files}.`
          : `Overlaps ${top.otherName} in ${files}.`,
      tip: collisionTooltip(list) ?? "",
    };
  }, [list]);
  const [shown, setShown] = useState(current);
  useEffect(() => {
    if (current) setShown(current);
  }, [current]);
  const view = current ?? shown;

  return (
    <Reveal open={!!current}>
      {view && (
        <div
          data-tour="review-companion-collision"
          className="mt-1.5 flex items-start gap-1.5 text-[12px] leading-snug text-octo-sage"
        >
          <GitCompareArrows
            size={12}
            aria-hidden
            className={`mt-[2px] shrink-0 ${collisionTone(view.top.severity)}`}
          />
          <span className="min-w-0" title={view.tip}>
            {view.text}{" "}
            <button
              type="button"
              onClick={() => useWorkspaceStore.getState().select(view.top.otherId)}
              title={`Open ${view.top.otherName}`}
              className="font-serif text-octo-ivory underline decoration-octo-hairline underline-offset-2 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-octo)] hover:text-octo-brass hover:decoration-octo-brass-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
            >
              Open {view.top.otherName}
            </button>
          </span>
        </div>
      )}
    </Reveal>
  );
}

// ─── Secret guard (#835) ──────────────────────────────────────────

/** How often the preview rescans while something is staged, on top of every
 *  new git status. Catches a hunk staged into an already-staged file (or an
 *  agent's edit + re-add between two polls), which leaves the status as is. */
export const SECRET_RESCAN_MS = 5_000;

/** The guard's scan of the staged diff — what Commit would check — redone on
 *  every new git status and every few seconds while something is staged. A
 *  result that a newer scan has overtaken is dropped. `null` while nothing is
 *  staged, with the guard off, or when the scan can't run (Commit still scans
 *  on its own). */
function useStagedSecretPreview(workspacePath: string, gitStatus: GitStatus | null): SecretPreview | null {
  const hasStaged = (gitStatus?.changedFiles ?? []).some((f) => f.staged);
  const [preview, setPreview] = useState<SecretPreview | null>(null);
  const [tick, setTick] = useState(0);
  const inFlight = useRef(0);

  // Heartbeat: skipped while the window is hidden or a scan is still running.
  useEffect(() => {
    if (!hasStaged) return;
    const id = setInterval(() => {
      if (document.visibilityState !== "visible" || inFlight.current > 0) return;
      setTick((t) => t + 1);
    }, SECRET_RESCAN_MS);
    return () => clearInterval(id);
  }, [workspacePath, hasStaged]);

  useEffect(() => {
    if (!hasStaged) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    inFlight.current += 1;
    Promise.resolve()
      .then(() => ipc.secretScanStaged(workspacePath))
      .then((p) => { if (!cancelled) setPreview(p ?? null); })
      .catch(() => { if (!cancelled) setPreview(null); })
      .finally(() => { inFlight.current -= 1; });
    return () => { cancelled = true; };
  }, [workspacePath, gitStatus, hasStaged, tick]);
  return preview;
}

const SECRET_LINE_TIP = "Secret guard: Commit will ask before recording this";

/** One line under the verdict when Commit would stop for a possible secret
 *  ("possible secret · GitHub token in a.ts:3"), with a jump to the first
 *  finding. Unfolds on the grid-rows Reveal; the last line stays mounted
 *  while it folds away. */
export function SecretVerdict({
  preview,
  onJump,
}: {
  preview: SecretPreview | null;
  onJump?: (file: string, line: number | null) => void;
}) {
  const current = useMemo(() => {
    const text = previewSummary(preview);
    return text ? { text, first: preview?.findings[0] ?? null } : null;
  }, [preview]);
  const [shown, setShown] = useState(current);
  useEffect(() => {
    if (current) setShown(current);
  }, [current]);
  const view = current ?? shown;

  return (
    <Reveal open={!!current}>
      {view && (
        <div
          data-tour="review-companion-secret"
          className="mt-1.5 flex items-start gap-1.5 text-[12px] leading-snug text-octo-sage"
        >
          <ShieldAlert size={12} aria-hidden className="mt-[2px] shrink-0 text-octo-rouge" />
          <span className="min-w-0 break-words" title={SECRET_LINE_TIP}>
            {view.text}
            {view.first && onJump && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => onJump(view.first!.file, view.first!.line)}
                  title={`Jump to ${findingLocation(view.first)}`}
                  className="font-serif text-octo-ivory underline decoration-octo-hairline underline-offset-2 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-octo)] hover:text-octo-brass hover:decoration-octo-brass-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                >
                  Show it
                </button>
              </>
            )}
          </span>
        </div>
      )}
    </Reveal>
  );
}

// ─── Provenance ───────────────────────────────────────────────────

interface Turn {
  messageId: number;
  files: string[];
  tools: Set<string>;
  latest: number;
}

function Provenance({
  workspaceId,
  files,
  onJump,
}: {
  workspaceId: string;
  files: GitStatus["changedFiles"];
  onJump?: (file: string, line: number | null) => void;
}) {
  const [edits, setEdits] = useState<FileEdit[] | null>(null);

  // Key the fetch on the set of changed paths so accepting/reverting a file
  // re-derives the story rather than showing a stale snapshot.
  const changedKey = useMemo(
    () => files.map((f) => f.path).sort().join("|"),
    [files],
  );
  const changedPaths = useMemo(() => files.map((f) => f.path), [files]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    ipc.listFileEdits(workspaceId)
      .then((e) => { if (!cancelled) setEdits(e); })
      .catch(() => { if (!cancelled) setEdits([]); });
    return () => { cancelled = true; };
  }, [workspaceId, changedKey]);

  const turns = useMemo<Turn[]>(() => {
    if (!edits) return [];
    const matches = (editPath: string) =>
      changedPaths.some(
        (p) => editPath === p || editPath.endsWith("/" + p) || p.endsWith("/" + editPath),
      );
    const map = new Map<number, Turn>();
    for (const e of edits) {
      if (e.messageId == null || !matches(e.filePath)) continue;
      const t = map.get(e.messageId) ?? { messageId: e.messageId, files: [], tools: new Set(), latest: 0 };
      if (!t.files.includes(e.filePath)) t.files.push(e.filePath);
      t.tools.add(e.toolName);
      const ts = Date.parse(e.createdAt);
      if (!Number.isNaN(ts)) t.latest = Math.max(t.latest, ts);
      map.set(e.messageId, t);
    }
    return [...map.values()].sort((a, b) => b.latest - a.latest);
  }, [edits, changedPaths]);

  const touched = useMemo(() => new Set(turns.flatMap((t) => t.files)).size, [turns]);

  if (files.length === 0) return null;

  return (
    <Section title="How this change was built">
      {edits === null ? (
        <div className="flex items-center gap-2 text-[11px] text-octo-sage">
          <Loader2 size={12} className="animate-spin" /> Tracing edits…
        </div>
      ) : turns.length === 0 ? (
        <p className="text-[11px] leading-[1.5] text-octo-mute">
          No agent edits tracked for these files — likely hand-written (or made before edit tracking).
        </p>
      ) : (
        <div className="space-y-1.5">
          <p className="text-[11px] leading-[1.5] text-octo-sage">
            Shaped by{" "}
            <span className="text-octo-ivory">{turns.length} agent turn{turns.length !== 1 ? "s" : ""}</span>{" "}
            across {touched} file{touched !== 1 ? "s" : ""}.
          </p>
          {turns.map((t) => (
            <ProvenanceTurn key={t.messageId} turn={t} onJump={onJump} />
          ))}
        </div>
      )}
    </Section>
  );
}

function ProvenanceTurn({ turn, onJump }: { turn: Turn; onJump?: (file: string, line: number | null) => void }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<ChatMessage | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !msg && !loading) {
      setLoading(true);
      ipc.getMessage(turn.messageId)
        .then(setMsg)
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  };

  return (
    <div className="rounded-sm border-l-2 border-[var(--brass-dim)] pl-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
      >
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-octo-brass" />
        <span className="font-mono text-[10px] text-octo-sage">
          {turn.latest ? formatRelTime(turn.latest) : "edit"}
        </span>
        <span className="font-mono text-[10px] text-octo-mute">
          · {turn.files.length} file{turn.files.length !== 1 ? "s" : ""}
        </span>
        <ChevronDown
          size={11}
          aria-hidden
          className={`ml-auto text-octo-mute transition-transform duration-[var(--dur-quick)] ease-[var(--ease-octo)] ${open ? "" : "-rotate-90"}`}
        />
      </button>

      <div
        className="grid transition-[grid-template-rows] duration-[var(--dur-quick)] ease-[var(--ease-octo)]"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="min-h-0 overflow-hidden pb-1.5">
          {/* File chips — click to jump to the file in the diff. */}
          <div className="mb-1 flex flex-wrap gap-1">
            {turn.files.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => onJump?.(f, null)}
                title={`Jump to ${f}`}
                className="max-w-full truncate rounded-sm px-1.5 py-px font-mono text-[9px] text-octo-brass transition-colors hover:bg-[var(--brass-ghost)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                style={{ border: "1px solid var(--brass-dim)" }}
              >
                {f.split("/").pop()}
              </button>
            ))}
          </div>
          {loading ? (
            <div className="flex items-center gap-2 text-[10px] text-octo-mute">
              <Loader2 size={11} className="animate-spin" /> Loading turn…
            </div>
          ) : msg ? (
            <>
              {msg.model && (
                <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute">{msg.model}</div>
              )}
              <p className="mt-0.5 max-h-24 overflow-y-auto whitespace-pre-wrap text-[11px] leading-[1.5] text-octo-sage">
                {msg.content.length > 360 ? msg.content.slice(0, 360) + "…" : msg.content}
              </p>
            </>
          ) : (
            <p className="text-[10px] text-octo-mute">No message linked to this turn.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Branch & publish ─────────────────────────────────────────────

function BranchPublish({
  workspaceId,
  workspacePath,
  gitStatus,
}: {
  workspaceId: string;
  workspacePath: string;
  gitStatus: GitStatus | null;
}) {
  const [lastCommit, setLastCommit] = useState<LastCommit | null>(null);
  // Commits since the base (#851), from the committed view App fetches in
  // Review — no IPC of its own.
  const committed = useReviewSource((s) => s.committedByWs[workspaceId] ?? null);
  const sinceBase = committed && committed.commits > 0 ? committed : null;

  const ahead = gitStatus?.ahead ?? 0;
  const behind = gitStatus?.behind ?? 0;
  const hasUpstream = gitStatus?.hasUpstream ?? false;
  const branch = gitStatus?.branch ?? null;

  // Re-fetch the tip commit when the commit state moves (ahead count / branch),
  // not just on workspace switch — so committing from the left panel updates
  // the cockpit's "last commit" instead of leaving it stale.
  useEffect(() => {
    let cancelled = false;
    ipc.getLastCommit(workspacePath)
      .then((c) => { if (!cancelled) setLastCommit(c); })
      .catch(() => { if (!cancelled) setLastCommit(null); });
    return () => { cancelled = true; };
  }, [workspacePath, ahead, branch]);

  // git timed out (or failed) counting commits: 0/0 would read as in sync,
  // which it may not be.
  const aheadBehindKnown = gitStatus?.aheadBehindKnown ?? true;

  const sync = !hasUpstream
    ? { text: "Not published yet", tone: "text-octo-brass" }
    : !aheadBehindKnown
      ? { text: "—", tone: "text-octo-mute", title: "Ahead/behind unknown: git couldn't compare with origin in time" }
      : ahead === 0 && behind === 0
      ? { text: "Up to date with origin", tone: "text-octo-verdigris" }
      : { text: `${ahead > 0 ? `↑${ahead} ahead` : ""}${ahead > 0 && behind > 0 ? " · " : ""}${behind > 0 ? `↓${behind} behind` : ""}`, tone: "text-octo-sage" };

  return (
    <Section title="Branch & publish" border={false}>
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <GitBranch size={12} className="shrink-0 text-octo-mute" aria-hidden />
        <span className={`octo-tabular ${sync.tone}`} title={"title" in sync ? sync.title : undefined}>{sync.text}</span>
      </div>
      {sinceBase && (
        <div
          data-tour="review-companion-ahead"
          className="octo-fade-in mt-1.5 flex items-center gap-1.5 font-mono text-[11px] text-octo-sage"
          title={`Commits on this branch since ${baseName(sinceBase.base)}${sinceBase.mergeBase ? ` (merge base ${sinceBase.mergeBase})` : ""}`}
        >
          <GitCompare size={12} className="shrink-0 text-octo-mute" aria-hidden />
          <span className="octo-tabular">
            {commitCount(sinceBase.commits)} ahead of {baseName(sinceBase.base)}
          </span>
        </div>
      )}
      {sinceBase?.base && (
        <BranchSecretScan
          key={`${workspacePath}|${sinceBase.base}|${sinceBase.mergeBase ?? ""}|${sinceBase.head ?? ""}|${sinceBase.commits}`}
          workspacePath={workspacePath}
          base={sinceBase.base}
          commits={sinceBase.commits}
        />
      )}
      {lastCommit && (
        <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-octo-sage">
          <GitCommit size={12} className="mt-0.5 shrink-0 text-octo-mute" aria-hidden />
          <span className="min-w-0">
            <span className="font-mono text-[10px] text-octo-mute">{lastCommit.shortSha}</span>{" "}
            <span className="text-octo-sage">{lastCommit.subject}</span>
          </span>
        </div>
      )}
    </Section>
  );
}

// ─── Branch secret scan (#820) ────────────────────────────────────

const SCAN_SHOWN = 5;

type BranchScan =
  | { state: "idle" }
  | { state: "scanning" }
  | { state: "done"; result: SecretPreview }
  | { state: "failed" };

/** "Scan this branch's commits": the secret guard's rules over every commit
 *  since the base, only when asked, never automatic. Read-only: it blocks
 *  nothing. The caller keys it on the branch's commits and HEAD, so a new
 *  commit or an amend drops a result that no longer covers the branch. */
export function BranchSecretScan({ workspacePath, base, commits }: { workspacePath: string; base: string; commits: number }) {
  const [scan, setScan] = useState<BranchScan>({ state: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const run = () => {
    setScan({ state: "scanning" });
    ipc.secretScanBranch(workspacePath, base)
      .then((result) => { if (alive.current) setScan({ state: "done", result }); })
      .catch(() => { if (alive.current) setScan({ state: "failed" }); });
  };

  return (
    <div className="mt-1.5 text-[11px]">
      {scan.state === "scanning" ? (
        <div className="octo-fade-in flex items-center gap-1.5 font-mono text-octo-sage">
          <Loader2 size={12} aria-hidden className="shrink-0 animate-spin text-octo-mute" />
          Scanning {commitCount(commits)}…
        </div>
      ) : (
        <button
          type="button"
          data-tour="review-companion-scan-branch"
          onClick={run}
          title={`Check every commit since ${baseName(base)} for possible secrets. Changes nothing.`}
          className="flex items-center gap-1.5 font-serif text-[12px] text-octo-sage underline decoration-octo-hairline underline-offset-2 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-octo)] hover:text-octo-brass hover:decoration-octo-brass-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          <ShieldCheck size={12} aria-hidden className="shrink-0 text-octo-mute" />
          {scan.state === "idle" ? "Scan this branch's commits" : "Scan again"}
        </button>
      )}
      {scan.state === "done" && <BranchScanResult result={scan.result} commits={commits} />}
      {scan.state === "failed" && (
        <p className="octo-fade-in mt-1 text-octo-mute">Couldn't read this branch's commits.</p>
      )}
    </div>
  );
}

function BranchScanResult({ result, commits }: { result: SecretPreview; commits: number }) {
  const total = Math.max(result.total, result.findings.length);
  const shown = result.findings.slice(0, SCAN_SHOWN);
  const more = total - shown.length;
  return (
    <div data-tour="review-companion-scan-result" className="octo-fade-in mt-1">
      <div className="flex items-start gap-1.5 leading-snug text-octo-sage">
        {total > 0 ? (
          <ShieldAlert size={12} aria-hidden className="mt-[1px] shrink-0 text-octo-rouge" />
        ) : (
          <ShieldCheck size={12} aria-hidden className="mt-[1px] shrink-0 text-octo-verdigris" />
        )}
        <span className="min-w-0">{branchScanSummary(result, commits)}</span>
      </div>
      {total > 0 && (
        <>
          <ul aria-label="Found in this branch's commits" className="mt-1 space-y-0.5 pl-[18px]">
            {shown.map((f, i) => (
              <li key={`${f.file}:${f.line ?? 0}:${f.rule}:${i}`} className="flex min-w-0 items-baseline gap-2 font-mono text-[10px]">
                <span className="shrink-0 text-octo-sage">{f.kind}</span>
                <span className="min-w-0 truncate text-octo-mute" title={findingLocation(f)}>{findingLocation(f)}</span>
                {f.preview && (
                  <span className="ml-auto shrink-0 text-octo-mute" title={PREVIEW_TIP}>{f.preview}</span>
                )}
              </li>
            ))}
            {more > 0 && <li className="font-mono text-[10px] text-octo-mute">and {more} more</li>}
          </ul>
          {result.partial && <p className="mt-1 pl-[18px] text-octo-mute">{PARTIAL_NOTE}</p>}
          <p className="mt-1 pl-[18px] leading-snug text-octo-mute">
            A later commit that removes a key leaves it in the history: rotate a real one.
          </p>
        </>
      )}
    </div>
  );
}

// ─── Section shell ────────────────────────────────────────────────

function Section({
  title,
  children,
  border = true,
}: {
  title: string;
  children: React.ReactNode;
  border?: boolean;
}) {
  return (
    <section className={border ? "border-b border-octo-hairline" : ""}>
      <div className="flex h-9 items-center px-4">
        <h3 className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
          {title === "How this change was built" && <Sparkles size={11} aria-hidden />}
          {title}
        </h3>
      </div>
      <div className="px-4 pb-3">{children}</div>
    </section>
  );
}
