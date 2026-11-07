//! Signed entitlement tokens (#582).
//!
//! **The problem.** [`crate::entitlement::Entitlement::current`] used to trust
//! `auth::StoredSession.plan`, a plain string inside the keychain item
//! `octopush` / `clerk-oauth-session` with no integrity check. Rewriting that
//! item with `"plan":"pro"` unlocked the client-side Pro gates. (Sync was never
//! affected: the server re-checks the plan.)
//!
//! **The fix.** `octopush-api`'s `POST /api/entitlement` signs the caller's plan
//! with Ed25519, and this module verifies the signature against
//! [`ENTITLEMENT_PUBLIC_KEY`], compiled into the binary. Local state can carry a
//! claim the server signed; it can no longer invent one. A patched, rebuilt
//! client still bypasses this, and nothing short of attestation would stop that.
//!
//! **Token format** (mirrors `octopush-api/api/_lib/entitlement.ts`). Not a JWT:
//! there is no algorithm field, so there is no "alg: none" class of bug.
//! ```text
//! claims = {"v":1,"sub":"<clerk user id>","plan":"free"|"pro","iat":<unix s>,"exp":<unix s>}
//! token  = "v1." + b64url(claims json) + "." + b64url(ed25519 signature)
//! signed bytes = ASCII "v1." + b64url(claims json)        (b64url: no padding)
//! ```
//!
//! **Offline.** The server issues a [`LEASE_DAYS`]-day lease. Refreshes happen
//! on launch, after sign-in and after checkout ([`refresh`]); any failed refresh
//! keeps the cached token, so only that many days with no successful refresh
//! end the lease.

use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use std::sync::Mutex;

use crate::error::{AppError, AppResult};

/// Lease length the server issues (`LEASE_DAYS` in `api/_lib/entitlement.ts`).
/// Informational: the signed `exp` claim is what is enforced.
pub const LEASE_DAYS: i64 = 30;

/// The only token/claims version this build understands.
pub const TOKEN_VERSION: u32 = 1;

/// **THE PUBLIC KEY GOES HERE.** Base64 (standard alphabet) of the raw 32-byte
/// Ed25519 public key matching the server's `ENTITLEMENT_SIGNING_KEY`, exactly
/// as printed by `node scripts/entitlement-keygen.mjs <file>` in octopush-api
/// (see that repo's README, "Signed entitlement tokens").
///
/// Empty = not provisioned: [`compiled_key`] is `None`, no token is fetched or
/// read, and `Entitlement::current` keeps using the legacy session plan, so a
/// build with this empty behaves exactly as before #582. Once a key is set, only
/// a valid signed token grants Pro. Ship that change as a beta first.
pub const ENTITLEMENT_PUBLIC_KEY: &str = "";

/// Claims as signed by the server. Parsed only after the signature verifies.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EntitlementClaims {
    pub v: u32,
    /// Clerk user id the token was issued to.
    pub sub: String,
    /// `"free"` or `"pro"`.
    pub plan: String,
    /// Issued-at / expiry, seconds since the epoch.
    pub iat: i64,
    pub exp: i64,
}

/// Why a token was not accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenRejection {
    /// Not `v1.<claims>.<sig>`, or undecodable.
    Malformed,
    /// The signature does not verify: forged, tampered, or another key.
    BadSignature,
    /// Signed, but a claims version this build does not understand.
    WrongVersion,
    /// Issued to a different Clerk user than the one signed in.
    WrongSubject,
    /// Past its `exp`.
    Expired,
}

/// Parse a base64 raw 32-byte Ed25519 public key. `None` when empty or invalid.
pub fn parse_public_key(b64: &str) -> Option<VerifyingKey> {
    let b64 = b64.trim();
    if b64.is_empty() {
        return None;
    }
    let raw = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let bytes: [u8; 32] = raw.try_into().ok()?;
    VerifyingKey::from_bytes(&bytes).ok()
}

/// The compiled-in key, or `None` while [`ENTITLEMENT_PUBLIC_KEY`] is empty.
pub fn compiled_key() -> Option<VerifyingKey> {
    parse_public_key(ENTITLEMENT_PUBLIC_KEY)
}

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).ok()
}

