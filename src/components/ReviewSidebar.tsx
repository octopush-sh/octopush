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
import { FadeSwap } from "./primitives/FadeSwap";

type Tab = "changes" | "files";

const COLLAPSE_KEY = "reviewSidebarCollapsed";
const TAB_KEY = "reviewSidebarTab";

interface FileTreeProps {
  rootPath: string;
  rootLabel: string;
  changedPaths: Set<string>;
  onFileClick?: (absPath: string) => void;
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
    <div className="flex w-[280px] shrink-0 flex-col border-r border-octo-hairline transition-all duration-[220ms]">
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
