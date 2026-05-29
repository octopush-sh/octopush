# Provider & Model Management — design

**Date:** 2026-05-28
**Status:** Approved (pending spec review)
**Sub-project:** A of the "providers + perf-disk" release

## Motivation

Today the AI provider catalog (providers + their models) is seeded from
hardcoded Rust defaults (`provider_router::builtin_providers`) into
`~/.octopush/providers.json`. The Settings → Models & Providers pane only lets
you set an API **key** and a **base-URL override** per built-in provider. There
is no way to:

- Add a **new** provider without editing Rust (so a custom gateway can only be
  used by *hijacking* a built-in provider's base URL — e.g. pointing "Anthropic"
  at a Bedrock gateway, which means you can no longer use Anthropic-direct too).
- Add/edit/remove **model ids** (so the catalog goes stale, and a gateway that
  exposes different model ids than the three built-in Claude ids can't be used
  through the picker).

The user runs an Anthropic-compatible Bedrock gateway daily and needs both:
a first-class custom provider, and editable model ids per provider.

## Goals

- **Custom providers**: add/remove providers with `{ name, protocol
  (anthropic | openai-compatible), base URL, "runs locally / no key" }`,
  alongside (not replacing) the built-ins.
- **Editable models on any provider** (built-in or custom): add/edit/remove
  models with the essential fields (`id`, display name, input/output cost per
  million, max context). Other `ModelInfo` fields keep sensible defaults.
- **Reset a built-in provider to its shipped defaults** (escape hatch after edits).
- Changes persist to `~/.octopush/providers.json` and take effect immediately
  (the router reloads the file on each request).

## Non-goals (v1)

- Native AWS Bedrock (SigV4 / AWS credentials). Out of scope — the gateway case
  is covered by the existing `anthropic` / `openai-compatible` protocols.
- Auto-fetching models from a provider's `/v1/models` endpoint.
- Editing rate limits, tags, or the vision/tools flags in the UI (kept at
  defaults; advanced users can still hand-edit `providers.json`).
- Renaming a provider's identity after creation (the `name` is the identity used
  as the settings-keys map key and in `find_model`; to "rename", remove + re-add).

## Architecture

The data layer already exists and needs **no schema change**:

- `~/.octopush/providers.json` holds `Vec<ProviderConfig>`, each with
  `{ name, api_base, api_key_env, models: Vec<ModelInfo>, rate_limits, enabled,
  protocol, local }`. `ModelInfo` already carries `{ id, display_name,
  input_cost_per_m, output_cost_per_m, cache_*_cost_per_m, max_context,
  supports_vision, supports_tools, tags }`.
- `ProviderRouter::load()` reads the file (seeding + migrating from
  `builtin_providers()` on first run) and is called fresh in
  `chat_engine::resolve_provider` on every request — so a saved edit applies to
  the next message with no restart.
- API **keys** and **base-URL overrides** live separately in
  `~/.octopush/settings.json` (`providerKeys` / `providerBaseUrls`), already
  edited by `ModelsPane` via `saveSettings`. This split is preserved: the
  catalog (providers.json) and secrets/overrides (settings.json) stay separate.

So the feature is: a **save command** for the catalog + a **Settings UI** to edit
it. The existing read path (`ipc.listProviders`) and the existing pricing-refresh
(`ipc.refreshPricing`, which updates costs of known models) are complementary and
unchanged.

## Backend (Rust)

### Commands (`commands.rs`)

- `save_providers(providers: Vec<ProviderConfig>) -> Result<(), AppError>`
  - Validates, then writes `~/.octopush/providers.json` (pretty JSON, same shape
    `ProviderRouter::load` reads).
  - **Validation** (reject with a descriptive error → surfaced as a toast):
    - Every provider `name` is non-empty and unique (case-insensitive).
    - Every provider `protocol` ∈ {`anthropic`, `openai-compatible`}.
    - For non-`local` providers, `api_base` is non-empty.
    - Within each provider, every model `id` is non-empty and unique.
    - At least the model `id` is present; numeric fields default to 0 / a
      sensible `max_context` when omitted.
- `get_default_providers() -> Vec<ProviderConfig>`
  - Returns `builtin_providers()` as a list, so the UI's "Reset to defaults" can
    restore a single built-in provider to its shipped config.

### `provider_router.rs`

- Extract the file-writing currently inlined in `load()` into a reusable
  `pub(crate) fn write_providers(list: &[ProviderConfig]) -> AppResult<()>` and a
  `pub(crate) fn default_providers_list() -> Vec<ProviderConfig>`; `load()` uses
  the former. `save_providers` / `get_default_providers` call these. No behavior
  change to `load()`.

## Frontend (React + TypeScript)

`Settings.tsx` → `ModelsPane`, decomposed into focused subcomponents so no file
grows unwieldy:

- **`ModelsPane`** (existing, extended): owns the editable `providers` array in
  local state (loaded via `ipc.listProviders()`), plus the existing keys/baseUrls.
  "Save changes" now persists **both**: `ipc.saveSettings({...keys, baseUrls})`
  AND `ipc.saveProviders(providers)`. After save it re-fetches `listModels` so the
  model picker reflects edits.
