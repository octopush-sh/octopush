# Releasing Octopush

Octopush ships as a **universal macOS `.dmg`** (Apple Silicon + Intel in one file)
with a signed **Tauri auto-updater** artifact. This document is the source of
truth for cutting a release. The Apple signing/notarization layer is **optional
and env-gated** — the pipeline produces a working (unsigned) build today and
becomes Gatekeeper-clean the moment the Apple Developer secrets are filled in,
with no code changes.

There are two ways to cut a release, sharing one build+publish implementation
(`scripts/release.mjs`):

- **Local, one command** — bumps versions, tags, pushes, builds, publishes.
- **CI (GitHub Actions)** — you tag; CI builds, signs, and publishes.

---

## What every release publishes

Each GitHub Release (`v<version>`) carries these assets:

| Asset | Purpose |
|---|---|
| `Octopush.dmg` | **Stable permalink** target. `octopush.sh/download` → `releases/latest/download/Octopush.dmg`. Byte-copy of the versioned DMG. |
| `Octopush_<version>_universal.dmg` | Versioned DMG, for archives / direct links to a specific version. |
| `Octopush.app.tar.gz` | Updater payload (the app, gzipped) the Tauri updater downloads. |
| `Octopush.app.tar.gz.sig` | Ed25519 signature of the payload (updater verifies it). |
| `latest.json` | Updater manifest: version, notes, `pub_date`, and per-arch `{signature, url}`. Both `darwin-aarch64` and `darwin-x86_64` point at the same universal payload. |

### The updater endpoint (host indirection)

`tauri.conf.json` → `plugins.updater.endpoints`:

```
1. https://octopush.sh/update/latest.json      ← preferred (host-portable)
2. https://github.com/octopush-sh/octopush/releases/latest/download/latest.json  ← fallback
```

`octopush.sh/update/latest.json` is a 302 redirect to the GitHub asset (see the
`octopush-web` repo: `vercel.json`). This indirection means the binaries can move
off GitHub later without breaking already-installed apps. The Tauri v2 updater
carries its signature **inline** in `latest.json`, so there is no separate `.sig`
URL to redirect.

The updater's public key is `plugins.updater.pubkey` in `tauri.conf.json`; it
must match the private key used at build time (`TAURI_SIGNING_PRIVATE_KEY`).

---

## Prerequisites

- **macOS** with Xcode command-line tools.
- **Rust** with both targets: `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.
- **`gh`** CLI, authenticated with a token that has `repo` scope.
- **Updater keypair** (REQUIRED — unsigned updater artifacts break in-app updates):
  ```
  npx @tauri-apps/cli signer generate --write-keys ~/.octopush-keys/updater_key --password ""
  ```
  The public key printed must be `plugins.updater.pubkey` in `tauri.conf.json`.
  (In CI, provide the private key as the `TAURI_SIGNING_PRIVATE_KEY` secret
  instead of the key file.)

---

## Local release — one command

```
npm run release -- 0.4.51
```

It will, in order: verify the tree is clean and on `main` → bump the version in
`package.json`, `Cargo.toml`, `tauri.conf.json` → build the universal bundle
(updater-signed; Apple-signed + notarized if secrets present) → verify the
sidecars are bundled → generate `latest.json` → commit, tag `v0.4.51`, push →
`gh release create` with all assets.

---

## CI release — tag and let Actions build

`.github/workflows/release.yml` runs on any `v*` tag (or manual dispatch) on a
`macos-14` runner:

1. Bump the version locally and land it on `main` (e.g. `npm version` or edit the
   three files), commit.
2. Tag and push:
   ```
   git tag v0.4.51 && git push origin main v0.4.51
   ```
3. Actions builds with `node scripts/release.mjs --ci`, which **skips** the
   version bump and commit/tag/push (the tag already exists) and publishes the
   release. Re-runs are idempotent (`gh release upload --clobber`).

---

## Apple signing & notarization (env-gated)

**The Apple Developer account does not exist yet.** Until it does, releases build
**unsigned** and the release notes include the one-time `xattr -cr` unblock.
`scripts/release.mjs` prints a loud warning on every unsigned build. Nothing
fails.

To flip to Gatekeeper-clean, provide these as environment variables (locally) or
repo secrets (CI). No code changes are needed.

**Signing** (one of):
- `APPLE_SIGNING_IDENTITY` — e.g. `"Developer ID Application: Your Name (TEAMID)"` (identity already in the keychain), **or**
- `APPLE_CERTIFICATE` (base64 of a `.p12`) + `APPLE_CERTIFICATE_PASSWORD` — imported into a temp keychain by Tauri.

**Notarization** (one of):
- `APPLE_ID` + `APPLE_PASSWORD` (an **app-specific** password) + `APPLE_TEAM_ID`, **or**
- `APPLE_API_ISSUER` + `APPLE_API_KEY` + `APPLE_API_KEY_PATH` (App Store Connect API key).

> **Gotcha (CI):** Tauri decides to codesign based on whether `APPLE_CERTIFICATE`
> / `APPLE_SIGNING_IDENTITY` are **defined**, not whether they're non-empty — and
> GitHub renders a missing secret as an empty string. Passing them straight
> through as workflow `env:` therefore makes the bundler try `security import`
> with an empty certificate and fail with *"failed to import keychain
> certificate"*. `.github/workflows/release.yml` routes them through
> `$GITHUB_ENV` and exports each one only when it carries a value. Keep it that
> way when editing the workflow.

When both signing and notarization creds are present, Tauri 2 signs, submits to
`notarytool`, and staples the ticket. `scripts/release.mjs` then verifies:
`codesign --verify --strict`, `xcrun stapler validate`, and `spctl -a -vv`
(the assessment a user's Mac performs on first launch). See
[`gtm-legitimacy.md`](gtm-legitimacy.md) for the enrollment runbook.

### Blocked-on-Apple checklist

When the Developer account lands:

1. Enroll; create a **Developer ID Application** certificate.
2. Export it as `.p12`, base64-encode it, add `APPLE_CERTIFICATE` +
   `APPLE_CERTIFICATE_PASSWORD` (or set `APPLE_SIGNING_IDENTITY` on a Mac that
   holds the cert). Add `APPLE_TEAM_ID`.
3. Add notarization creds (`APPLE_ID` + app-specific `APPLE_PASSWORD`, or the API
   key trio).
4. Cut a release; confirm `spctl -a -vv` reports **accepted**.
5. Remove the `xattr` note from the docs install page
   (`octopush-web`: search `REMOVE-AFTER-NOTARIZATION`).
6. Publish the Homebrew cask (see [`DISTRIBUTION.md`](DISTRIBUTION.md)).

---

## Sidecars

The bundle carries three sidecar binaries (declared in `tauri.conf.json`
`bundle.externalBin`, built by the `tauri:build:universal` npm script and staged
by `src-tauri/build.rs`):

- `octopush-pty-server` — out-of-process PTY daemon (terminals survive restarts).
- `octopush-mcp` — bundled MCP server exposing pipelines/roles/runs to external CLIs.
- `octopush-run-worker` — detached-run worker (Pro crews survive app quit).

`scripts/release.mjs` **fails the release** if any sidecar is missing or empty in
the built `.app`, before anything is tagged or published.
