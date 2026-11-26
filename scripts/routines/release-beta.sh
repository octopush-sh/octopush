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
#           The tag only ever lands on a tree CI tested (#1063): the PR merges
#           only if its head still contains main (if main moved while CI ran,
#           the release is cut again from the new main, up to
#           OCTOPUSH_RELEASE_RECUTS times, and CI runs again), and the merge
#           commit must have the head's exact tree. Notes carry the changes of
#           versions tagged since the last published release whose build failed.
#           Safe to re-run: reuses an open PR, and if the bump already landed on
#           main untagged, only tags it — once CI passed on that tree; else CI
#           runs on that exact commit (branch release-check/v<version>), and a
#           red result abandons the version (tag abandoned/v<version>, never
#           v*): the next release takes the number after it and carries its
#           notes. On failure: no tag is left behind and the PR gets a comment
#           and is closed.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPO="${OCTOPUSH_ROUTINE_REPO:-$(cd "$ROOT" && this_repo)}"
OWNER="${REPO%%/*}"
CI_TIMEOUT="${OCTOPUSH_RELEASE_CI_TIMEOUT:-2700}"   # seconds (45 min)
CI_POLL="${OCTOPUSH_RELEASE_CI_POLL:-30}"           # seconds
CI_STARVED_RETRIES="${OCTOPUSH_RELEASE_CI_STARVED_RETRIES:-3}"   # re-runs of a CI that only lost its runner
# Times the release is cut again because main moved while CI ran on it (then it stops).
RECUTS="${OCTOPUSH_RELEASE_RECUTS:-1}"
# Tags walked back looking for the last published release (failed builds in between are carried).
CARRY_MAX=5
# How long the check waits for main's CI to settle (default the smaller of the
# CI timeout and 30 min): a merge minutes before the release window must not
# cost the day's beta. One deadline covers the waiting and any re-runs.
# Only in Actions: as a Mac Routine fire condition the check must stay quick.
if [[ "${GITHUB_ACTIONS:-}" == true ]]; then main_wait_default=$(( CI_TIMEOUT < 1800 ? CI_TIMEOUT : 1800 )); else main_wait_default=0; fi
MAIN_CI_WAIT="${OCTOPUSH_RELEASE_MAIN_CI_WAIT:-$main_wait_default}"
# In GitHub Actions (nightly-release.yml) pushes made with GITHUB_TOKEN start no
# workflows: OCTOPUSH_DISPATCH=1 dispatches CI on the release branch and the
# release build on the new tag explicitly.
DISPATCH="${OCTOPUSH_DISPATCH:-0}"

# In Actions the checkout keeps no credentials (persist-credentials: false):
# pushes authenticate per command with GH_TOKEN.
PUSH_AUTH=()
if [[ "$DISPATCH" == 1 && -n "${GH_TOKEN:-}" ]]; then
  PUSH_AUTH=(-c "http.https://github.com/.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')")
fi

dispatch() { # <workflow file> <ref>
  [[ "$DISPATCH" == 1 ]] || return 0
  gh api -X POST "repos/$REPO/actions/workflows/$1/dispatches" -f ref="$2" >/dev/null \
    && echo "dispatched $1 on $2"
}
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

# Main's CI for `sha` once it settles: waits while it runs (up to
# MAIN_CI_WAIT) and re-runs a run that only lost its macOS runner. Prints
# success | failure | pending | none; returns non-zero only on a gh error.
main_ci_settled() {
  local sha="$1" ci starved retries=0 start=$SECONDS
  while :; do
    ci="$(ci_status_for "$REPO" "$sha")" || return 1
    case "$ci" in
      success) echo success; return 0 ;;
      failure)
        starved="$(ci_starved_run_for "$REPO" "$sha" || true)"
        if [[ -n "$starved" && "$retries" -lt "$CI_STARVED_RETRIES" ]]; then
          retries=$((retries + 1))
          echo "main's CI run $starved only lost its runner — re-running it ($retries)" >&2
          gh api -X POST "repos/$REPO/actions/runs/$starved/rerun-failed-jobs" >/dev/null || { echo failure; return 0; }
        else
          echo failure; return 0
        fi ;;
    esac
    if (( SECONDS - start >= MAIN_CI_WAIT )); then echo "$ci"; return 0; fi
    sleep "$CI_POLL"
  done
}

