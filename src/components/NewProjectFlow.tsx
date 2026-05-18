import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { BrassRule } from "./BrassRule";
import { useProjectStore } from "../stores/projectStore";
import { ipc } from "../lib/ipc";
import { parseGitUrl } from "../lib/parseGitUrl";

interface Props {
  onBack: () => void;
}

type ProjectType = "empty" | "clone" | "template";
type Step = 1 | 2;

interface CloneProgress {
  receivedObjects: number;
  totalObjects: number;
  receivedBytes: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Error-shape helpers for structured errors the Rust backend sends back
// ──────────────────────────────────────────────────────────────────────────────

/** Normalise an unknown thrown value to a plain object (or null). */
function parseBackendError(err: unknown): Record<string, unknown> | null {
  if (err && typeof err === "object") {
    return err as Record<string, unknown>;
  }
  if (typeof err === "string") {
    try {
      const parsed = JSON.parse(err);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // fall through
    }
  }
  return null;
}

function isAuthRequired(err: unknown): { host: string } | null {
  const e = parseBackendError(err);
  if (e?.["kind"] === "AuthRequired" && typeof e["host"] === "string") {
    return { host: e["host"] as string };
  }
  return null;
}

function isSshKeyMissing(err: unknown): { host: string } | null {
  const e = parseBackendError(err);
  if (e?.["kind"] === "SshKeyMissing" && typeof e["host"] === "string") {
    return { host: e["host"] as string };
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// SSH-to-HTTPS URL conversion
// ──────────────────────────────────────────────────────────────────────────────

/** Convert an SSH remote URL to its HTTPS equivalent.
 *  git@github.com:owner/repo.git      → https://github.com/owner/repo.git
 *  ssh://git@github.com/owner/repo.git → https://github.com/owner/repo.git
 *  Already-HTTPS URLs are returned unchanged.
 */
export function sshToHttps(url: string): string {
  // SCP style: git@github.com:owner/repo.git
  const sshScp = url.match(/^git@([^:]+):(.+)$/);
  if (sshScp) return `https://${sshScp[1]}/${sshScp[2]}`;
  // ssh:// scheme: ssh://git@github.com/owner/repo.git
  const sshProto = url.match(/^ssh:\/\/git@([^/]+)\/(.+)$/);
  if (sshProto) return `https://${sshProto[1]}/${sshProto[2]}`;
  return url; // already HTTPS or unknown
}

// ──────────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────────

export function NewProjectFlow({ onBack }: Props) {
  const { create, loading: createLoading, error: createError } = useProjectStore();

  // Step navigation
  const [step, setStep] = useState<Step>(1);
  const [projectType, setProjectType] = useState<ProjectType>("empty");

  // Empty-project fields
  const [repoName, setRepoName] = useState("");
  const [location, setLocation] = useState("~/.octopus-sh/projects");

  // Clone fields
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneName, setCloneName] = useState("");
  const [cloneNameManual, setCloneNameManual] = useState(false); // true = user edited name manually
  const [cloneLocation, setCloneLocation] = useState("~/.octopus-sh/projects");

  // Clone operation state
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [cloneProgress, setCloneProgress] = useState<CloneProgress | null>(null);

  // HTTPS auth fallback panel
  const [authHost, setAuthHost] = useState<string | null>(null);
  const [authUsername, setAuthUsername] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [authRemember, setAuthRemember] = useState(true);
  const [authLoading, setAuthLoading] = useState(false);

  // SSH key missing panel
  const [sshKeyMissingHost, setSshKeyMissingHost] = useState<string | null>(null);

  const urlInputRef = useRef<HTMLInputElement>(null);

  // ── Auto-detect name from URL ───────────────────────────────────────
  useEffect(() => {
    if (cloneNameManual) return;
    const parsed = parseGitUrl(cloneUrl);
    setCloneName(parsed?.repo ?? "");
  }, [cloneUrl, cloneNameManual]);

  // ── Pre-fill credentials from settings when auth panel appears ──────
  useEffect(() => {
    if (!authHost) return;
    ipc.getSettings().then((settings) => {
      const saved = settings.gitCredentials?.[authHost];
      if (saved) {
        setAuthUsername(saved.username);
        setAuthToken(saved.token);
      }
    }).catch(() => {});
  }, [authHost]);

  // ── Subscribe to clone progress events ─────────────────────────────
  useEffect(() => {
    if (!cloning) return;
    const unsub = listen<CloneProgress>("clone://progress", (ev) => {
      setCloneProgress(ev.payload);
    });
    return () => {
      unsub.then((u) => u());
    };
  }, [cloning]);

  // ── Helpers ─────────────────────────────────────────────────────────
  const parsedCloneUrl = parseGitUrl(cloneUrl);
  const cloneNameValid = cloneName.trim().length > 0;
  const cloneUrlValid = parsedCloneUrl !== null;
  const emptyNameValid = repoName.trim().length > 0;

  function handleTypeSelect(type: ProjectType) {
    if (type === "template") return; // still disabled
    setProjectType(type);
    setStep(2);
  }

  async function handleCreate() {
    if (projectType === "empty") {
      await create(location.trim(), repoName.trim());
    }
  }

  async function handleClone(credentials?: { username: string; token: string }) {
    setCloning(true);
    setCloneError(null);
    setCloneProgress(null);
    setAuthHost(null);
    setSshKeyMissingHost(null);

    try {
      const project = await ipc.cloneProject({
        path: cloneLocation.trim(),
        url: cloneUrl.trim(),
        nameOverride: cloneName.trim() || undefined,
        credentials,
      });
      useProjectStore.setState({ current: project, loading: false });
    } catch (err: unknown) {
      const auth = isAuthRequired(err);
      const ssh = isSshKeyMissing(err);
      if (auth) {
        setAuthHost(auth.host);
      } else if (ssh) {
        setSshKeyMissingHost(ssh.host);
      } else {
        setCloneError(String(err));
      }
    } finally {
      setCloning(false);
    }
  }

  function switchToHttps() {
    setCloneUrl((prev) => sshToHttps(prev));
    setSshKeyMissingHost(null);
    setCloneError(null);
  }

  async function handleAuthRetry() {
    if (!authHost) return;
    const creds = { username: authUsername, token: authToken };
    setAuthLoading(true);
    setCloneError(null);
    try {
      const project = await ipc.cloneProject({
        path: cloneLocation.trim(),
        url: cloneUrl.trim(),
        nameOverride: cloneName.trim() || undefined,
        credentials: creds,
      });
      if (authRemember) {
        await ipc.saveGitCredentials(authHost, authUsername, authToken).catch(() => {});
      }
      setAuthHost(null);
      useProjectStore.setState({ current: project, loading: false });
    } catch (err: unknown) {
      const auth = isAuthRequired(err);
      if (auth) {
        setCloneError("Authentication failed — check your credentials.");
      } else {
        setCloneError(String(err));
      }
    } finally {
      setAuthLoading(false);
    }
  }

  // ── Derived ─────────────────────────────────────────────────────────
  const progressPct =
    cloneProgress && cloneProgress.totalObjects > 0
      ? Math.round((cloneProgress.receivedObjects / cloneProgress.totalObjects) * 100)
      : 0;

  const displayError = cloneError ?? createError;

  // ── Render ──────────────────────────────────────────────────────────
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
          <StepIndex
            active={step === 1}
            numeral="I"
            label="Type"
            onClick={() => setStep(1)}
          />
          <StepIndex
            active={step === 2}
            numeral="II"
            label="Details"
            onClick={() => setStep(2)}
            disabled={step === 1}
          />
        </div>

        <BrassRule className="mt-10 w-7" />
      </aside>

      {/* Right content pane */}
      <main className="flex flex-1 flex-col justify-center px-14 py-10">
        {step === 1 ? (
          /* ── Step I — Type selection ─────────────────────────────── */
          <>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
              STEP I · OF II
            </div>
            <h1 className="mt-3 font-serif italic text-[26px] leading-[1.05] tracking-[-0.005em] text-octo-ivory">
              Where does it begin?
            </h1>
            <p className="mt-3 max-w-[48ch] text-[13px] leading-[1.6] text-octo-sage">
              Start from scratch, clone an existing repository, or scaffold from a template.
            </p>

            <div className="mt-8 grid max-w-[640px] grid-cols-3 gap-3">
              <TypeCard
                glyph="∅"
                label="Empty"
                description="A fresh git repository."
                selected={projectType === "empty"}
                disabled={false}
                onClick={() => handleTypeSelect("empty")}
              />
              <TypeCard
                glyph="⎘"
                label="Clone"
                description="From a remote URL."
                selected={projectType === "clone"}
                disabled={false}
                onClick={() => handleTypeSelect("clone")}
              />
              <TypeCard
                glyph="❦"
                label="Template"
                description="Coming soon."
                selected={projectType === "template"}
                disabled
                onClick={() => {}}
              />
            </div>
          </>
        ) : projectType === "clone" ? (
          /* ── Step II — Clone details ─────────────────────────────── */
          <>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
              STEP II · OF II
            </div>
            <h1 className="mt-3 font-serif italic text-[26px] leading-[1.05] tracking-[-0.005em] text-octo-ivory">
              Clone a repository.
            </h1>
            <p className="mt-3 max-w-[48ch] text-[13px] leading-[1.6] text-octo-sage">
              Paste the remote URL and Octopus will detect the name automatically.
            </p>

            <div className="mt-8 max-w-[520px] space-y-5">
              <Field label="REPOSITORY URL">
                <div className="relative">
                  <input
                    ref={urlInputRef}
                    autoFocus
                    value={cloneUrl}
                    onChange={(e) => setCloneUrl(e.target.value)}
                    placeholder="*Paste a git remote URL…*"
                    className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:font-serif placeholder:italic placeholder:text-octo-mute focus:border-octo-brass"
                  />
                  {parsedCloneUrl && (
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[9px] tracking-[0.15em] text-octo-brass">
                      § {parsedCloneUrl.host}
                    </span>
                  )}
                </div>
              </Field>

              <Field label="PROJECT NAME">
                <input
                  value={cloneName}
                  onChange={(e) => {
                    setCloneName(e.target.value);
                    setCloneNameManual(true);
                  }}
                  placeholder="*auto-detected from URL*"
                  className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-sans text-[14px] text-octo-ivory outline-none placeholder:font-serif placeholder:italic placeholder:text-octo-mute focus:border-octo-brass"
                />
              </Field>

              <Field label="LOCATION">
                <input
                  value={cloneLocation}
                  onChange={(e) => setCloneLocation(e.target.value)}
                  placeholder="~/.octopus-sh/projects"
                  className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
                />
              </Field>
            </div>

            {/* Progress bar */}
            {cloning && (
              <div className="mt-5 max-w-[520px]">
                <div className="h-[2px] w-full overflow-hidden rounded-full bg-octo-hairline">
                  <div
                    className="h-full rounded-full transition-all duration-200"
                    style={{
                      width: `${progressPct}%`,
                      background: "var(--color-octo-brass)",
                    }}
                  />
                </div>
                {cloneProgress && (
                  <div className="mt-1 font-mono text-[9px] text-octo-mute">
                    {cloneProgress.receivedObjects}/{cloneProgress.totalObjects} objects
                    {" · "}
                    {Math.round(cloneProgress.receivedBytes / 1024)} KB
                  </div>
                )}
              </div>
            )}

            {/* HTTPS auth fallback panel */}
            {authHost && (
              <div
                className="mt-6 max-w-[520px] rounded-md p-4 space-y-4"
                style={{
                  border: "1px solid var(--brass-dim)",
                  background: "var(--brass-ghost)",
                }}
              >
                <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-brass">
                  Private repository · sign in to {authHost}
                </div>

                <div className="space-y-3">
                  <Field label="USERNAME">
                    <input
                      value={authUsername}
                      onChange={(e) => setAuthUsername(e.target.value)}
                      placeholder="*your username*"
                      className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-sans text-[13px] text-octo-ivory outline-none placeholder:font-serif placeholder:italic placeholder:text-octo-mute focus:border-octo-brass"
                    />
                  </Field>

                  <Field label="PERSONAL ACCESS TOKEN">
                    <input
                      type="password"
                      value={authToken}
                      onChange={(e) => setAuthToken(e.target.value)}
                      placeholder="ghp_…"
                      className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:font-serif placeholder:italic placeholder:text-octo-mute focus:border-octo-brass"
                    />
                  </Field>
                </div>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={authRemember}
                    onChange={(e) => setAuthRemember(e.target.checked)}
                    className="rounded border-octo-hairline"
                  />
                  <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-sage">
                    Remember for {authHost}
                  </span>
                </label>

                <button
                  type="button"
                  onClick={handleAuthRetry}
                  disabled={authLoading || !authUsername || !authToken}
                  className="rounded-md px-4 py-2 font-serif italic text-[13px] text-octo-brass transition disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
                >
                  {authLoading ? "Trying…" : "Try again"}
                </button>
              </div>
            )}

            {/* SSH key missing panel */}
            {sshKeyMissingHost && (
              <div
                className="mt-6 max-w-[520px] rounded-md p-4 space-y-4"
                style={{
                  border: "1px solid var(--brass-dim)",
                  background: "var(--brass-ghost)",
                }}
              >
                <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
                  SSH KEY · {sshKeyMissingHost}
                </div>
                <p className="text-[13px] leading-[1.55] text-octo-sage">
                  Octopus couldn't find an SSH key in your agent for{" "}
                  <span className="font-mono text-octo-ivory">{sshKeyMissingHost}</span>.
                  Add one in a terminal, then click{" "}
                  <em className="font-serif italic text-octo-ivory">Try again</em>:
                </p>
                <div className="rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-sage">
                  ssh-add ~/.ssh/id_ed25519
                </div>
                <p className="text-[13px] leading-[1.55] text-octo-sage">
                  Or paste an HTTPS URL instead — Octopus will ask for a Personal Access Token.
                </p>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => handleClone()}
                    className="rounded-md px-4 py-2 font-serif italic text-[13px] text-octo-brass transition"
                    style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
                  >
                    Try again
                  </button>
                  <button
                    type="button"
                    onClick={switchToHttps}
                    className="rounded-md px-4 py-2 font-mono text-[11px] uppercase tracking-[0.15em] text-octo-sage transition hover:text-octo-ivory"
                    style={{ border: "1px solid var(--color-octo-hairline)" }}
                  >
                    Switch to HTTPS
                  </button>
                </div>
              </div>
            )}

            {/* Error message */}
            {displayError && (
              <div
                className="mt-6 max-w-[520px] rounded-md px-3 py-2 text-[12px] text-octo-rouge"
                style={{
                  borderLeft: "1px solid var(--color-octo-rouge)",
                  background: "rgba(209, 139, 139, 0.08)",
                }}
              >
                {displayError}
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
                onClick={() => handleClone()}
                disabled={cloning || !cloneUrlValid || !cloneNameValid}
                className="rounded-md px-4 py-2 font-serif italic text-[13px] text-octo-brass transition disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
              >
                {cloning ? "Cloning…" : "Clone & open"}
              </button>
            </div>
          </>
        ) : (
          /* ── Step II — Empty project details ─────────────────────── */
          <>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
              STEP II · OF II
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
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && emptyNameValid) void handleCreate();
                  }}
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

            {displayError && (
              <div
                className="mt-6 max-w-[520px] rounded-md px-3 py-2 text-[12px] text-octo-rouge"
                style={{
                  borderLeft: "1px solid var(--color-octo-rouge)",
                  background: "rgba(209, 139, 139, 0.08)",
                }}
              >
                {displayError}
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
                disabled={!emptyNameValid || createLoading}
                className="rounded-md px-4 py-2 font-serif italic text-[13px] text-octo-brass transition disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
              >
                {createLoading ? "Creating…" : "Bring it to life"}
              </button>
              <div className="ml-auto font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
                ↵ to create
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────────────────

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
