# octopush-sh/homebrew-tap — the staged template

This folder holds the **template** for the public Homebrew tap
[`octopush-sh/homebrew-tap`](https://github.com/octopush-sh/homebrew-tap)
(the `homebrew-` prefix is what lets `brew tap octopush-sh/tap` resolve).
Users install with:

```
brew install --cask octopush-sh/tap/octopush
```

Octopush is signed with an Apple Developer ID certificate and notarized from
v0.4.63 on (`spctl -a -vv` on every release build), so a cask install lands an
app that opens cleanly.

## How the tap is published

Nobody edits the tap by hand. Every promotion to stable
(`.github/workflows/promote.yml`, job `homebrew-tap`):

1. reads the promoted release's `Octopush.dmg` sha256 (the asset's `digest`;
   if the release reports none, it downloads the DMG and runs `shasum -a 256`);
2. renders `Casks/octopush.rb` from this template with that version and sha256
   (`scripts/homebrew-cask.mjs`);
3. checks the result with `brew style` and `brew audit --cask --strict`
   (`scripts/homebrew-cask-check.sh`);
4. pushes it to the tap's `main` with an Octopush Cycle app token limited to the
   tap repo. On the empty repo this is the first commit; afterwards the cask is
   updated in place, left alone when it is already current, and never moved
   back to an older version.

Betas never touch the tap. A failed tap update never undoes the promotion; the
run's summary says "Homebrew tap NOT updated" and re-running the job retries.
CI renders the template with dummy values and runs the same checks on every
pull request, so it can't rot between promotions.

The `version` and `sha256` in `Casks/octopush.rb` here are **placeholders**:
change anything else (description, zap paths, minimum macOS) in this template,
and the next promotion publishes it.

## Layout

```
Casks/
  octopush.rb   the cask template
README.md       this file
```
