#!/usr/bin/env bash
# Wrapper so Octopush routines get the PATH fix from lib.sh (node, gh) — see answers.mjs.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
exec node "$(dirname "$0")/answers.mjs" "$@"
