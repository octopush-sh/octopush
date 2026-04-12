import { useState, useRef, useEffect } from "react";
import { MessageSquare, Terminal, GitBranch, MoreHorizontal, Trash2, Plus, X } from "lucide-react";

export interface WorkspaceTab {
  id: string;
  type: "chat" | "terminal";
  label: string;
  /** For chat tabs: used as workspace_id in chat_messages DB */
  conversationId?: string;
  /** For terminal tabs: PTY session ID */
  sessionId?: string;
}

interface Props {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  activeView: string;
  onSelectTab: (tabId: string) => void;
  onAddChat: () => void;
  onAddTerminal: () => void;
  onCloseTab: (tabId: string) => void;
  onViewChange: (view: "changes") => void;
  onDeleteWorkspace: () => void;
  workspaceName: string;
  branch: string;
}

export function WorkspaceBar({
  tabs,
  activeTabId,
  activeView,
  onSelectTab,
  onAddChat,
  onAddTerminal,
  onCloseTab,
  onViewChange,
  onDeleteWorkspace,
  workspaceName: _workspaceName,
  branch: _branch,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const chatTabs = tabs.filter((t) => t.type === "chat");
  const terminalTabs = tabs.filter((t) => t.type === "terminal");

  const canCloseChat = chatTabs.length > 1;
  const canCloseTerm = terminalTabs.length > 1;

  return (
    <div className="flex h-9 shrink-0 items-center border-b border-octo-border bg-octo-panel/50 px-2">
      {/* Chat tab group */}
      <div className="flex items-center gap-0">
        <MessageSquare size={12} className="mr-1.5 text-zinc-600" />
        {chatTabs.map((tab) => {
          const active = activeTabId === tab.id && activeView === "chat";
          return (
            <button
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              className={`group relative flex items-center gap-1 px-2.5 py-1.5 text-[11px] transition ${
                active
                  ? "border-b-2 border-octo-accent text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <span>{tab.label}</span>
              {canCloseChat && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  className="ml-0.5 hidden cursor-pointer text-[10px] text-zinc-600 hover:text-zinc-300 group-hover:inline"
                >
                  <X size={10} />
                </span>
              )}
            </button>
          );
        })}
        <button
          onClick={onAddChat}
          className="px-1.5 py-1.5 text-zinc-600 transition hover:text-zinc-400"
          title="New chat"
        >
          <Plus size={12} />
        </button>
      </div>

      {/* Divider */}
      <div className="mx-2 h-4 w-px bg-octo-border" />

      {/* Terminal tab group */}
      <div className="flex items-center gap-0">
        <Terminal size={12} className="mr-1.5 text-zinc-600" />
        {terminalTabs.map((tab) => {
          const active = activeTabId === tab.id && activeView === "terminal";
          return (
            <button
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              className={`group relative flex items-center gap-1 px-2.5 py-1.5 text-[11px] transition ${
                active
                  ? "border-b-2 border-octo-accent text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <span>{tab.label}</span>
              {canCloseTerm && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  className="ml-0.5 hidden cursor-pointer text-[10px] text-zinc-600 hover:text-zinc-300 group-hover:inline"
                >
                  <X size={10} />
                </span>
              )}
            </button>
          );
        })}
        <button
          onClick={onAddTerminal}
          className="px-1.5 py-1.5 text-zinc-600 transition hover:text-zinc-400"
          title="New terminal"
        >
          <Plus size={12} />
        </button>
      </div>

      {/* Divider */}
      <div className="mx-2 h-4 w-px bg-octo-border" />

      {/* Changes (singleton) */}
      <button
        onClick={() => onViewChange("changes")}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] transition ${
          activeView === "changes"
            ? "border-b-2 border-octo-accent text-zinc-100"
            : "text-zinc-500 hover:text-zinc-300"
        }`}
      >
        <GitBranch size={12} />
        <span>Changes</span>
      </button>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Menu button */}
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
          title="Workspace actions"
        >
          <MoreHorizontal size={16} />
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-full z-10 mt-1 w-48 rounded-md border border-octo-border bg-octo-panel shadow-xl">
            <button
              onClick={() => {
                setMenuOpen(false);
                onDeleteWorkspace();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-xs text-red-400 transition hover:bg-zinc-800"
            >
              <Trash2 size={14} />
              Delete workspace
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
