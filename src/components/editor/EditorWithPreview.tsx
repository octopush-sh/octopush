import { useRef, useState } from "react";
import { EditorPane } from "../EditorPane";
import { MarkdownPreview } from "./MarkdownPreview";
import { isMarkdownFile } from "../../lib/isMarkdownFile";
import { useEditorStore } from "../../stores/editorStore";
import { useReviewPrefs } from "../../stores/reviewPrefsStore";

interface Props {
  workspaceId: string;
  workspacePath: string;
  diffText: string;
}

const REDUCED =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
const GROW = REDUCED ? "none" : "width 280ms cubic-bezier(0.2,0.8,0.3,1)";

/** REVIEW editor surface: EditorPane (always mounted) with an optional,
 *  collapsible MarkdownPreview to its right. The preview never unmounts the
 *  editor — it only collapses to zero width — so CodeMirror state survives a
 *  toggle. Divider is draggable (ratio persisted, clamped by the store) and
 *  double-click-resets. */
export function EditorWithPreview({ workspaceId, workspacePath, diffText }: Props) {
  const activePath = useEditorStore((s) => s.getActivePath(workspaceId));
  const files = useEditorStore((s) => s.getFiles(workspaceId));
  const mdPreview = useReviewPrefs((s) => s.mdPreview);
  const split = useReviewPrefs((s) => s.mdPreviewSplit);
  const setSplit = useReviewPrefs((s) => s.setMdPreviewSplit);

  const activeFile = activePath ? files.find((f) => f.path === activePath) ?? null : null;
  const showPreview = mdPreview && isMarkdownFile(activeFile);

  const containerRef = useRef<HTMLDivElement>(null);
  // Real state (not a ref) so the transition prop reactively flips to "none"
  // for the duration of a drag and back to the grow easing on release.
  const [dragging, setDragging] = useState(false);

  const onDividerMouseDown = () => {
    setDragging(true);
    const onMove = (e: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      setSplit(((e.clientX - rect.left) / rect.width) * 100);
    };
    const onUp = () => {
      setDragging(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const transition = dragging ? "none" : GROW;

  return (
    <div ref={containerRef} data-testid="editor-with-preview" className="flex h-full min-h-0 w-full overflow-hidden">
      {/* Editor — always mounted; full width when preview hidden. */}
      <div className="min-h-0 overflow-hidden" style={{ width: showPreview ? `${split}%` : "100%", transition }}>
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
        className="min-h-0 overflow-hidden"
        style={{
          width: showPreview ? `${100 - split}%` : "0%",
          visibility: showPreview ? "visible" : "hidden",
          transition,
        }}
      >
        {showPreview && activeFile && <MarkdownPreview source={activeFile.content} />}
      </div>
    </div>
  );
}
