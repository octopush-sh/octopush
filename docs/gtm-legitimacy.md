# GTM legitimacy — Apple signing + GitHub/Google login

Two things stand between "deep product" and "installs without friction / signs in like a real app":

1. **macOS Developer-ID signing + notarization** — kills the "unidentified developer / app is damaged" Gatekeeper warning and the `xattr -cr` workaround.
2. **GitHub / Google login** — one-click social sign-in instead of only email.

Both are **credential-gated**: the *code/config side is already wired* — what remains needs **your own Apple and OAuth accounts**. This doc is the runbook. Where a step needs you, it's marked **⛳ you**.

---

## 1. macOS Developer-ID signing + notarization

### Already wired (no action needed)

- `scripts/release.mjs` is **env-driven**: the build spawn already forwards your whole environment to `tauri build`, and Tauri 2 signs + notarizes + staples natively when the Apple env vars are present. The script now:
  - detects the signing posture and prints whether the build is unsigned / signed / notarized,
  - verifies the signature (`codesign --verify`) and the stapled ticket (`xcrun stapler validate`) after the build,
  - **drops the `xattr` unblock from the GitHub release notes automatically** once the build is notarized (an unsigned build keeps it).
- No `tauri.conf.json` change is required: `bundle.macOS.hardenedRuntime` already defaults to `true`, and the signing identity is read from the environment. Our subprocess model (spawning `claude` / `bash` / `sandbox-exec`, bundling the Rust sidecars) needs **no custom entitlements** — hardened runtime doesn't block spawning child processes, and WKWebView's JIT runs in a separate system-signed process.

### ⛳ You — one-time Apple setup

1. **Enroll in the Apple Developer Program** — <https://developer.apple.com/programs/> (~$99/yr). This is the hard gate; nothing below works without it.
2. **Create a "Developer ID Application" certificate** (this is the cert for apps distributed *outside* the Mac App Store):
   - Easiest: Xcode → **Settings → Accounts → [your team] → Manage Certificates → + → Developer ID Application**. It lands in your login keychain.
   - Or: Keychain Access → Certificate Assistant → *Request a Certificate from a CA* (save to disk) → developer.apple.com → **Certificates → + → Developer ID Application** → upload the CSR → download + double-click to install.
3. **Find your signing identity string and Team ID:**
   ```bash
   security find-identity -v -p codesigning
   # → "Developer ID Application: Your Name (ABCDE12345)"   ← the (ABCDE12345) is your Team ID
   ```
4. **Create a notarization credential** (pick one):
   - **App-specific password** (simplest): <https://appleid.apple.com> → *Sign-In and Security → App-Specific Passwords → +*. You'll use your Apple ID email + this password.
   - **App Store Connect API key** (better for repeat runs): App Store Connect → *Users and Access → Integrations → App Store Connect API → +*. Download the `.p8` once; note the **Key ID** and **Issuer ID**.

### ⛳ You — cut a signed release

Export the env, then release exactly as before. With an app-specific password:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (ABCDE12345)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"   # the app-specific password
export APPLE_TEAM_ID="ABCDE12345"

npm run release -- <version>
```

…or with an App Store Connect API key (instead of the three `APPLE_ID/PASSWORD/TEAM_ID` lines):

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (ABCDE12345)"
export APPLE_API_ISSUER="<issuer-uuid>"
export APPLE_API_KEY="<key-id>"
export APPLE_API_KEY_PATH="$HOME/.appstoreconnect/AuthKey_<key-id>.p8"

npm run release -- <version>
```

The script prints `Apple Developer-ID signing + notarization: ON` at the top and `Notarization ticket stapled to Octopush.app` near the end (Tauri staples the `.app`; the DMG is signed but carries the notarized app inside). The GitHub release notes will omit the `xattr` step. That first notarized build is the visible win — a `.dmg` whose app opens clean on any Mac.

> **Tip:** put the `export` lines in a private, git-ignored file (e.g. `~/.octopush-keys/apple.env`) and `source` it before releasing — never commit them.

