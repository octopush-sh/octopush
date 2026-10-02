/**
 * ReviewSidebar — the left navigator for Review mode.
 *
 * Unifies the two "what's in this workspace" surfaces that used to live apart
 * (Changes on the left, Files in the right companion) behind one Changes|Files
 * toggle, and — like the workspace rail — collapses to a slim icon strip when
 * the user wants the canvas to themselves. The active panel keeps its own
 * eyebrow actions; the tab switcher + collapse control are injected into that
 * eyebrow via `headerLeading`, so there's a single top bar, never two.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { PanelLeftClose, PanelLeftOpen, FileDiff, FolderTree } from "lucide-react";
import { ChangesPanel } from "./ChangesPanel";
import { CompanionFileTree } from "./CompanionFileTree";
import { NO_LOCATE } from "../lib/locate";
import { FadeSwap } from "./primitives/FadeSwap";

type Tab = "changes" | "files";

const COLLAPSE_KEY = "reviewSidebarCollapsed";
const TAB_KEY = "reviewSidebarTab";
const WIDTH_KEY = "reviewSidebarWidth";

/** Drag-resize bounds for the expanded sidebar. Deep trees (Java packages,
 *  monorepos) need room; the canvas still keeps the majority of the window. */
export const SIDEBAR_DEFAULT_WIDTH = 280;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 640;
/** The canvas always keeps at least this much room, whatever the stored
 *  width — a wide sidebar on a narrow window must not crush the diff. */
const MIN_CANVAS_WIDTH = 360;

function clampWidth(w: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, w));
}