main_pkg_version() { g show origin/main:package.json | sed -nE 's/^  "version": *"([^"]+)".*/\1/p' | head -n 1; }
next_after() { local x y z; IFS=. read -r x y z <<< "$1"; echo "$x.$y.$((z + 1))"; }
abandoned() { [[ -n "$(g tag --list "abandoned/v$1")" ]]; }
# The version main carries when its release merged but was never tagged (and
# not abandoned), or nothing.
pending_version() {
  local prev="${1#v}" mv
  mv="$(main_pkg_version)"
  if [[ "$mv" == "$(next_after "$prev")" ]] && ! abandoned "$mv"; then echo "$mv"; fi
}

# Prints a one-line reason; returns 0 (fire) / 1 (nothing to do). Errors exit 2.
should_release() {
  local prev changes sha ci busy
  prev="$(latest_tag)"
  [[ -n "$prev" ]] || die "no v* tag found — cut the first release by hand"
  changes="$(real_changes "$prev")"
  if [[ -z "$changes" ]]; then echo "nothing to release since $prev"; return 1; fi
  # A release merged but never tagged is verified on its own merge commit by
  # `run`, whatever main's head says: waiting for a green head could wait forever.
  local pending
  pending="$(pending_version "$prev")"
  if [[ -n "$pending" ]]; then
    busy="$(release_in_progress)" || die "could not list release workflow runs"
    if [[ "$busy" != "0" ]]; then echo "a release workflow run is in progress"; return 1; fi
    echo "v$pending is merged on main but not tagged — verifying it"
    return 0
  fi
  sha="$(g rev-parse origin/main)"
  ci="$(main_ci_settled "$sha")" || die "could not read CI status for main ($sha)"
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
  local sha="$1" waited=0 ci starved retries=0
  while :; do
    ci="$(ci_status_for "$REPO" "$sha" || echo error)"
    case "$ci" in
      success) echo "CI green on $sha"; return 0 ;;
      failure)
        # A job GitHub never gave a runner (macOS capacity) is not a test
        # failure: re-run it, a few times, instead of abandoning the release.
        starved="$(ci_starved_run_for "$REPO" "$sha" || true)"
        if [[ -n "$starved" && "$retries" -lt "$CI_STARVED_RETRIES" ]]; then
          retries=$((retries + 1))
          echo "CI run $starved only had cancelled jobs (no runner) — re-running them ($retries)"
          gh api -X POST "repos/$REPO/actions/runs/$starved/rerun-failed-jobs" >/dev/null || fail "could not re-run CI run $starved"
          waited=0   # each re-run gets the full CI timeout
          sleep "$CI_POLL"; continue
        else
          fail "CI failed on the release PR (head $sha)"
        fi ;;
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
  g "${PUSH_AUTH[@]}" push origin "refs/tags/v$version" || fail "could not push tag v$version"
  TAG_PUSHED=1
  dispatch release.yml "v$version" || fail "could not start release.yml on v$version"
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
  local reason rc prev next main_version merge head tested
  reason="$(should_release)" && rc=0 || rc=$?
  echo "$reason"
  [[ "$rc" == 0 ]] || exit "$rc"   # 1 = nothing to do, 2 = the check itself failed
  prev="$(latest_tag)"; prev="${prev#v}"
  next="$(next_after "$prev")"
  main_version="$(main_pkg_version)"

  if [[ "$main_version" == "$next" ]] && abandoned "$next"; then
    # Its merge failed CI: that number is spent. The release after it carries its notes.
    echo "v$next was abandoned (CI failed on its merge) — releasing v$(next_after "$next") from main"
    prev="$next"; next="$(next_after "$next")"
  elif [[ "$main_version" == "$next" ]]; then
    # Resume: the bump for <next> already merged but the tag never got pushed.
    merge="$(g log --merges --format='%H %s' "v$prev..origin/main" | grep -E "/release/v$next\$" | head -n 1 | cut -d' ' -f1 || true)"
    [[ -n "$merge" ]] || die "main is already at $next but has no release/v$next merge — tag it by hand"
    if tested="$(merge_tested "$merge")"; then
      echo "v$next already merged ($merge; $tested) — tagging only"
    else
      echo "v$next is merged ($merge) but untested: $tested — running CI on that commit"
      verify_merge "$next" "$merge" && rc=0 || rc=$?
      case "$rc" in
        0) echo "CI green on v$next's merge — tagging it" ;;
        1) abandon "$next" "$merge"
           die "v$next abandoned: CI failed on its merge $merge. The next run releases v$(next_after "$next") from main once main is green" ;;
        *) die "CI on v$next's merge $merge did not give a verdict (timeout or no runner) — the next run checks it again" ;;
      esac
    fi
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
  install_deps

  local base cuts=0 main_now
  base="$(git -C "$WT" rev-parse HEAD)"
  while :; do
    cut_release "$next" "$prev"
    head="$HEAD_SHA"
    echo "waiting for CI on $head (≤ $((CI_TIMEOUT / 60)) min)"
    wait_for_ci "$head"
    # The PR merges with a merge commit: unless its head still contains main,
    # that commit — the one tagged — is a tree CI never built (#1063).
    g fetch --quiet origin main || fail "git fetch origin failed"
    main_now="$(g rev-parse origin/main)"
    if g merge-base --is-ancestor "$main_now" "$head"; then break; fi
    cuts=$((cuts + 1))
    if [[ "$cuts" -gt "$RECUTS" ]]; then
      fail "main moved to $main_now while CI ran on the release (cut $cuts times) — stopping so nothing untested is tagged; the next run starts over"
    fi
    echo "main moved to $main_now while CI ran on $head — cutting v$next again from it ($cuts of $RECUTS)"
    git -C "$WT" checkout --quiet --force -B "$BRANCH" origin/main || fail "could not reset $BRANCH to origin/main"
    git -C "$WT" clean -fdq -- whats-new >/dev/null 2>&1 || true
    if ! git -C "$WT" diff --quiet "$base" HEAD -- package-lock.json; then install_deps; fi
    base="$(git -C "$WT" rev-parse HEAD)"
  done

  merge="$(gh api -X PUT "repos/$REPO/pulls/$PR/merge" -f merge_method=merge -f sha="$head" --jq .sha)" \
    || fail "could not merge PR #$PR"
  [[ -n "$merge" ]] || fail "merge of PR #$PR returned no sha"
  echo "merged PR #$PR as $merge"
  local merged_pr="$PR"; PR=""   # from here on a failure must not close a merged PR

  # Main can still move between the check above and the merge: tag only a tree CI tested.
  g fetch --quiet origin main || fail "git fetch origin failed"
  if [[ "$(g rev-parse "$merge^{tree}")" != "$(g rev-parse "$head^{tree}")" ]]; then
    echo "main moved during the merge: $merge is not the tree CI tested on $head — running CI on the merge itself"
    verify_merge "$next" "$merge" && rc=0 || rc=$?
    case "$rc" in
      0) echo "CI green on the merge $merge" ;;
      1) abandon "$next" "$merge"
         fail "v$next abandoned: CI failed on its merge $merge (main moved during the merge). The next run releases v$(next_after "$next") from main once main is green" ;;
      *) fail "CI on the merge $merge did not give a verdict (timeout or no runner): not tagged — the next run checks it again" ;;
    esac
  fi

  tag_and_push "$next" "$merge"
  gh api -X DELETE "repos/$REPO/git/refs/heads/$BRANCH" >/dev/null 2>&1 || true
  echo "PR:      https://github.com/$REPO/pull/$merged_pr"
  echo "---- whats-new/$next/notes.md ----"
  cat "$WT/whats-new/$next/notes.md" 2>/dev/null || echo "(no notes.md)"
}

