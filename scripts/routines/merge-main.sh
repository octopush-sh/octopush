#!/usr/bin/env bash
# Bring origin/main into the checked-out agent branch before a fix round
# (nightly-build.yml, docs/ROUTINES.md "Fix rounds"). Run inside the checkout,
# before the agent starts; never runs hooks, fsmonitor or filters.
#
#   merge-main.sh <out-dir>
#
# Prints one word and writes its lists into <out-dir>:
#   clean        main was already in the branch: nothing to do
#   merged       merged cleanly; the merge is committed
#   conflicts    every conflicted file got text conflict markers: the merge is
#                committed WITH them (zdiff3) and conflicts.txt lists the files;
#                resolving them is the round's work, and publish-build.mjs pushes
#                nothing while one still has a marker
#   unmergeable  some conflict leaves no marker to resolve (a binary file, a file
#                deleted on one side, a symlink): Git would settle it silently,
#                so the merge is aborted, the branch is left WITHOUT main, and
#                unmergeable.txt lists those files; publish-build.mjs parks the PR
#   failed       the merge failed without a conflict (merge-main.log has why);
#                the branch is left as it was
set -euo pipefail
out="${1:?usage: merge-main.sh <out-dir>}"
BOT=(-c core.hooksPath=/dev/null -c core.fsmonitor=false -c merge.conflictStyle=zdiff3
     -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com")
: > "$out/conflicts.txt"
: > "$out/unmergeable.txt"
start="$(git rev-parse HEAD)"

if git "${BOT[@]}" merge --quiet --no-edit --no-verify origin/main >"$out/merge-main.log" 2>&1; then
  if [ "$(git rev-parse HEAD)" != "$start" ]; then echo merged; else echo clean; fi
  exit 0
fi

back() { git merge --abort >/dev/null 2>&1 || git reset --quiet --hard "$start"; }
git diff --name-only -z --diff-filter=U > "$out/conflicts.z"
if [ ! -s "$out/conflicts.z" ]; then back; echo failed; exit 0; fi

# A conflict the agent can resolve: both sides still have the file (stages 2
# and 3), it is a regular file, Git rewrote it (it is no longer this branch's
# version, which is what a binary conflict leaves) and it carries a marker.
marked() {
  local f="$1" stages ours
  [ -f "$f" ] && [ ! -L "$f" ] || return 1
  stages="$(git --literal-pathspecs ls-files -u -- "$f" | awk '{ print $3 }' | sort -u | tr -d '\n')"
  case "$stages" in *2*3*) ;; *) return 1 ;; esac
  ours="$(git --literal-pathspecs ls-files -u -- "$f" | awk '$3 == 2 { print $2; exit }')"
  [ "$(git hash-object --no-filters -- "$f")" != "$ours" ] || return 1
  grep -qE '^<{7}( |$)' -- "$f"
}
while IFS= read -r -d '' f; do
  marked "$f" || printf '%s\n' "$f" >> "$out/unmergeable.txt"
done < "$out/conflicts.z"
if [ -s "$out/unmergeable.txt" ]; then back; echo unmergeable; exit 0; fi

git --literal-pathspecs add -A --pathspec-from-file="$out/conflicts.z" --pathspec-file-nul
git "${BOT[@]}" commit --quiet --no-verify --no-edit
tr '\0' '\n' < "$out/conflicts.z" > "$out/conflicts.txt"
echo conflicts
