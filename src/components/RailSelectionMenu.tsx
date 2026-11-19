import { FolderPlus, X } from "lucide-react";
import { MenuSurface } from "./MenuSurface";
import { MoveToGroupItem, type MoveTargetGroup } from "./MoveToGroupItem";
import { MENU_HEADER, MENU_ITEM, MENU_SEP } from "../lib/menuStyles";

interface Props {
  x: number;
  y: number;
  /** How many missions are selected (two or more). */
  count: number;
  /** The mission groups of the selection's project, in rail order. */
  groups: MoveTargetGroup[];
  /** The group every selected mission is in, or null when they differ. */
  commonGroupId: string | null;
  /** Some selected mission is in a group ("Remove from group" shows). */
  anyGrouped: boolean;
  onGroup: () => void;
  onMove: (groupId: string) => void;
  onRemoveFromGroup: () => void;
  onClearSelection: () => void;
  onDismiss: () => void;
}

/**
 * The context menu of a multi-selection of missions in the rail: make one
 * group of them, move them all to a group, or let the selection go. The
 * per-mission actions stay on a single mission's own menu.
 */
export function RailSelectionMenu({
  x,
  y,
  count,
  groups,
  commonGroupId,
  anyGrouped,
  onGroup,
  onMove,
  onRemoveFromGroup,
  onClearSelection,
  onDismiss,
}: Props) {
  const run = (fn: () => void) => () => {
    fn();
    onDismiss();
  };
  return (
    <MenuSurface x={x} y={y} ariaLabel="Selected missions" onDismiss={onDismiss} widthClass="w-[240px]">
      <div className={MENU_HEADER}>{count} missions selected</div>
      <button type="button" role="menuitem" className={MENU_ITEM} onClick={run(onGroup)}>
        <FolderPlus size={12} className="shrink-0" /> Group {count} missions…
      </button>
      <MoveToGroupItem
        label={`Move ${count} missions to group`}
        groups={groups}
        currentGroupId={commonGroupId}
        onMove={(id) => run(() => onMove(id))()}
        onNewGroup={run(onGroup)}
        onRemoveFromGroup={anyGrouped ? run(onRemoveFromGroup) : undefined}
      />
      <div className={MENU_SEP} />
      <button type="button" role="menuitem" className={MENU_ITEM} onClick={run(onClearSelection)}>
        <X size={12} className="shrink-0" /> Clear selection
      </button>
    </MenuSurface>
  );
}
