# Octopush — Accounts & Subscriptions: Implementation Plan

> **Status:** Proposal · 2026-06-20 · branch `premium-features`
> **Companion doc:** [`premium-features-plan.md`](premium-features-plan.md) — *what* is free vs. paid. This doc is *how* we build accounts, billing, and entitlement enforcement.
> **Scope:** Octopush is a **Tauri 2 desktop app** (macOS‑first; React 19 frontend, Rust backend) with **no accounts and no billing today**. This adds: sign‑in, a paid subscription, and a way to verify "is this user entitled to feature X" — without breaking the local‑first, BYOK, offline‑friendly contract.

---

## 1. Goals & constraints

**Goals**
- Lightweight **accounts** (sign in / sign out / account settings).
- A **paid subscription** (Pro, later Team/Enterprise) purchasable from the desktop app.
- **Entitlement enforcement** for the gates defined in the premium plan (Direct‑runs cap, parallel runs, history sync, etc.), enforced where it matters — in the **Rust core**.
- **Reuse Clerk** for auth (the owner already runs Clerk in other apps).

**Hard constraints (from the product principles)**
1. **Free works offline and without an account.** Sign‑in is required only to *activate* Pro+, never to use Free locally.
2. **The user's API keys and local data never leave the device** as part of this work. Only the auth handshake and the entitlement check (and opt‑in history sync) touch the network.
3. **Graceful degradation:** if entitlement can't be verified (offline > grace period, server down), the app **falls back to Free** — it never hard‑locks.
4. **No secrets in the frontend.** Tokens live in the OS keychain; entitlement is verified in Rust.

---

## 2. Architecture decision (summary)

| Concern | Decision | Why (short) |
|---|---|---|
| **Auth** | **Clerk**, via **system‑browser OAuth 2.0 + PKCE + loopback redirect** | Reuses the owner's Clerk; Clerk acts as an OIDC/OAuth provider and ships an official CLI‑auth (PKCE + localhost) example. Tauri has only a *community* Clerk plugin, so we drive the standard OAuth flow ourselves rather than depend on it. |
| **Token storage** | **macOS Keychain** via the `keyring` crate | Native‑secure; **not** Tauri Stronghold (deprecated/removed in Tauri v3). |
| **JWT verification** | **`clerk-rs`** (JWKS) in the Rust core | Verify Clerk session/access JWTs server‑side‑style, in‑process; read identity + claims without any Next.js/middleware assumptions. |
| **Billing** | **Polar.sh** (Merchant of Record) | Buyers are **global indie devs**; an MoR handles worldwide VAT/sales‑tax + compliance (Stripe/Clerk Billing leave that on us). Polar is open‑source, developer‑first, has **native license keys** (device limits, expiry), lifecycle webhooks, lowest paid‑tier fees (3.4–3.8%), and runs on Stripe Connect. |
| **Entitlement source of truth** | **Phase 1:** Polar **license‑key activation** + cached signed snapshot. **Phase 2:** a tiny **entitlement service** that reconciles Clerk identity ↔ Polar subscription (webhooks) and mints **Ed25519‑signed entitlement JWTs**. | Phase 1 ships fast with **no custom backend**. Phase 2 gives clean signed entitlements + cross‑device sync. |
| **Enforcement** | A new **`entitlement.rs`** module in the Rust core; gates at `start_run`/`create_run`; frontend gating is **UX‑only**. | The client check is friction, not DRM; the meaningful gates live in Rust where runs actually start. |
| **Offline** | Cache last‑known‑good signed entitlement; **14‑day offline grace**, then degrade to Free. | Never nag on a plane; never hard‑lock. |

> **Alternatives we rejected for v1:** *Clerk Billing* (Beta API; makes us merchant‑of‑record → we'd owe global VAT) and *Stripe direct* (same tax burden + we'd bolt on Keygen for license keys). Both stay viable if buyers turn out to be ~90% US — see §10.

---

## 3. Authentication design

### 3.1 Flow (system browser + PKCE + loopback)

