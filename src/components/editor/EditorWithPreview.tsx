import { useCallback, useEffect, useRef, useState } from "react";
import { EditorPane } from "../EditorPane";
import { MarkdownPreview } from "./MarkdownPreview";
import { isMarkdownFile } from "../../lib/isMarkdownFile";
import { prefersReducedMotion } from "../../lib/motion";
import { useEditorStore } from "../../stores/editorStore";
import { useReviewPrefs } from "../../stores/reviewPrefsStore";
import type { MdView } from "../../stores/reviewPrefsStore";

interface Props {
  workspaceId: string;
  workspacePath: string;
  diffText: string;
}

/** How long the column width takes to settle — must match the CSS transition
 *  below, because a reveal dispatched mid-animation would measure CodeMirror
 *  against a column that hasn't finished widening. */
const WIDTH_MS = 280;

/** REVIEW editor surface: EditorPane (always mounted) beside an optional
 *  MarkdownPreview. A markdown tab picks one of three layouts — source only,
 *  split, or reading (rendered only). Neither pane ever unmounts the editor:
 *  a hidden column collapses to zero width, so CodeMirror keeps its undo
 *  history, folds and scroll position across every mode switch.
 *
 *  The divider is draggable in split: the live width is local component state
 *  while dragging and the ratio is committed to the persisted store once on
 *  release, so a drag doesn't serialize the whole prefs store to localStorage
 *  on every pixel. Double-click the divider to reset to 50/50. */
export function EditorWithPreview({ workspaceId, workspacePath, diffText }: Props) {
  const activePath = useEditorStore((s) => s.getActivePath(workspaceId));
  const files = useEditorStore((s) => s.getFiles(workspaceId));
  const revealLine = useEditorStore((s) => s.revealLine);
  const mdView = useReviewPrefs((s) => s.mdView);
  const setMdView = useReviewPrefs((s) => s.setMdView);
  const split = useReviewPrefs((s) => s.mdPreviewSplit);
  const setSplit = useReviewPrefs((s) => s.setMdPreviewSplit);

  const activeFile = activePath ? files.find((f) => f.path === activePath) ?? null : null;
  // Only a markdown tab has three layouts; anything else is the editor alone.
  const view: MdView = isMarkdownFile(activeFile) ? mdView : "source";
  const showEditor = view !== "reading";
  const showPreview = view !== "source";
  const showDivider = view === "split";

  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // Live width while dragging (committed to the store on release). Null when
  // not dragging, so the rendered width falls back to the persisted ratio.
  const [dragSplit, setDragSplit] = useState<number | null>(null);
  const liveRef = useRef<number | null>(null);
  // Detach handler for an in-flight drag, so we can also clean up if the
  // divider unmounts mid-drag or the component itself unmounts.
  const stopDragRef = useRef<(() => void) | null>(null);
  // Pending deferred reveal (reading → split), cancelled on a newer jump or
  // on unmount so a timer can never fire against a gone component.
  const revealTimerRef = useRef<number | null>(null);

  const width = dragSplit ?? split;
  const editorWidth = view === "split" ? `${width}%` : view === "source" ? "100%" : "0%";
  const previewWidth = view === "split" ? `${100 - width}%` : view === "reading" ? "100%" : "0%";

  const onDividerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    liveRef.current = null;
    // Suppress text selection + show the resize cursor for the whole gesture
    // (mirrors the Companion resize in App.tsx).
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMove = (ev: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const pct = Math.round(
        Math.max(25, Math.min(75, ((ev.clientX - rect.left) / rect.width) * 100)),
      );
      liveRef.current = pct;
      setDragSplit(pct);
    };
    const detach = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      stopDragRef.current = null;
    };
    function onUp() {
      // Commit the final position to the persisted store exactly once.
      if (liveRef.current != null) setSplit(liveRef.current);
      liveRef.current = null;
      setDragSplit(null);
      setDragging(false);
      detach();
    }
    stopDragRef.current = detach;
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // Abort an in-flight drag if the divider goes away (mode left split / active
  // tab flips to non-markdown): detach the document listeners and drop the
  // live width so nothing keeps mutating a control that is no longer visible.
  useEffect(() => {
    if (showDivider) return;
    stopDragRef.current?.();
    setDragSplit(null);
    setDragging(false);
  }, [showDivider]);
  // Detach on unmount as well (detach() only removes listeners — no setState).
  useEffect(() => () => {
    stopDragRef.current?.();
    if (revealTimerRef.current != null) window.clearTimeout(revealTimerRef.current);
  }, []);

  /** Rendered block → editor caret. From reading the editor column is still
   *  zero-width, so the jump opens split first and defers the reveal until the
   *  width transition lands — otherwise CodeMirror scrolls against no viewport. */
  const jumpToLine = useCallback(
    (line: number) => {
      const path = activeFile?.path;
      if (!path) return;
      if (revealTimerRef.current != null) {
        window.clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
      if (view !== "reading") {
        revealLine(workspaceId, path, line);
        return;
      }
      setMdView("split");
      if (prefersReducedMotion()) {
        revealLine(workspaceId, path, line);
        return;
      }
      revealTimerRef.current = window.setTimeout(() => {
        revealTimerRef.current = null;
        revealLine(workspaceId, path, line);
      }, WIDTH_MS + 20);
    },
    [activeFile?.path, view, workspaceId, revealLine, setMdView],
  );

  const transition =
    dragging || prefersReducedMotion()
      ? "none"
      : `width ${WIDTH_MS}ms cubic-bezier(0.2,0.8,0.3,1)`;

  return (
    <div ref={containerRef} data-testid="editor-with-preview" className="flex min-h-0 w-full flex-1 overflow-hidden">
      {/* Editor — always mounted; collapses to zero width in reading mode. The
          column is a flex-col so EditorPane's own flex-1 fills the height. */}
      <div
        className="flex min-h-0 flex-col overflow-hidden"
        style={{ width: editorWidth, visibility: showEditor ? "visible" : "hidden", transition }}
      >
        <EditorPane workspaceId={workspaceId} workspacePath={workspacePath} diffText={diffText} />
      </div>

      {/* Divider — only present (and interactive) in the split layout. */}
      {showDivider && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize preview"
          onMouseDown={onDividerMouseDown}
          onDoubleClick={() => setSplit(50)}
          className="w-px shrink-0 cursor-col-resize bg-octo-hairline transition-colors hover:bg-octo-brass"
        />
      )}

      {/* Preview — collapses to zero width when hidden; never remounts the
          editor. Only rendered for markdown tabs so the renderer never runs
          for code. */}
      <div
        className="flex min-h-0 flex-col overflow-hidden"
        style={{
          width: previewWidth,
          visibility: showPreview ? "visible" : "hidden",
          transition,
        }}
      >
        {showPreview && activeFile && (
          <MarkdownPreview source={activeFile.content} onJumpToLine={jumpToLine} />
        )}
      </div>
    </div>
  );
}
