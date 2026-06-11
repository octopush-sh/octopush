import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, GitBranch, RotateCcw } from "lucide-react";
import { useIssuesStore } from "../stores/issuesStore";
import { useParentIssuesStore } from "../stores/parentIssuesStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useCompanionPrefs } from "../stores/companionPrefsStore";
import { useActiveIssue } from "../hooks/useActiveIssue";
import { ipc } from "../lib/ipc";
import type { Issue, LinkedIssueRef, StatusCategory, Workspace } from "../lib/types";
import { detectIssueKey } from "../lib/detectIssueKey";
import { TINTS } from "../lib/monogram";
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
  /** Project id — keys the persisted collapse preference. Without it the
   *  collapse state is session-local. */
  projectId?: string | null;
  /** Fallback collapse state when the user hasn't toggled this project yet
   *  (Companion passes mode !== "talk": expanded in Talk, tucked elsewhere). */
  defaultCollapsed?: boolean;
  /** Active ticket key — drives detail fetch + epic resolution + exclude-self. */
  activeKey: string | null;
  onTicketContextMenu?: (issue: Issue, x: number, y: number) => void;
}

export function WorkContextPanel({
  configured,
  projectKey = null,
  projectId = null,
  defaultCollapsed = false,
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

  // Workspaces of the current project, so each row can flag tickets that
  // already have a workspace and offer a one-click jump to it.
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const selectWorkspace = useWorkspaceStore((s) => s.select);

  // issueKey → workspace. A ticket is "claimed" by a workspace via an explicit
  // link (linkedIssueKey) or a branch whose name encodes the key — the same
  // pairing App.tsx uses when linking. First match wins.
  const workspaceByIssueKey = useMemo(() => {
    const map = new Map<string, Workspace>();
    for (const ws of workspaces) {
      const key = ws.linkedIssueKey ?? detectIssueKey(ws.branch ?? "");
      if (key && !map.has(key)) map.set(key, ws);
    }
    return map;
  }, [workspaces]);

  const activeIssue = useActiveIssue(activeKey);

  // For sub-task active tickets we need the parent loaded to surface
  // siblings; for the epic pill we may need to walk up two levels.
  useEffect(() => {
    if (!activeIssue?.parentKey) return;
    void loadAncestors(activeIssue.parentKey, activeIssue.subtask ? 2 : 1);
  }, [activeIssue?.parentKey, activeIssue?.subtask, loadAncestors]);

  const [activePill, setActivePill] = useState<PillKey>("mine");

  // Collapse: a user toggle persists per project (companionPrefsStore);
  // until then we follow the mode-aware default from the caller. Without a
  // project id (shouldn't happen from Companion) the override is local.
  const storedCollapsed = useCompanionPrefs((s) =>
    projectId != null ? s.workContextCollapsed[projectId] : undefined,
  );
  const setWorkContextCollapsed = useCompanionPrefs((s) => s.setWorkContextCollapsed);
  const [localCollapsed, setLocalCollapsed] = useState<boolean | null>(null);
  const collapsed =
    (projectId != null ? storedCollapsed : localCollapsed) ?? defaultCollapsed;
  function toggleCollapsed() {
    if (projectId != null) setWorkContextCollapsed(projectId, !collapsed);
    else setLocalCollapsed(!collapsed);
  }

  // Initial my-issues load.
  useEffect(() => {
    if (configured) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured]);

  const epicKey = useMemo(
    () => resolveEpicKey(activeIssue, parents),
    [activeIssue, parents],
  );

  // Load the epic's open tickets as soon as we can resolve the active
  // ticket's epic. We can't lazy-load on pill-select like the other tabs:
  // the Epic pill is hidden until its count is > 0, so without the data it
  // would never become clickable (chicken-and-egg). loadEpic is idempotent
  // and guards against duplicate requests.
  useEffect(() => {
    if (epicKey) void loadEpic(epicKey);
  }, [epicKey, loadEpic]);

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
  // Mine always shows. Epic shows whenever the active ticket has a resolvable
  // epic — even with 0 siblings loaded yet — so it's visible while its tickets
  // fetch; it only stays hidden once we know the epic has no other tickets.
  // Every other pill shows only when it has rows.
  const visiblePills = allPills.filter((p) => {
    if (p.key === "mine") return true;
    if (p.key === "epic") return !!epicKey && (p.count > 0 || !!epicLoadingByKey[epicKey]);
    return p.count > 0;
  });

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
          // The static right-edge fade hints that the strip scrolls when
          // pills overflow; on short strips it only grazes trailing padding.
          className="relative flex flex-1 items-center overflow-x-auto py-0.5 [mask-image:linear-gradient(to_right,black_85%,transparent)]"
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
                <span className="text-[9px] opacity-60">{p.count}</span>
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
          onClick={toggleCollapsed}
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
        // `inert` takes the clipped rows out of the tab order while collapsed
        // (aria-hidden alone leaves them keyboard-focusable).
        inert={collapsed || undefined}
        className="grid overflow-hidden transition-[grid-template-rows,opacity] duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.3,1)]"
        style={{
          // grid-cols forces the column to track the container width
          // exactly. Without it, the implicit `minmax(auto, 1fr)` column
          // sizes to the row's min-content (dot + key + status = ~180px
          // of flex-shrink-0 children), and on narrow companion widths
          // that overflows the panel — the status badge ends up clipped
          // off the right edge.
          gridTemplateColumns: "minmax(0, 1fr)",
          gridTemplateRows: collapsed ? "0fr" : "1fr",
          opacity: collapsed ? 0 : 1,
        }}
      >
        <div className="min-h-0 min-w-0">
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
                    workspace={workspaceByIssueKey.get(row.key)}
                    onJump={selectWorkspace}
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
  /** The workspace that already owns this ticket, if any — surfaces the jump chip. */
  workspace?: Workspace;
  onJump?: (workspaceId: string) => void;
  onContextMenu?: (x: number, y: number) => void;
}

const TicketRow = memo(function TicketRow({ row, workspace, onJump, onContextMenu }: RowProps) {
  const openTicket = () => ipc.openFileInSystem(row.url).catch(() => {});
  return (
    // Plain group container: the main content is a real <button> (open in
    // Jira) and the jump chip is a SIBLING <button> — no nested interactives.
    // Hover/border styling stays here so both buttons share one surface.
    <div
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault();
              onContextMenu(e.clientX, e.clientY);
            }
          : undefined
      }
      title={`${row.key} · ${row.summary}`}
      className="group flex w-full items-center gap-2 rounded px-1 py-[5px] transition-colors duration-[220ms] ease-[cubic-bezier(0.2,0.8,0.3,1)] hover:bg-octo-panel-2"
    >
      <button
        type="button"
        onClick={openTicket}
        aria-label={`Open ${row.key} · ${row.summary}`}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
      >
        <span
          aria-label={row.statusCategory}
          className={`h-[6px] w-[6px] flex-shrink-0 rounded-full ${STATUS_DOT_COLOR[row.statusCategory]}`}
          style={{ background: "currentColor" }}
        />
        <span className={`flex-shrink-0 font-mono text-[11px] ${issueTypeToken(row)}`}>
          {row.key}
        </span>
        {/* Summary's last ~24px fade out via mask-image so the text appears
            to dissolve into the status pill instead of getting cut with an
            ellipsis — the status itself stays pinned on the right (see
            flex-shrink-0 below) and is always legible. */}
        <span
          className="min-w-0 flex-1 text-[12px] text-octo-sage"
          style={{
            whiteSpace: "nowrap",
            overflow: "hidden",
            maskImage: "linear-gradient(to right, black calc(100% - 24px), transparent)",
            WebkitMaskImage: "linear-gradient(to right, black calc(100% - 24px), transparent)",
          }}
        >
          {row.summary}
        </span>
        {/* On rows that carry a jump chip, the status badge yields to the
            expanding chip on hover/keyboard focus so the summary keeps its
            room. */}
        <span
          className={`flex-shrink-0 font-mono text-[9px] uppercase tracking-[0.1em] text-octo-mute ${
            workspace && onJump ? "group-hover:hidden group-focus-within:hidden" : ""
          }`}
        >
          {row.statusName}
        </span>
      </button>
      {workspace && onJump && <WorkspaceJumpChip workspace={workspace} onJump={onJump} />}
    </div>
  );
});

