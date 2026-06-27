//! Accounts (P1) — desktop sign-in via Clerk using the OAuth 2.0 Authorization
//! Code flow with **PKCE (S256)** as a **public client** (no client secret).
//!
//! Why this shape (vs. embedding Clerk's web SDK): Octopush is a native Tauri
//! app, and Clerk has no official desktop SDK. The robust, standard pattern for
//! native apps (RFC 8252) is to do the OAuth dance in the user's **real system
//! browser** and capture the redirect on a **loopback** server — which sidesteps
//! the webview cookie/origin friction entirely and keeps identity in Rust where
//! the entitlement gates live. Clerk's discovery advertises
//! `token_endpoint_auth_methods_supported: ["none", ...]`, so a public client
//! (PKCE, no secret) is supported — nothing secret ever ships in the binary.
//!
//! Flow: gen PKCE verifier+challenge → open the browser to `/oauth/authorize`
//! → user signs in on Clerk's hosted page → Clerk redirects to
//! `http://127.0.0.1:8976/callback?code&state` → we exchange the code at
//! `/oauth/token` (with the verifier, no secret) → fetch `/oauth/userinfo` →
//! store the session in the OS keychain. See
//! `docs/premium/accounts-and-subscriptions-implementation-plan.md` (P1).

use crate::error::{AppError, AppResult};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Loopback port the OAuth redirect lands on. Must match a Redirect URL
/// registered on the Clerk OAuth application.
const LOOPBACK_PORT: u16 = 8976;

/// Set by `cancel_sign_in` to abort an in-flight sign-in; the loopback poll
/// checks it each tick. A single flag is enough — only one sign-in runs at a
/// time (the loopback port is exclusive). Invariant: it is cleared at the
/// *start* of every `begin_sign_in` and never read outside an active sign-in,
/// so a leftover `true` from a prior cancel cannot pre-cancel the next one.
static SIGN_IN_CANCEL: AtomicBool = AtomicBool::new(false);

/// Serializes token refresh so concurrent `status()` calls don't double-refresh
/// — with refresh-token rotation, a second, now-stale refresh could spuriously
/// revoke the whole session.
static REFRESH_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
fn refresh_lock() -> &'static tokio::sync::Mutex<()> {
    REFRESH_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}
/// How long we wait for the user to finish signing in before giving up.
const SIGN_IN_TIMEOUT_SECS: u64 = 300;
/// Keychain service/account under which the session blob is stored.
const KEYRING_SERVICE: &str = "octopush";
const KEYRING_ACCOUNT: &str = "clerk-oauth-session";

/// Resolved Clerk OAuth configuration. The `client_id` and instance are PUBLIC
/// values (safe to ship); the secret is never used (public-client PKCE). For now
/// these are built-in defaults for the project's Clerk instance; a later phase
/// makes them configurable for a production instance.
#[derive(Debug, Clone)]
pub struct ClerkConfig {
    pub instance: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub scopes: String,
}

impl ClerkConfig {
    pub fn current() -> Self {
        ClerkConfig {
            instance: "smooth-ringtail-82.clerk.accounts.dev".into(),
            client_id: "M3OMbpMlh1vzUnO4".into(),
            redirect_uri: format!("http://127.0.0.1:{LOOPBACK_PORT}/callback"),
            // `offline_access` → refresh token; `public_metadata` → the user's
            // plan claim (set by the billing webhook) rides on the OAuth session.
            scopes: "openid email profile offline_access public_metadata".into(),
        }
    }
    pub fn authorize_url(&self) -> String {
        format!("https://{}/oauth/authorize", self.instance)
    }
    pub fn token_url(&self) -> String {
        format!("https://{}/oauth/token", self.instance)
    }
    pub fn userinfo_url(&self) -> String {
        format!("https://{}/oauth/userinfo", self.instance)
    }
    /// Clerk's hosted account portal — opened in the browser for sign-up and
    /// profile/MFA management (a clean native pattern; we don't rebuild it).
    pub fn account_portal_url(&self) -> String {
        format!("https://{}/user", self.instance)
    }
}

/// What the frontend shows: are we signed in, and as whom.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub signed_in: bool,
    pub email: Option<String>,
    pub name: Option<String>,
}

