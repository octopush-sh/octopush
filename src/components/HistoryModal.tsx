/**
 * HistoryModal — commit log browser for the Review mode (G7 slices III–V).
 *
 * A ModalShell over a windowed, paginated `git log`: mono rows (short sha ·
 * summary · author + relative time), click-to-expand inline commit diff
 * (vs first parent), a quiet "More" for the next page, and per-row actions:
 * copy SHA, cherry-pick, tag, and a confirm-gated reset (soft/mixed/hard).
 */

import { useEffect, useState } from "react";
import { Cherry, Copy, Loader2, Tag, Undo2 } from "lucide-react";
import { ipc } from "../lib/ipc";
import type { CommitInfo } from "../lib/ipc";
import { copyToClipboard } from "../lib/clipboard";
import { formatRelTime } from "../lib/relTime";
import { pushToast } from "./Toasts";
import { ModalShell } from "./ModalShell";
import { FileNameDialog } from "./FileNameDialog";
import { Reveal } from "./primitives/Reveal";

/** Page size for the log walk — a full page implies "there may be more". */
export const HISTORY_PAGE = 50;

interface Props {
  projectPath: string;
  onClose: () => void;
  /** Called after a mutation (cherry-pick / reset) so the parent refreshes
   *  git status + diff downstream. */
  onRepoChanged?: () => void;
}

type ResetMode = "soft" | "mixed" | "hard";

function validateTagName(name: string): string | null {
  if (name === "") return "Tag name is required.";
  if (/\s/.test(name)) return "Tag names cannot contain spaces.";
  if (name.startsWith("-")) return "Tag names cannot start with a dash.";
  if (name.includes("..")) return 'Tag names cannot contain "..".';
  return null;
}

