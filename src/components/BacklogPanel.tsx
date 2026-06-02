import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import { useIssuesStore } from "../stores/issuesStore";
import { ipc } from "../lib/ipc";
import type { Issue, StatusCategory } from "../lib/types";
import { selectBacklog } from "../lib/issueTrackerSelectors";

const STATUS_DOT_COLOR: Record<StatusCategory, string> = {
  todo: "text-octo-mute",
  inProgress: "text-state-blue",
  done: "text-octo-verdigris",
  unknown: "text-octo-sage",
};

interface Props {
  configured: boolean;
  /** Caller guarantees this is non-null when Companion renders BacklogPanel.
   *  Kept optional here for backward-compat with tests that pass null. */
  projectKey?: string | null;
  activeKey: string | null;
  onTicketContextMenu?: (issue: Issue, x: number, y: number) => void;
}

export function BacklogPanel({ configured, projectKey = null, activeKey, onTicketContextMenu }: Props) {
  const { issues, loading, error, load } = useIssuesStore();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (configured) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured]);

  const filtered: Issue[] = selectBacklog(issues ?? [], projectKey, activeKey);

  return (
    <div className="border-b border-octo-hairline px-3 py-2">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex flex-1 items-center justify-between font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute"
        >
          <span>
            § Backlog
            {projectKey && (
              <>
                {" · "}
                <span className="text-octo-brass">{projectKey}</span>
                {" · "}
                {filtered.length}
              </>
            )}
          </span>
          <span className="mr-1 flex items-center text-octo-mute">
            {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
          </span>
        </button>
        {configured && !collapsed && (
          <button
            type="button"
            onClick={() => void load()}
            title="Refresh backlog"
            aria-label="Refresh backlog"
            className="flex items-center justify-center rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass"
          >
            <RotateCcw size={16} />
          </button>
        )}
      </div>

      {!collapsed && !configured && (
        <p className="mt-2 text-[12px] text-octo-mute">Connect Jira in Settings →</p>
      )}

      {!collapsed && configured && projectKey != null && (
        <>
          {error && (
            <p className="mt-1 font-mono text-[10px] tracking-[0.1em] text-octo-mute">
              couldn't refresh
            </p>
          )}
          {loading && !issues && (
            <p className="mt-2 font-mono text-[10px] text-octo-mute">loading…</p>
          )}
          {filtered.length === 0 && !loading && !error && (
            <p className="mt-2 text-[12px] text-octo-verdigris">
              Backlog clear ✓
            </p>
          )}
          <div className="mt-1">
            {filtered.map((it) => (
              <button
                key={it.key}
                type="button"
                role="button"
                onClick={() => ipc.openFileInSystem(it.url).catch(() => {})}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onTicketContextMenu?.(it, e.clientX, e.clientY);
                }}
                className="flex w-full items-center gap-2 rounded px-1 py-[5px] text-left transition-colors duration-[220ms] ease-[cubic-bezier(0.2,0.8,0.3,1)] hover:bg-octo-panel-2"
                style={{ borderLeft: "1px solid transparent" }}
              >
                <span
                  aria-label={it.statusCategory}
                  className={`h-[6px] w-[6px] rounded-full ${STATUS_DOT_COLOR[it.statusCategory]}`}
                  style={{ background: "currentColor" }}
                />
                <span className="flex-shrink-0 font-mono text-[11px] text-octo-ivory">{it.key}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-octo-sage">{it.summary}</span>
                <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-octo-mute">
                  {it.statusName}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
