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
  FlaskConical,
  Sparkles,
  X,
} from "lucide-react";
import { ipc } from "../lib/ipc";
import { pushToast } from "./Toasts";
import { parseFullDiff } from "../lib/diffParser";
import { revealDiffTarget } from "../lib/diffJump";
import type { ChatMessage, FileEdit, GitStatus, TestRunResult } from "../lib/types";
import { useReviewPrefs } from "../stores/reviewPrefsStore";
import { useAiReview } from "../stores/aiReviewStore";
import { DiffView } from "./review/DiffView";
import { AiReviewPanel } from "./review/AiReviewPanel";
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

  const readingMode = useReviewPrefs((s) => s.readingMode);
  const ignoreWhitespace = useReviewPrefs((s) => s.ignoreWhitespace);
  const setReadingMode = useReviewPrefs((s) => s.setReadingMode);
  const setIgnoreWhitespace = useReviewPrefs((s) => s.setIgnoreWhitespace);

  // Reject-undo inline bar (error=true when applyHunk couldn't restore the change)
  const [undo, setUndo] = useState<{ rawText: string; error?: boolean } | null>(null);

  // Why? drawer (canvas-level, keyed by file path)
  const [whyFile, setWhyFile] = useState<string | null>(null);

  // Test runner state — the command lives behind a compact popover so the
  // toolbar stays a single tidy row (it used to host an always-on input).
  const [testCommand, setTestCommand] = useState<string>("");
  const [testsOpen, setTestsOpen] = useState(false);
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<TestRunResult | null>(null);
  const testsPopoverRef = useRef<HTMLDivElement>(null);
  // Last value persisted to the backend — guards against the Enter handler and
  // the input's blur-on-unmount both firing setWorkspaceTestCommand.
  const savedCmdRef = useRef<string | null>(null);

  // AI review drawer (lives in the diff, not the companion). Subtle brass
  // access in the toolbar; the panel slides in over the right of the diff.
  const [aiOpen, setAiOpen] = useState(false);
  const aiReview = useAiReview((s) => s.reviewFor(workspaceId));
  const aiFindingCount =
    aiReview.status === "done" ? aiReview.result?.findings.length ?? 0 : null;

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
      // Escape peels back one surface at a time, topmost first. The Why?
      // drawer owns Escape while open, so leave it alone here.
      if (e.key !== "Escape" || whyFile) return;
      if (testsOpen) { setTestsOpen(false); return; }
      if (aiOpen) { setAiOpen(false); return; }
      setTestResult(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [whyFile, testsOpen, aiOpen]);

  // Auto-clear the reject-undo bar after 6s — but keep the error message
  // visible until the user dismisses it (don't let a failed undo vanish).
  useEffect(() => {
    if (!undo || undo.error) return;
    const id = setTimeout(() => setUndo(null), 6_000);
    return () => clearTimeout(id);
  }, [undo]);

  // When the last change is accepted/committed the toolbar's AI toggle hides
  // (it only shows with files to review); close the drawer so its state can't
  // disagree with a missing toggle.
  useEffect(() => {
    if ((gitStatus?.changedFiles.length ?? 0) === 0) setAiOpen(false);
  }, [gitStatus]);

  // Dismiss the test-command popover on an outside click.
  useEffect(() => {
    if (!testsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (testsPopoverRef.current && !testsPopoverRef.current.contains(e.target as Node)) {
        setTestsOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [testsOpen]);

  const saveTestCommand = useCallback(async () => {
    const cmd = testCommand.trim();
    if (!cmd || savedCmdRef.current === cmd) return;
    savedCmdRef.current = cmd;
    try {
      await ipc.setWorkspaceTestCommand(workspaceId, cmd);
    } catch (e) {
      console.error("save test command failed:", e);
      savedCmdRef.current = null; // let a later attempt retry the failed save
    }
  }, [workspaceId, testCommand]);

  // Scroll the diff to a finding's location and flash it, so an AI-review
  // finding's target reads unambiguously instead of just jumping into view.
  // Shares the anchor protocol with App's navigateToFile via revealDiffTarget.
  const jumpToDiff = useCallback((file: string, line: number | null) => {
    if (!revealDiffTarget(file, line, { flash: true })) {
      pushToast({ level: "info", title: "Not in the current diff", body: file });
    }
  }, []);

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
      {/* ── Toolbar ───────────────────────────────────────────────
          One tidy row that never wraps: every control is shrink-0 +
          whitespace-nowrap, and seldom-needed bits (the test command)
          live behind a compact popover instead of an always-on field. */}
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-octo-hairline bg-octo-panel px-3">
        <div className="ml-auto flex items-center gap-2">
          {/* View toggle — Diff / Editor */}
          <div className="flex shrink-0 items-center overflow-hidden rounded-md border border-octo-hairline">
            <button
              onClick={() => setViewMode("diff")}
              aria-label="Diff view"
              className={`flex items-center gap-1 whitespace-nowrap px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors focus-visible:ring-1 focus-visible:ring-octo-brass ${
                viewMode === "diff" ? "text-octo-brass" : "text-octo-mute hover:text-octo-sage"
              }`}
              style={viewMode === "diff" ? { background: "var(--brass-ghost)" } : undefined}
            >
              <LayoutList size={12} />
              Diff
            </button>
            <button
              onClick={() => setViewMode("editor")}
              aria-label="Editor view"
              className={`flex items-center gap-1 whitespace-nowrap border-l border-octo-hairline px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors focus-visible:ring-1 focus-visible:ring-octo-brass ${
                viewMode === "editor" ? "text-octo-brass" : "text-octo-mute hover:text-octo-sage"
              }`}
              style={viewMode === "editor" ? { background: "var(--brass-ghost)" } : undefined}
            >
              <PenLine size={12} />
              Editor
            </button>
          </div>

          {/* Reading mode + whitespace — only meaningful in Diff view.
              Icon-only with tooltips so the row stays compact. */}
          {viewMode === "diff" && (
            <>
              <div className="flex shrink-0 items-center overflow-hidden rounded-md border border-octo-hairline">
                <button
                  onClick={() => setReadingMode("inline")}
                  aria-label="Inline"
                  title="Inline diff"
                  className={`flex items-center justify-center px-2 py-1 transition-colors focus-visible:ring-1 focus-visible:ring-octo-brass ${
                    readingMode === "inline" ? "text-octo-brass" : "text-octo-mute hover:text-octo-sage"
                  }`}
                  style={readingMode === "inline" ? { background: "var(--brass-ghost)" } : undefined}
                >
                  <AlignJustify size={13} />
                </button>
                <button
                  onClick={() => setReadingMode("sbs")}
                  aria-label="Side by side"
                  title="Side-by-side diff"
                  className={`flex items-center justify-center border-l border-octo-hairline px-2 py-1 transition-colors focus-visible:ring-1 focus-visible:ring-octo-brass ${
                    readingMode === "sbs" ? "text-octo-brass" : "text-octo-mute hover:text-octo-sage"
                  }`}
                  style={readingMode === "sbs" ? { background: "var(--brass-ghost)" } : undefined}
                >
                  <Columns2 size={13} />
                </button>
              </div>

              {/* Whitespace toggle */}
              <button
                onClick={() => setIgnoreWhitespace(!ignoreWhitespace)}
                aria-label="Ignore whitespace"
                title="Hide whitespace-only changes (re-indents, trailing spaces, blank lines)"
                className={`shrink-0 whitespace-nowrap rounded-md border border-octo-hairline px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors focus-visible:ring-1 focus-visible:ring-octo-brass ${
                  ignoreWhitespace ? "text-octo-brass" : "text-octo-mute hover:text-octo-sage"
                }`}
                style={ignoreWhitespace ? { background: "var(--brass-ghost)" } : undefined}
              >
                ±WS
              </button>
            </>
          )}

          {/* Test runner — compact icon button + popover */}
          <div className="relative shrink-0" ref={testsPopoverRef}>
            <button
              onClick={() => setTestsOpen((v) => !v)}
              aria-label="Tests"
              aria-expanded={testsOpen}
              title={testCommand ? `Run tests · ${testCommand}` : "Set a test command"}
              className={`flex items-center gap-1 rounded-md border border-octo-hairline px-2 py-1 transition-colors focus-visible:ring-1 focus-visible:ring-octo-brass ${
                testsOpen || testRunning ? "text-octo-brass" : "text-octo-mute hover:text-octo-sage"
              }`}
              style={testsOpen ? { background: "var(--brass-ghost)" } : undefined}
            >
              {testRunning ? <Loader2 size={13} className="animate-spin" /> : <FlaskConical size={13} />}
            </button>
            {testsOpen && (
              <div className="octo-menu-enter absolute right-0 top-[calc(100%+6px)] z-30 w-64 rounded-md border border-octo-hairline bg-octo-panel p-2 shadow-2xl">
                <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">
                  Test command
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    value={testCommand}
                    onChange={(e) => setTestCommand(e.target.value)}
                    onBlur={() => void saveTestCommand()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { void saveTestCommand(); handleRunTests(); setTestsOpen(false); }
                      if (e.key === "Escape") { e.stopPropagation(); setTestsOpen(false); }
                    }}
                    className="min-w-0 flex-1 rounded border border-octo-hairline bg-octo-onyx px-2 py-1 font-mono text-[11px] text-octo-ivory outline-none focus:border-octo-brass placeholder:font-serif placeholder:not-italic placeholder:text-octo-mute"
                    placeholder="npm test"
                    autoFocus
                  />
                  <button
                    onClick={() => { void saveTestCommand(); handleRunTests(); }}
                    disabled={!testCommand.trim() || testRunning}
                    aria-label="Run tests"
                    title="Run tests"
                    className="flex shrink-0 items-center justify-center rounded px-2 py-1 text-octo-brass transition-colors hover:bg-[var(--brass-ghost)] disabled:opacity-30 focus-visible:ring-1 focus-visible:ring-octo-brass"
                    style={{ border: "1px solid var(--brass-dim)" }}
                  >
                    {testRunning ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* AI review + Accept all — diff view, with changes to act on */}
          {viewMode === "diff" && fileCount > 0 && (
            <>
              <button
                onClick={() => setAiOpen((v) => !v)}
                aria-label="Review with AI"
                aria-pressed={aiOpen}
                title="Review this change with AI"
                className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-brass transition-colors focus-visible:ring-1 focus-visible:ring-octo-brass"
                style={{
                  background: aiOpen ? "var(--brass-ghost)" : "transparent",
                  border: "1px solid var(--brass-dim)",
                }}
              >
                <Sparkles size={12} />
                AI
                {aiFindingCount != null && aiFindingCount > 0 && (
                  <span className="rounded-full bg-[var(--brass-ghost)] px-1 text-[9px] tabular-nums text-octo-brass">
                    {aiFindingCount}
                  </span>
                )}
              </button>

              <button
                onClick={handleAcceptAll}
                aria-label="Accept all changes"
                className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-octo-brass transition-colors focus-visible:ring-1 focus-visible:ring-octo-brass"
                style={{
                  background: "var(--brass-ghost)",
                  border: "1px solid var(--brass-dim)",
                }}
                title="Stages every change. Commit from the left panel."
              >
                <CheckSquare size={12} />
                Accept all
              </button>
            </>
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

        {/* AI review drawer — slides over the right of the diff. Clicking a
            finding scrolls + flashes its line in the diff behind it; Edit opens
            the file in the editor at the line. */}
        {viewMode === "diff" && aiOpen && (
          <aside
            className="octo-fade-in absolute inset-y-0 right-0 z-20 flex w-[340px] flex-col border-l border-octo-hairline bg-octo-panel shadow-2xl"
            aria-label="AI review"
          >
            <AiReviewPanel
              embedded
              workspaceId={workspaceId}
              gitDiff={gitDiff}
              onJump={jumpToDiff}
              onEdit={(file, line) => onOpenFileAtLine?.(file, line ?? 1)}
              onClose={() => setAiOpen(false)}
            />
          </aside>
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
    // Match on either path being a tail of the other (a recorded edit may be
    // absolute or repo-relative; the diff path is repo-relative), then fall
    // back to a basename match so a real agent edit is still attributed.
    const base = (p: string) => p.split("/").pop() ?? p;
    const edit =
      fileEdits.find(
        (e) =>
          e.filePath === filePath ||
          filePath.endsWith("/" + e.filePath) ||
          e.filePath.endsWith("/" + filePath),
      ) ?? fileEdits.find((e) => base(e.filePath) === base(filePath));
    if (edit?.messageId == null) {
      setError(
        "This change isn't attributed to an agent turn — it was hand-written, or made outside an agent run.",
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
          Agent origin
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
