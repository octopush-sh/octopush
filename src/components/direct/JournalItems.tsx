// The one renderer for live-journal entries — prose lines, brass notices, and
// flat tool lines with their paired results — shared by the Direct stage focus
// (live + archived attempts) and the Talk crew journal, so every journal in
// the app reads identically.
import type { ReactElement } from "react";
import type { LiveEntry } from "../../lib/ipc";
import { iconForTool } from "../../lib/roleIcons";

/** A Claude Code sub-agent's entries sit one level in, under the `Agent`
 *  line that spawned them: a hairline on the left, a little indent, nothing
 *  else — the hierarchy is a fact of the journal, not a decoration. */
function nested(e: LiveEntry, base: string): string {
  return e.parent ? `${base} ml-3 border-l border-octo-hairline pl-3` : base;
}

export function buildJournalItems(entries: LiveEntry[]): ReactElement[] {
  const items: ReactElement[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.kind === "text") {
      items.push(<div key={i} data-parent={e.parent} className={nested(e, "octo-rise-in text-octo-sage")}>{e.text}</div>);
    } else if (e.kind === "notice") {
      items.push(<div key={i} data-parent={e.parent} className={nested(e, "octo-rise-in font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass")}>{e.text}</div>);
    } else if (e.kind === "tool") {
      // Pair the result only when it is the very next entry AND belongs to the
      // same level — a spawning Agent line is followed by its sub-agent's
      // entries, and its own result lands later as a standalone line.
      const next = entries[i + 1];
      const res = next && next.kind === "tool_result" && (next.parent ?? null) === (e.parent ?? null) ? next : null;
      if (res) i++; // consume the paired result
      const ToolIcon = iconForTool(e.tool);
      items.push(
        <div key={i} data-parent={e.parent} data-agent-id={e.agentId} className={nested(e, "octo-rise-in flex items-baseline gap-2 font-mono text-[12px]")}>
          <span className="translate-y-[1px] shrink-0 text-octo-mute" title={e.tool}>
            <ToolIcon size={11} strokeWidth={1.75} />
          </span>
          <span className="shrink-0 text-octo-ivory">{e.tool}</span>
          {e.hint && (
            <span className="min-w-0 truncate text-octo-sage" title={e.hint}>
              {e.hint}
            </span>
          )}
          {res && (
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px]">
              <span className={res.ok ? "text-octo-verdigris" : "text-octo-rouge"}>{res.ok ? "✓" : "✕"}</span>
              <span className="max-w-[28ch] truncate text-octo-mute" title={res.detail}>
                {res.detail}
              </span>
            </span>
          )}
        </div>,
      );
    } else if (e.kind === "tool_result") {
      // orphan result (no preceding tool in buffer) — render compactly
      items.push(
        <div key={i} data-parent={e.parent} className={nested(e, "octo-rise-in flex items-center gap-1.5 font-mono text-[11px] text-octo-mute")}>
          <span className={e.ok ? "text-octo-verdigris" : "text-octo-rouge"}>{e.ok ? "✓" : "✕"}</span>
          <span>{e.detail}</span>
        </div>,
      );
    }
  }
  return items;
}
