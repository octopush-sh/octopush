#!/bin/bash
# Prepare a GitHub Actions runner for a builder agent (run once per job, as the
# runner user, before the agent starts). See agent-check.sh.
#   - creates the unprivileged `octo-sandbox` user (no shared group);
#   - opens ONLY the checkout to it (it runs the type checker and tests there);
#   - leaves the directories above the checkout traversable but not listable,
#     and locks the runner's temp dir (step scripts, env files) to the runner.
set -euo pipefail

SANDBOX_USER="${OCTOPUSH_SANDBOX_USER:-octo-sandbox}"
# The checkout to open to the sandbox. The workflow runs this script from a
# copy taken from main (outside the checkout), so the path comes in explicitly.
ROOT="${OCTOPUSH_CHECKOUT:?OCTOPUSH_CHECKOUT is required}"
HERE="$(cd "$(dirname "$0")" && pwd)"

[[ "${GITHUB_ACTIONS:-}" == "true" ]] || { echo "agent-sandbox-setup: GitHub Actions only" >&2; exit 64; }

id -u "$SANDBOX_USER" >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin "$SANDBOX_USER"
sudo install -d -o "$SANDBOX_USER" -m 700 "/tmp/$SANDBOX_USER-home"

# The checkout: read/write for others (the sandbox), so tests can write caches.
chmod -R o+rwX "$ROOT"

# Above the checkout: traverse only (no listing), up to /.
dir="$ROOT"
while :; do
  dir="$(dirname "$dir")"
  [[ "$dir" == "/" ]] && break
  if [[ -O "$dir" ]]; then chmod o-r,o+x "$dir"; else sudo chmod o+x "$dir"; fi
done

# The runner's temp dir holds step scripts and env files: runner only.
[[ -n "${RUNNER_TEMP:-}" ]] && chmod 700 "$RUNNER_TEMP"

# The check command the agent may run, installed where it can't edit it
# (root-owned, outside the checkout), with this checkout's path baked in.
NODE_DIR="$(dirname "$(readlink -f "$(command -v node)")")"
sed -e "s#^ROOT=.*#ROOT=\"$ROOT\"#" -e "s#^NODE_DIR=.*#NODE_DIR=\"$NODE_DIR\"#" "$HERE/agent-check.sh" \
  | sudo tee /usr/local/bin/octo-check >/dev/null
sudo chown root:root /usr/local/bin/octo-check
sudo chmod 755 /usr/local/bin/octo-check

echo "sandbox user $SANDBOX_USER ready for $ROOT; checks: octo-check"