/// Persisted session (kept in the OS keychain, never in the DB or settings.json).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSession {
    sub: String,
    email: Option<String>,
    name: Option<String>,
    access_token: String,
    refresh_token: Option<String>,
    obtained_at: String,
    /// RFC3339 expiry of `access_token` (from the token response's `expires_in`).
    /// `None` for legacy sessions saved before this field existed.
    #[serde(default)]
    expires_at: Option<String>,
    /// The user's plan from Clerk `public_metadata.plan` (e.g. "pro"); `None`
    /// = Free. Read from userinfo at sign-in / refresh_identity.
    #[serde(default)]
    plan: Option<String>,
}

// ─── PKCE + state (pure, unit-tested) ──────────────────────────────────────

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// A high-entropy code verifier: 32 random bytes → 43-char base64url string
/// (within the RFC 7636 43–128 range, all unreserved chars). Two v4 UUIDs supply
/// ~244 bits of CSPRNG entropy — well above what PKCE needs.
fn gen_verifier() -> String {
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    b64url(&bytes)
}

/// `code_challenge = BASE64URL(SHA256(verifier))` — the S256 method (the only
/// one Clerk advertises).
fn challenge_s256(verifier: &str) -> String {
    b64url(&Sha256::digest(verifier.as_bytes()))
}

/// 122-bit CSPRNG state (CSRF token) tying the redirect back to this request.
fn random_state() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Build the `/oauth/authorize` URL for the Authorization Code + PKCE flow.
fn build_authorize_url(cfg: &ClerkConfig, challenge: &str, state: &str) -> String {
    let q = |k: &str, v: &str| format!("{}={}", k, urlencoding::encode(v));
    format!(
        "{}?{}&{}&{}&{}&{}&{}&{}",
        cfg.authorize_url(),
        q("response_type", "code"),
        q("client_id", &cfg.client_id),
        q("redirect_uri", &cfg.redirect_uri),
        q("scope", &cfg.scopes),
        q("state", state),
        q("code_challenge", challenge),
        q("code_challenge_method", "S256"),
    )
}

// ─── Loopback redirect capture ─────────────────────────────────────────────

/// Parse `code`/`state`/`error` out of a redirect request's target path
/// (e.g. `/callback?code=abc&state=xyz`).
fn parse_callback_query(target: &str) -> (Option<String>, Option<String>, Option<String>) {
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            let val = urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_default();
            match k {
                "code" => code = Some(val),
                "state" => state = Some(val),
                "error" => error = Some(val),
                _ => {}
            }
        }
    }
    (code, state, error)
}

/// The security-critical gate over the callback params: an OAuth `error` aborts,
/// a `state` that doesn't match what we issued is rejected (CSRF), and the
/// `code` must be present. Pure so the gate is unit-tested without a socket.
fn decide_callback(
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    expected_state: &str,
) -> Result<String, String> {
    if let Some(err) = error {
        return Err(format!("Clerk reported: {err}"));
    }
    // Constant-ish comparison is unnecessary here (the attacker can't probe
    // adaptively — one redirect, one chance), but the match must be exact.
    if state.as_deref() != Some(expected_state) {
        return Err("State mismatch — please try again.".into());
    }
    match code {
        Some(c) if !c.is_empty() => Ok(c),
        _ => Err("No authorization code returned.".into()),
    }
}

