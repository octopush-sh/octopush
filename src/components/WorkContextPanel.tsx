import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import { useIssuesStore } from "../stores/issuesStore";
import { useParentIssuesStore } from "../stores/parentIssuesStore";
import { useActiveIssue } from "../hooks/useActiveIssue";
import { ipc } from "../lib/ipc";
import type { Issue, LinkedIssueRef, StatusCategory } from "../lib/types";
import {
  selectBacklog,
  selectBlocking,
  selectBlockedBy,
  selectSubtasksOrSiblings,
  selectEpicSiblings,
  resolveEpicKey,
  issueTypeToken,
} from "../lib/issueTrackerSelectors";

const STATUS_DOT_COLOR: Record<StatusCategory, string> = {
  todo: "text-octo-mute",
  inProgress: "text-state-blue",
  done: "text-octo-verdigris",
  unknown: "text-octo-sage",
};

type PillKey = "mine" | "subtasks" | "blocking" | "blockedBy" | "epic";

interface PillSpec {
  key: PillKey;
  label: string;
  count: number;
  rows: Array<Issue | LinkedIssueRef>;
}

interface Props {
  configured: boolean;
  /** Caller guarantees this is non-null when Companion renders the panel. */
  projectKey?: string | null;
  /** Active ticket key — drives detail fetch + epic resolution + exclude-self. */
  activeKey: string | null;
  onTicketContextMenu?: (issue: Issue, x: number, y: number) => void;
}

