import { Copy, ExternalLink, FilePlus, FolderOpen, FolderPlus, Pencil, SquareTerminal, Trash2 } from "lucide-react";
import { MenuSurface } from "./MenuSurface";
import { MENU_DANGER, MENU_HEADER, MENU_ITEM, MENU_SEP } from "../lib/menuStyles";
import { ipc } from "../lib/ipc";
import { pushToast } from "./Toasts";

interface Props {
  /** Absolute path of the right-clicked entry. */
  path: string;
  /** Display name (file or folder basename). */
  name: string;
  isDir: boolean;
  /** True when the entry is the workspace root itself — hides Rename/Delete,
   *  which the backend always refuses for the root. */
  isRoot?: boolean;
  /** Workspace root, for computing the relative path. */
  rootPath: string;
  x: number;
  y: number;
  onDismiss: () => void;
  /** Open the New-file name dialog (dirs only). */
  onNewFile: () => void;
  /** Open the New-folder name dialog (dirs only). */
  onNewDir: () => void;
  /** Open the Rename dialog. */
  onRename: () => void;
  /** Open the Delete confirmation. */
  onDelete: () => void;
}

const ITEM = MENU_ITEM;
const DANGER = MENU_DANGER;
const SEP = MENU_SEP;

function relativePath(abs: string, root: string): string {
  if (abs === root) return ".";
  if (abs.startsWith(root + "/")) return abs.slice(root.length + 1);
  return abs;
}

/**
 * Context menu for companion file-tree rows. MenuSurface's portal+fixed
 * chrome lets it escape the tree's overflow-y-auto scroll container.
 */
export function FileTreeContextMenu({
  path,
  name,
  isDir,
  isRoot = false,
  rootPath,
  x,
  y,
  onDismiss,
  onNewFile,
  onNewDir,
  onRename,
  onDelete,
}: Props) {
  const run = (fn: () => void) => () => {
    fn();
    onDismiss();
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => pushToast({ level: "success", title: "Path copied" }),
      (e) => pushToast({ level: "error", title: "Copy failed", body: String(e) }),
    );
  };

  return (
    <MenuSurface x={x} y={y} ariaLabel={`Actions for ${name}`} onDismiss={onDismiss}>
      <div className={MENU_HEADER}>
        {name}
      </div>

      <button
        type="button"
        role="menuitem"
        className={ITEM}
        onClick={run(() =>
          void ipc
            .revealInFinder(path)
            .catch((err) => pushToast({ level: "error", title: "Reveal failed", body: String(err) })),
        )}
      >
        <FolderOpen size={12} className="shrink-0" /> Reveal in Finder
      </button>
      {isDir ? (
        <button
          type="button"
          role="menuitem"
          className={ITEM}
          onClick={run(() =>
            void ipc
              .openInTerminal(path)
              .catch((err) => pushToast({ level: "error", title: "Open in terminal failed", body: String(err) })),
          )}
        >
          <SquareTerminal size={12} className="shrink-0" /> Open in terminal
        </button>
      ) : (
        <button
          type="button"
          role="menuitem"
          className={ITEM}
          onClick={run(() =>
            void ipc
              .openFileInSystem(path)
              .catch((err) => pushToast({ level: "error", title: "Open failed", body: String(err) })),
          )}
        >
          <ExternalLink size={12} className="shrink-0" /> Open in system app
        </button>
      )}

      <div className={SEP} />

      <button type="button" role="menuitem" className={ITEM} onClick={run(() => copy(path))}>
        <Copy size={12} className="shrink-0" /> Copy path
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={run(() => copy(relativePath(path, rootPath)))}>
        <Copy size={12} className="shrink-0" /> Copy relative path
      </button>

      <div className={SEP} />

      {isDir && (
        <>
          <button
            type="button"
            role="menuitem"
            className={ITEM}
            title="Create a file in this folder"
            onClick={run(onNewFile)}
          >
            <FilePlus size={12} className="shrink-0" /> New file
          </button>
          <button
            type="button"
            role="menuitem"
            className={ITEM}
            title="Create a folder in this folder"
            onClick={run(onNewDir)}
          >
            <FolderPlus size={12} className="shrink-0" /> New folder
          </button>
        </>
      )}
      {!isRoot && (
        <>
          <button
            type="button"
            role="menuitem"
            className={ITEM}
            title={isDir ? "Rename this folder" : "Rename this file"}
            onClick={run(onRename)}
          >
            <Pencil size={12} className="shrink-0" /> Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className={DANGER}
            title="Delete permanently"
            onClick={run(onDelete)}
          >
            <Trash2 size={12} className="shrink-0" /> Delete
          </button>
        </>
      )}
    </MenuSurface>
  );
}
