import { useEffect } from "react";
import type { ProjectInfo } from "../lib/types";
import { BrassRule } from "./BrassRule";

interface Props {
  activeProjectId: string;
  projects: ProjectInfo[];
  onSelect: (project: ProjectInfo) => void;
  onAddProject: () => void;
  onClose: () => void;
}

export function ProjectSwitcher({
  activeProjectId,
  projects,
  onSelect,
  onAddProject,
  onClose,
}: Props) {
  // Esc closes the sheet
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-octo-bg/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Switch project"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[480px] rounded-xl border border-octo-hairline bg-octo-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3">
          <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
            Projects
          </div>
        </div>

        {/* Project list */}
        <div className="flex flex-col px-3 pb-2">
          {projects.map((p) => {
            const isActive = p.id === activeProjectId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onSelect(p);
                  onClose();
                }}
                className={`group flex w-full flex-col rounded-md px-3 py-2.5 text-left transition ${
                  isActive
                    ? "border-l-2 border-octo-brass bg-[var(--brass-ghost)]"
                    : "border-l-2 border-transparent hover:bg-[var(--brass-faint)]"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`font-serif text-[14px] leading-snug ${
                      isActive ? "text-octo-ivory" : "text-octo-sage group-hover:text-octo-ivory"
                    } transition`}
                  >
                    {p.name}
                  </span>
                  {isActive && (
                    <span
                      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-octo-brass"
                      aria-label="active"
                    />
                  )}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-octo-mute">
                  {p.path}
                </div>
              </button>
            );
          })}

          {projects.length === 0 && (
            <p className="px-3 py-4 font-mono text-[11px] text-octo-mute">
              No recent projects.
            </p>
          )}
        </div>

        {/* Footer — Add project */}
        <div className="px-5 pb-5">
          <BrassRule className="mb-4" />
          <button
            type="button"
            onClick={() => {
              onAddProject();
              onClose();
            }}
            className="font-serif text-[13px] text-octo-brass transition hover:text-octo-brass-hi"
          >
            + Add project ↗
          </button>
        </div>
      </div>
    </div>
  );
}
