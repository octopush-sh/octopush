/**
 * ChangesPanel — interactive stage/commit/push rail for the Review mode.
 *
 * Job 1: a clickable index of changed files split into Staged / Unstaged.
 *        Click a row to toggle its stage status.
 * Job 2: type a commit message and commit the staged changes.
 * Job 3: publish the branch (push --set-upstream).
 *
 * Identity (branch name, project) lives in the workspace header above —
 * this panel deliberately doesn't restate it.
 */

import { useEffect, useState, useCallback } from "react";
import {
  FilePlus,
  FileEdit,
  FileX,
  FileMinus,
  ArrowUpRight,
  Check,
  Loader2,
  GitCommit,
} from "lucide-react";
import { ipc } from "../lib/ipc";
import type { FileChange, GitStatus } from "../lib/types";
import { pushToast } from "./Toasts";

interface Props {
  projectPath: string;
  /** Diff text — drives the +/- line summary in the eyebrow. */
  diff?: string;
  /** Optional: called when a file row is clicked. The parent typically
   *  scrolls the canvas to that file's diff section. */
  onFileClick?: (filePath: string) => void;
  /** Optional: called after a successful commit or push, so the parent can
   *  refresh git status / diff downstream. */
  onChange?: () => void;
}

const POLL_MS = 5_000;

