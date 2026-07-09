//! Entitlement — the single source of truth for "what is this install allowed
//! to do".
//!
//! **Enforcement is live (P2c):** [`Entitlement::current`] derives the plan from
//! the signed-in user's Clerk `public_metadata.plan` (set by the billing webhook
//! after a Dodo subscription). **Pro** is uncapped; **Free / signed-out** gets
//! the restricted tier — the monthly Direct-run cap, enforced by
//! [`Entitlement::check_direct_run_quota`] in `commands::start_run`.
//!
//! See `docs/premium/accounts-and-subscriptions-implementation-plan.md`.

use serde::Serialize;

/// Feature keys gated by tier. Pro holds all of them; the restricted Free tier
/// holds none.
pub mod feature {
    /// Run Direct pipelines without the monthly free cap.
    pub const DIRECT_UNLIMITED: &str = "direct.unlimited";
    /// Run pipelines in parallel / in the background across workspaces.
    pub const RUNS_PARALLEL: &str = "runs.parallel";
    /// Unlimited run history + cross-machine sync.
    pub const HISTORY_SYNC: &str = "history.sync";
}

/// The Free monthly Direct-run cap (live). Shared by the meter, the restricted
/// entitlement, and the gate.
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
    /// The current entitlement, derived from the signed-in user's plan
    /// (`public_metadata.plan` via Clerk). A "pro" plan gets [`Entitlement::pro`]
    /// (uncapped); **everyone else (Free / signed-out / unknown) gets
    /// [`Entitlement::free_restricted`]** — the monthly Direct-run cap is live.
    pub fn current() -> Self {
        Self::for_plan(crate::auth::current_plan().as_deref())
    }

    /// Map a plan claim to an entitlement. Pure (the keyring read lives in
    /// [`Entitlement::current`]) so it's unit-testable without a session.
    pub fn for_plan(plan: Option<&str>) -> Self {
        // Trim + case-insensitive so a paying Pro user is never capped by stray
        // casing/whitespace in the plan claim.
        match plan.map(str::trim) {
            Some(p) if p.eq_ignore_ascii_case("pro") => Self::pro(),
            // Free, signed-out, and any unknown plan → the restricted Free tier
            // (premium features off, monthly Direct-run cap on).
            _ => Self::free_restricted(),
        }
    }

    /// Pro: every premium feature, no caps.
    pub fn pro() -> Self {
        Entitlement {
            plan: Plan::Pro,
            features: vec![
                feature::DIRECT_UNLIMITED.into(),
                feature::RUNS_PARALLEL.into(),
                feature::HISTORY_SYNC.into(),
            ],
            direct_runs_per_month: None,
        }
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

    /// The restricted Free tier (live for every non-Pro user): no premium
    /// features, and the monthly Direct-run cap turned on.
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
    /// Pro (has `DIRECT_UNLIMITED`, cap `None`) is always `Ok`; Free is denied
    /// once `used` reaches the cap.
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
/// the current plan is uncapped (Pro).
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
    fn free_plan_is_capped_with_no_premium_features() {
        // No plan claim (signed out / Free) → the restricted Free tier.
        let e = Entitlement::for_plan(None);
        assert_eq!(e.plan, Plan::Free);
        assert!(!e.has_feature(feature::DIRECT_UNLIMITED));
        assert!(!e.has_feature(feature::RUNS_PARALLEL));
        assert!(!e.has_feature(feature::HISTORY_SYNC));
        assert_eq!(e.direct_runs_per_month, Some(FREE_DIRECT_RUNS_PER_MONTH));
        // The monthly cap is enforced.
        assert!(e.check_direct_run_quota(FREE_DIRECT_RUNS_PER_MONTH).is_err());
        // An unknown plan string also maps to the restricted Free tier.
        let unknown = Entitlement::for_plan(Some("mystery"));
        assert_eq!(unknown.plan, Plan::Free);
        assert_eq!(unknown.direct_runs_per_month, Some(FREE_DIRECT_RUNS_PER_MONTH));
    }

    #[test]
    fn pro_match_tolerates_casing_and_whitespace() {
        // A paying Pro user must never be capped by a stray-cased plan claim.
        assert_eq!(Entitlement::for_plan(Some(" PRO ")).plan, Plan::Pro);
        assert_eq!(Entitlement::for_plan(Some("Pro")).plan, Plan::Pro);
    }

    #[test]
    fn pro_plan_is_uncapped_with_all_features() {
        let e = Entitlement::for_plan(Some("pro"));
        assert_eq!(e.plan, Plan::Pro);
        assert!(e.has_feature(feature::DIRECT_UNLIMITED));
        assert!(e.has_feature(feature::RUNS_PARALLEL));
        assert!(e.has_feature(feature::HISTORY_SYNC));
        assert_eq!(e.direct_runs_per_month, None);
        assert!(e.check_direct_run_quota(10_000).is_ok());
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
