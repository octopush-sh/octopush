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

import { useEffect, useState, useCallback, useRef } from "react";
import {
  FilePlus,
  FileEdit,
  FileX,
  FileMinus,
  ArrowUpRight,
  Check,
  Loader2,
  GitCommit,
  Pencil,
  Sparkles,
} from "lucide-react";
import { ipc } from "../lib/ipc";
import type { LastCommit } from "../lib/ipc";
import type { FileChange, GitStatus } from "../lib/types";
import { pushToast } from "./Toasts";
import { ConfirmDialog } from "./ConfirmDialog";
import { ModalShell } from "./ModalShell";
import { ConflictAiModal } from "./ConflictAiModal";
import { COMMIT_SYSTEM, buildCommitPrompt } from "../lib/commitMessage";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useProjectStore } from "../stores/projectStore";
import { useAiReview } from "../stores/aiReviewStore";

interface Props {
  projectPath: string;
  /** Optional workspace id — keys the per-workspace review model used by
   *  AI conflict resolution. Falls back to the store default when absent. */
  workspaceId?: string;
  /** Diff text — drives the +/- line summary in the eyebrow. */
  diff?: string;
  /** Optional: called when a file row is clicked. The parent typically
   *  scrolls the canvas to that file's diff section. */
  onFileClick?: (filePath: string) => void;
  /** Optional: called after a successful commit or push, so the parent can
   *  refresh git status / diff downstream. */
  onChange?: () => void;
  /** Optional: hands the parent a function that focuses the commit textarea
   *  (wired to the `c` keyboard shortcut in App). */
  registerFocusCommit?: (fn: () => void) => void;
}

const POLL_MS = 5_000;

const MAX_VISIBLE_FILES = 200;

// Quiet conflict-row chips — rouge is the conflict hue; the tint only
// surfaces on hover/focus so the section stays calm.
const CONFLICT_CHIP =
  "shrink-0 rounded border border-octo-hairline px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-octo-sage transition-colors hover:border-[color:var(--rouge-border)] hover:bg-[var(--rouge-ghost)] hover:text-octo-rouge disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-rouge";

const CONFLICT_ICON_BTN =
  "shrink-0 rounded p-1 text-octo-sage transition-colors hover:text-octo-brass disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass";

