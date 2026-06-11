import { useEffect, useState } from "react";
import type { WorkspaceMode } from "../lib/modes";
import type { Budget, SpendSnapshot, ProjectInfo, Workspace, Issue } from "../lib/types";
import { CompanionContext } from "./CompanionContext";
import { CompanionHistory, type CompanionHistoryChat } from "./CompanionHistory";
import { CompanionTerminals } from "./CompanionTerminals";
import { CompanionFileTree } from "./CompanionFileTree";
import { AiReviewPanel } from "./review/AiReviewPanel";
import { CompanionRuns } from "./CompanionRuns";
import { WorkContextPanel } from "./WorkContextPanel";
import { ElsewhereFooter } from "./ElsewhereFooter";
import { ElsewhereModal } from "./ElsewhereModal";
import { ModeSwitcher } from "./ModeSwitcher";
import { FadeSwap } from "./primitives/FadeSwap";
import { useIssuesStore } from "../stores/issuesStore";
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

interface FileTreeProps {
  rootPath: string;
  rootLabel: string;
  changedPaths: Set<string>;
  onFileClick?: (absPath: string) => void;
}

interface Props {
  mode: WorkspaceMode;
  workspaceId: string | null;
  contextProps: ContextProps;
  historyProps: HistoryProps;
  fileTree?: FileTreeProps;
  workspace: Workspace | null;
  project: ProjectInfo | null;
  issueTrackerConfigured: boolean;
  onBacklogTicketContextMenu?: (issue: Issue, x: number, y: number) => void;
  onModeChange: (next: WorkspaceMode) => void;
  reviewGitDiff?: string;
  onJumpToFile?: (file: string, line: number | null) => void;
}

export function Companion({
  mode,
  workspaceId,
  contextProps,
  historyProps,
  fileTree,
  workspace,
  project,
  issueTrackerConfigured,
  onBacklogTicketContextMenu,
  onModeChange,
  reviewGitDiff,
  onJumpToFile,
}: Props) {
  const issues = useIssuesStore((s) => s.issues);
  const [elsewhereOpen, setElsewhereOpen] = useState(false);

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

  return (
    <aside
      className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-md border border-octo-hairline bg-octo-panel"
      aria-label="Companion"
    >
      <div className="flex items-center justify-center border-b border-octo-hairline px-3 py-2">
        <ModeSwitcher
          mode={mode}
          onChange={onModeChange}
          workspaceId={workspaceId ?? undefined}
        />
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
          persist across modes. flex/min-h-0/flex-1/flex-col preserve the
          review file-tree's h-full height chain. */}
      <FadeSwap swapKey={mode} className="flex min-h-0 flex-1 flex-col">
        {/* Sections are full-bleed so their h-11 eyebrow bars (border-b
            included) align edge-to-edge with the Review/Direct bars — body
            insets live inside each panel, not on this wrapper. */}
        {mode === "talk" && (
          <div className="flex flex-col">
            <CompanionHistory {...historyProps} />
            <CompanionContext {...contextProps} workspaceId={workspaceId ?? undefined} />
          </div>
        )}
        {mode === "run" && workspaceId && (
          <CompanionTerminals workspaceId={workspaceId} />
        )}
        {mode === "review" && (
          <div className="flex min-h-0 flex-1 flex-col">
            {workspaceId && reviewGitDiff !== undefined && (
              <AiReviewPanel
                workspaceId={workspaceId}
                gitDiff={reviewGitDiff}
                onJump={onJumpToFile ?? (() => {})}
              />
            )}
            {fileTree && <CompanionFileTree {...fileTree} />}
          </div>
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
