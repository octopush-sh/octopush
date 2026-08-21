import { useEffect } from "react";
import { Copy, GitBranch, Hammer, Shield } from "lucide-react";
import { INTENT_ICON } from "../lib/missionIntent";
import type { GitStatus, Issue, Pr, PrState, StatusCategory, Workspace } from "../lib/types";
import { useParentIssuesStore } from "../stores/parentIssuesStore";
import { useActiveIssue } from "../hooks/useActiveIssue";
import { ipc } from "../lib/ipc";
import { issueTypeToken } from "../lib/issueTrackerSelectors";
import { detectIssueKeyForProject } from "../lib/detectIssueKey";
import { copyToClipboard } from "../lib/clipboard";
import { MidTruncate } from "./primitives/MidTruncate";

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

/** Mute `·` between eyebrow atoms. Never a connector glyph — `⟶` is retired. */
function Sep() {
  return (
    <span className="flex-none text-octo-mute" aria-hidden>
      ·
    </span>
  );
}

/** One clickable ticket key, type-tinted, opening that issue in the tracker. */
function IssueKey({ issue }: { issue: Issue }) {
  return (
    <button
      type="button"
      aria-label={`Open ${issue.key} in Jira`}
      title={
        `${issue.issueType.toUpperCase()}` +
        (issue.priority ? ` · ${issue.priority.toUpperCase()}` : "") +
        ` — ${issue.summary}`
      }
      onClick={() => {
        void ipc.openFileInSystem(issue.url).catch(() => {});
      }}
      className={`-mx-0.5 flex-none rounded px-0.5 tracking-[0.14em] ${issueTypeToken(issue)} transition hover:bg-[var(--brass-ghost)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass`}
    >
      {issue.key}
    </button>
  );
}

interface Props {
  workspaceName: string;
  branch: string;
  gitStatus: GitStatus | null;
  pr?: Pr | null;
  /** Called with the PR's html_url when the chip is clicked. Typically
   *  routes through `ipc.openFileInSystem` to launch the browser. */
  onOpenPr?: (url: string) => void;
  /** The active workspace. A manually linked ticket (linkedIssueKey) wins;
   *  otherwise a branch-detected key gated on the project's Jira key
   *  (detectIssueKeyForProject). */
  workspace?: Workspace | null;
  /** Whether the issue tracker is configured. When false, no ticket is
   *  shown even if a key is present — the eyebrow reads "Workspace" and the
   *  name line falls back to the workspace name. */
  issueTrackerConfigured?: boolean;
  /** The active project's configured Jira key. A branch-DETECTED key must
   *  match this prefix to surface a ticket (C5); a manual link still wins
   *  regardless. */
  jiraProjectKey?: string | null;
  /** The active mission's intent (build/fix/…). Opens the eyebrow with a small
   *  mute glyph + label; null falls back to "Workspace". */
  missionIntent?: string | null;
  /** The active mission's execution isolation. `sandbox` adds a mute Shield glyph
   *  to the intent eyebrow. */
  missionExecIsolation?: string | null;
}

/**
 * The workspace identity band — one grammar in both states.
 *
 * A mono EYEBROW carries every piece of meta (mission intent, sandbox posture,
 * the ticket chain, the ticket's status, the branch), and a serif NAME line
 * below carries the single thing you are looking at: the ticket summary, or
 * the workspace name when no ticket resolves. Splitting the band this way is
 * what fixes long branch names: the name line owns the full width and can
 * never be squeezed out by a 160-character branch sitting beside it.
 *
 * Two mechanics keep it honest at any canvas width (design-system §6):
 *   · the branch is MIDDLE-truncated (<MidTruncate>) so its head and its
 *     disambiguating tail both survive, with the full string in a popover;
 *   · the demotion ladder (`.octo-demote*`, `.octo-status-*`) sheds meta in a
 *     fixed order as the header narrows, animating each step's width rather
 *     than unmounting it. The active key and the name line never demote.
 */
