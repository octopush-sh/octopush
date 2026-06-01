import { useEffect, useState } from "react";
import type { GitStatus, Pr, PrState, Issue, StatusCategory, Workspace } from "../lib/types";
import { ScratchpadIcon } from "./ScratchpadIcon";
import { useScratchpadStore } from "../stores/scratchpadStore";
import { useIssuesStore } from "../stores/issuesStore";
import { useParentIssuesStore } from "../stores/parentIssuesStore";
import { ipc } from "../lib/ipc";
import { resolveLinkage, issueTypeToken } from "../lib/issueTrackerSelectors";

/** Resolve an issue by key — prefers the store, falls back to getIssue() once
 *  per key change. Returns null until an issue is found or the lookup fails. */
function useActiveIssue(key: string | null): Issue | null {
  const storeIssues = useIssuesStore((s) => s.issues);
  const [fallback, setFallback] = useState<Issue | null>(null);
  useEffect(() => {
    setFallback(null);
    if (!key) return;
    const hit = (storeIssues ?? []).find((i) => i.key === key);
    if (hit) return;
    ipc.getIssue(key).then(setFallback).catch(() => setFallback(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!key) return null;
  return storeIssues?.find((i) => i.key === key) ?? fallback;
}

const STATUS_TOKEN: Record<StatusCategory, string> = {
  inProgress: "text-state-blue",
  todo: "text-octo-mute",
  done: "text-octo-verdigris",
  unknown: "text-octo-sage",
};

const PR_STATE_STYLE: Record<PrState, { color: string; bg: string; border: string; glyph: string }> = {
  open: {
    color: "text-octo-brass",
    bg: "var(--brass-ghost)",
    border: "var(--brass-dim)",
    glyph: "●",
  },
  draft: {
    color: "text-octo-mute",
    bg: "rgba(109, 99, 84, 0.12)",
    border: "rgba(109, 99, 84, 0.4)",
    glyph: "◐",
  },
  merged: {
    color: "text-state-purple",
    bg: "var(--state-purple-ghost)",
    border: "var(--state-purple-dim)",
    glyph: "✓",
  },
  closed: {
    color: "text-octo-rouge",
    bg: "var(--rouge-active-bg)",
    border: "var(--rouge-border)",
    glyph: "✕",
  },
};

interface Props {
  workspaceName: string;
  branch: string;
  gitStatus: GitStatus | null;
  pr?: Pr | null;
  /** Called with the PR's html_url when the chip is clicked. Typically
   *  routes through `ipc.openFileInSystem` to launch the browser. */
  onOpenPr?: (url: string) => void;
  /** The active workspace. Used to derive the ticket via resolveLinkage
   *  (manual link wins over branch detection). */
  workspace?: Workspace | null;
  /** Whether the issue tracker is configured. When false, no ticket is
   *  shown even if a key is present — the degraded WORKSPACE block renders. */
  issueTrackerConfigured?: boolean;
  rightSlot?: React.ReactNode;
}

export function ContextHeader({
  workspaceName,
  branch,
  gitStatus,
  pr,
  onOpenPr,
  workspace = null,
  issueTrackerConfigured = false,
  rightSlot,
}: Props) {
  const unstaged = gitStatus?.changedFiles.length ?? 0;
  const toggleScratchpad = useScratchpadStore((s) => s.toggleOpen);
  const linkage = workspace ? resolveLinkage(workspace, branch) : { kind: "unlinked" as const };
  const activeKey =
    linkage.kind === "linked" && issueTrackerConfigured ? linkage.key : null;
  const activeIssue = useActiveIssue(activeKey);

  const parents = useParentIssuesStore((s) => s.parents);
  const loadAncestors = useParentIssuesStore((s) => s.loadAncestors);
  useEffect(() => {
    if (!activeIssue?.parentKey) return;
    const depth = activeIssue.subtask ? 2 : 1;
    void loadAncestors(activeIssue.parentKey, depth);
  }, [activeIssue?.parentKey, activeIssue?.subtask, loadAncestors]);

  // Active ticket parent chain: [grandparent?, parent?] then activeIssue.
  // Sub-tasks get 2 levels (depth 2); non-sub-tasks 1 level.
  const parentIssue =
    activeIssue?.parentKey ? parents[activeIssue.parentKey] : undefined;
  const grandparentIssue =
    activeIssue?.subtask && parentIssue?.parentKey
      ? parents[parentIssue.parentKey]
      : undefined;

  return (
    <div className="m-4 flex items-center gap-4 rounded-xl border border-octo-hairline bg-octo-panel px-4 py-2">
      {activeIssue ? (
        <button
          type="button"
          aria-label="Open ticket in Jira"
          title={
            `${activeIssue.key} · ${activeIssue.issueType.toUpperCase()}` +
            (activeIssue.priority ? ` · ${activeIssue.priority.toUpperCase()}` : "") +
            (parentIssue?.summary
              ? ` · ${parentIssue.issueType}: ${parentIssue.summary}`
              : "") +
            (grandparentIssue?.summary
              ? ` · ${grandparentIssue.issueType}: ${grandparentIssue.summary}`
              : "") +
            ` · ${activeIssue.summary}`
          }
          onClick={() => { void ipc.openFileInSystem(activeIssue.url).catch(() => {}); }}
          className="-mx-1 flex min-w-0 flex-1 items-center gap-2.5 rounded px-1 transition hover:bg-[var(--brass-ghost)]"
        >
          <span className="text-octo-brass" aria-hidden style={{ fontSize: 16, lineHeight: 1 }}>◈</span>
          {grandparentIssue && (
            <>
              <span className={`font-mono text-[12px] ${issueTypeToken(grandparentIssue)}`}>
                {grandparentIssue.key}
              </span>
              <span className="font-mono text-[12px] text-octo-mute" aria-hidden>·</span>
            </>
          )}
          {parentIssue && (
            <>
              <span className={`font-mono text-[12px] ${issueTypeToken(parentIssue)}`}>
                {parentIssue.key}
              </span>
              <span className="font-mono text-[12px] text-octo-mute" aria-hidden>·</span>
            </>
          )}
          <span className={`font-mono text-[12px] ${issueTypeToken(activeIssue)}`}>
            {activeIssue.key}
          </span>
          <span className={`font-mono text-[10px] uppercase tracking-[0.15em] ${STATUS_TOKEN[activeIssue.statusCategory]}`}>
            {activeIssue.statusName}
          </span>
          <span aria-hidden className="h-[14px] w-px bg-octo-hairline" />
          <span className="min-w-0 truncate font-serif text-[15px] leading-tight text-octo-ivory">
            {activeIssue.summary}
          </span>
        </button>
      ) : (
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
            Workspace
          </div>
          <div
            key={workspaceName}
            className="animate-name-in font-serif text-[15px] leading-tight tracking-[-0.005em] text-octo-ivory"
          >
            {workspaceName}
          </div>
        </div>
      )}

      <div className="ml-auto flex flex-shrink-0 items-center gap-4">
        <div className="flex items-center gap-2 font-mono text-[10px] text-octo-mute">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-octo-verdigris" aria-hidden />
          <span>↳ {branch}</span>
          {unstaged > 0 && <span>· {unstaged} unstaged</span>}
        </div>

        {pr && (() => {
          const style = PR_STATE_STYLE[pr.state];
          return (
            <button
              type="button"
              onClick={() => onOpenPr?.(pr.url)}
              title={`${pr.state.charAt(0).toUpperCase() + pr.state.slice(1)} pull request — ${pr.title}`}
              className="flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors"
              style={{ background: style.bg, border: `1px solid ${style.border}` }}
            >
              <span aria-hidden className={style.color} style={{ fontSize: 11, lineHeight: 1 }}>
                {style.glyph}
              </span>
              <span className={style.color}>PR · #{pr.number}</span>
              <span aria-hidden style={{ fontSize: 9, opacity: 0.6 }}>↗</span>
            </button>
          );
        })()}

        {rightSlot && (
          <>
            <span className="h-6 w-px bg-octo-hairline" aria-hidden />
            <div className="flex items-center gap-2">
              <ScratchpadIcon onClick={toggleScratchpad} />
              {rightSlot}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
