#!/bin/bash
# Re-run CI runs that failed only because GitHub never gave a job a runner
# (macOS capacity: every non-successful job "cancelled", no step ran). Such a
# run is not a test result: left alone it reads as red CI, so the builder
# spends a fix round on code that is fine and the reviewer never sees the PR.
#
#   rerun-starved.sh            open PRs' heads and main's head, this repo
#
# At most two re-runs per run (it stops at attempt 3); after that it is left
# for a person. Exit 0 always unless gh itself fails (2).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
REPO="${OCTOPUSH_ROUTINE_REPO:-$(this_repo)}"
MAX_ATTEMPTS="${OCTOPUSH_STARVED_MAX_ATTEMPTS:-3}"

shas="$(gh api "repos/$REPO/pulls?state=open&per_page=100" --jq '.[].head.sha')" || die "could not list PRs"
shas="$shas"$'\n'"$(gh api "repos/$REPO/commits/main" --jq .sha)" || die "could not read main"
n=0
while read -r sha; do
  [[ -n "$sha" ]] || continue
  id="$(ci_starved_run_for "$REPO" "$sha")" || continue
  [[ -n "$id" ]] || continue
  attempt="$(gh api "repos/$REPO/actions/runs/$id" --jq .run_attempt)" || continue
  if [[ "$attempt" -ge "$MAX_ATTEMPTS" ]]; then echo "CI run $id (${sha:0:7}) starved $attempt times — leaving it"; continue; fi
  if err="$(gh api -X POST "repos/$REPO/actions/runs/$id/rerun-failed-jobs" 2>&1 >/dev/null </dev/null)"; then
    echo "re-ran CI run $id (${sha:0:7}, attempt $attempt): its jobs never got a runner"; n=$((n + 1))
  else
    echo "could not re-run CI run $id: $err"
  fi
done <<< "$shas"
echo "$n starved CI run(s) re-run"
