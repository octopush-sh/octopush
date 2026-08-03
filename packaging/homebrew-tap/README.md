# octopush-sh/homebrew-tap

This folder is a **ready-to-publish** Homebrew tap for Octopush. It is staged
here in the app repo; when the app is notarized, copy it into a new public repo
named **`octopush-sh/homebrew-tap`** (the `homebrew-` prefix is required — it's
what lets `brew tap octopush-sh/tap` resolve).

## ⚠️ Do not publish until the app is notarized

`brew install --cask` respects Gatekeeper. Installing an un-notarized app via a
cask lands a quarantined `Octopush.app` and the user hits an "Apple could not
verify" wall on first launch — a worse first impression than a manual download
with documented `xattr` steps. Publish this tap only after a released build
passes `spctl -a -vv` (see [`docs/RELEASING.md`](../../docs/RELEASING.md)).

## Publishing steps (when notarized)

1. Create the public repo `octopush-sh/homebrew-tap`.
2. Copy `Casks/octopush.rb` into it at the repo root path `Casks/octopush.rb`.
3. For the release you're publishing, set `version` and the real `sha256`:
   ```
   shasum -a 256 Octopush.dmg
   ```
   (Replace `sha256 :no_check` — a public tap must verify integrity.)
4. Commit and push. Users then install with:
   ```
   brew install --cask octopush-sh/tap/octopush
   ```
5. On each subsequent release, bump `version` + `sha256` in the tap (a tiny
   automation step you can fold into `scripts/release.mjs` later — out of scope
   until the tap exists).

## Layout

```
Casks/
  octopush.rb   the cask definition
README.md       this file
```