/// Handle a single inbound connection. `None` = a stray request (e.g. favicon) —
/// the caller keeps waiting; `Some(Ok(code))` = a valid callback; `Some(Err)` =
/// an OAuth error or state mismatch.
fn handle_callback_conn(mut stream: TcpStream, expected_state: &str) -> Option<Result<String, String>> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    // Read until the end of the request line (we only need the GET target), with
    // a cap, since a single read() is not guaranteed to return the whole line.
    let mut data = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                data.extend_from_slice(&chunk[..n]);
                // The request line we need ends at the first newline.
                if data.contains(&b'\n') || data.len() > 8192 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let req = String::from_utf8_lossy(&data);
    let target = req
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("");
    if !target.starts_with("/callback") {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return None;
    }
    let (code, state, error) = parse_callback_query(target);
    let decision = decide_callback(code, state, error, expected_state);
    let (status, html) = match &decision {
        Ok(_) => (
            "200 OK",
            callback_html(
                "Signed in",
                "You're all set — close this tab and head back to Octopush.",
                "You can close this window",
                false,
            ),
        ),
        Err(msg) => (
            "400 Bad Request",
            callback_html("Sign-in didn't complete", msg, "Return to Octopush and try again", true),
        ),
    };
    let _ = stream.write_all(
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
            html.len()
        )
        .as_bytes(),
    );
    Some(decision)
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// The branded page the browser shows after the OAuth redirect (Atelier in Onyx
/// & Brass). The dynamic `body` — which may carry the provider's `error` query
/// param — is HTML-escaped to prevent reflected injection on the loopback page.
fn callback_html(title: &str, body: &str, hint: &str, is_error: bool) -> String {
    const TEMPLATE: &str = r##"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__ · Octopush</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Spectral:wght@500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{
    --onyx:#0c0a08;--panel:#14110d;--hairline:#2a2419;
    --brass:#d4a574;--ivory:#f4ecdb;--sage:#95897a;--mute:#6d6354;--rouge:#d18b8b;
    --serif:"Spectral",Georgia,"Times New Roman",serif;--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,monospace;
  }
  *{box-sizing:border-box}
  html,body{height:100%;margin:0}
  body{background:var(--onyx);color:var(--ivory);font-family:var(--serif);
    display:flex;align-items:center;justify-content:center;min-height:100vh;
    padding:24px;position:relative;overflow:hidden;-webkit-font-smoothing:antialiased}
  .glow{position:fixed;border-radius:50%;filter:blur(120px);pointer-events:none}
  .glow-1{width:520px;height:520px;background:radial-gradient(circle,rgba(212,165,116,.16),transparent 70%);top:-180px;left:50%;transform:translateX(-50%)}
  .glow-2{width:380px;height:380px;background:radial-gradient(circle,rgba(212,165,116,.07),transparent 70%);bottom:-160px;right:-90px}
  .card{position:relative;z-index:1;text-align:center;max-width:440px;animation:rise .5s cubic-bezier(.2,.8,.3,1) both}
  @keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  .mark{display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;
    border-radius:16px;background:var(--panel);border:1px solid var(--hairline);
    font-family:var(--serif);font-weight:600;font-size:38px;line-height:1;color:var(--brass);
    margin-bottom:26px;box-shadow:0 0 0 1px rgba(212,165,116,.06),0 24px 60px -24px rgba(0,0,0,.8)}
  .mark.err{color:var(--rouge)}
  h1{font-family:var(--serif);font-weight:500;font-size:26px;margin:0 0 12px;letter-spacing:-.01em;color:var(--ivory)}
  p{font-family:var(--serif);font-size:15.5px;line-height:1.65;color:var(--sage);margin:0 auto;max-width:34ch}
  .hint{margin-top:30px;font-family:var(--mono);font-size:11.5px;letter-spacing:.06em;color:var(--mute);text-transform:uppercase}
  .brand{position:fixed;bottom:30px;left:0;right:0;text-align:center;font-family:var(--mono);font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--mute);z-index:1}
  .brand b{color:var(--brass);font-weight:500}
  @media (prefers-reduced-motion:reduce){.card{animation:none}}
</style>
</head>
<body>
  <div class="glow glow-1"></div>
  <div class="glow glow-2"></div>
  <main class="card">
    <div class="mark __MARKCLS__">§</div>
    <h1>__TITLE__</h1>
    <p>__BODY__</p>
    <div class="hint">__HINT__</div>
  </main>
  <div class="brand">Octopush</div>
</body>
</html>"##;
    // Substitute the attacker-influenceable __BODY__ LAST, so a body that happens
    // to contain another placeholder literal (e.g. "__HINT__") is never re-replaced.
    TEMPLATE
        .replace("__TITLE__", &html_escape(title))
        .replace("__HINT__", &html_escape(hint))
        .replace("__MARKCLS__", if is_error { "err" } else { "" })
        .replace("__BODY__", &html_escape(body))
}