export function HistoryModal({ projectPath, onClose, onRepoChanged }: Props) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [expandedSha, setExpandedSha] = useState<string | null>(null);
  const [diffBySha, setDiffBySha] = useState<Record<string, string>>({});
  const [busySha, setBusySha] = useState<string | null>(null);
  const [tagTarget, setTagTarget] = useState<CommitInfo | null>(null);
  const [resetTarget, setResetTarget] = useState<CommitInfo | null>(null);

  async function loadPage(skip: number) {
    try {
      const page = await ipc.gitLog(projectPath, HISTORY_PAGE, skip);
      setCommits((prev) => (skip === 0 ? page : [...prev, ...page]));
      setHasMore(page.length === HISTORY_PAGE);
    } catch (e) {
      pushToast({ level: "error", title: "Couldn't load history", body: String(e) });
    } finally {
      setLoaded(true);
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    void loadPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  async function toggleExpand(c: CommitInfo) {
    if (expandedSha === c.sha) {
      setExpandedSha(null);
      return;
    }
    setExpandedSha(c.sha);
    if (diffBySha[c.sha] === undefined) {
      try {
        const diff = await ipc.commitDiff(projectPath, c.sha);
        setDiffBySha((prev) => ({ ...prev, [c.sha]: diff }));
      } catch (e) {
        setDiffBySha((prev) => ({ ...prev, [c.sha]: `Couldn't load this diff: ${e}` }));
      }
    }
  }

  async function doCherryPick(c: CommitInfo) {
    setBusySha(c.sha);
    try {
      const r = await ipc.cherryPick(projectPath, c.sha);
      if (r.kind === "ok") {
        pushToast({ level: "success", title: "Cherry-picked", body: `${c.shaShort} ${c.summary}` });
        onRepoChanged?.();
        await loadPage(0); // the log gained a commit — reload from the top
      } else if (r.kind === "conflict") {
        pushToast({
          level: "warning",
          title: "Cherry-pick conflicts",
          body: "Resolve the conflicted files, then continue or abort.",
        });
        onRepoChanged?.();
        onClose(); // surface the conflict section in the Changes panel
      } else {
        pushToast({ level: "error", title: "Cherry-pick failed", body: r.output });
      }
    } catch (e) {
      pushToast({ level: "error", title: "Cherry-pick failed", body: String(e) });
    } finally {
      setBusySha(null);
    }
  }

  async function doCreateTag(name: string) {
    const target = tagTarget;
    setTagTarget(null);
    if (!target) return;
    try {
      await ipc.createTag(projectPath, name, target.sha);
      pushToast({ level: "success", title: "Tag created", body: `${name} at ${target.shaShort}` });
    } catch (e) {
      pushToast({ level: "error", title: "Couldn't create the tag", body: String(e) });
    }
  }

  async function doReset(mode: ResetMode) {
    const target = resetTarget;
    setResetTarget(null);
    if (!target) return;
    setBusySha(target.sha);
    try {
      await ipc.resetHead(projectPath, mode, target.sha);
      pushToast({
        level: "success",
        title: `Reset (${mode})`,
        body: `HEAD is now at ${target.shaShort} ${target.summary}`,
      });
      onRepoChanged?.();
      await loadPage(0); // commits after the target left the branch
    } catch (e) {
      pushToast({ level: "error", title: "Reset failed", body: String(e) });
    } finally {
      setBusySha(null);
    }
  }

  return (
    <>
    <ModalShell onClose={onClose} ariaLabel="Commit history" panelClassName="w-[680px] max-w-[92vw]">
      <div className="flex max-h-[72vh] flex-col overflow-hidden rounded-lg border border-octo-hairline bg-octo-panel">
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-octo-hairline px-4">
          <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
            History
          </span>
          {loaded && commits.length > 0 && (
            <span className="font-mono text-[10px] text-octo-mute">
              {commits.length}
              {hasMore ? "+" : ""} commit{commits.length === 1 && !hasMore ? "" : "s"}
            </span>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {!loaded ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 size={14} className="animate-spin text-octo-mute" />
            </div>
          ) : commits.length === 0 ? (
            <div className="px-4 py-10 text-center font-serif text-[13px] text-octo-mute">
              No commits yet on this branch.
            </div>
          ) : (
            <ul>
              {commits.map((c) => {
                const open = expandedSha === c.sha;
                return (
                  <li key={c.sha} className="octo-rise-in border-b border-octo-hairline/60 last:border-b-0">
                    <div
                      className={`group flex items-center gap-2 px-4 transition-colors ${
                        open ? "bg-[var(--brass-ghost)]" : "hover:bg-octo-panel-2"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => void toggleExpand(c)}
                        title={open ? "Collapse this commit's diff" : "Show this commit's diff"}
                        className="flex min-w-0 flex-1 items-baseline gap-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                      >
                        <span
                          className="shrink-0 font-mono text-[10.5px]"
                          style={{ color: "var(--brass-dim)" }}
                        >
                          {c.shaShort}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-octo-ivory">
                          {c.summary}
                        </span>
                        <span className="shrink-0 font-mono text-[9.5px] text-octo-mute">
                          {c.authorName} · {formatRelTime(c.timestampMs)}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label="Copy SHA"
                        title={`Copy ${c.sha}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void copyToClipboard(c.sha, "SHA copied");
                        }}
                        className={ROW_ACTION}
                      >
                        <Copy size={12} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Cherry-pick ${c.shaShort}`}
                        title="Cherry-pick this commit onto the current branch"
                        disabled={busySha !== null}
                        onClick={(e) => {
                          e.stopPropagation();
                          void doCherryPick(c);
                        }}
                        className={ROW_ACTION}
                      >
                        {busySha === c.sha ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Cherry size={12} />
                        )}
                      </button>
                      <button
                        type="button"
                        aria-label={`Tag ${c.shaShort}`}
                        title="Create a tag at this commit"
                        disabled={busySha !== null}
                        onClick={(e) => {
                          e.stopPropagation();
                          setTagTarget(c);
                        }}
                        className={ROW_ACTION}
                      >
                        <Tag size={12} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Reset to ${c.shaShort}`}
                        title="Reset the branch to this commit (choose soft, mixed or hard)"
                        disabled={busySha !== null}
                        onClick={(e) => {
                          e.stopPropagation();
                          setResetTarget(c);
                        }}
                        className={ROW_ACTION_DANGER}
                      >
                        <Undo2 size={12} />
                      </button>
                    </div>
                    <Reveal open={open}>
                      <div className="border-t border-octo-hairline/60 bg-octo-onyx px-4 py-2">
                        {diffBySha[c.sha] === undefined ? (
                          <div className="flex items-center gap-2 py-1 font-mono text-[10px] text-octo-mute">
                            <Loader2 size={10} className="animate-spin" /> loading diff
                          </div>
                        ) : diffBySha[c.sha] === "" ? (
                          <div className="py-1 font-serif text-[12px] text-octo-mute">
                            This commit introduces no textual changes.
                          </div>
                        ) : (
                          <pre className="max-h-72 overflow-auto whitespace-pre font-mono text-[11px] leading-[1.55] text-octo-sage">
                            {diffBySha[c.sha]}
                          </pre>
                        )}
                      </div>
                    </Reveal>
                  </li>
                );
              })}
            </ul>
          )}

          {loaded && hasMore && (
            <div className="flex justify-center py-2">
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => {
                  setLoadingMore(true);
                  void loadPage(commits.length);
                }}
                title="Load older commits"
                className="rounded px-3 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute transition-colors hover:text-octo-brass disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
              >
                {loadingMore ? "…" : "More"}
              </button>
            </div>
          )}
        </div>
      </div>
    </ModalShell>

    {/* Stacked dialogs render as siblings — ModalShell's entrance transform
        would otherwise trap their fixed positioning. */}
    {tagTarget && (
      <FileNameDialog
        title={`Tag ${tagTarget.shaShort}`}
        label="Tag name"
        confirmLabel="Create tag"
        validate={validateTagName}
        onSubmit={(name) => void doCreateTag(name)}
        onClose={() => setTagTarget(null)}
      />
    )}

    {resetTarget && (
      <ResetDialog
        commit={resetTarget}
        onConfirm={(mode) => void doReset(mode)}
        onCancel={() => setResetTarget(null)}
      />
    )}
    </>
  );
}

