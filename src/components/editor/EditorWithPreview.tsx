import { useEffect, useRef, useState } from "react";
import { EditorPane } from "../EditorPane";
import { MarkdownPreview } from "./MarkdownPreview";
import { isMarkdownFile } from "../../lib/isMarkdownFile";
import { prefersReducedMotion } from "../../lib/motion";
import { useEditorStore } from "../../stores/editorStore";
import { useReviewPrefs } from "../../stores/reviewPrefsStore";

interface Props {
  workspaceId: string;
  workspacePath: string;
  diffText: string;
}

/** REVIEW editor surface: EditorPane (always mounted) with an optional,
 *  collapsible MarkdownPreview to its right. The preview never unmounts the
 *  editor — it only collapses to zero width — so CodeMirror state survives a
 *  toggle. The divider is draggable: the live width is local component state
 *  while dragging and the ratio is committed to the persisted store once on
 *  release, so a drag doesn't serialize the whole prefs store to localStorage
 *  on every pixel. Double-click the divider to reset to 50/50. */
export function EditorWithPreview({ workspaceId, workspacePath, diffText }: Props) {
  const activePath = useEditorStore((s) => s.getActivePath(workspaceId));
  const files = useEditorStore((s) => s.getFiles(workspaceId));
  const mdPreview = useReviewPrefs((s) => s.mdPreview);
  const split = useReviewPrefs((s) => s.mdPreviewSplit);
  const setSplit = useReviewPrefs((s) => s.setMdPreviewSplit);

  const activeFile = activePath ? files.find((f) => f.path === activePath) ?? null : null;
  const showPreview = mdPreview && isMarkdownFile(activeFile);

  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // Live width while dragging (committed to the store on release). Null when
  // not dragging, so the rendered width falls back to the persisted ratio.
  const [dragSplit, setDragSplit] = useState<number | null>(null);
  const liveRef = useRef<number | null>(null);
  // Detach handler for an in-flight drag, so we can also clean up if the
  // divider unmounts mid-drag or the component itself unmounts.
  const stopDragRef = useRef<(() => void) | null>(null);

  const width = dragSplit ?? split;

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

  // Abort an in-flight drag if the divider goes away (preview hidden / active
  // tab flips to non-markdown): detach the document listeners and drop the
  // live width so nothing keeps mutating a control that is no longer visible.
  useEffect(() => {
    if (showPreview) return;
    stopDragRef.current?.();
    setDragSplit(null);
    setDragging(false);
  }, [showPreview]);
  // Detach on unmount as well (detach() only removes listeners — no setState).
  useEffect(() => () => { stopDragRef.current?.(); }, []);

  const transition =
    dragging || prefersReducedMotion()
      ? "none"
      : "width 280ms cubic-bezier(0.2,0.8,0.3,1)";

  return (
    <div ref={containerRef} data-testid="editor-with-preview" className="flex min-h-0 w-full flex-1 overflow-hidden">
      {/* Editor — always mounted; full width when preview hidden. The column is
          a flex-col so EditorPane's own flex-1 fills the available height. */}
      <div className="flex min-h-0 flex-col overflow-hidden" style={{ width: showPreview ? `${width}%` : "100%", transition }}>
        <EditorPane workspaceId={workspaceId} workspacePath={workspacePath} diffText={diffText} />
      </div>

      {/* Divider — only interactive when the preview is visible. */}
      {showPreview && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize preview"
          onMouseDown={onDividerMouseDown}
          onDoubleClick={() => setSplit(50)}
          className="w-px shrink-0 cursor-col-resize bg-octo-hairline transition-colors hover:bg-octo-brass"
        />
      )}

      {/* Preview — collapses to zero width when hidden; never remounts the editor.
          Only rendered for markdown tabs so we don't run the renderer for code. */}
      <div
        className="flex min-h-0 flex-col overflow-hidden"
        style={{
          width: showPreview ? `${100 - width}%` : "0%",
          visibility: showPreview ? "visible" : "hidden",
          transition,
        }}
      >
        {showPreview && activeFile && <MarkdownPreview source={activeFile.content} />}
      </div>
    </div>
  );
}
