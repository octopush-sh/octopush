// The one renderer for live-journal entries — prose lines, brass notices, and
// flat tool lines with their paired results — shared by the Direct stage focus
// (live + archived attempts) and the Talk crew journal, so every journal in
// the app reads identically.
import type { ReactElement } from "react";
import type { LiveEntry } from "../../lib/ipc";
import { iconForTool } from "../../lib/roleIcons";

export function buildJournalItems(entries: LiveEntry[]): ReactElement[] {
  const items: ReactElement[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.kind === "text") {
      items.push(<div key={i} className="octo-rise-in text-octo-sage">{e.text}</div>);
    } else if (e.kind === "notice") {
      items.push(<div key={i} className="octo-rise-in font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">{e.text}</div>);
    } else if (e.kind === "tool") {
      const next = entries[i + 1];
      const res = next && next.kind === "tool_result" ? next : null;
      if (res) i++; // consume the paired result
      const ToolIcon = iconForTool(e.tool);
      items.push(
        <div key={i} className="octo-rise-in flex items-baseline gap-2 font-mono text-[12px]">
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
        <div key={i} className="octo-rise-in flex items-center gap-1.5 font-mono text-[11px] text-octo-mute">
          <span className={e.ok ? "text-octo-verdigris" : "text-octo-rouge"}>{e.ok ? "✓" : "✕"}</span>
          <span>{e.detail}</span>
        </div>,
      );
    }
  }
  return items;
}