export function ChangesPanel({ projectPath, diff = "", onFileClick, onChange }: Props) {
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const status = await ipc.getGitStatus(projectPath);
      setGitStatus(status);
    } catch {
      // silently ignore — project may not be a git repo yet
    }
  }, [projectPath]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const files = gitStatus?.changedFiles ?? [];
  const staged = files.filter((f) => f.staged);
  const unstaged = files.filter((f) => f.unstaged);
  const ahead = gitStatus?.ahead ?? 0;
  const hasUpstream = gitStatus?.hasUpstream ?? false;

  // +/− line totals derived from the diff.
  const addCount = diff
    ? diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length
    : 0;
  const delCount = diff
    ? diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length
    : 0;

  async function toggleStage(file: FileChange) {
    setBusyPath(file.path);
    try {
      if (file.staged && !file.unstaged) {
        await ipc.unstageFile(projectPath, file.path);
      } else {
        await ipc.stageFile(projectPath, file.path);
      }
      await refresh();
      onChange?.();
    } catch (e) {
      pushToast({ level: "error", title: "Stage toggle failed", body: String(e) });
    } finally {
      setBusyPath(null);
    }
  }

  async function handleUnstageAll() {
    if (staged.length === 0) return;
    setBusyPath("__all__");
    try {
      await ipc.unstageAllChanges(projectPath);
      await refresh();
      onChange?.();
    } catch (e) {
      pushToast({ level: "error", title: "Unstage all failed", body: String(e) });
    } finally {
      setBusyPath(null);
    }
  }

  async function handleCommit() {
    if (!commitMessage.trim() || staged.length === 0) return;
    setCommitting(true);
    try {
      const sha = await ipc.commitChanges(projectPath, commitMessage.trim());
      pushToast({ level: "success", title: "Committed", body: sha });
      setCommitMessage("");
      await refresh();
      onChange?.();
    } catch (e) {
      pushToast({ level: "error", title: "Commit failed", body: String(e) });
    } finally {
      setCommitting(false);
    }
  }

  async function handlePush() {
    setPushing(true);
    try {
      const result = await ipc.pushBranch(projectPath);
      pushToast({
        level: "success",
        title: "Branch published",
        body: result.split("\n").slice(-1)[0] || undefined,
      });
      await refresh();
      onChange?.();
    } catch (e) {
      pushToast({ level: "error", title: "Push failed", body: String(e) });
    } finally {
      setPushing(false);
    }
  }

  const canCommit = staged.length > 0 && commitMessage.trim().length > 0 && !committing;
  // Push enabled when:
  //  - there are commits ahead of upstream (normal case), OR
  //  - the branch has no upstream yet AND there's at least one commit to push
  //    (first publish). We can't easily tell "has any commits" from here, but
  //    a branch without an upstream effectively needs a first publish, so we
  //    enable Publish unconditionally in that case; the backend will surface
  //    a clear error if the branch is genuinely empty.
  const canPush = !pushing && (ahead > 0 || !hasUpstream);

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden bg-octo-panel">
      {/* Eyebrow row — aligned with canvas toolbar and FILES rail. */}
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-octo-hairline px-4">
        <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
          Changes
        </span>
        {(addCount > 0 || delCount > 0) && (
          <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute">
            <span className="text-octo-verdigris">+{addCount}</span>
            <span className="px-1 opacity-50">/</span>
            <span className="text-octo-rouge">−{delCount}</span>
          </span>
        )}
      </header>

      {/* Scrollable section list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {files.length === 0 ? (
          <EmptyHint />
        ) : (
          <>
            <Section
              label="Staged"
              count={staged.length}
              files={staged}
              busyPath={busyPath}
              onRowClick={onFileClick}
              onToggle={toggleStage}
              toggleMode="unstage"
              emptyHint="Nothing staged."
              headerAction={
                staged.length > 0 ? (
                  <button
                    type="button"
                    onClick={handleUnstageAll}
                    disabled={busyPath === "__all__"}
                    className="font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute transition-colors hover:text-octo-brass disabled:opacity-50"
                    title="Move every staged file back to unstaged"
                  >
                    {busyPath === "__all__" ? "…" : "unstage all"}
                  </button>
                ) : null
              }
            />
            <Section
              label="Unstaged"
              count={unstaged.length}
              files={unstaged}
              busyPath={busyPath}
              onRowClick={onFileClick}
              onToggle={toggleStage}
              toggleMode="stage"
              emptyHint="Nothing pending."
            />
          </>
        )}
      </div>

      {/* Commit + Publish actions */}
      <div className="space-y-2 border-t border-octo-hairline p-3">
        <textarea
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder="Describe what you're shipping…"
          rows={2}
          disabled={committing}
          className="w-full resize-none rounded-md border border-octo-hairline bg-octo-onyx px-3 py-1.5 font-mono text-[12px] leading-[1.5] text-octo-ivory outline-none transition-colors placeholder:font-serif placeholder:italic placeholder:text-octo-mute focus:border-octo-brass disabled:opacity-50"
        />

        <button
          onClick={handleCommit}
          disabled={!canCommit}
          className="flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            color: canCommit ? "var(--color-octo-brass)" : "var(--color-octo-mute)",
            background: canCommit ? "var(--brass-ghost)" : "transparent",
            border: canCommit
              ? "1px solid var(--brass-dim)"
              : "1px solid var(--color-octo-hairline)",
          }}
        >
          {committing ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <GitCommit size={11} />
          )}
          {staged.length > 0
            ? `Commit ${staged.length} file${staged.length !== 1 ? "s" : ""}`
            : "Commit"}
        </button>

        <button
          onClick={handlePush}
          disabled={!canPush}
          title={
            !hasUpstream
              ? "Push this branch to origin for the first time."
              : ahead === 0
                ? "Nothing to publish — make a commit first."
                : `Push ${ahead} commit${ahead !== 1 ? "s" : ""} to origin`
          }
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-octo-hairline bg-octo-onyx/50 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-octo-mute transition-colors hover:text-octo-sage disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pushing ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <ArrowUpRight size={11} />
          )}
          {!hasUpstream ? "Publish branch" : "Push to origin"}
          {ahead > 0 && (
            <span className="ml-1 text-octo-brass">· {ahead} ahead</span>
          )}
        </button>
      </div>
    </aside>
  );
}

// ─── Section ───────────────────────────────────────────────────────