/// Poll the loopback listener (non-blocking, so the thread is never parked
/// forever) until the OAuth redirect arrives or `deadline` passes. Returning —
/// on success, error, or timeout — drops the `listener`, releasing the port so a
/// retry can bind again.
fn wait_for_callback(
    listener: TcpListener,
    expected_state: &str,
    deadline: Instant,
) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("could not arm the sign-in listener: {e}"))?;
    loop {
        if SIGN_IN_CANCEL.load(Ordering::SeqCst) {
            return Err("Sign-in cancelled.".into());
        }
        if Instant::now() >= deadline {
            return Err("sign-in timed out — the browser never returned.".into());
        }
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(result) = handle_callback_conn(stream, expected_state) {
                    return result;
                }
                // stray request — keep waiting
            }
            Err(ref e) if e.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("sign-in listener error: {e}")),
        }
    }
}

fn open_in_browser(url: &str) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    let prog = "open";
    #[cfg(target_os = "linux")]
    let prog = "xdg-open";
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let prog = "open";
    std::process::Command::new(prog)
        .arg(url)
        .spawn()
        .map_err(|e| AppError::Other(format!("could not open the browser for sign-in: {e}")))?;
    Ok(())
}

// ─── Token exchange + userinfo ─────────────────────────────────────────────

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

#[derive(Deserialize)]
struct UserInfo {
    sub: String,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    name: Option<String>,
    /// Clerk public metadata (present when the `public_metadata` scope is
    /// granted). Carries `{ "plan": "pro" }` once the billing webhook sets it.
    #[serde(default)]
    public_metadata: Option<serde_json::Value>,
}

/// Reduce a non-2xx token response to just the standard OAuth `error` /
/// `error_description` fields — never echo an arbitrary upstream body.
fn oauth_error_message(status: reqwest::StatusCode, body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            let e = v.get("error").and_then(|x| x.as_str())?.to_string();
            let d = v.get("error_description").and_then(|x| x.as_str());
            Some(match d {
                Some(d) => format!("{e}: {d}"),
                None => e,
            })
        })
        .unwrap_or_else(|| format!("HTTP {}", status.as_u16()))
}

async fn exchange_code(
    client: &reqwest::Client,
    cfg: &ClerkConfig,
    code: &str,
    verifier: &str,
) -> AppResult<TokenResponse> {
    let resp = client
        .post(cfg.token_url())
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &cfg.redirect_uri),
            ("client_id", &cfg.client_id),
            ("code_verifier", verifier),
        ])
        .send()
        .await
        .map_err(|e| AppError::Other(format!("token exchange request failed: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "token exchange failed — {}",
            oauth_error_message(status, &body)
        )));
    }
    resp.json::<TokenResponse>()
        .await
        .map_err(|e| AppError::Other(format!("could not parse token response: {e}")))
}

async fn fetch_userinfo(
    client: &reqwest::Client,
    cfg: &ClerkConfig,
    access_token: &str,
) -> AppResult<UserInfo> {
    let resp = client
        .get(cfg.userinfo_url())
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| AppError::Other(format!("userinfo request failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Other(format!("userinfo failed: {}", resp.status())));
    }
    resp.json::<UserInfo>()
        .await
        .map_err(|e| AppError::Other(format!("could not parse userinfo: {e}")))
}

// ─── Keychain persistence (cached in memory) ───────────────────────────────
//
// The OS keychain prompts for access on an unsigned / ad-hoc-signed build
// ("cannot verify the authenticity of Octopush"). So we read it AT MOST ONCE
// per launch and serve every later read from an in-memory cache; writes/clears
// update both. Without this, P2a's plan read on every Settings open (via the
// entitlement) fires a keychain prompt each time.

enum SessionCache {
    Unloaded,
    Loaded(Option<StoredSession>),
}
static SESSION_CACHE: Mutex<SessionCache> = Mutex::new(SessionCache::Unloaded);

fn keyring_entry() -> AppResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| AppError::Other(format!("keychain unavailable: {e}")))
}

/// Read straight from the keychain (the only place that actually touches it for
/// reads). Triggers the OS prompt on an unverified build — call sparingly.
fn read_keychain() -> Option<StoredSession> {
    let entry = keyring_entry().ok()?;
    match entry.get_password() {
        Ok(blob) => serde_json::from_str(&blob).ok(),
        Err(_) => None, // NoEntry or other → treat as signed out
    }
}

