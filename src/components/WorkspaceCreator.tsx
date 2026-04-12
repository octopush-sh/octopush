import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useWorkspaceStore } from "../stores/workspaceStore";

interface Props {
  projectId: string;
  projectPath: string;
  onCreated: () => void;
  onCancel: () => void;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function WorkspaceCreator({ projectId, projectPath, onCreated, onCancel }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [task, setTask] = useState("");
  const [setupScript, setSetupScript] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useWorkspaceStore((s) => s.create);

  const branch = slugify(task) || "new-workspace";
  const workspaceName = branch;

  async function handleCreate() {
    if (!task.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await create(projectId, projectPath, workspaceName, task.trim(), branch, "main", setupScript);
      onCreated();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  if (step === 1) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-octo-bg">
        <div className="w-full max-w-md px-4">
          {/* Step indicator */}
          <div className="mb-1 text-[10px] uppercase tracking-widest text-zinc-600">
            Step 1 of 2
          </div>

          <h2 className="mb-1 text-xl font-semibold text-zinc-100">
            Create your first workspace
          </h2>
          <p className="mb-6 text-sm text-zinc-500">
            Workspaces are isolated task environments backed by git worktrees.
          </p>

          {/* Task input */}
          <label className="mb-1.5 block text-xs font-medium text-zinc-400">
            Task
          </label>
          <input
            type="text"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && task.trim()) setStep(2);
            }}
            placeholder="e.g. Add dark mode, Fix checkout bug"
            className="w-full rounded-md border border-octo-border bg-octo-panel px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none transition focus:border-octo-accent/50 focus:ring-1 focus:ring-octo-accent/20"
            autoFocus
          />

          {/* Branch preview */}
          <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-600">
            <span className="font-mono text-zinc-400">{branch}</span>
            <span>from</span>
            <span className="font-mono text-zinc-500">main</span>
          </div>

          {/* Advanced options collapsible */}
          <button className="mt-4 flex items-center gap-1 text-xs text-zinc-600 transition hover:text-zinc-400">
            <ChevronDown size={12} />
            Advanced options
          </button>

          {/* Actions */}
          <div className="mt-6 flex justify-end">
            <button
              onClick={onCancel}
              className="mr-3 rounded-md px-4 py-2 text-sm text-zinc-500 transition hover:text-zinc-300"
            >
              Cancel
            </button>
            <button
              onClick={() => setStep(2)}
              disabled={!task.trim()}
              className="rounded-md bg-octo-accent px-4 py-2 text-sm font-medium text-zinc-900 transition hover:bg-octo-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Continue &gt;
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center bg-octo-bg">
      <div className="w-full max-w-md px-4">
        {/* Step indicator */}
        <div className="mb-1 text-[10px] uppercase tracking-widest text-zinc-600">
          Step 2 of 2
        </div>

        <h2 className="mb-1 text-xl font-semibold text-zinc-100">
          Setup script
        </h2>
        <p className="mb-6 text-sm text-zinc-500">
          These commands run automatically when a workspace is created.
        </p>

        {/* Package manager detection notice */}
        <div className="rounded-md border border-octo-border bg-octo-panel px-4 py-3">
          <p className="text-xs text-zinc-500">
            We couldn't detect a package manager or environment config.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => setSetupScript("")}
              className="rounded-md border border-octo-border px-3 py-1.5 text-xs text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200"
            >
              Add commands
            </button>
            <button
              onClick={() => setSetupScript("")}
              className="rounded-md px-3 py-1.5 text-xs text-zinc-600 transition hover:text-zinc-400"
            >
              Skip
            </button>
          </div>
        </div>

        {/* Teardown commands collapsible */}
        <button className="mt-4 flex items-center gap-1 text-xs text-zinc-600 transition hover:text-zinc-400">
          <ChevronDown size={12} />
          Teardown commands (optional)
        </button>

        {error && (
          <div className="mt-4 rounded-md border border-octo-danger/40 bg-octo-danger/10 px-3 py-2 text-xs text-octo-danger">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="mt-6 flex items-center justify-between">
          <button
            onClick={() => setStep(1)}
            className="rounded-md px-4 py-2 text-sm text-zinc-500 transition hover:text-zinc-300"
          >
            &lt; Back
          </button>

          <div className="flex gap-2">
            <button
              onClick={onCreated}
              className="rounded-md px-4 py-2 text-sm text-zinc-500 transition hover:text-zinc-300"
            >
              Skip for now
            </button>
            <button
              onClick={handleCreate}
              disabled={creating || !task.trim()}
              className="rounded-md bg-octo-accent px-4 py-2 text-sm font-medium text-zinc-900 transition hover:bg-octo-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {creating ? "Creating..." : "Create workspace >"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
