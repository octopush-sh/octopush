// Settings → Models → Model tiers. Three provider-agnostic names — fast,
// balanced, strong — each mapped to one configured model. A sub-agent
// definition's `model: haiku` (Claude Code vocabulary) or an `Agent` call's
// `model: "fast"` resolves here, so the same skill runs on whatever provider
// this machine uses. Persisted read-modify-write in settings.json
// (`modelTiers`); an unset tier falls back to a substring match over the
// configured ids, exactly as before this section existed.
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { ipc } from "../../lib/ipc";
import { ModelPicker } from "../ModelPicker";

export type ModelTier = "fast" | "balanced" | "strong";

export const MODEL_TIERS: Array<{ tier: ModelTier; label: string; description: string }> = [
  { tier: "fast", label: "Fast", description: "Cheap and quick — what a definition's `haiku` or a call's `fast` asks for." },
  { tier: "balanced", label: "Balanced", description: "The everyday model — `sonnet` / `balanced`." },
  { tier: "strong", label: "Strong", description: "Deepest reasoning, highest cost — `opus` / `strong`." },
];

export function ModelTiersSection() {
  const [tiers, setTiers] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    ipc
      .getSettings()
      .then((s) => setTiers(s.modelTiers ?? {}))
      .catch(() => {});
  }, []);

  async function persist(next: Record<string, string>) {
    setTiers(next);
    try {
      const current = await ipc.getSettings();
      await ipc.saveSettings({ ...current, modelTiers: next });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {
      // Leave the picker where the user put it; the next change retries.
    }
  }

  function setTier(tier: ModelTier, modelId: string | null) {
    const next = { ...tiers };
    if (modelId) next[tier] = modelId;
    else delete next[tier];
    void persist(next);
  }

  return (
    <section data-testid="model-tiers" className="mt-8 max-w-[860px]">
      <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">Model tiers</div>
      <p className="mb-3 text-[12px] leading-[1.55] text-octo-sage">
        Provider-agnostic names a sub-agent can ask for. A Claude Code agent definition saying
        <span className="font-mono"> model: haiku</span> and an Agent call saying
        <span className="font-mono"> model: "fast"</span> both run on whatever you map here — so the same
        skill works on any provider. Unmapped tiers fall back to a name match over your configured models.
      </p>
      <div className="flex flex-col gap-2">
        {MODEL_TIERS.map(({ tier, label, description }) => (
          <div
            key={tier}
            data-testid={`tier-${tier}`}
            className="flex items-center justify-between gap-4 rounded-lg px-4 py-3"
            style={{ border: "1px solid var(--color-octo-hairline)", background: "var(--color-octo-panel)" }}
          >
            <div className="min-w-0 flex-1">
              <div className="font-serif text-[14px] leading-tight text-octo-ivory">{label}</div>
              <div className="mt-1 text-[12px] leading-[1.55] text-octo-sage">{description}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <ModelPicker activeModel={tiers[tier] ?? ""} onSelectModel={(m) => setTier(tier, m)} />
              {tiers[tier] && (
                <button
                  type="button"
                  onClick={() => setTier(tier, null)}
                  aria-label={`Clear ${label.toLowerCase()} tier`}
                  title="Clear"
                  className="flex h-6 w-6 items-center justify-center rounded text-octo-mute transition-colors hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {saved && <div className="mt-1 font-mono text-[10px] text-octo-verdigris">Saved</div>}
    </section>
  );
}
