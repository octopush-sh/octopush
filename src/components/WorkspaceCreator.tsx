import { useEffect, useRef, useState } from "react";
import { ChevronLeft, X } from "lucide-react";
import { BaseBranchPicker } from "./BaseBranchPicker";
import { PrPicker } from "./PrPicker";
import type { PrInfo } from "../lib/types";
import { BrassRule } from "./BrassRule";
import { FadeSwap } from "./primitives/FadeSwap";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useCompanionPrefs } from "../stores/companionPrefsStore";
import { ipc } from "../lib/ipc";
import { copyToClipboard } from "../lib/clipboard";

interface Props {
  projectId: string;
  projectPath: string;
  onCreated: () => void;
  onCancel: () => void;
  /** Pre-fill the task input with this value. */
  initialTask?: string;
  /** After successful creation, link this issue key to the new workspace. */
  linkIssueKeyOnCreate?: string | null;
}

type Step = 1 | 2;

/** Mirror the backend's worktree path computation: workspaces live as
 *  siblings of the project root, inside a shared `.octopus-worktrees/`
 *  directory. Showing this honestly here means the path the user sees
 *  in the wizard matches what they'd see in Finder. */
function worktreeDisplayPath(projectPath: string, branch: string): string {
  const parent = projectPath.replace(/\/[^/]+\/?$/, "");
  return `${parent}/.octopus-worktrees/${branch}`;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function WorkspaceCreator({ projectId, projectPath, onCreated, onCancel, initialTask, linkIssueKeyOnCreate }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [task, setTask] = useState(initialTask ?? "");
  // Step II prefills with the project's last-used setup script (saved back on
  // successful create — a remembered template, not a live binding).
  const [setupScript, setSetupScript] = useState(
    () => useCompanionPrefs.getState().setupScriptByProject[projectId] ?? "",
  );
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [base, setBase] = useState<string | null>(null);
  /** Explicit branch name typed by the user. null = follow the task slug. */
  const [branchOverride, setBranchOverride] = useState<string | null>(null);
  /** The pull request this workspace starts from, if any (drives the chip). */
  const [fromPr, setFromPr] = useState<PrInfo | null>(null);
  const [prError, setPrError] = useState<string | null>(null);
  /** Base in effect before a PR retargeted it — restored when the chip clears. */
  const prevBaseRef = useRef<string | null>(null);

  const create = useWorkspaceStore((s) => s.create);

  async function handlePickPr(pr: PrInfo) {
    setPrError(null);
    try {
      await ipc.ensurePrBranch(projectPath, pr.number, pr.headRefName);
    } catch (e) {
      setPrError(String(e));
      return;
    }
    // Remember the base only on the first pick — switching between PRs
    // should still restore the original (default) base on clear.
    if (fromPr === null) prevBaseRef.current = base;
    setBase(pr.headRefName);
    // The head ref now exists locally — offer it in the picker too.
    setBranches((cur) => (cur.includes(pr.headRefName) ? cur : [...cur, pr.headRefName]));
    setTask((cur) => (cur.trim() ? cur : pr.title));
    setFromPr(pr);
  }

  function clearPr() {
    setFromPr(null);
    setPrError(null);
    setBase(prevBaseRef.current ?? branches[0] ?? null);
  }

  // Load local branches for the base picker. The repo default comes first.
  // On failure the picker degrades to a static label and creation still
  // works: an empty base lets the backend resolve the repo default.
  useEffect(() => {
    ipc
      .listBranches(projectPath)
      .then((b) => {
        setBranches(b.local);
        setRemoteBranches(b.remote);
        setBase((cur) => cur ?? b.local[0] ?? null);
      })
      .catch(() => {});
  }, [projectPath]);

  // Escape cancels the whole creator — but only when no inner layer claimed
  // the key first. The BaseBranchPicker's menu chrome calls preventDefault()
  // on its Escape; without the defaultPrevented guard, dismissing the branch
  // menu would also tear down the creator.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (e.defaultPrevented) return;
      if (!creating) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [creating, onCancel]);

  const branch = branchOverride ?? (slugify(task) || "new-workspace");
  const workspaceName = branch;
  const taskValid = task.trim().length > 0;
  const branchCollides = branches.includes(branch);

  async function handleCreate() {
    if (!taskValid) return;
    setCreating(true);
    setError(null);
    let newWs;
    try {
      newWs = await create(projectId, projectPath, workspaceName, task.trim(), branch, base ?? "", setupScript);
    } catch (e) {
      setError(String(e));
      setCreating(false);
      return;
    }
    // Remember the script (possibly empty) as this project's template.
    useCompanionPrefs.getState().setSetupScriptForProject(projectId, setupScript);
    if (linkIssueKeyOnCreate) {
      try {
        await ipc.updateWorkspaceLink(newWs.id, linkIssueKeyOnCreate);
        await useWorkspaceStore.getState().load(newWs.projectId);
      } catch (e) {
        // Workspace was created OK but the Jira link did not persist. Keep the
        // creator open with a clear, actionable message — the user can dismiss
        // and link the ticket later via the workspace's right-click menu.
        setError(`Workspace was created but linking the Jira ticket failed: ${String(e)}. You can link it later via right-click on the workspace.`);
        setCreating(false);
        return;
      }
    }
    setCreating(false);
    onCreated();
  }

  return (
    <div
      data-tauri-drag-region
      className="flex h-full w-full bg-octo-bg"
      style={{
        background:
          "radial-gradient(ellipse at 30% 25%, var(--brass-faint), transparent 50%), var(--color-octo-onyx)",
      }}
    >
      {/* Left index pane */}
      <aside className="w-[220px] shrink-0 border-r border-octo-hairline bg-octo-panel px-6 py-10">
        <button
          type="button"
          onClick={onCancel}
          className="mb-10 inline-flex items-center gap-1 rounded-sm font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute transition-colors duration-[220ms] hover:text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          <ChevronLeft size={12} />
          Back
        </button>

        <div className="font-serif text-[18px] text-octo-ivory">
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
      <main className="flex flex-1 flex-col px-14 py-10">
        <FadeSwap swapKey={String(step)} className="flex flex-1 flex-col justify-center">
        {step === 1 ? (
          <>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
              STEP I · OF II
            </div>
            <h1 className="mt-3 font-serif text-[26px] leading-[1.05] tracking-[-0.005em] text-octo-ivory">
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
                  className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-sans text-[14px] text-octo-ivory outline-none placeholder:font-serif placeholder:not-italic placeholder:text-octo-mute focus:border-octo-brass"
                />
              </Field>

              {/* Branch preview — the value is quietly editable */}
              <div className="mt-4 flex items-baseline gap-2 font-mono text-[10px] uppercase tracking-[0.2em]">
                <span className="text-octo-mute">BRANCH</span>
                <input
                  value={branch}
                  onChange={(e) => setBranchOverride(e.target.value)}
                  onBlur={() => {
                    if (branchOverride === null) return;
                    const cleaned = slugify(branchOverride);
                    setBranchOverride(cleaned || null);
                  }}
                  title="Branch name — edit to override the suggested slug"
                  aria-label="Branch name"
                  className="rounded-none border-b border-transparent bg-transparent font-mono text-[10px] normal-case tracking-[0.2em] text-octo-brass outline-none transition-colors duration-[220ms] focus:border-octo-brass"
                  style={{
                    width: `calc(${Math.max(branch.length, 4)}ch + ${Math.max(branch.length, 4) * 0.2}em)`,
                  }}
                />
                <span className="text-octo-mute">from</span>
                <BaseBranchPicker
                  branches={branches}
                  remoteBranches={remoteBranches}
                  value={base}
                  onSelect={setBase}
                />
                <PrPicker projectPath={projectPath} onPick={handlePickPr} />
                {fromPr && (
                  <span className="octo-rise-in inline-flex items-center gap-1.5 rounded-sm border border-octo-hairline px-1.5 py-0.5 font-mono text-[9px] normal-case tracking-[0.15em] text-octo-mute">
                    from PR #{fromPr.number}
                    <button
                      type="button"
                      title="Clear pull request base"
                      onClick={clearPr}
                      className="inline-flex items-center rounded-sm transition-colors duration-[220ms] hover:text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                    >
                      <X size={9} />
                    </button>
                  </span>
                )}
              </div>
              {prError && (
                <div className="octo-rise-in mt-2 font-mono text-[10px] tracking-[0.05em] text-octo-rouge">
                  Could not fetch the pull request branch: {prError}
                </div>
              )}
              {branchCollides && (
                <div className="octo-rise-in mt-2 font-mono text-[10px] tracking-[0.05em] text-octo-rouge">
                  Branch exists — the workspace will reuse it
                </div>
              )}
            </div>

            <div className="mt-10 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setStep(2)}
                disabled={!taskValid}
                className="rounded-md border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-4 py-2 font-serif text-[13px] text-octo-brass transition disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
              >
                Continue
              </button>
              <button
                type="button"
                onClick={onCancel}
                className="rounded-md px-3 py-2 text-[12px] text-octo-mute transition-colors duration-[220ms] hover:text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
              >
                Cancel
              </button>
              <div className="ml-auto font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
                <kbd className="rounded border border-octo-hairline px-1.5 py-0.5 font-mono text-[9px] tracking-normal text-octo-mute">Enter</kbd>
                <span className="ml-1">to continue</span>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
              STEP II · OF II
            </div>
            <h1 className="mt-3 font-serif text-[26px] leading-[1.05] tracking-[-0.005em] text-octo-ivory">
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
                Runs inside the new worktree at <span className="text-octo-sage">{worktreeDisplayPath(projectPath, branch)}</span>.
              </div>
            </div>

            {error && (
              <div
                className="octo-rise-in mt-6 max-w-[520px] rounded-md px-3 py-2 text-[12px] text-octo-rouge"
                style={{
                  borderLeft: "1px solid var(--color-octo-rouge)",
                  background: "var(--rouge-ghost)",
                  userSelect: "text",
                  WebkitUserSelect: "text",
                  cursor: "text",
                }}
              >
                {error}
                <button
                  type="button"
                  onClick={() => {
                    void copyToClipboard(error, "Error copied");
                  }}
                  className="ml-2 inline-flex items-center font-mono text-[10px] uppercase tracking-[0.18em] text-octo-rouge/70 transition-colors hover:text-octo-rouge"
                  title="Copy error to clipboard"
                  style={{ userSelect: "none" }}
                >
                  · copy
                </button>
              </div>
            )}

            <div className="mt-10 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="inline-flex items-center gap-1 rounded-md px-3 py-2 text-[12px] text-octo-mute transition-colors duration-[220ms] hover:text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
              >
                <ChevronLeft size={12} />
                Back
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={!taskValid || creating}
                className="rounded-md border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-4 py-2 font-serif text-[13px] text-octo-brass transition disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
              >
                {creating ? "Creating…" : "Begin"}
              </button>
            </div>
          </>
        )}
        </FadeSwap>
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
      title={disabled ? "Complete the task first" : undefined}
      className="flex w-full items-baseline gap-3 rounded-sm py-1.5 text-left disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
    >
      <span
        className={`w-6 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors duration-[220ms] ${
          active ? "text-octo-brass" : "text-octo-mute"
        }`}
      >
        {numeral}
      </span>
      <span
        className={`transition-colors duration-[220ms] ${
          active
            ? "font-serif text-[14px] text-octo-ivory"
            : "font-sans text-[12px] text-octo-mute"
        }`}
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
