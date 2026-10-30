#!/usr/bin/env bash
# Trusted reading for agents — see read.mjs.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
exec node "$(dirname "$0")/read.mjs" "$@"
