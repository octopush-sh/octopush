import { Check, ListFilter } from "lucide-react";
import { MenuSurface } from "./MenuSurface";
import { MENU_HEADER, MENU_ITEM, MENU_SEP } from "../lib/menuStyles";
import { MISSION_STATES, type MissionState } from "../lib/railState";
import { useAnchoredMenu } from "../lib/useAnchoredMenu";

interface Props {
  /** The state shown, or null for every mission. */
  value: MissionState | null;
  /** How many missions are in each state right now. */
  counts: Record<MissionState, number>;
  onChange: (value: MissionState | null) => void;
}

/**
 * The rail's state filter (#963), at the end of its search line: a quiet
 * icon that opens Every mission · Needs you · Working · Idle. While a state
 * is picked the icon is brass and names it, so a narrowed rail never passes
 * for a whole one.
 */
export function RailStateFilter({ value, counts, onChange }: Props) {
  const { menu, close, pick, buttonProps } = useAnchoredMenu((r) => ({ x: r.left, y: r.bottom + 4 }));
  const label = MISSION_STATES.find((s) => s.id === value)?.label ?? null;
  const title = label ? `Showing missions: ${label}` : "Show missions by state";
  const options: { id: MissionState | null; label: string; count: number | null }[] = [
    { id: null, label: "Every mission", count: null },
    ...MISSION_STATES.map((s) => ({ ...s, count: counts[s.id] })),
  ];
  return (
    <>
      <button
        type="button"
        {...buttonProps}
        data-tour="rail-state-filter"
        title={title}
        aria-label={title}
        className={`flex h-6 shrink-0 items-center gap-1 rounded px-1 font-mono text-[10px] transition-[color,background-color] duration-[180ms] hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass ${
          value ? "text-octo-brass" : "text-octo-mute"
        }`}
      >
        <ListFilter size={12} aria-hidden />
        {label && <span className="octo-pop-in lowercase">{label}</span>}
      </button>
      {menu && (
        <MenuSurface x={menu.x} y={menu.y} ariaLabel="Show missions" onDismiss={close} widthClass="w-[184px]">
          <div className={MENU_HEADER}>Show missions</div>
          {options.map((o, i) => (
            <div key={o.id ?? "all"}>
              {i === 1 && <div className={MENU_SEP} />}
              <button
                type="button"
                role="menuitemradio"
                aria-checked={value === o.id}
                className={MENU_ITEM}
                onClick={pick(() => onChange(o.id))}
              >
                <Check size={12} aria-hidden className={`shrink-0 ${value === o.id ? "" : "invisible"}`} />
                <span className="flex-1 text-left">{o.label}</span>
                {o.count !== null && <span className="octo-tabular text-octo-mute">{o.count}</span>}
              </button>
            </div>
          ))}
        </MenuSurface>
      )}
    </>
  );
}
