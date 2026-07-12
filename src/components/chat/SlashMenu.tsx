import { Slash } from "lucide-react";
import type { SkillMeta } from "../../lib/types";

interface Props {
  items: SkillMeta[];
  activeIndex: number;
  onSelect: (skill: SkillMeta) => void;
  onHover: (index: number) => void;
}

/**
 * `/`-triggered skill menu, anchored above the composer. Lists the worktree's
 * skills (project ∪ user SKILL.md). Purely presentational — keyboard nav lives
 * in the Composer (shared with the @file popover). Selecting a skill activates
 * it for subsequent turns until cleared.
 */
export function SlashMenu({ items, activeIndex, onSelect, onHover }: Props) {
  return (
    <div
      className="octo-pop-in absolute bottom-full left-0 z-20 mb-1.5 max-h-64 w-[min(30rem,100%)] overflow-y-auto rounded-md border border-octo-hairline bg-octo-panel py-1 shadow-lg"
      role="listbox"
      id="slash-popover"
      aria-label="Skills"
    >
      <div className="px-3 py-1 font-mono text-[8px] uppercase tracking-[0.3em] text-octo-brass">
        Skills
      </div>
      {items.length === 0 ? (
        <div className="px-3 py-2 text-[11px] text-octo-mute">
          No skills found. Add one at{" "}
          <span className="font-mono text-octo-sage">.claude/skills/&lt;name&gt;/SKILL.md</span>.
        </div>
      ) : (
        items.map((skill, i) => {
          const active = i === activeIndex;
          return (
            <button
              key={`${skill.source}:${skill.name}`}
              id={`slash-opt-${i}`}
              type="button"
              role="option"
              aria-selected={active}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(skill);
              }}
              onMouseMove={() => onHover(i)}
              className={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors ${
                active ? "bg-[var(--brass-ghost)]" : ""
              }`}
            >
              <div className="flex items-baseline gap-2">
                <span title="Skill" className="flex items-center text-octo-brass">
                  <Slash size={12} strokeWidth={1.75} />
                </span>
                <span className={`font-mono text-[11px] ${active ? "text-octo-brass" : "text-octo-ivory"}`}>
                  {skill.name}
                </span>
                <span className="ml-auto font-mono text-[8px] uppercase tracking-[0.2em] text-octo-mute">
                  {skill.source}
                </span>
              </div>
              {skill.description && (
                <span className="truncate pl-4 text-[10px] leading-tight text-octo-sage">
                  {skill.description}
                </span>
              )}
            </button>
          );
        })
      )}
    </div>
  );
}