# CI on one exact commit, the release PR's merge: pushed as its own branch
# (release-check/v<version>, so no other dispatch on main can cancel it) and
# waited for. Only runs on that branch count. Returns 0 green, 1 red, 2 no
# verdict (timeout, or only lost runners after the re-runs: "retry", not red).
verify_merge() {
  local version="$1" merge="$2" ref="release-check/v$1" ci starved retries=0 waited=0 rc
  g "${PUSH_AUTH[@]}" push --quiet --force origin "$merge:refs/heads/$ref" || { echo "could not push $ref" >&2; return 2; }
  gh api -X POST "repos/$REPO/actions/workflows/ci.yml/dispatches" -f ref="$ref" >/dev/null || { echo "could not start CI on $ref" >&2; return 2; }
  echo "CI started on $ref ($merge)"
  while :; do
    ci="$(ci_status_on_ref "$REPO" "$merge" "$ref" || echo error)"
    case "$ci" in
      success) rc=0; break ;;
      failure)
        starved="$(ci_starved_run_for "$REPO" "$merge" || true)"
        if [[ -n "$starved" && "$retries" -lt "$CI_STARVED_RETRIES" ]]; then
          retries=$((retries + 1))
          echo "CI run $starved on $ref only lost its runner — re-running it ($retries)"
          gh api -X POST "repos/$REPO/actions/runs/$starved/rerun-failed-jobs" >/dev/null || { rc=2; break; }
          waited=0; sleep "$CI_POLL"; continue
        fi
        if [[ -n "$starved" ]]; then rc=2; else rc=1; fi
        break ;;
    esac
    if [[ "$waited" -ge "$CI_TIMEOUT" ]]; then rc=2; break; fi
    sleep "$CI_POLL"; waited=$((waited + CI_POLL))
  done
  g "${PUSH_AUTH[@]}" push --quiet origin ":refs/heads/$ref" >/dev/null 2>&1 || true
  return "$rc"
}