We never embed credentials in the webview. We open the user's **real browser** to Clerk's hosted sign‑in and capture the redirect on a transient `127.0.0.1` server using [`tauri-plugin-oauth`](https://github.com/FabianLars/tauri-plugin-oauth). (A custom `octopush://` scheme via the deep‑linking plugin is the fallback; loopback is preferred because some IdPs reject custom‑scheme redirect URIs.)

```
 ┌─────────┐     1. click "Sign in"         ┌──────────────────────┐
 │  React  │ ─────────────────────────────► │  Rust: auth::begin   │
 │ (front) │                                │  - gen PKCE verifier │
 └─────────┘                                │  - start loopback srv│
      ▲                                     │    on 127.0.0.1:PORT │
      │ 6. authStore.setSignedIn            │  - open system browser│
      │                                     └──────────┬───────────┘
      │                                                │ 2. open URL
      │                                     ┌──────────▼───────────┐
      │                                     │  System browser →     │
      │                                     │  Clerk hosted sign-in │
      │                                     └──────────┬───────────┘
      │                                        3. user authenticates
      │                                     ┌──────────▼───────────┐
      │  5. emit auth://signed-in           │  Clerk redirects to   │
 ┌────┴─────────────────────┐               │  127.0.0.1:PORT/cb     │
 │ Rust: auth::on_callback   │ ◄────────────┤  ?code=…&state=…       │
 │ - exchange code+verifier  │   4. captured └───────────────────────┘
 │   at Clerk token endpoint │
 │ - verify JWT via clerk-rs │
 │ - store tokens in Keychain│
 └───────────────────────────┘
```

1. **`auth::begin`** (new Rust command): generate a PKCE `code_verifier` + `code_challenge`, a random `state`, start the loopback server, and `tauri-plugin-shell`‑open the Clerk authorize URL (`redirect_uri=http://127.0.0.1:PORT/callback`, `response_type=code`, `code_challenge`, `state`, scopes).
2. User authenticates in the browser (passwords, OAuth social, MFA — all Clerk's UI; nothing for us to build).
3. Clerk redirects to the loopback with `?code&state`.
4. The loopback handler validates `state`, **exchanges the code + `code_verifier`** at Clerk's token endpoint for a session/access JWT (Clerk supports issuing **JWT access tokens** via OAuth applications). It serves a tiny "you can close this tab" page.
5. Rust **verifies the JWT** with `clerk-rs` against Clerk's JWKS, extracts `sub` (user id), email, and (if Clerk Billing is used later) `pla`/`fea` claims, **stores tokens in the Keychain**, and emits `auth://signed-in`.
6. The frontend `authStore` flips to signed‑in and refreshes entitlement.

**Sign‑out:** clear Keychain entries, drop the in‑memory session, emit `auth://signed-out`, revert entitlement to Free.

### 3.2 Token storage & refresh
- **Storage:** macOS Keychain via the `keyring` crate (key: `octopush.auth`). Never `localStorage`, never a plaintext file. (`tauri-plugin-stronghold` is **deprecated in Tauri v3** — do not use.)
- **Refresh:** Clerk session tokens are short‑lived. Cache a derived **entitlement** (longer‑lived, signed) so we don't need a live Clerk token for every gate check (see §5). Refresh the Clerk session on app focus when online; if refresh fails, rely on the cached entitlement within its grace window.

### 3.3 Rust verification
- Add `clerk-rs` (JWKS provider + validator) to `src-tauri/Cargo.toml`. Verify token signature, `exp`, issuer, and audience in‑process. No Next.js, no middleware — just JWKS verification, which `clerk-rs` is built for.

---

## 4. Billing design (Polar.sh)

### 4.1 Why Polar (recap)
Merchant of Record → **Polar handles global VAT/GST/sales‑tax registration + remittance**, fraud, and chargebacks. Open‑source, developer‑first, **native license keys** with device limits/expiry/quotas, Standard‑Webhooks lifecycle events, Stripe‑Connect underneath, and the lowest paid‑tier fees (3.4–3.8% on the $20/$100/$400 plans; 5%+50¢ free tier). For a desktop tool sold worldwide, the ~2% fee premium over raw Stripe is dwarfed by the **$5–15k/yr** of tax‑compliance work an MoR absorbs.

### 4.2 Products & purchase flow
- Create Polar products: **Pro (monthly/annual)**, later **Team (per‑seat)**.
- **Purchase from the desktop:** "Upgrade to Pro" → Rust opens the **Polar hosted checkout** URL in the system browser (same `shell.open` mechanism as auth), pre‑filled with the signed‑in user's email/Clerk id (as `customer_external_id` / metadata) so the subscription is tied to the Clerk identity.
- On success, Polar issues a **license key** (Phase 1) and fires `subscription.created`. The desktop returns to an "activating…" state and resolves entitlement (§5).

### 4.3 Webhooks & state (Phase 2 service)
- A minimal serverless **entitlement service** subscribes to Polar webhooks: `subscription.created/updated/active/canceled/revoked`. **Gate on `subscription.revoked`, not `canceled`** (canceled subs stay active until period end).
- It maps **Clerk `sub` ↔ Polar customer/subscription ↔ plan/features** and mints signed entitlements (§5). This is the only new server component, and it holds *no* code/keys — just identity↔subscription mappings.

---

## 5. Entitlement model

### 5.1 The object (single source of truth the client trusts)

```ts
// returned by the entitlement service / derived from a Polar license key
interface Entitlement {
  userId: string;            // Clerk sub
  plan: "free" | "pro" | "team" | "enterprise";
  features: string[];        // e.g. ["direct.unlimited","runs.parallel","history.sync"]
  limits: { directRunsPerMonth: number | null };  // null = unlimited
  iat: number;               // issued-at (unix)
  exp: number;               // short, e.g. iat + 7 days
}
// transported as an Ed25519-signed JWT; the desktop embeds the PUBLIC key.
```

### 5.2 How it's produced
- **Phase 1 (no backend):** the desktop activates a **Polar license key** (`POST /v1/customer-portal/license-keys/activate`, binds a device, returns benefits) and validates it (online) to derive `{plan, features, limits}`. A **locally signed snapshot** is cached for offline use (signed with a key we control, or we trust Polar's validation response + a short TTL).
- **Phase 2 (entitlement service):** the desktop calls `GET /entitlement` with its Clerk token; the service verifies the Clerk JWT, looks up the Polar subscription, and returns a **short‑lived Ed25519‑signed `Entitlement` JWT**. The desktop verifies the signature with the **embedded public key** and caches it.

### 5.3 How it's consumed (offline‑friendly)
- On sign‑in, app focus (when online), and a daily timer: fetch a fresh entitlement; cache it (Keychain or `settings.json`, signed).
- **Verification is offline:** the Rust core verifies signature + `exp` against the embedded public key — no network needed between refreshes.
- **Offline grace:** a cached entitlement is honored up to **14 days** past `exp` if the server is unreachable; beyond that, **degrade to Free** (do not lock). The grace window is shown in account settings ("Pro · verified 2 days ago").

### 5.4 Anti‑bypass posture (honest about limits)
- Sign entitlements **asymmetrically (Ed25519)**; the client only holds the **public** key, hard‑coded in the binary (never loaded from an editable file), so entitlements can't be forged.
- The meaningful gates are enforced **server‑adjacent** where possible (Phase 2 sync features need the service anyway). For purely local gates (Direct‑runs cap), accept that a determined user can patch a desktop binary — the goal is **friction for the 99%**, not unbreakable DRM. This matches how mature desktop dev tools treat offline licensing.

---

## 6. Enforcement in the codebase

### 6.1 New Rust module: `src-tauri/src/entitlement.rs`
- Holds the cached `Entitlement`, verifies its signature/exp, exposes:
  - `current() -> Entitlement` (cached or Free fallback),
  - `has_feature(key: &str) -> bool`,
  - `direct_runs_remaining() -> Option<u32>` (None = unlimited).
- Loaded into Tauri state (`state.rs`) alongside `AppState`.

### 6.2 Gate points (where the checks actually go)
- **Direct‑runs cap & parallel gate** — in `commands.rs::start_run` (and/or `create_run`): before spawning the orchestrator drive,
  - if `!has_feature("direct.unlimited")` and the **monthly run count** ≥ `limits.directRunsPerMonth`, return a typed `AppError::UpgradeRequired { feature, used, limit }`;
  - if `!has_feature("runs.parallel")` and another run is already executing in *any* workspace, return `AppError::UpgradeRequired { feature: "runs.parallel" }`. (Note: a single‑run‑per‑*workspace* guard already exists via `has_concurrent_run`; the parallel gate extends it across workspaces for Free.)
- **History retention / sync** — in the run‑persistence path and a future sync command, gated on `history.sync`.
- **Shared pipelines / org config (Team)** — gated when those commands land.
- **Monthly run counting** — a tiny `usage_counters` table (or a `COUNT(*)` over `runs` where `created_at >= start_of_month` and `status != 'draft'`). Local first; reconciled server‑side in Phase 2.

### 6.3 Frontend (UX‑only gating)
- `authStore` (new Zustand store): `{ user, plan, features, signIn(), signOut(), refreshEntitlement() }`, hydrated from new ipc commands.
- Read‑through `useEntitlement()` hook so components can show the right state, but **the frontend never decides entitlement** — it reflects what Rust reports and surfaces the upgrade nudge when Rust returns `UpgradeRequired`.
- **Paywall surfaces (Atelier voice, non‑nagging):**
  - Direct launcher shows a quiet **runs meter** ("18 of 25 runs this month") for Free, consistent with Octopush's existing honesty about spend.
  - Hitting the cap or a parallel run opens a tasteful **"Unlock the full crew"** sheet (`ModalShell`) → "Upgrade" → Polar checkout.
  - **Account pane** in Settings (new tab under "App"): signed‑in identity, plan, "verified N ago", Manage subscription (opens Polar customer portal), Sign out.

### 6.4 New Tauri commands (registered in `lib.rs`)
```
auth_begin_sign_in            // start OAuth (PKCE + loopback)
auth_sign_out
auth_status                   // { signedIn, email }
get_entitlement               // { plan, features, limits, verifiedAt, grace }
refresh_entitlement
open_checkout(plan)           // open Polar hosted checkout in browser
open_billing_portal           // open Polar customer portal
activate_license_key(key)     // Phase 1 activation path
direct_run_usage              // { used, limit } for the meter
```
Events: `auth://signed-in`, `auth://signed-out`, `entitlement://changed`.

### 6.5 Data model (`db.rs`)
- `account` (one row): `clerk_user_id, email, signed_in_at` (non‑secret cache; tokens live in Keychain).
- `entitlement_cache`: the signed entitlement blob + `verified_at` (or store in Keychain).
- `usage_counters`: `period (YYYY-MM), direct_runs` — or derive from `runs`.
- (Settings already persist to `~/.octopush/settings.json`; non‑secret auth/entitlement metadata can live there too — secrets always go to Keychain.)

---

## 7. Phased rollout

| Phase | Deliverable | Notes |
|---|---|---|
| **P0 · Scaffolding** | `entitlement.rs` returning a hard‑coded **Free** entitlement; `useEntitlement()` hook; `AppError::UpgradeRequired`; the runs meter UI reading a local count. | Ships the *gating structure* with everyone on Free — zero behavior change, fully testable. |
| **P1 · Accounts (Clerk)** | OAuth/PKCE + loopback sign‑in, Keychain storage, `clerk-rs` verification, Account pane (identity + sign out). | No billing yet; signing in does nothing but show your email. |
| **P2 · Billing (Polar) + activation** | Polar products, hosted‑checkout open‑in‑browser, **license‑key activation**, entitlement derived from the key with offline‑cached snapshot. **Turn on the Direct‑runs gate.** | First revenue. Backend‑light. |
| **P3 · Entitlement service** | Serverless `GET /entitlement` reconciling Clerk↔Polar via webhooks; **Ed25519‑signed entitlement JWTs**; embedded public key in the binary; 14‑day offline grace. | Clean signed entitlements; sets up sync. |
| **P4 · Pro features** | Parallel/background runs gate, unlimited history + **opt‑in encrypted history sync**. | The Pro value beyond "unlimited runs". |
| **P5 · Team** | Per‑seat Polar, shared pipeline/role libraries, central billing, team analytics. | |
| **P6 · Enterprise / Managed inference (later)** | SSO/SAML, self‑host of the entitlement+sync service, optional managed‑inference proxy (cost+margin). | Out of scope for the first releases. |

**Recommended first PR after this plan:** P0 — it's pure structure (new module, error type, hook, meter), no auth/billing dependencies, and de‑risks everything downstream.

---

## 8. Security & privacy

- **Local‑first preserved:** Free works fully offline and **without signing in**. Nothing about this work uploads code, prompts, keys, or run data. Only the OAuth handshake, the entitlement check, and **opt‑in** history sync use the network.
- **Secrets:** OS Keychain only. The embedded entitlement‑verification key is **public** (signing key stays server‑side).
- **Tokens:** short‑lived Clerk tokens; longer‑lived but **signed** entitlements with grace.
- **Telemetry:** unchanged — none. The entitlement check sends only the Clerk token (identity), not usage.
- **Threat model honesty:** a fully offline client gate is ultimately patchable; we optimize for friction + a clean upgrade path, and keep truly sensitive capability (sync, team) behind the service.

---

## 9. Effort estimate (rough)

| Phase | Backend (Rust) | Frontend | Service / infra | Total |
|---|---|---|---|---|
| P0 | S | S | — | **~2–3 d** |
| P1 | M (OAuth, keychain, clerk‑rs) | M (sign‑in, account pane) | — | **~1–1.5 wk** |
| P2 | M (Polar, license activation, gate) | M (checkout, paywall, meter) | S (Polar setup) | **~1.5 wk** |
| P3 | S (verify signed JWT) | S | M (entitlement service + webhooks) | **~1–1.5 wk** |
| P4 | M (parallel gate, sync) | M (sync UI) | M (sync store) | **~2 wk** |

(Team/Enterprise/managed‑inference are separate later efforts.)

---

## 10. Alternatives (kept on the table)

- **Clerk + Clerk Billing** — single vendor, fastest to wire, plan/features as JWT `pla`/`fea` claims (no custom backend). **But** Clerk Billing is **Beta**, runs on *our* Stripe, and makes **us the merchant of record → we owe worldwide VAT** (Stripe Tax only calculates; we remit). Effective ~4.3% + $0.30 + our tax‑filing cost. **Choose this only if buyers are ≥~90% US.**
- **Clerk + Stripe direct** — lowest %, max control; same tax burden; must bolt on Keygen for desktop license keys.
- **Keygen** instead of Polar license keys — strongest offline/cryptographic licensing if Polar's keys prove too limited; more to integrate.

If we later confirm a mostly‑US buyer base, switching the billing layer from Polar to Clerk Billing is **localized** (the entitlement abstraction in §5 means the client doesn't care who bills).

---

## 11. Risks & open questions

1. **Community‑maintained Clerk‑on‑Tauri.** We drive the standard OAuth flow ourselves (not the community plugin) to limit dependency risk, but Clerk has no first‑class desktop SDK — budget for owning the integration.
2. **Clerk JWT access‑token issuance** for the desktop OAuth flow — verify the exact token shape and lifetimes against current Clerk docs during P1 (Clerk added OAuth JWT access tokens in early 2026).
3. **Polar roadmap** — Polar is young; confirm license‑key API stability and MoR coverage for our target regions during P2. (Lemon Squeezy is a fallback MoR but is mid‑merger into Stripe Managed Payments — more uncertain.)
4. **Free Direct‑runs cap number** — set from real telemetry once the meter ships (P0/P2).
5. **Do we want a free account at all (for sync) or only paid accounts?** Recommend a free Clerk account is *optional* and only needed for sync/purchase, never for local use.
6. **Refunds/disputes** — handled by the MoR (Polar), but define the in‑app messaging when an entitlement is revoked (degrade to Free gracefully, with a clear notice).

---

## 12. Research basis (cited)

The decisions above rest on two 2025–2026 research passes (auth/billing and pricing). Load‑bearing, independently‑verified facts:

**Clerk / auth on desktop**
- Clerk officially supports web + mobile/Expo/native; **Tauri is community‑plugin only**, no official desktop SDK — clerk.com/docs.
- Recommended native pattern = **system browser + OAuth/PKCE + redirect capture** (loopback or deep link); Clerk ships a CLI‑auth PKCE+localhost example. `tauri-plugin-oauth` (loopback) / Tauri deep‑linking plugin for capture.
- **Rust verification:** `clerk-rs` (JWKS) verifies Clerk JWTs in‑process — github.com/DarrenBaldwin07/clerk-rs; clerk.com/docs manual‑jwt‑verification.
- **Token storage:** macOS Keychain via `keyring`; **Tauri Stronghold is deprecated/removed in v3** — v2.tauri.app/plugin/stronghold, tauri discussion #7846.

**Billing / entitlement**
- **Clerk Billing** is **Beta**, runs on **your own Stripe**, **+0.7%** on top of Stripe (~4.3% all‑in), **you remain merchant of record** (owe global VAT) — clerk.com/docs/guides/billing/overview, clerk.com/pricing. Plan/features available as session‑token claims (`pla`/`fea`) + `has({plan/feature})`.
- **Merchant‑of‑Record comparison:** Stripe (not MoR; you remit tax), Paddle (MoR, 5%+$0.50), Lemon Squeezy (MoR, Stripe‑owned, license API, merger uncertainty), **Polar** (MoR, open‑source, **native license keys** w/ device limits, 3.4–3.8% paid tiers, Stripe Connect) — paddle.com/pricing, polar.sh/resources/pricing, polar.sh/docs/features/benefits/license-keys, techcrunch.com Stripe×Lemon‑Squeezy.
- **Why MoR for us:** Stripe Tax only *calculates*; non‑EU sellers owe **EU VAT from the first euro**; tax compliance commonly **$5–15k/yr** — an MoR absorbs it for ~2% more — stripe.com/tax, MoR‑vs‑Stripe analyses.
- **Entitlement enforcement patterns:** asymmetric‑signed entitlements/license files verified offline + periodic online re‑check + **offline grace**; hard‑code account id + public key into the binary; treat the client check as friction — keygen.sh offline/timed licensing, cryptographic license files.

**Pricing landscape (informs the gates)**
- Industry shifted to **dollar/credit‑denominated usage**; **agentic/background features and teams/SSO/privacy are the near‑universal paywalls**; **core editor + BYOK + local models are kept free** (Zed/Cline/Aider). **Warp** is the precedent for charging a **platform fee even under BYOK** ("not free for us to run our agent harness"). Individual **$20** modal price; teams **~$40/seat**. — cursor.com/pricing, github.com/features/copilot/plans, zed.dev/pricing, warp.dev/pricing, and the per‑tool comparison in the pricing research.

> The two full research reports (with complete source lists) were produced during this planning pass and inform every cited claim here.

---

## 13. TL;DR

Reuse **Clerk** for sign‑in via the **system‑browser OAuth/PKCE + loopback** pattern, verify tokens in Rust with **`clerk-rs`**, store them in the **Keychain**. Bill through **Polar** (Merchant of Record) so we don't take on worldwide tax. Represent access as a small **signed `Entitlement`** the Rust core verifies offline with a 14‑day grace, and enforce the gates at **`start_run`** and the sync paths — frontend gating is cosmetic. Ship it in phases: **P0 structure → P1 accounts → P2 Polar + the Direct‑runs gate → P3 signed entitlements → P4 Pro features**. Start with **P0** — pure gating scaffolding, zero behavior change.
