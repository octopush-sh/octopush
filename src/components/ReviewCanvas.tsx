/**
 * ReviewCanvas — diff-first canvas for the Review mode.
 *
 * Hosts the toolbar (Diff/Editor toggle, Inline/Split + whitespace toggles,
 * test runner, Accept-all), the DiffView, the reject-undo bar, and a
 * canvas-level "Why?" agent-origin drawer.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Play,
  Loader2,
  PenLine,
  LayoutList,
  CheckSquare,
  Columns2,
  AlignJustify,
  X,
} from "lucide-react";
import { ipc } from "../lib/ipc";
import { pushToast } from "./Toasts";
import { parseFullDiff } from "../lib/diffParser";
import type { ChatMessage, FileEdit, GitStatus, TestRunResult } from "../lib/types";
import { useReviewPrefs } from "../stores/reviewPrefsStore";
import { DiffView } from "./review/DiffView";
import { TestDrawer } from "./review/TestDrawer";

// ─── Types ─────────────────────────────────────────────────────────

export type ReviewViewMode = "diff" | "editor";

interface Props {
  workspaceId: string;
  workspacePath: string;
  gitStatus: GitStatus | null;
  gitDiff: string;
  /** Callback to request parent to re-fetch diff (after Accept/Reject). */
  onDiffChange?: () => void;
  /** Default test command (pre-fill before the user saves one). */
  initialTestCommand?: string | null;
  /** Render children (Editor mode) when not in diff view. */
  children?: React.ReactNode;
  /** Controlled view mode — when provided, the canvas is fully driven by
   *  the parent. Used so other surfaces (FILES rail, terminal links, chat
   *  message links) can deep-link straight into Diff or Editor view. */
  viewMode?: ReviewViewMode;
  onViewModeChange?: (next: ReviewViewMode) => void;
  /** Open a file in the editor at a given line (line is best-effort). */
  onOpenFileAtLine?: (filePath: string, line: number) => void;
  /** A file's "viewed" state toggled in the diff. */
  onViewedChange?: (filePath: string, viewed: boolean) => void;
  /** Keyboard request to focus the filter / commit affordances. */
  onFocusFilter?: () => void;
  onFocusCommit?: () => void;
}

// ─── ReviewCanvas ──────────────────────────────────────────────────

