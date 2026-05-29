import { useEffect, useState } from "react";
import { useIssuesStore } from "../stores/issuesStore";
import { ipc } from "../lib/ipc";
import type { Issue, StatusCategory } from "../lib/types";

// Status → existing octo tokens, no new colors
const STATUS_DOT_COLOR: Record<StatusCategory, string> = {
  todo: "text-octo-mute",
  inProgress: "text-octo-brass",
  done: "text-octo-verdigris",
  unknown: "text-octo-sage",
};

interface Props {
  activeKey: string | null;
  configured: boolean;
}

export function BacklogPanel({ activeKey, configured }: Props) {
  const { issues, loading, error, load } = useIssuesStore();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (configured) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured]);

  return (
    <div className="border-t border-octo-hairline px-3 py-2">
      {/* Header row: eyebrow + collapse chevron + refresh */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex flex-1 items-center justify-between font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute"
        >
          <span>Backlog</span>
          <span className="mr-1">{collapsed ? "▸" : "▾"}</span>
        </button>
        {configured && !collapsed && (
          <button
            type="button"
            onClick={() => void load()}
            className="font-mono text-[10px] text-octo-mute transition hover:text-octo-brass"
            title="Refresh backlog"
            aria-label="Refresh backlog"
          >
            ↺
          </button>
        )}
      </div>

      {/* Body — hidden when collapsed */}
      {!collapsed && (
        <div className="mt-2 space-y-1">
          {/* Not configured */}
          {!configured && (
            <div className="text-[12px] text-octo-mute">
              Connect Jira in Settings
            </div>
          )}

          {/* Loading (no cached list yet) */}
          {configured && loading && !issues && (
            <div className="text-[12px] text-octo-mute">loading…</div>
          )}

          {/* Error */}
          {configured && error && !loading && (
            <div className="text-[12px] text-octo-mute">
              couldn&#39;t reach Jira
            </div>
          )}

          {/* Empty */}
          {configured && issues && issues.length === 0 && (
            <div className="text-[12px] text-octo-mute">
              No assigned tickets
            </div>
          )}

          {/* Issue rows */}
          {configured &&
            issues?.map((it: Issue) => {
              const isActive = it.key === activeKey;
              return (
                <button
                  key={it.key}
                  type="button"
                  role="button"
                  onClick={() => ipc.openFileInSystem(it.url).catch(() => {})}
                  className="flex w-full items-center gap-2 px-2 py-1 text-left transition-colors duration-[220ms] ease-[cubic-bezier(0.2,0.8,0.3,1)] hover:bg-octo-panel-2"
                  style={
                    isActive
                      ? { borderLeft: "1px solid var(--brass-dim)", background: "var(--brass-ghost)" }
                      : { borderLeft: "1px solid transparent" }
                  }
                >
                  {/* Status dot */}
                  <span
                    className={`flex-shrink-0 text-[8px] leading-none ${STATUS_DOT_COLOR[it.statusCategory]}`}
                    aria-label={it.statusCategory}
                  >
                    ●
                  </span>

                  {/* Ticket key — mono */}
                  <span className="flex-shrink-0 font-mono text-[11px] text-octo-ivory">
                    {it.key}
                  </span>

                  {/* Summary — truncated */}
                  <span className="min-w-0 flex-1 truncate text-[12px] text-octo-sage">
                    {it.summary}
                  </span>

                  {/* Status label */}
                  <span className="flex-shrink-0 text-[10px] text-octo-mute">
                    {it.statusName}
                  </span>
                </button>
              );
            })}
        </div>
      )}
    </div>
  );
}
