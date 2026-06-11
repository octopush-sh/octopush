import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
import { Eye, EyeOff, Search } from "lucide-react";
import { ipc } from "../lib/ipc";
import type { DirectoryEntry } from "../lib/types";
import { fileIcon } from "../lib/fileIcons";
import { useReviewPrefs } from "../stores/reviewPrefsStore";
import { FileTreeContextMenu } from "./FileTreeContextMenu";
import { FileNameDialog } from "./FileNameDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { pushToast } from "./Toasts";
import { useVirtualRows } from "../lib/useVirtualRows";

/** Every row (node or placeholder) renders at exactly this height — the
 *  fixed-row contract the windowing math depends on. */
const ROW_HEIGHT = 24;

interface Props {
  rootPath: string;
  rootLabel: string;
  changedPaths: Set<string>;
  onFileClick?: (absPath: string) => void;
}

type ChildState = DirectoryEntry[] | "loading" | "error";

interface TreeStateCacheEntry {
  expanded: Set<string>;
  children: Record<string, ChildState>;
  focusedPath: string;
  /** The show-ignored value the cached children were fetched with. On
   *  mismatch we reuse the expanded set but not the children (they would
   *  show/hide the wrong entries until the revalidate fetch landed). */
  showIgnored: boolean;
}

/** Survives the mode-switch remount: the Companion unmounts this panel when
 *  the user leaves Review and remounts it on return — without this cache the
 *  whole expansion state (and every fetched directory) is lost each time.
 *  Keyed by rootPath so each workspace keeps its own snapshot. */
const treeStateCache = new Map<string, TreeStateCacheEntry>();

/** Test hook: existing suites assume a fresh tree per render. */
export function clearTreeStateCache(): void {
  treeStateCache.clear();
}

// ─── Flat row model ──────────────────────────────────────────────
//
// The tree renders from a flat list, not a recursive component: flattening is
// what makes both filtering (visibility is a property of the whole walk) and
// windowed rendering (a slice of an array) tractable.

interface NodeRow {
  kind: "node";
  path: string;
  label: string;
  isDir: boolean;
  isIgnored: boolean;
  depth: number;
  isRoot: boolean;
  isExpanded: boolean;
  /** [start, end) of the filter match inside `label`, when filtering. */
  match?: readonly [number, number];
}

interface PlaceholderRow {
  kind: "placeholder";
  key: string;
  depth: number;
  state: "loading" | "error" | "empty";
}

type FlatRow = NodeRow | PlaceholderRow;

/** Document-order walk of the expanded tree (no filter). */
function flattenVisible(
  rootPath: string,
  rootLabel: string,
  expanded: Set<string>,
  childrenMap: Record<string, ChildState>,
): FlatRow[] {
  const out: FlatRow[] = [];
  const visit = (
    path: string,
    label: string,
    isDir: boolean,
    isIgnored: boolean,
    depth: number,
    isRoot: boolean,
  ) => {
    const isExpanded = isDir && expanded.has(path);
    out.push({ kind: "node", path, label, isDir, isIgnored, depth, isRoot, isExpanded });
    if (!isExpanded) return;
    const state = childrenMap[path];
    if (!state || state === "loading") {
      out.push({ kind: "placeholder", key: `${path}::loading`, depth: depth + 1, state: "loading" });
      return;
    }
    if (state === "error") {
      out.push({ kind: "placeholder", key: `${path}::error`, depth: depth + 1, state: "error" });
      return;
    }
    if (state.length === 0) {
      out.push({ kind: "placeholder", key: `${path}::empty`, depth: depth + 1, state: "empty" });
      return;
    }
    for (const entry of state) {
      visit(entry.path, entry.name, entry.isDir, entry.isIgnored || isIgnored, depth + 1, false);
    }
  };
  visit(rootPath, rootLabel, true, false, 0, true);
  return out;
}

