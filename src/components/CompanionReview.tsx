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
 *   3. Branch & publish — upstream / ahead-behind / last commit at a glance.
 */

import { useEffect, useMemo, useState } from "react";
import { Sparkles, GitBranch, Loader2, ChevronDown, GitCommit } from "lucide-react";
import { ipc } from "../lib/ipc";
import type { LastCommit } from "../lib/ipc";
import type { GitStatus, FileEdit, ChatMessage } from "../lib/types";
import { formatRelTime } from "../lib/relTime";

interface Props {
  workspaceId: string;
  workspacePath: string;
  gitStatus: GitStatus | null;
  gitDiff: string;
  /** Jump to a file in the diff (scrolls + highlights). */
  onJump?: (file: string, line: number | null) => void;
}

export function CompanionReview({ workspaceId, workspacePath, gitStatus, gitDiff, onJump }: Props) {
  const files = gitStatus?.changedFiles ?? [];
  const staged = files.filter((f) => f.staged).length;
  const conflicted = gitStatus?.conflicted ?? 0;
  const fileCount = files.length;

  const { addCount, delCount } = useMemo(() => {
    if (!gitDiff) return { addCount: 0, delCount: 0 };
    let a = 0, d = 0;
    for (const l of gitDiff.split("\n")) {
      if (l.startsWith("+") && !l.startsWith("+++")) a++;
      else if (l.startsWith("-") && !l.startsWith("---")) d++;
    }
    return { addCount: a, delCount: d };
  }, [gitDiff]);

  // ── Verdict — deliberately AI-free; the AI review lives in the diff. ──
  const verdict =
    fileCount === 0
      ? { text: "Working tree is clean.", tone: "text-octo-mute" }
      : conflicted > 0
        ? { text: `Resolve ${conflicted} conflict${conflicted !== 1 ? "s" : ""} first.`, tone: "text-octo-rouge" }
        : staged > 0
          ? { text: `${staged} staged · ready to commit.`, tone: "text-octo-ivory" }
          : { text: `${fileCount} change${fileCount !== 1 ? "s" : ""} to review.`, tone: "text-octo-ivory" };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* ── Readiness hero ──────────────────────────────────────── */}
      <div className="border-b border-octo-hairline px-4 py-3">
        <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">Review</div>
        <div className={`mt-1.5 font-serif text-[15px] leading-snug ${verdict.tone}`}>{verdict.text}</div>
        <div
          className="mt-2 h-px w-7"
          style={{ background: "linear-gradient(90deg, var(--color-octo-brass), transparent)" }}
          aria-hidden
        />
        {fileCount > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-octo-mute octo-tabular">
            <span>{fileCount} file{fileCount !== 1 ? "s" : ""}</span>
            {addCount > 0 && <span className="text-octo-verdigris">+{addCount}</span>}
            {delCount > 0 && <span className="text-octo-rouge">−{delCount}</span>}
            {staged > 0 && <span className="text-octo-sage">{staged} staged</span>}
          </div>
        )}
      </div>

      {/* ── Provenance ──────────────────────────────────────────── */}
      <Provenance workspaceId={workspaceId} files={files} onJump={onJump} />

      {/* ── Branch & publish ────────────────────────────────────── */}
      <BranchPublish workspacePath={workspacePath} gitStatus={gitStatus} />
    </div>
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
        <span aria-hidden className="font-mono text-[10px] text-octo-brass">§</span>
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

function BranchPublish({ workspacePath, gitStatus }: { workspacePath: string; gitStatus: GitStatus | null }) {
  const [lastCommit, setLastCommit] = useState<LastCommit | null>(null);

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

  const sync = !hasUpstream
    ? { text: "Not published yet", tone: "text-octo-brass" }
    : ahead === 0 && behind === 0
      ? { text: "Up to date with origin", tone: "text-octo-verdigris" }
      : { text: `${ahead > 0 ? `↑${ahead} ahead` : ""}${ahead > 0 && behind > 0 ? " · " : ""}${behind > 0 ? `↓${behind} behind` : ""}`, tone: "text-octo-sage" };

  return (
    <Section title="Branch & publish" border={false}>
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <GitBranch size={12} className="shrink-0 text-octo-mute" aria-hidden />
        <span className={`octo-tabular ${sync.tone}`}>{sync.text}</span>
      </div>
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
