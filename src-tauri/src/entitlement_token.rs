//! Signed entitlement tokens — the license-key layer.
//!
//! **The problem this solves.** Until now the app decided "am I Pro?" by reading
//! a plain string it had cached in the OS keychain (`auth::StoredSession.plan`,
//! written from a Clerk `/oauth/userinfo` response). Anyone who could write that
//! keychain entry granted themselves Pro — no recompile, no patching. That was a
//! cheaper bypass than editing the (source-available) client itself.
//!
//! **The fix.** The server now issues an **Ed25519-signed** statement of what an
//! install is entitled to, which this module verifies against a public key
//! compiled into the binary. Local state can no longer *claim* Pro; it can only
//! *carry* a claim the server signed.
//!
//! This does not stop someone from patching and rebuilding the client — nothing
//! short of remote attestation would, and the source is public by design. It
//! removes the easy bypass, and the Elastic License 2.0 makes the hard one an
//! explicit violation ("you may not move, change, disable, or circumvent the
//! license key functionality").
//!
//! **Offline is deliberately not broken:**
//! - **Free** never needs a token. Fully offline, forever.
//! - **Pro** carries a [`LEASE_DAYS`]-day lease, refreshed silently whenever the
//!   app is online. Losing Pro requires that many *consecutive* days with no
//!   successful refresh, and one reconnection restores it.
//!
//! Token format (mirrors `api/_lib/entitlement.ts`):
//! ```text
//! v1.<b64url(claims json)>.<b64url(ed25519 signature)>
//! signature covers the ASCII bytes "v1.<b64url(claims json)>"
//! ```
//! Deliberately not a JWT: no algorithm field, so there is no "alg: none" class
//! of bug. The version prefix is inside the signed bytes, so a v1 token can
//! never be reinterpreted under a future format.

use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

use crate::error::{AppError, AppResult};

/// Lease length, in days. Must match `LEASE_DAYS` in `api/_lib/entitlement.ts`.
/// Informational here — the authoritative expiry is the signed `exp` claim.
pub const LEASE_DAYS: i64 = 30;

/// The Ed25519 public key matching the server's `ENTITLEMENT_SIGNING_KEY`, as
/// base64 of the **raw 32 bytes**:
///
/// ```sh
/// openssl pkey -in ent-priv.pem -pubout -outform DER | tail -c 32 | base64
/// ```
///
/// Empty = not yet provisioned. While empty, [`verified`] returns `None` and the
/// app falls back to the legacy keychain plan, so builds cut before the key is
/// deployed keep working exactly as they did. Fill it in and the license-key
/// layer switches on. See `octopush-api/README.md` for generation + rotation.
pub const ENTITLEMENT_PUBLIC_KEY: &str = "";

/// This machine's id, published once at startup so the (synchronous, state-less)
/// entitlement path can check the `mid` binding without a DB handle.
static MACHINE_ID: OnceLock<String> = OnceLock::new();

/// Record this machine's id. Called once during app setup. Idempotent; the
/// headless run-worker never calls it (it has no DB handle and must not touch
/// the keychain), which is fine — see [`verify_token`] for how an unknown
/// machine id is handled.
pub fn set_machine_id(id: String) {
    let _ = MACHINE_ID.set(id);
}

fn machine_id() -> Option<&'static str> {
    MACHINE_ID.get().map(String::as_str)
}

/// Claims as signed by the server. Field names match the TypeScript issuer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntitlementClaims {
    /// Clerk user id the token was minted for.
    pub sub: String,
    /// `"free"` or `"pro"`.
    pub plan: String,
    pub features: Vec<String>,
    /// Monthly Direct-run cap; `None`/null = unlimited.
    #[serde(rename = "directRunsPerMonth")]
    pub direct_runs_per_month: Option<u32>,
    /// Machine id the token was minted for.
    pub mid: String,
    /// Issued-at / expiry, seconds since epoch.
    pub iat: i64,
    pub exp: i64,
}

