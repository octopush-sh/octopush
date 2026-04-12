import { useState, useRef, useEffect } from "react";
import { MessageSquare, Terminal, GitBranch, MoreHorizontal, Trash2, Plus, X } from "lucide-react";

export interface WorkspaceTab {
  id: string;
  type: "chat" | "terminal";
  label: string;
  conversationId?: string;
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
  onViewChange: (view: "chat" | "terminal" | "changes") => void;
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
  const termTabs = tabs.filter((t) => t.type === "terminal");

  // Show subtabs for the active category
  const activeTabs = activeView === "chat" ? chatTabs : activeView === "terminal" ? termTabs : [];
  const canClose = activeTabs.length > 1;
  const onAdd = activeView === "chat" ? onAddChat : activeView === "terminal" ? onAddTerminal : null;

  return (
    <div className="shrink-0">
      {/* Level 1: Category tabs */}
      <div className="flex h-9 items-center border-b border-octo-border bg-octo-panel/50 px-3">
        <CategoryTab
          icon={<MessageSquare size={13} />}
          label="Chat"
          shortcut="⌘⇧C"
          active={activeView === "chat"}
          onClick={() => onViewChange("chat")}
        />
        <CategoryTab
          icon={<Terminal size={13} />}
          label="Terminal"
          shortcut="⌘T"
          active={activeView === "terminal"}
          onClick={() => onViewChange("terminal")}
        />
        <CategoryTab
          icon={<GitBranch size={13} />}
          label="Changes"
          shortcut="⌘⇧G"
          active={activeView === "changes"}
          onClick={() => onViewChange("changes")}
        />

        <div className="flex-1" />

        {/* Menu */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
          >
            <MoreHorizontal size={16} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-10 mt-1 w-48 rounded-md border border-octo-border bg-octo-panel shadow-xl">
              <button
                onClick={() => { setMenuOpen(false); onDeleteWorkspace(); }}
                className="flex w-full items-center gap-2 px-3 py-2 text-xs text-red-400 transition hover:bg-zinc-800"
              >
                <Trash2 size={14} />
                Delete workspace
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Level 2: Subtabs — only for Chat and Terminal when they have content */}
      {(activeView === "chat" || activeView === "terminal") && (
        <div className="flex h-7 items-center gap-0 border-b border-octo-border/50 bg-octo-bg px-3">
          {activeTabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <button
                key={tab.id}
                onClick={() => onSelectTab(tab.id)}
                className={`group flex items-center gap-1 rounded-t px-2.5 py-1 text-[10px] transition ${
                  isActive
                    ? "bg-octo-panel/60 text-zinc-200"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                <span>{tab.label}</span>
                {canClose && (
                  <span
                    onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
                    className="ml-0.5 hidden cursor-pointer text-zinc-600 hover:text-zinc-300 group-hover:inline"
                  >
                    <X size={9} />
                  </span>
                )}
              </button>
            );
          })}
          {onAdd && (
            <button
              onClick={onAdd}
              className="ml-1 rounded p-0.5 text-zinc-600 transition hover:bg-zinc-800 hover:text-zinc-400"
              title={activeView === "chat" ? "New chat" : "New terminal"}
            >
              <Plus size={11} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function CategoryTab({
  icon,
  label,
  shortcut,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-2 text-xs transition ${
        active
          ? "border-b-2 border-octo-accent text-zinc-100"
          : "text-zinc-500 hover:text-zinc-300"
      }`}
      title={shortcut}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
