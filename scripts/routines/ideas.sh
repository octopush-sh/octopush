#!/usr/bin/env bash
# Wrapper so Octopush routines get the PATH fix from lib.sh (node, gh) — see ideas.mjs.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
exec node "$(dirname "$0")/ideas.mjs" "$@"
