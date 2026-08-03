# Octopush — Homebrew cask.
#
# ⚠️ DO NOT PUBLISH THIS TAP UNTIL THE APP IS NOTARIZED.
# An unsigned/un-notarized cask makes `brew install --cask octopush` drop a
# Gatekeeper-quarantined app on the user's disk — the first-launch experience is
# a scary "Apple could not verify" dialog, which is a terrible first impression
# and reads as broken. Ship the cask only once `spctl -a -vv` reports "accepted"
# on a released build (see docs/RELEASING.md → Blocked-on-Apple checklist).
#
# When ready, this file lives at Casks/octopush.rb in the repo
# github.com/octopush-sh/homebrew-tap, and users install with:
#     brew install --cask octopush-sh/tap/octopush
#
# Before publishing each release, set `version` to the release and replace the
# `sha256` with the real digest of that release's Octopush.dmg:
#     shasum -a 256 Octopush.dmg
# (Do not ship `sha256 :no_check` in a public tap — it disables integrity
# verification. It's only a stand-in here because no release exists yet.)

cask "octopush" do
  version "0.4.50"
  sha256 :no_check # TODO(before publish): replace with `shasum -a 256 Octopush.dmg`

  # Stable permalink asset published by scripts/release.mjs. `Octopush.dmg` is a
  # byte-copy of the versioned universal DMG, so this URL is arch-agnostic.
  url "https://github.com/octopush-sh/octopush/releases/download/v#{version}/Octopush.dmg"
  name "Octopush"
  desc "The IDE for Agentic Developers — cost-conscious multi-agent orchestration"
  homepage "https://octopush.sh"

  # Track new releases automatically.
  livecheck do
    url "https://github.com/octopush-sh/octopush/releases/latest"
    strategy :github_latest
  end

  auto_updates true # Octopush updates itself via the built-in Tauri updater.
  depends_on macos: ">= :monterey"

  app "Octopush.app"

  # Leave the user's local data in place on uninstall; `--zap` removes it.
  zap trash: [
    "~/.octopush",
    "~/Library/Application Support/octopush",
    "~/Library/Caches/com.octopush.app",
    "~/Library/Preferences/com.octopush.app.plist",
    "~/Library/Saved Application State/com.octopush.app.savedState",
  ]
end
