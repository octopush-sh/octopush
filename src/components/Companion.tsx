import type { WorkspaceMode } from "../lib/modes";
import type { Budget, SpendSnapshot } from "../lib/types";
import { CompanionContext } from "./CompanionContext";
import { CompanionHistory, type CompanionHistoryChat } from "./CompanionHistory";
import { CompanionTerminals } from "./CompanionTerminals";
import { CompanionFileTree } from "./CompanionFileTree";

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
}

export function Companion({
  mode,
  workspaceId,
  contextProps,
  historyProps,
  fileTree,
}: Props) {
  return (
    <aside
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto rounded-xl border border-octo-hairline bg-octo-panel p-4"
      aria-label="Companion"
    >
      {mode === "talk" && (
        <>
          <CompanionContext
            {...contextProps}
            workspaceId={workspaceId ?? undefined}
          />
          <CompanionHistory {...historyProps} />
        </>
      )}
      {mode === "run" && workspaceId && (
        <CompanionTerminals workspaceId={workspaceId} />
      )}
      {mode === "review" && fileTree && (
        <CompanionFileTree {...fileTree} />
      )}
    </aside>
  );
}
