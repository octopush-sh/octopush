#!/usr/bin/env bash
# Nightly builders' job picker — see jobs.mjs (review fixes and red CI first,
# then `ready` issues; claims via the `in-progress` label expire after 24 h).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
exec node "$(dirname "$0")/jobs.mjs" "$@"