/// Verify `token` against `key` for the signed-in user `expected_sub` at `now`.
///
/// The key and the clock are parameters so tests exercise this exact function.
/// Order: shape → signature over `"v1.<claims>"` → parse claims → `v` → `sub` →
/// `exp`. The claims bytes are never interpreted before the signature checks out.
pub fn verify_token(
    token: &str,
    key: &VerifyingKey,
    expected_sub: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<EntitlementClaims, TokenRejection> {
    let mut parts = token.trim().split('.');
    let (prefix, claims_b64, sig_b64) = match (parts.next(), parts.next(), parts.next(), parts.next())
    {
        (Some(p), Some(c), Some(s), None) => (p, c, s),
        _ => return Err(TokenRejection::Malformed),
    };
    if prefix != "v1" {
        return Err(TokenRejection::Malformed);
    }
    let sig_bytes: [u8; 64] = b64url_decode(sig_b64)
        .ok_or(TokenRejection::Malformed)?
        .try_into()
        .map_err(|_| TokenRejection::Malformed)?;
    let signed = format!("{prefix}.{claims_b64}");
    key.verify(signed.as_bytes(), &Signature::from_bytes(&sig_bytes))
        .map_err(|_| TokenRejection::BadSignature)?;

    // Only now are the claims trusted enough to parse.
    let claims: EntitlementClaims =
        serde_json::from_slice(&b64url_decode(claims_b64).ok_or(TokenRejection::Malformed)?)
            .map_err(|_| TokenRejection::Malformed)?;
    if claims.v != TOKEN_VERSION {
        return Err(TokenRejection::WrongVersion);
    }
    if claims.sub != expected_sub {
        return Err(TokenRejection::WrongSubject);
    }
    if now.timestamp() >= claims.exp {
        return Err(TokenRejection::Expired);
    }
    Ok(claims)
}

// ─── Storage: the keychain, beside the session ─────────────────────────────

const KEYRING_ACCOUNT: &str = "entitlement-token";

/// Read at most once per launch, like the session (an unverified build prompts
/// on every keychain read). `None` = not loaded yet.
static TOKEN_CACHE: Mutex<Option<Option<String>>> = Mutex::new(None);

pub fn store_token(token: &str) -> AppResult<()> {
    crate::auth::keychain_entry(KEYRING_ACCOUNT)?
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
    let loaded = crate::auth::keychain_entry(KEYRING_ACCOUNT)
        .ok()
        .and_then(|e| e.get_password().ok());
    *cache = Some(loaded.clone());
    loaded
}

/// Drop the stored token (sign-out). The in-memory copy is cleared even when
/// the keychain delete fails, so this launch honours the sign-out regardless.
pub fn clear_token() -> AppResult<()> {
    let result = match crate::auth::keychain_entry(KEYRING_ACCOUNT)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Other(format!("could not clear the entitlement token: {e}"))),
    };
    *TOKEN_CACHE.lock().unwrap() = Some(None);
    result
}

// ─── Refresh ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct IssuedToken {
    token: String,
}

/// Fetch a fresh token from `POST /api/entitlement` and store it.
///
/// No-op (no request at all) while no key is compiled in, or when signed out.
/// Best-effort: every failure (offline, 401, 503 `not_provisioned`, a token
/// that does not verify) logs and keeps the cached token, so a failed refresh
/// never downgrades anyone before the cached token's own `exp`. Returns the
/// verified plan on success.
pub async fn refresh() -> Option<String> {
    let key = compiled_key()?;
    let (sub, _) = crate::auth::current_identity()?;
    let access = crate::auth::current_access_token().await?;
    let client = match crate::tls::client_builder().build() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("entitlement refresh: http client init failed: {e}");
            return None;
        }
    };
    let url = format!("{}/api/entitlement", crate::sync::SYNC_API_BASE);
    let resp = match client.post(&url).bearer_auth(access).send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::debug!(
                error = %crate::tls::describe_request_error(&e),
                "entitlement refresh failed; keeping the cached token"
            );
            return None;
        }
    };
    if !resp.status().is_success() {
        tracing::debug!(status = %resp.status(), "entitlement refresh refused; keeping the cached token");
        return None;
    }
    let issued: IssuedToken = match resp.json().await {
        Ok(v) => v,
        Err(_) => {
            tracing::warn!("entitlement refresh: unreadable response; keeping the cached token");
            return None;
        }
    };
    // Never let a bad response overwrite a good cached token.
    let claims = match verify_token(&issued.token, &key, &sub, chrono::Utc::now()) {
        Ok(c) => c,
        Err(why) => {
            tracing::warn!(?why, "entitlement refresh: server token did not verify; keeping the cached token");
            return None;
        }
    };
    if let Err(e) = store_token(&issued.token) {
        tracing::warn!("could not store the entitlement token: {e}");
        return None;
    }
    Some(claims.plan)
}