fn store_session(session: &StoredSession) -> AppResult<()> {
    let blob = serde_json::to_string(session)?;
    keyring_entry()?
        .set_password(&blob)
        .map_err(|e| AppError::Other(format!("could not save the session to the keychain: {e}")))?;
    *SESSION_CACHE.lock().unwrap() = SessionCache::Loaded(Some(session.clone()));
    Ok(())
}

fn load_session() -> Option<StoredSession> {
    let mut cache = SESSION_CACHE.lock().unwrap();
    if let SessionCache::Loaded(session) = &*cache {
        return session.clone();
    }
    let loaded = read_keychain();
    *cache = SessionCache::Loaded(loaded.clone());
    loaded
}

fn clear_session() -> AppResult<()> {
    let entry = keyring_entry()?;
    let result = match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Other(format!("could not clear the session: {e}"))),
    };
    // Clear the in-memory cache regardless of the delete outcome: the user asked
    // to sign out, so honor it locally for this session even if the keychain
    // delete failed (the keychain would win on the next launch).
    *SESSION_CACHE.lock().unwrap() = SessionCache::Loaded(None);
    result
}

// ─── Public API (driven by Tauri commands) ─────────────────────────────────

/// Run the full interactive sign-in. Opens the browser, captures the redirect,
/// exchanges the code, fetches identity, and persists the session.
pub async fn begin_sign_in() -> AppResult<AuthStatus> {
    let cfg = ClerkConfig::current();
    SIGN_IN_CANCEL.store(false, Ordering::SeqCst);
    let verifier = gen_verifier();
    let challenge = challenge_s256(&verifier);
    let state = random_state();

    // Bind the loopback listener up front so we fail fast if the port is taken.
    let listener = TcpListener::bind(("127.0.0.1", LOOPBACK_PORT)).map_err(|e| {
        AppError::Other(format!(
            "could not start the sign-in listener on 127.0.0.1:{LOOPBACK_PORT} ({e}). Close whatever is using that port and try again."
        ))
    })?;

    // One shared client (avoids a per-request connection pool and the panic path
    // of `Client::new()` on a TLS-init failure).
    let http = reqwest::Client::builder()
        .build()
        .map_err(|e| AppError::Other(format!("http client init failed: {e}")))?;

    open_in_browser(&build_authorize_url(&cfg, &challenge, &state))?;

    let deadline = Instant::now() + Duration::from_secs(SIGN_IN_TIMEOUT_SECS);
    let expected = state.clone();
    let code = tokio::task::spawn_blocking(move || wait_for_callback(listener, &expected, deadline))
        .await
        .map_err(|e| AppError::Other(format!("sign-in listener crashed: {e}")))?
        .map_err(AppError::Other)?;

    // Past this point the sign-in is no longer cancellable — we hold a valid
    // code and complete the exchange rather than abandon it.
    let tokens = exchange_code(&http, &cfg, &code, &verifier).await?;
    let user = fetch_userinfo(&http, &cfg, &tokens.access_token).await?;

    let plan = plan_from_userinfo(&user);
    store_session(&StoredSession {
        sub: user.sub,
        email: user.email.clone(),
        name: user.name.clone(),
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        obtained_at: chrono::Utc::now().to_rfc3339(),
        expires_at: expires_at_from(tokens.expires_in),
        plan,
    })?;

    Ok(AuthStatus { signed_in: true, email: user.email, name: user.name })
}

pub fn sign_out() -> AppResult<()> {
    clear_session()
}

