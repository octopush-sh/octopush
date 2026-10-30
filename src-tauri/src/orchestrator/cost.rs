//! Per-stage cost and the all-premium baseline used to show savings.

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
    let router = crate::token_engine::catalog()?;
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

/// A pre-run estimate (see [`estimate_run`]).
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEstimate {
    pub estimate_usd: f64,
    pub baseline_usd: f64,
    /// Distinct stage models with no price, in stage order.
    pub unpriced_models: Vec<String>,
    /// Stages on an unpriced model — their spend is invisible to the run's
    /// budget gate, so a budget cannot be enforced across them.
    pub unpriced_stages: usize,
}

/// Estimate a run from `(model, est. input, est. output)` per stage. An
/// unpriced stage is left out of both figures (never "free", never
/// "saved") and counted; a stage priced at $0 (free model) has nothing to
/// save against and stays out of the baseline. The baseline is never below
/// the estimate; with no priced reference it equals it. Pure — callers
/// resolve prices outside the DB lock.
pub fn estimate_run(
    stages: &[(String, u64, u64)],
    price: &dyn Fn(&str) -> Option<crate::token_engine::ModelPrices>,
    reference: Option<crate::token_engine::ModelPrices>,
) -> RunEstimate {
    let mut out = RunEstimate::default();
    let mut baseline = 0.0;
    for (model, tok_in, tok_out) in stages {
        let Some(p) = price(model) else {
            out.unpriced_stages += 1;
            if !out.unpriced_models.iter().any(|m| m == model) {
                out.unpriced_models.push(model.clone());
            }
            continue;
        };
        let c = p.cost(*tok_in, *tok_out, 0, 0);
        out.estimate_usd += c;
        if c > 0.0 {
            if let Some(r) = &reference {
                baseline += r.cost(*tok_in, *tok_out, 0, 0);
            }
        }
    }
    out.baseline_usd = if reference.is_none() || baseline < out.estimate_usd { out.estimate_usd } else { baseline };
    out
}
