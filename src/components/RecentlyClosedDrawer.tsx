import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { ProjectMark } from "./icons/ProjectMark";
import type { ProjectInfo } from "../lib/types";

interface Props {
  projects: ProjectInfo[];
  onReopen: (id: string) => void;
}

/** Collapsed-by-default drawer of soft-closed projects, pinned above the
 *  rail's Add-project footer. Hidden entirely when nothing is closed (§4.4). */
export function RecentlyClosedDrawer({ projects, onReopen }: Props) {
  const [open, setOpen] = useState(false);
  if (projects.length === 0) return null;

  return (
    <div className="w-full border-t border-octo-hairline pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="recently-closed-panel"
        className="flex w-full items-center justify-between px-3 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute transition hover:text-octo-sage"
      >
        <span>⟲ Recently closed · {projects.length}</span>
        <ChevronDown
          size={12}
          aria-hidden="true"
          className={`transition-transform duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.3,1)] ${
            open ? "" : "-rotate-90"
          }`}
        />
      </button>
      <div
        id="recently-closed-panel"
        aria-hidden={!open}
        className="grid overflow-hidden transition-all duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.3,1)]"
        style={{
          gridTemplateRows: open ? "1fr" : "0fr",
          opacity: open ? 1 : 0,
        }}
      >
        <div className="mt-1 flex min-h-0 flex-col overflow-hidden">
          {projects.map((p) => (
            <div key={p.id} className="group flex items-center gap-2 px-3 py-1.5">
              <ProjectMark size={13} className="shrink-0 opacity-50" />
              <span className="flex-1 truncate font-mono text-[10px] uppercase tracking-[0.2em] text-octo-sage">
                {p.name}
              </span>
              <button
                type="button"
                onClick={() => onReopen(p.id)}
                aria-label={`Restore ${p.name}`}
                className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 font-mono text-[10px] text-octo-brass"
              >
                Restore
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
