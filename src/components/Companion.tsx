import { useEffect, useState } from "react";
import { PanelRightClose, PanelRightOpen, SquareTerminal, MessagesSquare, GitCompare, Workflow } from "lucide-react";
import { MODES, MODE_LABELS, type WorkspaceMode } from "../lib/modes";
import type { Budget, SpendSnapshot, ProjectInfo, Workspace, Issue, GitStatus } from "../lib/types";
import { CompanionContext } from "./CompanionContext";
import { CompanionReview } from "./CompanionReview";
import { CompanionHistory, type CompanionHistoryChat } from "./CompanionHistory";
import { CompanionTerminals } from "./CompanionTerminals";
import { CompanionRuns } from "./CompanionRuns";
import { WorkContextPanel } from "./WorkContextPanel";
import { ElsewhereFooter } from "./ElsewhereFooter";
import { ElsewhereModal } from "./ElsewhereModal";
import { ModeSwitcher } from "./ModeSwitcher";
import { FadeSwap } from "./primitives/FadeSwap";
import { useIssuesStore } from "../stores/issuesStore";
import { useAttentionStore } from "../stores/attentionStore";
import { selectElsewhereCount } from "../lib/issueTrackerSelectors";
import { detectIssueKeyForProject } from "../lib/detectIssueKey";

interface ContextProps {
  tokensUsed: number;
  tokensLimit: number;
  unstaged: number;
  toolCalls: number;
  budgets?: Budget[];
  spend?: Record<string, SpendSnapshot>;
}

interface HistoryProps {
  chats: CompanionHistoryChat[];
  activeChatId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
}

