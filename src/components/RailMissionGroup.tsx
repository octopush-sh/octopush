import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, GitPullRequest, Plus } from "lucide-react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { TINTS } from "../lib/monogram";
import { tourId } from "../lib/tour/ids";
import type { Group } from "../lib/types";
import type { RailDragSubject, RailDropTarget } from "../lib/railGroups";
import { useGroupsStore } from "../stores/groupsStore";
import { useRailGroupUi } from "../stores/railGroupUiStore";
import { HighlightedLabel, matchRange } from "./primitives/HighlightedLabel";

/**
 * A mission group in the workspace rail: a folder inside one project
 * (design-system §8, "Workspace rail — the index", rule 8).
 *
 * Its signature is two marks and nothing else: a chevron that is always
 * visible, standing in the monogram column, and a 1px guide beside its
 * members, which are indented 14px. The guide starts under the chevron and
 * stops at the last member, so where the group ends is drawn, and the next
 * loose mission returns to the outer alignment. The group's tint colours
 * those two marks only. A mission's monogram is never recoloured, and the
 * rows' 2px state edge stays at the rail's left edge.
 */

const EASE = "ease-[cubic-bezier(0.2,0.8,0.3,1)]";

/** The quiet icon button of the rail's header lines (design-system §9). */
const ICON_BTN =
  "flex shrink-0 items-center justify-center rounded text-octo-mute transition-[color,background-color,opacity] duration-[180ms] hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-octo-brass";

/** The colour of a group's two marks: its tint, or `fallback` when it has none. */
export function groupMarkColor(group: Pick<Group, "tint">, fallback: string): string {
  return group.tint ? TINTS[group.tint].accent : fallback;
}

/** What a folded group's header says about the members it hides. */
export type GroupAttention = "beacon" | "dot" | null;

interface Props {
  group: Group;
  /** Every member of the group (not only the ones a filter shows). */
  memberCount: number;
  /** Folded right now (always false while a filter is typed). */
  folded: boolean;
  /** False while a filter holds everything open: the header stops toggling
   *  and the stored fold is left alone. */
  canFold: boolean;
  /** The live filter query, to wash a hit inside the name. */
  q: string;
  /** A member has an open pull request. */
  hasOpenPr: boolean;
  /** Set only while folded: the beacon or a static dot the header carries
   *  for its hidden members. */
  attention: GroupAttention;
  /** Missions can be dropped on this group and its header dragged. */
  dragEnabled: boolean;
  /** What the pointer is dragging in the rail right now, if anything. */
  dragging: RailDragSubject | null;
  hitClassName: string;
  onToggle: () => void;
  onContextMenu: (x: number, y: number) => void;
  /** Start a new mission in this group. Left out where the flow is not wired. */
  onNewMission?: () => void;
  /** The group's mission rows. */
  children: ReactNode;
}

