# Distributing Octopush

How Octopush reaches users, and how each channel activates. For the mechanics of
*building* a release, see [`RELEASING.md`](RELEASING.md).

## Channels

| Channel | Status | Gate |
|---|---|---|
| Direct download (`octopush.sh/download` → GitHub release `Octopush.dmg`) | **Live path, needs first release** | Publish `v<version>` |
| In-app auto-update (Tauri updater) | **Live path, needs first release** | Publish `latest.json` |
| Homebrew cask (`brew install --cask octopush-sh/tap/octopush`) | **Cleared to publish** | Create the `octopush-sh/homebrew-tap` repo |

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

### 3. Homebrew cask — cleared to publish

The notarization gate is cleared (v0.4.63 onward is signed + notarized), so a
cask install now lands an app that opens cleanly. A ready-to-publish tap is
staged at [`packaging/homebrew-tap/`](../packaging/homebrew-tap/), with a real
`version` and `sha256` already filled in.

**To ship it:**
1. Create the public repo `octopush-sh/homebrew-tap` (the `homebrew-` prefix is
   required for `brew tap octopush-sh/tap` to resolve).
2. Copy `packaging/homebrew-tap/Casks/octopush.rb` to `Casks/octopush.rb` at its
   root.
3. Announce `brew install --cask octopush-sh/tap/octopush`.
4. On each later release, refresh the cask's `version` + `sha256`.

## Platform scope

macOS only (Apple Silicon + Intel, one universal `.dmg`). No Windows/Linux build
is published today despite `bundle.targets: "all"` in `tauri.conf.json`.

## First-launch experience by signing state

| State | What the user sees | Status |
|---|---|---|
| Unsigned (up to v0.4.62) | "Apple could not verify…" on first open | Historical — those builds needed a one-time `xattr -cr` |
| **Signed + notarized (v0.4.63 onward)** | **Opens cleanly on a plain double-click** | **Current.** Verified per release with `codesign --verify`, `xcrun stapler validate` and `spctl -a -vv` |
