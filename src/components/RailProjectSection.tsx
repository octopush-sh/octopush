import { useEffect, useRef, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useDndContext, useDroppable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { DRAGGED_BLOCK, useFollowPointer, type RailTopData } from "../lib/railDnd";
import { sectionDragId, sectionHeadId } from "../lib/railGroups";
import { tourId } from "../lib/tour/ids";
import type { Group } from "../lib/types";
import { useRailGroupUi } from "../stores/railGroupUiStore";
import { HighlightedLabel, matchRange } from "./primitives/HighlightedLabel";
import { GroupNameInput, groupHeaderKeyDown, groupMarkColor, type GroupAttention } from "./RailMissionGroup";

/**
 * A project group in the workspace rail: a section of the top level
 * (design-system §8, "Rail groups").
 *
 * Its signature is a hairline above and a caps eyebrow, and nothing else: its
 * projects are not indented and it draws no guide, so it can never be read as
 * a mission group (an always-visible chevron, a mono label and an indented
 * run beside a guide). The section's end is drawn by whatever follows it: the
 * next section's hairline, or the closing hairline a loose project takes when
 * it comes right after a section (`WorkspaceRail`).
 *
 * The group's tint colours the fold chevron, which shows on hover, on focus
 * and while folded. A project's hexagon takes it too, only when the project
 * has no tint of its own (the rail decides that; see `projectMarkColor`).
 */

const EASE = "ease-[cubic-bezier(0.2,0.8,0.3,1)]";

/** The air above the section, and its hairline. A group above already ends
 *  with its own foot; a project's last row needs the room a project gets. */
const LEAD = {
  first: "mt-1",
  "after-project": "mt-2.5 border-t border-octo-hairline pt-1.5",
  "after-section": "mt-0.5 border-t border-octo-hairline pt-1.5",
} as const;

/** The eyebrow's type: the rail's "Recently closed" idiom. */
const EYEBROW = "font-mono text-[9px] uppercase leading-none tracking-[0.25em]";

interface Props {
  group: Group;
  /** Every project of the group (not only the ones a filter shows). */
  projectCount: number;
  /** What stands above it in the rail: nothing (`first`, so it needs no
   *  hairline), a loose project (`after-project`) or another group. */
  lead: "first" | "after-project" | "after-section";
  /** Folded right now (always false while a filter is typed). */
  folded: boolean;
  /** False while a filter holds everything open. */
  canFold: boolean;
  /** The live filter query, to wash a hit inside the name. */
  q: string;
  /** The active mission is in one of its projects. While the section is
   *  folded its name reads in ivory, the cue a project's line gives. */
  holdsActive: boolean;
  /** Set only while folded: the beacon or a static dot the header carries
   *  for the missions it hides. */
  attention: GroupAttention;
  /** The section can be dragged as one unit and projects dropped on it. */
  dragEnabled: boolean;
  hitClassName: string;
  onToggle: () => void;
  /** Open the header's menu. `fromKeyboard`: it was asked for with ⇧F10 or
   *  the context-menu key, so the header wants the focus back when it closes. */
  onContextMenu: (x: number, y: number, fromKeyboard?: boolean) => void;
  /** The section's projects. */
  children: ReactNode;
}

export function RailProjectSection({
  group,
  projectCount,
  lead,
  folded,
  canFold,
  q,
  holdsActive,
  attention,
  dragEnabled,
  hitClassName,
  onToggle,
  onContextMenu,
  children,
}: Props) {
  const renaming = useRailGroupUi((s) => s.renamingId === group.id);
  const headerRef = useRef<HTMLButtonElement | null>(null);

  // The whole section is one block of the top-level list: dragged by its
  // header, it moves with its projects.
  const unit = useSortable({
    id: sectionDragId(group.id),
    data: { type: "section", groupId: group.id } satisfies RailTopData,
    disabled: !dragEnabled || renaming,
  });
  const shown = useFollowPointer(sectionDragId(group.id), unit.isDragging, unit.transform);
  // Its header is where a project is dropped to join it.
  const head = useDroppable({
    id: sectionHeadId(group.id),
    data: { type: "section-head", groupId: group.id } satisfies RailTopData,
    disabled: !dragEnabled,
  });
  // A project is being dragged over this section's header or one of its
  // projects, and it is not one of them yet: dropping it here adds it.
  const { active, over } = useDndContext();
  const dragged = active?.data.current as Partial<RailTopData> | undefined;
  const target = over?.data.current as Partial<RailTopData> | undefined;
  const accepts =
    dragged?.type === "project" &&
    dragged.sectionId !== group.id &&
    ((target?.type === "section-head" && target.groupId === group.id) ||
      (target?.type === "project" && target.sectionId === group.id));

  // One of this group's own projects is being dragged. Its block moves by a
  // transform and may leave the group's box (that is how it is dragged out),
  // so the fold's clipping is lifted meanwhile: clipped, the block would
  // vanish the moment it crossed the group's edge. The group is open then (a
  // folded group's projects cannot be grabbed), so nothing needs the clip.
  // The group is raised too: its entrance (`octo-fade-in`, filled) makes it a
  // stacking context, which would hold its dragged project's `z-10` inside
  // it, and every later block of the rail would paint over the project.
  const holdsDragged = dragged?.type === "project" && dragged.sectionId === group.id;

  // After a rename ends, the header gets the focus back (the input held it).
  const wasRenaming = useRef(false);
  useEffect(() => {
    if (wasRenaming.current && !renaming) headerRef.current?.focus({ preventScroll: true });
    wasRenaming.current = renaming;
  }, [renaming]);

  const empty = projectCount === 0;
  const hit = matchRange(group.name, q);
  const startRename = () => useRailGroupUi.getState().startRename(group.id);
  const openMenuAtHeader = () => {
    const r = headerRef.current?.getBoundingClientRect();
    if (r) onContextMenu(r.left + 24, r.bottom, true);
  };

  return (
    <div
      ref={unit.setNodeRef}
      data-testid={`rail-section-${group.id}`}
      data-rail-section={group.id}
      data-dragging={unit.isDragging || undefined}
      // Dragged, it is an opaque, lifted surface that occludes the blocks it
      // passes, its content at full strength.
      className={`octo-fade-in flex flex-col pb-1 ${LEAD[lead]} ${
        unit.isDragging ? DRAGGED_BLOCK : holdsDragged ? "relative z-10" : ""
      }`}
      style={{
        transform: shown,
        transition: unit.transition,
      }}
    >
      <div
        ref={head.setNodeRef}
        onPointerDown={unit.listeners?.onPointerDown as React.PointerEventHandler<HTMLDivElement> | undefined}
        data-tour="rail-section-header"
        className={`group/shead relative flex h-[26px] items-center gap-2 pl-3.5 pr-2 transition-colors duration-[180ms] ${
          accepts ? "bg-[var(--brass-ghost)]" : ""
        }`}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(e.clientX, e.clientY);
        }}
      >
        {renaming ? (
          <GroupNameInput group={group} typeClassName={EYEBROW} />
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
            onKeyDown={(e) =>
              groupHeaderKeyDown(e, { canFold, folded, onToggle, onRename: startRename, onMenu: openMenuAtHeader })
            }
            className="flex h-full min-w-0 flex-1 items-center rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-octo-brass"
          >
            <span
              data-testid="rail-section-name"
              // Mute at rest, like every eyebrow. Folded over the active
              // mission it is ivory: with the row and its project out of
              // sight, the header says where you are.
              className={`min-w-0 flex-1 truncate ${EYEBROW} transition-colors duration-[180ms] ${
                folded && holdsActive ? "text-octo-ivory" : "text-octo-mute group-hover/shead:text-octo-sage"
              }`}
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

        {/* Aggregates — only while folded (a count visible in the list is
            never repeated in a header). `empty` always shows: there is no
            list to read it from. Kept mounted so folding fades them in. */}
        <span
          data-testid="rail-section-aggregates"
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
              <span>
                {projectCount} {projectCount === 1 ? "project" : "projects"}
              </span>
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

        {/* The fold chevron, in the group's tint: decoration for the pointer
            (the header button is the one fold control), shown on hover, on
            focus and while folded. Folded over the beacon's workspace, it
            carries the pulse. */}
        {!renaming && (
          <span
            aria-hidden
            data-testid="rail-section-chevron"
            title={canFold ? `${folded ? "Expand" : "Collapse"} ${group.name}` : undefined}
            onClick={() => {
              if (canFold) onToggle();
            }}
            className={`flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded transition-opacity duration-[180ms] ${
              attention === "beacon" ? "rail-beacon animate-attention-pulse" : ""
            } ${folded ? "opacity-100" : "opacity-0 group-focus-within/shead:opacity-100 group-hover/shead:opacity-100"}`}
            style={{ color: groupMarkColor(group, "var(--color-octo-mute)") }}
          >
            <ChevronDown
              size={12}
              className={`transition-transform duration-[280ms] ${EASE} ${folded ? "-rotate-90" : ""}`}
            />
          </span>
        )}
      </div>

      {/* The projects — the grid-rows 0fr↔1fr collapse idiom. */}
      <div
        aria-hidden={folded}
        inert={folded}
        data-testid="rail-section-fold"
        className={`grid transition-[grid-template-rows,opacity] duration-[280ms] ${EASE} ${
          holdsDragged ? "overflow-visible" : "overflow-hidden"
        }`}
        style={{
          gridTemplateColumns: "minmax(0, 1fr)",
          gridTemplateRows: folded ? "0fr" : "1fr",
          opacity: folded ? 0 : 1,
        }}
      >
        <div className={`min-h-0 ${holdsDragged ? "overflow-visible" : "overflow-hidden"}`}>
          <div
            data-tour={empty ? undefined : tourId("rail-section-projects")}
            className={`flex flex-col ${empty ? "" : "pb-1"}`}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
