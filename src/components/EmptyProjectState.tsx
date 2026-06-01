interface Props {
  projectName: string;
  onCreateWorkspace: () => void;
}

export function EmptyProjectState({ projectName, onCreateWorkspace }: Props) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-mute">
        Project
      </div>
      <div className="font-serif text-[20px] leading-tight tracking-[-0.005em] text-octo-ivory">
        {projectName}
      </div>
      <p className="max-w-md text-[12px] leading-[1.6] text-octo-sage">
        No workspaces here yet. Workspaces are isolated git worktrees — one per task you're working on.
      </p>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={onCreateWorkspace}
          className="rounded-md px-4 py-2 font-serif text-[13px] text-octo-brass transition"
          style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
        >
          Create a workspace
        </button>
      </div>
      <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute">
        Or pick another project from the rail
      </p>
    </div>
  );
}
