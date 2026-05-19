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
      className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-xl border border-octo-hairline bg-octo-panel"
      aria-label="Companion"
    >
      {/* Talk and Run modes keep the legacy inner padding. Review mode
          uses a flush top-bar (FILES eyebrow) that aligns with the canvas
          toolbar and CHANGES rail eyebrow, so it provides its own
          padding internally. */}
      {mode === "talk" && (
        <div className="flex flex-col gap-4 p-4">
          <CompanionContext
            {...contextProps}
            workspaceId={workspaceId ?? undefined}
          />
          <CompanionHistory {...historyProps} />
        </div>
      )}
      {mode === "run" && workspaceId && (
        <div className="p-4">
          <CompanionTerminals workspaceId={workspaceId} />
        </div>
      )}
      {mode === "review" && fileTree && (
        <CompanionFileTree {...fileTree} />
      )}
    </aside>
  );
}