/// Current sign-in status. If the access token has expired, attempt a silent
/// refresh: on success update the stored session; if the refresh token is
/// rejected the session is dead (clear it, report signed-out); on a
/// transient/offline failure keep the session and stay signed in optimistically.
pub async fn status() -> AuthStatus {
    let session = match load_session() {
        Some(s) => s,
        None => return AuthStatus::default(),
    };
    if !is_expired(session.expires_at.as_deref()) {
        return AuthStatus { signed_in: true, email: session.email, name: session.name };
    }
    // Single-flight the refresh: only one network refresh runs at a time, and we
    // re-load after acquiring the lock — another caller may have refreshed while
    // we waited (avoids a refresh-token-rotation race that could sign us out).
    let _guard = refresh_lock().lock().await;
    let session = match load_session() {
        Some(s) => s,
        None => return AuthStatus::default(),
    };
    if !is_expired(session.expires_at.as_deref()) {
        return AuthStatus { signed_in: true, email: session.email, name: session.name };
    }
    match refresh_session(&session).await {
        RefreshOutcome::Refreshed(updated) => {
            let _ = store_session(&updated);
            AuthStatus { signed_in: true, email: updated.email, name: updated.name }
        }
        // The refresh token is gone/rejected → the session is truly dead.
        RefreshOutcome::TokenRevoked => {
            let _ = clear_session();
            AuthStatus::default()
        }
        // Offline / server hiccup → keep the session and stay signed in
        // optimistically (offline grace; it refreshes on a later call online).
        RefreshOutcome::TransientError => {
            AuthStatus { signed_in: true, email: session.email, name: session.name }
        }
    }
}

/// True when the stored access token has passed (or is within 30s of) its
/// expiry. Unknown/legacy expiry is treated as not-expired (don't force a
/// refresh on sessions saved before the field existed).
fn is_expired(expires_at: Option<&str>) -> bool {
    match expires_at.and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()) {
        Some(exp) => chrono::Utc::now() + chrono::Duration::seconds(30) >= exp,
        None => false,
    }
}

fn expires_at_from(expires_in: Option<i64>) -> Option<String> {
    expires_in.map(|secs| (chrono::Utc::now() + chrono::Duration::seconds(secs)).to_rfc3339())
}

/// Outcome of a refresh attempt — distinguishes a definitively dead session
/// (refresh token rejected → sign out) from a transient/offline failure (keep
/// the session; never sign a user out just because they were offline).
enum RefreshOutcome {
    Refreshed(StoredSession),
    TokenRevoked,
    TransientError,
}

/// A non-success refresh status: only an explicit token rejection (400
/// invalid_grant / 401) is definitive; everything else (403 proxy/WAF
/// interstitials, 429 rate-limit, 5xx) is transient, so we keep the session.
fn refresh_failure_is_revoked(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::UNAUTHORIZED
    )
}

/// Exchange the refresh token for a fresh access token (public-client grant, no
/// secret). Keeps a rotated refresh token if Clerk returns one.
async fn refresh_session(session: &StoredSession) -> RefreshOutcome {
    let Some(refresh_token) = session.refresh_token.as_deref() else {
        return RefreshOutcome::TokenRevoked; // nothing to refresh with → dead
    };
    let cfg = ClerkConfig::current();
    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(_) => return RefreshOutcome::TransientError,
    };
    let resp = match client
        .post(cfg.token_url())
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", &cfg.client_id),
        ])
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return RefreshOutcome::TransientError, // offline / DNS / TLS
    };
    let status = resp.status();
    if !status.is_success() {
        return if refresh_failure_is_revoked(status) {
            RefreshOutcome::TokenRevoked
        } else {
            RefreshOutcome::TransientError
        };
    }
    match resp.json::<TokenResponse>().await {
        Ok(tokens) => RefreshOutcome::Refreshed(StoredSession {
            sub: session.sub.clone(),
            email: session.email.clone(),
            name: session.name.clone(),
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token.or_else(|| session.refresh_token.clone()),
            obtained_at: chrono::Utc::now().to_rfc3339(),
            expires_at: expires_at_from(tokens.expires_in),
            plan: session.plan.clone(),
        }),
        Err(_) => RefreshOutcome::TransientError,
    }
}

/// Abort an in-flight sign-in; the loopback poll returns within ~100ms.
pub fn cancel_sign_in() {
    SIGN_IN_CANCEL.store(true, Ordering::SeqCst);
}

pub fn account_portal_url() -> String {
    ClerkConfig::current().account_portal_url()
}

/// Extract the plan claim from Clerk `public_metadata.plan` in a userinfo
/// response (e.g. "pro"). `None` → treat as Free.
fn plan_from_userinfo(user: &UserInfo) -> Option<String> {
    user.public_metadata
        .as_ref()?
        .get("plan")?
        .as_str()
        .map(str::to_string)
}

