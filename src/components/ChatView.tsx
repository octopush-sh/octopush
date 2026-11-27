import { useRef } from "react";
import { ChatCanvas } from "./chat/ChatCanvas";
import { Composer } from "./chat/Composer";
import { LiveProcessPanel } from "./chat/LiveProcessPanel";
import { useEscStopsTurn } from "./chat/talkEscape";

interface Props {
  workspaceId: string;
  workspacePath: string;
  /** Talk is the mode on screen (the canvas stays mounted while hidden).
   *  Esc stops the running turn only then. */
  active?: boolean;
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
 * Esc with the focus in here stops the running turn (`talkEscape`).
 */
export function ChatView({
  workspaceId,
  workspacePath,
  active = true,
  onOpenSettings,
  onOpenInEditor,
  onRunInTerminal,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEscStopsTurn(rootRef, workspaceId, active);
  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <ChatCanvas
        workspaceId={workspaceId}
        workspacePath={workspacePath}
        onOpenSettings={onOpenSettings}
        onOpenInEditor={onOpenInEditor}
        onRunInTerminal={onRunInTerminal}
      />
      <LiveProcessPanel workspaceId={workspaceId} />
      <div className="shrink-0 border-t border-octo-hairline bg-octo-panel">
        <Composer workspaceId={workspaceId} workspacePath={workspacePath} />
      </div>
    </div>
  );
}
