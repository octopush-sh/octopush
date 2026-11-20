# Distributing Octopush

How Octopush reaches users, and how each channel activates. For the mechanics of
*building* a release, see [`RELEASING.md`](RELEASING.md).

## Channels

| Channel | Status | Gate |
|---|---|---|
| Direct download (`octopush.sh/download` → GitHub release `Octopush.dmg`) | **Live path, needs first release** | Publish `v<version>` |
| In-app auto-update (Tauri updater) | **Live path, needs first release** | Publish `latest.json` |
| Homebrew cask (`brew install --cask octopush-sh/tap/octopush`) | **Published on promotion** | The first promotion after the Octopush Cycle app can write to `octopush-sh/homebrew-tap` |

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

### 3. Homebrew cask — published on every promotion

The notarization gate is cleared (v0.4.63 onward is signed + notarized), so a
cask install lands an app that opens cleanly. The tap is the public repo
[`octopush-sh/homebrew-tap`](https://github.com/octopush-sh/homebrew-tap) (the
`homebrew-` prefix is what lets `brew tap octopush-sh/tap` resolve), with one
file, `Casks/octopush.rb`. Nobody edits it by hand:

- **The template** is [`packaging/homebrew-tap/Casks/octopush.rb`](../packaging/homebrew-tap/Casks/octopush.rb)
  in this repo, the one copy anyone edits. Its `version` and `sha256` are
  placeholders.
- **On promotion**, `.github/workflows/promote.yml`'s `homebrew-tap` job runs
  after the `promote` job succeeded. It reads the promoted release's
  `Octopush.dmg` sha256 (the asset's `digest`; if the release reports none, it
  downloads the DMG and hashes it), renders the template with that version and
  sha256 (`scripts/homebrew-cask.mjs`), checks the result with `brew style` and
  an offline `brew audit --cask --strict` (`scripts/homebrew-cask-check.sh`),
  and pushes it to the tap's `main` with an Octopush Cycle app token limited to
  that one repo (contents: write). On the empty tap the push is the first
  commit and creates `main`; after that it updates the cask in place, does
  nothing when the cask is already current, and never moves the tap back to an
  older version.
- **Betas never touch the tap.** Tags publish prereleases; only a promotion
  runs the job, and it refuses a release that is still a prerelease.
- **A tap failure never undoes the promotion.** The release is already stable
  when the job runs. A failure is marked in the run's summary ("Homebrew tap
  NOT updated"); re-running the `homebrew-tap` job retries it.
- **CI** renders the template with dummy values and runs the same checks on
  every pull request (`ci.yml` → `homebrew-cask`, macOS), so the template
  can't rot between promotions.

**Owner prerequisite:** the Octopush Cycle GitHub App must be installed on
`octopush-sh/homebrew-tap` with Contents read & write. Until then the job fails
at "Tap token" and the summary says so.

## Platform scope

macOS only (Apple Silicon + Intel, one universal `.dmg`). No Windows/Linux build
is published today despite `bundle.targets: "all"` in `tauri.conf.json`.

## First-launch experience by signing state

| State | What the user sees | Status |
|---|---|---|
| Unsigned (up to v0.4.62) | "Apple could not verify…" on first open | Historical — those builds needed a one-time `xattr -cr` |
| **Signed + notarized (v0.4.63 onward)** | **Opens cleanly on a plain double-click** | **Current.** Verified per release with `codesign --verify`, `xcrun stapler validate` and `spctl -a -vv` |
