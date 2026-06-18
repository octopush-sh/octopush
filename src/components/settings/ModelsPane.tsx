// Settings → Models — a master-detail catalog editor. The provider list (master)
// sits beside a detail panel for the selected provider; add/edit happen in
// focused dialogs, and an unsaved-changes bar reveals only when the working copy
// diverges from what's on disk. Backend contract is unchanged: saveProviders
// validates server-side, then keys/base-URLs merge into settings.json.
import { useEffect, useMemo, useState } from "react";
import { Pencil, X, RefreshCw, Plus } from "lucide-react";
import { ipc } from "../../lib/ipc";
import type { ModelInfo, ProviderConfig } from "../../lib/types";
import { ConfirmDialog } from "../ConfirmDialog";
import { IconButton } from "../controls/IconButton";
import { Reveal } from "../primitives/Reveal";
import { pushToast } from "../Toasts";
import { PaneHeader } from "./shared";
import { ModelDialog } from "./ModelDialog";
import { AddProviderDialog } from "./AddProviderDialog";

const BUILTIN_PROVIDER_NAMES = new Set(["anthropic", "openai", "deepseek", "ollama"]);

type Snapshot = string; // stable serialization of { providers, keys, baseUrls }

function serialize(providers: ProviderConfig[], keys: Record<string, string>, baseUrls: Record<string, string>): Snapshot {
  return JSON.stringify({ providers, keys, baseUrls });
}

type ModelDialogState =
  | { mode: "add" }
  | { mode: "edit"; model: ModelInfo };