# success | pending | failure | none — like lib.sh ci_status_for, counting only runs on `ref`.
ci_status_on_ref() {
  gh api "repos/$1/actions/runs?head_sha=$2&per_page=50" --jq '
    [.workflow_runs[] | select(.name == "CI" and .head_branch == "'"$3"'")
      | select(.status != "waiting")
      | select((.status == "completed" and ((.conclusion // "") | IN("action_required", "cancelled", "skipped", "stale", "neutral"))) | not)]
    | sort_by(.created_at) | last |
    if . == null then "none"
    elif .status != "completed" then "pending"
    elif .conclusion == "success" then "success"
    else "failure" end'
}

# Give up a version whose merge failed CI: tag abandoned/v<version> on it (no
# v* tag, so no release build and no "latest tag"); its number is spent.
abandon() {
  local version="$1" merge="$2"
  g tag -a -f "abandoned/v$version" "$merge" -m "Octopush v$version abandoned: CI failed on its merge" || return 1
  g "${PUSH_AUTH[@]}" push --quiet --force origin "refs/tags/abandoned/v$version" || { echo "could not push abandoned/v$version" >&2; return 1; }
  echo "abandoned v$version (tag abandoned/v$version on $merge)"
}

# Was `merge` (the release PR's merge commit) tested? Yes when CI passed on it,
# or when it has exactly the tree of its second parent (the PR head) and CI
# passed on that head. Prints the CI status that decided; returns 1 if untested.
merge_tested() {
  local merge="$1" head ci
  ci="$(ci_status_for "$REPO" "$merge" || echo error)"
  if [[ "$ci" == success ]]; then echo "CI green on the merge $merge"; return 0; fi
  head="$(g rev-parse --verify --quiet "$merge^2" || true)"
  if [[ -n "$head" && "$(g rev-parse "$merge^{tree}")" == "$(g rev-parse "$head^{tree}")" ]]; then
    ci="$(ci_status_for "$REPO" "$head" || echo error)"
    if [[ "$ci" == success ]]; then echo "the merge $merge has the tree CI passed on ($head)"; return 0; fi
  fi
  echo "CI is $ci on the merge $merge and its tree is not one CI passed on"
  return 1
}

# The versions to carry into this release's notes, and where its changes start.
# --since is the newest v* tag with a published GitHub release. Carried: every
# collected version on main (whats-new/X.Y.Z/) after it that was never
# published — its tagged build failed, or its merge failed CI and was
# abandoned — at most CARRY_MAX. Prints "<since-tag> <comma-separated
# versions>"; falls back to "<prev-tag> " (carry nothing) when the releases
# can't be read or no published one is within reach.
carry_plan() {
  local prev="$1" wt="$2" next="$3" published tag since="" carry="" n=0 d v
  if ! published="$(gh api "repos/$REPO/releases?per_page=100" --jq '.[] | select(.draft | not) | .tag_name')"; then
    echo "could not list the published releases — carrying no failed build's notes" >&2
    echo "$prev "; return 0
  fi
  while read -r tag; do
    [[ -n "$tag" ]] || continue
    if grep -qxF -- "$tag" <<< "$published"; then since="$tag"; break; fi
    n=$((n + 1)); [[ "$n" -le "$CARRY_MAX" ]] || break
  done <<< "$(g tag --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true)"
  if [[ -z "$since" ]]; then echo "$prev "; return 0; fi
  while read -r v; do
    [[ -n "$v" && "$v" != "$next" && "$v" != "${since#v}" ]] || continue
    [[ "$(printf '%s\n%s\n' "${since#v}" "$v" | sort -V | tail -n 1)" == "$v" ]] || continue   # newer than since
    grep -qxF -- "v$v" <<< "$published" && continue
    carry="${carry:+$carry,}$v"
  done <<< "$(for d in "$wt"/whats-new/*/; do d="${d%/}"; d="${d##*/}"; [[ "$d" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && echo "$d"; done | sort -V | tail -n "$CARRY_MAX")"
  echo "$since $carry"
}

# Cut (or cut again) release/v<next> in the worktree from origin/main: collect,
# clips, bump, commit, push, CI, PR. Sets HEAD_SHA.
HEAD_SHA=""
cut_release() {
  local next="$1" prev="$2" plan since carry body
  plan="$(carry_plan "v$prev" "$WT" "$next")"
  since="${plan%% *}"; carry="${plan#* }"
  echo "collecting changesets for $next (since $since${carry:+; carrying $carry, never published})"
  (cd "$WT" && node scripts/whats-new.mjs collect "$next" --since "$since" ${carry:+--carry "$carry"}) || fail "whats-new collect failed"
  git -C "$WT" add -A whats-new || fail "git add whats-new failed"

  # Recording clips runs the app's frontend (agent work) — never next to the
  # GitHub token, so not in Actions. Clips are optional.
  if [[ "${OCTOPUSH_SKIP_CLIPS:-0}" == 1 ]]; then
    echo "OCTOPUSH_SKIP_CLIPS=1 — releasing without new clips"
  elif grep -q '"clips:record"' "$WT/package.json"; then
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
  HEAD_SHA="$(git -C "$WT" rev-parse HEAD)"
  git -C "$WT" "${PUSH_AUTH[@]}" push --quiet --force origin "HEAD:refs/heads/$BRANCH" || fail "could not push $BRANCH"
  dispatch ci.yml "$BRANCH" || fail "could not start CI on $BRANCH"

  body="Nightly beta release of **v$next** (\`scripts/routines/release-beta.sh\`, docs/ROUTINES.md).

Merging this and tagging \`v$next\` publishes a **beta** (GitHub prerelease). Promote it to stable with \`promote.yml\` (docs/RELEASING.md).

$(cat "$WT/whats-new/$next/notes.md" 2>/dev/null || true)"
  if [[ -z "$PR" ]]; then
    PR="$(gh api "repos/$REPO/pulls?state=open&head=$OWNER:$BRANCH&per_page=1" --jq '.[0].number // empty')" \
      || fail "could not look up an existing PR for $BRANCH"
    if [[ -z "$PR" ]]; then
      PR="$(gh api "repos/$REPO/pulls" -f title="chore: release v$next" -f head="$BRANCH" -f base=main -f body="$body" --jq .number)" \
        || { PR=""; fail "could not open the release PR"; }
      echo "opened PR #$PR"
    else
      echo "reusing open PR #$PR"
    fi
    gh api "repos/$REPO/issues/$PR/labels" -f "labels[]=release" >/dev/null || fail "could not label PR #$PR"
  else
    # Cut again: same PR, new head; its description follows the new notes.
    gh api -X PATCH "repos/$REPO/pulls/$PR" -f body="$body" >/dev/null || echo "could not update PR #$PR's description" >&2
  fi
}

install_deps() {
  echo "installing dependencies"
  # In Actions, no install scripts: main's src/ is agent work and must not run where the token is.
  if [[ "$DISPATCH" == 1 ]]; then
    (cd "$WT" && npm ci --no-audit --no-fund --ignore-scripts) || fail "npm ci failed"
  else
    (cd "$WT" && npm ci --no-audit --no-fund) || fail "npm ci failed"
  fi
}

case "${1:-}" in
  check)
    fetch
    should_release
    ;;
  run) do_run ;;
  *) echo "usage: $0 check|run" >&2; exit 64 ;;
esac
