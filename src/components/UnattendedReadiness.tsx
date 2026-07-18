import { useState } from "react";
import { Moon, Shield, Lock } from "lucide-react";
import { useEntitlement } from "../hooks/useEntitlement";
import { useMissionsStore } from "../stores/missionsStore";
import { useUpgradeStore } from "../stores/upgradeStore";
import { pushToast } from "./Toasts";

/**
 * The unattended-readiness affordance in the Direct launcher foot. A detached
 * crew (one that survives app quit) is a Pro capability: Free sees a locked chip
 * that opens the upsell; Pro sees that the crew runs unattended plus a one-click
 * to sandbox the mission — unattended crews run best write-confined.
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

  if (!detached) {
    return (
      <button
        type="button"
        onClick={() => showUpgrade({ feature: "runs.detached", used: 0, limit: 0 })}
        title="Run crews unattended — they keep going even if you quit Octopush (Pro)"
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-octo-hairline bg-octo-onyx px-2.5 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-mute transition-colors duration-[180ms] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
      >
        <Lock size={11} aria-hidden />
        Unattended · Pro
      </button>
    );
  }

  const sandboxed = execIso === "sandbox";
  const enableSandbox = async () => {
    if (!missionId || enabling) return;
    setEnabling(true);
    try {
      await setExecIsolation(missionId, "sandbox");
      pushToast({
        level: "success",
        title: "Sandbox enabled",
        body: "Agent writes are now confined to the workspace.",
      });
    } catch (e) {
      pushToast({ level: "error", title: "Couldn't enable sandbox", body: String(e).split("\n")[0] });
    } finally {
      setEnabling(false);
    }
  };

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em]">
      <span
        className="flex items-center gap-1.5 text-octo-mute"
        title="This crew keeps going even if you quit Octopush"
      >
        <Moon size={11} aria-hidden />
        Runs unattended
      </span>
      {gitIso === "readonly" ? (
        <span
          className="flex items-center gap-1 text-octo-verdigris"
          title="Read-only — this mission's agents read the checkout but can't modify it"
        >
          <Shield size={11} aria-hidden />
          read-only
        </span>
      ) : sandboxed ? (
        <span
          className="flex items-center gap-1 text-octo-verdigris"
          title="Sandboxed — the agent's writes are confined to the workspace"
        >
          <Shield size={11} aria-hidden />
          sandboxed
        </span>
      ) : missionId ? (
        <button
          type="button"
          onClick={() => void enableSandbox()}
          disabled={enabling}
          title="Unattended crews run best sandboxed — confine the agent's writes to this workspace. Free."
          className="flex items-center gap-1 text-octo-brass transition-colors duration-[180ms] hover:text-octo-brass-hi focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass disabled:opacity-50"
        >
          <Shield size={11} aria-hidden />
          {enabling ? "enabling…" : "sandbox it"}
        </button>
      ) : null}
    </div>
  );
}