export function ModelsPane() {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [baseUrls, setBaseUrls] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>(serialize([], {}, {}));
  const [saving, setSaving] = useState(false);
  const [defaults, setDefaults] = useState<ProviderConfig[] | null>(null);

  const [refreshingPricing, setRefreshingPricing] = useState(false);
  const [lastPricingRefresh, setLastPricingRefresh] = useState<string | null>(null);
  const [pricingMessage, setPricingMessage] = useState<string | null>(null);

  const [showAddProvider, setShowAddProvider] = useState(false);
  const [modelDialog, setModelDialog] = useState<ModelDialogState | null>(null);
  const [confirmRemoveProvider, setConfirmRemoveProvider] = useState<string | null>(null);
  const [confirmRemoveModelId, setConfirmRemoveModelId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([ipc.listProviders(), ipc.getSettings()]).then(([provs, settings]) => {
      const k = settings.providerKeys ?? {};
      const b = settings.providerBaseUrls ?? {};
      setProviders(provs);
      setKeys(k);
      setBaseUrls(b);
      setSnapshot(serialize(provs, k, b));
      setLastPricingRefresh(settings.lastPricingRefresh ?? null);
      setSelectedName((cur) => cur ?? provs[0]?.name ?? null);
    });
  }, []);

  const dirty = useMemo(
    () => serialize(providers, keys, baseUrls) !== snapshot,
    [providers, keys, baseUrls, snapshot],
  );

  // Resolve the selected provider, falling back to the first if the selection
  // was removed (so the detail pane is never blank while providers exist).
  const selected = useMemo(
    () => providers.find((p) => p.name === selectedName) ?? providers[0] ?? null,
    [providers, selectedName],
  );

  async function getDefaults(): Promise<ProviderConfig[]> {
    if (defaults) return defaults;
    const d = await ipc.getDefaultProviders();
    setDefaults(d);
    return d;
  }

  function patchProvider(name: string, updated: ProviderConfig) {
    setProviders((ps) => ps.map((x) => (x.name === name ? updated : x)));
  }

  async function handleSave() {
    setSaving(true);
    try {
      // Save the catalog first — it validates server-side and throws on invalid
      // input, so we don't write settings.json for a rejected catalog.
      await ipc.saveProviders(providers);
      // Read-modify-write: save_settings overwrites the whole file, so we merge
      // onto the existing settings — otherwise we'd wipe gitCredentials,
      // issueTracker, editorCommand, and lastPricingRefresh.
      const current = await ipc.getSettings();
      const filteredKeys = Object.fromEntries(Object.entries(keys).filter(([, v]) => v && v.length > 0));
      const filteredBaseUrls = Object.fromEntries(Object.entries(baseUrls).filter(([, v]) => v && v.length > 0));
      await ipc.saveSettings({ ...current, providerKeys: filteredKeys, providerBaseUrls: filteredBaseUrls });
      // Refresh models so the picker reflects edits.
      await ipc.listModels?.();
      // Align the working copy + snapshot with exactly what was persisted —
      // empty credential entries are dropped on disk, so adopt the filtered set
      // here too, otherwise the in-memory snapshot wouldn't match a fresh load.
      setKeys(filteredKeys);
      setBaseUrls(filteredBaseUrls);
      setSnapshot(serialize(providers, filteredKeys, filteredBaseUrls));
    } catch (e) {
      pushToast({ level: "error", title: "Save failed", body: String(e) });
    } finally {
      setSaving(false);
    }
  }

  function handleDiscard() {
    try {
      const snap = JSON.parse(snapshot) as { providers: ProviderConfig[]; keys: Record<string, string>; baseUrls: Record<string, string> };
      setProviders(snap.providers);
      setKeys(snap.keys);
      setBaseUrls(snap.baseUrls);
    } catch {
      /* snapshot is always valid JSON we wrote — ignore */
    }
  }

  async function handleRefreshPricing() {
    // Pricing refresh replaces the in-memory catalog with the server's freshly
    // priced one. Refuse while there are unsaved edits so we never silently
    // clobber them.
    if (dirty) {
      pushToast({
        level: "error",
        title: "Unsaved changes",
        body: "Save or discard your changes before refreshing pricing.",
      });
      return;
    }
    setRefreshingPricing(true);
    setPricingMessage(null);
    try {
      const result = await ipc.refreshPricing();
      setLastPricingRefresh(result.fetchedAt);
      setPricingMessage(`Updated ${result.modelsUpdated} of ${result.modelsTotal}`);
      const provs = await ipc.listProviders();
      setProviders(provs);
      setSnapshot((s) => {
        // Pricing refresh writes to disk server-side; rebase the snapshot's
        // providers onto the refreshed catalog so it doesn't read as dirty.
        try {
          const parsed = JSON.parse(s);
          return serialize(provs, parsed.keys, parsed.baseUrls);
        } catch {
          return serialize(provs, keys, baseUrls);
        }
      });
    } catch (e) {
      setPricingMessage(`Refresh failed: ${String(e)}`);
    } finally {
      setRefreshingPricing(false);
      setTimeout(() => setPricingMessage(null), 5000);
    }
  }

  function submitModel(m: ModelInfo) {
    if (!selected) return;
    if (modelDialog?.mode === "edit") {
      const prevId = modelDialog.model.id;
      patchProvider(selected.name, {
        ...selected,
        models: selected.models.map((x) => (x.id === prevId ? m : x)),
      });
    } else {
      patchProvider(selected.name, { ...selected, models: [...selected.models, m] });
    }
    setModelDialog(null);
  }

  function removeModel(id: string) {
    if (selected) patchProvider(selected.name, { ...selected, models: selected.models.filter((m) => m.id !== id) });
    setConfirmRemoveModelId(null);
  }

  async function resetToDefaults() {
    if (!selected) return;
    const defs = await getDefaults();
    const def = defs.find((d) => d.name === selected.name);
    if (def) {
      patchProvider(selected.name, { ...selected, models: def.models, apiBase: def.apiBase, protocol: def.protocol });
    }
  }

  return (
    <>
      <PaneHeader
        eyebrow="Models & Providers"
        title="Choose where your tokens go."
        subtitle="API keys live on this machine in ~/.octopush/settings.json. They never leave the device except in requests to the providers themselves."
      />

      <div className="grid max-w-[860px] grid-cols-[220px_1fr] gap-5">
        {/* ── Master: provider list ── */}
        <div className="flex flex-col gap-1">
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">Providers</div>
          {providers.map((p) => (
            <ProviderListItem
              key={p.name}
              provider={p}
              active={selected?.name === p.name}
              onSelect={() => setSelectedName(p.name)}
            />
          ))}

          <button
            type="button"
            onClick={() => setShowAddProvider(true)}
            className="mt-2 flex items-center gap-2 rounded-md px-3 py-2 font-serif text-[13px] text-octo-brass transition"
            style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
          >
            <Plus size={13} /> Add a provider
          </button>

          {/* Pricing — quiet footer */}
          <div className="mt-3 flex items-center gap-2 border-t border-octo-hairline pt-3">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[8px] uppercase tracking-[0.25em] text-octo-mute">Pricing</div>
              <div className="octo-tabular mt-0.5 truncate font-mono text-[10px] text-octo-sage" title={pricingMessage ?? undefined}>
                {pricingMessage ?? formatLastRefresh(lastPricingRefresh)}
              </div>
            </div>
            <IconButton label="Refresh pricing" onClick={() => void handleRefreshPricing()} disabled={refreshingPricing}>
              <RefreshCw size={12} className={refreshingPricing ? "animate-spin" : ""} />
            </IconButton>
          </div>
        </div>

        {/* ── Detail: selected provider ── */}
        <div className="min-w-0">
          {selected ? (
            <ProviderDetail
              provider={selected}
              isBuiltin={BUILTIN_PROVIDER_NAMES.has(selected.name)}
              apiKey={keys[selected.name] ?? ""}
              baseUrl={baseUrls[selected.name] ?? ""}
              showKey={shown[selected.name] ?? false}
              onChangeKey={(v) => setKeys((s) => ({ ...s, [selected.name]: v }))}
              onChangeBaseUrl={(v) => setBaseUrls((s) => ({ ...s, [selected.name]: v }))}
              onToggleShowKey={() => setShown((s) => ({ ...s, [selected.name]: !s[selected.name] }))}
              onAddModel={() => setModelDialog({ mode: "add" })}
              onEditModel={(m) => setModelDialog({ mode: "edit", model: m })}
              onRemoveModel={(id) => setConfirmRemoveModelId(id)}
              onResetToDefaults={() => void resetToDefaults()}
              onRemoveProvider={() => setConfirmRemoveProvider(selected.name)}
            />
          ) : (
            <div className="font-serif text-[13px] text-octo-mute">No providers configured.</div>
          )}
        </div>
      </div>

      {/* ── Unsaved-changes bar ── */}
      <div className="sticky bottom-0 mt-6 max-w-[860px]">
        <Reveal open={dirty}>
          <div
            className="flex items-center gap-3 rounded-lg px-4 py-2.5"
            style={{ background: "var(--color-octo-panel-2)", border: "1px solid var(--brass-dim)" }}
          >
            <span className="font-serif text-[13px] text-octo-ivory">Unsaved changes</span>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="ml-auto min-w-[120px] rounded-md px-4 py-1.5 text-center font-serif text-[13px] text-octo-brass transition-colors disabled:opacity-50"
              style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
            <button
              type="button"
              onClick={handleDiscard}
              disabled={saving}
              className="text-[12px] text-octo-mute transition hover:text-octo-sage disabled:opacity-50"
            >
              Discard
            </button>
          </div>
        </Reveal>
      </div>

      {/* ── Dialogs ── */}
      {showAddProvider && (
        <AddProviderDialog
          existingNames={providers.map((p) => p.name)}
          onAdd={(p) => {
            setProviders((ps) => [...ps, p]);
            setSelectedName(p.name);
            setShowAddProvider(false);
          }}
          onClose={() => setShowAddProvider(false)}
        />
      )}

      {modelDialog && selected && (
        <ModelDialog
          providerName={displayProviderName(selected.name)}
          initial={modelDialog.mode === "edit" ? modelDialog.model : undefined}
          takenIds={
            modelDialog.mode === "edit"
              ? selected.models.filter((x) => x.id !== modelDialog.model.id).map((x) => x.id)
              : selected.models.map((x) => x.id)
          }
          onSubmit={submitModel}
          onClose={() => setModelDialog(null)}
        />
      )}

      {confirmRemoveProvider && (
        <ConfirmDialog
          title={`Remove provider "${confirmRemoveProvider}"?`}
          body="The provider and all its models will be removed from the catalog. This cannot be undone without resetting to defaults."
          destructiveLabel="Remove provider"
          onConfirm={() => {
            const removed = confirmRemoveProvider;
            const next = providers.filter((p) => p.name !== removed);
            setProviders(next);
            // Remove is only reachable from the selected provider's detail, so
            // advance the selection to keep selectedName truthful.
            if (selectedName === removed || selected?.name === removed) {
              setSelectedName(next[0]?.name ?? null);
            }
            // Prune orphaned credentials so they aren't re-persisted for a
            // provider that no longer exists in the catalog.
            setKeys((k) => Object.fromEntries(Object.entries(k).filter(([n]) => n !== removed)));
            setBaseUrls((b) => Object.fromEntries(Object.entries(b).filter(([n]) => n !== removed)));
            setConfirmRemoveProvider(null);
          }}
          onCancel={() => setConfirmRemoveProvider(null)}
        />
      )}

      {confirmRemoveModelId && (
        <ConfirmDialog
          title={`Remove model "${confirmRemoveModelId}"?`}
          body="This model will be removed from the provider's catalog."
          destructiveLabel="Remove model"
          onConfirm={() => removeModel(confirmRemoveModelId)}
          onCancel={() => setConfirmRemoveModelId(null)}
        />
      )}
    </>
  );
}

