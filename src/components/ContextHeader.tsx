import type { GitStatus, OpenPr } from "../lib/types";

interface Props {
  projectName: string;
  onOpenProjectSwitcher: () => void;
  workspaceName: string;
  branch: string;
  gitStatus: GitStatus | null;
  /** Open PR for the current branch, if any. Renders a brass chip next to
   *  the workspace status pill. */
  openPr?: OpenPr | null;
  /** Called with the PR's html_url when the chip is clicked. Typically
   *  routes through `ipc.openFileInSystem` to launch the browser. */
  onOpenPr?: (url: string) => void;
  /** Right-side slot — typically the mode switcher (TALK · RUN · REVIEW).
   *  Lives inside ContextHeader so the entire top of the app reads as one
   *  unified header band, rather than two floating cards in separate
   *  columns. */
  rightSlot?: React.ReactNode;
}

export function ContextHeader({
  projectName,
  onOpenProjectSwitcher,
  workspaceName,
  branch,
  gitStatus,
  openPr,
  onOpenPr,
  rightSlot,
}: Props) {
  const unstaged = gitStatus?.changedFiles.length ?? 0;

  return (
    <div className="m-4 flex items-center gap-4 rounded-xl border border-octo-hairline bg-octo-panel px-4 py-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        {/* Project chip — sits above the workspace row */}
        <button
          type="button"
          onClick={onOpenProjectSwitcher}
          aria-label="Switch project"
          className="group flex w-fit items-center gap-1.5 rounded px-1 -mx-1 transition hover:bg-[var(--brass-ghost)]"
        >
          <span className="font-mono text-[8px] uppercase tracking-[0.3em] text-octo-brass">
            Project
          </span>
          <span className="font-serif text-[13px] leading-none text-octo-ivory">
            {projectName}
          </span>
          <span className="font-mono text-[9px] text-octo-mute transition group-hover:text-octo-brass">
            ▾
          </span>
        </button>

        {/* Workspace row — primary identity */}
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
            Workspace
          </div>
          <div
            key={workspaceName}
            className="animate-name-in font-serif text-[15px] leading-tight tracking-[-0.005em] text-octo-ivory"
          >
            {workspaceName}
          </div>
        </div>
      </div>

      <div className="ml-auto flex items-center gap-4">
        <div className="flex items-center gap-2 font-mono text-[10px] text-octo-mute">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-octo-verdigris" aria-hidden />
          <span>↳ {branch}</span>
          {unstaged > 0 && <span>· {unstaged} unstaged</span>}
        </div>

        {openPr && (
          <button
            type="button"
            onClick={() => onOpenPr?.(openPr.url)}
            title={`${openPr.isDraft ? "Draft" : "Open"} pull request — ${openPr.title}`}
            className="flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-brass transition-colors"
            style={{
              background: "var(--brass-ghost)",
              border: "1px solid var(--brass-dim)",
            }}
          >
            <span aria-hidden style={{ fontSize: 11, lineHeight: 1 }}>
              {openPr.isDraft ? "◐" : "●"}
            </span>
            <span>PR · #{openPr.number}</span>
            <span aria-hidden style={{ fontSize: 9, opacity: 0.6 }}>
              ↗
            </span>
          </button>
        )}

        {rightSlot && (
          <>
            <span className="h-6 w-px bg-octo-hairline" aria-hidden />
            {rightSlot}
          </>
        )}
      </div>
    </div>
  );
}
