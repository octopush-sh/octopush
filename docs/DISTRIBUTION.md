# Distributing Octopush

How Octopush reaches users, and how each channel activates. For the mechanics of
*building* a release, see [`RELEASING.md`](RELEASING.md).

## Channels

| Channel | Status | Gate |
|---|---|---|
| Direct download (`octopush.sh/download` → GitHub release `Octopush.dmg`) | **Live path, needs first release** | Publish `v<version>` |
| In-app auto-update (Tauri updater) | **Live path, needs first release** | Publish `latest.json` |
| Homebrew cask (`brew install --cask octopush-sh/tap/octopush`) | **Staged, gated on notarization** | Notarize + create tap repo |

### 1. Direct download

`octopush.sh/download` is a server-side 302 to
`github.com/octopush-sh/octopush/releases/latest/download/Octopush.dmg`. Every
release must publish an asset named exactly `Octopush.dmg` (the release script
does this). The redirect lives in the `octopush-web` repo (`api/download.ts` +
`vercel.json`) and logs the `?src=` channel tag — the only top-of-funnel
measurement, since the app ships zero telemetry.

### 2. In-app auto-update

Installed apps check `octopush.sh/update/latest.json` (redirect → the GitHub
release `latest.json`), verify the Ed25519 signature, and update in place. See
[`RELEASING.md`](RELEASING.md) → "The updater endpoint".

### 3. Homebrew cask — **do not publish until notarized**

A ready-to-publish tap is staged at
[`packaging/homebrew-tap/`](../packaging/homebrew-tap/) (cask +
publishing instructions). `brew install --cask` respects Gatekeeper, so shipping
an un-notarized cask lands a quarantined app and users hit an "Apple could not
verify" wall on first launch. Publish the tap only after a released build passes
`spctl -a -vv` (accepted).

**Activation, when the Apple Developer account lands:**
1. Notarize a release (fill the `APPLE_*` secrets — see `RELEASING.md`).
2. Create the public repo `octopush-sh/homebrew-tap`.
3. Copy `packaging/homebrew-tap/Casks/octopush.rb` into it; set the real
   `version` + `sha256` (`shasum -a 256 Octopush.dmg`).
4. Announce `brew install --cask octopush-sh/tap/octopush`.

## Platform scope

macOS only (Apple Silicon + Intel, one universal `.dmg`). No Windows/Linux build
is published today despite `bundle.targets: "all"` in `tauri.conf.json`.

## First-launch experience by signing state

| State | What the user sees | Mitigation |
|---|---|---|
| Unsigned (today) | "Apple could not verify… " on first open | Docs `xattr -cr` step + `<!-- REMOVE-AFTER-NOTARIZATION -->` note on the install page |
| Signed + notarized (goal) | Opens cleanly | Remove the `xattr` note; publish the cask |