// Hidden-until-hover per-row action chrome (shared by copy/cherry-pick/tag).
const ROW_ACTION =
  "shrink-0 rounded p-1 text-octo-mute opacity-0 transition group-hover:opacity-70 hover:!text-octo-brass disabled:opacity-30 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass";

// Reset is destructive-leaning — it warms to rouge instead of brass.
const ROW_ACTION_DANGER =
  "shrink-0 rounded p-1 text-octo-mute opacity-0 transition group-hover:opacity-70 hover:!text-octo-rouge disabled:opacity-30 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-rouge";

// ─── Reset dialog ──────────────────────────────────────────────────

const RESET_MODES: { mode: ResetMode; hint: string; danger?: boolean }[] = [
  { mode: "soft", hint: "Keep all later changes, staged" },
  { mode: "mixed", hint: "Keep all later changes in the working tree, unstaged" },
  { mode: "hard", hint: "Discard every change after this commit — irreversible", danger: true },
];

function ResetDialog({
  commit,
  onConfirm,
  onCancel,
}: {
  commit: CommitInfo;
  onConfirm: (mode: ResetMode) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<ResetMode>("mixed");
  const hard = mode === "hard";

  return (
    <ModalShell
      onClose={onCancel}
      closeOnBackdrop={false}
      ariaLabel="Reset branch"
      panelClassName="w-full max-w-[420px]"
    >
      <div className="rounded-xl border border-octo-hairline bg-octo-panel p-6 shadow-2xl">
        <h2 className="font-serif text-[18px] leading-tight tracking-[-0.005em] text-octo-ivory">
          Reset to {commit.shaShort}
        </h2>
        <p className="mt-2 truncate font-mono text-[11px] text-octo-sage" title={commit.summary}>
          {commit.summary}
        </p>

        <div role="radiogroup" aria-label="Reset mode" className="mt-4 space-y-1">
          {RESET_MODES.map((m) => {
            const selected = mode === m.mode;
            return (
              <button
                key={m.mode}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setMode(m.mode)}
                className={`flex w-full items-baseline gap-2 rounded-md border px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-1 ${
                  m.danger
                    ? "focus-visible:ring-octo-rouge"
                    : "focus-visible:ring-octo-brass"
                } ${
                  selected
                    ? m.danger
                      ? "border-[color:var(--rouge-border)] bg-[var(--rouge-ghost)]"
                      : "border-[color:var(--brass-dim)] bg-[var(--brass-ghost)]"
                    : "border-octo-hairline hover:bg-octo-panel-2"
                }`}
              >
                <span
                  className={`w-12 shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] ${
                    m.danger ? "text-octo-rouge" : selected ? "text-octo-brass" : "text-octo-sage"
                  }`}
                >
                  {m.mode}
                </span>
                <span className="text-[11px] leading-snug text-octo-sage">{m.hint}</span>
              </button>
            );
          })}
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-4 py-2 font-mono text-[11px] text-octo-sage transition hover:text-octo-ivory"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(mode)}
            className={`rounded-md border px-4 py-2 font-mono text-[11px] transition ${
              hard
                ? "border-[color:var(--rouge-border)] bg-[var(--rouge-active-bg)] text-octo-rouge"
                : "border-[color:var(--brass-dim)] bg-[var(--brass-ghost)] text-octo-brass"
            }`}
          >
            {hard ? "Reset hard" : `Reset (${mode})`}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
