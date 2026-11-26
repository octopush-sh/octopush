//! The crew report card (#983): per-stage outcomes of a pipeline's past runs
//! on this Mac, and the deterministic right-sizing rules built on them. Pure —
//! the command reads the samples and resolves prices outside the DB lock.
//! Nothing here edits a pipeline: a suggestion is only ever offered.

use crate::orchestrator::cost::{percentile, TokenSample};
use crate::token_engine::ModelPrices;

/// Below this many counted runs of a stage, no rule fires and no record shows.
pub const MIN_RUNS: usize = 8;
/// How many of a stage's latest runs feed its record.
pub const WINDOW: usize = 20;
/// How many outcomes the micro-history keeps.
pub const RECENT: usize = 10;

/// What one model spent on one stage of one run, every attempt on it summed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModelSpend {
    pub model: String,
    pub cost_usd: f64,
    /// A ledger row of it is `unpriced`: the cost is unknown, never $0.
    pub unpriced: bool,
    pub tokens: TokenSample,
}

/// One stage of one settled run, as the ledger recorded it.
#[derive(Clone, Debug, Default)]
pub struct StageRunSample {
    pub run_id: String,
    pub run_status: String,
    pub position: i64,
    pub role: String,
    pub status: String,
    pub escalated: bool,
    /// Archived attempts of this stage that failed (halted and re-ran).
    pub failed_attempts: i64,
    /// Set on a review stage: where it sends work back, and how often it did.
    pub loop_target_position: Option<i64>,
    pub loop_iterations: i64,
    pub spend: Vec<ModelSpend>,
}

impl StageRunSample {
    /// A stage that ran to an outcome: done, or halted in a run the director
    /// didn't abort (an abort cuts a running stage short, which says nothing
    /// about its model).
    fn counted(&self) -> bool {
        self.status == "done" || (self.status == "failed" && self.run_status != "aborted")
    }

    /// Every attempt summed; `None` when an attempt is unpriced or nothing
    /// was recorded.
    fn total_usd(&self) -> Option<f64> {
        if self.spend.is_empty() || self.spend.iter().any(|s| s.unpriced) {
            return None;
        }
        Some(self.spend.iter().map(|s| s.cost_usd).sum())
    }

    fn tokens(&self) -> TokenSample {
        self.spend.iter().fold(TokenSample::default(), |a, s| TokenSample {
            input: a.input + s.tokens.input,
            output: a.output + s.tokens.output,
            cache_read: a.cache_read + s.tokens.cache_read,
            cache_creation: a.cache_creation + s.tokens.cache_creation,
        })
    }
}