/** Filtered walk over everything LOADED (the tree is lazy — unloaded folders
 *  cannot match): a node is visible iff its name matches (case-insensitive
 *  substring) or it has a visible descendant. Ancestors of matches therefore
 *  stay visible; everything else collapses away. The caller's `expanded` set
 *  is deliberately not consulted — and not mutated — so clearing the filter
 *  restores the prior expansion untouched. */
function flattenFiltered(
  rootPath: string,
  rootLabel: string,
  childrenMap: Record<string, ChildState>,
  query: string,
): { rows: FlatRow[]; matchCount: number } {
  const q = query.toLowerCase();
  let matchCount = 0;
  const visit = (
    path: string,
    label: string,
    isDir: boolean,
    isIgnored: boolean,
    depth: number,
    isRoot: boolean,
  ): FlatRow[] | null => {
    const idx = isRoot ? -1 : label.toLowerCase().indexOf(q);
    const selfMatch = idx >= 0;
    if (selfMatch) matchCount += 1;
    const childRows: FlatRow[] = [];
    if (isDir) {
      const state = childrenMap[path];
      if (Array.isArray(state)) {
        for (const entry of state) {
          const sub = visit(
            entry.path,
            entry.name,
            entry.isDir,
            entry.isIgnored || isIgnored,
            depth + 1,
            false,
          );
          if (sub) childRows.push(...sub);
        }
      }
    }
    if (!isRoot && !selfMatch && childRows.length === 0) return null;
    const row: NodeRow = {
      kind: "node",
      path,
      label,
      isDir,
      isIgnored,
      depth,
      isRoot,
      isExpanded: isDir && childRows.length > 0,
      match: selfMatch ? ([idx, idx + q.length] as const) : undefined,
    };
    return [row, ...childRows];
  };
  const rows = visit(rootPath, rootLabel, true, false, 0, true) ?? [];
  return { rows, matchCount };
}