interface Props {
  mode: WorkspaceMode;
  workspaceId: string | null;
  contextProps: ContextProps;
  historyProps: HistoryProps;
  workspace: Workspace | null;
  project: ProjectInfo | null;
  issueTrackerConfigured: boolean;
  onBacklogTicketContextMenu?: (issue: Issue, x: number, y: number) => void;
  onModeChange: (next: WorkspaceMode) => void;
  /** Review-mode context for the companion cockpit (scope, provenance, sync). */
  reviewProps?: { gitStatus: GitStatus | null; gitDiff: string; workspacePath: string } | null;
  /** Jump to a file in the diff from the companion (e.g. a provenance chip). */
  onJumpToFile?: (file: string, line: number | null) => void;
  /** Collapsed state is owned by the parent (App), mirroring the rail. When
   *  collapsed the companion shrinks to a slim strip that still carries the
   *  mode switcher, so the user trades panel content for canvas room. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

/** Icons for the collapsed-strip mode switcher (the expanded switcher is text). */
const MODE_ICONS: Record<WorkspaceMode, typeof SquareTerminal> = {
  run: SquareTerminal,
  talk: MessagesSquare,
  review: GitCompare,
  direct: Workflow,
};

export function Companion({
  mode,
  workspaceId,
  contextProps,
  historyProps,
  workspace,
  project,
  issueTrackerConfigured,
  onBacklogTicketContextMenu,
  onModeChange,
  reviewProps,
  onJumpToFile,
  collapsed,
  onToggleCollapsed,
}: Props) {
  const issues = useIssuesStore((s) => s.issues);
  const [elsewhereOpen, setElsewhereOpen] = useState(false);

  // In-workspace attention: pulse the Run/Talk icon when a chat/terminal in
  // this workspace needs the eye and the user is in a different mode — the same
  // signal the expanded ModeSwitcher gives, preserved while collapsed.
  const attentionFlag = useAttentionStore((s) => (workspaceId ? s.flagsByWs[workspaceId] : undefined));
  const flagMode: WorkspaceMode | null =
    attentionFlag?.kind === "chat" ? "talk" : attentionFlag?.kind === "terminal" ? "run" : null;

  // The elsewhere list is scoped to the current project — never let an
  // open modal survive a project switch and show stale context.
  const projectId = project?.id ?? null;
  useEffect(() => {
    setElsewhereOpen(false);
  }, [projectId]);

  const branch = workspace?.branch ?? "";
  const manualKey = workspace?.linkedIssueKey ?? null;
  const detectedKey = detectIssueKeyForProject(branch, project?.jiraProjectKey ?? null);
  const activeKey = manualKey ?? detectedKey;
  // Backlog project key: the configured key, else a manually-linked ticket's
  // prefix. A key guessed from an arbitrary branch name is NOT used (C5).
  const projectKey =
    project?.jiraProjectKey ?? (manualKey ? manualKey.split("-")[0] : null);
  const elsewhereCount = selectElsewhereCount(issues ?? [], projectKey);

  // Gate: only show Jira panels when tracker is configured AND we have a
  // resolved project key. If projectKey is null, the project is not linked to
  // any Jira project — render nothing Jira-related.
  const showJiraBlock = issueTrackerConfigured && workspace !== null && project !== null && projectKey !== null;

  // ── Collapsed strip — slim, like the workspace rail ─────────────
  if (collapsed) {
    return (
      <aside
        className="flex h-full min-h-0 flex-col items-center gap-1 rounded-md border border-octo-hairline bg-octo-panel py-2"
        aria-label="Companion"
      >
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Expand companion"
          title="Expand companion"
          className="flex h-7 w-7 items-center justify-center rounded text-octo-mute transition-colors hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          <PanelRightOpen size={16} />
        </button>
        <div className="mt-1 h-px w-5 bg-octo-hairline" aria-hidden />
        <div className="mt-1 flex flex-col items-center gap-1.5">
          {MODES.map((m) => {
            const Icon = MODE_ICONS[m];
            const active = m === mode;
            const pulse = flagMode === m && !active;
            return (
              <button
                key={m}
                type="button"
                onClick={() => onModeChange(m)}
                aria-pressed={active}
                aria-label={pulse ? `${MODE_LABELS[m]} — needs your attention` : MODE_LABELS[m]}
                title={pulse ? `${MODE_LABELS[m]} needs your attention` : MODE_LABELS[m]}
                className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass ${
                  active
                    ? "text-octo-brass"
                    : pulse
                      ? "animate-attention-pulse !text-octo-brass border-transparent"
                      : "border-transparent text-octo-mute hover:text-octo-sage"
                }`}
                style={
                  active
                    ? { background: "var(--brass-ghost)", borderColor: "var(--brass-dim)" }
                    : undefined
                }
              >
                <Icon size={15} />
              </button>
            );
          })}
        </div>
      </aside>
    );
  }

  // ── Expanded panel ──────────────────────────────────────────────
  return (
    <aside
      className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-md border border-octo-hairline bg-octo-panel"
      aria-label="Companion"
    >
      <div className="relative flex items-center justify-center border-b border-octo-hairline px-3 py-2">
        <ModeSwitcher
          mode={mode}
          onChange={onModeChange}
          workspaceId={workspaceId ?? undefined}
        />
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Collapse companion"
          title="Collapse companion"
          className="absolute right-2 flex h-7 w-7 items-center justify-center rounded text-octo-mute transition-colors hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          <PanelRightClose size={16} />
        </button>
      </div>

      {showJiraBlock && (
        <>
          <WorkContextPanel
            configured={issueTrackerConfigured}
            projectKey={projectKey}
            projectId={projectId}
            defaultCollapsed={mode !== "talk"}
            activeKey={activeKey}
            onTicketContextMenu={onBacklogTicketContextMenu}
          />
          {elsewhereCount > 0 && (
            <ElsewhereFooter count={elsewhereCount} onOpen={() => setElsewhereOpen(true)} />
          )}
        </>
      )}

      {/* Mode-specific content — crossfades (exit 120ms, then enter) when the
          mode changes, following the gliding ModeSwitcher indicator. The
          shared header and Jira block above stay outside this wrapper so they
          persist across modes. Review mode shows a "change intelligence"
          cockpit (readiness, provenance, branch/publish) — the Changes/Files
          navigator lives on the left and AI review inside the diff, so the
          companion answers the questions those surfaces can't. */}
      <FadeSwap swapKey={mode} className="flex min-h-0 flex-1 flex-col">
        {mode === "talk" && (
          <div className="flex flex-col">
            <CompanionHistory {...historyProps} />
            <CompanionContext {...contextProps} workspaceId={workspaceId ?? undefined} />
          </div>
        )}
        {mode === "run" && workspaceId && (
          <CompanionTerminals workspaceId={workspaceId} />
        )}
        {mode === "review" && workspaceId && reviewProps && (
          <CompanionReview
            workspaceId={workspaceId}
            workspacePath={reviewProps.workspacePath}
            gitStatus={reviewProps.gitStatus}
            gitDiff={reviewProps.gitDiff}
            onJump={onJumpToFile}
          />
        )}
        {mode === "direct" && workspaceId && (
          <CompanionRuns workspaceId={workspaceId} />
        )}
      </FadeSwap>

      {showJiraBlock && elsewhereOpen && (
        <ElsewhereModal
          issues={issues ?? []}
          activeProjectKey={projectKey}
          onClose={() => setElsewhereOpen(false)}
        />
      )}
    </aside>
  );
}
