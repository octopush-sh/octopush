# Octopush — Homebrew cask.
#
# The template for Casks/octopush.rb in github.com/octopush-sh/homebrew-tap.
# Users install with:
#     brew install --cask octopush-sh/tap/octopush
#
# Edit the template (packaging/homebrew-tap/Casks/octopush.rb in
# octopush-sh/octopush), never the copy in the tap: every promotion to stable
# (.github/workflows/promote.yml, job `homebrew-tap`) renders this file with the
# promoted version and the sha256 of that release's Octopush.dmg
# (scripts/homebrew-cask.mjs), checks it with `brew style` + `brew audit`, and
# pushes it to the tap. The `version` and `sha256` below are placeholders the
# render replaces; CI runs the same checks on every pull request.

cask "octopush" do
  version "0.0.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  # Stable permalink asset published by scripts/release.mjs. `Octopush.dmg` is a
  # byte-copy of the versioned universal DMG, so this URL is arch-agnostic.
  url "https://github.com/octopush-sh/octopush/releases/download/v#{version}/Octopush.dmg",
      verified: "github.com/octopush-sh/octopush/"
  name "Octopush"
  desc "IDE for directing crews of AI coding agents"
  homepage "https://octopush.sh/"

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
