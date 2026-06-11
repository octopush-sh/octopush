import { useState, useEffect, useCallback, useRef } from "react";
import { Eye, EyeOff } from "lucide-react";
import { ipc } from "../lib/ipc";
import type { DirectoryEntry } from "../lib/types";
import { fileIcon } from "../lib/fileIcons";
import { useReviewPrefs } from "../stores/reviewPrefsStore";
import { FileTreeContextMenu } from "./FileTreeContextMenu";

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
  // Roving tabindex: exactly one row (the focused one) is tabbable; arrows
  // move within the tree. Invariant: focusedPath always points at a rendered
  // row — collapsing an ancestor or hiding ignored files resets it to root.
  const [focusedPath, setFocusedPath] = useState(() => {
    const cached = treeStateCache.get(rootPath);
    // A cached focus target is only guaranteed to be rendered when the
    // cached children were fetched under the same show-ignored setting.
    return cached && cached.showIgnored === showIgnored ? cached.focusedPath : rootPath;
  });
  const genRef = useRef(0);

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

  return (
    <section className="flex h-full min-h-0 flex-col">
      {/* Eyebrow — same height & padding as the canvas toolbar and the
          left rail's CHANGES eyebrow so the three top bars form one row. */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-octo-hairline px-4">
        <h3 className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">Files</h3>
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

      <div role="tree" aria-label="Workspace files" className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <TreeNode
          path={rootPath}
          label={rootLabel}
          isDir={true}
          isIgnored={false}
          depth={0}
          isRoot={true}
          expanded={expanded}
          children={children}
          changedPaths={changedPaths}
          focusedPath={focusedPath}
          onToggle={toggleExpand}
          onFileClick={onFileClick}
          onRowContextMenu={onRowContextMenu}
          onRowFocus={setFocusedPath}
          onShowMenuAt={openMenuAt}
        />
      </div>

      {menu && (
        <FileTreeContextMenu
          path={menu.path}
          name={menu.name}
          isDir={menu.isDir}
          rootPath={rootPath}
          x={menu.x}
          y={menu.y}
          onDismiss={() => setMenu(null)}
        />
      )}
    </section>
  );
}

interface TreeNodeProps {
  path: string;
  label: string;
  isDir: boolean;
  isIgnored: boolean;
  depth: number;
  isRoot: boolean;
  expanded: Set<string>;
  children: Record<string, ChildState>;
  changedPaths: Set<string>;
  focusedPath: string;
  onToggle: (path: string) => void;
  onFileClick?: (absPath: string) => void;
  onRowContextMenu: (e: React.MouseEvent, path: string, name: string, isDir: boolean) => void;
  onRowFocus: (path: string) => void;
  onShowMenuAt: (x: number, y: number, path: string, name: string, isDir: boolean) => void;
}

/** Returns the label color class for a file/folder based on state and depth. */
function depthColorClass(depth: number, isChanged: boolean): string {
  if (isChanged) return "text-octo-ivory";
  if (depth >= 4) return "text-octo-mute";
  return "text-octo-sage";
}

