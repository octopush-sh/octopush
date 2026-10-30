#!/usr/bin/env bash
# Dependency triage — the fire condition and inventory for the routine described
# in docs/ROUTINES.md. Covers every Octopush repo ($OCTOPUSH_REPOS).
#
#   check   exit 0 when any repo has an open Dependabot PR; else 1; errors: 2
#   list    one line per open Dependabot PR: repo<TAB>#n<TAB>CI<TAB>title<TAB>url
set -euo pipefail
. "$(dirname "$0")/lib.sh"

list() {
  local repo
  for repo in $OCTOPUSH_REPOS; do
    gh api "repos/$repo/pulls?state=open&per_page=100" --jq '
      .[] | select(.user.login == "dependabot[bot]")
          | "\(.number)\t\(.head.sha)\t\(.title)\t\(.html_url)"' \
      || die "could not list PRs for $repo"
  done | while IFS="	" read -r n sha title url; do
    # repo is recovered from the URL so the loop stays a plain pipe (bash 3.2).
    r="$(echo "$url" | sed -E 's#https://github.com/([^/]+/[^/]+)/pull/.*#\1#')"
    printf '%s\t#%s\t%s\t%s\t%s\n' "$r" "$n" "$(ci_status_for "$r" "$sha" || echo unknown)" "$title" "$url"
  done
}

case "${1:-}" in
  check)
    n="$(list | wc -l | tr -d ' ')"
    if [[ "$n" == "0" ]]; then echo "no open Dependabot PRs"; exit 1; fi
    echo "$n open Dependabot PR(s)"
    ;;
  list) list ;;
  *) echo "usage: $0 check|list" >&2; exit 64 ;;
esac
