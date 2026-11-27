import { useEffect, useRef, useState } from "react";
import { Shield, ShieldOff } from "lucide-react";
import { ModalShell } from "./ModalShell";
import { pushToast } from "./Toasts";
import { useMissionsStore } from "../stores/missionsStore";
import { sandboxOnBody } from "../lib/shareWithMissions";

/** The Shield's titles, one per state. Pure copy, so it is tested. */
export const SANDBOX_TITLES = {
  forced: "Read-only mission: its agents read the code and never change it. The sandbox is always on.",
  on: "Sandboxed: this mission's agents write only inside the workspace. Click to turn the sandbox off. A change applies from the next Talk turn or stage, never in the middle of a command.",
  off: "Not sandboxed: this mission's agents write wherever you can. Click to confine their writes to the workspace, from the next Talk turn or stage. Folders linked from the main checkout, and env files copied from it and left unchanged, are removed.",
} as const;

const RING = "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass";

/**
 * The confirmation before a mission's sandbox goes off (#1230), shared by the
 * header's Shield and the launcher foot: it says what turning it off unlocks,
 * **Keep the sandbox** takes the focus, Esc cancels, nothing outside or Enter
 * confirms, and the CTA is an upright-serif phrase.
 */
export function SandboxOffDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const keep = useRef<HTMLButtonElement | null>(null);
  return (
    <ModalShell onClose={onCancel} closeOnBackdrop={false} ariaLabel="Turn off the sandbox" initialFocus={keep} panelClassName="w-full max-w-[440px]">
      <div data-tour="header-sandbox-confirm" className="rounded-xl border border-octo-hairline bg-octo-panel p-6 normal-case tracking-normal shadow-2xl">
        <h2 className="font-serif text-[18px] leading-tight text-octo-ivory">Turn off the sandbox?</h2>
        <p className="mt-3 text-[12px] leading-relaxed text-octo-sage">
          This mission's agents will be able to write outside the workspace: anywhere your account can, such as your home folder and
          other projects. A command already running finishes as it is; the change applies from the next Talk turn or stage.
        </p>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            ref={keep}
            type="button"
            onClick={onCancel}
            className={`rounded-md px-4 py-2 font-mono text-[11px] text-octo-sage transition-colors duration-[var(--dur-quick)] hover:text-octo-ivory ${RING}`}
          >
            Keep the sandbox
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-md border border-[color:var(--rouge-border)] bg-[var(--rouge-active-bg)] px-4 py-2 font-serif text-[14px] text-octo-rouge transition-colors duration-[var(--dur-quick)] ${RING}`}
          >
            Let its agents write outside the workspace
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

interface Props {
  missionId: string | null;
  /** The mission's Execution axis: `sandbox` or `none`. */
  execIsolation: string | null;
  /** `readonly` (review, probe, perf) forces the sandbox on. */
  gitIsolation: string | null;
}

/**
 * The header's sandbox toggle (#1230): the mission's Execution axis, `none`
 * ↔ `sandbox`, through `update_mission`'s `exec_isolation`. The Shield shows
 * whenever the sandbox is in effect, a read-only mission's forced one
 * included, which can't be turned off; ShieldOff when it isn't. Turning it
 * on is one click. Turning it off asks first, since it lets the mission's
 * agents write outside the workspace. A Talk turn resolves the sandbox once
 * as it starts and a stage as it starts, so a change applies from the next
 * turn or stage, never in the middle of a command.
 */
export function HeaderSandbox({ missionId, execIsolation, gitIsolation }: Props) {
  const setExecIsolation = useMissionsStore((s) => s.setExecIsolation);
  // The mission the dialog was opened on: it shows only while that mission
  // is still the one on screen, still sandboxed and not forced, and closes
  // on a switch, so a confirmation never reaches another mission.
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const forced = gitIsolation === "readonly";
  const on = forced || execIsolation === "sandbox";
  const confirming = confirmFor !== null && confirmFor === missionId && on && !forced;
  useEffect(() => {
    if (confirmFor !== null && !confirming) setConfirmFor(null);
  }, [confirmFor, confirming]);
  if (!missionId) return null;

  const change = async (id: string, next: "none" | "sandbox") => {
    setConfirmFor(null);
    setBusy(true);
    try {
      const done = await setExecIsolation(id, next);
      pushToast(
        next === "sandbox"
          ? { level: "success", title: "Sandbox on", body: `${sandboxOnBody(done)} It applies from the next Talk turn or stage.` }
          : { level: "info", title: "Sandbox off", body: "From the next Talk turn or stage, this mission's agents can write outside the workspace." },
      );
    } catch (e) {
      pushToast({ level: "error", title: "Couldn't change the sandbox", body: String(e).split("\n")[0] });
    } finally {
      setBusy(false);
    }
  };

  const Icon = on ? Shield : ShieldOff;
  return (
    <>
      <button
        type="button"
        aria-pressed={on}
        aria-disabled={forced || busy}
        aria-label={on ? "Sandbox on" : "Sandbox off"}
        title={forced ? SANDBOX_TITLES.forced : on ? SANDBOX_TITLES.on : SANDBOX_TITLES.off}
        data-tour="header-sandbox"
        onClick={() => {
          if (forced || busy) return;
          if (on) setConfirmFor(missionId);
          else void change(missionId, "sandbox");
        }}
        className={`octo-pop-in -mx-0.5 flex flex-none items-center rounded px-0.5 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-octo)] ${RING} ${
          forced ? "cursor-default" : "hover:text-octo-sage"
        }`}
      >
        <Icon size={10} aria-hidden />
      </button>
      {confirming && <SandboxOffDialog onCancel={() => setConfirmFor(null)} onConfirm={() => confirmFor && void change(confirmFor, "none")} />}
    </>
  );
}
