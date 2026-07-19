import { useState } from "react";
import { Moon, Shield, Lock } from "lucide-react";
import { useEntitlement } from "../hooks/useEntitlement";
import { useMissionsStore } from "../stores/missionsStore";
import { useUpgradeStore } from "../stores/upgradeStore";
import { pushToast } from "./Toasts";

/**
 * The unattended-readiness + sandbox affordance in the Direct launcher foot.
 * Two independent pieces:
 *  - **Sandbox** (FREE, everyone) — a Shield toggle to confine / un-confine the
 *    mission's writes. Always available (security is never gated), so a genesis
 *    project sandboxed by default can be turned OFF here if a build needs to
 *    write outside the workspace.
 *  - **Unattended** (Pro) — Free sees a locked chip → the `runs.detached` upsell;
 *    Pro sees "Runs unattended" (the crew survives app quit).
 */
export function UnattendedReadiness({ workspaceId }: { workspaceId: string }) {
  const { hasFeature } = useEntitlement();
  const detached = hasFeature("runs.detached");
  const showUpgrade = useUpgradeStore((s) => s.show);
  const missionId = useMissionsStore((s) => s.missionByWorkspaceId[workspaceId]?.id ?? null);
  const execIso = useMissionsStore((s) => s.missionByWorkspaceId[workspaceId]?.execIsolation ?? null);
  const gitIso = useMissionsStore((s) => s.missionByWorkspaceId[workspaceId]?.gitIsolation ?? null);
  const setExecIsolation = useMissionsStore((s) => s.setExecIsolation);
  const [enabling, setEnabling] = useState(false);

  const sandboxed = execIso === "sandbox";
  const toggleSandbox = async () => {
    if (!missionId || enabling) return;
    const next = sandboxed ? "none" : "sandbox";
    setEnabling(true);
    try {
      await setExecIsolation(missionId, next);
      pushToast(
        next === "sandbox"
          ? { level: "success", title: "Sandbox enabled", body: "Agent writes are now confined to the workspace." }
          : { level: "info", title: "Sandbox off", body: "This mission's agents run with your normal permissions." },
      );
    } catch (e) {
      pushToast({ level: "error", title: "Couldn't change the sandbox", body: String(e).split("\n")[0] });
    } finally {
      setEnabling(false);
    }
  };

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em]">
      {/* Unattended (Pro) — the detach framing. */}
      {detached ? (
        <span
          className="flex items-center gap-1.5 text-octo-mute"
          title="This crew keeps going even if you quit Octopush"
        >
          <Moon size={11} aria-hidden />
          Runs unattended
        </span>
      ) : (
        <button
          type="button"
          onClick={() => showUpgrade({ feature: "runs.detached", used: 0, limit: 0 })}
          title="Run crews unattended — they keep going even if you quit Octopush (Pro)"
          className="flex items-center gap-1.5 rounded-md border border-octo-hairline bg-octo-onyx px-2.5 py-1 text-octo-mute transition-colors duration-[180ms] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          <Lock size={11} aria-hidden />
          Unattended · Pro
        </button>
      )}

      {/* Sandbox (FREE, everyone) — read-only missions are confined by
          construction; others get a toggle. */}
      {gitIso === "readonly" ? (
        <span
          className="flex items-center gap-1 text-octo-verdigris"
          title="Read-only — this mission's agents read the checkout but can't modify it"
        >
          <Shield size={11} aria-hidden />
          read-only
        </span>
      ) : missionId ? (
        <button
          type="button"
          onClick={() => void toggleSandbox()}
          disabled={enabling}
          title={
            sandboxed
              ? "Sandboxed — the agent's writes are confined to the workspace. Click to turn off (e.g. if a build needs to write outside it)."
              : "Sandbox this mission — confine the agent's writes to the workspace. Free."
          }
          className={`flex items-center gap-1 transition-colors duration-[180ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass disabled:opacity-50 ${
            sandboxed ? "text-octo-verdigris hover:text-octo-brass" : "text-octo-brass hover:text-octo-brass-hi"
          }`}
        >
          <Shield size={11} aria-hidden />
          {enabling ? "…" : sandboxed ? "sandboxed" : "sandbox it"}
        </button>
      ) : null}
    </div>
  );
}