export function CompanionFileTree({ rootPath, rootLabel, changedPaths, onFileClick }: Props) {
  const showIgnored = useReviewPrefs((s) => !!s.showIgnoredFiles[rootPath]);
  const toggleShowIgnored = useReviewPrefs((s) => s.toggleShowIgnored);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const cached = treeStateCache.get(rootPath);
    return cached ? new Set(cached.expanded) : new Set([rootPath]);
  });
  const [children, setChildren] = useState<Record<string, ChildState>>(() => {
    const cached = treeStateCache.get(rootPath);
    return cached && cached.showIgnored === showIgnored ? cached.children : {};
  });
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    path: string;
    name: string;
    isDir: boolean;
  } | null>(null);
  // The in-flight file operation: which dialog/confirm is open, and for which
  // entry. Opened from the context menu (which dismisses itself first).
  const [fileOp, setFileOp] = useState<{
    kind: "newFile" | "newDir" | "rename" | "delete";
    path: string;
    name: string;
    isDir: boolean;
  } | null>(null);
  // Tree filter: a quiet input below the eyebrow bar. The query filters what
  // is LOADED — `expanded` is left untouched so clearing restores the view.
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  // Roving tabindex: exactly one row (the focused one) is tabbable; arrows
  // move within the tree. Invariant: focusedPath always points at a visible
  // row — collapsing an ancestor or hiding ignored files resets it to root.
  const [focusedPath, setFocusedPath] = useState(() => {
    const cached = treeStateCache.get(rootPath);
    // A cached focus target is only guaranteed to be rendered when the
    // cached children were fetched under the same show-ignored setting.
    return cached && cached.showIgnored === showIgnored ? cached.focusedPath : rootPath;
  });
  const genRef = useRef(0);
  // Mounted row elements, keyed by path — focus targets for keyboard nav.
  const rowEls = useRef(new Map<string, HTMLElement>());
  // A focus move requested before the target row was mounted/re-rendered;
  // applied (then cleared) by the layout effect below.
  const pendingFocusRef = useRef<string | null>(null);
  // The focused row scrolled out of the window while it held DOM focus;
  // re-apply focus when it scrolls back in (it is unmounted in between).
  const lostFocusRef = useRef<string | null>(null);
  const focusedPathRef = useRef(focusedPath);
  focusedPathRef.current = focusedPath;
  // Paths whose data has already been on screen (or inside the flat list) —
  // rise-in is reserved for newly appearing DATA, not for rows that merely
  // mount because the window scrolled over them.
  const seenPathsRef = useRef(new Set<string>());

  // Write the snapshot back on every state change. Skipped for the render
  // where rootPath just changed: that render's state still belongs to the
  // previous root, and the reset effect below re-runs us with fresh state.
  const cacheRootRef = useRef(rootPath);
  useEffect(() => {
    if (cacheRootRef.current !== rootPath) {
      cacheRootRef.current = rootPath;
      return;
    }
    treeStateCache.set(rootPath, { expanded, children, focusedPath, showIgnored });
  }, [rootPath, expanded, children, focusedPath, showIgnored]);

  const fetchChildren = useCallback(
    async (path: string, opts?: { force?: boolean }) => {
      if (!opts?.force && children[path] && children[path] !== "error") return; // already cached
      const gen = genRef.current;
      // Stale-while-revalidate: when force-refetching a path that already has
      // entries, keep the old rows visible until the new data lands. Checked
      // via functional update — the closure's `children` can be stale right
      // after a root-switch cache hydration (same effect pass).
      setChildren((prev) =>
        Array.isArray(prev[path]) ? prev : { ...prev, [path]: "loading" },
      );
      try {
        const entries = await ipc.readDirectory(path, showIgnored);
        if (genRef.current !== gen) return; // toggle flipped mid-flight; discard
        setChildren((prev) => ({ ...prev, [path]: entries }));
      } catch {
        if (genRef.current !== gen) return;
        setChildren((prev) => ({ ...prev, [path]: "error" }));
      }
    },
    [children, showIgnored],
  );

  /** Force-refetch one directory in place (stale-while-revalidate). */
  const refreshDir = useCallback(
    (dirPath: string) => void fetchChildren(dirPath, { force: true }),
    [fetchChildren],
  );

  /** Parent directory of an entry; entries at the top level map to the root. */
  const parentOf = useCallback(
    (path: string) => {
      const idx = path.lastIndexOf("/");
      const parent = idx > 0 ? path.slice(0, idx) : "";
      return parent === "" || !path.startsWith(rootPath + "/") ? rootPath : parent;
    },
    [rootPath],
  );

  /** A renamed/deleted row may be the focus target; keep the roving tabindex
   *  pointed at a rendered row by falling back to the root. */
  const releaseFocusUnder = useCallback(
    (path: string) => {
      setFocusedPath((cur) => (cur === path || cur.startsWith(path + "/") ? rootPath : cur));
    },
    [rootPath],
  );

  const submitFileOp = useCallback(
    async (name: string) => {
      if (!fileOp) return;
      const op = fileOp;
      setFileOp(null);
      try {
        if (op.kind === "newFile") {
          await ipc.fsCreateFile(rootPath, op.path, name);
          pushToast({ level: "success", title: "File created", body: name });
          refreshDir(op.path);
        } else if (op.kind === "newDir") {
          await ipc.fsCreateDir(rootPath, op.path, name);
          pushToast({ level: "success", title: "Folder created", body: name });
          refreshDir(op.path);
        } else if (op.kind === "rename") {
          if (name === op.name) return; // unchanged — quiet no-op
          const parent = parentOf(op.path);
          await ipc.fsRename(rootPath, op.path, parent + "/" + name);
          pushToast({ level: "success", title: "Renamed", body: name });
          releaseFocusUnder(op.path);
          refreshDir(parent);
        }
      } catch (err) {
        pushToast({
          level: "error",
          title: op.kind === "rename" ? "Rename failed" : "Create failed",
          body: String(err),
        });
      }
    },
    [fileOp, rootPath, parentOf, refreshDir, releaseFocusUnder],
  );

  const confirmDelete = useCallback(async () => {
    if (!fileOp) return;
    const op = fileOp;
    setFileOp(null);
    try {
      await ipc.fsDelete(rootPath, op.path);
      pushToast({ level: "success", title: "Deleted", body: op.name });
      releaseFocusUnder(op.path);
      refreshDir(parentOf(op.path));
    } catch (err) {
      pushToast({ level: "error", title: "Delete failed", body: String(err) });
    }
  }, [fileOp, rootPath, parentOf, refreshDir, releaseFocusUnder]);

  const prevRootRef = useRef(rootPath);
  const didInitRef = useRef(false);

  // (Re)load on mount, on workspace switch, and when the show-ignored toggle
  // flips: bump the generation (discarding in-flight responses) and
  // force-refetch. A workspace switch hydrates the destination's cached
  // snapshot (so A→B→A keeps A's expansion) and revalidates every expanded
  // folder; without a snapshot it resets to the new root alone. A toggle
  // keeps the cache and revalidates every expanded folder in place — old
  // rows stay visible until fresh entries land (no full-tree flash).
  useEffect(() => {
    const firstRun = !didInitRef.current;
    didInitRef.current = true;
    genRef.current += 1;
    const rootChanged = prevRootRef.current !== rootPath;
    prevRootRef.current = rootPath;
    if (rootChanged) {
      const cached = treeStateCache.get(rootPath);
      // Children (and the focus target, which must point at a rendered row)
      // are only reusable when they were fetched under the current
      // show-ignored setting — same rule as the initial-mount hydration.
      const sameIgnored = cached !== undefined && cached.showIgnored === showIgnored;
      setMenu(null);
      setFileOp(null);
      setFilterOpen(false);
      setFilterQuery("");
      seenPathsRef.current = new Set(); // the new root's rows get their entrance
      lostFocusRef.current = null;
      setExpanded(cached ? new Set(cached.expanded) : new Set([rootPath]));
      setChildren(sameIgnored ? cached.children : {});
      setFocusedPath(sameIgnored ? cached.focusedPath : rootPath);
      const toRevalidate = new Set(cached ? cached.expanded : []);
      toRevalidate.add(rootPath);
      for (const p of toRevalidate) {
        void fetchChildren(p, { force: true });
      }
      return;
    }
    // Toggling ignored files OFF may hide the focused row; reset the roving
    // tabindex to the root so the tree stays Tab-reachable. (Skipped on the
    // initial mount — a cache-restored focus target is still rendered.)
    if (!firstRun && !showIgnored) setFocusedPath(rootPath);
    const toFetch = new Set(expanded);
    toFetch.add(rootPath);
    for (const p of toFetch) {
      void fetchChildren(p, { force: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, showIgnored]);

  const toggleExpand = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
          // Collapsing an ancestor of the focused row would unrender it and
          // leave no tabbable row; fall back to the root.
          setFocusedPath((cur) => (cur.startsWith(path + "/") ? rootPath : cur));
        } else {
          next.add(path);
          fetchChildren(path);
        }
        return next;
      });
    },
    [fetchChildren, rootPath],
  );

  const openMenuAt = useCallback(
    (x: number, y: number, path: string, name: string, isDir: boolean) => {
      setMenu({ x, y, path, name, isDir });
    },
    [],
  );

  const onRowContextMenu = useCallback(
    (e: React.MouseEvent, path: string, name: string, isDir: boolean) => {
      e.preventDefault();
      openMenuAt(e.clientX, e.clientY, path, name, isDir);
    },
    [openMenuAt],
  );

  // ─── Flat rows ──────────────────────────────────────────────────

  const trimmedQuery = filterQuery.trim();
  const filterActive = filterOpen && trimmedQuery !== "";

  const { rows: flatRows, matchCount } = useMemo(() => {
    if (filterActive) return flattenFiltered(rootPath, rootLabel, children, trimmedQuery);
    return {
      rows: flattenVisible(rootPath, rootLabel, expanded, children),
      matchCount: 0,
    };
  }, [filterActive, rootPath, rootLabel, children, expanded, trimmedQuery]);

  /** Node rows only — the keyboard-navigation order (placeholders skipped). */
  const nodeRows = useMemo(
    () => flatRows.filter((r): r is NodeRow => r.kind === "node"),
    [flatRows],
  );

  // Filtering (or any data change) may hide the focus target; keep the
  // invariant that focusedPath points at a visible row.
  useEffect(() => {
    if (!nodeRows.some((r) => r.path === focusedPath)) setFocusedPath(rootPath);
  }, [nodeRows, focusedPath, rootPath]);

  // ─── Windowing ──────────────────────────────────────────────────

  const treeRef = useRef<HTMLDivElement>(null);
  const { start, end, topPad, bottomPad, scrollToRow } = useVirtualRows(
    treeRef,
    flatRows.length,
    ROW_HEIGHT,
  );
  const windowRows = useMemo(() => flatRows.slice(start, end), [flatRows, start, end]);

  // Mark every path currently in the (full) flat list as seen — from the
  // next commit on, mounting such a row is windowing, not new data.
  useEffect(() => {
    for (const r of flatRows) {
      if (r.kind === "node") seenPathsRef.current.add(r.path);
    }
  }, [flatRows]);

  // Apply a deferred focus move once the target row exists in the DOM.
  useLayoutEffect(() => {
    const want = pendingFocusRef.current;
    if (!want) return;
    const el = rowEls.current.get(want);
    if (el) {
      pendingFocusRef.current = null;
      el.focus({ preventScroll: true });
      el.scrollIntoView?.({ block: "nearest" });
    }
  });

  const focusNodeAt = useCallback(
    (idx: number) => {
      const target = nodeRows[idx];
      if (!target) return;
      pendingFocusRef.current = target.path;
      setFocusedPath(target.path);
      // Bring the target inside the window — it may not be mounted yet; the
      // layout effect above applies the focus once it is.
      scrollToRow(flatRows.indexOf(target));
      const el = rowEls.current.get(target.path);
      if (el) {
        pendingFocusRef.current = null;
        el.focus({ preventScroll: true });
        el.scrollIntoView?.({ block: "nearest" });
      }
    },
    [nodeRows, flatRows, scrollToRow],
  );

  /** Keyboard model over the flat list (visual order = array order). */
  const onRowKeyDown = useCallback(
    (e: React.KeyboardEvent, row: NodeRow) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (row.isDir) toggleExpand(row.path);
        else onFileClick?.(row.path);
        return;
      }
      // Keyboard route to the context menu (WAI-ARIA: Shift+F10 / Menu key).
      if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        e.preventDefault();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenuAt(r.left + 8, r.bottom, row.path, row.label, row.isDir);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) {
        return;
      }
      e.preventDefault();
      const idx = nodeRows.findIndex((r) => r.path === row.path);
      if (idx < 0) return;
      switch (e.key) {
        case "ArrowDown":
          focusNodeAt(idx + 1);
          break;
        case "ArrowUp":
          focusNodeAt(idx - 1);
          break;
        case "ArrowRight":
          if (!row.isDir) break;
          if (!row.isExpanded) toggleExpand(row.path);
          else focusNodeAt(idx + 1); // first child in visual order
          break;
        case "ArrowLeft":
          if (row.isDir && row.isExpanded) {
            toggleExpand(row.path);
            break;
          }
          // Focus the parent: first preceding row with a smaller depth.
          for (let i = idx - 1; i >= 0; i--) {
            if (nodeRows[i].depth < row.depth) {
              focusNodeAt(i);
              break;
            }
          }
          break;
        case "Home":
          focusNodeAt(0);
          break;
        case "End":
          focusNodeAt(nodeRows.length - 1);
          break;
      }
    },
    [nodeRows, focusNodeAt, toggleExpand, onFileClick, openMenuAt],
  );

  const registerRowEl = useCallback((path: string, el: HTMLElement | null) => {
    if (el) {
      rowEls.current.set(path, el);
      // The roving-focus row scrolled back into the window after being
      // unmounted mid-focus: reclaim, but only if focus genuinely fell to
      // the body (never steal from the filter input or another control).
      if (
        lostFocusRef.current === path &&
        (document.activeElement === document.body || document.activeElement === null)
      ) {
        lostFocusRef.current = null;
        el.focus({ preventScroll: true });
      }
    } else {
      const prev = rowEls.current.get(path);
      rowEls.current.delete(path);
      // Unmounting the focused row drops DOM focus to the body; remember it
      // so the attach branch above can re-apply when it scrolls back in.
      if (
        path === focusedPathRef.current &&
        (document.activeElement === prev || document.activeElement === document.body)
      ) {
        lostFocusRef.current = path;
      }
    }
  }, []);

  const toggleFilter = useCallback(() => {
    setFilterOpen((open) => {
      if (open) setFilterQuery("");
      return !open;
    });
  }, []);

  return (
    <section className="flex h-full min-h-0 flex-col">
      {/* Eyebrow — same height & padding as the canvas toolbar and the
          left rail's CHANGES eyebrow so the three top bars form one row. */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-octo-hairline px-4">
        <h3 className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">Files</h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Filter files"
            aria-pressed={filterOpen}
            title="Filter files"
            onClick={toggleFilter}
            className={`flex items-center justify-center rounded p-1 transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass ${
              filterOpen ? "text-octo-brass" : "text-octo-mute"
            }`}
          >
            <Search size={12} />
          </button>
          <button
            type="button"
            aria-label="Show ignored files"
            aria-pressed={showIgnored}
            title={showIgnored ? "Hide ignored files" : "Show ignored files"}
            onClick={() => toggleShowIgnored(rootPath)}
            className={`flex items-center justify-center rounded p-1 transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass ${
              showIgnored ? "text-octo-brass" : "text-octo-mute"
            }`}
          >
            {showIgnored ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
        </div>
      </div>

      {/* Filter strip — appears below the eyebrow, calm rise-in. */}
      {filterOpen && (
        <div className="octo-rise-in shrink-0 border-b border-octo-hairline px-4 py-2">
          <input
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // Swallow before App-level / overlay Escape handlers see it
                // (the context-menu listener is capture-phase and never
                // coexists with a focused filter input).
                e.preventDefault();
                e.stopPropagation();
                setFilterQuery("");
                setFilterOpen(false);
              }
            }}
            aria-label="Filter files"
            title="Searches loaded folders"
            placeholder="Filter by name"
            autoFocus
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            className="w-full bg-transparent font-mono text-[11px] text-octo-ivory outline-none placeholder:font-serif placeholder:not-italic placeholder:text-octo-mute"
          />
          {filterActive && (
            <p className="mt-1 font-mono text-[10px] text-octo-mute">
              {matchCount === 1 ? "1 match" : `${matchCount} matches`}
            </p>
          )}
        </div>
      )}

      <div
        ref={treeRef}
        role="tree"
        aria-label="Workspace files"
        className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
      >
        {topPad > 0 && <div aria-hidden="true" style={{ height: `${topPad}px` }} />}
        {windowRows.map((row) =>
          row.kind === "node" ? (
            <TreeRow
              key={row.path}
              row={row}
              isChanged={!row.isDir && changedPaths.has(row.path)}
              isFocused={row.path === focusedPath}
              isNew={!seenPathsRef.current.has(row.path)}
              onActivate={() => {
                if (row.isDir) toggleExpand(row.path);
                else onFileClick?.(row.path);
              }}
              onKeyDown={onRowKeyDown}
              onContextMenu={(e) => onRowContextMenu(e, row.path, row.label, row.isDir)}
              onFocusRow={setFocusedPath}
              registerEl={registerRowEl}
            />
          ) : (
            <PlaceholderLine key={row.key} row={row} />
          ),
        )}
        {bottomPad > 0 && <div aria-hidden="true" style={{ height: `${bottomPad}px` }} />}
      </div>

      {menu && (
        <FileTreeContextMenu
          path={menu.path}
          name={menu.name}
          isDir={menu.isDir}
          isRoot={menu.path === rootPath}
          rootPath={rootPath}
          x={menu.x}
          y={menu.y}
          onDismiss={() => setMenu(null)}
          onNewFile={() => setFileOp({ kind: "newFile", path: menu.path, name: menu.name, isDir: menu.isDir })}
          onNewDir={() => setFileOp({ kind: "newDir", path: menu.path, name: menu.name, isDir: menu.isDir })}
          onRename={() => setFileOp({ kind: "rename", path: menu.path, name: menu.name, isDir: menu.isDir })}
          onDelete={() => setFileOp({ kind: "delete", path: menu.path, name: menu.name, isDir: menu.isDir })}
        />
      )}

      {fileOp && fileOp.kind !== "delete" && (
        <FileNameDialog
          title={
            fileOp.kind === "newFile" ? "New file" : fileOp.kind === "newDir" ? "New folder" : "Rename"
          }
          label={
            fileOp.kind === "newDir" || (fileOp.kind === "rename" && fileOp.isDir)
              ? "Folder name"
              : "File name"
          }
          initial={fileOp.kind === "rename" ? fileOp.name : undefined}
          confirmLabel={fileOp.kind === "rename" ? "Rename" : "Create"}
          onSubmit={(name) => void submitFileOp(name)}
          onClose={() => setFileOp(null)}
        />
      )}

      {fileOp?.kind === "delete" && (
        <ConfirmDialog
          title={`Delete ${fileOp.name}?`}
          body="This cannot be undone."
          destructiveLabel="Delete"
          onConfirm={confirmDelete}
          onCancel={() => setFileOp(null)}
        />
      )}
    </section>
  );
}

