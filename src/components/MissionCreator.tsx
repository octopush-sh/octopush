import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Hammer, Wrench, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { BaseBranchPicker } from "./BaseBranchPicker";
import { PrPicker } from "./PrPicker";
import { Reveal } from "./primitives/Reveal";
import { Listbox } from "./controls/Listbox";
import type { PrInfo } from "../lib/types";
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

type Step = 1 | 2 | 3;
type Intent = "build" | "fix";
/** The manual git-isolation choices. `pr` is derived (picking a PR), never a
 *  Listbox option — one state, two entry points. */
type GitIsolation = "worktree" | "ephemeral";

/** The execution-isolation choices offered in the wizard. `container`/`cloud`
 *  arrive with later movements — zero dead options until they're real. */
type ExecIsolation = "none" | "sandbox";

/** Flatten a branch to the single-component directory name the backend uses for
 *  the worktree (mirrors `git_ops::slot_name_for`): keep ASCII word chars, `.`;
 *  turn everything else (slashes, spaces, …) into `-`; collapse; trim. So
 *  `feat/Foo` lives at `.octopus-worktrees/feat-Foo`, not a nested `feat/Foo`. */
function worktreeDirName(branch: string): string {
  let out = "";
  let prevDash = false;
  for (const ch of branch) {
    if (/[A-Za-z0-9_.]/.test(ch)) {
      out += ch;
      prevDash = false;
    } else if (!prevDash) {
      out += "-";
      prevDash = true;
    }
  }
  out = out.replace(/^-+|-+$/g, "").replace(/^\.+/, "");
  return out || "workspace";
}

