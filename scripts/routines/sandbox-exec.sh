#!/bin/bash
# The only way code runs as octo-sandbox. agent-sandbox-setup.sh installs this
# root-owned as /usr/local/sbin/octo-sandbox-exec; callers run it with sudo.
#
#   octo-sandbox-exec CMD…    run CMD as octo-sandbox inside the job's sandbox
#                             cgroup, unable to gain privileges (no setuid,
#                             so no crontab, at or su either)
#   octo-sandbox-exec --kill  kill every process in that cgroup at once and
#                             wait until it is empty
#
# Nothing in the cgroup can leave it (root owns it and its parent), and its
# children are born in it. Writing 1 to its cgroup.kill therefore ends every
# process the sandbox ever started, forks in flight included, in one step: no
# snapshot of the process table that a fork could slip past. frozen-node.sh end
# relies on that.
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
SANDBOX_USER=octo-sandbox
CG=/sys/fs/cgroup/octo-sandbox

[[ "$(id -u)" == 0 ]] || { echo "octo-sandbox-exec: run it with sudo" >&2; exit 64; }
[[ -e "$CG/cgroup.kill" && -e "$CG/cgroup.procs" ]] || { echo "octo-sandbox-exec: no sandbox cgroup at $CG (agent-sandbox-setup.sh makes it)" >&2; exit 70; }

if [[ "${1:-}" == --kill ]]; then
  for _ in $(seq 1 100); do
    echo 1 > "$CG/cgroup.kill"
    grep -qx 'populated 0' "$CG/cgroup.events" && exit 0
    sleep 0.05
  done
  echo "octo-sandbox-exec: the sandbox cgroup is still populated" >&2
  exit 1
fi
(($#)) || { echo "usage: octo-sandbox-exec CMD… | --kill" >&2; exit 64; }

# Into the cgroup first, then the sandbox user: CMD and all it starts stay there.
echo "$$" > "$CG/cgroup.procs"
exec setpriv --reuid="$(id -u "$SANDBOX_USER")" --regid="$(id -g "$SANDBOX_USER")" --clear-groups --no-new-privs -- "$@"
