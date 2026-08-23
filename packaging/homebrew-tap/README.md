# octopush-sh/homebrew-tap

This folder is a **ready-to-publish** Homebrew tap for Octopush. It is staged
here in the app repo; when the app is notarized, copy it into a new public repo
named **`octopush-sh/homebrew-tap`** (the `homebrew-` prefix is required — it's
what lets `brew tap octopush-sh/tap` resolve).

## ✅ Cleared to publish

The notarization gate is cleared. As of **v0.4.63** Octopush is signed with an
Apple Developer ID certificate and notarized by Apple, verified with
`spctl -a -vv` on every release build, so a cask install lands an app that opens
cleanly.

## Publishing steps

1. Create the public repo `octopush-sh/homebrew-tap`.
2. Copy `Casks/octopush.rb` into it at the repo root path `Casks/octopush.rb`.
3. The cask already carries a real `version` and `sha256` (v0.4.63). On each
   later release, refresh both:
   ```
   shasum -a 256 Octopush.dmg
   ```
   (GitHub also reports it as the release asset's `digest` field.)
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
