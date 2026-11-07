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
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use std::sync::Mutex;

use crate::error::{AppError, AppResult};

/// Lease length the server issues (`LEASE_DAYS` in `api/_lib/entitlement.ts`).
/// Informational: the signed `exp` claim is what is enforced.
pub const LEASE_DAYS: i64 = 30;

/// The only token/claims version this build understands.
pub const TOKEN_VERSION: u32 = 1;

/// Tokens longer than this are refused before any decoding. A real token is
/// ~250 bytes.
pub const MAX_TOKEN_BYTES: usize = 4096;

/// How far in the future `iat` may be (clock skew allowance), in seconds.
pub const MAX_IAT_SKEW_SECS: i64 = 5 * 60;

/// Tauri event emitted when a refresh changed the effective plan, so the
/// frontend's `entitlementStore` reloads.
pub const ENTITLEMENT_CHANGED_EVENT: &str = "entitlement-changed";

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
    /// Not `v1.<claims>.<sig>`, undecodable, or over [`MAX_TOKEN_BYTES`].
    Malformed,
    /// The signature does not verify: forged, tampered, or another key.
    BadSignature,
    /// Signed, but a claims version this build does not understand.
    WrongVersion,
    /// Issued to a different Clerk user than the one signed in.
    WrongSubject,
    /// Past its `exp`.
    Expired,
    /// `iat` more than [`MAX_IAT_SKEW_SECS`] in the future.
    IssuedInFuture,
}

