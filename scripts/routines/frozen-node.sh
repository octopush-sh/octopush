#!/bin/bash
# Node for a job that runs code as octo-sandbox (agent-sandbox-setup.sh), and
# the proof that nothing the runner executes after that code has changed.
#
#   frozen-node.sh freeze [tree…]   before anything untrusted runs: copy the job's
#                            Node 22 (the tool cache's, as setup-node left it,
#                            else the newest cached 22.x) to /opt/octo-node,
#                            install the npm packages named in OCTO_NODE_GLOBALS
#                            into it, make it root-owned and read-only; put it
#                            first on PATH for the next steps; close to other
#                            users everything the runner executes from then on;
#                            record a digest of /opt/octo-node
#   frozen-node.sh verify [tree…]   after the sandbox is gone, before the runner runs
#                            anything else: exit 1 if /opt/octo-node changed, if
#                            anything the runner executes from now on is
#                            writable by, or belongs to, another user, if a git
#                            directory among the trees has a hook or a command
#                            of its own, or if the step's environment carries a
#                            variable that makes bash, node, git or the loader
#                            run other code
#   frozen-node.sh end [checkout…]  the sandbox is over: kill every process in the
#                            sandbox's cgroup at once (cgroup.kill: forks in
#                            flight included, never gated on a look at the
#                            process table), then exit 1 unless the cgroup is
#                            empty and no process of the sandbox user runs
#                            anywhere; remove its crontab and lock the account,
#                            so nothing can start as it again. Then, for each checkout it could write
#                            (whose own .git was moved out before the sandbox):
#                            close its top directory to other users, remove any
#                            .git there (actions/checkout's post step would run
#                            git in it), and exit 1 if there was one
#   frozen-node.sh guard [tree…]    end (no checkouts), then verify
#
# A job that never created the sandbox user ran nothing untrusted: end and
# guard pass there, and touch nothing.
#
# Each extra tree (a checkout's .git, which actions/checkout's post step runs
# git in; a copy of these scripts the runner executes) is checked like the
# runner's own.
#
# OCTO_NODE_GLOBALS: space-separated npm packages at exact versions
# (name@X.Y.Z), installed by the runner into the copy before it is frozen, with
# their install scripts, before the sandbox user exists.
# OCTOPUSH_QUIET_ERRORS=1 (a private lane): findings are counted, never named;
# a path the sandbox chose could carry its data into the public log.
#
# A job uses this in place of running agent code on actions/setup-node's Node.
# `freeze` copies itself into $RUNNER_TEMP, which agent-sandbox-setup.sh closes
# to the sandbox: run `verify` and `guard` from that copy (or from another
# runner-only copy taken before the sandbox existed).
set -euo pipefail
JOB_PATH="${PATH:-}"
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

NODE=/opt/octo-node
SANDBOX_USER=octo-sandbox
QUIET="${OCTOPUSH_QUIET_ERRORS:-}"
die() { echo "::error::frozen-node: $*" >&2; exit 1; }
# What a finding list says in the log: its first paths, or only how many.
show() { if [[ "$QUIET" == 1 ]]; then echo "$(grep -c . <<<"$1") path(s), not named in this log"; else head -n 5 <<<"$1" | tr '\n' ' '; fi; }

[[ "${GITHUB_ACTIONS:-}" == "true" && -n "${RUNNER_TEMP:-}" ]] || { echo "frozen-node: GitHub Actions only" >&2; exit 64; }
case "${1:-}" in freeze|verify|guard|end) ;; *) echo "usage: frozen-node.sh freeze [tree…] | verify [tree…] | guard [tree…] | end [checkout…]" >&2; exit 64 ;; esac
DIGEST="$RUNNER_TEMP/octo-node.digest"

globals=()
if [[ "$1" == freeze ]]; then
  for p in ${OCTO_NODE_GLOBALS:-}; do
    [[ "$p" =~ ^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*@[0-9]+\.[0-9]+\.[0-9]+$ ]] \
      || die "OCTO_NODE_GLOBALS takes packages at exact versions (name@X.Y.Z), not: $p"
    globals+=("$p")
  done
fi
if [[ "$1" == guard || "$1" == end ]] && ! id -u "$SANDBOX_USER" >/dev/null 2>&1; then
  echo "no $SANDBOX_USER user in this job: nothing untrusted has run"
  exit 0
fi

