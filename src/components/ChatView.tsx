import { ChatCanvas } from "./chat/ChatCanvas";
import { Composer } from "./chat/Composer";

interface Props {
  workspaceId: string;
  workspacePath: string;
  onOpenSettings?: () => void;
  /** Open a file (relative or absolute) in the in-app editor. When provided,
   *  WRITE tool cards show an "Open in editor" button, and bare file paths
   *  rendered in chat messages become clickable links. */
  onOpenInEditor?: (path: string) => void;
  /** Re-run a tool's shell command in the RUN-mode terminal (cross-mode, P9). */
  onRunInTerminal?: (command: string) => void;
}

/**
 * TALK mode host. A thin layout shell composing the conversation timeline
 * (ChatCanvas) above the input (Composer). All chat state lives in
 * `chatStore`; both children read it directly, scoped by workspaceId.
 */
export function ChatView({
  workspaceId,
  workspacePath,
  onOpenSettings,
  onOpenInEditor,
  onRunInTerminal,
}: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatCanvas
        workspaceId={workspaceId}
        workspacePath={workspacePath}
        onOpenSettings={onOpenSettings}
        onOpenInEditor={onOpenInEditor}
        onRunInTerminal={onRunInTerminal}
      />
      <div className="shrink-0 border-t border-octo-hairline bg-octo-panel">
        <Composer workspaceId={workspaceId} workspacePath={workspacePath} />
      </div>
    </div>
  );
}
