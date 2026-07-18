import { ipc } from "./ipc";

/**
 * Persist an Anthropic API key + enable the provider, via the SAME path
 * Settings·Models uses (`save_providers` + `save_settings` read-modify-write) —
 * one source of truth for provider keys, no second writer. Used by the genesis
 * surface's inline key capture (G4) so a cold user never has to leave the flow.
 *
 * Enables the `anthropic` provider (adding it from the default catalog if the
 * user's list doesn't have it yet) and merges the key into `providerKeys` without
 * clobbering the rest of settings.
 */
export async function saveAnthropicKey(key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("empty key");

  const providers = await ipc.listProviders();
  let anthropic = providers.find((p) => p.name === "anthropic");
  let next = providers;
  if (anthropic) {
    // Enable it in place.
    next = providers.map((p) => (p.name === "anthropic" ? { ...p, enabled: true } : p));
  } else {
    // The user's catalog somehow lacks anthropic — graft it from the defaults.
    const defaults = await ipc.getDefaultProviders();
    const def = defaults.find((p) => p.name === "anthropic");
    if (!def) throw new Error("no Anthropic provider available");
    anthropic = { ...def, enabled: true };
    next = [...providers, anthropic];
  }
  // Catalog first (validates server-side), then merge the key into settings.
  await ipc.saveProviders(next);
  const current = await ipc.getSettings();
  await ipc.saveSettings({
    ...current,
    providerKeys: { ...current.providerKeys, anthropic: trimmed },
  });
}
