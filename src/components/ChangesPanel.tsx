import { useEffect, useState } from "react";
import {
  GitBranch,
  FilePlus,
  FileEdit,
  FileX,
  FileMinus,
  ArrowUpRight,
} from "lucide-react";
import { ipc } from "../lib/ipc";
import type { FileChange, GitStatus } from "../lib/types";

interface Props {
  projectPath: string;
  diff: string;
}

const POLL_MS = 5_000;

type TabView = "files" | "diffs";

export function ChangesPanel({ projectPath, diff }: Props) {
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [activeTab, setActiveTab] = useState<TabView>("files");
  const [commitMessage, setCommitMessage] = useState("");

  async function refresh() {
    try {
      const status = await ipc.getGitStatus(projectPath);
      setGitStatus(status);
    } catch {
      // silently ignore — project may not be a git repo yet
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  // Count +/- lines from the diff, excluding the `+++ b/file` and `--- a/file`
  // header lines that git emits at the start of each file section.
  const diffLineCount = diff
    ? diff
        .split("\n")
        .filter((l) => {
          if (l.startsWith("+++") || l.startsWith("---")) return false;
          return l.startsWith("+") || l.startsWith("-");
        }).length
    : 0;

  const files = gitStatus?.changedFiles ?? [];
  const branch = gitStatus?.branch ?? null;
  const ahead = gitStatus?.ahead ?? 0;
  const behind = gitStatus?.behind ?? 0;

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col overflow-hidden border-l border-octo-border bg-octo-panel">
      {/* Header */}
      <header className="border-b border-octo-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <GitBranch size={14} className="text-octo-accent" />
          Changes
        </div>
        {branch && (
          <div className="mt-1.5 flex items-center gap-2">
            <span className="rounded-md bg-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-300">
              {branch}
            </span>
            {(ahead > 0 || behind > 0) && (
              <span className="flex items-center gap-1 text-[10px] text-zinc-500">
                {ahead > 0 && (
                  <span className="text-octo-success">+{ahead}</span>
                )}
                {behind > 0 && (
                  <span className="text-octo-danger">-{behind}</span>
                )}
              </span>
            )}
          </div>
        )}
      </header>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-octo-border px-3 py-1.5">
        <TabButton
          active={activeTab === "diffs"}
          onClick={() => setActiveTab("diffs")}
        >
          Diffs {diffLineCount}
        </TabButton>
        <TabButton
          active={activeTab === "files"}
          onClick={() => setActiveTab("files")}
        >
          Files {files.length}
        </TabButton>
      </div>

      {/* Scrollable content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeTab === "files" && (
          <FileList files={files} />
        )}
        {activeTab === "diffs" && (
          <DiffViewer diff={diff} />
        )}
      </div>

      {/* Bottom actions */}
      <div className="border-t border-octo-border p-3 space-y-2">
        <input
          type="text"
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder="Commit message"
          className="w-full rounded-md border border-octo-border bg-octo-bg px-3 py-1.5 text-xs text-zinc-300 placeholder-zinc-600 outline-none focus:border-zinc-600 transition-colors"
        />
        <button
          disabled
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-octo-border bg-zinc-800/50 px-3 py-1.5 text-xs text-zinc-500 cursor-not-allowed opacity-60"
        >
          <ArrowUpRight size={12} />
          Publish Branch
        </button>
      </div>
    </aside>
  );
}

// ─── Tab Button ────────────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "rounded px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-zinc-800 text-zinc-200"
          : "text-zinc-500 hover:text-zinc-300",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

// ─── File List ──────────────────────────────────────────────────────

function FileList({ files }: { files: FileChange[] }) {
  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-xs text-zinc-600">
        <GitBranch size={20} className="opacity-40" />
        No changes detected
      </div>
    );
  }

  return (
    <ul className="py-1">
      {files.map((file) => (
        <li
          key={file.path}
          className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-zinc-800/40 transition-colors"
        >
          <FileStatusIcon status={file.status} />
          <span className="flex-1 truncate font-mono text-zinc-300" title={file.path}>
            {shortenPath(file.path)}
          </span>
          <StatusBadge status={file.status} />
        </li>
      ))}
    </ul>
  );
}

function FileStatusIcon({ status }: { status: FileChange["status"] }) {
  const props = { size: 13 };
  switch (status) {
    case "new":
      return <FilePlus {...props} className="shrink-0 text-octo-success" />;
    case "modified":
      return <FileEdit {...props} className="shrink-0 text-octo-warning" />;
    case "deleted":
      return <FileX {...props} className="shrink-0 text-octo-danger" />;
    case "renamed":
      return <FileMinus {...props} className="shrink-0 text-blue-400" />;
    default:
      return <FileEdit {...props} className="shrink-0 text-zinc-500" />;
  }
}

function StatusBadge({ status }: { status: FileChange["status"] }) {
  const colorMap: Record<FileChange["status"], string> = {
    new: "text-octo-success",
    modified: "text-octo-warning",
    deleted: "text-octo-danger",
    renamed: "text-blue-400",
    unknown: "text-zinc-500",
  };
  return (
    <span className={`uppercase tracking-wide text-[9px] ${colorMap[status]}`}>
      {status[0].toUpperCase()}
    </span>
  );
}

function shortenPath(filePath: string): string {
  // Show last 2 segments for readability
  const parts = filePath.split("/");
  if (parts.length <= 2) return filePath;
  return "…/" + parts.slice(-2).join("/");
}

// ─── Diff Viewer ────────────────────────────────────────────────────

function DiffViewer({ diff }: { diff: string }) {
  if (!diff) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-xs text-zinc-600">
        <GitBranch size={20} className="opacity-40" />
        No diff available
      </div>
    );
  }

  const lines = diff.split("\n");

  return (
    <div className="overflow-x-auto">
      <pre className="font-mono text-xs leading-relaxed">
        {lines.map((line, i) => (
          <DiffLine key={i} line={line} />
        ))}
      </pre>
    </div>
  );
}

function DiffLine({ line }: { line: string }) {
  if (line.startsWith("@@")) {
    return (
      <div className="bg-blue-950/30 px-3 text-blue-400">{line}</div>
    );
  }
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return (
      <div className="bg-green-950/30 px-3 text-green-300">{line}</div>
    );
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return (
      <div className="bg-red-950/30 px-3 text-red-300">{line}</div>
    );
  }
  return (
    <div className="px-3 text-zinc-400">{line}</div>
  );
}
