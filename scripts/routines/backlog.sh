#!/usr/bin/env bash
# Backlog → PR — the fire condition and picker for the routine described in
# docs/ROUTINES.md.
#
#   check   exit 0 when there is work: an agent PR whose review asked for
#           changes, or an open `ready` issue that no open PR claims
#           ("Closes/Fixes/Resolves #N") and isn't parked (`needs-owner`,
#           `proposal`) or claimed by another builder (`in-progress`); else 1
#   next    print the next job, review fixes first:
#             pr<TAB>number<TAB>branch<TAB>title<TAB>url      (address the review)
#             issue<TAB>number<TAB>title<TAB>url              (implement it)
set -euo pipefail
. "$(dirname "$0")/lib.sh"

REPO="${OCTOPUSH_ROUTINE_REPO:-$(this_repo)}"

candidates() {
  local claimed
  # Issue numbers referenced by a closing keyword in any open PR's title or body.
  claimed="$(gh api "repos/$REPO/pulls?state=open&per_page=100" --jq '
    [.[] | ((.title // "") + "\n" + (.body // ""))
     | scan("(?i)\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\\s+#([0-9]+)") | .[0]] | unique | join(" ")')" \
    || die "could not list PRs for $REPO"
  gh api "repos/$REPO/issues?labels=ready&state=open&sort=created&direction=asc&per_page=100" --jq "
    [.[] | select(.pull_request == null)
         | select([.labels[].name] | index(\"needs-owner\") == null and index(\"proposal\") == null and index(\"in-progress\") == null)
         | .number as \$n
         | select((\" $claimed \" | contains(\" \(\$n) \")) | not)]
    | .[] | \"\(.number)\t\(.title)\t\(.html_url)\"" \
    || die "could not list issues for $REPO"
}

# Only the app repo has review/auto-merge; elsewhere there are no fix jobs.
fix_prs() {
  [[ "$REPO" == "octopush-sh/octopush" ]] || return 0
  node "$(dirname "$0")/automerge.mjs" changes || die "could not list PRs awaiting fixes"
}

next_job() {
  local fix issue
  fix="$(fix_prs | head -n 1)"
  if [[ -n "$fix" ]]; then printf 'pr\t%s\n' "$fix"; return 0; fi
  issue="$(candidates | head -n 1)"
  if [[ -n "$issue" ]]; then printf 'issue\t%s\n' "$issue"; return 0; fi
  return 1
}

case "${1:-}" in
  check)
    if job="$(next_job)"; then echo "work: $(echo "$job" | cut -f1,2)"; exit 0; fi
    echo "no review fixes and no unclaimed ready issues in $REPO"; exit 1
    ;;
  next)
    next_job || { echo "nothing to do in $REPO" >&2; exit 1; }
    ;;
  *) echo "usage: $0 check|next" >&2; exit 64 ;;
esac
