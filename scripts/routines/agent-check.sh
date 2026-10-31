#!/usr/bin/env bash
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

SANDBOX_USER="${OCTOPUSH_SANDBOX_USER:-octo-sandbox}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

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
chmod -R o+rwX "$ROOT" 2>/dev/null || true

# sudo -n: the workflow prepared the user and the permissions beforehand
# (agent-sandbox-setup.sh); never prompt.
exec sudo -n -u "$SANDBOX_USER" env -i \
  PATH="/usr/local/bin:/usr/bin:/bin:$(dirname "$(command -v node)")" \
  HOME="/tmp/$SANDBOX_USER-home" \
  CI=true LANG=C.UTF-8 \
  bash -c 'cd "$1" && shift && exec "$@"' _ "$ROOT" "${cmd[@]}"