/** Marker on rows whose ticket already has a workspace. At rest it's a quiet
 *  dot in the workspace's tint colour; on row hover it grows into a pill with
 *  the workspace name. Clicking jumps to that workspace (stops the row's
 *  open-in-Jira click). Combination of design proposals I (named chip) and
 *  IV (workspace-tint identity). */
function WorkspaceJumpChip({
  workspace,
  onJump,
}: {
  workspace: Workspace;
  onJump: (workspaceId: string) => void;
}) {
  const tint = workspace.tint ?? "brass";
  const accent = TINTS[tint].accent;
  return (
    <button
      type="button"
      title={`Jump to workspace · ${workspace.name}`}
      aria-label={`Jump to workspace ${workspace.name}`}
      onClick={(e) => {
        e.stopPropagation();
        onJump(workspace.id);
      }}
      // Expands on row hover AND keyboard focus within the row (the chip's
      // own focus-visible included), so it isn't a mouse-only affordance.
      className="flex h-[14px] w-[14px] flex-shrink-0 items-center justify-center overflow-hidden rounded-full border border-transparent p-0 transition-[width,padding,background-color,border-color,filter] duration-[200ms] ease-[cubic-bezier(0.2,0.8,0.3,1)] hover:brightness-110 group-hover:w-auto group-hover:justify-start group-hover:border-[color:var(--tint-bd)] group-hover:bg-[color:var(--tint-bg)] group-hover:px-[7px] group-hover:py-[2px] group-focus-within:w-auto group-focus-within:justify-start group-focus-within:border-[color:var(--tint-bd)] group-focus-within:bg-[color:var(--tint-bg)] group-focus-within:px-[7px] group-focus-within:py-[2px] focus-visible:w-auto focus-visible:justify-start focus-visible:border-[color:var(--tint-bd)] focus-visible:bg-[color:var(--tint-bg)] focus-visible:px-[7px] focus-visible:py-[2px]"
      style={
        {
          color: accent,
          // Expanded surface uses the tint at low alpha (same identity colour
          // shown in the rail). Driven via CSS vars so the group-hover Tailwind
          // utilities below can reference them.
          "--tint-bg": hexToRgba(accent, 0.16),
          "--tint-bd": hexToRgba(accent, 0.42),
        } as CSSProperties
      }
    >
      <span
        className="h-[6px] w-[6px] flex-shrink-0 rounded-full"
        style={{ background: accent }}
      />
      <GitBranch
        size={11}
        className="ml-0 w-0 opacity-0 transition-[margin-left,width,opacity] duration-[200ms] group-hover:ml-[5px] group-hover:w-[11px] group-hover:opacity-100 group-focus-within:ml-[5px] group-focus-within:w-[11px] group-focus-within:opacity-100"
      />
      <span className="ml-0 max-w-0 overflow-hidden truncate font-mono text-[10px] leading-none opacity-0 transition-[margin-left,max-width,opacity] duration-[200ms] group-hover:ml-[5px] group-hover:max-w-[120px] group-hover:opacity-100 group-focus-within:ml-[5px] group-focus-within:max-w-[120px] group-focus-within:opacity-100">
        {workspace.name}
      </span>
    </button>
  );
}

/** `#rrggbb` → `rgba(r, g, b, a)`. Tints come from the monogram palette as
 *  hex; the jump chip needs alpha variants for its hover surface. */
function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