export function ReviewCanvas({
  workspaceId,
  workspacePath,
  gitStatus,
  gitDiff,
  onDiffChange,
  initialTestCommand,
  children,
  viewMode: viewModeProp,
  onViewModeChange,
  onOpenFileAtLine,
  onViewedChange,
  onFocusFilter,
  onFocusCommit,
}: Props) {
  const [viewModeState, setViewModeState] = useState<ReviewViewMode>("diff");
  const viewMode = viewModeProp ?? viewModeState;
  const setViewMode = (next: ReviewViewMode) => {
    if (onViewModeChange) onViewModeChange(next);
    else setViewModeState(next);
  };
  const [fileEdits, setFileEdits] = useState<FileEdit[]>([]);

  const { readingMode, ignoreWhitespace, setReadingMode, setIgnoreWhitespace } =
    useReviewPrefs();

  // Reject-undo inline bar (error=true when applyHunk couldn't restore the change)
  const [undo, setUndo] = useState<{ rawText: string; error?: boolean } | null>(null);

  // Why? drawer (canvas-level, keyed by file path)
  const [whyFile, setWhyFile] = useState<string | null>(null);

  // Test runner state
  const [testCommand, setTestCommand] = useState<string>("");
  const [testCommandEditing, setTestCommandEditing] = useState(false);
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<TestRunResult | null>(null);
  const testInputRef = useRef<HTMLInputElement>(null);

  // Parse diff — memoized so the per-hunk word-diff LCS only runs when the
  // diff string actually changes, not on every unrelated re-render.
  const diffFiles = useMemo(() => parseFullDiff(gitDiff), [gitDiff]);

  // Load file edits for this workspace
  useEffect(() => {
    if (!workspaceId) return;
    ipc.listFileEdits(workspaceId).then(setFileEdits).catch(() => {});
  }, [workspaceId]);

  // Detect/load test command
  useEffect(() => {
    if (initialTestCommand) {
      setTestCommand(initialTestCommand);
      return;
    }
    ipc.detectDefaultTestCommand(workspacePath).then((cmd) => {
      if (cmd) setTestCommand(cmd);
    }).catch(() => {});
  }, [workspacePath, initialTestCommand]);

  // Dismiss test drawer on Esc — but let the Why? drawer take precedence when
  // it's open, so a single Esc closes only the topmost surface.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !whyFile) setTestResult(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [whyFile]);

  // Auto-clear the reject-undo bar after 6s — but keep the error message
  // visible until the user dismisses it (don't let a failed undo vanish).
  useEffect(() => {
    if (!undo || undo.error) return;
    const id = setTimeout(() => setUndo(null), 6_000);
    return () => clearTimeout(id);
  }, [undo]);

  const handleTestCommandBlur = useCallback(async () => {
    setTestCommandEditing(false);
    if (testCommand.trim()) {
      try {
        await ipc.setWorkspaceTestCommand(workspaceId, testCommand.trim());
      } catch (e) {
        console.error("save test command failed:", e);
      }
    }
  }, [workspaceId, testCommand]);

  async function handleRunTests() {
    if (!testCommand.trim()) return;
    setTestRunning(true);
    setTestResult(null);
    try {
      const result = await ipc.runTestCommand(workspacePath, testCommand.trim());
      setTestResult(result);
    } catch (e) {
      setTestResult({ stdout: "", stderr: String(e), exitCode: -1 });
    } finally {
      setTestRunning(false);
    }
  }

  async function handleAcceptAll() {
    try {
      await ipc.stageAllChanges(workspacePath);
      onDiffChange?.();
    } catch (e) {
      console.error("stage all failed:", e);
    }
  }

  // ── Hunk actions (wired into DiffView) ──
  const accept = async (filePath: string, hunkIdx: number) => {
    const hunk = diffFiles.find((f) => f.filePath === filePath)?.hunks[hunkIdx];
    if (!hunk) return;
    try {
      await ipc.stageHunk(workspacePath, hunk.rawText);
      onDiffChange?.();
    } catch (e) {
      console.error("stage hunk failed:", e);
      pushToast({ level: "error", title: "Couldn't accept hunk", body: String(e) });
    }
  };

  const reject = async (filePath: string, hunkIdx: number) => {
    const hunk = diffFiles.find((f) => f.filePath === filePath)?.hunks[hunkIdx];
    if (!hunk) return;
    try {
      await ipc.revertHunk(workspacePath, hunk.rawText);
      setUndo({ rawText: hunk.rawText });
      onDiffChange?.();
    } catch (e) {
      console.error("revert hunk failed:", e);
      pushToast({ level: "error", title: "Couldn't reject hunk", body: String(e) });
    }
  };

  const fileCount = gitStatus?.changedFiles.length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* ── Toolbar ─────────────────────────────────────────────── */}
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-octo-hairline bg-octo-panel px-4">
        <div className="ml-auto flex items-center gap-2">
          {/* View toggle */}
          <div className="flex items-center rounded-md border border-octo-hairline overflow-hidden">
            <button
              onClick={() => setViewMode("diff")}
              aria-label="Diff view"
              className={[
                "flex items-center gap-1 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors focus-visible:ring-1 focus-visible:ring-octo-brass",
                viewMode === "diff"
                  ? "text-octo-brass"
                  : "text-octo-mute hover:text-octo-sage",
              ].join(" ")}
              style={
                viewMode === "diff"
                  ? { background: "var(--brass-ghost)" }
                  : undefined
              }
            >
              <LayoutList size={12} />
              Diff
            </button>
            <button
              onClick={() => setViewMode("editor")}
              aria-label="Editor view"
              className={[
                "flex items-center gap-1 border-l border-octo-hairline px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors focus-visible:ring-1 focus-visible:ring-octo-brass",
                viewMode === "editor"
                  ? "text-octo-brass"
                  : "text-octo-mute hover:text-octo-sage",
              ].join(" ")}
              style={
                viewMode === "editor"
                  ? { background: "var(--brass-ghost)" }
                  : undefined
              }
            >
              <PenLine size={12} />
              Editor
            </button>
          </div>

          {/* Reading mode + whitespace — only meaningful in Diff view */}
          {viewMode === "diff" && (
            <>
              {/* Inline / Split segmented control */}
              <div className="flex items-center rounded-md border border-octo-hairline overflow-hidden">
                <button
                  onClick={() => setReadingMode("inline")}
                  aria-label="Inline"
                  className={[
                    "flex items-center gap-1 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors focus-visible:ring-1 focus-visible:ring-octo-brass",
                    readingMode === "inline"
                      ? "text-octo-brass"
                      : "text-octo-mute hover:text-octo-sage",
                  ].join(" ")}
                  style={
                    readingMode === "inline"
                      ? { background: "var(--brass-ghost)" }
                      : undefined
                  }
                >
                  <AlignJustify size={12} />
                  Inline
                </button>
                <button
                  onClick={() => setReadingMode("sbs")}
                  aria-label="Side by side"
                  className={[
                    "flex items-center gap-1 border-l border-octo-hairline px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors focus-visible:ring-1 focus-visible:ring-octo-brass",
                    readingMode === "sbs"
                      ? "text-octo-brass"
                      : "text-octo-mute hover:text-octo-sage",
                  ].join(" ")}
                  style={
                    readingMode === "sbs"
                      ? { background: "var(--brass-ghost)" }
                      : undefined
                  }
                >
                  <Columns2 size={12} />
                  Split
                </button>
              </div>

              {/* Whitespace toggle */}
              <button
                onClick={() => setIgnoreWhitespace(!ignoreWhitespace)}
                aria-label="Ignore whitespace"
                className={[
                  "flex items-center gap-1 rounded-md border border-octo-hairline px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors focus-visible:ring-1 focus-visible:ring-octo-brass",
                  ignoreWhitespace
                    ? "text-octo-brass"
                    : "text-octo-mute hover:text-octo-sage",
                ].join(" ")}
                style={
                  ignoreWhitespace
                    ? { background: "var(--brass-ghost)" }
                    : undefined
                }
              >
                ±WS
              </button>
            </>
          )}

          {/* Test runner */}
          <div className="flex items-center gap-0.5 rounded-md border border-octo-hairline pl-2 pr-1">
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
              tests
            </span>
            {testCommandEditing ? (
              <input
                ref={testInputRef}
                value={testCommand}
                onChange={(e) => setTestCommand(e.target.value)}
                onBlur={handleTestCommandBlur}
                onKeyDown={(e) => {
                  if (e.key === "Enter") testInputRef.current?.blur();
                  if (e.key === "Escape") {
                    setTestCommandEditing(false);
                  }
                }}
                className="w-36 bg-transparent px-2 py-1 font-mono text-[11px] text-octo-ivory outline-none placeholder:font-serif placeholder:not-italic placeholder:text-octo-mute"
                placeholder="npm test"
                autoFocus
              />
            ) : (
              <button
                onClick={() => setTestCommandEditing(true)}
                aria-label="Edit test command"
                className={[
                  "px-2 py-1 transition-colors focus-visible:ring-1 focus-visible:ring-octo-brass",
                  testCommand
                    ? "font-mono text-[11px] text-octo-sage hover:text-octo-ivory"
                    : "font-serif text-[11px] text-octo-mute hover:text-octo-sage",
                ].join(" ")}
                title="Click to set the command Octopus runs for tests"
              >
                {testCommand || "set a test command…"}
              </button>
            )}
            <button
              onClick={handleRunTests}
              disabled={!testCommand.trim() || testRunning}
              aria-label="Run tests"
              className="flex items-center gap-1 rounded px-2 py-1 text-octo-mute transition-colors hover:bg-octo-panel-2 hover:text-octo-brass disabled:opacity-30 focus-visible:ring-1 focus-visible:ring-octo-brass"
              title="Run tests"
            >
              {testRunning ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Play size={12} />
              )}
            </button>
          </div>

          {/* Accept all */}
          {fileCount > 0 && viewMode === "diff" && (
            <button
              onClick={handleAcceptAll}
              aria-label="Accept all changes"
              className="flex items-center gap-1.5 rounded-md px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-octo-brass transition-colors focus-visible:ring-1 focus-visible:ring-octo-brass"
              style={{
                background: "var(--brass-ghost)",
                border: "1px solid var(--brass-dim)",
              }}
              title="Stages every change. Commit from the left panel."
            >
              <CheckSquare size={12} />
              Accept all
            </button>
          )}
        </div>
      </header>

      {/* ── Content area ────────────────────────────────────────── */}
      <div className="relative min-h-0 flex-1">
        {/* Diff view */}
        {viewMode === "diff" && (
          <DiffView
            files={diffFiles}
            workspacePath={workspacePath}
            stagedCount={
              gitStatus?.changedFiles.filter((f) => f.staged).length ?? 0
            }
            onAccept={accept}
            onReject={reject}
            onWhy={(filePath) => {
              // Refresh the edit→message links each time so the drawer reflects
              // edits the agent made after this canvas mounted (not a stale snapshot).
              ipc.listFileEdits(workspaceId).then(setFileEdits).catch(() => {});
              setWhyFile(filePath);
            }}
            onOpen={(filePath, line) => onOpenFileAtLine?.(filePath, line)}
            onViewedChange={onViewedChange}
            onFocusCommit={onFocusCommit}
            onFocusFilter={onFocusFilter}
          />
        )}

        {/* Editor mode — render children (EditorTabs + EditorPane) */}
        {viewMode === "editor" && (
          <div className="absolute inset-0 flex flex-col">{children}</div>
        )}
      </div>

      {/* ── Why? drawer (agent origin) ───────────────────────────── */}
      {whyFile && (
        <WhyDrawer
          filePath={whyFile}
          fileEdits={fileEdits}
          onClose={() => setWhyFile(null)}
        />
      )}

      {/* ── Reject-undo bar ──────────────────────────────────────── */}
      {undo && (
        <div className="octo-rise-in flex items-center gap-3 border-t border-octo-hairline bg-octo-panel px-4 py-2 font-mono text-[11px] text-octo-sage">
          {undo.error ? (
            <span className="text-octo-rouge">Couldn&apos;t undo automatically — the file changed since the hunk was rejected.</span>
          ) : (
            <>
              <span>Hunk rejected.</span>
              <button
                onClick={async () => {
                  try {
                    await ipc.applyHunk(workspacePath, undo.rawText);
                    onDiffChange?.();
                    setUndo(null);
                  } catch (e) {
                    console.error("undo (apply_hunk) failed:", e);
                    setUndo((u) => (u ? { ...u, error: true } : null));
                  }
                }}
                className="rounded px-2 py-0.5 text-octo-brass focus-visible:ring-1 focus-visible:ring-octo-brass"
                style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
              >
                Undo
              </button>
            </>
          )}
          <button
            onClick={() => setUndo(null)}
            aria-label="Dismiss"
            className="ml-auto text-octo-mute hover:text-octo-sage focus-visible:ring-1 focus-visible:ring-octo-brass"
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Test result drawer ───────────────────────────────────── */}
      {testResult && (
        <div className="shrink-0">
          <TestDrawer result={testResult} onClose={() => setTestResult(null)} />
        </div>
      )}
    </div>
  );
}

