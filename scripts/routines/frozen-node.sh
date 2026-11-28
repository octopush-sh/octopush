#!/bin/bash
# Node for a job that runs code as octo-sandbox (agent-sandbox-setup.sh), and
# the proof that nothing the runner executes after that code has changed.
#
#   frozen-node.sh freeze [tree…]   before anything untrusted runs: copy the runner's
#                            cached Node 22 to /opt/octo-node, root-owned and
#                            read-only; put it first on PATH for the next steps;
#                            close to other users everything the runner executes
#                            from then on; record a digest of /opt/octo-node
#   frozen-node.sh verify [tree…]   after the sandbox is gone, before the runner runs
#                            anything else: exit 1 if /opt/octo-node changed, or
#                            if anything the runner executes from now on is
#                            writable by, or belongs to, another user
#
# Each extra tree (a checkout's .git, which actions/checkout's post step runs
# git in) is checked like the runner's own.
#
# A job uses this instead of actions/setup-node. `freeze` copies itself into
# $RUNNER_TEMP, which agent-sandbox-setup.sh closes to the sandbox: run
# `verify` from that copy.
set -euo pipefail
JOB_PATH="${PATH:-}"
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

NODE=/opt/octo-node
SANDBOX_USER=octo-sandbox
die() { echo "::error::frozen-node: $*" >&2; exit 1; }

[[ "${GITHUB_ACTIONS:-}" == "true" && -n "${RUNNER_TEMP:-}" ]] || { echo "frozen-node: GitHub Actions only" >&2; exit 64; }
DIGEST="$RUNNER_TEMP/octo-node.digest"

# Content, modes, owners and links of the whole tree, in one digest.
digest() { sudo tar --sort=name --numeric-owner -cf - -C "$NODE" . | sha256sum | cut -d' ' -f1; }

# Trees the runner executes from after the sandbox: the runner itself (with the
# node it runs actions on), the actions' code, and the configuration git and
# the CLIs read.
pid="$(pgrep -o -x Runner.Worker || true)"
[[ -n "$pid" ]] || die "could not find the runner process"
TREES=("$(dirname "$(dirname "$(readlink -f "/proc/$pid/exe")")")")
[[ -d "$(dirname "$RUNNER_TEMP")/_actions" ]] && TREES+=("$(dirname "$RUNNER_TEMP")/_actions")
[[ -n "${HOME:-}" && -d "$HOME/.config" ]] && TREES+=("$HOME/.config")
[[ -d "${GITHUB_WORKSPACE:-}/.git" ]] && TREES+=("$GITHUB_WORKSPACE/.git")
for t in "${@:2}"; do [[ -d "$t" ]] || die "no such tree: $t"; TREES+=("$t"); done

# Every path another user could change, one per line. Links are judged by
# their owner only (their mode is always 777); a sticky directory (/tmp)
# doesn't let others rename what they don't own.
findings() {
  local path="$1" d a
  local theirs=(-perm -0002) links=(-false)
  if id -u "$SANDBOX_USER" >/dev/null 2>&1; then
    theirs=(-perm -0002 -o -user "$SANDBOX_USER" -o -group "$SANDBOX_USER")
    links=(-user "$SANDBOX_USER")
  fi
  while IFS= read -r d; do
    # Judge the directory itself, not a link to it (/bin → usr/bin).
    d="$(realpath -e "$d" 2>/dev/null)" || continue
    [[ -d "$d" ]] || continue
    a="$d"
    while :; do
      sudo find "$a" -maxdepth 0 \( -perm -0002 ! -perm -1000 \) -print 2>/dev/null || echo "$a (unreadable)"
      [[ "$a" == / ]] && break
      a="$(dirname "$a")"
    done
    sudo find "$d" -mindepth 1 -maxdepth 1 \( \( ! -type l \( "${theirs[@]}" \) \) -o \( -type l "${links[@]}" \) \) -print 2>/dev/null \
      || echo "$d (unreadable)"
  done < <(tr ':' '\n' <<<"$path" | awk 'NF && !seen[$0]++')
  for d in "${TREES[@]}"; do
    sudo find "$d" -xdev \( \( ! -type l \( "${theirs[@]}" \) \) -o \( -type l "${links[@]}" \) \) -print 2>/dev/null \
      || echo "$d (unreadable)"
  done
  for d in "${HOME:-}" "${HOME:-}/.gitconfig"; do
    [[ -n "$d" && -e "$d" ]] && { sudo find "$d" -maxdepth 0 ! -type l \( "${theirs[@]}" \) -print 2>/dev/null || echo "$d (unreadable)"; }
  done
  return 0
}

case "${1:-}" in
  freeze)
    src="$(ls -d "${RUNNER_TOOL_CACHE:-/opt/hostedtoolcache}"/node/22.*/x64 2>/dev/null | sort -V | tail -n 1 || true)"
    [[ -n "$src" && -x "$src/bin/node" ]] || die "no cached Node 22 on this runner"
    sudo rm -rf "$NODE"
    sudo cp -a "$src" "$NODE"
    sudo chown -R root:root "$NODE"
    sudo chmod -R a+rX,go-w "$NODE"
    "$NODE/bin/node" --version | grep -q '^v22\.' || die "$NODE/bin/node is not Node 22"
    digest > "$DIGEST"
    echo "$NODE/bin" >> "$GITHUB_PATH"
    # Close what is open now (nothing untrusted has run yet), then prove it.
    path="$NODE/bin:$JOB_PATH"
    open="$(findings "$path" | sort -u)"
    while IFS= read -r f; do
      [[ -n "$f" && "$f" != *" (unreadable)" ]] || continue
      echo "closing $f to other users"
      sudo chmod o-w "$f"
    done <<<"$open"
    left="$(findings "$path")"
    [[ -z "$left" ]] || die "still open to other users: $(head -n 5 <<<"$left" | tr '\n' ' ')"
    cp "$0" "$RUNNER_TEMP/frozen-node.sh"
    echo "Node $("$NODE/bin/node" --version) frozen at $NODE; what the runner executes is closed to other users"
    ;;
  verify)
    [[ -f "$DIGEST" ]] || die "run freeze first"
    [[ "$(digest)" == "$(cat "$DIGEST")" ]] || die "$NODE changed"
    case ":$JOB_PATH:" in *":$NODE/bin:"*) ;; *) die "$NODE/bin is not on PATH" ;; esac
    left="$(findings "$JOB_PATH")"
    [[ -z "$left" ]] || die "open to another user since freeze: $(head -n 5 <<<"$left" | tr '\n' ' ')"
    echo "nothing the runner executes from here has changed"
    ;;
  *) echo "usage: frozen-node.sh freeze [tree…] | verify [tree…]" >&2; exit 64 ;;
esac
