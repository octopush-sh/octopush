/**
 * ReviewCanvas — diff-first canvas for the Review mode.
 *
 * Renders hunks as Accept/Reject/Why? cards. Includes a toolbar with
 * Diff/Editor toggle, test runner, and Accept-all button.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  CheckCircle,
  XCircle,
  HelpCircle,
  ChevronRight,
  X,
  Play,
  Loader2,
  PenLine,
  LayoutList,
  CheckSquare,
} from "lucide-react";
import { ipc } from "../lib/ipc";
import { parseFullDiff, type DiffFile, type DiffHunk } from "../lib/diffParser";
import type { ChatMessage, FileEdit, GitStatus, TestRunResult } from "../lib/types";

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
}

// ─── Hunk card ─────────────────────────────────────────────────────

interface HunkCardProps {
  file: DiffFile;
  hunk: DiffHunk;
  workspacePath: string;
  workspaceId: string;
  fileEdits: FileEdit[];
  onAccepted: () => void;
  onRejected: () => void;
}

function HunkCard({
  file,
  hunk,
  workspacePath,
  workspaceId,
  fileEdits,
  onAccepted,
  onRejected,
}: HunkCardProps) {
  const [status, setStatus] = useState<"idle" | "accepting" | "rejecting" | "accepted" | "rejected">("idle");
  const [whyOpen, setWhyOpen] = useState(false);
  const [whyMessage, setWhyMessage] = useState<ChatMessage | null>(null);
  const [whyLoading, setWhyLoading] = useState(false);
  const [whyError, setWhyError] = useState<string | null>(null);

  async function handleAccept() {
    setStatus("accepting");
    try {
      await ipc.stageHunk(workspacePath, hunk.rawText);
      setStatus("accepted");
      onAccepted();
    } catch (e) {
      console.error("stage hunk failed:", e);
      setStatus("idle");
    }
  }

  async function handleReject() {
    setStatus("rejecting");
    try {
      await ipc.revertHunk(workspacePath, hunk.rawText);
      setStatus("rejected");
      setTimeout(onRejected, 400); // brief delay so user sees the state change
    } catch (e) {
      console.error("revert hunk failed:", e);
      setStatus("idle");
    }
  }

  async function handleWhy() {
    setWhyOpen(true);
    if (whyMessage || whyLoading) return;
    setWhyLoading(true);
    setWhyError(null);
    try {
      const edits = await ipc.listFileEdits(workspaceId);
      const relevant = edits.find((e) => e.filePath === file.filePath || file.filePath.endsWith(e.filePath));
      if (relevant?.messageId != null) {
        const msg = await ipc.getMessage(relevant.messageId);
        setWhyMessage(msg);
      } else {
        // Try to find in already-loaded fileEdits prop
        const fromProp = fileEdits.find(
          (e) => e.filePath === file.filePath || file.filePath.endsWith(e.filePath),
        );
        if (fromProp?.messageId != null) {
          const msg = await ipc.getMessage(fromProp.messageId);
          setWhyMessage(msg);
        } else {
          setWhyError(
            "This change isn't linked to an agent turn — likely a manual edit (or made before agent-edit tracking landed).",
          );
        }
      }
    } catch (e) {
      setWhyError(String(e));
    } finally {
      setWhyLoading(false);
    }
  }

  if (status === "rejected") return null;

  const isAccepted = status === "accepted";

  // Skip the @@ header line — it's already rendered in the card header.
  const bodyLines = hunk.lines.length > 0 && hunk.lines[0].startsWith("@@")
    ? hunk.lines.slice(1)
    : hunk.lines;

  return (
    <div
      className={[
        "overflow-hidden rounded-md border transition-all duration-200",
        isAccepted
          ? "border-octo-hairline bg-octo-panel/40 opacity-60"
          : "border-octo-hairline bg-octo-panel",
      ].join(" ")}
    >
      {/* Hunk header */}
      <div className="flex items-center gap-2 border-b border-octo-hairline bg-octo-onyx/40 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute">
          {formatHunkRange(hunk.header)}
        </span>
        <span className="ml-auto flex items-center gap-2 font-mono text-[10px]">
          {hunk.additions > 0 && (
            <span className="text-octo-verdigris">+{hunk.additions}</span>
          )}
          {hunk.deletions > 0 && (
            <span className="text-octo-rouge">−{hunk.deletions}</span>
          )}
          {isAccepted && (
            <span
              className="rounded-sm px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-octo-brass"
              style={{ background: "var(--brass-ghost)" }}
            >
              Staged
            </span>
          )}
        </span>
      </div>

      {/* Diff lines */}
      <div className="overflow-x-auto">
        <pre className="px-0 font-mono text-[11.5px] leading-[1.55]">
          {bodyLines.map((line, i) => (
            <DiffLine key={i} line={line} />
          ))}
        </pre>
      </div>

      {/* Action bar */}
      {!isAccepted && (
        <div className="flex items-center justify-end gap-1 border-t border-octo-hairline bg-octo-onyx/30 px-3 py-2">
          {/* Why? — tertiary, mute */}
          <button
            onClick={handleWhy}
            disabled={whyLoading}
            className="flex items-center gap-1 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute transition-colors hover:bg-octo-panel-2 hover:text-octo-sage"
          >
            <HelpCircle size={11} />
            Why?
          </button>
          <span className="mx-1 h-3 w-px bg-octo-hairline" aria-hidden />
          {/* Reject — secondary, rouge-dimmed */}
          <button
            onClick={handleReject}
            disabled={status === "rejecting" || status === "accepting"}
            className="flex items-center gap-1 rounded px-2.5 py-1 text-[11px] text-octo-sage transition-colors hover:bg-octo-rouge/10 hover:text-octo-rouge disabled:opacity-40"
            style={{ border: "1px solid transparent" }}
          >
            {status === "rejecting" ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <XCircle size={12} />
            )}
            Reject
          </button>
          {/* Accept — primary, brass-solid */}
          <button
            onClick={handleAccept}
            disabled={status === "rejecting" || status === "accepting"}
            className="flex items-center gap-1.5 rounded px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-octo-brass transition-colors disabled:opacity-40"
            style={{
              background: "var(--brass-ghost)",
              border: "1px solid var(--brass-dim)",
            }}
          >
            {status === "accepting" ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <CheckCircle size={12} />
            )}
            Accept
          </button>
        </div>
      )}

      {/* Why? drawer */}
      {whyOpen && (
        <div className="border-t border-octo-hairline bg-octo-onyx/60 px-3 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-octo-brass">
              § Agent origin
            </span>
            <button
              onClick={() => setWhyOpen(false)}
              aria-label="Close"
              className="flex h-6 w-6 items-center justify-center rounded text-octo-mute transition-colors hover:bg-octo-panel-2 hover:text-octo-sage"
            >
              <X size={14} />
            </button>
          </div>
          {whyLoading && (
            <div className="flex items-center gap-2 text-[11px] text-octo-sage">
              <Loader2 size={12} className="animate-spin" />
              Looking up agent message…
            </div>
          )}
          {whyError && (
            <p className="font-serif text-[12px] leading-[1.5] text-octo-sage">
              {whyError}
            </p>
          )}
          {whyMessage && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute">
                <span className="text-octo-brass">{whyMessage.role}</span>
                <span>·</span>
                <span>{new Date(whyMessage.createdAt).toLocaleTimeString()}</span>
                {whyMessage.model && (
                  <>
                    <span>·</span>
                    <span>{whyMessage.model}</span>
                  </>
                )}
              </div>
              <p className="max-h-32 overflow-y-auto whitespace-pre-wrap text-[12px] leading-[1.55] text-octo-ivory">
                {whyMessage.content.length > 800
                  ? whyMessage.content.slice(0, 800) + "…"
                  : whyMessage.content}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Strip the trailing function-context from `@@ -X,Y +A,B @@ extra` for a
 *  cleaner hunk label, e.g. "lines 12–18 → 12–22". */
function formatHunkRange(header: string): string {
  const m = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!m) return header;
  const [, oldStart, oldCount, newStart, newCount] = m;
  const oldEnd = parseInt(oldStart, 10) + (parseInt(oldCount || "1", 10) - 1);
  const newEnd = parseInt(newStart, 10) + (parseInt(newCount || "1", 10) - 1);
  return `lines ${oldStart}–${oldEnd} → ${newStart}–${newEnd}`;
}

// ─── Diff line ─────────────────────────────────────────────────────

function DiffLine({ line }: { line: string }) {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return (
      <div
        className="px-3 text-octo-verdigris"
        style={{ background: "rgba(143, 201, 168, 0.08)" }}
      >
        {line}
      </div>
    );
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return (
      <div
        className="px-3 text-octo-rouge"
        style={{ background: "rgba(209, 139, 139, 0.08)" }}
      >
        {line}
      </div>
    );
  }
  return <div className="px-3 text-octo-sage">{line}</div>;
}

// ─── Test drawer ───────────────────────────────────────────────────

function TestDrawer({
  result,
  onClose,
}: {
  result: TestRunResult;
  onClose: () => void;
}) {
  const isPass = result.exitCode === 0;

  return (
    <div className="border-t border-octo-hairline bg-octo-bg">
      <div className="flex items-center gap-2 px-4 py-2">
        <span className="font-mono text-xs font-semibold text-octo-text">Test output</span>
        <span
          className={[
            "ml-1 rounded px-2 py-0.5 font-mono text-[10px] font-semibold",
            isPass
              ? "bg-octo-success/20 text-octo-success"
              : "bg-octo-danger/20 text-octo-danger",
          ].join(" ")}
        >
          exit {result.exitCode}
        </span>
        <button
          onClick={onClose}
          aria-label="Dismiss"
          className="ml-auto flex h-6 w-6 items-center justify-center rounded text-octo-mute transition-colors hover:bg-octo-panel-2 hover:text-octo-sage"
          title="Dismiss (Esc)"
        >
          <X size={14} />
        </button>
      </div>
      <div className="max-h-56 overflow-y-auto px-4 pb-3">
        {result.stdout && (
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-octo-text">
            {result.stdout}
          </pre>
        )}
        {result.stderr && (
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-octo-danger/80">
            {result.stderr}
          </pre>
        )}
        {!result.stdout && !result.stderr && (
          <p className="text-xs text-octo-textMuted">(no output)</p>
        )}
      </div>
    </div>
  );
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
}: Props) {
  const [viewModeState, setViewModeState] = useState<ReviewViewMode>("diff");
  const viewMode = viewModeProp ?? viewModeState;
  const setViewMode = (next: ReviewViewMode) => {
    if (onViewModeChange) onViewModeChange(next);
    else setViewModeState(next);
  };
  const [fileEdits, setFileEdits] = useState<FileEdit[]>([]);

  // Test runner state
  const [testCommand, setTestCommand] = useState<string>("");
  const [testCommandEditing, setTestCommandEditing] = useState(false);
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<TestRunResult | null>(null);
  const testInputRef = useRef<HTMLInputElement>(null);

  // Parse diff
  const diffFiles = parseFullDiff(gitDiff);

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

  // Dismiss test drawer on Esc
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setTestResult(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  const fileCount = gitStatus?.changedFiles.length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* ── Toolbar ─────────────────────────────────────────────── */}
      {/* Same height as the left rail's CHANGES eyebrow and the right
          rail's FILES eyebrow — the three form one continuous rhythm
          row across the three columns. No floating stats on the left:
          file count lives in the workspace header, +/- line totals live
          in the CHANGES rail. */}
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-octo-hairline bg-octo-panel px-4">
        <div className="ml-auto flex items-center gap-2">
          {/* View toggle */}
          <div className="flex items-center rounded-md border border-octo-hairline overflow-hidden">
            <button
              onClick={() => setViewMode("diff")}
              className={[
                "flex items-center gap-1 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors",
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
              className={[
                "flex items-center gap-1 border-l border-octo-hairline px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors",
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
                className={[
                  "px-2 py-1 transition-colors",
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
              className="flex items-center gap-1 rounded px-2 py-1 text-octo-mute transition-colors hover:bg-octo-panel-2 hover:text-octo-brass disabled:opacity-30"
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
              className="flex items-center gap-1.5 rounded-md px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-octo-brass transition-colors"
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
          <div className="absolute inset-0 overflow-y-auto">
            {diffFiles.length === 0 ? (
              <EmptyDiffState
                stagedCount={
                  gitStatus?.changedFiles.filter((f) => f.staged).length ?? 0
                }
              />
            ) : (
              <div className="space-y-6 px-4 py-4">
                {diffFiles.map((file) => (
                  <FileDiffSection
                    key={file.filePath}
                    file={file}
                    workspacePath={workspacePath}
                    workspaceId={workspaceId}
                    fileEdits={fileEdits}
                    onDiffChange={onDiffChange}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Editor mode — render children (EditorTabs + EditorPane) */}
        {viewMode === "editor" && (
          <div className="absolute inset-0 flex flex-col">{children}</div>
        )}
      </div>

      {/* ── Test result drawer ───────────────────────────────────── */}
      {testResult && (
        <div className="shrink-0">
          <TestDrawer result={testResult} onClose={() => setTestResult(null)} />
        </div>
      )}
    </div>
  );
}

// ─── File diff section ─────────────────────────────────────────────

interface FileDiffSectionProps {
  file: DiffFile;
  workspacePath: string;
  workspaceId: string;
  fileEdits: FileEdit[];
  onDiffChange?: () => void;
}

function FileDiffSection({
  file,
  workspacePath,
  workspaceId,
  fileEdits,
  onDiffChange,
}: FileDiffSectionProps) {
  const [visibleHunks, setVisibleHunks] = useState(() => file.hunks.map((_, i) => i));

  function removeHunk(idx: number) {
    setVisibleHunks((prev) => prev.filter((i) => i !== idx));
    onDiffChange?.();
  }

  if (visibleHunks.length === 0) return null;

  const typeLabel =
    file.changeType === "new"
      ? "NEW"
      : file.changeType === "deleted"
        ? "DELETED"
        : "MODIFIED";

  const typeColor =
    file.changeType === "new"
      ? "text-octo-verdigris"
      : file.changeType === "deleted"
        ? "text-octo-rouge"
        : "text-octo-brass";

  return (
    <div
      className="space-y-3 scroll-mt-4"
      id={`review-file-${encodeURIComponent(file.filePath)}`}
    >
      {/* File header */}
      <div className="flex items-center gap-2 border-b border-octo-hairline pb-1.5">
        <span
          className={`font-mono text-[9px] font-semibold uppercase tracking-[0.2em] ${typeColor}`}
        >
          {typeLabel}
        </span>
        <span className="text-octo-hairline">·</span>
        <span className="font-mono text-[12.5px] text-octo-ivory">
          {file.filePath}
        </span>
        <ChevronRight size={11} className="text-octo-mute" />
        <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute">
          {visibleHunks.length} hunk{visibleHunks.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Hunk cards */}
      <div className="space-y-3">
        {visibleHunks.map((hunkIdx) => (
          <HunkCard
            key={hunkIdx}
            file={file}
            hunk={file.hunks[hunkIdx]}
            workspacePath={workspacePath}
            workspaceId={workspaceId}
            fileEdits={fileEdits}
            onAccepted={() => onDiffChange?.()}
            onRejected={() => removeHunk(hunkIdx)}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Empty state ───────────────────────────────────────────────────

function EmptyDiffState({ stagedCount }: { stagedCount: number }) {
  const hasStaged = stagedCount > 0;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <CheckCircle size={24} className="text-octo-brass opacity-60" />
      <div className="font-serif text-[20px] leading-tight tracking-[-0.005em] text-octo-ivory">
        {hasStaged
          ? `${stagedCount} file${stagedCount !== 1 ? "s" : ""} staged.`
          : "Nothing to review."}
      </div>
      <p className="max-w-xs text-[12px] leading-[1.6] text-octo-sage">
        {hasStaged
          ? "Write a commit message in the Changes rail and commit when you're ready."
          : "When the agent edits files in this workspace, the diff will appear here for hunk-by-hunk approval."}
      </p>
      <div className="h-px w-7 bg-octo-brass/60" aria-hidden />
    </div>
  );
}
