import { useState } from "react";
import { BrassRule } from "./BrassRule";
import { useWorkspaceStore } from "../stores/workspaceStore";

interface Props {
  projectId: string;
  projectPath: string;
  onCreated: () => void;
  onCancel: () => void;
}

type Step = 1 | 2;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function WorkspaceCreator({ projectId, projectPath, onCreated, onCancel }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [task, setTask] = useState("");
  const [setupScript, setSetupScript] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useWorkspaceStore((s) => s.create);

  const branch = slugify(task) || "new-workspace";
  const workspaceName = branch;
  const taskValid = task.trim().length > 0;

  async function handleCreate() {
    if (!taskValid) return;
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

  return (
    <div
      data-tauri-drag-region
      className="flex h-full w-full bg-octo-bg"
      style={{
        background:
          "radial-gradient(ellipse at 30% 25%, rgba(212,165,116,0.05), transparent 50%), var(--color-octo-onyx)",
      }}
    >
      {/* Left index pane */}
      <aside className="w-[220px] shrink-0 border-r border-octo-hairline bg-octo-panel px-6 py-10">
        <button
          type="button"
          onClick={onCancel}
          className="mb-10 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute hover:text-octo-sage"
        >
          ← Back
        </button>

        <div className="font-serif italic text-[18px] text-octo-ivory">
          A new workspace
        </div>

        <div className="mt-6 space-y-1">
          <StepIndex active={step === 1} numeral="I" label="Task & intent" onClick={() => setStep(1)} />
          <StepIndex
            active={step === 2}
            numeral="II"
            label="Setup script"
            onClick={() => taskValid && setStep(2)}
            disabled={!taskValid && step !== 2}
          />
        </div>

        <BrassRule className="mt-10 w-7" />
      </aside>

      {/* Right content pane */}
      <main className="flex flex-1 flex-col justify-center px-14 py-10">
        {step === 1 ? (
          <>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
              STEP I · OF II
            </div>
            <h1 className="mt-3 font-serif italic text-[26px] leading-[1.05] tracking-[-0.005em] text-octo-ivory">
              What are you setting out to do?
            </h1>
            <p className="mt-3 max-w-[48ch] text-[13px] leading-[1.6] text-octo-sage">
              A workspace is an isolated task environment backed by a git worktree. The task name becomes the branch.
            </p>

            <div className="mt-8 max-w-[520px]">
              <Field label="TASK">
                <input
                  autoFocus
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && taskValid) setStep(2);
                  }}
                  placeholder="e.g. Add dark mode, Fix checkout bug"
                  className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-sans text-[14px] text-octo-ivory outline-none placeholder:font-serif placeholder:italic placeholder:text-octo-mute focus:border-octo-brass"
                />
              </Field>

              {/* Branch preview */}
              <div className="mt-4 flex items-baseline gap-2 font-mono text-[10px] uppercase tracking-[0.2em]">
                <span className="text-octo-mute">BRANCH</span>
                <span className="text-octo-brass">{branch}</span>
                <span className="text-octo-mute">from</span>
                <span className="text-octo-sage">main</span>
              </div>
            </div>

            <div className="mt-10 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setStep(2)}
                disabled={!taskValid}
                className="rounded-md px-4 py-2 font-serif italic text-[13px] text-octo-brass transition disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
              >
                Continue
              </button>
              <button
                type="button"
                onClick={onCancel}
                className="rounded-md px-3 py-2 text-[12px] text-octo-mute hover:text-octo-sage"
              >
                Cancel
              </button>
              <div className="ml-auto font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
                ↵ to continue
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
              STEP II · OF II
            </div>
            <h1 className="mt-3 font-serif italic text-[26px] leading-[1.05] tracking-[-0.005em] text-octo-ivory">
              How does it start?
            </h1>
            <p className="mt-3 max-w-[48ch] text-[13px] leading-[1.6] text-octo-sage">
              These commands run automatically when the workspace is created. Leave empty to skip.
            </p>

            <div className="mt-8 max-w-[640px]">
              <Field label="SETUP SCRIPT">
                <textarea
                  value={setupScript}
                  onChange={(e) => setSetupScript(e.target.value)}
                  placeholder="npm install"
                  rows={6}
                  className="w-full resize-y rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] leading-[1.6] text-octo-ivory outline-none placeholder:font-mono placeholder:not-italic placeholder:text-octo-mute focus:border-octo-brass"
                />
              </Field>

              <div className="mt-2 font-mono text-[10px] tracking-[0.05em] text-octo-mute">
                Runs inside the new worktree at <span className="text-octo-sage">{projectPath}/.octopus/{branch}</span>.
              </div>
            </div>

            {error && (
              <div
                className="mt-6 max-w-[520px] rounded-md px-3 py-2 text-[12px] text-octo-rouge"
                style={{ borderLeft: "1px solid var(--color-octo-rouge)", background: "rgba(209, 139, 139, 0.08)" }}
              >
                {error}
              </div>
            )}

            <div className="mt-10 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="rounded-md px-3 py-2 text-[12px] text-octo-mute hover:text-octo-sage"
              >
                ← Back
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={!taskValid || creating}
                className="rounded-md px-4 py-2 font-serif italic text-[13px] text-octo-brass transition disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
              >
                {creating ? "Creating…" : "Begin"}
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={creating}
                className="rounded-md px-3 py-2 text-[12px] text-octo-mute hover:text-octo-sage"
                title="Skip the setup script"
              >
                Skip & begin
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function StepIndex({
  active,
  numeral,
  label,
  onClick,
  disabled = false,
}: {
  active: boolean;
  numeral: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-baseline gap-3 py-1.5 text-left disabled:cursor-not-allowed"
    >
      <span
        className={`w-6 font-mono text-[10px] uppercase tracking-[0.2em] ${
          active ? "text-octo-brass" : "text-octo-mute"
        }`}
      >
        {numeral}
      </span>
      <span
        className={
          active
            ? "font-serif italic text-[14px] text-octo-ivory"
            : "font-sans text-[12px] text-octo-mute"
        }
      >
        {label}
      </span>
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">
        {label}
      </div>
      {children}
    </label>
  );
}
