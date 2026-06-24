//! Entitlement — the single source of truth for "what is this install allowed
//! to do".
//!
//! **P0 (this change):** everyone is on the **Free** plan, and Free currently
//! grants *everything* with no caps — so behavior is unchanged. What ships now
//! is the *shape* (the [`Entitlement`] model + the gate helpers) and the gate
//! *points* (e.g. [`Entitlement::check_direct_run_quota`], consulted in
//! `commands::start_run`). Turning enforcement on later is therefore a **data
//! change** (return a restricted entitlement), not a refactor.
//!
//! **Later phases:** [`Entitlement::current`] will return a short-lived,
//! Ed25519-signed entitlement derived from the signed-in user's subscription
//! (verified in-process, cached with an offline grace window). See
//! `docs/premium/accounts-and-subscriptions-implementation-plan.md`.

use serde::Serialize;

/// Feature keys gated by tier. Free holds all of them today (P0); P2/P4 drop the
/// premium keys from the Free entitlement once accounts + billing exist.
pub mod feature {
    /// Run Direct pipelines without the monthly free cap.
    pub const DIRECT_UNLIMITED: &str = "direct.unlimited";
    /// Run pipelines in parallel / in the background across workspaces.
    pub const RUNS_PARALLEL: &str = "runs.parallel";
    /// Unlimited run history + cross-machine sync.
    pub const HISTORY_SYNC: &str = "history.sync";
}

/// The proposed Free monthly Direct-run cap. Defined now (so the meter, the
/// restricted entitlement, and tests share one number); **activated in P2**.
pub const FREE_DIRECT_RUNS_PER_MONTH: u32 = 25;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Plan {
    Free,
    Pro,
    Team,
    Enterprise,
}

/// What an install is entitled to. Serialized to the frontend as camelCase.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entitlement {
    pub plan: Plan,
    pub features: Vec<String>,
    /// Cap on Direct runs per calendar month; `None` = unlimited.
    pub direct_runs_per_month: Option<u32>,
}

/// A quota gate refusal — mapped to `AppError::UpgradeRequired` at the command
/// boundary so the frontend can show an upgrade sheet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuotaDenied {
    pub feature: &'static str,
    pub used: u32,
    pub limit: u32,
}

impl Entitlement {
    /// The current entitlement. **P0:** a hard-coded Free that grants everything
    /// (zero behavior change). The gate points already consult this, so P2 only
    /// needs to return [`Entitlement::free_restricted`] for unpaid users plus a
    /// real signed entitlement for subscribers.
    pub fn current() -> Self {
        Self::free_unrestricted()
    }

    /// P0 Free: every feature granted, no caps. Keeps behavior identical to
    /// pre-accounts Octopush while the gating structure lands.
    pub fn free_unrestricted() -> Self {
        Entitlement {
            plan: Plan::Free,
            features: vec![
                feature::DIRECT_UNLIMITED.into(),
                feature::RUNS_PARALLEL.into(),
                feature::HISTORY_SYNC.into(),
            ],
            direct_runs_per_month: None,
        }
    }

    /// The restricted Free tier P2 will switch to once billing exists: no
    /// premium features, and the monthly Direct-run cap turned on. Defined now
    /// so the gate logic that enforces it is unit-tested before it ships.
    pub fn free_restricted() -> Self {
        Entitlement {
            plan: Plan::Free,
            features: Vec::new(),
            direct_runs_per_month: Some(FREE_DIRECT_RUNS_PER_MONTH),
        }
    }

    pub fn has_feature(&self, key: &str) -> bool {
        self.features.iter().any(|f| f == key)
    }

    /// `Some(remaining)` for a capped plan, `None` when unlimited.
    pub fn direct_runs_remaining(&self, used: u32) -> Option<u32> {
        self.direct_runs_per_month
            .map(|limit| limit.saturating_sub(used))
    }

    /// The gate consulted before a Direct run starts. `Ok(())` when allowed;
    /// `Err(QuotaDenied)` when the monthly cap is reached on a capped plan.
    ///
    /// With the P0 Free entitlement (has `DIRECT_UNLIMITED`, cap `None`) this is
    /// **always `Ok`** — no run is blocked today.
    pub fn check_direct_run_quota(&self, used: u32) -> Result<(), QuotaDenied> {
        if self.has_feature(feature::DIRECT_UNLIMITED) {
            return Ok(());
        }
        if let Some(limit) = self.direct_runs_per_month {
            if used >= limit {
                return Err(QuotaDenied {
                    feature: feature::DIRECT_UNLIMITED,
                    used,
                    limit,
                });
            }
        }
        Ok(())
    }
}

/// Monthly Direct-run usage shown by the launcher meter. `limit == None` means
/// the current plan is uncapped (the P0 state).
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectRunUsage {
    pub used: u32,
    pub limit: Option<u32>,
    pub remaining: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p0_free_grants_everything_and_is_uncapped() {
        let e = Entitlement::current();
        assert_eq!(e.plan, Plan::Free);
        assert!(e.has_feature(feature::DIRECT_UNLIMITED));
        assert!(e.has_feature(feature::RUNS_PARALLEL));
        assert!(e.has_feature(feature::HISTORY_SYNC));
        assert_eq!(e.direct_runs_per_month, None);
        assert_eq!(e.direct_runs_remaining(9999), None);
    }

    #[test]
    fn unlimited_plan_never_blocks_a_run() {
        let e = Entitlement::free_unrestricted();
        // Even with absurd usage, unlimited never denies.
        assert!(e.check_direct_run_quota(0).is_ok());
        assert!(e.check_direct_run_quota(10_000).is_ok());
    }

    #[test]
    fn restricted_free_enforces_the_monthly_cap() {
        let e = Entitlement::free_restricted();
        assert!(!e.has_feature(feature::DIRECT_UNLIMITED));
        assert_eq!(e.direct_runs_per_month, Some(FREE_DIRECT_RUNS_PER_MONTH));

        // Under the cap → allowed; remaining counts down.
        assert!(e.check_direct_run_quota(0).is_ok());
        assert!(e.check_direct_run_quota(FREE_DIRECT_RUNS_PER_MONTH - 1).is_ok());
        assert_eq!(e.direct_runs_remaining(10), Some(FREE_DIRECT_RUNS_PER_MONTH - 10));

        // At/over the cap → denied with the upgrade feature + numbers.
        let denied = e
            .check_direct_run_quota(FREE_DIRECT_RUNS_PER_MONTH)
            .unwrap_err();
        assert_eq!(denied.feature, feature::DIRECT_UNLIMITED);
        assert_eq!(denied.used, FREE_DIRECT_RUNS_PER_MONTH);
        assert_eq!(denied.limit, FREE_DIRECT_RUNS_PER_MONTH);
        assert!(e.check_direct_run_quota(FREE_DIRECT_RUNS_PER_MONTH + 5).is_err());

        // remaining saturates at 0 (never underflows).
        assert_eq!(e.direct_runs_remaining(FREE_DIRECT_RUNS_PER_MONTH + 5), Some(0));
    }

    #[test]
    fn entitlement_serializes_camelcase_for_the_frontend() {
        let json = serde_json::to_value(Entitlement::free_restricted()).unwrap();
        assert_eq!(json["plan"], "free");
        assert_eq!(json["directRunsPerMonth"], 25);
        assert!(json["features"].is_array());
    }
}
