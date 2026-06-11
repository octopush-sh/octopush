import { useMemo } from "react";
import { ipc } from "../lib/ipc";
import type { Issue, StatusCategory } from "../lib/types";
import { selectElsewhereIssues, issueTypeToken } from "../lib/issueTrackerSelectors";
import { ModalShell } from "./ModalShell";

const STATUS_DOT: Record<StatusCategory, string> = {
  todo: "text-octo-mute",
  inProgress: "text-state-blue",
  done: "text-octo-verdigris",
  unknown: "text-octo-sage",
};

interface Props {
  issues: Issue[];
  activeProjectKey: string | null;
  onClose: () => void;
}

export function ElsewhereModal({ issues, activeProjectKey, onClose }: Props) {
  // Same in-progress-elsewhere set the footer counts (selectElsewhereIssues)
  // — the modal's rows always sum to the footer's number.
  const grouped = useMemo(() => {
    const map = new Map<string, Issue[]>();
    for (const it of selectElsewhereIssues(issues, activeProjectKey)) {
      const prefix = it.key.split("-")[0];
      const list = map.get(prefix) ?? [];
      list.push(it);
      map.set(prefix, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [issues, activeProjectKey]);

  return (
    <ModalShell onClose={onClose} ariaLabel="Tickets elsewhere">
      <div className="flex max-h-[80vh] w-[640px] flex-col rounded-md border border-octo-hairline bg-octo-panel">
        <div className="flex items-center justify-between border-b border-octo-hairline px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">
            Tickets elsewhere
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute hover:text-octo-brass"
          >
            ESC
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-3">
          {grouped.length === 0 && (
            <p className="text-[12px] text-octo-mute">Nothing in-progress elsewhere.</p>
          )}
          {grouped.map(([prefix, items]) => (
            <div key={prefix} className="mb-4">
              <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">
                {prefix}
              </div>
              {items.map((it) => (
                <button
                  key={it.key}
                  type="button"
                  onClick={() => ipc.openFileInSystem(it.url).catch(() => {})}
                  className="flex w-full items-center gap-2 rounded px-1 py-[5px] text-left transition-colors duration-[220ms] hover:bg-octo-panel-2"
                >
                  <span
                    aria-label={it.statusCategory}
                    className={`h-[6px] w-[6px] rounded-full ${STATUS_DOT[it.statusCategory]}`}
                    style={{ background: "currentColor" }}
                  />
                  <span className={`font-mono text-[11px] ${issueTypeToken(it)}`}>{it.key}</span>
                  <span className="flex-1 truncate text-[12px] text-octo-sage" title={it.summary}>
                    {it.summary}
                  </span>
                  <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-octo-mute">
                    {it.statusName}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </ModalShell>
  );
}
