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

/// [`stage_cost`] with `cache_creation_1h` of the writes at the 1-hour
/// cache-write rate (Claude Code stream usage carries the TTL breakdown).
pub fn stage_cost_split(
    model: &str,
    input_tokens: u64,
    output_tokens: u64,
    cache_read: u64,
    cache_creation: u64,
    cache_creation_1h: u64,
) -> f64 {
    crate::token_engine::cost_for_split(model, input_tokens, output_tokens, cache_read, cache_creation, cache_creation_1h)
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

/// Fewer past runs of a `(role, effort)` than this and the estimate falls
/// back to the role's built-in token prior, labelled `rough`.
pub const MIN_HISTORY_SAMPLES: usize = 3;
/// How many of the most recent completed stages of a `(role, effort)` feed
/// its percentiles.
pub const MAX_HISTORY_SAMPLES: usize = 20;
/// The cold-start range: the role's token prior is the low end, this many
/// times it the high end (agentic stages usually burn well past the prior).
pub const PRIOR_HIGH_FACTOR: u64 = 3;

/// Tokens one completed stage burned, summed over all its attempts.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TokenSample {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
}

impl TokenSample {
    fn cost(&self, p: &crate::token_engine::ModelPrices) -> f64 {
        p.cost(self.input, self.output, self.cache_read, self.cache_creation)
    }

    fn scaled(&self, k: u64) -> TokenSample {
        TokenSample {
            input: self.input * k,
            output: self.output * k,
            cache_read: self.cache_read * k,
            cache_creation: self.cache_creation * k,
        }
    }
}

/// One stage to estimate: the model it would run on, this Mac's history for
/// its `(role, effort)`, and the role's built-in token prior.
#[derive(Clone, Debug)]
pub struct StagePlan {
    pub position: i64,
    pub role: String,
    pub effort: Option<String>,
    pub model: String,
    pub samples: Vec<TokenSample>,
    pub prior: TokenSample,
}

/// The estimate for one stage. `low_usd`/`high_usd` are `None` when its
/// model is unpriced — unknown, never `$0`.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageEstimate {
    pub position: i64,
    pub role: String,
    pub effort: Option<String>,
    pub model: String,
    pub low_usd: Option<f64>,
    pub high_usd: Option<f64>,
    /// Past stages the range came from (0 on the prior).
    pub samples: usize,
    /// The range is the built-in prior, not this Mac's history.
    pub rough: bool,
}

/// A pre-run estimate (see [`estimate_run`]).
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEstimate {
    /// The run's central figure: the sum of the stages' medians.
    pub estimate_usd: f64,
    /// The p25 and p75 of the priced stages, summed.
    pub low_usd: f64,
    pub high_usd: f64,
    pub baseline_usd: f64,
    /// Distinct stage models with no price, in stage order.
    pub unpriced_models: Vec<String>,
    /// Stages on an unpriced model — their spend is invisible to the run's
    /// budget gate, so a budget cannot be enforced across them.
    pub unpriced_stages: usize,
    pub per_stage: Vec<StageEstimate>,
    /// `history` when every priced stage came from past runs, else `rough`.
    pub confidence: &'static str,
}

/// The `p` quantile (0..=1) of an ascending slice, linearly interpolated
/// between the closest ranks. `0.0` for an empty slice.
pub fn percentile(sorted: &[f64], p: f64) -> f64 {
    match sorted.len() {
        0 => 0.0,
        1 => sorted[0],
        n => {
            let rank = p.clamp(0.0, 1.0) * (n - 1) as f64;
            let lo = rank.floor() as usize;
            let hi = rank.ceil() as usize;
            sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo as f64)
        }
    }
}

/// `(p25, p50, p75)` of the samples, each priced at `p`. The tokens are
/// re-priced at the chosen model, so the range is right after a model swap.
fn quartiles(samples: &[TokenSample], p: &crate::token_engine::ModelPrices) -> (f64, f64, f64) {
    let mut costs: Vec<f64> = samples.iter().map(|s| s.cost(p)).collect();
    costs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    (percentile(&costs, 0.25), percentile(&costs, 0.5), percentile(&costs, 0.75))
}

/// Whether a stage has too little history and falls back to its prior.
fn is_rough(stage: &StagePlan) -> bool {
    stage.samples.len() < MIN_HISTORY_SAMPLES
}

/// `(low, mid, high)` of a stage priced at `p`: the history's quartiles, or
/// on a cold start the prior, `PRIOR_HIGH_FACTOR` × it, and their midpoint.
fn range(stage: &StagePlan, p: &crate::token_engine::ModelPrices) -> (f64, f64, f64) {
    if is_rough(stage) {
        let low = stage.prior.cost(p);
        let high = stage.prior.scaled(PRIOR_HIGH_FACTOR).cost(p);
        (low, (low + high) / 2.0, high)
    } else {
        quartiles(&stage.samples, p)
    }
}

/// Estimate a run, stage by stage. Each stage's range is the p25–p75 of
/// its history re-priced at its model (or the rough prior). An unpriced
/// stage is left out of every figure (never "free", never "saved") and
/// counted; a stage priced at $0 (free model) has nothing to save against
/// and stays out of the baseline. The baseline re-prices each stage's
/// median tokens at the reference model; it is never below the estimate
/// and with no priced reference equals it. Pure — callers resolve prices
/// outside the DB lock.
pub fn estimate_run(
    stages: &[StagePlan],
    price: &dyn Fn(&str) -> Option<crate::token_engine::ModelPrices>,
    reference: Option<crate::token_engine::ModelPrices>,
) -> RunEstimate {
    let mut out = RunEstimate { confidence: "history", ..Default::default() };
    let mut baseline = 0.0;
    for stage in stages {
        let rough = is_rough(stage);
        let mut row = StageEstimate {
            position: stage.position,
            role: stage.role.clone(),
            effort: stage.effort.clone(),
            model: stage.model.clone(),
            samples: if rough { 0 } else { stage.samples.len() },
            rough,
            ..Default::default()
        };
        let Some(p) = price(&stage.model) else {
            out.unpriced_stages += 1;
            if !out.unpriced_models.iter().any(|m| m == &stage.model) {
                out.unpriced_models.push(stage.model.clone());
            }
            out.per_stage.push(row);
            continue;
        };
        if rough {
            out.confidence = "rough";
        }
        let (low, mid, high) = range(stage, &p);
        row.low_usd = Some(low);
        row.high_usd = Some(high);
        out.low_usd += low;
        out.high_usd += high;
        out.estimate_usd += mid;
        if mid > 0.0 {
            if let Some(r) = &reference {
                baseline += range(stage, r).1;
            }
        }
        out.per_stage.push(row);
    }
    out.baseline_usd = if reference.is_none() || baseline < out.estimate_usd { out.estimate_usd } else { baseline };
    out
}
