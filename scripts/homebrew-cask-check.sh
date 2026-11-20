#!/usr/bin/env bash
# Check a rendered Octopush cask with Homebrew's own tools (macOS).
#
#   scripts/homebrew-cask-check.sh <path/to/octopush.rb>
#
# Used by CI (the staged template, rendered with dummy values) and by
# promote.yml's `homebrew-tap` job (the real render, before it is pushed).
# `brew audit` only takes casks from a tap, so the file is staged in a
# throwaway local tap that is removed afterwards. Offline audit: nothing is
# downloaded.
set -euo pipefail
cask="${1:?usage: scripts/homebrew-cask-check.sh <cask.rb>}"
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_INSTALL_CLEANUP=1

ruby -c "$cask" >/dev/null

tap="octopush-ci/cask-check"
brew untap "$tap" >/dev/null 2>&1 || true
brew tap-new --no-git "$tap" >/dev/null
trap 'brew untap "$tap" >/dev/null 2>&1 || true' EXIT
dir="$(brew --repository "$tap")"
mkdir -p "$dir/Casks"
cp "$cask" "$dir/Casks/octopush.rb"

brew style --cask "$tap/octopush"
brew audit --cask --strict "$tap/octopush"
echo "cask ok: brew style + brew audit --strict"