# The sandbox's cgroup (agent-sandbox-setup.sh): every process octo-sandbox-exec
# starts is in it and can't leave it, so cgroup.kill ends them all at once.
CG=/sys/fs/cgroup/octo-sandbox
# A process of the sandbox user that can still run (a zombie runs nothing).
alive() { ps -u "$SANDBOX_USER" -o stat= 2>/dev/null | grep -qv '^Z'; }
end_sandbox() {
  [[ -e "$CG/cgroup.kill" && -e "$CG/cgroup.events" ]] || die "no sandbox cgroup at $CG: $SANDBOX_USER can't be ended at once (agent-sandbox-setup.sh makes it)"
  # First, always: the whole cgroup, then until it reports itself empty.
  local empty=""
  for _ in $(seq 1 50); do
    echo 1 | sudo tee "$CG/cgroup.kill" >/dev/null
    if grep -qx 'populated 0' "$CG/cgroup.events"; then empty=1; break; fi
    sleep 0.1
  done
  [[ -n "$empty" ]] || die "the sandbox's cgroup is still populated after cgroup.kill"
  sudo crontab -r -u "$SANDBOX_USER" >/dev/null 2>&1 || true
  sudo usermod --lock --expiredate 1 --shell /usr/sbin/nologin "$SANDBOX_USER" >/dev/null 2>&1 || die "could not lock $SANDBOX_USER"
  # Nothing of the user's may run outside the cgroup: kill it too, and fail.
  if alive; then
    sudo setpriv --reuid="$(id -u "$SANDBOX_USER")" --regid="$(id -g "$SANDBOX_USER")" --clear-groups /usr/bin/bash -c 'kill -KILL -1' >/dev/null 2>&1 || true
    die "a process of $SANDBOX_USER ran outside the sandbox's cgroup"
  fi
}

if [[ "$1" == end ]]; then
  end_sandbox
  planted=0
  for c in "${@:2}"; do
    [[ -d "$c" && ! -L "$c" && "$(stat -c %u "$c")" == "$(id -u)" ]] || die "not a checkout of the runner's: $c"
    # Its top directory first: from here no one else can create a .git in it.
    sudo chmod o-w "$c"
    if [[ -e "$c/.git" || -L "$c/.git" ]]; then
      sudo rm -rf -- "$c/.git"
      : > "$RUNNER_TEMP/planted-git"
      planted=$((planted + 1))
    fi
  done
  ((planted == 0)) || die "$planted checkout(s) had a .git of the sandbox's: removed"
  echo "$SANDBOX_USER ended and locked${2:+; its checkouts are closed and have no .git}"
  exit 0
fi

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
  for d in "${HOME:-}" "${HOME:-}/.gitconfig" "$RUNNER_TEMP" "$RUNNER_TEMP/frozen-node.sh"; do
    [[ -n "$d" && -e "$d" ]] && { sudo find "$d" -maxdepth 0 ! -type l \( "${theirs[@]}" \) -print 2>/dev/null || echo "$d (unreadable)"; }
  done
  return 0
}

# A git directory among the trees (it has HEAD and config) whose hooks or
# configuration would run a command: git runs them wherever it works in that
# repository, whatever the caller's -c flags leave out.
gitdirs() {
  local t
  for t in "${TREES[@]}"; do
    [[ -f "$t/HEAD" && -f "$t/config" ]] || continue
    if [[ -d "$t/hooks" ]]; then
      sudo find "$t/hooks" -mindepth 1 ! -type d ! -name '*.sample' -print 2>/dev/null || echo "$t/hooks (unreadable)"
    fi
    { git config --file "$t/config" --name-only --get-regexp \
        '^(core\.(hookspath|fsmonitor|sshcommand|gitproxy|askpass)|(filter|diff|merge)\..+\.(clean|smudge|process|textconv|command|driver))$' 2>/dev/null || true; } \
      | while IFS= read -r k; do echo "$t/config: $k"; done
  done
  return 0
}