/// The signed-in user's plan (from the stored session), or `None` when signed
/// out / no plan claim. Consulted by `entitlement::current`.
pub fn current_plan() -> Option<String> {
    load_session().and_then(|s| s.plan)
}

/// The signed-in user's (clerk_user_id, email), or `None` when signed out.
/// Used by billing to stamp the checkout link.
pub fn current_identity() -> Option<(String, Option<String>)> {
    load_session().map(|s| (s.sub, s.email))
}

/// Re-fetch identity (incl. the `plan` in public_metadata) for the stored
/// session, refreshing the access token first if needed. Picks up a plan change
/// after the user subscribes. Best-effort: on a transient failure it returns the
/// existing status unchanged (never signs the user out over a network hiccup).
pub async fn refresh_identity() -> AppResult<AuthStatus> {
    // Single-flight with status()'s refresh so concurrent calls can't both rotate
    // the refresh token (re-load after acquiring, like status()).
    let _guard = refresh_lock().lock().await;
    let mut session = match load_session() {
        Some(s) => s,
        None => return Ok(AuthStatus::default()),
    };
    let here = |s: &StoredSession| AuthStatus {
        signed_in: true,
        email: s.email.clone(),
        name: s.name.clone(),
    };
    if is_expired(session.expires_at.as_deref()) {
        match refresh_session(&session).await {
            RefreshOutcome::Refreshed(updated) => {
                let _ = store_session(&updated);
                session = updated;
            }
            RefreshOutcome::TokenRevoked => {
                let _ = clear_session();
                return Ok(AuthStatus::default());
            }
            RefreshOutcome::TransientError => return Ok(here(&session)),
        }
    }
    let cfg = ClerkConfig::current();
    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(_) => return Ok(here(&session)),
    };
    match fetch_userinfo(&client, &cfg, &session.access_token).await {
        Ok(user) => {
            // Only write the keychain when something actually changed — avoids a
            // keychain prompt on every Account-pane open when nothing moved.
            let new_plan = plan_from_userinfo(&user);
            if session.email != user.email || session.name != user.name || session.plan != new_plan {
                session.email = user.email.clone();
                session.name = user.name.clone();
                session.plan = new_plan;
                let _ = store_session(&session);
            }
            Ok(here(&session))
        }
        Err(_) => Ok(here(&session)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s256_matches_rfc7636_vector() {
        // RFC 7636 Appendix B.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(challenge_s256(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn plan_is_read_from_public_metadata() {
        let pro: UserInfo = serde_json::from_value(serde_json::json!({
            "sub": "user_1", "email": "a@b.co", "public_metadata": { "plan": "pro" }
        }))
        .unwrap();
        assert_eq!(plan_from_userinfo(&pro).as_deref(), Some("pro"));

        // No metadata at all → None (Free).
        let bare: UserInfo = serde_json::from_value(serde_json::json!({ "sub": "u2" })).unwrap();
        assert_eq!(plan_from_userinfo(&bare), None);

        // Metadata present but no plan key → None.
        let empty: UserInfo = serde_json::from_value(serde_json::json!({
            "sub": "u3", "public_metadata": {}
        }))
        .unwrap();
        assert_eq!(plan_from_userinfo(&empty), None);
    }

    #[test]
    fn is_expired_handles_past_future_and_unknown() {
        // Unknown/legacy expiry → treated as still valid (no forced refresh).
        assert!(!is_expired(None));
        assert!(!is_expired(Some("not-a-date")));
        // Far future → not expired.
        let future = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        assert!(!is_expired(Some(&future)));
        // Past → expired.
        let past = (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339();
        assert!(is_expired(Some(&past)));
        // Within the 30s skew window → expired (refresh proactively).
        let soon = (chrono::Utc::now() + chrono::Duration::seconds(10)).to_rfc3339();
        assert!(is_expired(Some(&soon)));
    }

    #[test]
    fn only_400_401_revoke_the_session() {
        use reqwest::StatusCode;
        assert!(refresh_failure_is_revoked(StatusCode::BAD_REQUEST));
        assert!(refresh_failure_is_revoked(StatusCode::UNAUTHORIZED));
        // 403 (proxy/WAF interstitial), 429, and 5xx must NOT sign the user out.
        assert!(!refresh_failure_is_revoked(StatusCode::FORBIDDEN));
        assert!(!refresh_failure_is_revoked(StatusCode::TOO_MANY_REQUESTS));
        assert!(!refresh_failure_is_revoked(StatusCode::INTERNAL_SERVER_ERROR));
    }

    #[test]
    fn expires_at_from_handles_none() {
        assert!(expires_at_from(None).is_none());
        assert!(expires_at_from(Some(3600)).is_some());
    }

    #[test]
    fn verifier_is_valid_pkce_length_and_charset() {
        let v = gen_verifier();
        assert_eq!(v.len(), 43, "32 bytes base64url-nopad = 43 chars");
        assert!(v.len() >= 43 && v.len() <= 128);
        assert!(
            v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "verifier must be unreserved chars only: {v}"
        );
        assert_ne!(gen_verifier(), gen_verifier(), "verifiers must be random");
    }

    #[test]
    fn authorize_url_has_all_required_params() {
        let cfg = ClerkConfig::current();
        let url = build_authorize_url(&cfg, "CHAL", "STATE");
        assert!(url.starts_with(&cfg.authorize_url()));
        assert!(url.contains("response_type=code"));
        assert!(url.contains(&format!("client_id={}", cfg.client_id)));
        assert!(url.contains("code_challenge=CHAL"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=STATE"));
        // redirect_uri + scopes are URL-encoded.
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A8976%2Fcallback"));
        assert!(url.contains("scope=openid%20email%20profile%20offline_access"));
    }

    #[test]
    fn parses_callback_code_and_state() {
        let (code, state, error) = parse_callback_query("/callback?code=abc123&state=xyz");
        assert_eq!(code.as_deref(), Some("abc123"));
        assert_eq!(state.as_deref(), Some("xyz"));
        assert!(error.is_none());

        let (_, _, error) = parse_callback_query("/callback?error=access_denied");
        assert_eq!(error.as_deref(), Some("access_denied"));
    }

    #[test]
    fn html_escape_covers_the_dangerous_chars() {
        assert_eq!(html_escape("<a href=\"x\">& '"), "&lt;a href=&quot;x&quot;&gt;&amp; &#39;");
    }

    #[test]
    fn callback_html_escapes_the_body_and_brands_the_page() {
        // A provider error param carrying HTML must not break out into markup.
        let page = callback_html(
            "Sign-in didn't complete",
            "Clerk reported: <script>alert(1)</script>",
            "Return to Octopush",
            true,
        );
        assert!(!page.contains("<script>alert(1)</script>"));
        assert!(page.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        // Branded chrome + the error mark.
        assert!(page.contains(">Octopush</div>"));
        assert!(page.contains("class=\"mark err\""));
        // Success uses the plain mark (no error class).
        let ok = callback_html("Signed in", "All set.", "You can close this window", false);
        assert!(ok.contains("class=\"mark \""));
        // A body containing a placeholder literal must not trigger a second-order replace.
        let tricky = callback_html("Signed in", "weird __HINT__ value", "HINTTEXT", false);
        assert!(tricky.contains("weird __HINT__ value"));
        assert!(!tricky.contains("weird HINTTEXT value"));
    }

    #[test]
    fn decide_callback_enforces_state_and_code() {
        // Happy path.
        assert_eq!(
            decide_callback(Some("c".into()), Some("S".into()), None, "S"),
            Ok("c".into())
        );
        // CSRF: state mismatch is rejected.
        assert!(decide_callback(Some("c".into()), Some("WRONG".into()), None, "S").is_err());
        // Missing state is rejected.
        assert!(decide_callback(Some("c".into()), None, None, "S").is_err());
        // Missing/empty code is rejected even with a good state.
        assert!(decide_callback(None, Some("S".into()), None, "S").is_err());
        assert!(decide_callback(Some(String::new()), Some("S".into()), None, "S").is_err());
        // An OAuth error aborts.
        assert!(decide_callback(Some("c".into()), Some("S".into()), Some("access_denied".into()), "S").is_err());
    }
}
