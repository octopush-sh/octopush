#!/usr/bin/env bash
# Weekly report — collects the facts for the Friday report routine described in
# docs/ROUTINES.md, as Markdown on stdout. The agent adds judgement (risks, what
# needs the owner) and files it as an issue labelled `report`.
#
#   collect [days]   facts for the last N days (default 7)
set -euo pipefail
. "$(dirname "$0")/lib.sh"

[[ "${1:-}" == "collect" ]] || { echo "usage: $0 collect [days]" >&2; exit 64; }
DAYS="${2:-7}"
SINCE="$(days_ago_iso "$DAYS")"

echo "# Facts for the last $DAYS days (since $SINCE)"
for repo in $OCTOPUSH_REPOS; do
  echo
  echo "## $repo"

  echo
  echo "**Merged**"
  gh api "repos/$repo/pulls?state=closed&sort=updated&direction=desc&per_page=100" --jq "
    [.[] | select(.merged_at != null and .merged_at >= \"$SINCE\")]
    | if length == 0 then \"- none\" else .[] | \"- #\(.number) \(.title) (\(.user.login))\" end"

  echo
  echo "**Open PRs** (CI on the head commit)"
  gh api "repos/$repo/pulls?state=open&per_page=100" --jq '
    if length == 0 then "none" else .[] | "\(.number)\t\(.head.sha)\t\(.draft)\t\(.user.login)\t\(.title)" end' |
  while IFS="	" read -r n sha draft who title; do
    if [[ "$n" == "none" ]]; then echo "- none"; continue; fi
    flag=""; [[ "$draft" == "true" ]] && flag=" (draft)"
    echo "- #$n $title — $who$flag — CI: $(ci_status_for "$repo" "$sha" || echo unknown)"
  done

  echo
  for label in ready proposal claude-code-update; do
    c="$(gh api "repos/$repo/issues?labels=$label&state=open&per_page=100" --jq '[.[] | select(.pull_request == null)] | length')"
    echo "- open \`$label\` issues: $c"
  done

  main="$(gh api "repos/$repo/commits/main" --jq .sha)"
  echo "- main: ${main:0:7} — CI: $(ci_status_for "$repo" "$main" || echo unknown)"
  name="${repo#*/}"
  if [[ -f "$DEPLOY_STATE_DIR/$name.sha" ]]; then
    live="$(cat "$DEPLOY_STATE_DIR/$name.sha")"
    if [[ "$live" == "$main" ]]; then echo "- production: ${live:0:7} (up to date with main)"
    else echo "- production: ${live:0:7} (behind main)"; fi
  elif [[ "$name" != "octopush" ]]; then
    echo "- production: unknown (no deploy record on this Mac)"
  fi
done

echo
echo "## Claude Code"
cc_marker="$ROUTINES_STATE_DIR/claude-code.version"
echo "- latest on npm: $(npm view @anthropic-ai/claude-code version 2>/dev/null || echo unknown)"
echo "- last processed by the release watch: $([[ -f "$cc_marker" ]] && cat "$cc_marker" || echo none)"