export function WorkContextPanel({
  configured,
  projectKey = null,
  activeKey,
  onTicketContextMenu,
}: Props) {
  const issues = useIssuesStore((s) => s.issues);
  const loading = useIssuesStore((s) => s.loading);
  const error = useIssuesStore((s) => s.error);
  const load = useIssuesStore((s) => s.load);
  const epicIssuesByKey = useIssuesStore((s) => s.epicIssuesByKey);
  const epicLoadingByKey = useIssuesStore((s) => s.epicLoadingByKey);
  const loadEpic = useIssuesStore((s) => s.loadEpic);

  const parents = useParentIssuesStore((s) => s.parents);
  const loadAncestors = useParentIssuesStore((s) => s.loadAncestors);

  const activeIssue = useActiveIssue(activeKey);

  // For sub-task active tickets we need the parent loaded to surface
  // siblings; for the epic pill we may need to walk up two levels.
  useEffect(() => {
    if (!activeIssue?.parentKey) return;
    void loadAncestors(activeIssue.parentKey, activeIssue.subtask ? 2 : 1);
  }, [activeIssue?.parentKey, activeIssue?.subtask, loadAncestors]);

  const [activePill, setActivePill] = useState<PillKey>("mine");
  const [collapsed, setCollapsed] = useState(false);

  // Initial my-issues load.
  useEffect(() => {
    if (configured) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured]);

  const epicKey = useMemo(
    () => resolveEpicKey(activeIssue, parents),
    [activeIssue, parents],
  );

  // Lazy-load the epic's open tickets the first time the Epic pill is
  // selected — keeps the initial render cheap and avoids paying for a
  // request the user may never look at.
  useEffect(() => {
    if (activePill === "epic" && epicKey) void loadEpic(epicKey);
  }, [activePill, epicKey, loadEpic]);

  const mineList     = useMemo(() => selectBacklog(issues ?? [], projectKey, activeKey), [issues, projectKey, activeKey]);
  const blockingList = useMemo(() => selectBlocking(activeIssue),                          [activeIssue]);
  const blockedList  = useMemo(() => selectBlockedBy(activeIssue),                         [activeIssue]);
  const subtaskList  = useMemo(() => selectSubtasksOrSiblings(activeIssue, parents),       [activeIssue, parents]);
  const epicList     = useMemo(() => selectEpicSiblings(epicKey ? epicIssuesByKey[epicKey] : undefined, activeKey), [epicKey, epicIssuesByKey, activeKey]);

  const subtaskLabel = activeIssue?.subtask ? "Siblings" : "Subtasks";

  // Build the pill nav, then hide ones with no rows (Mine stays even
  // empty so the panel always has somewhere to land).
  const allPills: PillSpec[] = [
    { key: "mine",      label: "Mine",        count: mineList.length,     rows: mineList },
    { key: "subtasks",  label: subtaskLabel,  count: subtaskList.length,  rows: subtaskList },
    { key: "blocking",  label: "Blocking",    count: blockingList.length, rows: blockingList },
    { key: "blockedBy", label: "Blocked by",  count: blockedList.length,  rows: blockedList },
    { key: "epic",      label: "Epic",        count: epicList.length,     rows: epicList },
  ];
  const visiblePills = allPills.filter((p) => p.key === "mine" || p.count > 0);

  // If the previously-active pill just disappeared (e.g., a workspace
  // switch wiped its data), drop back to Mine so the body isn't empty.
  useEffect(() => {
    if (!visiblePills.some((p) => p.key === activePill)) setActivePill("mine");
  }, [visiblePills, activePill]);

  const activeRows = allPills.find((p) => p.key === activePill)?.rows ?? [];
  const isLoadingActive =
    activePill === "mine"
      ? loading
      : activePill === "epic" && epicKey
        ? !!epicLoadingByKey[epicKey]
        : false;
  const refreshable = activePill === "mine" || activePill === "epic";

  function handleRefresh() {
    if (activePill === "mine") void load();
    else if (activePill === "epic" && epicKey) void loadEpic(epicKey);
  }

  // ── Gliding indicator for the pill nav ────────────────────────
  // Measure the active pill's bounding box relative to its container
  // and translate the brass-ghost rect underneath. Same motion family
  // as the ModeSwitcher (280ms / ease) so the two tab strips read as
  // siblings.
  const navRef = useRef<HTMLDivElement | null>(null);
  const pillRefs = useRef<Map<PillKey, HTMLButtonElement | null>>(new Map());
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const pill = pillRefs.current.get(activePill);
    if (!nav || !pill) {
      setIndicator(null);
      return;
    }
    const navRect = nav.getBoundingClientRect();
    const pillRect = pill.getBoundingClientRect();
    setIndicator({
      left: pillRect.left - navRect.left + nav.scrollLeft,
      width: pillRect.width,
    });
  }, [activePill, visiblePills.length, visiblePills.map((p) => `${p.key}:${p.count}`).join("|")]);

  return (
    <div className="border-b border-octo-hairline px-3 py-2">
      {/* ── Pill nav + refresh + chevron ─────────────────────────── */}
      <div className="flex items-center gap-1">
        <div
          ref={navRef}
          role="tablist"
          aria-label="Work context"
          className="relative flex flex-1 items-center overflow-x-auto py-0.5"
        >
          {/* Gliding indicator. Hidden until the first measurement so it
              never paints at the wrong (left=0) spot. */}
          {indicator && (
            <div
              aria-hidden
              className="absolute top-0 bottom-0 rounded-full border border-[var(--brass-dim)] bg-[var(--brass-ghost)] transition-[left,width] duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.3,1)]"
              style={{ left: indicator.left, width: indicator.width }}
            />
          )}
          {visiblePills.map((p) => {
            const active = p.key === activePill;
            return (
              <button
                key={p.key}
                ref={(el) => { pillRefs.current.set(p.key, el); }}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActivePill(p.key)}
                className={`relative z-10 flex flex-shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] transition-colors duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.3,1)] ${
                  active
                    ? "text-octo-brass"
                    : "text-octo-mute hover:text-octo-sage"
                }`}
              >
                {p.label}
                <span className="border-l border-current pl-1.5 text-[9px] opacity-70">
                  {p.count}
                </span>
              </button>
            );
          })}
        </div>
        {refreshable && configured && (
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isLoadingActive}
            title={isLoadingActive ? "Refreshing…" : "Refresh"}
            aria-label={isLoadingActive ? "Refreshing" : "Refresh"}
            aria-busy={isLoadingActive}
            className="flex flex-shrink-0 items-center justify-center rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-octo-brass"
          >
            <RotateCcw size={16} className={isLoadingActive ? "animate-spin" : ""} />
          </button>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand work context" : "Collapse work context"}
          title={collapsed ? "Expand work context" : "Collapse work context"}
          className="flex flex-shrink-0 items-center justify-center rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass"
        >
          <ChevronDown
            size={16}
            className={`transition-transform duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.3,1)] ${collapsed ? "-rotate-90" : ""}`}
          />
        </button>
      </div>

      {/* ── Body, with grid-rows expand/collapse ─────────────────── */}
      <div
        aria-hidden={collapsed}
        className="grid overflow-hidden transition-all duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.3,1)]"
        style={{
          gridTemplateRows: collapsed ? "0fr" : "1fr",
          opacity: collapsed ? 0 : 1,
        }}
      >
        <div className="min-h-0">
          {!configured && (
            <p className="mt-2 text-[12px] text-octo-mute">Connect Jira in Settings →</p>
          )}
          {configured && projectKey != null && (
            <>
              {activePill === "mine" && error && (
                <p className="mt-1 font-mono text-[10px] tracking-[0.1em] text-octo-mute">
                  couldn't refresh
                </p>
              )}
              {isLoadingActive && activeRows.length === 0 && (
                <p className="mt-2 font-mono text-[10px] text-octo-mute">loading…</p>
              )}
              {!isLoadingActive && activeRows.length === 0 && (
                <p className="mt-2 text-[12px] text-octo-mute">{emptyCopy(activePill, subtaskLabel)}</p>
              )}
              <div className="mt-1">
                {activeRows.map((row) => (
                  <TicketRow
                    key={row.key}
                    row={row}
                    onContextMenu={
                      onTicketContextMenu && isFullIssue(row)
                        ? (x, y) => onTicketContextMenu(row, x, y)
                        : undefined
                    }
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function isFullIssue(row: Issue | LinkedIssueRef): row is Issue {
  return "priority" in row;
}

function emptyCopy(pill: PillKey, subtaskLabel: string): string {
  switch (pill) {
    case "mine":      return "Backlog clear ✓";
    case "subtasks":  return subtaskLabel === "Siblings" ? "No sibling sub-tasks." : "No sub-tasks.";
    case "blocking":  return "Nothing is waiting on this ticket.";
    case "blockedBy": return "Nothing is blocking this ticket.";
    case "epic":      return "Epic backlog is clear ✓";
  }
}

interface RowProps {
  row: Issue | LinkedIssueRef;
  onContextMenu?: (x: number, y: number) => void;
}

function TicketRow({ row, onContextMenu }: RowProps) {
  return (
    <button
      type="button"
      role="button"
      onClick={() => ipc.openFileInSystem(row.url).catch(() => {})}
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault();
              onContextMenu(e.clientX, e.clientY);
            }
          : undefined
      }
      className="flex w-full items-center gap-2 rounded px-1 py-[5px] text-left transition-colors duration-[220ms] ease-[cubic-bezier(0.2,0.8,0.3,1)] hover:bg-octo-panel-2"
      style={{ borderLeft: "1px solid transparent" }}
    >
      <span
        aria-label={row.statusCategory}
        className={`h-[6px] w-[6px] flex-shrink-0 rounded-full ${STATUS_DOT_COLOR[row.statusCategory]}`}
        style={{ background: "currentColor" }}
      />
      <span className={`flex-shrink-0 font-mono text-[11px] ${issueTypeToken(row)}`}>
        {row.key}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-octo-sage">{row.summary}</span>
      <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-octo-mute">
        {row.statusName}
      </span>
    </button>
  );
}