function Section({
  label,
  count,
  files,
  busyPath,
  onRowClick,
  onToggle,
  toggleMode,
  emptyHint,
  headerAction,
}: {
  label: string;
  count: number;
  files: FileChange[];
  busyPath: string | null;
  onRowClick?: (path: string) => void;
  onToggle: (file: FileChange) => void;
  toggleMode: "stage" | "unstage";
  emptyHint: string;
  headerAction?: React.ReactNode;
}) {
  return (
    <div className="border-b border-octo-hairline/60 last:border-b-0">
      <div className="flex items-center gap-2 px-4 pt-2.5 pb-1">
        <span className="font-mono text-[8px] uppercase tracking-[0.25em] text-octo-mute">
          {label}
        </span>
        <span className="font-mono text-[10px] text-octo-mute">{count}</span>
        {headerAction && <span className="ml-auto">{headerAction}</span>}
      </div>
      {count === 0 ? (
        <div className="px-4 pb-2 font-serif italic text-[11px] text-octo-mute">
          {emptyHint}
        </div>
      ) : (
        <ul className="pb-2">
          {files.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              busy={busyPath === file.path}
              onClick={() => onRowClick?.(file.path)}
              onToggle={() => onToggle(file)}
              toggleMode={toggleMode}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── File row ──────────────────────────────────────────────────────

function FileRow({
  file,
  busy,
  onClick,
  onToggle,
  toggleMode,
}: {
  file: FileChange;
  busy: boolean;
  onClick: () => void;
  onToggle: () => void;
  toggleMode: "stage" | "unstage";
}) {
  return (
    <li className="group flex items-center gap-2 px-3 transition-colors hover:bg-[var(--brass-ghost)]">
      {/* Stage / unstage toggle */}
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        title={toggleMode === "stage" ? "Stage this file" : "Unstage this file"}
        aria-label={toggleMode === "stage" ? "Stage file" : "Unstage file"}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-octo-panel-2"
      >
        {busy ? (
          <Loader2 size={11} className="animate-spin text-octo-mute" />
        ) : toggleMode === "stage" ? (
          <span
            aria-hidden
            className="h-3 w-3 rounded-sm border border-octo-hairline transition-colors group-hover:border-octo-brass"
          />
        ) : (
          <span
            aria-hidden
            className="flex h-3 w-3 items-center justify-center rounded-sm border border-octo-brass"
            style={{ background: "var(--brass-ghost)" }}
          >
            <Check size={9} className="text-octo-brass" strokeWidth={3} />
          </span>
        )}
      </button>

      {/* Clickable file label — scrolls canvas to this file */}
      <button
        type="button"
        onClick={onClick}
        className="flex flex-1 items-center gap-2 truncate py-1.5 text-left text-[12px]"
        title={file.path}
      >
        <FileStatusIcon status={file.status} />
        <span className="flex-1 truncate font-mono text-octo-ivory">
          {shortenPath(file.path)}
        </span>
        <StatusGlyph status={file.status} />
      </button>
    </li>
  );
}

function FileStatusIcon({ status }: { status: FileChange["status"] }) {
  const props = { size: 12 };
  switch (status) {
    case "new":
      return <FilePlus {...props} className="shrink-0 text-octo-verdigris" />;
    case "modified":
      return <FileEdit {...props} className="shrink-0 text-octo-brass" />;
    case "deleted":
      return <FileX {...props} className="shrink-0 text-octo-rouge" />;
    case "renamed":
      return <FileMinus {...props} className="shrink-0 text-octo-sage" />;
    default:
      return <FileEdit {...props} className="shrink-0 text-octo-mute" />;
  }
}

function StatusGlyph({ status }: { status: FileChange["status"] }) {
  const map: Record<FileChange["status"], { letter: string; color: string }> = {
    new: { letter: "N", color: "text-octo-verdigris" },
    modified: { letter: "M", color: "text-octo-brass" },
    deleted: { letter: "D", color: "text-octo-rouge" },
    renamed: { letter: "R", color: "text-octo-sage" },
    unknown: { letter: "?", color: "text-octo-mute" },
  };
  const { letter, color } = map[status];
  return (
    <span className={`font-mono text-[9px] uppercase tracking-[0.2em] ${color}`}>
      {letter}
    </span>
  );
}

function shortenPath(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 2) return filePath;
  return "…/" + parts.slice(-2).join("/");
}

// ─── Empty hint ────────────────────────────────────────────────────

function EmptyHint() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <div className="font-serif italic text-[13px] text-octo-mute">
        Working tree is clean.
      </div>
      <div className="h-px w-6 bg-octo-brass/40" aria-hidden />
    </div>
  );
}
