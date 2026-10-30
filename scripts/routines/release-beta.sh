#!/usr/bin/env bash
# Nightly beta release — the fire condition and the deterministic release cut
# for the routine described in docs/ROUTINES.md. Releases go beta first
# (VISION.md §8, docs/RELEASING.md): the tag this pushes makes release.yml
# publish a GitHub prerelease on the beta channel; the owner promotes later.
#
#   check   exit 0 when origin/main has commits since the latest v* tag that are
#           not only a release bump, CI is green on main's head, and no
#           `release` workflow run is in progress; else 1; errors: 2
#   run     cut the next patch version: temp worktree of origin/main → branch
#           release/v<next> → collect changesets → (record clips) → bump →
#           commit → PR (label `release`) → wait for CI → merge → tag v<next>.
#           Safe to re-run: reuses an open PR, and if the bump already landed on
#           main untagged, only tags it. On failure: no tag is left behind and
#           the PR gets a comment and is closed.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPO="${OCTOPUSH_ROUTINE_REPO:-$(cd "$ROOT" && this_repo)}"
OWNER="${REPO%%/*}"
CI_TIMEOUT="${OCTOPUSH_RELEASE_CI_TIMEOUT:-2700}"   # seconds (45 min)
CI_POLL="${OCTOPUSH_RELEASE_CI_POLL:-30}"           # seconds
# Optional commit trailers (e.g. attribution), one per line; none by default.
TRAILERS="${OCTOPUSH_RELEASE_TRAILERS:-}"

g() { git -C "$ROOT" "$@"; }

fetch() { g fetch --quiet --tags --force origin main || die "git fetch origin failed"; }

latest_tag() {
  g tag --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true
}

# Subjects since $1 that are not a release bump (its commit or its PR merge).
real_changes() {
  g log --format=%s "$1..origin/main" | grep -vE '^chore: release v[0-9]|^Merge pull request #[0-9]+ from [^ ]+/release/v[0-9]' || true
}

release_in_progress() {
  gh api "repos/$REPO/actions/workflows/release.yml/runs?per_page=20" \
    --jq '[.workflow_runs[] | select(.status != "completed")] | length'
}

# Prints a one-line reason; returns 0 (fire) / 1 (nothing to do). Errors exit 2.
should_release() {
  local prev changes sha ci busy
  prev="$(latest_tag)"
  [[ -n "$prev" ]] || die "no v* tag found — cut the first release by hand"
  changes="$(real_changes "$prev")"
  if [[ -z "$changes" ]]; then echo "nothing to release since $prev"; return 1; fi
  sha="$(g rev-parse origin/main)"
  ci="$(ci_status_for "$REPO" "$sha")" || die "could not read CI status for main ($sha)"
  if [[ "$ci" != "success" ]]; then echo "CI on main ($sha) is $ci — waiting"; return 1; fi
  busy="$(release_in_progress)" || die "could not list release workflow runs"
  if [[ "$busy" != "0" ]]; then echo "a release workflow run is in progress"; return 1; fi
  echo "$(echo "$changes" | wc -l | tr -d ' ') change(s) on main since $prev, CI green"
  return 0
}

# ── run ────────────────────────────────────────────────────────────

PR=""; TAG_CREATED=""; TAG_PUSHED=""; WT=""; BRANCH=""

cleanup() {
  if [[ -n "$TAG_CREATED" && -z "$TAG_PUSHED" ]]; then g tag -d "$TAG_CREATED" >/dev/null 2>&1 || true; fi
  if [[ -n "$WT" ]]; then
    g worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"
    g worktree prune >/dev/null 2>&1 || true
  fi
  if [[ -n "$BRANCH" ]]; then g branch -D "$BRANCH" >/dev/null 2>&1 || true; fi
}

