# Releasing Octopush

Octopush ships as a **universal macOS `.dmg`** (Apple Silicon + Intel in one file)
with a signed **Tauri auto-updater** artifact. This document is the source of
truth for cutting a release. Since **v0.4.63** every release is also signed with
an Apple Developer ID certificate and **notarized by Apple**, so it installs with
a plain double-click. That layer stays env-gated: without the `APPLE_*` secrets
the pipeline still produces a working (unsigned) build, with no code changes.

**Releases go beta first, always** (VISION.md §8). Every tag `vX.Y.Z` is
published as a GitHub **prerelease** on the beta channel; the owner **promotes**
a beta to stable. See [Channels and promotion](#channels-and-promotion).

There are three ways to cut a release, sharing one build+publish implementation
(`scripts/release.mjs`) — all of them beta-first:

- **Nightly beta routine** — `scripts/routines/release-beta.sh` on the owner's
  Mac opens and merges a release PR and pushes the tag; CI publishes.
- **CI (GitHub Actions)** — you tag; CI builds, signs, and publishes.
- **Local, one command** — bumps versions, tags, pushes, builds, publishes.

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

### Release notes

When `whats-new/<version>/notes.md` exists (written by
`node scripts/whats-new.mjs collect <version>`, see [`WHATS-NEW.md`](WHATS-NEW.md) §5),
it is the top of the GitHub release body (followed by the install / notarization
text) and — trimmed to 4000 characters at a line boundary, ending in
"… full notes on GitHub" — the `latest.json` `notes` the in-app update alert
shows. Without it, the notes fall back to the generic `Octopush <version>` text.

---

## Channels and promotion

| Channel | Manifest the app reads | What it holds |
|---|---|---|
| **Beta** | `releases/download/beta-channel/latest.json` (via `octopush.sh/update/beta.json`) | The newest release, beta or stable |
| **Stable** | `releases/latest/download/latest.json` (via `octopush.sh/update/latest.json`) | The newest **promoted** release |

- **Publishing (beta).** `scripts/release.mjs` defaults to `--channel beta`
  (`release.yml` passes `--ci --channel beta`): `gh release create … --prerelease
  --latest=false`, so the release never becomes GitHub "latest" and the stable
  manifest and the `octopush.sh/download` DMG don't move. Its `latest.json` is
  then uploaded (`--clobber`) to the moving **`beta-channel`** release — a
  prerelease titled *Beta channel manifest*, created on first use, whose only
  asset is that manifest. The beta manifest never moves backwards: a re-run of
  an older version leaves a newer manifest alone.
- **`--channel stable`** publishes a full release directly (the pre-channel
  behaviour) and refreshes `beta-channel` too, so beta users never see an older
  version than stable. Use it only for emergencies; promotion is the normal path.
- **Promoting.** `.github/workflows/promote.yml` (owner-only, `workflow_dispatch`):
  ```
  gh workflow run promote.yml -f version=0.4.90
  ```
  It checks that `v<version>` exists, is a prerelease, carries all five assets and
  that its `latest.json` reports that version; refuses a version older than (or
  equal to) the current stable; runs `gh release edit v<version>
  --prerelease=false --latest`; and confirms `releases/latest/download/latest.json`
  now reports the version. Answering `promote <version>` in the daily ideas digest
  (VISION.md §9) dispatches exactly this workflow.

  **Owner-only is enforced, once set up:** the job runs in the `stable` environment.
  Repo → Settings → Environments → New environment `stable` → *Required reviewers*:
  you (leave "prevent self-review" off so your own dispatch works); and Settings →
  Secrets and variables → Actions → *Variables* → `OCTOPUSH_OWNER_LOGIN` = your login.
  Every promotion — yours or the digest's — then waits for your one-tap approval
  (GitHub emails and notifies you), and the workflow refuses to run at all if the
  environment isn't protected that way.
- **Release builds are main-only.** `release.yml` refuses a tag whose commit is not
  on `main` before any secret is loaded, refuses a tag that doesn't match
  `tauri.conf.json`, runs one release at a time, and never re-uploads assets over a
  release that is already stable.
- Which manifest an installed app reads is chosen in the app (Settings › About ›
  Update channel); `tauri.conf.json`'s updater endpoints are the stable default.

---

## Nightly beta (the release routine)

`scripts/routines/release-beta.sh` runs as an Octopush Routine on the owner's Mac
every day at 05:00 ([`ROUTINES.md`](ROUTINES.md)):

- **`check`** fires only when `origin/main` has commits since the latest `v*` tag
  that aren't just a release bump, CI is green on main's head, and no `release`
  workflow run is in progress.
- **`run`** computes the next patch version, and in a temporary worktree of
  `origin/main`: creates `release/v<next>`, runs `npm ci`, `node
  scripts/whats-new.mjs collect <next> --since v<prev>`, `npm run clips:record --
  <next>` when that script exists (optional — a failure is logged and skipped),
  bumps `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` and the
  `octopush` entry of `src-tauri/Cargo.lock` (`node scripts/release-lib.mjs bump`),
  commits `chore: release v<next>`, pushes, opens a PR labelled `release`, waits
  for CI (≤ 45 min), merges it (merge commit, pinned to the head sha), and pushes
  the annotated tag `v<next>` on the merge commit. `release.yml` then publishes the beta.
- On any failure it stops, leaves no tag behind, and comments on and closes the
  PR. Re-running is safe: an open PR is reused, and a release that merged but
  never got its tag is only tagged.

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
npm run release -- 0.4.51                    # beta (default)
npm run release -- 0.4.51 --channel stable   # straight to stable — emergencies only
```

Manual releases are beta-first too: without `--channel stable` the result is a
prerelease you promote with `promote.yml`. It will, in order: verify the tree is clean and on `main` → bump the version in
`package.json`, `Cargo.toml`, `tauri.conf.json` → build the universal bundle
(updater-signed; Apple-signed + notarized if secrets present) → verify the
sidecars are bundled → generate `latest.json` → commit, tag `v0.4.51`, push →
`gh release create` with all assets → refresh `beta-channel/latest.json`.

---

## CI release — tag and let Actions build

`.github/workflows/release.yml` runs on any `v*` tag (or manual dispatch) on a
`macos-15` runner:

1. Bump the version locally and land it on `main` (e.g. `npm version` or edit the
   three files), commit.
2. Tag and push:
   ```
   git tag v0.4.51 && git push origin main v0.4.51
   ```
3. Actions builds with `node scripts/release.mjs --ci --channel beta`, which **skips** the
   version bump and commit/tag/push (the tag already exists) and publishes the
   release as a beta prerelease. Re-runs are idempotent (`gh release upload --clobber`).
4. Promote it when it's good: `gh workflow run promote.yml -f version=0.4.51`.

Prefer landing the bump through a PR (as the nightly routine does) to pushing to
`main` directly.

---

## Apple signing & notarization (env-gated)

**Active since v0.4.63.** Releases are signed with a Developer ID certificate and
notarized by Apple, and install with a plain double-click. The six `APPLE_*`
secrets are set in the repo, so CI releases are Gatekeeper-clean by default.

The mechanism stays env-gated: if these are ever absent (a fork, a local build
without them), the release builds **unsigned**, `scripts/release.mjs` prints a
loud warning, and the notes fall back to the one-time `xattr -cr` unblock.
Nothing fails.

The credentials, for reference — as environment variables locally or repo
secrets in CI:

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

### How this was set up (done — v0.4.63)

1. ✅ Enrolled; created a **Developer ID Application** certificate under the
   **G2** Sub-CA. *(Pick G2, not "Previous Sub-CA" — the latter's certificates
   expire 2027-02-01 regardless of when you create them.)*
2. ✅ Exported as `.p12`, base64-encoded into `APPLE_CERTIFICATE`, with
   `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` and `APPLE_TEAM_ID`.
3. ✅ Notarization creds: `APPLE_ID` + app-specific `APPLE_PASSWORD` +
   `APPLE_TEAM_ID`.
4. ✅ v0.4.63 cut; `spctl -a -vv` reports **accepted**.
5. ✅ The `xattr` note removed from the docs install page (`octopush-web`).
6. ⏳ Homebrew cask — cleared to publish, needs the tap repo created. See
   [`DISTRIBUTION.md`](DISTRIBUTION.md).

**Certificate renewal:** the Developer ID Application certificate expires in
2031. Renewing means repeating steps 1–2 and refreshing the two certificate
secrets; nothing else changes.

**Validating notarization creds without burning a build** — worth doing before
any credential change:

```sh
xcrun notarytool history --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific>"
```

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
