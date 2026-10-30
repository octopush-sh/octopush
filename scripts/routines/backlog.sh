#!/usr/bin/env bash
# Backlog → PR — the fire condition and picker for the routine described in
# docs/ROUTINES.md.
#
#   check   exit 0 when this repo has an open issue labelled `ready` that no open
#           PR already claims ("Closes/Fixes/Resolves #N"); else 1; errors: 2
#   next    print the oldest such issue: number<TAB>title<TAB>url
set -euo pipefail
. "$(dirname "$0")/lib.sh"

REPO="${OCTOPUSH_ROUTINE_REPO:-$(this_repo)}"

candidates() {
  local claimed
  # Issue numbers referenced by a closing keyword in any open PR's title or body.
  claimed="$(gh api "repos/$REPO/pulls?state=open&per_page=100" --jq '
    [.[] | ((.title // "") + "\n" + (.body // ""))
     | scan("(?i)\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#([0-9]+)") | .[0]] | unique | join(" ")')" \
    || die "could not list PRs for $REPO"
  gh api "repos/$REPO/issues?labels=ready&state=open&sort=created&direction=asc&per_page=100" --jq "
    [.[] | select(.pull_request == null)
         | .number as \$n
         | select((\" $claimed \" | contains(\" \(\$n) \")) | not)]
    | .[] | \"\(.number)\t\(.title)\t\(.html_url)\"" \
    || die "could not list issues for $REPO"
}

case "${1:-}" in
  check)
    first="$(candidates | head -n 1)"
    if [[ -z "$first" ]]; then echo "no unclaimed ready issues in $REPO"; exit 1; fi
    echo "ready: #${first%%	*} in $REPO"
    ;;
  next)
    first="$(candidates | head -n 1)"
    [[ -n "$first" ]] || { echo "no unclaimed ready issues in $REPO" >&2; exit 1; }
    echo "$first"
    ;;
  *) echo "usage: $0 check|next" >&2; exit 64 ;;
esac
