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

  if (files.length === 0) return null;

  return (
    <div
      className="flex overflow-x-auto border-b border-octo-hairline bg-octo-panel"
      style={{ scrollbarWidth: "none" }}
    >
      {files.map((file) => {
        const filename = file.path.split("/").pop() ?? file.path;
        const isActive = file.path === activePath;
        const dirty = isDirty(workspaceId, file.path);

        return (
          <div
            key={file.path}
            data-testid={`tab-${file.path}`}
            className="group relative flex shrink-0 cursor-pointer items-center gap-1.5 px-3 py-2 transition-colors duration-[220ms]"
            style={{
              borderBottom: isActive
                ? "2px solid var(--color-octo-brass)"
                : "2px solid transparent",
              background: isActive
                ? "rgba(212, 165, 116, 0.04)"
                : "transparent",
            }}
            onClick={() => setActive(workspaceId, file.path)}
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
