import type { GitStatus } from "../lib/types";

interface Props {
  workspaceName: string;
  branch: string;
  gitStatus: GitStatus | null;
}

export function ContextHeader({ workspaceName, branch, gitStatus }: Props) {
  const unstaged = gitStatus?.changedFiles.length ?? 0;

  return (
    <div className="m-4 flex items-center gap-4 rounded-xl border border-octo-hairline bg-octo-panel px-4 py-2">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
          Workspace
        </div>
        <div
          key={workspaceName}
          className="animate-name-in font-serif italic text-[15px] leading-tight tracking-[-0.005em] text-octo-ivory"
        >
          {workspaceName}
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2 font-mono text-[10px] text-octo-mute">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-octo-verdigris" aria-hidden />
        <span>↳ {branch}</span>
        {unstaged > 0 && <span>· {unstaged} unstaged</span>}
      </div>
    </div>
  );
}
