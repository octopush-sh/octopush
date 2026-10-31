#!/bin/bash
# The only way a nightly builder agent runs code (scripts/routines/agent.mjs).
#
#   agent-check.sh typecheck | test [vitest args…] | whats-new | all
#
# agent-sandbox-setup.sh installs it as root-owned /usr/local/bin/octo-check
# (with the checkout's path baked in); the agent may run only that copy, never
# this file, which it could edit.
#
# The checks execute code the agent just wrote, so they run as a separate,
# unprivileged user (`octo-sandbox`) with an empty environment: that user can't
# read the agent's process environment (where the Claude token lives) or the
# runner's files, and has no GitHub credential. Inside GitHub Actions only —
# on a Mac it refuses, the Mac routines run checks directly.
set -euo pipefail
# Never trust the caller's PATH for the tools this script itself runs.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

SANDBOX_USER="${OCTOPUSH_SANDBOX_USER:-octo-sandbox}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"   # replaced with the checkout path when installed
NODE_DIR=""                                     # replaced with node's directory when installed

if [[ "${GITHUB_ACTIONS:-}" != "true" && "${OCTOPUSH_AGENT_SANDBOX:-}" != "1" ]]; then
  echo "agent-check: only for the GitHub Actions agents (run the checks directly instead)" >&2
  exit 64
fi

case "${1:-}" in
  typecheck) cmd=(npm run --silent typecheck) ;;
  test) shift; cmd=(npx vitest run "$@") ;;
  whats-new) cmd=(node scripts/whats-new.mjs check) ;;
  all) cmd=(bash -c 'npm run --silent typecheck && npx vitest run && node scripts/whats-new.mjs check') ;;
  *) echo "usage: octo-check typecheck | test [vitest args] | whats-new | all" >&2; exit 64 ;;
esac

# Files the agent created since setup are the runner's (umask 022): readable by
# the sandbox; reopen them for writing too, as setup did for the checkout.
/bin/chmod -R o+rwX "$ROOT" 2>/dev/null || true

# sudo -n: the workflow prepared the user and the permissions beforehand
# (agent-sandbox-setup.sh); never prompt.
[[ -n "$NODE_DIR" && -x "$NODE_DIR/node" ]] || { echo "octo-check: node not configured" >&2; exit 2; }
# Not exec: after the checks, remove every symlink the sandbox created (one
# into the runner's files would let the agent's file tools reach past cwd).
set +e
/usr/bin/sudo -n -u "$SANDBOX_USER" /usr/bin/env -i \
  PATH="$NODE_DIR:/usr/local/bin:/usr/bin:/bin" \
  HOME="/tmp/$SANDBOX_USER-home" \
  CI=true LANG=C.UTF-8 \
  bash -c 'cd "$1" && shift && exec "$@"' _ "$ROOT" "${cmd[@]}"
rc=$?
/usr/bin/sudo -n /usr/bin/pkill -KILL -u "$SANDBOX_USER" 2>/dev/null
/usr/bin/sudo -n /usr/bin/find "$ROOT" -type l -user "$SANDBOX_USER" -delete 2>/dev/null
exit "$rc"
