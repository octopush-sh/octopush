# Octopush — Homebrew cask.
#
# ✅ READY TO PUBLISH. As of v0.4.63 Octopush is signed with an Apple Developer ID
# certificate and notarized by Apple (verified with `spctl -a -vv` on every
# release build), so a cask install lands an app that opens cleanly — the
# notarization gate that previously blocked this tap is cleared.
#
# This file lives at Casks/octopush.rb in the repo
# github.com/octopush-sh/homebrew-tap, and users install with:
#     brew install --cask octopush-sh/tap/octopush
#
# On each release, bump `version` and refresh `sha256` with the digest of that
# release's Octopush.dmg:
#     shasum -a 256 Octopush.dmg
# (GitHub also reports it: the release asset's `digest` field.)

cask "octopush" do
  version "0.4.63"
  sha256 "50d989d10c934fea87ce50e68336ed047e99d826570414791e1a8eef8a415f91"

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
