import { useEffect } from "react";
import type { GitStatus, Pr, PrState, StatusCategory, Workspace } from "../lib/types";
import { useParentIssuesStore } from "../stores/parentIssuesStore";
import { useActiveIssue } from "../hooks/useActiveIssue";
import { ipc } from "../lib/ipc";
import { issueTypeToken } from "../lib/issueTrackerSelectors";
import { detectIssueKeyForProject } from "../lib/detectIssueKey";

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
  /** The active project's configured Jira key. A branch-DETECTED key must
   *  match this prefix to surface a ticket (C5); a manual link still wins
   *  regardless. */
  jiraProjectKey?: string | null;
}

export function ContextHeader({
  workspaceName,
  branch,
  gitStatus,
  pr,
  onOpenPr,
  workspace = null,
  issueTrackerConfigured = false,
  jiraProjectKey = null,
}: Props) {
  const unstaged = gitStatus?.changedFiles.length ?? 0;
  const manualKey = workspace?.linkedIssueKey ?? null;
  const detectedKey = detectIssueKeyForProject(branch, jiraProjectKey ?? null);
  const resolvedKey = manualKey ?? detectedKey;
  const activeKey = resolvedKey && issueTrackerConfigured ? resolvedKey : null;
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
    <div className="my-4 mr-4 flex items-center gap-4 rounded-md border border-octo-hairline bg-octo-panel px-4 py-2">
      {activeIssue ? (
        <div className="-mx-1 flex min-w-0 flex-1 items-center gap-2.5 rounded px-1">
          <span className="text-octo-brass" aria-hidden style={{ fontSize: 16, lineHeight: 1 }}>◈</span>
          {grandparentIssue && (
            <>
              <button
                type="button"
                aria-label={`Open ${grandparentIssue.key} in Jira`}
                title={`${grandparentIssue.issueType}: ${grandparentIssue.summary}`}
                onClick={() => { void ipc.openFileInSystem(grandparentIssue.url).catch(() => {}); }}
                className={`-mx-0.5 rounded px-0.5 font-mono text-[12px] ${issueTypeToken(grandparentIssue)} transition hover:bg-[var(--brass-ghost)]`}
              >
                {grandparentIssue.key}
              </button>
              <span className="font-mono text-[12px] text-octo-mute" aria-hidden>·</span>
            </>
          )}
          {parentIssue && (
            <>
              <button
                type="button"
                aria-label={`Open ${parentIssue.key} in Jira`}
                title={`${parentIssue.issueType}: ${parentIssue.summary}`}
                onClick={() => { void ipc.openFileInSystem(parentIssue.url).catch(() => {}); }}
                className={`-mx-0.5 rounded px-0.5 font-mono text-[12px] ${issueTypeToken(parentIssue)} transition hover:bg-[var(--brass-ghost)]`}
              >
                {parentIssue.key}
              </button>
              <span className="font-mono text-[12px] text-octo-mute" aria-hidden>·</span>
            </>
          )}
          <button
            type="button"
            aria-label={`Open ${activeIssue.key} in Jira`}
            title={
              `${activeIssue.issueType.toUpperCase()}` +
              (activeIssue.priority ? ` · ${activeIssue.priority.toUpperCase()}` : "") +
              ` — ${activeIssue.summary}`
            }
            onClick={() => { void ipc.openFileInSystem(activeIssue.url).catch(() => {}); }}
            className={`-mx-0.5 rounded px-0.5 font-mono text-[12px] ${issueTypeToken(activeIssue)} transition hover:bg-[var(--brass-ghost)]`}
          >
            {activeIssue.key}
          </button>
          <span className={`font-mono text-[10px] uppercase tracking-[0.15em] ${STATUS_TOKEN[activeIssue.statusCategory]}`}>
            {activeIssue.statusName}
          </span>
          <span aria-hidden className="h-[14px] w-px bg-octo-hairline" />
          <span className="min-w-0 truncate font-serif text-[15px] leading-tight text-octo-ivory">
            {activeIssue.summary}
          </span>
        </div>
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

      </div>
    </div>
  );
}