export function ContextHeader({
  workspaceName,
  branch,
  gitStatus,
  pr,
  onOpenPr,
  workspace = null,
  issueTrackerConfigured = false,
  jiraProjectKey = null,
  missionIntent = null,
  missionExecIsolation = null,
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

  const base =
    workspace?.fromBranch && workspace.fromBranch !== branch ? workspace.fromBranch : null;
  const IntentIcon = missionIntent ? INTENT_ICON[missionIntent] ?? Hammer : null;
  // The name line: the ticket's summary when one resolves, else the workspace's
  // own name. Keyed so a workspace switch re-runs the entrance.
  const name = activeIssue ? activeIssue.summary : workspaceName;

  return (
    <div className="octo-header my-4 flex items-center gap-4 rounded-md border border-octo-hairline bg-octo-panel px-4 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        {/* Eyebrow — all meta, mono, one line. The height is reserved in every
            state so nothing shifts while missions and issues load. */}
        <div className="flex h-[14px] min-w-0 items-center gap-2 font-mono text-[9px] uppercase tracking-[0.22em] text-octo-mute">
          {IntentIcon ? (
            <span
              className="octo-pop-in flex flex-none items-center gap-1"
              title="Mission intent"
            >
              <IntentIcon size={10} aria-hidden />
              <span>{missionIntent}</span>
            </span>
          ) : (
            // Only when nothing else leads the line. With a ticket resolved the
            // chain leads and a "Workspace" label would just be noise.
            !activeIssue && <span className="flex-none">Workspace</span>
          )}

          {missionExecIsolation === "sandbox" && (
            <span
              title="Sandboxed execution — this mission's agents run write-confined to the workspace"
              className="octo-pop-in flex flex-none items-center"
            >
              <Shield size={10} aria-hidden />
            </span>
          )}

          {activeIssue && (
            <>
              {IntentIcon && <Sep />}
              {grandparentIssue && (
                <span className="octo-demote octo-demote-chain">
                  <IssueKey issue={grandparentIssue} />
                  <Sep />
                </span>
              )}
              {parentIssue && (
                <span className="octo-demote octo-demote-chain">
                  <IssueKey issue={parentIssue} />
                  <Sep />
                </span>
              )}
              <IssueKey issue={activeIssue} />
              <Sep />
              {/* Wide: the status name. Narrow: the category dot it already
                  implies — never both (design-system §9). */}
              <span
                className={`octo-status flex-none ${STATUS_TOKEN[activeIssue.statusCategory]}`}
                title={activeIssue.statusName}
              >
                <span className="octo-status-dot" aria-hidden />
                <span className={`octo-status-text ${STATUS_TOKEN[activeIssue.statusCategory]}`}>
                  {activeIssue.statusName}
                </span>
              </span>
            </>
          )}

          <Sep />

          {/* Branch — middle-truncated chip, full provenance one hover (or one
              Tab) away. Right-anchored: the chip sits in the band's right half,
              so a left-anchored panel would reach past the canvas. */}
          <span className="octo-prov min-w-0">
            <button
              type="button"
              title={branch}
              aria-label={`Branch ${branch}`}
              aria-describedby="octo-branch-provenance"
              className="-mx-1 flex min-w-0 max-w-full items-center gap-1.5 rounded px-1 py-0.5 normal-case tracking-normal text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
            >
              <GitBranch size={11} className="flex-none" aria-hidden />
              <MidTruncate text={branch} tail={12} className="text-[10px]" />
            </button>

            <span
              id="octo-branch-provenance"
              role="tooltip"
              className="octo-prov-pop octo-prov-pop--end"
            >
              <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5">
                <dt className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
                  Branch
                </dt>
                <dd className="flex items-start gap-1.5 font-mono text-[11px] normal-case tracking-normal text-octo-ivory">
                  <span className="octo-selectable break-words">{branch}</span>
                  <button
                    type="button"
                    aria-label="Copy branch name"
                    title="Copy branch name"
                    onClick={() => {
                      void copyToClipboard(branch, "Branch name copied");
                    }}
                    className="mt-px flex flex-none items-center justify-center rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                  >
                    <Copy size={11} />
                  </button>
                </dd>
                {base && (
                  <>
                    <dt className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
                      Base
                    </dt>
                    <dd className="font-mono text-[11px] normal-case tracking-normal text-octo-ivory">
                      <span className="octo-selectable break-words">{base}</span>
                    </dd>
                  </>
                )}
                <dt className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
                  Working tree
                </dt>
                <dd
                  className={`octo-tabular font-mono text-[11px] normal-case tracking-normal ${
                    unstaged > 0 ? "text-octo-verdigris" : "text-octo-sage"
                  }`}
                >
                  {unstaged > 0 ? `${unstaged} changed` : "clean"}
                </dd>
              </dl>
            </span>
          </span>

          {base && (
            <span
              className="octo-demote octo-demote-base normal-case tracking-normal text-[10px] opacity-70"
              title="Base branch this workspace was created from"
            >
              from {base}
            </span>
          )}
        </div>

        {/* Name — the one thing you are looking at. Owns the full width in
            both states; a long branch can no longer squeeze it out. */}
        <div
          key={activeIssue?.key ?? workspaceName}
          title={name}
          className="animate-name-in truncate font-serif text-[15px] leading-tight tracking-[-0.005em] text-octo-ivory"
        >
          {name}
        </div>
      </div>

      <div className="ml-auto flex flex-shrink-0 items-center gap-3">
        <span className="flex items-center gap-2 font-mono text-[10px] text-octo-mute">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-octo-verdigris"
            title={unstaged > 0 ? `${unstaged} files changed in the working tree` : "Working tree clean"}
            aria-hidden
          />
          {unstaged > 0 && <span className="octo-tabular octo-fade-in">{unstaged} unstaged</span>}
        </span>

        {pr && (() => {
          const style = PR_STATE_STYLE[pr.state];
          return (
            <div
              className="group flex items-center gap-1 rounded px-1.5 py-1 pr-1"
              style={{ background: style.bg, border: `1px solid ${style.border}` }}
            >
              <button
                type="button"
                onClick={() => onOpenPr?.(pr.url)}
                title={`${pr.state.charAt(0).toUpperCase() + pr.state.slice(1)} pull request — ${pr.title}`}
                className="flex items-center gap-1.5 rounded px-0.5 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors"
              >
                <span aria-hidden className={style.color} style={{ fontSize: 11, lineHeight: 1 }}>
                  {style.glyph}
                </span>
                <span className={style.color}>PR · #{pr.number}</span>
                <span aria-hidden style={{ fontSize: 9, opacity: 0.6 }}>↗</span>
              </button>
              <button
                type="button"
                aria-label="Copy PR URL"
                title="Copy PR URL"
                onClick={(e) => {
                  e.stopPropagation();
                  void copyToClipboard(pr.url, "PR URL copied");
                }}
                className="flex shrink-0 items-center justify-center rounded p-1 text-octo-mute opacity-0 transition group-hover:opacity-70 hover:!text-octo-brass focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
              >
                <Copy size={11} />
              </button>
            </div>
          );
        })()}

      </div>
    </div>
  );
}
