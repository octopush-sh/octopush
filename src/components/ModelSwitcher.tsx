import { useState, useEffect, useRef } from "react";
import { Zap, ChevronDown, Check } from "lucide-react";
import { ipc } from "../lib/ipc";
import { shortModel } from "../lib/modelLabel";
import { useSessionStore } from "../stores/sessionStore";
import { pushToast } from "./Toasts";
import type { ModelWithProvider } from "../lib/types";
import { clsx } from "clsx";

interface Props {
  open: boolean;
  onClose: () => void;
}

const COST_BADGE: Record<string, { label: string; color: string }> = {
  low: { label: "$", color: "text-octo-success" },
  medium: { label: "$$", color: "text-octo-warning" },
  high: { label: "$$$", color: "text-octo-danger" },
};

function costTier(inputPerM: number): "low" | "medium" | "high" {
  if (inputPerM <= 1) return "low";
  if (inputPerM <= 5) return "medium";
  return "high";
}

export function ModelSwitcher({ open, onClose }: Props) {
  const { sessions, activeId, refresh } = useSessionStore();
  const [models, setModels] = useState<ModelWithProvider[]>([]);
  const [switching, setSwitching] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const active = sessions.find((s) => s.id === activeId);

  useEffect(() => {
    if (open) {
      ipc.listModels().then(setModels).catch(() => setModels([]));
    }
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose]);

  if (!open || !active) return null;

  const currentModel = active.agent.model;

  async function selectModel(modelId: string) {
    if (!activeId || modelId === currentModel) {
      onClose();
      return;
    }
    setSwitching(modelId);
    try {
      const result = await ipc.switchAgent(activeId, modelId);
      await refresh();
      onClose();
      pushToast({
        level: result.appliedToPty ? "success" : "info",
        title: `Model → ${modelId}`,
        body: result.message,
      });
    } catch (err) {
      console.error("switch agent failed", err);
      pushToast({ level: "error", title: "Switch failed", body: String(err) });
    } finally {
      setSwitching(null);
    }
  }

  // Group models by provider.
  const grouped = new Map<string, ModelWithProvider[]>();
  for (const m of models) {
    const list = grouped.get(m.provider) ?? [];
    list.push(m);
    grouped.set(m.provider, list);
  }

  return (
    <div
      ref={panelRef}
      className="absolute right-4 top-10 z-40 w-72 overflow-hidden rounded-xl border border-octo-border bg-octo-panel shadow-2xl"
    >
      <div className="border-b border-octo-border px-4 py-2.5">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
          <Zap size={12} />
          Switch model
        </div>
        <div className="mt-0.5 text-[10px] text-zinc-600">
          Current: <span className="text-zinc-400">{currentModel}</span>
        </div>
      </div>

      <div className="max-h-80 overflow-y-auto py-1">
        {[...grouped.entries()].map(([provider, items]) => (
          <div key={provider}>
            <div className="px-4 pt-2 pb-1 text-[9px] font-semibold uppercase tracking-widest text-zinc-600">
              {provider}
            </div>
            {items.map((m) => {
              const tier = costTier(m.model.inputCostPerM);
              const badge = COST_BADGE[tier];
              const isCurrent = m.model.id === currentModel;
              const isLoading = switching === m.model.id;

              return (
                <button
                  key={m.model.id}
                  onClick={() => selectModel(m.model.id)}
                  disabled={isLoading}
                  className={clsx(
                    "flex w-full items-center gap-2 px-4 py-2 text-left text-sm transition",
                    isCurrent
                      ? "bg-octo-accent/10 text-octo-accent"
                      : "text-zinc-300 hover:bg-zinc-800/60",
                  )}
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">
                        {m.model.displayName}
                      </span>
                      <span className={clsx("text-[10px] font-bold", badge.color)}>
                        {badge.label}
                      </span>
                    </div>
                    <div className="text-[10px] text-zinc-600">
                      {(m.model.maxContext / 1000).toFixed(0)}K ctx
                      {m.model.supportsVision && " • vision"}
                      {m.model.supportsTools && " • tools"}
                    </div>
                  </div>
                  {isCurrent && <Check size={14} className="shrink-0 text-octo-accent" />}
                  {isLoading && (
                    <span className="text-[10px] text-zinc-500">...</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Inline button for the titlebar. */
export function ModelSwitcherButton({
  model,
  onClick,
}: {
  model: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
      title="Switch model (⌘⇧M)"
    >
      <span className="font-mono">{shortModel(model)}</span>
      <ChevronDown size={12} />
    </button>
  );
}
