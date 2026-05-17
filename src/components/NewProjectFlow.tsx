import { useState } from "react";
import { BrassRule } from "./BrassRule";
import { useProjectStore } from "../stores/projectStore";

interface Props {
  onBack: () => void;
}

type ProjectType = "empty" | "clone" | "template";
type Step = 1 | 2;

export function NewProjectFlow({ onBack }: Props) {
  const { create, loading, error } = useProjectStore();
  const [step, setStep] = useState<Step>(1);
  const [location, setLocation] = useState("~/.octopus-sh/projects");
  const [repoName, setRepoName] = useState("");
  const [projectType, setProjectType] = useState<ProjectType>("empty");

  const nameValid = repoName.trim().length > 0;

  async function handleCreate() {
    const trimmedLocation = location.trim();
    const trimmedName = repoName.trim();
    if (!trimmedName) return;
    await create(trimmedLocation, trimmedName);
  }

  function handleStep1KeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && nameValid) setStep(2);
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
          onClick={onBack}
          className="mb-10 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute hover:text-octo-sage"
        >
          ← Back
        </button>

        <div className="font-serif italic text-[18px] text-octo-ivory">
          A new project
        </div>

        <div className="mt-6 space-y-1">
          <StepIndex active={step === 1} numeral="I" label="Name & path" onClick={() => setStep(1)} />
          <StepIndex active={step === 2} numeral="II" label="Type" onClick={() => nameValid && setStep(2)} disabled={!nameValid && step !== 2} />
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
              Name your new study.
            </h1>
            <p className="mt-3 max-w-[48ch] text-[13px] leading-[1.6] text-octo-sage">
              A project is the home for your codebase. Each project can hold many workspaces — one per branch you're working on.
            </p>

            <div className="mt-8 max-w-[520px] space-y-5">
              <Field label="PROJECT NAME">
                <input
                  autoFocus
                  value={repoName}
                  onChange={(e) => setRepoName(e.target.value)}
                  onKeyDown={handleStep1KeyDown}
                  placeholder="Hyperion"
                  className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-sans text-[14px] text-octo-ivory outline-none placeholder:font-serif placeholder:italic placeholder:text-octo-mute focus:border-octo-brass"
                />
              </Field>

              <Field label="LOCATION">
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="~/.octopus-sh/projects"
                  className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
                />
              </Field>
            </div>

            <div className="mt-10 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setStep(2)}
                disabled={!nameValid}
                className="rounded-md px-4 py-2 font-serif italic text-[13px] text-octo-brass transition disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
              >
                Continue
              </button>
              <button
                type="button"
                onClick={onBack}
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
              Where does it begin?
            </h1>
            <p className="mt-3 max-w-[48ch] text-[13px] leading-[1.6] text-octo-sage">
              Start with an empty repository, clone an existing one, or scaffold from a template. Only "Empty" is available today.
            </p>

            <div className="mt-8 grid max-w-[640px] grid-cols-3 gap-3">
              <TypeCard
                glyph="∅"
                label="Empty"
                description="A fresh git repository."
                selected={projectType === "empty"}
                disabled={false}
                onClick={() => setProjectType("empty")}
              />
              <TypeCard
                glyph="⎘"
                label="Clone"
                description="From a remote URL."
                selected={projectType === "clone"}
                disabled
                onClick={() => setProjectType("clone")}
              />
              <TypeCard
                glyph="❦"
                label="Template"
                description="Coming soon."
                selected={projectType === "template"}
                disabled
                onClick={() => setProjectType("template")}
              />
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
                disabled={!nameValid || loading || projectType !== "empty"}
                className="rounded-md px-4 py-2 font-serif italic text-[13px] text-octo-brass transition disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
              >
                {loading ? "Creating…" : "Bring it to life"}
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

function TypeCard({
  glyph,
  label,
  description,
  selected,
  disabled,
  onClick,
}: {
  glyph: string;
  label: string;
  description: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex flex-col items-start gap-3 rounded-md p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        border: selected ? "1px solid var(--brass-dim)" : "1px solid var(--color-octo-hairline)",
        background: selected ? "var(--brass-ghost)" : "transparent",
      }}
    >
      <span
        className="font-serif italic text-[20px]"
        style={{ color: selected ? "var(--color-octo-brass)" : "var(--color-octo-sage)" }}
      >
        {glyph}
      </span>
      <div>
        <div
          className="font-mono text-[10px] uppercase tracking-[0.2em]"
          style={{ color: selected ? "var(--color-octo-brass)" : "var(--color-octo-ivory)" }}
        >
          {label}
        </div>
        <div className="mt-1 font-serif italic text-[12px] text-octo-sage">
          {description}
        </div>
      </div>
    </button>
  );
}