/// Parse a base64 raw 32-byte Ed25519 public key. `None` when empty, invalid,
/// or a weak (small-order) key such as the identity point, which would accept
/// forged signatures.
pub fn parse_public_key(b64: &str) -> Option<VerifyingKey> {
    let b64 = b64.trim();
    if b64.is_empty() {
        return None;
    }
    let raw = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let bytes: [u8; 32] = raw.try_into().ok()?;
    let key = VerifyingKey::from_bytes(&bytes).ok()?;
    if key.is_weak() {
        return None;
    }
    Some(key)
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
/// Order: size bound → shape → strict signature over `"v1.<claims>"` → parse
/// claims → `v` → `sub` → `exp` → `iat` not in the future. The claims bytes are
/// never interpreted before the signature checks out.
pub fn verify_token(
    token: &str,
    key: &VerifyingKey,
    expected_sub: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<EntitlementClaims, TokenRejection> {
    let token = token.trim();
    if token.len() > MAX_TOKEN_BYTES {
        return Err(TokenRejection::Malformed);
    }
    let mut parts = token.split('.');
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
    // `verify_strict` also refuses non-canonical signatures and weak keys.
    key.verify_strict(signed.as_bytes(), &Signature::from_bytes(&sig_bytes))
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
    if claims.iat > now.timestamp() + MAX_IAT_SKEW_SECS {
        return Err(TokenRejection::IssuedInFuture);
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
    if let Some(cached) = &*TOKEN_CACHE.lock().unwrap() {
        return cached.clone();
    }
    // Read the keychain WITHOUT holding the lock (it can block on an OS prompt).
    let loaded = crate::auth::keychain_entry(KEYRING_ACCOUNT)
        .ok()
        .and_then(|e| e.get_password().ok());
    let mut cache = TOKEN_CACHE.lock().unwrap();
    // A store/clear that landed while we were reading wins over our read.
    if let Some(cached) = &*cache {
        return cached.clone();
    }
    *cache = Some(loaded.clone());
    loaded
}

/// Drop the stored token. Called from `auth::clear_session`, so sign-out and a
/// revoked session both clear it. The in-memory copy is cleared even when the
/// keychain delete fails, so this launch honours it regardless.
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

/// The Tauri app handle, set once at startup so a background refresh can tell
/// the frontend the plan changed. Absent in tests and the headless worker.
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

pub fn set_app_handle(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

fn emit_entitlement_changed() {
    use tauri::Emitter;
    if let Some(app) = APP.get() {
        let _ = app.emit(ENTITLEMENT_CHANGED_EVENT, ());
    }
}

/// Should `auth_refresh` also fetch a new token? Only with a key compiled in,
/// and only when the session plan Clerk just reported (`legacy`) disagrees with
/// the plan the gates use (`effective`): that is the post-checkout moment when
/// the webhook has landed but the token still says the old plan. Pure, tested.
pub fn token_lags_session(
    key_compiled_in: bool,
    legacy: crate::entitlement::Plan,
    effective: crate::entitlement::Plan,
) -> bool {
    key_compiled_in && legacy != effective
}

/// What to do with a token the server just returned. Pure, tested.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefreshDecision {
    /// Valid for the user still signed in: store it.
    Store(EntitlementClaims),
    /// Signed by our key but for another user: our cached token belongs to a
    /// different principal than the session thinks, so drop it.
    ClearCached,
    /// Unusable, or the session changed mid-flight: keep the cached token.
    Keep,
}

pub fn decide_refresh(
    token: &str,
    key: &VerifyingKey,
    requested_sub: &str,
    sub_now: Option<&str>,
    now: chrono::DateTime<chrono::Utc>,
) -> RefreshDecision {
    // Sign-out (or a different sign-in) raced the request: the token is not
    // for whoever is signed in now. Drop it on the floor.
    if sub_now != Some(requested_sub) {
        return RefreshDecision::Keep;
    }
    match verify_token(token, key, requested_sub, now) {
        Ok(claims) => RefreshDecision::Store(claims),
        Err(TokenRejection::WrongSubject) => RefreshDecision::ClearCached,
        Err(_) => RefreshDecision::Keep,
    }
}

/// Fetch a fresh token from `POST /api/entitlement` and store it.
///
/// No-op (no request at all) while no key is compiled in, or when signed out.
/// Best-effort: a failure (offline, 401, 503 `not_provisioned`, a token that
/// does not verify) logs and keeps the cached token, so a failed refresh never
/// downgrades anyone before the cached token's own `exp`. The one exception is
/// a validly signed token for a different user, which clears the cache.
/// Emits [`ENTITLEMENT_CHANGED_EVENT`] when the effective plan changed. Returns
/// the verified plan on success.
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
    let before = crate::entitlement::Entitlement::current().plan;
    // Re-read the identity right before storing: a sign-out during the request
    // must not leave a token behind.
    let sub_now = crate::auth::current_identity().map(|(s, _)| s);
    let plan = match decide_refresh(&issued.token, &key, &sub, sub_now.as_deref(), chrono::Utc::now()) {
        RefreshDecision::Store(claims) => {
            if let Err(e) = store_token(&issued.token) {
                tracing::warn!("could not store the entitlement token: {e}");
                return None;
            }
            Some(claims.plan)
        }
        RefreshDecision::ClearCached => {
            tracing::warn!("entitlement refresh: server token is for another user; clearing the cached token");
            let _ = clear_token();
            None
        }
        RefreshDecision::Keep => {
            tracing::warn!("entitlement refresh: token not usable for the current session; keeping the cached token");
            return None;
        }
    };
    if crate::entitlement::Entitlement::current().plan != before {
        emit_entitlement_changed();
    }
    plan
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

    /// What this proves: `auth::sign_out` (through `clear_session`, which also
    /// backs the revoked-refresh-token path) clears the token this process
    /// serves, and its keychain delete is attempted and tolerated. What it does
    /// NOT prove: that the real macOS keychain item is gone. keyring's mock
    /// store keeps no state across `Entry` instances, so the keychain side is
    /// only exercised for "delete of a missing item is OK".
    #[test]
    #[serial_test::serial(keychain)]
    fn sign_out_clears_the_served_token_mock_keychain() {
        // Never touch the real keychain from a test.
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        store_token(TS_PRO).expect("store");
        assert_eq!(load_token().as_deref(), Some(TS_PRO));
        crate::auth::sign_out().expect("sign out");
        assert_eq!(load_token(), None, "sign-out must drop the token");
    }

    // ── Hardening ───────────────────────────────────────────────────────────

    #[test]
    fn weak_keys_are_rejected() {
        // The identity point (compressed: 0x01 then 31 zero bytes) is a valid
        // curve point but small-order: it would make forged signatures verify.
        let mut identity = [0u8; 32];
        identity[0] = 1;
        assert!(VerifyingKey::from_bytes(&identity).is_ok(), "decodes as a point");
        assert!(parse_public_key(&STANDARD.encode(identity)).is_none());
    }

    #[test]
    fn oversized_tokens_are_refused_before_decoding() {
        let big = format!("v1.{}.{}", "A".repeat(MAX_TOKEN_BYTES), "A".repeat(86));
        assert!(big.len() > MAX_TOKEN_BYTES);
        assert_eq!(verify_token(&big, &key(), "user_abc", now()), Err(TokenRejection::Malformed));
        // A real token is far below the bound.
        assert!(TS_PRO.len() < MAX_TOKEN_BYTES / 8);
    }

    #[test]
    fn a_token_issued_in_the_future_is_refused() {
        let at = |iat: i64| {
            mint_raw(
                &serde_json::json!({"v": 1, "sub": "user_abc", "plan": "pro", "iat": iat, "exp": iat + 30 * 86_400}),
                &signing_key(),
            )
        };
        let t = now().timestamp();
        assert!(verify_token(&at(t + MAX_IAT_SKEW_SECS), &key(), "user_abc", now()).is_ok(), "within skew");
        assert_eq!(
            verify_token(&at(t + MAX_IAT_SKEW_SECS + 1), &key(), "user_abc", now()),
            Err(TokenRejection::IssuedInFuture)
        );
    }

    // ── Refresh decisions ───────────────────────────────────────────────────

    #[test]
    fn auth_refresh_fetches_a_token_only_when_it_lags_the_session() {
        // The post-checkout poll: Clerk says Pro, the token still says Free.
        assert!(token_lags_session(true, Plan::Pro, Plan::Free));
        // A cancellation travels the same way.
        assert!(token_lags_session(true, Plan::Free, Plan::Pro));
        // In agreement: no request.
        assert!(!token_lags_session(true, Plan::Pro, Plan::Pro));
        assert!(!token_lags_session(true, Plan::Free, Plan::Free));
        // No key compiled in: never a request.
        assert!(!token_lags_session(false, Plan::Pro, Plan::Free));
    }

    #[test]
    fn auth_refresh_lag_check_against_real_resolution() {
        // Key set, webhook landed (legacy "pro"), cached token still Free.
        let k = key();
        let legacy = Entitlement::for_plan(Some("pro")).plan;
        let effective = resolve(Some(&k), Some("pro"), Some("user_abc"), Some(TS_FREE)).plan;
        assert!(token_lags_session(true, legacy, effective));
        // After the refresh stored a Pro token, the poll stops asking.
        let effective = resolve(Some(&k), Some("pro"), Some("user_abc"), Some(TS_PRO)).plan;
        assert!(!token_lags_session(true, legacy, effective));
    }

    #[test]
    fn refresh_decisions() {
        let k = key();
        match decide_refresh(TS_PRO, &k, "user_abc", Some("user_abc"), now()) {
            RefreshDecision::Store(c) => assert_eq!(c.plan, "pro"),
            other => panic!("expected Store, got {other:?}"),
        }
        // Validly signed for someone else: clear what we cached.
        assert_eq!(decide_refresh(TS_PRO, &k, "user_other", Some("user_other"), now()), RefreshDecision::ClearCached);
        // Signed out, or another user signed in, while the request was in flight.
        assert_eq!(decide_refresh(TS_PRO, &k, "user_abc", None, now()), RefreshDecision::Keep);
        assert_eq!(decide_refresh(TS_PRO, &k, "user_abc", Some("user_new"), now()), RefreshDecision::Keep);
        // Unusable responses keep the cached token.
        assert_eq!(decide_refresh("garbage", &k, "user_abc", Some("user_abc"), now()), RefreshDecision::Keep);
        let expired = mint("pro", now().timestamp());
        assert_eq!(decide_refresh(&expired, &k, "user_abc", Some("user_abc"), now()), RefreshDecision::Keep);
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