/// [`refresh`] in the background, for launch and sign-in: never blocks them.
pub fn spawn_refresh() {
    if compiled_key().is_none() {
        return;
    }
    tauri::async_runtime::spawn(async {
        let _ = refresh().await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
    use chrono::TimeZone;
    use ed25519_dalek::{Signer, SigningKey};

    /// Throwaway TEST key (seed = 32 × 0x07). No production meaning.
    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }
    /// The same test key's public half, base64 raw 32 bytes, as printed by
    /// `entitlement-keygen.mjs`.
    const TEST_PUBLIC_KEY: &str = "6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=";

    /// Minted by the REAL TypeScript issuer (`issueToken` in
    /// `octopush-api/api/_lib/entitlement.ts`) with the test seed above at
    /// 2026-11-07T00:00:00Z: a cross-language interop fixture.
    const TS_PRO: &str = "v1.eyJ2IjoxLCJzdWIiOiJ1c2VyX2FiYyIsInBsYW4iOiJwcm8iLCJpYXQiOjE3OTQwMDk2MDAsImV4cCI6MTc5NjYwMTYwMH0.A5KrssE1nlQMD0jATRg5bu7BVt_LgQA_5XDDi_vGz03ETW-jIHAKKwxioyClTXGW7haWg2qQhdHUjIA2DCrTBA";
    const TS_FREE: &str = "v1.eyJ2IjoxLCJzdWIiOiJ1c2VyX2FiYyIsInBsYW4iOiJmcmVlIiwiaWF0IjoxNzk0MDA5NjAwLCJleHAiOjE3OTY2MDE2MDB9.FHoH_SaxtsvJ9SJ-bxRTuV7gnzf7Npg2Pli1Lphb1nUpFFoKuzAW06IsGuInMUjGh3Xle-g2dWkfJtdih1SPAA";

    /// Fixed clock: 2026-11-08T00:00:00Z, one day into the fixtures' lease.
    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::Utc.with_ymd_and_hms(2026, 11, 8, 0, 0, 0).unwrap()
    }

    fn key() -> VerifyingKey {
        parse_public_key(TEST_PUBLIC_KEY).expect("test key parses")
    }

    /// Sign arbitrary claims JSON the way the server does.
    fn mint_raw(claims: &serde_json::Value, sk: &SigningKey) -> String {
        let payload = format!("v1.{}", URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap()));
        let sig = sk.sign(payload.as_bytes());
        format!("{payload}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
    }

    fn mint(plan: &str, exp: i64) -> String {
        mint_raw(
            &serde_json::json!({"v": 1, "sub": "user_abc", "plan": plan, "iat": exp - 30 * 86_400, "exp": exp}),
            &signing_key(),
        )
    }

    #[test]
    fn test_key_constant_matches_the_seed() {
        assert_eq!(STANDARD.encode(signing_key().verifying_key().to_bytes()), TEST_PUBLIC_KEY);
    }

    #[test]
    fn accepts_a_valid_pro_token() {
        let c = verify_token(TS_PRO, &key(), "user_abc", now()).expect("pro verifies");
        assert_eq!((c.v, c.sub.as_str(), c.plan.as_str()), (1, "user_abc", "pro"));
        assert_eq!(c.exp - c.iat, LEASE_DAYS * 86_400);
    }

    #[test]
    fn accepts_a_valid_free_token() {
        let c = verify_token(TS_FREE, &key(), "user_abc", now()).expect("free verifies");
        assert_eq!(c.plan, "free");
    }

    #[test]
    fn rejects_an_expired_token() {
        let exp = now().timestamp();
        assert_eq!(verify_token(&mint("pro", exp), &key(), "user_abc", now()), Err(TokenRejection::Expired));
        // One second earlier it was still valid.
        assert!(verify_token(&mint("pro", exp + 1), &key(), "user_abc", now()).is_ok());
        // The TS fixture itself expires at the end of its 30-day lease.
        let later = chrono::Utc.with_ymd_and_hms(2026, 12, 7, 0, 0, 0).unwrap();
        assert_eq!(verify_token(TS_PRO, &key(), "user_abc", later), Err(TokenRejection::Expired));
    }

    #[test]
    fn rejects_a_wrong_signature() {
        // Signed by another key.
        let other = SigningKey::from_bytes(&[9u8; 32]);
        let foreign = mint_raw(
            &serde_json::json!({"v": 1, "sub": "user_abc", "plan": "pro", "iat": 0, "exp": i64::MAX}),
            &other,
        );
        assert_eq!(verify_token(&foreign, &key(), "user_abc", now()), Err(TokenRejection::BadSignature));
        // Garbage signature bytes of the right length.
        let claims = TS_PRO.split('.').nth(1).unwrap();
        let bogus = format!("v1.{claims}.{}", URL_SAFE_NO_PAD.encode([0u8; 64]));
        assert_eq!(verify_token(&bogus, &key(), "user_abc", now()), Err(TokenRejection::BadSignature));
    }

    #[test]
    fn rejects_tampered_claims() {
        // Keep Free's signature, rewrite its claims to Pro.
        let parts: Vec<&str> = TS_FREE.split('.').collect();
        let mut claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        claims["plan"] = serde_json::json!("pro");
        let forged = format!("v1.{}.{}", URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap()), parts[2]);
        assert_eq!(verify_token(&forged, &key(), "user_abc", now()), Err(TokenRejection::BadSignature));
    }

    #[test]
    fn rejects_a_wrong_version() {
        // A correctly signed token whose claims say v2.
        let v2 = mint_raw(
            &serde_json::json!({"v": 2, "sub": "user_abc", "plan": "pro", "iat": 0, "exp": i64::MAX}),
            &signing_key(),
        );
        assert_eq!(verify_token(&v2, &key(), "user_abc", now()), Err(TokenRejection::WrongVersion));
        // A "v2." prefix is not this format at all.
        let relabelled = TS_PRO.replacen("v1.", "v2.", 1);
        assert_eq!(verify_token(&relabelled, &key(), "user_abc", now()), Err(TokenRejection::Malformed));
    }

    #[test]
    fn rejects_a_token_for_another_user() {
        assert_eq!(verify_token(TS_PRO, &key(), "user_other", now()), Err(TokenRejection::WrongSubject));
    }

    #[test]
    fn rejects_garbage() {
        let signed_non_json = {
            let payload = format!("v1.{}", URL_SAFE_NO_PAD.encode(b"not json"));
            let sig = signing_key().sign(payload.as_bytes());
            format!("{payload}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
        };
        for bad in [
            "",
            "garbage",
            "v1",
            "v1.only-two",
            "a.b.c.d",
            "v1.!!!.!!!",
            "v1.e30.c2hvcnQ", // signature too short
            signed_non_json.as_str(),
        ] {
            let got = verify_token(bad, &key(), "user_abc", now());
            assert_eq!(got, Err(TokenRejection::Malformed), "for {bad:?}");
        }
    }

    #[test]
    fn public_key_parsing() {
        assert!(parse_public_key("").is_none());
        assert!(parse_public_key("   ").is_none());
        assert!(parse_public_key("not base64!").is_none());
        assert!(parse_public_key(&STANDARD.encode([1u8; 31])).is_none(), "wrong length");
        assert!(parse_public_key(TEST_PUBLIC_KEY).is_some());
    }

    // ── Entitlement::resolve, driving the real verify_token ────────────────

    use crate::entitlement::{Entitlement, Plan};

    fn resolve(
        key: Option<&VerifyingKey>,
        legacy: Option<&str>,
        sub: Option<&str>,
        token: Option<&str>,
    ) -> Entitlement {
        Entitlement::resolve(
            key,
            || legacy.map(str::to_string),
            || sub.map(str::to_string),
            || token.map(str::to_string),
            now(),
        )
    }

    #[test]
    fn without_a_compiled_key_the_legacy_session_plan_is_used() {
        // Behaviour on main until the owner compiles a key in.
        assert_eq!(resolve(None, Some("pro"), Some("user_abc"), None).plan, Plan::Pro);
        assert_eq!(resolve(None, Some("free"), Some("user_abc"), Some(TS_PRO)).plan, Plan::Free);
        assert_eq!(resolve(None, None, None, None).plan, Plan::Free);
        // The token is not even read while unprovisioned.
        let e = Entitlement::resolve(
            None,
            || Some("pro".into()),
            || Some("user_abc".into()),
            || panic!("token must not be read without a key"),
            now(),
        );
        assert_eq!(e.plan, Plan::Pro);
    }

    #[test]
    fn with_a_key_only_a_valid_token_grants_pro() {
        let k = key();
        let pro = resolve(Some(&k), Some("free"), Some("user_abc"), Some(TS_PRO));
        assert_eq!(pro.plan, Plan::Pro);
        assert!(pro.has_feature(crate::entitlement::feature::DIRECT_UNLIMITED));
        assert_eq!(pro.direct_runs_per_month, None);

        let free = resolve(Some(&k), Some("pro"), Some("user_abc"), Some(TS_FREE));
        assert_eq!(free.plan, Plan::Free, "a signed free beats a forged legacy pro");
        assert_eq!(free.direct_runs_per_month, Some(crate::entitlement::FREE_DIRECT_RUNS_PER_MONTH));
    }

    #[test]
    fn with_a_key_anything_but_a_valid_token_is_free() {
        let k = key();
        let expired = mint("pro", now().timestamp() - 1);
        let tampered = {
            let parts: Vec<&str> = TS_FREE.split('.').collect();
            let forged = URL_SAFE_NO_PAD.encode(
                br#"{"v":1,"sub":"user_abc","plan":"pro","iat":0,"exp":9999999999}"#,
            );
            format!("v1.{forged}.{}", parts[2])
        };
        // The keychain plan says "pro" in every case: the issue's bypass.
        for (why, sub, token) in [
            ("no token", Some("user_abc"), None),
            ("signed out", None, Some(TS_PRO)),
            ("another user's token", Some("user_other"), Some(TS_PRO)),
            ("expired", Some("user_abc"), Some(expired.as_str())),
            ("tampered", Some("user_abc"), Some(tampered.as_str())),
            ("garbage", Some("user_abc"), Some("garbage")),
        ] {
            let e = resolve(Some(&k), Some("pro"), sub, token);
            assert_eq!(e.plan, Plan::Free, "{why}");
            assert!(!e.has_feature(crate::entitlement::feature::RUNS_PARALLEL), "{why}");
        }
        // Signed by a different key than the compiled one.
        let other = SigningKey::from_bytes(&[9u8; 32]).verifying_key();
        assert_eq!(resolve(Some(&other), Some("pro"), Some("user_abc"), Some(TS_PRO)).plan, Plan::Free);
    }

    // ── Storage ─────────────────────────────────────────────────────────────

    #[test]
    #[serial_test::serial(keychain)]
    fn sign_out_clears_the_token() {
        // The mock store: never touch the real keychain from a test.
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        store_token(TS_PRO).expect("store");
        assert_eq!(load_token().as_deref(), Some(TS_PRO));
        crate::auth::sign_out().expect("sign out");
        assert_eq!(load_token(), None, "sign-out must drop the token");
    }

    #[test]
    fn an_empty_compiled_key_means_not_provisioned() {
        // Holds while the owner has not compiled a key in. Once they have, the
        // key must parse, or every user would silently fall to Free.
        if ENTITLEMENT_PUBLIC_KEY.trim().is_empty() {
            assert!(compiled_key().is_none());
        } else {
            assert!(compiled_key().is_some(), "ENTITLEMENT_PUBLIC_KEY is set but does not parse");
        }
    }
}
