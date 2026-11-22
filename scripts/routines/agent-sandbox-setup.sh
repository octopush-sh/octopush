#!/bin/bash
# Prepare a GitHub Actions runner for a builder agent (run once per job, as the
# runner user, before the agent starts). See agent-check.sh.
#   - creates the unprivileged `octo-sandbox` user (no shared group);
#   - opens ONLY the checkout to it (it runs the type checker and tests there);
#   - leaves the directories above the checkout traversable but not listable,
#     and locks the runner's temp dir (step scripts, env files) to the runner.
set -euo pipefail

SANDBOX_USER=octo-sandbox
# The checkout to open to the sandbox. The workflow runs this script from a
# copy taken from main (outside the checkout), so the path comes in explicitly.
ROOT="${OCTOPUSH_CHECKOUT:?OCTOPUSH_CHECKOUT is required}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# Which checks octo-check runs: app (this repo), web (octopush-web) or epiku. Baked in below.
PROFILE="${OCTO_CHECK_PROFILE:-app}"
[[ "$PROFILE" == app || "$PROFILE" == web || "$PROFILE" == web-audit || "$PROFILE" == epiku ]] || { echo "agent-sandbox-setup: OCTO_CHECK_PROFILE is app, web, web-audit or epiku" >&2; exit 64; }

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

# OCTO_SANDBOX_NETWORK=none (epiku-build.yml): the sandbox user gets no network
# at all. Its checkout holds a private repo, real project plans included, and
# the code it runs was just written by an agent: with no way out, that code
# can read them but can't send them anywhere. Packet rules by uid (IPv4 and
# IPv6): loopback stays (test runners talk to themselves) except DNS, which the
# local stub resolver would carry out; the resolver's and the system bus's
# sockets are closed to the user as well (they answer DNS without a packet of
# its own). Proved below — any way out left open stops the job.
if [[ "${OCTO_SANDBOX_NETWORK:-open}" == none ]]; then
  uid="$(id -u "$SANDBOX_USER")"
  for ipt in iptables ip6tables; do
    sudo "$ipt" -w -I OUTPUT 1 -m owner --uid-owner "$uid" -j REJECT
    sudo "$ipt" -w -I OUTPUT 1 -m owner --uid-owner "$uid" -o lo -j ACCEPT
    sudo "$ipt" -w -I OUTPUT 1 -m owner --uid-owner "$uid" -o lo -p udp --dport 53 -j REJECT
    sudo "$ipt" -w -I OUTPUT 1 -m owner --uid-owner "$uid" -o lo -p tcp --dport 53 -j REJECT
  done
  for sock in /run/systemd/resolve/io.systemd.Resolve /run/systemd/resolve/io.systemd.Resolve.Monitor /run/dbus/system_bus_socket /var/run/nscd/socket; do
    if [[ -e "$sock" ]]; then sudo setfacl -m "u:$SANDBOX_USER:---" "$sock"; fi
  done
  as_sandbox() { sudo -n -u "$SANDBOX_USER" /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/timeout 8 "$@" >/dev/null 2>&1; }
  open=""
  if as_sandbox /bin/bash -c 'exec 3<>/dev/tcp/1.1.1.1/443'; then open="$open tcp"; fi
  if as_sandbox /bin/bash -c 'exec 3<>/dev/tcp/2606:4700:4700::1111/443'; then open="$open tcp6"; fi
  if as_sandbox /usr/bin/getent hosts github.com; then open="$open dns"; fi
  if command -v resolvectl >/dev/null && as_sandbox resolvectl query github.com; then open="$open resolved"; fi
  [[ -z "$open" ]] || { echo "::error::the sandbox user still has a way out ($open ) — not starting the agent"; exit 1; }
  echo "sandbox user $SANDBOX_USER has no network (proved: tcp, tcp6, dns, the resolver)"
elif [[ "${OCTO_SANDBOX_NETWORK:-open}" != open ]]; then
  echo "agent-sandbox-setup: OCTO_SANDBOX_NETWORK is open or none" >&2; exit 64
fi

# The runner's temp dir holds step scripts and env files: runner only.
[[ -n "${RUNNER_TEMP:-}" ]] && chmod 700 "$RUNNER_TEMP"

# The check command the agent may run, installed where it can't edit it
# (root-owned, outside the checkout), with this checkout's path and the profile baked in.
NODE_DIR="$(dirname "$(readlink -f "$(command -v node)")")"
sed -e "s#^ROOT=.*#ROOT=\"$ROOT\"#" -e "s#^NODE_DIR=.*#NODE_DIR=\"$NODE_DIR\"#" -e "s#^PROFILE=.*#PROFILE=\"$PROFILE\"#" "$HERE/agent-check.sh" \
  | sudo tee /usr/local/bin/octo-check >/dev/null
sudo chown root:root /usr/local/bin/octo-check
sudo chmod 755 /usr/local/bin/octo-check

echo "sandbox user $SANDBOX_USER ready for $ROOT; checks: octo-check ($PROFILE)"
