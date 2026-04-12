import { useState, useRef, useEffect } from "react";
import { MessageSquare, Terminal, GitBranch, MoreHorizontal, Trash2 } from "lucide-react";

interface Props {
  activeView: string;
  onViewChange: (view: "chat" | "terminal" | "changes") => void;
  onDeleteWorkspace: () => void;
  workspaceName: string;
  branch: string;
}

const tabs = [
  { id: "chat" as const, label: "Chat", icon: MessageSquare, shortcut: "⌘⇧C" },
  { id: "terminal" as const, label: "Terminal", icon: Terminal, shortcut: "⌘T" },
  { id: "changes" as const, label: "Changes", icon: GitBranch, shortcut: "⌘⇧G" },
];

export function WorkspaceBar({
  activeView,
  onViewChange,
  onDeleteWorkspace,
  workspaceName: _workspaceName,
  branch: _branch,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
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

  return (
    <div className="flex h-9 shrink-0 items-center border-b border-octo-border bg-octo-panel/50 px-2">
      {/* Tabs */}
      <div className="flex items-center gap-0.5">
        {tabs.map((tab) => {
          const active = activeView === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => onViewChange(tab.id)}
              className={`flex items-center gap-1.5 rounded-t px-3 py-1.5 text-xs transition ${
                active
                  ? "border-b-2 border-octo-accent text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <Icon size={14} />
              <span>{tab.label}</span>
              <kbd className="ml-1 hidden text-[10px] text-zinc-600 sm:inline">
                {tab.shortcut}
              </kbd>
            </button>
          );
        })}
      </div>

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
