import { Slash } from "lucide-react";
import type { SkillMeta, SkippedDefinition } from "../../lib/types";

/** How many skipped skill files the menu names; the rest are counted. */
export const MAX_SKIPPED_ROWS = 20;

/** The skipped skill files a `/query` matches, by directory name, the way
 *  the menu's skills are matched by name. */
export function matchingSkipped(skipped: SkippedDefinition[], query: string): SkippedDefinition[] {
  const q = query.toLowerCase();
  return q ? skipped.filter((s) => s.name.toLowerCase().includes(q)) : skipped;
}

interface Props {
  items: SkillMeta[];
  /** Skill files the backend left unread (`list_skipped_skills`), already
   *  matched to the query. Listed under the skills; never selectable. */
  skipped?: SkippedDefinition[];
  activeIndex: number;
  onSelect: (skill: SkillMeta) => void;
  onHover: (index: number) => void;
  /** Which way the list opens. TALK's composer sits at the bottom of the
   *  screen, so `up` is the default; a mid-canvas host (DIRECT's brief)
   *  must pass `down` — upward overflow cannot be scrolled to inside an
   *  `overflow:auto` ancestor, it is simply clipped. */
  placement?: "up" | "down";
}

/**
 * `/`-triggered skill menu, anchored above the composer. Lists the worktree's
 * skills (project ∪ user SKILL.md). Purely presentational — keyboard nav lives
 * in the Composer (shared with the @file popover). Selecting a skill inserts a
 * `/name` token into the message — it rides with that message only. A skill
 * file the backend left unread (it resolves outside the project, or is over
 * 4 MiB) is named below the skills as "skipped: …", muted and not selectable.
 */
export function SlashMenu({ items, skipped = [], activeIndex, onSelect, onHover, placement = "up" }: Props) {
  const shown = skipped.slice(0, MAX_SKIPPED_ROWS);
  const more = skipped.length - shown.length;
  return (
    <div
      className={`octo-pop-in ${placement === "down" ? "top-full mt-1.5" : "bottom-full mb-1.5"} absolute left-0 z-20 max-h-64 w-[min(30rem,100%)] overflow-y-auto rounded-md border border-octo-hairline bg-octo-panel py-1 shadow-lg`}
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
      {shown.map((s) => (
        <div
          key={`skipped:${s.path}`}
          role="option"
          aria-selected={false}
          aria-disabled={true}
          title={`${s.label} · skipped: ${s.reason}`}
          className="flex items-baseline gap-2 px-3 py-1.5 text-octo-mute"
        >
          <span title="Skipped skill" className="flex items-center">
            <Slash size={12} strokeWidth={1.75} />
          </span>
          <span className="truncate font-mono text-[11px]">{s.name}</span>
          <span className="ml-auto shrink-0 font-mono text-[10px]">skipped: {s.reason}</span>
        </div>
      ))}
      {more > 0 && <div className="px-3 py-1 font-mono text-[10px] text-octo-mute">+{more} more skipped</div>}
    </div>
  );
}
