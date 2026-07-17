//! Per-stage cost and the all-premium baseline used to show savings.

use crate::provider_router::ProviderRouter;

/// Actual cost of a stage given its model and token counts. Routes through the
/// single pricing authority (catalog-first) so DIRECT respects user-edited
/// prices and current models, not just the builtin table.
pub fn stage_cost(
    model: &str,
    input_tokens: u64,
    output_tokens: u64,
    cache_read: u64,
    cache_creation: u64,
) -> f64 {
    crate::token_engine::cost_for(model, input_tokens, output_tokens, cache_read, cache_creation)
}

/// Baseline cost: the same token counts priced at the reference (premium) model.
/// Cache tokens are NOT re-priced here — run_stages only persists input/output, so
/// the baseline re-prices the stored input/output counts. One-shot path (pre-run
/// estimate); the hot `recompute_run_cost` loop resolves the reference prices once
/// via `token_engine::prices_for` instead of calling this per stage.
pub fn baseline_cost(reference_model: &str, input_tokens: u64, output_tokens: u64) -> f64 {
    crate::token_engine::cost_for(reference_model, input_tokens, output_tokens, 0, 0)
}

/// Pick the premium reference model: highest blended (input+output) price among
/// enabled providers. Returns `None` if no models are configured.
pub fn pick_reference_model() -> Option<String> {
    let router = ProviderRouter::load().ok()?;
    router
        .list_models()
        .into_iter()
        .max_by(|a, b| {
            let pa = a.model.input_cost_per_m + a.model.output_cost_per_m;
            let pb = b.model.input_cost_per_m + b.model.output_cost_per_m;
            pa.partial_cmp(&pb).unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|m| m.model.id)
}