function readStoredWidth(): number {
  try {
    const parsed = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(parsed) && parsed > 0 ? clampWidth(parsed) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

interface FileTreeProps {
  rootPath: string;
  rootLabel: string;
  changedPaths: Set<string>;
  onFileClick?: (absPath: string) => void;
  /** The file open in the editor — marked in the tree wherever it's visible. */
  activePath?: string | null;
  /** Receives the tree's `locate(absPath)` so the editor breadcrumb can point
   *  the tree at the open file on demand. */
  registerLocate?: (fn: (absPath: string) => void) => void;
}

interface Props {
  /** Drives the default tab and the collapsed-strip badge. */
  changedCount: number;
  // ── Changes panel ──
  projectPath: string;
  workspaceId?: string;
  diff?: string;
  onChangesFileClick?: (filePath: string) => void;
  onChangesChange?: () => void;
  registerFocusCommit?: (fn: () => void) => void;
  // ── File tree ──
  fileTree: FileTreeProps;
}

function readStoredTab(): Tab | null {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return v === "changes" || v === "files" ? v : null;
  } catch {
    return null;
  }
}

export function ReviewSidebar({
  changedCount,
  projectPath,
  workspaceId,
  diff,
  onChangesFileClick,
  onChangesChange,
  registerFocusCommit,
  fileTree,
}: Props) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  // Stored preference wins; otherwise open on Changes when there's work to
  // review, else Files (a fresh workspace with nothing changed yet).
  const [tab, setTabState] = useState<Tab>(
    () => readStoredTab() ?? (changedCount > 0 ? "changes" : "files"),
  );

  const setTab = useCallback((next: Tab) => {
    setTabState(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      /* storage unavailable — keep the in-memory value */
    }
  }, []);

  const setCollapsedPersist = useCallback((next: boolean) => {
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
    } catch {
      /* storage unavailable — keep the in-memory value */
    }
  }, []);

  // ── Width (drag the right edge; double-click resets) ────────────
  const [width, setWidth] = useState<number>(readStoredWidth);
  const [resizing, setResizing] = useState(false);
  // Tears down an in-flight drag. Held in a ref so an unmount mid-drag (a
  // mode switch via shortcut, a workspace change) can't leak window
  // listeners or leave the body stuck in col-resize / no-select.
  const endDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => endDragRef.current?.(), []);

  const persistWidth = useCallback((next: number) => {
    try {
      localStorage.setItem(WIDTH_KEY, String(next));
    } catch {
      /* storage unavailable — keep the in-memory value */
    }
  }, []);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      let latest = startWidth;
      setResizing(true);
      const onMove = (ev: MouseEvent) => {
        // The sidebar sits on the left; moving the cursor RIGHT widens it.
        latest = clampWidth(startWidth + ev.clientX - startX);
        setWidth(latest);
      };
      const teardown = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        endDragRef.current = null;
      };
      const onUp = () => {
        teardown();
        setResizing(false);
        persistWidth(latest);
      };
      endDragRef.current = teardown;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [width, persistWidth],
  );

  const resetWidth = useCallback(() => {
    setWidth(SIDEBAR_DEFAULT_WIDTH);
    persistWidth(SIDEBAR_DEFAULT_WIDTH);
  }, [persistWidth]);

  const onResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 64 : 16;
      let next: number | null = null;
      if (e.key === "ArrowLeft") next = clampWidth(width - step);
      else if (e.key === "ArrowRight") next = clampWidth(width + step);
      else if (e.key === "Home") next = SIDEBAR_MIN_WIDTH;
      else if (e.key === "End") next = SIDEBAR_MAX_WIDTH;
      if (next === null) return;
      e.preventDefault();
      setWidth(next);
      persistWidth(next);
    },
    [width, persistWidth],
  );

  // ── Focus-commit orchestration (the `c` shortcut) ───────────────
  // ChangesPanel is now only mounted on the Changes tab, so the shortcut must
  // first reveal it (switch tab + expand), then focus the commit box once the
  // panel has (re)mounted and handed us its focuser.
  const childFocusRef = useRef<(() => void) | null>(null);
  const pendingFocusRef = useRef(false);

  const handleChildFocusRegister = useCallback((fn: () => void) => {
    childFocusRef.current = fn;
    if (pendingFocusRef.current) {
      pendingFocusRef.current = false;
      fn();
    }
  }, []);

  useEffect(() => {
    registerFocusCommit?.(() => {
      // ChangesPanel mounted & visible → focus immediately; childFocusRef is
      // only read in this branch, so it's always the live (non-stale) focuser.
      if (tab === "changes" && !collapsed && childFocusRef.current) {
        childFocusRef.current();
      } else {
        pendingFocusRef.current = true;
        setTab("changes");
        setCollapsedPersist(false);
      }
    });
  }, [registerFocusCommit, tab, collapsed, setTab, setCollapsedPersist]);

  // ── Locate orchestration (the ⌖ Reveal / ⌘⇧E path) ──────────────
  // Same problem as the commit shortcut above, same shape: the tree is only
  // mounted on the Files tab, and Review defaults to Changes whenever the
  // workspace has changes — i.e. exactly when a reviewer asks "where is this
  // file". So reveal has to open the tab (and expand the sidebar) first, then
  // replay the request once the tree mounts and hands us its `locate`.
  const treeLocateRef = useRef<((absPath: string) => void) | null>(null);
  const pendingLocateRef = useRef<string | null>(null);

  const handleTreeLocateRegister = useCallback((fn: (absPath: string) => void) => {
    // An unmounting tree registers the NO_LOCATE sentinel; it must neither
    // become the live locate nor consume a pending reveal, which belongs to
    // the tree that mounts next.
    if (fn === NO_LOCATE) {
      treeLocateRef.current = null;
      return;
    }
    treeLocateRef.current = fn;
    const pending = pendingLocateRef.current;
    if (pending) {
      pendingLocateRef.current = null;
      fn(pending);
    }
  }, []);

  useEffect(() => {
    fileTree.registerLocate?.((absPath: string) => {
      if (tab === "files" && !collapsed && treeLocateRef.current) {
        treeLocateRef.current(absPath);
      } else {
        pendingLocateRef.current = absPath;
        setTab("files");
        setCollapsedPersist(false);
      }
    });
    // `fileTree` is rebuilt each render by the parent's useMemo; only its
    // registrar identity matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileTree.registerLocate, tab, collapsed, setTab, setCollapsedPersist]);

  // ── Collapsed strip — slim icons, mirrors the workspace rail ────
  if (collapsed) {
    return (
      <div className="flex w-[44px] shrink-0 flex-col items-center gap-1 border-r border-octo-hairline bg-octo-panel py-2 transition-all duration-[220ms]">
        <button
          type="button"
          onClick={() => setCollapsedPersist(false)}
          aria-label="Expand changes & files"
          title="Expand changes & files"
          className="flex h-7 w-7 items-center justify-center rounded text-octo-mute transition-colors hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          <PanelLeftOpen size={16} />
        </button>
        <div className="mt-1 h-px w-5 bg-octo-hairline" aria-hidden />
        <StripButton
          active={tab === "changes"}
          onClick={() => { setTab("changes"); setCollapsedPersist(false); }}
          label="Changes"
          badge={changedCount > 0 ? changedCount : undefined}
        >
          <FileDiff size={15} />
        </StripButton>
        <StripButton
          active={tab === "files"}
          onClick={() => { setTab("files"); setCollapsedPersist(false); }}
          label="Files"
        >
          <FolderTree size={15} />
        </StripButton>
      </div>
    );
  }

  // ── Expanded — tab switcher + collapse injected into the panel eyebrow ──
  const headerLeading = (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setCollapsedPersist(true)}
        aria-label="Collapse changes & files"
        title="Collapse changes & files"
        className="flex h-6 w-6 items-center justify-center rounded text-octo-mute transition-colors hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
      >
        <PanelLeftClose size={14} />
      </button>
      <div className="flex items-center overflow-hidden rounded-md border border-octo-hairline">
        <TabButton active={tab === "changes"} onClick={() => setTab("changes")} badge={changedCount > 0 ? changedCount : undefined}>
          <FileDiff size={12} />
          Changes
        </TabButton>
        <TabButton active={tab === "files"} onClick={() => setTab("files")} borderLeft>
          <FolderTree size={12} />
          Files
        </TabButton>
      </div>
    </div>
  );

  return (
    <div
      className={`relative flex shrink-0 flex-col border-r border-octo-hairline ${
        // Animate collapse/expand, never the live drag — a transition on
        // width would make the edge lag behind the cursor.
        resizing ? "" : "transition-all duration-[220ms]"
      }`}
      style={{ width, maxWidth: `calc(100% - ${MIN_CANVAS_WIDTH}px)` }}
      data-testid="review-sidebar"
    >
      {/* Resize handle on the right edge — the mirror of the Companion's. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize changes & files"
        aria-valuenow={width}
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        tabIndex={0}
        title="Drag to resize · Double-click to reset"
        onMouseDown={startResize}
        onDoubleClick={resetWidth}
        onKeyDown={onResizeKeyDown}
        className={`absolute -right-[2px] top-0 bottom-0 z-10 w-[4px] cursor-col-resize transition-colors hover:bg-octo-brass focus-visible:bg-octo-brass focus-visible:outline-none ${
          resizing ? "bg-octo-brass" : "bg-transparent"
        }`}
      />
      <FadeSwap swapKey={tab} className="flex min-h-0 flex-1 flex-col">
        {tab === "changes" ? (
          <ChangesPanel
            projectPath={projectPath}
            workspaceId={workspaceId}
            diff={diff}
            onFileClick={onChangesFileClick}
            onChange={onChangesChange}
            registerFocusCommit={handleChildFocusRegister}
            headerLeading={headerLeading}
          />
        ) : (
          <CompanionFileTree
            rootPath={fileTree.rootPath}
            rootLabel={fileTree.rootLabel}
            changedPaths={fileTree.changedPaths}
            onFileClick={fileTree.onFileClick}
            activePath={fileTree.activePath}
            registerLocate={handleTreeLocateRegister}
            headerLeading={headerLeading}
          />
        )}
      </FadeSwap>
    </div>
  );
}

// ─── Controls ─────────────────────────────────────────────────────

function TabButton({
  children,
  active,
  onClick,
  borderLeft,
  badge,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  borderLeft?: boolean;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1 whitespace-nowrap px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass ${
        borderLeft ? "border-l border-octo-hairline " : ""
      }${active ? "text-octo-brass" : "text-octo-mute hover:text-octo-sage"}`}
      style={active ? { background: "var(--brass-ghost)" } : undefined}
    >
      {children}
      {badge != null && (
        <span className="rounded-full bg-[var(--brass-ghost)] px-1 text-[9px] tabular-nums text-octo-brass">
          {badge}
        </span>
      )}
    </button>
  );
}

function StripButton({
  children,
  active,
  onClick,
  label,
  badge,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  label: string;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={`relative flex h-7 w-7 items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass ${
        active ? "text-octo-brass" : "border-transparent text-octo-mute hover:text-octo-sage"
      }`}
      style={active ? { background: "var(--brass-ghost)", borderColor: "var(--brass-dim)" } : undefined}
    >
      {children}
      {badge != null && (
        <span className="absolute -right-0.5 -top-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-octo-brass px-0.5 font-mono text-[8px] tabular-nums text-octo-onyx">
          {badge}
        </span>
      )}
    </button>
  );
}