/// Why a token was not usable. Kept granular so the UI can say something true
/// ("reconnect to restore Pro") instead of a generic failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenRejection {
    /// No public key compiled in — the layer is not provisioned yet.
    NotProvisioned,
    Malformed,
    /// Signature did not verify: forged, corrupted, or signed by another key.
    BadSignature,
    /// Past its `exp`. For a Pro user this is the "offline too long" case.
    Expired,
    /// Minted for a different Clerk user.
    WrongSubject,
    /// Minted for a different machine — i.e. a shared token.
    WrongMachine,
}

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).ok()
}

fn verifying_key() -> Option<VerifyingKey> {
    if ENTITLEMENT_PUBLIC_KEY.is_empty() {
        return None;
    }
    let raw = base64::engine::general_purpose::STANDARD
        .decode(ENTITLEMENT_PUBLIC_KEY.trim())
        .ok()?;
    let bytes: [u8; 32] = raw.try_into().ok()?;
    VerifyingKey::from_bytes(&bytes).ok()
}

/// Verify a token's signature and bindings.
///
/// `expected_sub` is the currently signed-in Clerk user. The `mid` binding is
/// only enforced when this process knows its machine id — the run-worker sidecar
/// does not, and refusing there would break detached runs for legitimate Pro
/// users. Signature, subject and expiry are always enforced.
pub fn verify_token(
    token: &str,
    expected_sub: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<EntitlementClaims, TokenRejection> {
    let key = verifying_key().ok_or(TokenRejection::NotProvisioned)?;

    let mut parts = token.split('.');
    let (version, claims_b64, sig_b64) = match (parts.next(), parts.next(), parts.next(), parts.next())
    {
        (Some(v), Some(c), Some(s), None) => (v, c, s),
        _ => return Err(TokenRejection::Malformed),
    };
    if version != "v1" {
        return Err(TokenRejection::Malformed);
    }

    // The signature covers "v1.<claims>" — the version prefix included, so a
    // token can't be lifted into a different format.
    let signed = format!("{version}.{claims_b64}");
    let sig_bytes: [u8; 64] = b64url_decode(sig_b64)
        .ok_or(TokenRejection::Malformed)?
        .try_into()
        .map_err(|_| TokenRejection::Malformed)?;
    key.verify(signed.as_bytes(), &Signature::from_bytes(&sig_bytes))
        .map_err(|_| TokenRejection::BadSignature)?;

    // Only parse the claims AFTER the signature checks out.
    let claims: EntitlementClaims = serde_json::from_slice(
        &b64url_decode(claims_b64).ok_or(TokenRejection::Malformed)?,
    )
    .map_err(|_| TokenRejection::Malformed)?;

    if claims.sub != expected_sub {
        return Err(TokenRejection::WrongSubject);
    }
    if now.timestamp() >= claims.exp {
        return Err(TokenRejection::Expired);
    }
    if let Some(mid) = machine_id() {
        if claims.mid != mid {
            return Err(TokenRejection::WrongMachine);
        }
    }
    Ok(claims)
}

// ─── Storage (keychain, beside the session) ────────────────────────────────

const KEYRING_SERVICE: &str = "octopush";
const KEYRING_ACCOUNT: &str = "entitlement-token";

fn keyring_entry() -> AppResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| AppError::Other(format!("keychain unavailable: {e}")))
}

/// Cached like the session is: an unverified build prompts on every keychain
/// read, so read once per process.
static TOKEN_CACHE: std::sync::Mutex<Option<Option<String>>> = std::sync::Mutex::new(None);

pub fn store_token(token: &str) -> AppResult<()> {
    keyring_entry()?
        .set_password(token)
        .map_err(|e| AppError::Other(format!("could not save the entitlement token: {e}")))?;
    *TOKEN_CACHE.lock().unwrap() = Some(Some(token.to_string()));
    Ok(())
}

pub fn load_token() -> Option<String> {
    let mut cache = TOKEN_CACHE.lock().unwrap();
    if let Some(cached) = &*cache {
        return cached.clone();
    }
    let loaded = keyring_entry().ok().and_then(|e| e.get_password().ok());
    *cache = Some(loaded.clone());
    loaded
}