### Known risk (first notarized build only)

Notarization requires **every** Mach-O in the bundle to be Developer-ID-signed with hardened runtime — that includes the three Rust sidecars (`octopush-pty-server`, `octopush-mcp`, `octopush-run-worker`). Tauri 2 signs bundled `externalBin` sidecars as part of the app signing, so this should just work. If notarization rejects with a "not signed with a valid Developer ID" / "hardened runtime" error naming a sidecar, the fix is to sign the sidecars explicitly before bundling; tell me and I'll add that step to the release script (it's a known, small addition — deferred only because it's untestable without the cert).

---

## 2. GitHub / Google login

### Already built (no code needed)

Octopush's auth is a **native OAuth 2.0 Authorization-Code + PKCE loopback flow** against **Clerk** (see `src-tauri/src/auth.rs`): the app opens Clerk's **hosted** authorize page in your system browser and captures the callback on `http://127.0.0.1:8976/callback`; the session lives in the OS keychain. Because the sign-in page is *hosted by Clerk*, **any social provider you enable in the Clerk dashboard appears automatically** — no app change, no release.

### ⛳ You — enable the providers (Clerk dashboard)

1. **GitHub** — create a GitHub OAuth App: GitHub → *Settings → Developer settings → OAuth Apps → New OAuth App*. Set the callback to the URL Clerk shows you (Clerk proxies the OAuth handshake — the callback is Clerk's, not our loopback). Copy the **Client ID + Client Secret**.
2. **Google** — create an OAuth client: Google Cloud Console → *APIs & Services → Credentials → Create Credentials → OAuth client ID → Web application*. Add the redirect URI Clerk shows you. Copy the **Client ID + Client Secret**.
   > **This is very likely why Google sign-in errors today.** Production Clerk does **not** ship Google's shared dev credentials, so without your own client it fails with `Missing required parameter: client_id` (a 400). Creating the client above and pasting it into Clerk's Google connection fixes it — no app change.
3. **Clerk dashboard** → *User & Authentication → Social Connections* → enable **GitHub** and **Google**, pasting each Client ID/Secret. (Clerk also offers shared dev credentials for testing, but production should use your own OAuth apps.)
4. **Confirm the loopback redirect** is allowed on the Clerk OAuth application: `http://127.0.0.1:8976/callback` must be an allowed redirect URI (`auth.rs:70`, `LOOPBACK_PORT=8976`).

That's it — next time a user clicks **Sign in**, Clerk's page shows "Continue with GitHub / Google" alongside email. No new build required.

### Optional (later, code — only if you want it)

Today sign-in is a single **"Sign in"** button that opens the browser (`AccountPane.tsx`). If you'd rather show native **"Continue with GitHub / Google"** buttons *inside* the app (deep-linking straight to that provider), that's a code change — it needs a custom `octopush://` URL scheme (not registered today; `billing.rs:18` notes the same gap). Not required for the providers to work; say the word and I'll scope it.

---

## Summary — who does what

| Task | Code/config (done) | Needs your account |
| --- | --- | --- |
| Apple signing + notarization | release.mjs env-driven, verify + conditional notes ✅ | Developer Program, Developer-ID cert, Team ID, notarization cred |
| GitHub login | nothing (Clerk hosted) ✅ | GitHub OAuth App → Clerk |
| Google login | nothing (Clerk hosted) ✅ | Google OAuth client → Clerk |
| Native provider buttons (optional) | not started | — (custom URL scheme; ask if wanted) |

### Related legitimacy item (not in this pass)

The post-payment / support email currently uses a personal Gmail — the most visible "hobby" tell after Gatekeeper. Cheap fix when you're ready: a custom-domain inbox (e.g. Zoho free tier or Porkbun forwarding → `support@octopush.sh`), updated in **Dodo's** support-email setting and the landing's legal config. No app code. Flag it and I'll help wire the copy.
