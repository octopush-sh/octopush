import type { MentionGroup } from "../../lib/talkContext";
import { tourId } from "../../lib/tour/ids";

/** How a conversation or definition row reads (a path row reads its path). */
export interface MentionRowLabel {
  name: string;
  detail: string;
}

interface Props {
  items: string[];
  activeIndex: number;
  onSelect: (path: string) => void;
  onHover: (index: number) => void;
  /** Which way the list opens. TALK's composer sits at the bottom of the
   *  screen, so `up` is the default; a mid-canvas host (DIRECT's brief)
   *  must pass `down` — upward overflow cannot be scrolled to inside an
   *  `overflow:auto` ancestor, it is simply clipped. */
  placement?: "up" | "down";
  /** The eyebrow; Talk's composer offers more than files ("Add context"). */
  heading?: string;
  /** Talk's composer: each item's group, in `items` order (`groupMentionRows`).
   *  Conversations and definitions get an eyebrow of their own. */
  groups?: MentionGroup[];
  /** The name and detail of a conversation or definition row, by token. */
  labels?: Record<string, MentionRowLabel>;
}

const GROUP_HEADING: Record<Exclude<MentionGroup, "context">, string> = {
  chats: "Conversations",
  symbols: "Definitions",
};

const GROUP_TOUR: Record<Exclude<MentionGroup, "context">, string> = {
  chats: tourId("talk-mention-chats"),
  symbols: tourId("talk-mention-symbols"),
};

function Eyebrow({ children }: { children: string }) {
  return (
    <div className="px-3 py-1 font-mono text-[8px] uppercase tracking-[0.3em] text-octo-brass">{children}</div>
  );
}

/**
 * `@file` autocomplete list, anchored above the composer by the parent. Purely
 * presentational — keyboard navigation (Up/Down/Enter/Esc) lives in the
 * Composer so it can coexist with the textarea's own key handling. The active
 * row is brass-tinted; the basename is emphasized over its dimmed directory
 * (a folder row, `src/lib/`, emphasizes its own name). In Talk, the
 * workspace's other conversations and the definitions of the identifier
 * typed follow under their own eyebrows.
 */
export function MentionPopover({
  items,
  activeIndex,
  onSelect,
  onHover,
  placement = "up",
  heading = "Reference a file",
  groups,
  labels = {},
}: Props) {
  if (items.length === 0) return null;
  const row = (path: string, i: number) => {
    const active = i === activeIndex;
    const label = labels[path];
    let dim: string;
    let lead: string;
    if (label) {
      lead = label.name;
      dim = label.detail;
    } else {
      const bare = path.endsWith("/") ? path.slice(0, -1) : path;
      const slash = bare.lastIndexOf("/");
      dim = slash >= 0 ? path.slice(0, slash + 1) : "";
      lead = slash >= 0 ? path.slice(slash + 1) : path;
    }
    return (
      <button
        key={path}
        id={`mention-opt-${i}`}
        type="button"
        role="option"
        aria-selected={active}
        // onMouseDown (not onClick) so the textarea doesn't blur first.
        onMouseDown={(e) => {
          e.preventDefault();
          onSelect(path);
        }}
        onMouseMove={() => onHover(i)}
        title={label ? `@${path}` : undefined}
        className={`flex w-full items-baseline gap-0 truncate px-3 py-1.5 text-left font-mono text-[11px] transition-colors ${
          active ? "bg-[var(--brass-ghost)]" : ""
        }`}
      >
        {label ? (
          <>
            <span className={`shrink-0 ${active ? "text-octo-brass" : "text-octo-ivory"}`}>{lead}</span>
            <span className="ml-2 truncate text-octo-mute">{dim}</span>
          </>
        ) : (
          <>
            <span className="shrink-0 text-octo-mute">{dim}</span>
            <span className={active ? "text-octo-brass" : "text-octo-ivory"}>{lead}</span>
          </>
        )}
      </button>
    );
  };

  // Runs of one group, each under its eyebrow (the first run of plain
  // context rows sits under `heading`).
  const runs: { group: MentionGroup; from: number; tokens: string[] }[] = [];
  items.forEach((t, i) => {
    const g = groups?.[i] ?? "context";
    const last = runs[runs.length - 1];
    if (last && last.group === g) last.tokens.push(t);
    else runs.push({ group: g, from: i, tokens: [t] });
  });

  return (
    <div
      className={`octo-pop-in ${placement === "down" ? "top-full mt-1.5" : "bottom-full mb-1.5"} absolute left-0 z-20 max-h-64 w-[min(28rem,100%)] overflow-y-auto rounded-md border border-octo-hairline bg-octo-panel py-1 shadow-lg`}
      role="listbox"
      id="mention-popover"
      aria-label="Worktree files"
    >
      {runs.map((run, r) =>
        run.group === "context" ? (
          <div key={`run-${r}`} role="group" aria-label={heading}>
            <Eyebrow>{heading}</Eyebrow>
            {run.tokens.map((t, j) => row(t, run.from + j))}
          </div>
        ) : (
          <div
            key={`run-${r}`}
            role="group"
            aria-label={GROUP_HEADING[run.group]}
            data-tour={GROUP_TOUR[run.group]}
            className="octo-fade-in"
          >
            <Eyebrow>{GROUP_HEADING[run.group]}</Eyebrow>
            {run.tokens.map((t, j) => row(t, run.from + j))}
          </div>
        ),
      )}
    </div>
  );
}