# Variables in this step's environment that make bash, node, git or the
# dynamic loader run code from elsewhere. None of these workflows sets one; a
# directory on LD_LIBRARY_PATH is judged like one on PATH (in findings).
variables() {
  local v
  for v in BASH_ENV ENV NODE_OPTIONS NODE_PATH LD_PRELOAD LD_AUDIT; do
    [[ -v "$v" ]] && echo "environment: $v"
  done
  while IFS= read -r v; do
    case "$v" in
      GIT_TERMINAL_PROMPT|GIT_AUTHOR_NAME|GIT_AUTHOR_EMAIL|GIT_COMMITTER_NAME|GIT_COMMITTER_EMAIL) ;;
      GIT_*) echo "environment: $v" ;;
    esac
  done < <(compgen -e)
  return 0
}

check() {
  [[ -f "$DIGEST" ]] || die "run freeze first"
  [[ "$(digest)" == "$(cat "$DIGEST")" ]] || die "$NODE changed"
  case ":$JOB_PATH:" in *":$NODE/bin:"*) ;; *) die "$NODE/bin is not on PATH" ;; esac
  local left
  left="$(findings "$JOB_PATH:${LD_LIBRARY_PATH:-}"; gitdirs; variables)"
  [[ -z "$left" ]] || die "open to another user, or set to run other code, since freeze: $(show "$left")"
  echo "nothing the runner executes from here has changed"
}

case "$1" in
  freeze)
    cache="${RUNNER_TOOL_CACHE:-/opt/hostedtoolcache}"
    # The Node setup-node put first on PATH when it is a cached 22.x (it may be
    # newer than the image's, with check-latest), else the newest cached 22.x.
    src="$(PATH="$JOB_PATH"; command -v node 2>/dev/null || true)"
    [[ -n "$src" ]] && src="$(dirname "$(dirname "$(readlink -f "$src")")")"
    if [[ -z "$src" || "$src" != "$cache"/node/22.*/x64 ]]; then
      src="$(ls -d "$cache"/node/22.*/x64 2>/dev/null | sort -V | tail -n 1 || true)"
    fi
    [[ -n "$src" && -x "$src/bin/node" ]] || die "no cached Node 22 on this runner"
    sudo rm -rf "$NODE"
    if ((${#globals[@]})); then
      # The runner installs them in place (no path moves after an install
      # script ran), before the copy is closed and before any sandbox exists.
      sudo install -d -o "$(id -u)" -g "$(id -g)" -m 755 "$NODE"
      cp -a "$src/." "$NODE/"
      chmod -R go-w "$NODE"
      (cd / && env -i PATH="$NODE/bin:/usr/bin:/bin" HOME="$HOME" LANG=C.UTF-8 npm_config_update_notifier=false \
        "$NODE/bin/npm" install --global --prefix "$NODE" --no-audit --no-fund "${globals[@]}")
      for p in "${globals[@]}"; do
        name="${p%@*}" want="${p##*@}"
        got="$("$NODE/bin/node" -p 'require(process.argv[1]).version' "$NODE/lib/node_modules/$name/package.json" 2>/dev/null || true)"
        [[ "$got" == "$want" ]] || die "$name is '${got:-missing}' after installing $want"
      done
    else
      sudo cp -a "$src" "$NODE"
    fi
    sudo chown -R root:root "$NODE"
    sudo chmod -R a+rX,go-w "$NODE"
    "$NODE/bin/node" --version | grep -q '^v22\.' || die "$NODE/bin/node is not Node 22"
    digest > "$DIGEST"
    echo "$NODE/bin" >> "$GITHUB_PATH"
    # Close what is open now (nothing untrusted has run yet), then prove it.
    path="$NODE/bin:$JOB_PATH:${LD_LIBRARY_PATH:-}"
    open="$(findings "$path" | sort -u)"
    closed=0
    while IFS= read -r f; do
      [[ -n "$f" && "$f" != *" (unreadable)" ]] || continue
      [[ "$QUIET" == 1 ]] || echo "closing $f to other users"
      sudo chmod o-w "$f"
      closed=$((closed + 1))
    done <<<"$open"
    [[ "$QUIET" != 1 || "$closed" == 0 ]] || echo "closed $closed path(s) to other users"
    left="$(findings "$path"; gitdirs; variables)"
    [[ -z "$left" ]] || die "still open to other users, or set to run other code: $(show "$left")"
    cp "$0" "$RUNNER_TEMP/frozen-node.sh"
    echo "Node $("$NODE/bin/node" --version)${globals[*]:+ with ${globals[*]}} frozen at $NODE; what the runner executes is closed to other users"
    ;;
  verify)
    check
    ;;
  guard)
    end_sandbox
    check
    ;;
esac