// ─── Provider list item (master) ──────────────────────────────────────

function ProviderListItem({ provider, active, onSelect }: {
  provider: ProviderConfig;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className="flex items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors duration-[180ms]"
      style={{
        background: active ? "var(--brass-ghost)" : "transparent",
        border: active ? "1px solid var(--brass-dim)" : "1px solid transparent",
      }}
    >
      <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: providerDot(provider.name) }} />
      <span className={`flex-1 truncate font-serif text-[14px] ${active ? "text-octo-brass" : "text-octo-ivory"}`}>
        {displayProviderName(provider.name)}
      </span>
      <span className="octo-tabular shrink-0 font-mono text-[10px] text-octo-mute">
        {provider.local ? "local" : provider.models.length}
      </span>
    </button>
  );
}

// ─── Provider detail ──────────────────────────────────────────────────

function ProviderDetail({
  provider,
  isBuiltin,
  apiKey,
  baseUrl,
  showKey,
  onChangeKey,
  onChangeBaseUrl,
  onToggleShowKey,
  onAddModel,
  onEditModel,
  onRemoveModel,
  onResetToDefaults,
  onRemoveProvider,
}: {
  provider: ProviderConfig;
  isBuiltin: boolean;
  apiKey: string;
  baseUrl: string;
  showKey: boolean;
  onChangeKey: (v: string) => void;
  onChangeBaseUrl: (v: string) => void;
  onToggleShowKey: () => void;
  onAddModel: () => void;
  onEditModel: (m: ModelInfo) => void;
  onRemoveModel: (id: string) => void;
  onResetToDefaults: () => void;
  onRemoveProvider: () => void;
}) {
  return (
    <div className="octo-fade-in">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2.5">
          <h3 className="font-serif text-[17px] text-octo-ivory">{displayProviderName(provider.name)}</h3>
          <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
            {provider.local ? "local" : "cloud"}
          </span>
        </div>
        {isBuiltin ? (
          <button
            type="button"
            onClick={onResetToDefaults}
            className="font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute transition hover:text-octo-sage"
            title="Reset to defaults"
          >
            Reset to defaults
          </button>
        ) : (
          <button
            type="button"
            onClick={onRemoveProvider}
            className="font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute transition hover:text-octo-rouge"
            title="Remove provider"
          >
            Remove
          </button>
        )}
      </div>
      <p className="mt-1 text-[12px] leading-[1.55] text-octo-sage">{providerDescription(provider)}</p>

      {/* Credentials */}
      <div className="mt-4 space-y-3">
        {!provider.local && (
          <div>
            <div className="mb-1 font-mono text-[8px] uppercase tracking-[0.25em] text-octo-mute">API key</div>
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => onChangeKey(e.target.value)}
                placeholder="API key"
                className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 pr-12 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
              />
              <button
                type="button"
                onClick={onToggleShowKey}
                className="absolute right-2 top-1/2 -translate-y-1/2 px-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute hover:text-octo-brass"
              >
                {showKey ? "Hide" : "Show"}
              </button>
            </div>
          </div>
        )}

        <div>
          <div className="mb-1 font-mono text-[8px] uppercase tracking-[0.25em] text-octo-mute">
            Base URL {provider.local ? "(required)" : "(optional override)"}
          </div>
          <input
            value={baseUrl}
            onChange={(e) => onChangeBaseUrl(e.target.value)}
            placeholder={provider.apiBase}
            className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[11px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
          />
        </div>
      </div>

      {/* Models */}
      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between">
          <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">
            Models · {provider.models.length}
          </div>
          <button
            type="button"
            onClick={onAddModel}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1 font-serif text-[12px] text-octo-brass transition"
            style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
            aria-label="Add a model"
          >
            <Plus size={12} /> Add a model
          </button>
        </div>

        {provider.models.length === 0 ? (
          <div className="rounded-md border border-dashed border-octo-hairline px-3 py-4 text-center font-serif text-[12px] text-octo-mute">
            No models yet.
          </div>
        ) : (
          <ul className="space-y-1">
            {provider.models.map((m) => (
              <li
                key={m.id}
                className="octo-rise-in flex items-center justify-between gap-2 rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <span className="font-mono text-[11px] text-octo-ivory">{m.id}</span>
                  {m.displayName && m.displayName !== m.id && (
                    <span className="ml-2 font-sans text-[10px] text-octo-sage">{m.displayName}</span>
                  )}
                  <span className="octo-tabular ml-2 font-mono text-[9px] text-octo-mute">
                    ${m.inputCostPerM}/{m.outputCostPerM} · {(m.maxContext / 1000).toFixed(0)}k ctx
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <IconButton label={`Edit model ${m.id}`} onClick={() => onEditModel(m)}>
                    <Pencil size={12} />
                  </IconButton>
                  <IconButton label={`Remove model ${m.id}`} danger onClick={() => onRemoveModel(m.id)}>
                    <X size={12} />
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

// Built-in providers have canonical capitalizations that a naive title-case
// would mangle (e.g. "openai" → "Openai" instead of "OpenAI").
const PROVIDER_DISPLAY: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  ollama: "Ollama",
};

function displayProviderName(name: string): string {
  return PROVIDER_DISPLAY[name] ?? titleCase(name);
}

function titleCase(name: string): string {
  return name ? name[0].toUpperCase() + name.slice(1) : name;
}

function providerDot(name: string): string {
  switch (name) {
    case "anthropic": return "var(--provider-anthropic)";
    case "openai": return "var(--provider-openai)";
    case "deepseek": return "var(--provider-deepseek)";
    case "ollama": return "var(--provider-ollama)";
    default: return "var(--color-octo-mute)";
  }
}

function providerDescription(p: ProviderConfig): string {
  switch (p.name) {
    case "anthropic": return "Claude models (Opus, Sonnet, Haiku). Get your key at console.anthropic.com.";
    case "openai": return "GPT-4o and friends. Get your key at platform.openai.com.";
    case "deepseek": return "Cheaper alternative with strong code performance. platform.deepseek.com.";
    case "ollama": return "Local models running on this machine. Install via ollama.com — no key required.";
    default: return `${p.protocol} provider at ${p.apiBase}.`;
  }
}

function formatLastRefresh(iso: string | null): string {
  if (!iso) return "Never refreshed";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffH = Math.floor(diffMs / 3_600_000);
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffH >= 24) return `${Math.floor(diffH / 24)}d ago`;
  if (diffH >= 1) return `${diffH}h ago`;
  if (diffMin >= 1) return `${diffMin}m ago`;
  return "just now";
}
