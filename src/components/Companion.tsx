import { useState } from "react";
import type { WorkspaceMode } from "../lib/modes";
import type { Budget, SpendSnapshot, ProjectInfo, Workspace } from "../lib/types";
import { CompanionContext } from "./CompanionContext";
import { CompanionHistory, type CompanionHistoryChat } from "./CompanionHistory";
import { CompanionTerminals } from "./CompanionTerminals";
import { CompanionFileTree } from "./CompanionFileTree";
import { ActiveTicketPanel } from "./ActiveTicketPanel";
import { BacklogPanel } from "./BacklogPanel";
import { ElsewhereFooter } from "./ElsewhereFooter";
import { ElsewhereModal } from "./ElsewhereModal";
import { useIssuesStore } from "../stores/issuesStore";
import {
  resolveLinkage,
  resolveJiraProjectKey,
  selectElsewhereCount,
} from "../lib/issueTrackerSelectors";

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
}: Props) {
  const { issues } = useIssuesStore();
  const [elsewhereOpen, setElsewhereOpen] = useState(false);

  const branch = workspace?.branch ?? "";
  const linkage = workspace ? resolveLinkage(workspace, branch) : { kind: "unlinked" as const };
  const projectKey =
    workspace && project ? resolveJiraProjectKey(project, workspace, branch) : null;
  const activeKey = linkage.kind === "linked" ? linkage.key : null;
  const activeIssue =
    activeKey ? (issues ?? []).find((i) => i.key === activeKey) ?? null : null;
  const elsewhereCount = selectElsewhereCount(issues ?? [], projectKey);

  // Gate: only show Jira panels when tracker is configured AND we have a
  // resolved project key. If projectKey is null, the project is not linked to
  // any Jira project — render nothing Jira-related.
  const showJiraBlock = issueTrackerConfigured && workspace !== null && project !== null && projectKey !== null;

  return (
    <aside
      className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-xl border border-octo-hairline bg-octo-panel"
      aria-label="Companion"
    >
      {showJiraBlock && (
        <>
          {linkage.kind === "linked" && (
            <ActiveTicketPanel
              state={linkage}
              activeIssue={activeIssue}
              issuesLoaded={issues !== null}
              candidates={issues ?? []}
              projectKey={projectKey}
              workspaceId={workspace!.id}
              projectId={workspace!.projectId}
            />
          )}
          <BacklogPanel
            configured={issueTrackerConfigured}
            projectKey={projectKey}
            activeKey={activeKey}
          />
          {elsewhereCount > 0 && (
            <ElsewhereFooter count={elsewhereCount} onOpen={() => setElsewhereOpen(true)} />
          )}
        </>
      )}

      {/* Mode-specific content (unchanged behavior) */}
      {mode === "talk" && (
        <div className="flex flex-col gap-4 p-4">
          <CompanionContext {...contextProps} workspaceId={workspaceId ?? undefined} />
          <CompanionHistory {...historyProps} />
        </div>
      )}
      {mode === "run" && workspaceId && (
        <div className="p-4">
          <CompanionTerminals workspaceId={workspaceId} />
        </div>
      )}
      {mode === "review" && fileTree && <CompanionFileTree {...fileTree} />}

      {elsewhereOpen && (
        <ElsewhereModal
          issues={issues ?? []}
          activeProjectKey={projectKey}
          onClose={() => setElsewhereOpen(false)}
        />
      )}
    </aside>
  );
}
