# Shared helpers for the routine scripts in scripts/routines/.
# Sourced, not executed. Bash 3.2-compatible (macOS /bin/bash): no mapfile,
# associative arrays or ${var,,}. All GitHub calls use the REST API via `gh api`.

# Octopush (like any macOS GUI app / launchd job) runs fire conditions with a
# minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin): add gh/claude (~/.local/bin,
# Homebrew) and nvm's node/npm — same fix as octopush-web#10.
NVM_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -n 1 || true)"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin${NVM_BIN:+:$NVM_BIN}:$PATH"

ROUTINES_STATE_DIR="${OCTOPUSH_ROUTINES_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/octopush-routines}"
DEPLOY_STATE_DIR="${OCTOPUSH_DEPLOY_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/octopush-deploy}"
OCTOPUSH_REPOS="${OCTOPUSH_REPOS:-octopush-sh/octopush octopush-sh/octopush-api octopush-sh/octopush-web}"

die() { echo "${0##*/}: $*" >&2; exit 2; }

# The GitHub slug of the repo this script runs in (owner/repo).
this_repo() {
  local url
  url="$(git remote get-url origin 2>/dev/null)" || die "not in a git repo with an origin"
  url="${url%.git}"
  echo "$url" | sed -E 's#^.*[:/]([^/:]+/[^/]+)$#\1#'
}

# ISO-8601 UTC timestamp N days ago (node is required by the app anyway; BSD and
# GNU `date` disagree on relative dates).
days_ago_iso() { node -e "console.log(new Date(Date.now()-$1*864e5).toISOString().replace(/\.\d+Z$/,'Z'))"; }

# success | pending | failure | none — latest "CI" workflow run for a commit.
ci_status_for() {
  gh api "repos/$1/actions/runs?head_sha=$2&per_page=50" --jq '
    [.workflow_runs[] | select(.name == "CI")] | sort_by(.created_at) | last |
    if . == null then "none"
    elif .status != "completed" then "pending"
    elif .conclusion == "success" then "success"
    else "failure" end'
}
