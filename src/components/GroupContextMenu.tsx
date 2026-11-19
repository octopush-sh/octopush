import { useId, useRef, useState } from "react";
import { Pencil, Plus, Trash2, Ungroup } from "lucide-react";
import { MenuSurface } from "./MenuSurface";
import { MENU_HEADER, MENU_ITEM, MENU_ITEM_MULTILINE, MENU_SEP } from "../lib/menuStyles";
import { TINTS, TINT_NAMES } from "../lib/monogram";
import type { TintName } from "../lib/types";

interface Props {
  x: number;
  y: number;
  groupName: string;
  /** The group's tint, or null when it has none. */
  tint: TintName | null;
  /** True when the group holds no mission: the last row removes it. */
  empty: boolean;
  onRename: () => void;
  /** Called with the picked tint, or null for None. The menu stays open. */
  onTint: (tint: TintName | null) => void;
  /** Start a new mission in this group. Left out where the flow is not wired. */
  onNewMission?: () => void;
  /** Remove the group; its missions stay in the project. */
  onUngroup: () => void;
  onDismiss: () => void;
}

const SWATCH =
  "h-[18px] w-[18px] shrink-0 rounded-full transition-shadow duration-[180ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass focus-visible:ring-offset-2 focus-visible:ring-offset-octo-panel";
/** The current tint's swatch: a ring in the text ink, clear of the fill. */
const SWATCH_CURRENT = "ring-1 ring-octo-ivory ring-offset-2 ring-offset-octo-panel";

const titleCase = (name: string) => name[0].toUpperCase() + name.slice(1);

/**
 * The menu of a mission group's header: Rename, Tint (the seven monogram
 * tints plus None; no other hue exists), and Ungroup, which keeps the
 * missions. An empty group offers Remove group instead. Picking a tint does
 * not close the menu, so tints can be compared on the rail behind it.
 */
export function GroupContextMenu({
  x,
  y,
  groupName,
  tint,
  empty,
  onRename,
  onTint,
  onNewMission,
  onUngroup,
  onDismiss,
}: Props) {
  const swatches = useRef<HTMLDivElement>(null);
  const tintLabelId = useId();
  const run = (fn: () => void) => () => {
    fn();
    onDismiss();
  };

  const options: Array<TintName | null> = [null, ...TINT_NAMES];
  // The swatch row is ONE stop of the menu's ↑/↓ walk, and ←/→ move along it
  // (a roving tab stop). The stop starts on the current tint and follows the
  // focus, so ↓ from any swatch goes on to the next row instead of finding
  // itself outside the walk and starting over at the top.
  const [stop, setStop] = useState<TintName | null>(tint);
  const onSwatchKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const all = Array.from(swatches.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const at = all.indexOf(e.currentTarget);
    const next = (at + (e.key === "ArrowRight" ? 1 : -1) + all.length) % all.length;
    setStop(options[next]);
    all[next]?.focus();
  };

  return (
    <MenuSurface x={x} y={y} ariaLabel="Group actions" onDismiss={onDismiss} widthClass="w-[230px]">
      <div className={MENU_HEADER}>{groupName}</div>

      <button type="button" role="menuitem" className={MENU_ITEM} onClick={run(onRename)}>
        <Pencil size={12} className="shrink-0" />
        <span className="flex-1 text-left">Rename</span>
        <span className="text-[10px] text-octo-mute">F2</span>
      </button>
      {onNewMission && (
        <button type="button" role="menuitem" className={MENU_ITEM} onClick={run(onNewMission)}>
          <Plus size={12} className="shrink-0" /> New mission in this group
        </button>
      )}

      <div className={MENU_SEP} />

      <div id={tintLabelId} className={`${MENU_HEADER} pt-2`}>
        Tint
      </div>
      <div
        ref={swatches}
        role="group"
        aria-labelledby={tintLabelId}
        className="flex items-center gap-[7px] px-3 pb-2.5 pt-1"
      >
        {options.map((name) => {
          const current = name === tint;
          const label = name ? titleCase(name) : "No tint";
          return (
            <button
              key={name ?? "none"}
              type="button"
              role="menuitemradio"
              aria-checked={current}
              aria-label={label}
              title={label}
              tabIndex={name === stop ? 0 : -1}
              data-menu-item={name === stop ? "" : undefined}
              onFocus={() => setStop(name)}
              onClick={() => onTint(name)}
              onKeyDown={onSwatchKey}
              className={`${SWATCH} ${current ? SWATCH_CURRENT : ""} ${
                name ? "" : "border border-octo-border-strong"
              }`}
              style={name ? { background: TINTS[name].accent } : undefined}
            />
          );
        })}
      </div>

      <div className={MENU_SEP} />

      {empty ? (
        <button type="button" role="menuitem" className={MENU_ITEM} onClick={run(onUngroup)}>
          <Trash2 size={12} className="shrink-0" /> Remove group
        </button>
      ) : (
        <button type="button" role="menuitem" className={MENU_ITEM_MULTILINE} onClick={run(onUngroup)}>
          <Ungroup size={12} className="mt-0.5 shrink-0" />
          <span className="flex flex-col text-left">
            <span>Ungroup</span>
            <span className="text-octo-mute">Keeps the missions</span>
          </span>
        </button>
      )}
    </MenuSurface>
  );
}