function worktreeDisplayPath(projectPath: string, branch: string): string {
  const parent = projectPath.replace(/\/[^/]+\/?$/, "");
  // The backend appends a short per-workspace id (`-<id>`) so two workspaces can
  // never share a directory, whatever their branch names look like. It's assigned
  // at creation time, so preview it as a placeholder suffix rather than a lie.
  return `${parent}/.octopus-worktrees/${worktreeDirName(branch)}-<id>`;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const INTENT_META: Record<Intent, { icon: LucideIcon; title: string; desc: string }> = {
  build: { icon: Hammer, title: "Build something new", desc: "A feature, a surface, a capability." },
  fix: { icon: Wrench, title: "Fix something broken", desc: "A bug, a regression, a rough edge." },
};

export function MissionCreator({ projectId, projectPath, onCreated, onCancel, initialTask, linkIssueKeyOnCreate }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [intent, setIntent] = useState<Intent>("build");
  const [task, setTask] = useState(initialTask ?? "");
  // Step 3 prefills with the project's last-used setup script (saved back on
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
  /** The pull request this mission starts from, if any (drives the chip). */
  const [fromPr, setFromPr] = useState<PrInfo | null>(null);
  const [prError, setPrError] = useState<string | null>(null);
  /** Manual git-isolation choice (overridden to `pr` when a PR is picked). */
  const [gitIsolation, setGitIsolation] = useState<GitIsolation>("worktree");
  /** Execution isolation — free security: sandbox confines the agent's writes. */
  const [execIsolation, setExecIsolation] = useState<ExecIsolation>("none");
  const [showIsolation, setShowIsolation] = useState(false);
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
      if (e.defaultPrevented) return; // an inner layer (e.g. the base-branch menu) claimed it
      // We own Escape here. Prevent the default so it doesn't reach the OS — in
      // native fullscreen an unhandled Escape exits fullscreen and visibly
      // shrinks the window instead of just closing this view.
      e.preventDefault();
      if (!creating) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [creating, onCancel]);

  // Step-1 (Intent) keyboard: 1/2 choose-and-advance, ←/→ move the highlight,
  // Enter continues with the current choice. Only active on step 1 so it never
  // competes with the task input's own Enter handler on step 2.
  useEffect(() => {
    if (step !== 1) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "1") { setIntent("build"); setStep(2); }
      else if (e.key === "2") { setIntent("fix"); setStep(2); }
      else if (e.key === "ArrowLeft") setIntent("build");
      else if (e.key === "ArrowRight") setIntent("fix");
      else if (e.key === "Enter") setStep(2);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  const branch = branchOverride ?? (slugify(task) || "new-mission");
  const workspaceName = branch;
  const taskValid = task.trim().length > 0;
  const branchCollides = branches.includes(branch);

  function chooseIntent(v: Intent) {
    setIntent(v);
    setStep(2);
  }

  async function handleCreate() {
    if (!taskValid) return;
    setCreating(true);
    setError(null);
    // Picking a PR overrides the manual isolation choice — one effective value.
    const gitIso: string = fromPr ? "pr" : gitIsolation;
    let newWs;
    try {
      newWs = await create(
        projectId,
        projectPath,
        workspaceName,
        task.trim(),
        branch,
        base ?? "",
        setupScript,
        intent,
        gitIso,
        execIsolation,
      );
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
      className="relative flex h-full w-full bg-octo-bg"
      style={{
        background:
          "radial-gradient(ellipse at 30% 25%, var(--brass-faint), transparent 50%), var(--color-octo-onyx)",
      }}
    >
      {/* Always-present exit. A full-screen overlay needs one unmistakable way
          out on every step; Escape does the same (see the key handler above). */}
      <button
        type="button"
        onClick={onCancel}
        title="Close · Esc"
        aria-label="Close"
        className="absolute right-4 top-4 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md text-octo-mute transition-colors duration-[220ms] hover:text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
      >
        <X size={15} />
      </button>

      {/* Left index pane */}
      <aside className="w-[220px] shrink-0 border-r border-octo-hairline bg-octo-panel px-6 py-10">
        <div className="font-serif text-[18px] text-octo-ivory">
          A new mission
        </div>

        <div className="mt-6 space-y-1">
          <StepIndex active={step === 1} numeral="1" label="Intent" onClick={() => setStep(1)} />
          <StepIndex
            active={step === 2}
            numeral="2"
            label="Task & branch"
            onClick={() => setStep(2)}
          />
          <StepIndex
            active={step === 3}
            numeral="3"
            label="Setup script"
            onClick={() => taskValid && setStep(3)}
            disabled={!taskValid && step !== 3}
          />
        </div>
      </aside>

      {/* Right content pane */}
      <main className="flex flex-1 flex-col px-14 py-10">
        <FadeSwap swapKey={String(step)} className="flex flex-1 flex-col justify-center">
        {step === 1 ? (
          <>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
              STEP 1 OF 3
            </div>
            <h1 className="mt-3 font-serif text-[26px] leading-[1.05] tracking-[-0.005em] text-octo-ivory">
              What is this mission about?
            </h1>
            <p className="mt-3 max-w-[48ch] text-[13px] leading-[1.6] text-octo-sage">
              A mission is a thread of intent. What you set out to do shapes how it is isolated.
            </p>

            <div className="mt-8 grid max-w-[560px] grid-cols-2 gap-3">
              {(Object.keys(INTENT_META) as Intent[]).map((key, i) => (
                <IntentCard
                  key={key}
                  index={i}
                  meta={INTENT_META[key]}
                  shortcut={String(i + 1)}
                  selected={intent === key}
                  onSelect={() => chooseIntent(key)}
                />
              ))}
            </div>

            <div className="mt-10 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setStep(2)}
                className="rounded-md border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-4 py-2 font-serif text-[13px] text-octo-brass transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
              >
                Continue
              </button>
              <div className="ml-auto font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
                <kbd className="rounded border border-octo-hairline px-1.5 py-0.5 font-mono text-[9px] tracking-normal text-octo-mute">Enter</kbd>
                <span className="ml-1">to continue · 1 / 2 to choose</span>
              </div>
            </div>
          </>
        ) : step === 2 ? (
          <>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
              STEP 2 OF 3
            </div>
            <h1 className="mt-3 font-serif text-[26px] leading-[1.05] tracking-[-0.005em] text-octo-ivory">
              What are you setting out to do?
            </h1>
            <p className="mt-3 max-w-[48ch] text-[13px] leading-[1.6] text-octo-sage">
              The task name becomes the branch. By default the mission gets its own git worktree.
            </p>

            <div className="mt-8 max-w-[520px]">
              <Field label="TASK">
                <input
                  autoFocus
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && taskValid) setStep(3);
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
                    // An explicit branch is used verbatim (just trimmed) — mixed
                    // case and slashes like JIRA-123 or feat/Foo are valid git
                    // branches. Only the auto-suggested name (from the task) is
                    // slugified. Matches octopush-mcp's verbatim behaviour.
                    setBranchOverride(branchOverride.trim() || null);
                  }}
                  title="Branch name — edit to set an exact name (e.g. feat/Foo)"
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

              {/* Isolation disclosure — collapsed by default; brass stays quiet. */}
              <div className="mt-6">
                <button
                  type="button"
                  onClick={() => setShowIsolation((v) => !v)}
                  aria-expanded={showIsolation}
                  className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute transition-colors duration-[220ms] hover:text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                >
                  <ChevronRight
                    size={11}
                    aria-hidden
                    className={`transition-transform duration-[220ms] ${showIsolation ? "rotate-90" : ""}`}
                  />
                  Isolation
                </button>
                <Reveal open={showIsolation} className="mt-3">
                  <div className="flex flex-col gap-4">
                    <div>
                      <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">
                        Git state
                      </div>
                      {fromPr ? (
                        <div className="max-w-[420px] rounded-md border border-octo-hairline bg-octo-panel px-3 py-2 text-[12px] leading-[1.5] text-octo-sage">
                          Starting from <span className="text-octo-brass">PR #{fromPr.number}</span> — this mission uses the pull request&apos;s head as its checkout.
                        </div>
                      ) : (
                        <Listbox
                          ariaLabel="Git isolation"
                          className="max-w-[420px]"
                          value={gitIsolation}
                          onChange={(v) => setGitIsolation(v as GitIsolation)}
                          options={[
                            { value: "worktree", label: "Own worktree", description: "The default — a dedicated git worktree for this mission." },
                            { value: "ephemeral", label: "Ephemeral", description: "A throwaway worktree, archived when the mission is done." },
                          ]}
                        />
                      )}
                    </div>
                    <div>
                      <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">
                        Execution
                      </div>
                      <Listbox
                        ariaLabel="Execution isolation"
                        className="max-w-[420px]"
                        value={execIsolation}
                        onChange={(v) => setExecIsolation(v as ExecIsolation)}
                        options={[
                          { value: "none", label: "None", description: "The default — the agent runs with your normal permissions." },
                          { value: "sandbox", label: "Local sandbox", description: "Confines the Claude Code (Direct) crew's file writes to this workspace — reads and network stay open. Free." },
                        ]}
                      />
                    </div>
                  </div>
                </Reveal>
              </div>
            </div>

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
                onClick={() => setStep(3)}
                disabled={!taskValid}
                className="rounded-md border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-4 py-2 font-serif text-[13px] text-octo-brass transition disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
              >
                Continue
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
              STEP 3 OF 3
            </div>
            <h1 className="mt-3 font-serif text-[26px] leading-[1.05] tracking-[-0.005em] text-octo-ivory">
              How does it start?
            </h1>
            <p className="mt-3 max-w-[48ch] text-[13px] leading-[1.6] text-octo-sage">
              These commands run automatically when the mission&apos;s worktree is created. Leave empty to skip.
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
                {branchCollides ? (
                  // The branch already exists — creation reuses (or adopts) its
                  // existing checkout, so we can't promise a fresh path here.
                  <>Reuses the existing <span className="text-octo-sage">{branch}</span> branch — the setup script runs in its worktree.</>
                ) : (
                  <>Runs inside the new worktree at <span className="text-octo-sage">{worktreeDisplayPath(projectPath, branch)}</span>.</>
                )}
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
                onClick={() => setStep(2)}
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
                {creating ? "Beginning…" : "Begin the mission"}
              </button>
            </div>
          </>
        )}
        </FadeSwap>
      </main>
    </div>
  );
}

function IntentCard({
  index,
  meta,
  shortcut,
  selected,
  onSelect,
}: {
  index: number;
  meta: { icon: LucideIcon; title: string; desc: string };
  shortcut: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = meta.icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{ animationDelay: `calc(${index} * var(--stagger-step))` }}
      className={`octo-rise-in flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors duration-[220ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass ${
        selected
          ? "border-[var(--brass-dim)] bg-[var(--brass-ghost)]"
          : "border-octo-hairline bg-octo-panel hover:border-[var(--brass-dim)]"
      }`}
    >
      <div className="flex w-full items-center justify-between">
        <Icon size={18} aria-hidden className={selected ? "text-octo-brass" : "text-octo-sage"} />
        <span className="font-mono text-[9px] text-octo-mute">{shortcut}</span>
      </div>
      <div className="font-serif text-[15px] leading-tight text-octo-ivory">{meta.title}</div>
      <div className="text-[12px] leading-[1.5] text-octo-sage">{meta.desc}</div>
    </button>
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
      title={disabled ? "Add a task first" : undefined}
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