// ─── Rows ────────────────────────────────────────────────────────

/** Returns the label color class for a file/folder based on state and depth. */
function depthColorClass(depth: number, isChanged: boolean): string {
  if (isChanged) return "text-octo-ivory";
  if (depth >= 4) return "text-octo-mute";
  return "text-octo-sage";
}

interface TreeRowProps {
  row: NodeRow;
  isChanged: boolean;
  isFocused: boolean;
  /** True only in the commit where this path's data first appears — gates
   *  the rise-in entrance so scrolling never replays it. */
  isNew: boolean;
  onActivate: () => void;
  onKeyDown: (e: React.KeyboardEvent, row: NodeRow) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onFocusRow: (path: string) => void;
  registerEl: (path: string, el: HTMLElement | null) => void;
}

function TreeRow({
  row,
  isChanged,
  isFocused,
  isNew,
  onActivate,
  onKeyDown,
  onContextMenu,
  onFocusRow,
  registerEl,
}: TreeRowProps) {
  const { path, label, isDir, isIgnored, depth, isRoot, isExpanded, match } = row;
  const Icon = !isDir ? fileIcon(label) : null;
  // Freeze the entrance decision for the lifetime of this mounted instance:
  // re-renders within the animation window must not strip the class
  // mid-flight, and a remount via scrolling arrives with isNew=false.
  const riseIn = useRef(isNew).current;

  return (
    <div
      role="treeitem"
      aria-expanded={isDir ? isExpanded : undefined}
      aria-level={depth + 1}
      tabIndex={isFocused ? 0 : -1}
      data-depth={depth}
      ref={(el) => registerEl(path, el)}
      onFocus={() => onFocusRow(path)}
      title={isIgnored ? "Ignored by .gitignore" : undefined}
      className={`${riseIn ? "octo-rise-in " : ""}group relative flex cursor-pointer items-center gap-1 rounded-sm pr-1 transition duration-[220ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass${
        isIgnored ? " opacity-60" : ""
      }`}
      style={{
        height: `${ROW_HEIGHT}px`,
        paddingLeft: `${depth * 14 + 4}px`,
        background: "transparent",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = "var(--brass-ghost)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "transparent";
      }}
      onClick={onActivate}
      onKeyDown={(e) => onKeyDown(e, row)}
      onContextMenu={onContextMenu}
      data-testid={!isDir ? `file-row-${path}` : undefined}
    >
      {/* Indent guides — one 1px hairline per depth level */}
      {depth > 0 && <IndentGuides depth={depth} />}

      {/* Chevron (dirs) or dot indicator (files) */}
      {isDir ? (
        <span
          className="shrink-0 font-mono text-[9px] group-hover:text-octo-brass"
          data-testid={isExpanded ? "chevron-expanded" : "chevron-collapsed"}
          style={{
            color: isExpanded ? "var(--color-octo-brass)" : "var(--color-octo-mute)",
            transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
            display: "inline-block",
            transition: "transform 220ms cubic-bezier(0.2,0.8,0.3,1), color 220ms",
          }}
        >
          ▶
        </span>
      ) : (
        Icon && (
          <Icon
            size={12}
            aria-hidden="true"
            className="shrink-0 transition-colors duration-[220ms]"
            style={{ color: isChanged ? "var(--color-octo-brass)" : "var(--color-octo-mute)" }}
          />
        )
      )}

      {/* § glyph for folders (quiet brand mark, not for root) */}
      {isDir && !isRoot && (
        <span
          aria-hidden="true"
          className="shrink-0 font-mono text-[10px]"
          style={{ color: "var(--brass-dim)" }}
        >
          §
        </span>
      )}

      {/* Label */}
      {isRoot ? (
        <span className="min-w-0 truncate font-serif text-[13px] text-octo-ivory">{label}</span>
      ) : (
        <span className={`min-w-0 truncate font-mono text-[11px] ${depthColorClass(depth, isChanged)}`}>
          {match ? <HighlightedLabel label={label} match={match} /> : label}
        </span>
      )}
    </div>
  );
}