function TreeNode({
  path,
  label,
  isDir,
  isIgnored,
  depth,
  isRoot,
  expanded,
  children,
  changedPaths,
  focusedPath,
  onToggle,
  onFileClick,
  onRowContextMenu,
  onRowFocus,
  onShowMenuAt,
}: TreeNodeProps) {
  const isExpanded = expanded.has(path);
  const isChanged = !isDir && changedPaths.has(path);
  const Icon = !isDir ? fileIcon(label) : null;

  const activate = () => {
    if (isDir) {
      onToggle(path);
    } else if (onFileClick) {
      onFileClick(path);
    }
  };

  return (
    <div>
      {/* Row */}
      <div
        role="treeitem"
        aria-expanded={isDir ? isExpanded : undefined}
        tabIndex={path === focusedPath ? 0 : -1}
        data-depth={depth}
        onFocus={() => onRowFocus(path)}
        title={isIgnored ? "Ignored by .gitignore" : undefined}
        className={`octo-rise-in group relative flex cursor-pointer items-center gap-1 rounded-sm py-1 pr-1 transition duration-[220ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass${
          isIgnored ? " opacity-60" : ""
        }`}
        style={{
          paddingLeft: `${depth * 14 + 4}px`,
          background: "transparent",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background = "var(--brass-ghost)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
        onClick={activate}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate();
            return;
          }
          // Keyboard route to the context menu (WAI-ARIA: Shift+F10 / Menu key).
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            e.preventDefault();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onShowMenuAt(r.left + 8, r.bottom, path, label, isDir);
            return;
          }
          if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) {
            return;
          }
          e.preventDefault();
          // Document order of treeitem rows = visual order of the tree.
          const rows = Array.from(
            (e.currentTarget.closest('[role="tree"]') as HTMLElement | null)
              ?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
          );
          const idx = rows.indexOf(e.currentTarget as HTMLElement);
          switch (e.key) {
            case "ArrowDown":
              rows[idx + 1]?.focus();
              break;
            case "ArrowUp":
              rows[idx - 1]?.focus();
              break;
            case "ArrowRight":
              if (!isDir) break;
              if (!isExpanded) onToggle(path);
              else rows[idx + 1]?.focus(); // first child in document order
              break;
            case "ArrowLeft":
              if (isDir && isExpanded) {
                onToggle(path);
                break;
              }
              // Focus the parent: first preceding row with a smaller depth.
              for (let i = idx - 1; i >= 0; i--) {
                if (Number(rows[i].dataset.depth) < depth) {
                  rows[i].focus();
                  break;
                }
              }
              break;
            case "Home":
              rows[0]?.focus();
              break;
            case "End":
              rows[rows.length - 1]?.focus();
              break;
          }
        }}
        onContextMenu={(e) => onRowContextMenu(e, path, label, isDir)}
        data-testid={!isDir ? `file-row-${path}` : undefined}
      >
        {/* Indent guides — one 1px hairline per depth level */}
        {depth > 0 && (
          <IndentGuides depth={depth} />
        )}

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
          <span
            className="min-w-0 truncate font-serif text-[13px] text-octo-ivory"
          >
            {label}
          </span>
        ) : (
          <span
            className={`min-w-0 truncate font-mono text-[11px] ${depthColorClass(depth, isChanged)}`}
          >
            {label}
          </span>
        )}
      </div>

      {/* Children (only if dir + expanded) */}
      {isDir && isExpanded && (
        <div role="group">
          {(() => {
            const state = children[path];
            if (!state || state === "loading") {
              return (
                <div
                  className="py-[2px] font-serif text-[11px] text-octo-mute"
                  style={{ paddingLeft: `${(depth + 1) * 14 + 4}px` }}
                >
                  loading…
                </div>
              );
            }
            if (state === "error") {
              return (
                <div
                  className="py-[2px] font-serif text-[11px] text-octo-rouge"
                  style={{ paddingLeft: `${(depth + 1) * 14 + 4}px` }}
                >
                  error reading directory.
                </div>
              );
            }
            if (state.length === 0) {
              return (
                <div
                  className="py-[2px] font-serif text-[11px] text-octo-mute"
                  style={{ paddingLeft: `${(depth + 1) * 14 + 4}px` }}
                >
                  empty.
                </div>
              );
            }
            return state.map((entry) => (
              <TreeNode
                key={entry.path}
                path={entry.path}
                label={entry.name}
                isDir={entry.isDir}
                isIgnored={entry.isIgnored || isIgnored}
                depth={depth + 1}
                isRoot={false}
                expanded={expanded}
                children={children}
                changedPaths={changedPaths}
                focusedPath={focusedPath}
                onToggle={onToggle}
                onFileClick={onFileClick}
                onRowContextMenu={onRowContextMenu}
                onRowFocus={onRowFocus}
                onShowMenuAt={onShowMenuAt}
              />
            ));
          })()}
        </div>
      )}
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