// ─── Why? drawer (agent origin) ────────────────────────────────────

interface WhyDrawerProps {
  filePath: string;
  fileEdits: FileEdit[];
  onClose: () => void;
}

function WhyDrawer({ filePath, fileEdits, onClose }: WhyDrawerProps) {
  const [message, setMessage] = useState<ChatMessage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Esc to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Look up the agent message that produced this file's edit.
  useEffect(() => {
    let cancelled = false;
    setMessage(null);
    setError(null);
    setLoading(true);
    const edit = fileEdits.find(
      (e) => e.filePath === filePath || filePath.endsWith(e.filePath),
    );
    if (edit?.messageId == null) {
      setError(
        "This change isn't linked to an agent turn — likely a manual edit (or made before agent-edit tracking landed).",
      );
      setLoading(false);
      return;
    }
    ipc
      .getMessage(edit.messageId)
      .then((msg) => {
        if (!cancelled) setMessage(msg);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, fileEdits]);

  return (
    <div className="octo-fade-in shrink-0 border-t border-octo-hairline bg-octo-onyx/60 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-octo-brass">
          § Agent origin
        </span>
        <button
          onClick={onClose}
          aria-label="Close"
          className="flex h-6 w-6 items-center justify-center rounded text-octo-mute transition-colors hover:bg-octo-panel-2 hover:text-octo-sage focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          <X size={14} />
        </button>
      </div>
      <div className="mb-1.5 font-mono text-[10px] text-octo-mute">{filePath}</div>
      {loading && (
        <div className="flex items-center gap-2 text-[11px] text-octo-sage">
          <Loader2 size={12} className="animate-spin" />
          Looking up agent message…
        </div>
      )}
      {error && (
        <p className="font-serif text-[12px] leading-[1.5] text-octo-sage">
          {error}
        </p>
      )}
      {message && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute">
            <span className="text-octo-brass">{message.role}</span>
            <span>·</span>
            <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
            {message.model && (
              <>
                <span>·</span>
                <span>{message.model}</span>
              </>
            )}
          </div>
          <p className="max-h-32 overflow-y-auto whitespace-pre-wrap text-[12px] leading-[1.55] text-octo-ivory">
            {message.content.length > 800
              ? message.content.slice(0, 800) + "…"
              : message.content}
          </p>
        </div>
      )}
    </div>
  );
}