export function ChangesPanel({ projectPath, workspaceId, diff = "", onFileClick, onChange, registerFocusCommit }: Props) {
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [amend, setAmend] = useState(false);
  const [lastCommit, setLastCommit] = useState<LastCommit | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<string | null>(null);
  const [reconcile, setReconcile] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [resolvingPath, setResolvingPath] = useState<string | null>(null);
  const [abortConfirm, setAbortConfirm] = useState(false);
  const [opBusy, setOpBusy] = useState(false);
  const [aiTarget, setAiTarget] = useState<string | null>(null);
  const commitRef = useRef<HTMLTextAreaElement>(null);
  const modelFor = useAiReview((s) => s.modelFor);
  // Per-workspace review model; modelFor falls back to its default for
  // unknown keys, so the projectPath fallback is always safe.
  const aiModel = modelFor(workspaceId ?? projectPath);

  useEffect(() => {
    registerFocusCommit?.(() => commitRef.current?.focus());
  }, [registerFocusCommit]);

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
  const behind = gitStatus?.behind ?? 0;
  const conflicted = gitStatus?.conflicted ?? 0;
  const aheadBehindKnown = gitStatus?.aheadBehindKnown ?? true;
  const branchName = gitStatus?.branch ?? null;
  const operation = gitStatus?.operation ?? null;
  const conflictFiles = files.filter((f) => f.conflicted);

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

  async function handleDraft() {
    setDrafting(true);
    try {
      const d = await ipc.getStagedDiff(projectPath);
      const r = await ipc.aiComplete("claude-sonnet-4-6", COMMIT_SYSTEM, buildCommitPrompt(d));
      setCommitMessage(r.text.trim());
    } catch (e) {
      pushToast({ level: "error", title: "Couldn't draft message", body: String(e) });
    } finally {
      setDrafting(false);
    }
  }

  async function toggleAmend(next: boolean) {
    if (next) {
      try {
        const lc = await ipc.getLastCommit(projectPath);
        if (!lc) {
          pushToast({ level: "info", title: "Nothing to amend", body: "This branch has no commits yet." });
          return;
        }
        setAmend(true);
        setLastCommit(lc);
        const prefill = lc.subject + (lc.body ? "\n\n" + lc.body : "");
        setCommitMessage((prev) => (prev.trim() === "" ? prefill : prev));
      } catch {
        pushToast({ level: "error", title: "Couldn't load the last commit" });
      }
    } else {
      setAmend(false);
      const prefill = lastCommit ? lastCommit.subject + (lastCommit.body ? "\n\n" + lastCommit.body : "") : "";
      setCommitMessage((prev) => (prev === prefill ? "" : prev));
      setLastCommit(null);
    }
  }

  async function handleCommitOrAmend() {
    const msg = commitMessage.trim();
    if (!msg || (!amend && staged.length === 0)) return;
    setCommitting(true);
    try {
      const sha = amend ? await ipc.amendCommit(projectPath, msg) : await ipc.commitChanges(projectPath, msg);
      // A commit changes the worktree's dirty state — refresh the rail signal.
      const pid = useProjectStore.getState().current?.id;
      if (pid) void useWorkspaceStore.getState().loadGitSummaries(pid);
      pushToast({ level: "success", title: amend ? "Amended" : "Committed", body: sha });
      setCommitMessage(""); setAmend(false); setLastCommit(null);
      await refresh();
      onChange?.();
    } catch (e) {
      pushToast({ level: "error", title: amend ? "Amend failed" : "Commit failed", body: String(e) });
    } finally {
      setCommitting(false);
    }
  }

  async function confirmDiscard() {
    const path = discardTarget;
    if (!path) return;
    setDiscardTarget(null);
    try {
      await ipc.discardFile(projectPath, path);
      pushToast({ level: "success", title: "Changes discarded", body: path });
      await refresh();
      onChange?.();
    } catch (e) {
      pushToast({ level: "error", title: "Discard failed", body: String(e) });
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

  async function runPull(strategy: "ffOnly" | "rebase" | "merge") {
    setSyncing(true);
    try {
      const r = await ipc.pull(projectPath, strategy);
      if (r.kind === "ok") {
        pushToast({ level: "success", title: "Pulled", body: r.output.split("\n").slice(-1)[0] || undefined });
      } else if (r.kind === "diverged") {
        setReconcile(true);
      } else if (r.kind === "conflict") {
        pushToast({ level: "warning", title: "Merge conflicts", body: "Resolve the conflicted files." });
      } else {
        pushToast({ level: "error", title: "Pull failed", body: r.output });
      }
      await refresh();
      onChange?.();
    } catch (e) {
      pushToast({ level: "error", title: "Pull failed", body: String(e) });
    } finally {
      setSyncing(false);
    }
  }

  async function handleFetch() {
    setSyncing(true);
    try {
      await ipc.fetchChanges(projectPath);
      pushToast({ level: "success", title: "Fetched" });
      await refresh(); onChange?.();
    } catch (e) {
      pushToast({ level: "error", title: "Fetch failed", body: String(e) });
    } finally {
      setSyncing(false);
    }
  }

  async function reconcileWith(strategy: "rebase" | "merge") {
    setReconcile(false);
    await runPull(strategy);
  }

  // ─── Conflict resolution (G7 slice II) ───────────────────────────

  async function takeSide(file: string, side: "ours" | "theirs") {
    setResolvingPath(file);
    try {
      await ipc.resolveConflictTake(projectPath, file, side);
      await refresh();
      onChange?.();
    } catch (e) {
      pushToast({ level: "error", title: "Couldn't resolve the conflict", body: String(e) });
    } finally {
      setResolvingPath(null);
    }
  }

  async function handleContinue() {
    if (!operation) return;
    setOpBusy(true);
    try {
      const r = await ipc.continueOperation(projectPath);
      if (r.kind === "ok") {
        pushToast({
          level: "success",
          title: operation === "merge" ? "Merge completed" : "Rebase continued",
          body: r.output.trim().split("\n").slice(-1)[0] || undefined,
        });
      } else if (r.kind === "moreConflicts") {
        pushToast({
          level: "warning",
          title: "Next step has conflicts",
          body: "Resolve the new conflicts, then continue again.",
        });
      } else {
        pushToast({ level: "error", title: "Continue failed", body: r.output });
      }
      await refresh();
      onChange?.();
    } catch (e) {
      pushToast({ level: "error", title: "Continue failed", body: String(e) });
    } finally {
      setOpBusy(false);
    }
  }

  async function confirmAbort() {
    setAbortConfirm(false);
    if (!operation) return;
    setOpBusy(true);
    try {
      await ipc.abortOperation(projectPath);
      pushToast({ level: "success", title: operation === "merge" ? "Merge aborted" : "Rebase aborted" });
      await refresh();
      onChange?.();
    } catch (e) {
      pushToast({ level: "error", title: "Abort failed", body: String(e) });
    } finally {
      setOpBusy(false);
    }
  }

  const canCommit = commitMessage.trim().length > 0 && (amend || staged.length > 0) && !committing;
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
          <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute">
            <span className="text-octo-verdigris">+{addCount}</span>
            <span className="px-1 opacity-50">/</span>
            <span className="text-octo-rouge">−{delCount}</span>
          </span>
        )}
        {branchName && <span className="font-mono text-[10px] text-octo-sage">{branchName}</span>}
        {aheadBehindKnown && (ahead > 0 || behind > 0) && (
          <span data-testid="ahead-behind" className="font-mono text-[10px] text-octo-mute">
            {ahead > 0 && <span className="text-octo-brass">↑{ahead}</span>}
            {behind > 0 && <span className="ml-1 text-octo-sage">↓{behind}</span>}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={handleFetch} disabled={syncing} title="Fetch from remote"
            className="rounded px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-octo-sage disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass">Fetch</button>
          <button type="button" onClick={() => runPull("ffOnly")} disabled={syncing || behind === 0} title="Pull from remote"
            className="rounded px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-octo-brass disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
            style={{ border: "1px solid var(--brass-dim)" }}>Pull</button>
        </span>
      </header>
      {(conflicted > 0 || operation) && (
        <div className="octo-rise-in shrink-0 border-b border-octo-hairline" data-testid="conflict-section">
          {conflicted > 0 ? (
            <div className="flex items-center px-4 py-1.5" style={{ background: "var(--rouge-ghost)" }}>
              <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-rouge">
                {conflicted} conflict{conflicted !== 1 ? "s" : ""}
                {operation ? ` · ${operation}` : ""}
              </span>
            </div>
          ) : (
            <div className="flex items-center px-4 py-1.5">
              <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-sage">
                All conflicts resolved{operation ? ` · ${operation}` : ""}
              </span>
            </div>
          )}

          {conflictFiles.length > 0 && (
            <ul className="pb-1.5 pt-0.5">
              {conflictFiles.map((f) => (
                <li key={f.path} className="flex items-center gap-1.5 px-4 py-1">
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[11px] text-octo-ivory"
                    title={f.path}
                  >
                    {shortenPath(f.path)}
                  </span>
                  <button
                    type="button"
                    onClick={() => takeSide(f.path, "ours")}
                    disabled={resolvingPath === f.path}
                    title="Keep our version — git checkout --ours"
                    className={CONFLICT_CHIP}
                  >
                    OURS
                  </button>
                  <button
                    type="button"
                    onClick={() => takeSide(f.path, "theirs")}
                    disabled={resolvingPath === f.path}
                    title="Keep their version — git checkout --theirs"
                    className={CONFLICT_CHIP}
                  >
                    THEIRS
                  </button>
                  <button
                    type="button"
                    onClick={() => onFileClick?.(f.path)}
                    title="Open in editor"
                    aria-label="Open in editor"
                    className={CONFLICT_ICON_BTN}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setAiTarget(f.path)}
                    disabled={resolvingPath === f.path}
                    title="Resolve with AI"
                    aria-label="Resolve with AI"
                    className={CONFLICT_ICON_BTN}
                  >
                    <Sparkles size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {conflicted === 0 && operation && (
            <div className="flex items-center gap-2 px-4 pb-2">
              <button
                type="button"
                onClick={handleContinue}
                disabled={opBusy}
                title={`Run git ${operation} --continue`}
                className="rounded px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-octo-brass transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                style={{ border: "1px solid var(--brass-dim)", background: "var(--brass-ghost)" }}
              >
                {opBusy ? "…" : `Continue ${operation}`}
              </button>
              <button
                type="button"
                onClick={() => setAbortConfirm(true)}
                disabled={opBusy}
                title={`Abort the ${operation} and return to the previous state`}
                className="rounded px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-octo-rouge opacity-70 transition-opacity hover:opacity-100 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-rouge focus-visible:opacity-100"
              >
                Abort
              </button>
            </div>
          )}
        </div>
      )}

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
              onDiscard={(p) => setDiscardTarget(p)}
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
              onDiscard={(p) => setDiscardTarget(p)}
              toggleMode="stage"
              emptyHint="Nothing pending."
            />
          </>
        )}
      </div>

      {/* Commit + Publish actions */}
      <div className="space-y-2 border-t border-octo-hairline p-3">
        <div className="relative">
          <textarea
            ref={commitRef}
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder="Describe the change…"
            rows={3}
            disabled={committing}
            className="w-full resize-none rounded-md border border-octo-hairline bg-octo-onyx p-2 pr-16 font-mono text-[12px] leading-[1.5] text-octo-ivory outline-none transition-colors placeholder:font-serif placeholder:not-italic placeholder:text-octo-mute focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass disabled:opacity-50"
          />
          <button
            type="button"
            onClick={handleDraft}
            disabled={staged.length === 0 || drafting}
            aria-label="Draft commit message with AI"
            className="absolute right-2 top-2 rounded font-mono text-[9px] uppercase tracking-[0.12em] text-octo-brass transition disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
            style={{ border: "1px solid var(--brass-dim)", padding: "1px 6px" }}
          >
            {drafting ? "…" : "✨ Draft"}
          </button>
        </div>

        <label className="flex items-center gap-2 text-[11px] text-octo-sage">
          <input
            type="checkbox"
            checked={amend}
            disabled={committing}
            onChange={(e) => toggleAmend(e.target.checked)}
            aria-label="Amend last commit"
            className="accent-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
          />
          Amend last commit
        </label>
        {amend && lastCommit && (
          <div className="font-mono text-[9px] text-octo-mute">
            ↳ folds staged into {lastCommit.shortSha} "{lastCommit.subject}"
          </div>
        )}
        {amend && ahead === 0 && hasUpstream && (
          <div className="font-mono text-[9px] text-octo-rouge">
            Last commit is pushed — amending rewrites history.
          </div>
        )}

        <button
          type="button"
          onClick={handleCommitOrAmend}
          disabled={!canCommit}
          className="flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
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
          {amend ? "Amend" : "Commit"}
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

      {discardTarget && (
        <ConfirmDialog
          title="Discard changes"
          body={`Discard changes to ${discardTarget.split("/").pop()}? This can't be undone.`}
          destructiveLabel="Discard"
          cancelLabel="Cancel"
          onConfirm={confirmDiscard}
          onCancel={() => setDiscardTarget(null)}
        />
      )}

      {aiTarget && (
        <ConflictAiModal
          workspacePath={projectPath}
          file={aiTarget}
          model={aiModel}
          onClose={() => setAiTarget(null)}
          onResolved={() => {
            setAiTarget(null);
            void refresh().then(() => onChange?.());
          }}
        />
      )}

      {abortConfirm && operation && (
        <ConfirmDialog
          title={`Abort ${operation}`}
          body={`Abort the ${operation}? Conflict resolutions in progress are discarded.`}
          destructiveLabel={`Abort ${operation}`}
          cancelLabel="Cancel"
          onConfirm={confirmAbort}
          onCancel={() => setAbortConfirm(false)}
        />
      )}

      {reconcile && (
        <ModalShell onClose={() => setReconcile(false)} ariaLabel="Reconcile diverged branch">
          <div className="p-5">
            <h2 className="mb-1 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">Diverged</h2>
            <p className="mb-4 text-[12px] text-octo-sage">Your branch and its upstream have diverged. Reconcile by:</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setReconcile(false)} className="rounded px-3 py-1.5 text-[11px] text-octo-mute focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass">Cancel</button>
              <button type="button" onClick={() => reconcileWith("merge")} className="rounded px-3 py-1.5 text-[11px] text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass" style={{ border: "1px solid var(--brass-dim)" }}>Merge</button>
              <button type="button" onClick={() => reconcileWith("rebase")} className="rounded px-3 py-1.5 text-[11px] font-semibold text-octo-onyx focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass" style={{ background: "var(--color-octo-brass)" }}>Rebase</button>
            </div>
          </div>
        </ModalShell>
      )}
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
  onDiscard,
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
  onDiscard: (path: string) => void;
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
        <div className="px-4 pb-2 font-serif text-[11px] text-octo-mute">
          {emptyHint}
        </div>
      ) : (
        <ul className="pb-2">
          {files.slice(0, MAX_VISIBLE_FILES).map((file) => (
            <FileRow
              key={file.path}
              file={file}
              busy={busyPath === file.path}
              onClick={() => onRowClick?.(file.path)}
              onToggle={() => onToggle(file)}
              onDiscard={onDiscard}
              toggleMode={toggleMode}
            />
          ))}
          {files.length > MAX_VISIBLE_FILES && (
            <div className="px-3 py-2 font-mono text-[11px] text-octo-mute">
              +{files.length - MAX_VISIBLE_FILES} more changed files
            </div>
          )}
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
  onDiscard,
  toggleMode,
}: {
  file: FileChange;
  busy: boolean;
  onClick: () => void;
  onToggle: () => void;
  onDiscard: (path: string) => void;
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

      {/* Discard affordance — revealed on row hover / keyboard focus. */}
      <button
        type="button"
        aria-label={`Discard changes to ${file.path.split("/").pop()}`}
        title="Discard changes to this file"
        onClick={(e) => {
          e.stopPropagation();
          onDiscard(file.path);
        }}
        className="ml-1 shrink-0 rounded px-1 text-[12px] leading-none text-octo-sage opacity-0 transition group-hover:opacity-70 hover:!text-octo-rouge focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
      >
        ×
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
    case "conflicted":
      return <FileX {...props} className="shrink-0 text-octo-rouge" />;
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
    conflicted: { letter: "!", color: "text-octo-rouge" },
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
      <div className="font-serif text-[13px] text-octo-mute">
        Working tree is clean.
      </div>
      <div className="h-px w-6 bg-octo-brass/40" aria-hidden />
    </div>
  );
}