fail() {
  echo "release-beta: FAILED — $*" >&2
  if [[ -n "$TAG_CREATED" && -z "$TAG_PUSHED" ]]; then
    g tag -d "$TAG_CREATED" >/dev/null 2>&1 || true
    TAG_CREATED=""
  fi
  if [[ -n "$PR" ]]; then
    gh api "repos/$REPO/issues/$PR/comments" -f body="Nightly beta release stopped: $*

No tag was pushed. Closing this PR; the next run starts over (\`bash scripts/routines/release-beta.sh run\`)." >/dev/null 2>&1 || true
    gh api -X PATCH "repos/$REPO/pulls/$PR" -f state=closed >/dev/null 2>&1 || true
  fi
  exit 2
}

wait_for_ci() {
  local sha="$1" waited=0 ci
  while :; do
    ci="$(ci_status_for "$REPO" "$sha" || echo error)"
    case "$ci" in
      success) echo "CI green on $sha"; return 0 ;;
      failure) fail "CI failed on the release PR (head $sha)" ;;
      pending|none|error) ;;
      *) fail "unexpected CI status '$ci'" ;;
    esac
    if [[ "$waited" -ge "$CI_TIMEOUT" ]]; then fail "CI did not finish within $((CI_TIMEOUT / 60)) min (last: $ci)"; fi
    sleep "$CI_POLL"; waited=$((waited + CI_POLL))
  done
}

tag_and_push() {
  local version="$1" sha="$2"
  if [[ -n "$(g ls-remote --tags origin "refs/tags/v$version")" ]]; then fail "tag v$version already exists on origin"; fi
  g fetch --quiet origin main || fail "git fetch origin failed"
  g merge-base --is-ancestor "$sha" origin/main || fail "$sha is not on origin/main"
  g tag -d "v$version" >/dev/null 2>&1 || true
  g tag -a "v$version" "$sha" -m "Octopush v$version" || fail "could not create tag v$version"
  TAG_CREATED="v$version"
  g push origin "refs/tags/v$version" || fail "could not push tag v$version"
  TAG_PUSHED=1
  echo "tagged $sha as v$version and pushed — release.yml now publishes the beta"
  echo "release: https://github.com/$REPO/releases/tag/v$version"
  echo "build:   https://github.com/$REPO/actions/workflows/release.yml"
}

print_notes() {
  echo "---- whats-new/$1/notes.md ----"
  g show "origin/main:whats-new/$1/notes.md" 2>/dev/null || echo "(no notes.md)"
}

do_run() {
  trap cleanup EXIT
  fetch
  local reason rc prev next main_version merge head x y z
  reason="$(should_release)" && rc=0 || rc=$?
  echo "$reason"
  [[ "$rc" == 0 ]] || exit "$rc"   # 1 = nothing to do, 2 = the check itself failed
  prev="$(latest_tag)"; prev="${prev#v}"
  IFS=. read -r x y z <<< "$prev"
  next="$x.$y.$((z + 1))"
  main_version="$(g show origin/main:package.json | sed -nE 's/^  "version": *"([^"]+)".*/\1/p' | head -n 1)"

  # Resume: the bump for <next> already merged but the tag never got pushed.
  if [[ "$main_version" == "$next" ]]; then
    merge="$(g log --merges --format='%H %s' "v$prev..origin/main" | grep -E "/release/v$next\$" | head -n 1 | cut -d' ' -f1 || true)"
    [[ -n "$merge" ]] || die "main is already at $next but has no release/v$next merge — tag it by hand"
    echo "v$next already merged ($merge) — tagging only"
    tag_and_push "$next" "$merge"
    print_notes "$next"
    return 0
  fi
  [[ "$main_version" == "$prev" ]] || die "main's package.json is $main_version but the latest tag is v$prev — reconcile by hand"

  BRANCH="release/v$next"
  WT="$(mktemp -d "${TMPDIR:-/tmp}/octopush-release.XXXXXX")"
  rmdir "$WT"
  g worktree add --quiet --detach "$WT" origin/main || fail "could not create a worktree of origin/main"
  git -C "$WT" checkout --quiet -B "$BRANCH" || fail "could not create branch $BRANCH"

  echo "installing dependencies"
  (cd "$WT" && npm ci --no-audit --no-fund) || fail "npm ci failed"

  echo "collecting changesets for $next (since v$prev)"
  (cd "$WT" && node scripts/whats-new.mjs collect "$next" --since "v$prev") || fail "whats-new collect failed"
  git -C "$WT" add -A whats-new || fail "git add whats-new failed"

  if grep -q '"clips:record"' "$WT/package.json"; then
    echo "recording clips"
    if (cd "$WT" && npm run clips:record -- "$next"); then
      git -C "$WT" add -A whats-new || fail "git add whats-new failed"
    else
      echo "clips:record failed — releasing without new clips (they are optional)" >&2
      git -C "$WT" checkout -- whats-new >/dev/null 2>&1 || true
      git -C "$WT" clean -fdq -- whats-new >/dev/null 2>&1 || true
    fi
  else
    echo "no clips:record script — skipping clips"
  fi

  echo "bumping versions to $next"
  node "$WT/scripts/release-lib.mjs" bump "$next" "$WT" || fail "version bump failed"
  git -C "$WT" add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json whats-new \
    || fail "git add failed"
  git -C "$WT" commit --quiet -m "chore: release v$next

$TRAILERS" || fail "git commit failed"
  head="$(git -C "$WT" rev-parse HEAD)"
  git -C "$WT" push --quiet --force origin "HEAD:refs/heads/$BRANCH" || fail "could not push $BRANCH"

  PR="$(gh api "repos/$REPO/pulls?state=open&head=$OWNER:$BRANCH&per_page=1" --jq '.[0].number // empty')" \
    || fail "could not look up an existing PR for $BRANCH"
  if [[ -z "$PR" ]]; then
    local body
    body="Nightly beta release of **v$next** (\`scripts/routines/release-beta.sh\`, docs/ROUTINES.md).

Merging this and tagging \`v$next\` publishes a **beta** (GitHub prerelease). Promote it to stable with \`promote.yml\` (docs/RELEASING.md).

$(cat "$WT/whats-new/$next/notes.md" 2>/dev/null || true)"
    PR="$(gh api "repos/$REPO/pulls" -f title="chore: release v$next" -f head="$BRANCH" -f base=main -f body="$body" --jq .number)" \
      || { PR=""; fail "could not open the release PR"; }
    echo "opened PR #$PR"
  else
    echo "reusing open PR #$PR"
  fi
  gh api "repos/$REPO/issues/$PR/labels" -f "labels[]=release" >/dev/null || fail "could not label PR #$PR"

  echo "waiting for CI on $head (≤ $((CI_TIMEOUT / 60)) min)"
  wait_for_ci "$head"

  merge="$(gh api -X PUT "repos/$REPO/pulls/$PR/merge" -f merge_method=merge -f sha="$head" --jq .sha)" \
    || fail "could not merge PR #$PR"
  [[ -n "$merge" ]] || fail "merge of PR #$PR returned no sha"
  echo "merged PR #$PR as $merge"
  local merged_pr="$PR"; PR=""   # from here on a failure must not close a merged PR

  tag_and_push "$next" "$merge"
  gh api -X DELETE "repos/$REPO/git/refs/heads/$BRANCH" >/dev/null 2>&1 || true
  echo "PR:      https://github.com/$REPO/pull/$merged_pr"
  echo "---- whats-new/$next/notes.md ----"
  cat "$WT/whats-new/$next/notes.md" 2>/dev/null || echo "(no notes.md)"
}

case "${1:-}" in
  check)
    fetch
    should_release
    ;;
  run) do_run ;;
  *) echo "usage: $0 check|run" >&2; exit 64 ;;
esac