/// A pipeline stage as it is configured now.
#[derive(Clone, Debug)]
pub struct CurrentStage {
    pub position: i64,
    pub role: String,
    pub agent_model: String,
    pub escalate_model: Option<String>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCost {
    pub model: String,
    pub runs: usize,
    /// `None` when a run of it is unpriced.
    pub median_usd: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageOutcome {
    pub position: i64,
    pub role: String,
    pub runs: usize,
    pub first_pass: usize,
    /// Loop-backs charged to this stage: the times a review sent it back.
    pub loop_backs: i64,
    pub escalated: usize,
    pub halted: usize,
    /// Median of every attempt summed; `None` when a run is unpriced.
    pub median_usd: Option<f64>,
    pub by_model: Vec<ModelCost>,
    /// `pass` · `rework` · `halt`, newest first.
    pub recent: Vec<&'static str>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    /// `startStrong` · `lighterTier` · `loopHotspot`
    pub kind: &'static str,
    pub position: i64,
    pub role: String,
    pub runs: usize,
    /// Escalations (startStrong), first passes (lighterTier).
    pub count: usize,
    /// The model to start on.
    pub model: Option<String>,
    pub model_label: Option<String>,
    /// The escalation the edit leaves (lighterTier keeps a safety net).
    pub escalate_model: Option<String>,
    pub escalate_label: Option<String>,
    /// Estimated saving per run; `None` when a model is unpriced.
    pub saving_usd: Option<f64>,
    /// loopHotspot: the review that sends this stage back, and how often.
    pub sender_position: Option<i64>,
    pub mean_loops: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrewReport {
    pub min_runs: usize,
    pub stages: Vec<StageOutcome>,
    pub suggestions: Vec<Suggestion>,
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    percentile(&v, 0.5)
}

/// Loop-backs per (run, target position), with the position of the review
/// that sent them (the first, when two reviews target one stage).
fn loop_charges(samples: &[StageRunSample]) -> std::collections::HashMap<(String, i64), (i64, i64)> {
    let mut out: std::collections::HashMap<(String, i64), (i64, i64)> = std::collections::HashMap::new();
    for s in samples {
        let Some(target) = s.loop_target_position else { continue };
        if s.loop_iterations <= 0 {
            continue;
        }
        let e = out.entry((s.run_id.clone(), target)).or_insert((0, s.position));
        e.0 += s.loop_iterations;
    }
    out
}

/// Each current stage's window: its latest counted runs at the same
/// position, newest first, cut where the position last held another role.
/// `samples` come newest run first.
fn windows<'a>(current: &[CurrentStage], samples: &'a [StageRunSample]) -> Vec<Vec<&'a StageRunSample>> {
    current
        .iter()
        .map(|c| {
            samples
                .iter()
                .filter(|s| s.position == c.position)
                .take_while(|s| s.role == c.role)
                .filter(|s| s.counted())
                .take(WINDOW)
                .collect()
        })
        .collect()
}

/// The report: one outcome row per current stage, then the rules. `price`
/// resolves a model's prices (`None` = unpriced), `lighter` the next cheaper
/// tier of a model, `label` a model's short display name.
pub fn build_report(
    current: &[CurrentStage],
    samples: &[StageRunSample],
    price: &dyn Fn(&str) -> Option<ModelPrices>,
    lighter: &dyn Fn(&str) -> Option<String>,
    label: &dyn Fn(&str) -> String,
) -> CrewReport {
    let charges = loop_charges(samples);
    let mut report = CrewReport { min_runs: MIN_RUNS, ..Default::default() };
    for (c, window) in current.iter().zip(windows(current, samples)) {
        let loops_of = |s: &StageRunSample| charges.get(&(s.run_id.clone(), s.position)).map_or(0, |e| e.0);
        let mut out = StageOutcome {
            position: c.position,
            role: c.role.clone(),
            runs: window.len(),
            first_pass: 0,
            loop_backs: 0,
            escalated: 0,
            halted: 0,
            median_usd: None,
            by_model: Vec::new(),
            recent: Vec::new(),
        };
        let mut senders: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
        for &s in &window {
            let loops = loops_of(s);
            if let Some((n, from)) = charges.get(&(s.run_id.clone(), s.position)) {
                *senders.entry(*from).or_default() += n;
            }
            let halted = s.status == "failed";
            let pass = s.status == "done" && loops == 0 && !s.escalated && s.failed_attempts == 0;
            out.loop_backs += loops;
            out.escalated += s.escalated as usize;
            out.halted += halted as usize;
            out.first_pass += pass as usize;
            if out.recent.len() < RECENT {
                out.recent.push(if halted { "halt" } else if pass { "pass" } else { "rework" });
            }
        }
        // Unpriced stays unpriced: one unknown run and there is no figure.
        let totals: Vec<Option<f64>> = window.iter().filter(|s| !s.spend.is_empty()).map(|s| s.total_usd()).collect();
        if !totals.is_empty() && totals.iter().all(Option::is_some) {
            out.median_usd = Some(median(totals.into_iter().flatten().collect()));
        }
        let mut models: Vec<String> = Vec::new();
        for s in &window {
            for m in &s.spend {
                if !models.contains(&m.model) {
                    models.push(m.model.clone());
                }
            }
        }
        for model in models {
            let runs: Vec<&ModelSpend> = window.iter().flat_map(|s| s.spend.iter().filter(|m| m.model == model)).collect();
            let unpriced = runs.iter().any(|m| m.unpriced);
            out.by_model.push(ModelCost {
                model,
                runs: runs.len(),
                median_usd: if unpriced { None } else { Some(median(runs.iter().map(|m| m.cost_usd).collect())) },
            });
        }
        if let Some(s) = start_strong(c, &out, &window, price, label) {
            report.suggestions.push(s);
        }
        if let Some(s) = lighter_tier(c, &out, &window, price, lighter, label) {
            report.suggestions.push(s);
        }
        if out.runs >= MIN_RUNS && out.loop_backs as f64 / out.runs as f64 >= 1.5 {
            let sender = senders.into_iter().max_by_key(|(pos, n)| (*n, -*pos)).map(|(p, _)| p);
            report.suggestions.push(Suggestion {
                kind: "loopHotspot",
                position: c.position,
                role: c.role.clone(),
                runs: out.runs,
                count: out.loop_backs.max(0) as usize,
                model: None,
                model_label: None,
                escalate_model: None,
                escalate_label: None,
                saving_usd: None,
                sender_position: sender,
                mean_loops: Some(out.loop_backs as f64 / out.runs as f64),
            });
        }
        report.stages.push(out);
    }
    report
}

/// Median actual cost minus median repriced cost over the window's runs
/// with spend; `None` when any of it is unpriced or too few runs reported.
fn saving(window: &[&StageRunSample], repriced: &dyn Fn(&StageRunSample) -> Option<f64>) -> Option<f64> {
    let spent: Vec<&&StageRunSample> = window.iter().filter(|s| !s.spend.is_empty()).collect();
    if spent.len() < MIN_RUNS {
        return None;
    }
    let actual: Option<Vec<f64>> = spent.iter().map(|s| s.total_usd()).collect();
    let alt: Option<Vec<f64>> = spent.iter().map(|s| repriced(**s)).collect();
    Some(median(actual?) - median(alt?))
}

/// Rule 1: a stage that escalates in half its runs pays the cheap failed
/// attempt and then the strong one. The alternative prices each run on the
/// escalation model from the start: an escalated run at what its strong
/// attempts cost, any other run's tokens re-priced at the strong model.
fn start_strong(
    c: &CurrentStage,
    o: &StageOutcome,
    window: &[&StageRunSample],
    price: &dyn Fn(&str) -> Option<ModelPrices>,
    label: &dyn Fn(&str) -> String,
) -> Option<Suggestion> {
    let strong = c.escalate_model.as_deref().filter(|m| *m != c.agent_model)?;
    if o.runs < MIN_RUNS || o.escalated * 2 < o.runs {
        return None;
    }
    let saving_usd = match (price(&c.agent_model), price(strong)) {
        (Some(_), Some(p)) => saving(window, &|s: &StageRunSample| {
            if s.escalated {
                let on: Vec<&ModelSpend> = s.spend.iter().filter(|m| m.model == strong).collect();
                if on.is_empty() || on.iter().any(|m| m.unpriced) {
                    return None;
                }
                Some(on.iter().map(|m| m.cost_usd).sum::<f64>())
            } else {
                let t = s.tokens();
                Some(p.cost(t.input, t.output, t.cache_read, t.cache_creation))
            }
        }),
        _ => None,
    };
    // Priced and not cheaper: starting strong would not save, so say nothing.
    if saving_usd.is_some_and(|s| s <= 0.0) {
        return None;
    }
    Some(Suggestion {
        kind: "startStrong",
        position: c.position,
        role: c.role.clone(),
        runs: o.runs,
        count: o.escalated,
        model: Some(strong.to_string()),
        model_label: Some(label(strong)),
        escalate_model: None,
        escalate_label: None,
        saving_usd,
        sender_position: None,
        mean_loops: None,
    })
}

/// Rule 2: a stage that passes first time in 90% of its runs and never
/// escalates may run a tier lower. The current model stays (or becomes) the
/// escalation, so the safety net is there by construction.
fn lighter_tier(
    c: &CurrentStage,
    o: &StageOutcome,
    window: &[&StageRunSample],
    price: &dyn Fn(&str) -> Option<ModelPrices>,
    lighter: &dyn Fn(&str) -> Option<String>,
    label: &dyn Fn(&str) -> String,
) -> Option<Suggestion> {
    if o.runs < MIN_RUNS || o.escalated > 0 || o.first_pass * 10 < o.runs * 9 {
        return None;
    }
    let cheaper = lighter(&c.agent_model)?;
    let net = c.escalate_model.clone().unwrap_or_else(|| c.agent_model.clone());
    let saving_usd = match (price(&c.agent_model), price(&cheaper)) {
        (Some(_), Some(p)) => saving(window, &|s: &StageRunSample| {
            let t = s.tokens();
            Some(p.cost(t.input, t.output, t.cache_read, t.cache_creation))
        }),
        _ => None,
    };
    if saving_usd.is_some_and(|s| s <= 0.0) {
        return None;
    }
    Some(Suggestion {
        kind: "lighterTier",
        position: c.position,
        role: c.role.clone(),
        runs: o.runs,
        count: o.first_pass,
        model_label: Some(label(&cheaper)),
        model: Some(cheaper),
        escalate_label: Some(label(&net)),
        escalate_model: Some(net),
        saving_usd,
        sender_position: None,
        mean_loops: None,
    })
}

/// The next cheaper tier of `current` from the same provider (so the stage's
/// CLI or API can still run it): a curated model (it carries picker tags;
/// legacy ids kept only for pricing carry none), priced lower on both input
/// and output, with a context window at least as large, not replaced by a
/// newer model and not retiring. Of those the dearest, the first in catalog
/// order on a tie (Opus 5.5 → Sonnet 5.5, Sonnet 5.5 → Haiku 5.5). `None`
/// when the model isn't in the catalog or nothing qualifies.
pub fn next_lighter_tier(router: &crate::provider_router::ProviderRouter, current: &str) -> Option<String> {
    let (provider, model) = router.find_model(current)?;
    if provider.local || model.input_cost_per_m <= 0.0 {
        return None;
    }
    let blended = |m: &crate::provider_router::ModelInfo| m.input_cost_per_m + m.output_cost_per_m;
    let mut best: Option<&crate::provider_router::ModelInfo> = None;
    for m in provider.models.iter().filter(|m| {
        m.id != model.id
            && !m.tags.is_empty()
            && m.input_cost_per_m > 0.0
            && m.input_cost_per_m < model.input_cost_per_m
            && m.output_cost_per_m < model.output_cost_per_m
            && m.max_context >= model.max_context
            && m.superseded_by.is_none()
            && crate::token_engine::model_retirement(&m.id).is_none()
    }) {
        if best.is_none_or(|b| blended(m) > blended(b)) {
            best = Some(m);
        }
    }
    best.map(|m| m.id.clone())
}