export function RailMissionGroup({
  group,
  memberCount,
  folded,
  canFold,
  q,
  hasOpenPr,
  attention,
  dragEnabled,
  dragging,
  hitClassName,
  onToggle,
  onContextMenu,
  onNewMission,
  children,
}: Props) {
  const renaming = useRailGroupUi((s) => s.renamingId === group.id);
  const headerRef = useRef<HTMLButtonElement | null>(null);
  const projectId = group.projectId ?? "";

  const drop = useDroppable({
    id: `group:${group.id}`,
    data: { type: "group", groupId: group.id, projectId } satisfies RailDropTarget,
    disabled: !dragEnabled,
  });
  const drag = useDraggable({
    id: `group-drag:${group.id}`,
    data: { type: "group", groupId: group.id, projectId } satisfies RailDragSubject,
    disabled: !dragEnabled || renaming,
  });
  // A drop here would change something: a mission that is not already a
  // member, or a sibling group taking this one's place.
  const accepts =
    drop.isOver &&
    dragging !== null &&
    dragging.projectId === projectId &&
    dragging.groupId !== group.id;

  // After a rename ends, the header gets the focus back (the input held it).
  const wasRenaming = useRef(false);
  useEffect(() => {
    if (wasRenaming.current && !renaming) headerRef.current?.focus({ preventScroll: true });
    wasRenaming.current = renaming;
  }, [renaming]);

  const empty = memberCount === 0;
  const markColor = groupMarkColor(group, "var(--color-octo-mute)");
  const guideColor = groupMarkColor(group, "var(--color-octo-border-strong)");
  const hit = matchRange(group.name, q);
  const startRename = () => useRailGroupUi.getState().startRename(group.id);
  const openMenuAtHeader = () => {
    const r = headerRef.current?.getBoundingClientRect();
    if (r) onContextMenu(r.left + 24, r.bottom);
  };

  const chevron = (
    <span
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${
        attention === "beacon" ? "rail-beacon animate-attention-pulse" : ""
      }`}
      style={{ color: markColor }}
    >
      <ChevronDown
        size={12}
        aria-hidden
        className={`transition-transform duration-[280ms] ${EASE} ${folded ? "-rotate-90" : ""}`}
      />
    </span>
  );

  return (
    <div
      ref={drop.setNodeRef}
      data-testid={`rail-group-${group.id}`}
      data-rail-group={group.id}
      className={`octo-fade-in relative mb-1.5 mt-0.5 flex flex-col ${drag.isDragging ? "opacity-40" : ""}`}
    >
      <div
        ref={drag.setNodeRef}
        onPointerDown={drag.listeners?.onPointerDown as React.PointerEventHandler<HTMLDivElement> | undefined}
        data-tour="rail-group-header"
        className={`group/ghead relative flex h-7 items-center gap-2 pl-3.5 pr-3 transition-colors duration-[180ms] ${
          accepts ? "bg-[var(--brass-ghost)]" : ""
        }`}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(e.clientX, e.clientY);
        }}
      >
        {renaming ? (
          <>
            {chevron}
            <GroupNameInput group={group} />
          </>
        ) : (
          <button
            ref={headerRef}
            type="button"
            data-rail-group-header={group.id}
            aria-expanded={!folded}
            title={`${group.name} · double-click to rename · right-click for options`}
            onClick={() => {
              if (canFold) onToggle();
            }}
            onDoubleClick={startRename}
            onKeyDown={(e) => {
              if (e.key === "F2") {
                e.preventDefault();
                startRename();
              } else if (e.key === "ArrowLeft" && canFold && !folded) {
                e.preventDefault();
                onToggle();
              } else if (e.key === "ArrowRight" && canFold && folded) {
                e.preventDefault();
                onToggle();
              } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                e.preventDefault();
                openMenuAtHeader();
              }
            }}
            className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-octo-brass"
          >
            {chevron}
            <span
              data-testid="rail-group-name"
              className="min-w-0 flex-1 truncate font-mono text-[11px] leading-none text-octo-sage transition-colors duration-[180ms] group-hover/ghead:text-octo-ivory"
            >
              {hit ? (
                <HighlightedLabel label={group.name} match={hit} className={hitClassName} testId="rail-hit" />
              ) : (
                group.name
              )}
            </span>
            {attention && <span className="sr-only"> — needs attention</span>}
          </button>
        )}

        {/* The tail holds the aggregates and the "+". It has no gap of its
            own, so a hidden "+" costs nothing and the aggregates end on the
            same right edge as the rows' meta. */}
        <div className="flex shrink-0 items-center">
        {/* Aggregates — only while folded (a count visible in the list is
            never repeated in a header). `empty` is the exception: there is no
            list to read it from, so it always shows. Kept mounted so folding
            fades them in; they take no width while hidden. */}
        <span
          data-testid="rail-group-aggregates"
          aria-hidden={!(folded || empty)}
          inert={!(folded || empty)}
          className={`octo-tabular flex shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap font-mono text-[10px] leading-none text-octo-mute transition-[max-width,opacity] duration-[220ms] ${EASE} ${
            folded || empty ? "max-w-[120px] opacity-100" : "pointer-events-none max-w-0 opacity-0"
          }`}
        >
          {empty ? (
            <span>empty</span>
          ) : (
            <>
              <span title={`${memberCount} mission${memberCount === 1 ? "" : "s"}`}>{memberCount}</span>
              {hasOpenPr && (
                <span
                  role="img"
                  aria-label="Open pull request in this group"
                  title="Open pull request in this group"
                  className="flex text-octo-verdigris"
                >
                  <GitPullRequest size={10} aria-hidden />
                </span>
              )}
              {attention === "dot" && (
                <span
                  role="img"
                  aria-label="Needs your attention"
                  title="Needs your attention"
                  className="h-[5px] w-[5px] rounded-full bg-octo-brass"
                />
              )}
            </>
          )}
        </span>

        {/* "+" on hover and focus. Not a tab stop (the header is one stop);
            the header menu offers the same action to the keyboard. */}
        {onNewMission && !renaming && (
          <span
            className={`flex max-w-0 shrink-0 items-center overflow-hidden opacity-0 transition-[max-width,opacity] duration-[220ms] ${EASE} group-focus-within/ghead:max-w-6 group-focus-within/ghead:opacity-100 group-hover/ghead:max-w-6 group-hover/ghead:opacity-100`}
          >
            <button
              type="button"
              tabIndex={-1}
              onClick={onNewMission}
              title="New mission in this group"
              aria-label={`New mission in ${group.name}`}
              className={`${ICON_BTN} ml-1 h-5 w-5`}
            >
              <Plus size={12} aria-hidden />
            </button>
          </span>
        )}
        </div>
      </div>

      {/* The run — the grid-rows 0fr↔1fr collapse idiom. */}
      <div
        aria-hidden={folded}
        inert={folded}
        className={`grid overflow-hidden transition-[grid-template-rows,opacity] duration-[280ms] ${EASE}`}
        style={{
          gridTemplateColumns: "minmax(0, 1fr)",
          gridTemplateRows: folded ? "0fr" : "1fr",
          opacity: folded ? 0 : 1,
        }}
      >
        <div className="min-h-0 overflow-hidden">
          <div data-tour={empty ? undefined : tourId("rail-group-members")} className="relative flex flex-col">
            {children}
            {/* The guide: after the rows, so it is drawn over their hover and
                active grounds. It stops 5px short of the last row's foot. */}
            {!empty && (
              <span
                aria-hidden
                data-testid="rail-group-guide"
                className="pointer-events-none absolute bottom-[5px] left-6 top-0 w-px opacity-50"
                style={{ backgroundColor: guideColor }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The header's name in inline edit: Enter and blur commit, Escape keeps the
 *  name as it was. A blank name is not a name, so it changes nothing. */
function GroupNameInput({ group }: { group: Group }) {
  const [value, setValue] = useState(group.name);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) void useGroupsStore.getState().rename(group.id, value);
    useRailGroupUi.getState().stopRename();
  };

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      // The header is a drag handle; a press in the input places the caret.
      onPointerDown={(e) => e.stopPropagation()}
      aria-label="Group name"
      spellCheck={false}
      maxLength={80}
      className="h-5 min-w-0 flex-1 border-b border-octo-brass bg-transparent font-mono text-[11px] leading-none text-octo-ivory outline-none"
    />
  );
}
