import { useEffect, useState } from "react";
import { ipc } from "../lib/ipc";
import { useIssuesStore } from "../stores/issuesStore";
import { useParentIssuesStore } from "../stores/parentIssuesStore";
import type { Issue } from "../lib/types";
import type { LinkageState } from "../lib/issueTrackerSelectors";
import { InlineTicketPicker } from "./InlineTicketPicker";

interface Props {
  state: LinkageState;
  activeIssue: Issue | null;
  /** True once the global issuesStore has completed at least one load.
   *  Suppresses the "no se pudo cargar" error card during first paint when
   *  the store hasn't returned yet — otherwise a linked workspace flashes
   *  the error + Desvincular button on cold start. */
  issuesLoaded: boolean;
  candidates: Issue[];
  projectKey: string | null;
  workspaceId: string;
}

export function ActiveTicketPanel({ state, activeIssue, issuesLoaded, candidates, projectKey, workspaceId }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [picking, setPicking] = useState(false);
  const parents = useParentIssuesStore((s) => s.parents);
  const loadParent = useParentIssuesStore((s) => s.loadParent);

  useEffect(() => {
    if (activeIssue?.parentKey) void loadParent(activeIssue.parentKey);
  }, [activeIssue?.parentKey, loadParent]);

  async function dismiss() {
    await ipc.updateWorkspaceLink(workspaceId, null, true);
  }
  async function undismiss() {
    await ipc.updateWorkspaceLink(workspaceId, null, false);
  }
  async function unlink() {
    await ipc.updateWorkspaceLink(workspaceId, null, false);
  }
  async function confirmPick(key: string) {
    await ipc.updateWorkspaceLink(workspaceId, key, false);
    setPicking(false);
    // The picked ticket may not be in the global issues list (e.g. it was
    // confirmed via the exact-key fallback for a ticket not assigned to the
    // user). Trigger a single refresh so the card has data immediately.
    void useIssuesStore.getState().load();
  }

  return (
    <div className="border-b border-octo-hairline px-3 py-2">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex flex-1 items-center justify-between font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute"
        >
          <span>§ Active Ticket</span>
          <span className="mr-1">{collapsed ? "▸" : "▾"}</span>
        </button>
      </div>

      {!collapsed && state.kind === "linked" && activeIssue && (
        <div
          className="mt-2 rounded-r p-3"
          style={{ background: "var(--brass-ghost)", borderLeft: "1px solid var(--brass-dim)" }}
        >
          <div className="flex items-center gap-2">
            <span className="text-octo-brass" aria-hidden>◈</span>
            <span className="font-mono text-[12px] text-octo-brass">{activeIssue.key}</span>
            <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.15em] text-octo-mute">
              {activeIssue.statusName}
            </span>
            <button
              type="button"
              aria-label="Open in Jira"
              title="Open in Jira"
              onClick={() => { void Promise.resolve(ipc.openFileInSystem(activeIssue.url)).catch(() => {}); }}
              className="ml-1 font-mono text-[10px] text-octo-mute hover:text-octo-brass"
            >
              ↗
            </button>
          </div>
          <div className="mt-1 text-[13px] leading-tight text-octo-ivory">
            {activeIssue.summary}
          </div>
          <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.1em] text-octo-mute">
            {activeIssue.issueType.toUpperCase()}
            {activeIssue.priority ? ` · ${activeIssue.priority.toUpperCase()}` : ""}
            {activeIssue.parentKey && parents[activeIssue.parentKey] && (
              <>
                {" · "}
                <span className="text-octo-brass">Epic: {parents[activeIssue.parentKey].summary}</span>
              </>
            )}
          </div>
        </div>
      )}

      {!collapsed && state.kind === "linked" && !activeIssue && issuesLoaded && (
        <div
          className="mt-2 rounded-r p-3"
          style={{ background: "var(--brass-ghost)", borderLeft: "1px solid var(--brass-dim)" }}
        >
          <div className="flex items-center gap-2 font-mono text-[12px] text-octo-mute">
            <span className="text-octo-brass">{state.key}</span>
            <span className="text-[10px]">· no se pudo cargar este ticket</span>
            <button
              type="button"
              aria-label="Desvincular"
              onClick={() => void unlink()}
              className="ml-auto font-mono text-[9px] uppercase tracking-[0.15em] text-octo-brass"
            >
              Desvincular
            </button>
          </div>
        </div>
      )}

      {!collapsed && state.kind === "unlinked" && !picking && (
        <div className="mt-2 flex items-center gap-3 text-[12px] text-octo-sage">
          <span>Sin ticket vinculado.</span>
          <button
            type="button"
            aria-label="Vincular"
            onClick={() => setPicking(true)}
            className="font-mono text-[10px] uppercase tracking-[0.15em] text-octo-brass"
          >
            Vincular →
          </button>
          <button
            type="button"
            onClick={() => void dismiss()}
            className="font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute hover:text-octo-brass"
          >
            No usar ticket aquí
          </button>
        </div>
      )}

      {!collapsed && state.kind === "unlinked" && picking && (
        <div className="mt-2">
          <InlineTicketPicker
            candidates={candidates}
            projectKey={projectKey}
            onPick={(key) => void confirmPick(key)}
            onCancel={() => setPicking(false)}
          />
        </div>
      )}

      {!collapsed && state.kind === "dismissed" && (
        <div className="mt-1">
          <button
            type="button"
            aria-label="+ Vincular ticket"
            onClick={() => void undismiss()}
            className="font-mono text-[10px] tracking-[0.1em] text-octo-mute hover:text-octo-brass"
          >
            ↳ + Vincular ticket
          </button>
        </div>
      )}
    </div>
  );
}