/// Drop the stored token. Called on sign-out so the next user on a shared
/// machine doesn't inherit the previous one's entitlement.
pub fn clear_token() -> AppResult<()> {
    let result = match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Other(format!(
            "could not clear the entitlement token: {e}"
        ))),
    };
    *TOKEN_CACHE.lock().unwrap() = Some(None);
    result
}

/// The verified claims for the current session, or `None` with the reason.
///
/// `None` means "no trustworthy Pro claim" and the caller falls back to Free —
/// except for [`TokenRejection::NotProvisioned`], which means this build predates
/// key deployment and should use the legacy path.
pub fn verified(expected_sub: &str) -> Result<EntitlementClaims, TokenRejection> {
    let token = load_token().ok_or(TokenRejection::Malformed)?;
    verify_token(&token, expected_sub, chrono::Utc::now())
}

/// Is the license-key layer switched on in this build?
pub fn provisioned() -> bool {
    verifying_key().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Fixtures ───────────────────────────────────────────────────────────
    //
    // These tokens were minted by the REAL TypeScript issuer
    // (`octopush-api/api/_lib/entitlement.ts`) with the throwaway keypair below,
    // so this suite is a genuine cross-language interop test: it proves Rust
    // verifies exactly what Node signs, and that the claim shapes agree.
    //
    // The key is a TEST key with no production meaning. To regenerate:
    //   openssl genpkey -algorithm ed25519 -out t.pem
    //   openssl pkey -in t.pem -pubout -outform DER | tail -c 32 | base64
    // then mint tokens with `issueToken` and paste them here.
    const TEST_PUBLIC_KEY: &str = "GSN9DknBM1CXFiLCfX8RSpyg2hyUwwq8bjbXtkkT6FY=";
    const PRO: &str = "v1.eyJzdWIiOiJ1c2VyX2FiYyIsInBsYW4iOiJwcm8iLCJmZWF0dXJlcyI6WyJkaXJlY3QudW5saW1pdGVkIiwicnVucy5wYXJhbGxlbCIsImhpc3Rvcnkuc3luYyIsImxpYnJhcnkuc3luYyIsInJ1bnMuZGV0YWNoZWQiLCJyb3V0aW5lcy5zY2hlZHVsZWQiLCJsb2dib29rLnJlcG9ydHMiXSwiZGlyZWN0UnVuc1Blck1vbnRoIjpudWxsLCJtaWQiOiJtYWNoaW5lLTEiLCJpYXQiOjE3ODc1Mjk3MDMsImV4cCI6MTc5MDEyMTcwM30.wfwJyB_JbqC6LSF1K0Q8deB5SjESotv7ugYemoJO0CFEdm4J3yvTIHVlF1yQ1cZHCft54Wb1t1ZyNzTfEoFGCw";
    const FREE: &str = "v1.eyJzdWIiOiJ1c2VyX2FiYyIsInBsYW4iOiJmcmVlIiwiZmVhdHVyZXMiOltdLCJkaXJlY3RSdW5zUGVyTW9udGgiOjI1LCJtaWQiOiJtYWNoaW5lLTEiLCJpYXQiOjE3ODc1Mjk3MDMsImV4cCI6MTc5MDEyMTcwM30.Uqn9Ibmnm3gN6bXh5TS0M1vRkcvKKUUAHjkoX_tTKpOn9VJdx7ssQVx021XRBX2Xn9berDsGMfFaq_7jrr0KAw";
    const EXPIRED: &str = "v1.eyJzdWIiOiJ1c2VyX2FiYyIsInBsYW4iOiJwcm8iLCJmZWF0dXJlcyI6WyJkaXJlY3QudW5saW1pdGVkIiwicnVucy5wYXJhbGxlbCIsImhpc3Rvcnkuc3luYyIsImxpYnJhcnkuc3luYyIsInJ1bnMuZGV0YWNoZWQiLCJyb3V0aW5lcy5zY2hlZHVsZWQiLCJsb2dib29rLnJlcG9ydHMiXSwiZGlyZWN0UnVuc1Blck1vbnRoIjpudWxsLCJtaWQiOiJtYWNoaW5lLTEiLCJpYXQiOjE3ODQ4NTEzMDMsImV4cCI6MTc4NzQ0MzMwM30.qBfe06ho9TJOu4J6iqOzEkLdzFp420slCdDycYHiYQF4RfCwpadquPxRVIoe7AdKGRSXC7X74pnqNZOI6nmEAg";
    const OTHER_MACHINE: &str = "v1.eyJzdWIiOiJ1c2VyX2FiYyIsInBsYW4iOiJwcm8iLCJmZWF0dXJlcyI6WyJkaXJlY3QudW5saW1pdGVkIiwicnVucy5wYXJhbGxlbCIsImhpc3Rvcnkuc3luYyIsImxpYnJhcnkuc3luYyIsInJ1bnMuZGV0YWNoZWQiLCJyb3V0aW5lcy5zY2hlZHVsZWQiLCJsb2dib29rLnJlcG9ydHMiXSwiZGlyZWN0UnVuc1Blck1vbnRoIjpudWxsLCJtaWQiOiJtYWNoaW5lLTIiLCJpYXQiOjE3ODc1Mjk3MDMsImV4cCI6MTc5MDEyMTcwM30.gGHW2oVB9fNM1tRQJmSV4OMl_7Ov5fE4Oz09zrKkM4T8ZgmGks77ZfINXxdczdJCMA84RlEW80GyFp7cKDBrAQ";

    /// Verify against the TEST key rather than the compiled-in production one,
    /// so the suite runs identically before and after the real key is
    /// provisioned. Mirrors `verify_token`'s checks in the same order.
    fn verify_with_test_key(
        token: &str,
        expected_sub: &str,
        machine: Option<&str>,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<EntitlementClaims, TokenRejection> {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(TEST_PUBLIC_KEY)
            .map_err(|_| TokenRejection::NotProvisioned)?;
        let bytes: [u8; 32] = raw.try_into().map_err(|_| TokenRejection::NotProvisioned)?;
        let key = VerifyingKey::from_bytes(&bytes).map_err(|_| TokenRejection::NotProvisioned)?;

        let mut parts = token.split('.');
        let (version, claims_b64, sig_b64) =
            match (parts.next(), parts.next(), parts.next(), parts.next()) {
                (Some(v), Some(c), Some(s), None) => (v, c, s),
                _ => return Err(TokenRejection::Malformed),
            };
        if version != "v1" {
            return Err(TokenRejection::Malformed);
        }
        let signed = format!("{version}.{claims_b64}");
        let sig_bytes: [u8; 64] = b64url_decode(sig_b64)
            .ok_or(TokenRejection::Malformed)?
            .try_into()
            .map_err(|_| TokenRejection::Malformed)?;
        key.verify(signed.as_bytes(), &Signature::from_bytes(&sig_bytes))
            .map_err(|_| TokenRejection::BadSignature)?;
        let claims: EntitlementClaims =
            serde_json::from_slice(&b64url_decode(claims_b64).ok_or(TokenRejection::Malformed)?)
                .map_err(|_| TokenRejection::Malformed)?;
        if claims.sub != expected_sub {
            return Err(TokenRejection::WrongSubject);
        }
        if now.timestamp() >= claims.exp {
            return Err(TokenRejection::Expired);
        }
        if let Some(mid) = machine {
            if claims.mid != mid {
                return Err(TokenRejection::WrongMachine);
            }
        }
        Ok(claims)
    }

    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::Utc::now()
    }

    // ── Accepts what the server actually signs ─────────────────────────────

    #[test]
    fn verifies_a_pro_token_minted_by_the_typescript_issuer() {
        let c = verify_with_test_key(PRO, "user_abc", Some("machine-1"), now())
            .expect("pro token must verify");
        assert_eq!(c.plan, "pro");
        assert_eq!(c.direct_runs_per_month, None, "Pro is uncapped");
        assert!(c.features.contains(&feature_key_direct_unlimited()));
        assert_eq!(c.features.len(), 7, "all seven gates travel in the claims");
    }

    #[test]
    fn verifies_a_free_token_and_carries_the_cap() {
        let c = verify_with_test_key(FREE, "user_abc", Some("machine-1"), now())
            .expect("free token must verify");
        assert_eq!(c.plan, "free");
        assert_eq!(
            c.direct_runs_per_month,
            Some(crate::entitlement::FREE_DIRECT_RUNS_PER_MONTH),
            "the server's cap must match the desktop's constant"
        );
        assert!(c.features.is_empty());
    }

    /// The feature list is shared with `entitlement::feature`; assert against it
    /// rather than a literal so a rename can't drift the two apart silently.
    fn feature_key_direct_unlimited() -> String {
        crate::entitlement::feature::DIRECT_UNLIMITED.to_string()
    }

    // ── Rejects every forgery vector ───────────────────────────────────────

    #[test]
    fn rejects_an_expired_token() {
        // The offline-too-long case: past the lease, a Pro user drops to Free.
        assert_eq!(
            verify_with_test_key(EXPIRED, "user_abc", Some("machine-1"), now()),
            Err(TokenRejection::Expired)
        );
    }

    #[test]
    fn rejects_a_token_minted_for_another_user() {
        assert_eq!(
            verify_with_test_key(PRO, "user_someone_else", Some("machine-1"), now()),
            Err(TokenRejection::WrongSubject)
        );
    }

    #[test]
    fn rejects_a_token_shared_from_another_machine() {
        // Someone publishing their Pro token buys nobody else anything.
        assert_eq!(
            verify_with_test_key(OTHER_MACHINE, "user_abc", Some("machine-1"), now()),
            Err(TokenRejection::WrongMachine)
        );
    }

    #[test]
    fn rejects_a_tampered_claims_blob() {
        // The classic forgery: keep Free's signature, rewrite the claims to Pro.
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let parts: Vec<&str> = FREE.split('.').collect();
        let mut claims: serde_json::Value =
            serde_json::from_slice(&b64.decode(parts[1]).unwrap()).unwrap();
        claims["plan"] = serde_json::json!("pro");
        claims["features"] = serde_json::json!(["direct.unlimited", "runs.parallel"]);
        claims["directRunsPerMonth"] = serde_json::Value::Null;
        let forged = format!(
            "v1.{}.{}",
            b64.encode(serde_json::to_vec(&claims).unwrap()),
            parts[2]
        );
        assert_eq!(
            verify_with_test_key(&forged, "user_abc", Some("machine-1"), now()),
            Err(TokenRejection::BadSignature)
        );
    }

    #[test]
    fn rejects_a_token_signed_by_a_different_key() {
        // An attacker without the private key can only produce garbage bytes.
        let parts: Vec<&str> = PRO.split('.').collect();
        let bogus = format!("v1.{}.{}", parts[1], "A".repeat(86));
        assert_eq!(
            verify_with_test_key(&bogus, "user_abc", Some("machine-1"), now()),
            Err(TokenRejection::BadSignature)
        );
    }

    // ── Shape checks (independent of any key) ──────────────────────────────

    #[test]
    fn malformed_tokens_are_rejected_on_shape() {
        for bad in ["", "v1", "v1.only-two", "v2.a.b", "a.b.c.d"] {
            let got = verify_with_test_key(bad, "user_1", None, now());
            assert!(
                matches!(got, Err(TokenRejection::Malformed)),
                "expected Malformed for {bad:?}, got {got:?}"
            );
        }
    }

    #[test]
    fn an_unprovisioned_build_falls_back_instead_of_downgrading() {
        // While no production key is compiled in, the layer stays inert and
        // `Entitlement::current` keeps using the legacy path — so builds cut
        // before key deployment behave exactly as they did.
        if ENTITLEMENT_PUBLIC_KEY.is_empty() {
            assert!(!provisioned());
            assert_eq!(
                verify_token(PRO, "user_abc", now()),
                Err(TokenRejection::NotProvisioned)
            );
        }
    }
}