- **`ProviderRow`** (existing, extended): keeps key + base-URL fields; gains a
  **model list** (each row: id, display name, cost, context with edit/remove) and
  an **"Add a model"** affordance; plus per-provider **Remove** (custom) and
  **Reset to defaults** (built-in) actions.
- **`ModelEditor`** (new): inline form for add/edit — fields `id`*, display name,
  input cost /M, output cost /M, max context. Other `ModelInfo` fields preserved
  (edit) or defaulted (add).
- **`AddProviderForm`** (new): name*, protocol (select: Anthropic-compatible /
  OpenAI-compatible), base URL*, "runs locally (no key)" checkbox. On add, a new
  `ProviderConfig` (enabled, empty models) is appended; the user then adds models
  + sets its key.

### Data flow

`listProviders()` → editable local state → user edits → "Save changes" →
`saveSettings` (secrets/overrides) + `saveProviders` (catalog) → next chat request
re-reads providers.json; the model picker re-fetches `listModels()`.

### Error handling

- Backend validation rejects empty/duplicate names or model ids → toast with the
  message; nothing is written on rejection.
- Removing a provider or model uses the existing `ConfirmDialog`. If the removed
  model is the one currently selected in the active workspace, the model picker
  falls back to the first available model (or shows "select a model").
- "Reset to defaults" on a built-in re-seeds that single provider from
  `get_default_providers()` in local state (applied on Save).

## Design-system alignment (Atelier in Onyx & Brass)

This UI lives **entirely inside the existing Settings → Models & Providers pane**
— no new top-level chrome, no new tab system. It mirrors the patterns already in
`ModelsPane`/`ProviderRow` so it reads as the same surface:

- **Tokens only.** Colors/fonts/spacing via `text-octo-*`, `bg-octo-*`,
  `border-octo-hairline`, `var(--brass-ghost)`, `var(--brass-dim)`. No hex, no
  off-palette Tailwind colors.
- **No italics** (per the app-wide rule — overrides the cheatsheet's "italic"
  notes). Serif is used **upright**, exactly like the current provider name
  (`font-serif text-[16px] text-octo-ivory`) and the current "Save changes" /
  "Refresh pricing" buttons (`font-serif text-octo-brass`, no `italic`).
- **CTAs are upright-serif phrases, not imperative `+` labels.** "Add a provider",
  "Add a model", "Reset to defaults" — styled like the existing primary buttons
  (`rounded-md px-3-4 py-1.5-2 font-serif text-octo-brass`, `background:
  var(--brass-ghost); border: 1px solid var(--brass-dim)`).
- **Brass is surgical (≤5%).** Brass only on primary CTAs, active states, and
  eyebrow labels. Model rows and fields are `text-octo-sage`/`octo-ivory`/`octo-mute`.
- **Type roles:** eyebrow labels in `font-mono text-[9-10px] uppercase
  tracking-[0.25em] text-octo-mute` (e.g. `COST IN /M`, `CONTEXT`, `PROTOCOL`);
  model **ids**, costs, and base URLs in `font-mono` (code/meta role, matching the
  existing key/base-URL inputs); provider/display names in upright serif/sans;
  helper text in sans `text-[12px] text-octo-sage`.
- **Inputs** reuse the established recipe: `rounded-md border border-octo-hairline
  bg-octo-onyx px-3 py-2 font-mono text-[11-12px] text-octo-ivory outline-none
  placeholder:text-octo-mute focus:border-octo-brass`. Placeholders are quiet
  upright phrases (no italics).
- **Radii:** `rounded-md` for inputs/cards, `rounded-sm` for small pills/labels.
  No pill-shaped controls. The protocol picker is a small token-styled select or
  segmented control with a brass-ghost active state — not a new pill system.
- **Destructive actions** (remove provider/model) are quiet text buttons
  (`text-octo-mute hover:text-octo-rouge`) routed through the existing
  `ConfirmDialog`; rouge (`--color-octo-rouge`) signals danger.
- **Motion** is calm — reuse existing transitions (≤280ms, `ease-octo`); no
  spring, no bounce. Adding/removing a model row may fade/height-ease at
  220–280ms; nothing flashy.
- **Icons** (if any) only from `lucide-react`.

## Testing

**Backend (Rust):**
- `save_providers` round-trip: write a list, then `ProviderRouter::load()` returns
  the same providers/models (temp-dir `HOME`, the established pattern).
- Validation: rejects duplicate provider names, duplicate model ids within a
  provider, empty name/id, bad protocol, and empty base URL for a non-local
  provider.
- `get_default_providers` returns the built-ins (Anthropic/OpenAI/DeepSeek/Ollama).

**Frontend (Vitest):**
- `ModelEditor`: entering id + fields and confirming adds a model to local state;
  blank id is blocked.
- `AddProviderForm`: adds a provider with the chosen protocol/base URL/local flag.
- `ModelsPane`: "Save changes" calls both `saveSettings` and `saveProviders` with
  the edited catalog (ipc mocked); remove triggers `ConfirmDialog`.
- Reset-to-defaults restores a built-in provider's models in local state.

## Out of scope / future

- Native AWS Bedrock (SigV4).
- `/v1/models` auto-discovery.
- Editing rate limits / tags / vision-tools flags in the UI.
- Provider identity rename.
