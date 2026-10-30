#!/usr/bin/env bash
# Dependency triage — the fire condition and inventory for the routine described
# in docs/ROUTINES.md. Covers every Octopush repo ($OCTOPUSH_REPOS).
#
#   check   exit 0 when an open Dependabot PR has finished CI and has not been
#           triaged on its current head commit yet; else 1; errors: 2
#   list    those PRs: repo<TAB>#n<TAB>head-sha<TAB>CI<TAB>title<TAB>url
#
# A PR counts as triaged once it has a comment containing the marker
# `octopush-triage:<head-sha>` (the brief writes it), so each PR is triaged
# once per new commit, not every week.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

# Emits untriaged, CI-finished Dependabot PRs; stops after $1 of them (0 = all).
untriaged() {
  local limit="${1:-0}" found=0 repo prs comments n sha title url ci
  for repo in $OCTOPUSH_REPOS; do
    # Captured first (not piped/process-substituted) so a gh failure aborts with
    # exit 2 instead of looking like "no PRs".
    prs="$(gh api "repos/$repo/pulls?state=open&per_page=100" --jq '
      .[] | select(.user.login == "dependabot[bot]")
          | "\(.number)\t\(.head.sha)\t\(.title)\t\(.html_url)"')" || die "could not list PRs for $repo"
    while IFS="	" read -r n sha title url; do
      [[ -n "$n" ]] || continue
      comments="$(gh api "repos/$repo/issues/$n/comments?per_page=100" --jq '.[].body')" \
        || die "could not read comments on $repo#$n"
      case "$comments" in *"octopush-triage:$sha"*) continue ;; esac
      ci="$(ci_status_for "$repo" "$sha" || echo unknown)"
      [[ "$ci" == "pending" || "$ci" == "none" ]] && continue   # wait for CI
      printf '%s\t#%s\t%s\t%s\t%s\t%s\n' "$repo" "$n" "$sha" "$ci" "$title" "$url"
      found=$((found + 1))
      if [[ "$limit" != "0" && "$found" -ge "$limit" ]]; then return 0; fi
    done <<< "$prs"
  done
}

case "${1:-}" in
  check)
    # Stop at the first hit: fire conditions time out after 30s.
    first="$(untriaged 1)"
    if [[ -z "$first" ]]; then echo "no untriaged Dependabot PRs with finished CI"; exit 1; fi
    echo "untriaged: $(echo "$first" | cut -f1,2)"
    ;;
  list) untriaged 0 ;;
  *) echo "usage: $0 check|list" >&2; exit 64 ;;
esac
