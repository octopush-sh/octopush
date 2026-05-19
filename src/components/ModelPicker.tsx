import { useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { ipc } from "../lib/ipc";
import type { ModelInfo, ProviderConfig } from "../lib/types";

/** localStorage key for the recently-used model ids (most-recent first). */
const RECENTS_KEY = "octopush.modelPicker.recents";
const RECENTS_MAX = 3;

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string").slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

function pushRecent(modelId: string): string[] {
  const current = loadRecents().filter((id) => id !== modelId);
  const next = [modelId, ...current].slice(0, RECENTS_MAX);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota / disabled storage */
  }
  return next;
}

// Provider color palette — one accent dot per provider family.
const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "#cc785c",
  openai: "#74aa9c",
  deepseek: "#5c8acc",
  ollama: "#a8a8a8",
};

function providerColor(name: string): string {
  return PROVIDER_COLORS[name] ?? "var(--color-octo-sage)";
}

// Format cost as "$X.XX" trimming trailing zeros.
function formatCost(perM: number): string {
  if (perM === 0) return "free";
  if (perM < 1) return `$${perM.toFixed(2)}`;
  return `$${perM % 1 === 0 ? perM.toFixed(0) : perM.toFixed(1)}`;
}

// Format context window: "200k", "1M", etc.
function formatCtx(maxContext: number): string {
  if (maxContext >= 1_000_000) return `${maxContext / 1_000_000}M`;
  return `${Math.round(maxContext / 1000)}k`;
}

interface Props {
  activeModel: string;
  onSelectModel: (model: string) => void;
  onOpenSettings?: () => void;
}

export function ModelPicker({ activeModel, onSelectModel, onOpenSettings }: Props) {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [open, setOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => loadRecents());
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ipc.listProviders().then((provs) => {
      setProviders(provs.filter((p) => p.enabled && p.models.length > 0));
    });
  }, []);

  // Build a lookup of every available model so the Recents row knows the
  // displayName + provider for an id pulled out of localStorage.
  const modelIndex = useMemo(() => {
    const map = new Map<string, { model: ModelInfo; providerName: string }>();
    for (const p of providers) {
      for (const m of p.models) {
        map.set(m.id, { model: m, providerName: p.name });
      }
    }
    return map;
  }, [providers]);

  const recentEntries = useMemo(
    () =>
      recents
        .map((id) => modelIndex.get(id))
        .filter((x): x is { model: ModelInfo; providerName: string } => !!x),
    [recents, modelIndex],
  );

  function handleSelect(modelId: string) {
    onSelectModel(modelId);
    setRecents(pushRecent(modelId));
    setOpen(false);
  }

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  // Find active model display name + provider
  const activeInfo = (() => {
    for (const p of providers) {
      for (const m of p.models) {
        if (m.id === activeModel) {
          return { displayName: m.displayName || m.id, providerName: p.name };
        }
      }
    }
    return { displayName: activeModel || "Select model", providerName: "" };
  })();

  const dotColor = activeInfo.providerName
    ? providerColor(activeInfo.providerName)
    : "var(--color-octo-mute)";

  return (
    <div ref={containerRef} className="relative flex items-center gap-2">
      {/* Chip button */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={clsx(
          "flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[11px] transition-colors",
          open
            ? "border-octo-brass/40 bg-octo-brass/8 text-octo-brass"
            : "border-octo-hairline text-octo-sage hover:border-octo-brass/30 hover:text-octo-brass",
        )}
      >
        <span
          aria-hidden
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: dotColor }}
        />
        <span>{activeInfo.displayName}</span>
        <span
          aria-hidden
          className="ml-0.5 text-[9px] opacity-60"
        >
          ▾
        </span>
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          role="listbox"
          aria-label="Select model"
          className="absolute bottom-full left-0 z-50 mb-2 min-w-[260px] rounded-lg border border-octo-hairline bg-octo-panel shadow-xl"
        >
          {providers.length === 0 ? (
            <div className="px-4 py-3 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-mute">
              No models configured
            </div>
          ) : (
            <div className="py-2">
              {/* Recents — last 3 selected models, pinned at the top so the
                  user can flip between the ones they actually use without
                  scanning every provider. */}
              {recentEntries.length > 0 && (
                <>
                  <div className="px-3 pb-1 pt-1.5 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
                    Recents
                  </div>
                  {recentEntries.map(({ model, providerName }) => (
                    <ModelRow
                      key={`recent-${model.id}`}
                      model={model}
                      providerName={providerName}
                      isActive={activeModel === model.id}
                      onClick={() => handleSelect(model.id)}
                    />
                  ))}
                  <div className="mx-3 my-1.5 h-px bg-octo-hairline" />
                </>
              )}

              {providers.map((provider, idx) => (
                <div key={provider.name}>
                  {idx > 0 && (
                    <div className="mx-3 my-1.5 h-px bg-octo-hairline" />
                  )}

                  {/* Provider eyebrow */}
                  <div className="px-3 pb-1 pt-1.5 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">
                    {provider.name === "ollama"
                      ? "OLLAMA · local"
                      : provider.name.toUpperCase()}
                  </div>

                  {/* Model rows */}
                  {provider.models.map((model) => (
                    <ModelRow
                      key={model.id}
                      model={model}
                      providerName={provider.name}
                      isActive={activeModel === model.id}
                      onClick={() => handleSelect(model.id)}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Settings link (right side of the row — rendered by parent, but
          expose as a slot prop so caller can place it wherever) */}
      {onOpenSettings && (
        <button
          onClick={onOpenSettings}
          className="ml-auto font-mono text-[10px] uppercase tracking-[0.15em] text-octo-sage transition-colors hover:text-octo-brass"
        >
          Settings →
        </button>
      )}
    </div>
  );
}

/**
 * Single model row in the dropdown. Shared between the Recents section and
 * the per-provider sections — keeping the markup in one place means the two
 * stay visually consistent.
 */
function ModelRow({
  model,
  providerName,
  isActive,
  onClick,
}: {
  model: ModelInfo;
  providerName: string;
  isActive: boolean;
  onClick: () => void;
}) {
  const label = model.displayName || model.id;
  const dot = providerColor(providerName);
  return (
    <button
      role="option"
      aria-selected={isActive}
      onClick={onClick}
      className={clsx(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors",
        isActive
          ? "border-l-2 bg-octo-brass/8 text-octo-brass"
          : "border-l-2 border-transparent text-octo-ivory hover:bg-octo-onyx/60",
      )}
      style={isActive ? { borderLeftColor: "var(--color-octo-brass)" } : undefined}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: dot }}
      />
      <span className="text-[12px]">{label}</span>
      {/* Tags — small italic-serif pills surfacing the curated label. */}
      {model.tags && model.tags.length > 0 && (
        <span className="flex shrink-0 items-center gap-1">
          {model.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-sm px-1.5 py-px font-serif text-[9px] italic leading-tight text-octo-brass/80"
              style={{
                background: "var(--brass-ghost)",
                border: "1px solid var(--brass-dim)",
              }}
            >
              {tag}
            </span>
          ))}
        </span>
      )}
      <span className="ml-auto shrink-0 font-mono text-[9px] text-octo-mute">
        {formatCost(model.inputCostPerM)}/{formatCost(model.outputCostPerM)} · {formatCtx(model.maxContext)} ctx
      </span>
    </button>
  );
}
