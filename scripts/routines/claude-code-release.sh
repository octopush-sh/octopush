#!/usr/bin/env bash
# Claude Code release watch — the fire condition and helpers for the routine
# described in docs/ROUTINES.md.
#
#   check          exit 0 when a Claude Code version newer than the last one
#                  processed is published on npm (else 1; errors: 2 = skip)
#   show           versions + the upstream changelog for the unprocessed range
#   ack <version>  record <version> as processed (the routine's LAST step, so a
#                  failed run is retried at the next window)
set -euo pipefail
. "$(dirname "$0")/lib.sh"

PKG="@anthropic-ai/claude-code"
MARKER="$ROUTINES_STATE_DIR/claude-code.version"

latest() {
  local v
  v="$(npm view "$PKG" version 2>/dev/null)" || die "could not read $PKG from npm"
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || die "unexpected npm version: $v"
  echo "$v"
}
processed() { [[ -f "$MARKER" ]] && cat "$MARKER" || echo "none"; }

changelog() {
  gh api repos/anthropics/claude-code/contents/CHANGELOG.md --jq .content 2>/dev/null | base64 --decode 2>/dev/null \
    || curl -fsSL --max-time 20 https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
}

# Print the changelog sections from "## <new>" down to (not including) "## <old>".
section_between() {
  awk -v new="$1" -v old="$2" '
    /^## / { v=$2; if (v==new) on=1; else if (on && v==old) exit }
    on { print }'
}

case "${1:-}" in
  check)
    v="$(latest)"; p="$(processed)"
    if [[ "$v" == "$p" ]]; then echo "up to date: $v already processed"; exit 1; fi
    echo "new Claude Code release: $v (last processed: $p)"
    ;;
  show)
    v="$(latest)"; p="$(processed)"
    echo "latest on npm:   $v"
    echo "last processed:  $p"
    echo "installed here:  $(claude --version 2>/dev/null || echo 'not installed')"
    echo
    echo "---- upstream CHANGELOG ($v back to $p) ----"
    changelog | section_between "$v" "$p" | head -n 400 || echo "(changelog unavailable — read https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)"
    ;;
  ack)
    [[ -n "${2:-}" ]] || die "usage: ack <version>"
    mkdir -p "$ROUTINES_STATE_DIR"; echo "$2" > "$MARKER"; echo "recorded $2 as processed"
    ;;
  *) echo "usage: $0 check|show|ack <version>" >&2; exit 64 ;;
esac
