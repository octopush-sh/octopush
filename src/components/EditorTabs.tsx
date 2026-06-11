import { useState } from "react";
import { useEditorStore } from "../stores/editorStore";

interface Props {
  workspaceId: string;
}

export function EditorTabs({ workspaceId }: Props) {
  const files = useEditorStore((s) => s.getFiles(workspaceId));
  const activePath = useEditorStore((s) => s.getActivePath(workspaceId));
  const isDirty = useEditorStore((s) => s.isDirty);
  const setActive = useEditorStore((s) => s.setActive);
  const closeFile = useEditorStore((s) => s.closeFile);
  const reorderFiles = useEditorStore((s) => s.reorderFiles);

  // Drag-reorder state: the index being dragged and the current drop target.
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  if (files.length === 0) return null;

  /** Roving-tabindex focus movement (mirrors CompanionFileTree): arrows move
   *  focus only; Enter/Space activates. The active tab keeps tabIndex 0. */
  const onTabKeyDown = (
    e: React.KeyboardEvent<HTMLDivElement>,
    path: string,
  ) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Enter" || e.key === " ") {
      setActive(workspaceId, path);
      return;
    }

    const tablist = e.currentTarget.parentElement;
    if (!tablist) return;
    const tabs = Array.from(
      tablist.querySelectorAll<HTMLElement>('[role="tab"]'),
    );
    const idx = tabs.indexOf(e.currentTarget);
    if (idx === -1) return;

    let next = idx;
    if (e.key === "ArrowLeft") next = Math.max(0, idx - 1);
    else if (e.key === "ArrowRight") next = Math.min(tabs.length - 1, idx + 1);
    else if (e.key === "Home") next = 0;
    else next = tabs.length - 1; // End
    tabs[next]?.focus();
  };

  const clearDrag = () => {
    setDragIdx(null);
    setDropIdx(null);
  };

  return (
    <div
      role="tablist"
      aria-label="Open files"
      className="flex overflow-x-auto border-b border-octo-hairline bg-octo-panel"
      style={{ scrollbarWidth: "none" }}
    >
      {files.map((file, index) => {
        const filename = file.path.split("/").pop() ?? file.path;
        const isActive = file.path === activePath;
        const dirty = isDirty(workspaceId, file.path);
        const isDragging = dragIdx === index;
        const isDropTarget =
          dropIdx === index && dragIdx !== null && dragIdx !== index;

        return (
          <div
            key={file.path}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            title={file.path}
            data-testid={`tab-${file.path}`}
            draggable
            className={`group relative flex shrink-0 cursor-pointer items-center gap-1.5 px-3 py-2 transition-colors duration-[220ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass ${
              isDragging ? "opacity-60" : ""
            }`}
            style={{
              borderBottom: isActive
                ? "2px solid var(--color-octo-brass)"
                : "2px solid transparent",
              // Constant-width left border keeps the row from shifting while
              // the drop cue appears — calm, no layout jump.
              borderLeft: isDropTarget
                ? "2px solid var(--brass-dim)"
                : "2px solid transparent",
              background: isActive ? "var(--brass-faint)" : "transparent",
            }}
            onClick={() => setActive(workspaceId, file.path)}
            onKeyDown={(e) => onTabKeyDown(e, file.path)}
            onDragStart={(e) => {
              setDragIdx(index);
              if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
              if (dragIdx !== null && dropIdx !== index) setDropIdx(index);
            }}
            onDragLeave={() => {
              if (dropIdx === index) setDropIdx(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIdx !== null && dragIdx !== index) {
                reorderFiles(workspaceId, dragIdx, index);
              }
              clearDrag();
            }}
            onDragEnd={clearDrag}
          >
            {/* Filename */}
            <span
              className={`font-mono text-[11px] ${
                isActive ? "text-octo-ivory" : "text-octo-sage"
              }`}
            >
              {filename}
            </span>

            {/* Dirty indicator */}
            {dirty && (
              <span
                data-testid={`dirty-dot-${file.path}`}
                className="font-mono text-[10px]"
                style={{ color: "var(--color-octo-brass)" }}
              >
                ●
              </span>
            )}

            {/* Close button — bigger tap target (20×20) with a clear
                rouge hover so it reads as a destructive action. */}
            <button
              type="button"
              data-testid={`close-tab-${file.path}`}
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-sm font-mono text-[14px] leading-none transition-all duration-[220ms] hover:bg-octo-rouge/15 hover:!text-octo-rouge ${
                isActive
                  ? "opacity-70"
                  : "opacity-0 group-hover:opacity-70"
              }`}
              style={{ color: "var(--color-octo-sage)" }}
              onClick={(e) => {
                e.stopPropagation();
                closeFile(workspaceId, file.path);
              }}
              aria-label={`Close ${filename}`}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
