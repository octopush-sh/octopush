# Claude Code contract fixtures — v2.1.242 (synthetic only)

Not a recording. This directory holds a `SYNTHETIC` file instead of `VERSION`,
so `claude_code_contract.rs` doesn't run the full recording suite on it; only
the tests that name these files read them. 2.1.242 is the release the
`modelPricing` setting arrived in (a `multiplier` above 1 needs 2.1.271+).

These are managed settings documents, which an organization writes, not output
Claude Code prints. Octopush reads them read-only (`agent_adapter::read_managed_model_pricing`)
to say in Settings › Usage that Claude Code reports spend at the organization's rates.

## The schema, as the Claude Code settings reference gives it

- `modelPricing`, managed scope only: an object with an optional `multiplier`
  and an optional `overrides` map.
- `multiplier`: a number above 0 and at most 10. It scales every cost Claude
  Code computes, override rows included.
- `overrides`: model ID → `{input, output, cacheRead, cacheWrite}`, all four
  required, each 0–10000, USD per million tokens. `cacheWrite` covers 5-minute
  and 1-hour writes.
- Sources on macOS, in order: remote (server-managed) settings, which Octopush
  can't see; the configuration profile `/Library/Managed Preferences/com.anthropic.claudecode.plist`
  (read through `plutil -convert json -o -`); then
  `/Library/Application Support/ClaudeCode/managed-settings.json` and every
  `managed-settings.d/*.json` by name, hidden and non-`.json` files skipped. Between
  files a single value is replaced and a nested block merges key by key. Between
  sources, by default (`managedSourcesBehavior: "first-wins"`), the first that
  sets any policy key is the only one used; under `"merge"` the higher-ranked
  source's value applies per key.

## Provenance

| File | What it is | Source |
|---|---|---|
| `managed-settings/docs-example.json` | multiplier 0.85 and one override row | **copied exactly** from the Claude Code settings reference (https://code.claude.com/docs/en/settings-reference), as the owner pasted it on #1111 |
| `managed-settings/multiplier-only.json` | a multiplier, no `overrides` | **synthetic** |
| `managed-settings/malformed-row.json` | multiplier 0 (out of range) and six rows: one good, one missing `cacheWrite`, one rate above 10000, one rate as a string, one negative rate, one all zero (valid) | **synthetic** |
| `managed-settings/mdm-other-policy.json` | a configuration profile, as `plutil` prints it, that sets a policy key (`cleanupPeriodDays`) and no `modelPricing` | **synthetic** |
| `managed-settings/mdm-behavior-only.json` | a profile that sets only `managedSourcesBehavior: "merge"`, which isn't a policy key | **synthetic** |
| `managed-settings/mdm-merge-other-policy.json` | a profile with `"merge"` and a policy key, no `modelPricing` | **synthetic** |
| `managed-dir/` | a managed settings directory: `managed-settings.json` (the docs example), `managed-settings.d/10-rates.json` (a new row, and a new `input` on the existing one), `20-markup.json` (multiplier 1.1), and three files the reader skips: `.30-hidden.json` and `40-notes.txt` (Claude Code skips them too), `50-broken.json` (not JSON; what Claude Code does with it isn't documented, Octopush reads past it) | **synthetic** |

Replace or extend with a real managed settings file when one is available.
