import { Crosshair } from "lucide-react";

interface Props {
  /** Absolute path of the file open in the editor, or null when none is. */
  path: string | null;
  /** The worktree root — the breadcrumb is shown relative to it. */
  rootPath: string;
  /** Point the file tree at this file. Omitted when no tree is listening. */
  onReveal?: (absPath: string) => void;
}

/** The open file's position in the worktree, as a path of segments, plus the
 *  control that points the tree at it.
 *
 *  Review deliberately does NOT make the tree follow the editor: clicking
 *  through a diff would keep shifting the tree under the reader. So the
 *  breadcrumb answers "where is this file" in text at all times, and revealing
 *  it in the tree is something you ask for — here or with ⌘⇧E. */
export function EditorBreadcrumb({ path, rootPath, onReveal }: Props) {
  if (!path) return null;

  const rel = path.startsWith(`${rootPath}/`) ? path.slice(rootPath.length + 1) : path;
  const segments = rel.split("/");
  const name = segments[segments.length - 1];
  const dirs = segments.slice(0, -1);

  return (
    <div className="flex items-center gap-1.5 border-b border-octo-hairline bg-octo-panel px-3 py-1">
      <nav
        aria-label="File location"
        className="flex min-w-0 items-center gap-1.5 overflow-hidden font-mono text-[10px] text-octo-mute"
      >
        {dirs.map((dir, i) => (
          // Directory names repeat across a tree, so the index is part of the
          // key — two `src/` segments in one path would otherwise collide.
          <span key={`${dir}-${i}`} className="flex shrink items-center gap-1.5 truncate">
            <span className="truncate">{dir}</span>
            <span aria-hidden className="text-octo-hairline">
              ›
            </span>
          </span>
        ))}
        <span className="shrink-0 truncate text-octo-ivory">{name}</span>
      </nav>

      {onReveal && (
        <button
          type="button"
          onClick={() => onReveal(path)}
          title="Reveal in the file tree (⌘⇧E)"
          aria-label="Reveal in the file tree"
          className="ml-auto flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] text-octo-mute transition-colors hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          <Crosshair size={11} aria-hidden />
          Reveal
        </button>
      )}
    </div>
  );
}