/** Filter-match emphasis: the matched substring alone reads brass. */
function HighlightedLabel({ label, match }: { label: string; match: readonly [number, number] }) {
  const [start, end] = match;
  return (
    <>
      {label.slice(0, start)}
      <span className="text-octo-brass">{label.slice(start, end)}</span>
      {label.slice(end)}
    </>
  );
}

function PlaceholderLine({ row }: { row: PlaceholderRow }) {
  const text = row.state === "loading" ? "loading…" : row.state === "error" ? "error reading directory." : "empty.";
  return (
    <div
      className={`flex items-center font-serif text-[11px] ${
        row.state === "error" ? "text-octo-rouge" : "text-octo-mute"
      }`}
      style={{ height: `${ROW_HEIGHT}px`, paddingLeft: `${row.depth * 14 + 4}px` }}
    >
      {text}
    </div>
  );
}

/**
 * Renders vertical indent guide lines, one per depth level.
 * Ancestor guides are rendered at low opacity (~20%) to recede;
 * the current row's own guide (last one) is highlighted using brass-dim.
 */
function IndentGuides({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, i) => {
        const isCurrentLevel = i === depth - 1;
        return (
          <span
            key={i}
            aria-hidden="true"
            className="pointer-events-none absolute top-0 bottom-0 border-l"
            style={{
              left: `${i * 14 + 10}px`,
              borderColor: isCurrentLevel
                ? "var(--brass-dim)" // current row's guide: dimmed brass
                : "var(--color-octo-hairline)", // ancestor guides: hairline, receded via opacity
              opacity: isCurrentLevel ? 1 : 0.2,
            }}
          />
        );
      })}
    </>
  );
}
