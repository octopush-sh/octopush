// Run with: node --test scripts/release-beta.test.mjs
//
// Drives scripts/routines/release-beta.sh against a throwaway git repo with a
// local bare "origin" (real git, no network) and stubbed `gh` and `npm` on
// PATH. The `gh` stub prints what each REST call's --jq would yield, logs every
// call, and performs the PR merge on the bare origin so tagging is real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = "octo/app";
const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
};

const GH_STUB = `#!/usr/bin/env bash
echo "gh $*" >> "$STUB_LOG"
[[ "\${STUB_GH_FAIL:-0}" == 1 ]] && { echo "gh: HTTP 401" >&2; exit 1; }
args="$*"
case "$args" in
  *"actions/runs?head_sha="*) echo "\${STUB_CI:-success}" ;;
  *"actions/workflows/release.yml/runs"*) echo "\${STUB_RELEASE_BUSY:-0}" ;;
  *"pulls?state=open&head="*) echo "\${STUB_OPEN_PR:-}" ;;
  *"-X PUT"*"/pulls/"*"/merge"*)
    sha="$(echo "$args" | sed -nE 's/.*sha=([0-9a-f]+).*/\\1/p')"
    work="$(mktemp -d)"
    git clone --quiet "$STUB_ORIGIN" "$work" && cd "$work" \\
      && git merge --quiet --no-ff "$sha" -m "Merge pull request #42 from octo/$STUB_BRANCH" \\
      && git push --quiet origin HEAD:main && git rev-parse HEAD
    ;;
  *"repos/${SLUG}/pulls "*"-f title="*) echo 42 ;;
  *"repos/${SLUG}/releases?per_page="*) printf '%s\\n' \${STUB_PUBLISHED-v0.4.89} ;;
  *) : ;;
esac
`;

const NPM_STUB = `#!/usr/bin/env bash
echo "npm $*" >> "$STUB_LOG"
case "$1" in
  ci) ln -s "$REAL_NODE_MODULES" node_modules ;;
  run) [[ "\${STUB_CLIPS_FAIL:-0}" == 1 ]] && exit 1; : ;;
esac
`;

const CHANGESET = `---
title: A nicer thing
kind: feature
area: app
---
Something users will notice.
`;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" }).trim();
}

/** A bare origin at v0.4.89 (+ optional commits after the tag) and a "main workspace" clone. */
function fixture({ after = ["Merge pull request #7 from octo/feature-x"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "release-beta-"));
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  git(dir, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(dir, "clone", "--quiet", origin, seed);
  const put = (rel, text) => { mkdirSync(dirname(join(seed, rel)), { recursive: true }); writeFileSync(join(seed, rel), text); };
  const copy = (rel) => { mkdirSync(dirname(join(seed, rel)), { recursive: true }); copyFileSync(join(REPO_ROOT, rel), join(seed, rel)); };
  for (const f of ["scripts/whats-new.mjs", "scripts/release-lib.mjs", "scripts/routines/lib.sh", "scripts/routines/release-beta.sh"]) copy(f);
  put("package.json", '{\n  "name": "octopush",\n  "version": "0.4.89",\n  "scripts": {\n    "clips:record": "true"\n  }\n}\n');
  put("src-tauri/Cargo.toml", '[package]\nname = "octopush"\nversion = "0.4.89"\n');
  put("src-tauri/Cargo.lock", '[[package]]\nname = "octopush"\nversion = "0.4.89"\n');
  put("src-tauri/tauri.conf.json", '{\n  "productName": "Octopush",\n  "version": "0.4.89"\n}\n');
  put("whats-new/unreleased/README.md", "readme\n");
  put(".gitignore", "node_modules\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "base");
  git(seed, "tag", "-a", "v0.4.89", "-m", "v0.4.89");
  for (const [i, subject] of after.entries()) {
    if (i === 0) put("whats-new/unreleased/a-nicer-thing.md", CHANGESET);
    put(`notes-${i}.txt`, subject);
    git(seed, "add", "-A");
    git(seed, "commit", "--quiet", "-m", subject);
  }
  git(seed, "push", "--quiet", "origin", "main", "--tags");
  const ws = join(dir, "ws");
  git(dir, "clone", "--quiet", origin, ws);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), GH_STUB); chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(bin, "npm"), NPM_STUB); chmodSync(join(bin, "npm"), 0o755);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  return { dir, origin, ws, bin, log };
}

function routine(fx, cmd, env = {}) {
  const r = spawnSync("bash", [join(fx.ws, "scripts/routines/release-beta.sh"), cmd], {
    cwd: fx.ws,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env, ...GIT_ENV,
      PATH: `${fx.bin}:${process.env.PATH}`,
      OCTOPUSH_ROUTINES_KEEP_PATH: "1",
      OCTOPUSH_ROUTINE_REPO: SLUG,
      OCTOPUSH_RELEASE_CI_POLL: "0",
      OCTOPUSH_RELEASE_CI_TIMEOUT: "0",
      STUB_LOG: fx.log,
      STUB_ORIGIN: fx.origin,
      STUB_BRANCH: "release/v0.4.90",
      REAL_NODE_MODULES: join(REPO_ROOT, "node_modules"),
      TMPDIR: fx.dir,
      ...env,
    },
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}`, calls: readFileSync(fx.log, "utf8").split("\n").filter(Boolean) };
}

const originTags = (fx) => git(fx.origin, "tag", "--list");

test("check: nothing since the latest tag → exit 1", () => {
  const fx = fixture({ after: [] });
  const r = routine(fx, "check");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /nothing to release since v0\.4\.89/);
  rmSync(fx.dir, { recursive: true, force: true });
});

test("check: only a release bump since the tag → exit 1", () => {
  const fx = fixture({ after: ["chore: release v0.4.90", "Merge pull request #9 from octo/release/v0.4.90"] });
  const r = routine(fx, "check");
  assert.equal(r.code, 1, r.out);
  rmSync(fx.dir, { recursive: true, force: true });
});

test("check: CI pending on main → exit 1", () => {
  const fx = fixture();
  const r = routine(fx, "check", { STUB_CI: "pending" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /is pending/);
  rmSync(fx.dir, { recursive: true, force: true });
});

test("check: main's CI still running waits for it; one that lost its runner is re-run", () => {
  const fx = fixture();
  const gh = join(fx.bin, "gh");
  // CI reads for main: pending, then failed with only cancelled jobs (no
  // runner), then green after the re-run.
  writeFileSync(gh, GH_STUB.replace(
    '*"actions/runs?head_sha="*) echo "${STUB_CI:-success}" ;;',
    `*"actions/runs?head_sha="*'.conclusion == "failure"'*) echo 555 ;;
  *"actions/runs/555/jobs"*) echo 555 ;;
  *"actions/runs?head_sha="*) n=$(cat "$STUB_LOG.n" 2>/dev/null || echo 0); echo $((n + 1)) > "$STUB_LOG.n"; case "$n" in 0) echo pending ;; 1) echo failure ;; *) echo success ;; esac ;;`,
  ));
  const r = routine(fx, "check", { OCTOPUSH_RELEASE_MAIN_CI_WAIT: "30" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /re-running it \(1\)/);
  assert.ok(r.calls.some((c) => /actions\/runs\/555\/rerun-failed-jobs/.test(c)), r.calls.join("\n"));
  rmSync(fx.dir, { recursive: true, force: true });
});

test("check: a release run in progress → exit 1", () => {
  const fx = fixture();
  const r = routine(fx, "check", { STUB_RELEASE_BUSY: "1" });
  assert.equal(r.code, 1, r.out);
  rmSync(fx.dir, { recursive: true, force: true });
});

test("check: gh error → exit 2 (for check and run)", () => {
  const fx = fixture();
  assert.equal(routine(fx, "check", { STUB_GH_FAIL: "1" }).code, 2);
  const r = routine(fx, "run", { STUB_GH_FAIL: "1" });
  assert.equal(r.code, 2, r.out);
  assert.equal(originTags(fx), "v0.4.89");
  rmSync(fx.dir, { recursive: true, force: true });
});

test("check: changes + green CI + idle release → exit 0", () => {
  const fx = fixture();
  const r = routine(fx, "check");
  assert.equal(r.code, 0, r.out);
  rmSync(fx.dir, { recursive: true, force: true });
});

test("run: collect → bump → PR → wait → merge → tag, then nothing left to do", () => {
  const fx = fixture();
  const r = routine(fx, "run");
  assert.equal(r.code, 0, r.out);

  // The release commit (on the PR branch, merged into main) has notes + bump.
  const files = git(fx.origin, "show", "--name-only", "--format=%s%n%b", "main^2");
  assert.match(files, /^chore: release v0\.4\.90/);
  assert.doesNotMatch(files, /Co-Authored-By/, "no trailers unless OCTOPUSH_RELEASE_TRAILERS is set");
  assert.match(files, /whats-new\/0\.4\.90\/notes\.md/);
  assert.match(files, /whats-new\/0\.4\.90\/a-nicer-thing\.md/);
  for (const f of ["package.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json"]) {
    assert.match(files, new RegExp(f.replace(/\./g, "\\.")));
    assert.match(git(fx.origin, "show", `main:${f}`), /0\.4\.90/);
  }
  assert.match(git(fx.origin, "show", "main:whats-new/0.4.90/notes.md"), /A nicer thing/);

  // Annotated tag on the merge commit, pushed.
  assert.equal(git(fx.origin, "rev-parse", "v0.4.90^{commit}"), git(fx.origin, "rev-parse", "main"));
  assert.equal(git(fx.origin, "cat-file", "-t", "v0.4.90"), "tag");

  // Order of operations.
  const head = git(fx.origin, "rev-parse", "main^2");
  const at = (re) => {
    const i = r.calls.findIndex((c) => re.test(c));
    assert.ok(i >= 0, `missing call ${re}\n${r.calls.join("\n")}`);
    return i;
  };
  const order = [
    at(/^npm ci/),
    at(/^npm run clips:record -- 0\.4\.90/),
    at(/^gh api repos\/octo\/app\/pulls -f title=chore: release v0\.4\.90/),
    at(/issues\/42\/labels -f labels\[\]=release/),
    at(new RegExp(`actions/runs\\?head_sha=${head}`)),
    at(new RegExp(`-X PUT repos/octo/app/pulls/42/merge -f merge_method=merge -f sha=${head}`)),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order, r.calls.join("\n"));
  assert.match(r.out, /releases\/tag\/v0\.4\.90/);
  // The temp worktree is gone.
  assert.equal(git(fx.ws, "worktree", "list").split("\n").length, 1);

  // Re-run: nothing new since v0.4.90.
  const again = routine(fx, "check");
  assert.equal(again.code, 1, again.out);
  rmSync(fx.dir, { recursive: true, force: true });
});

test("run: clips failing is not fatal", () => {
  const fx = fixture();
  const r = routine(fx, "run", { STUB_CLIPS_FAIL: "1" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /clips:record failed/);
  assert.equal(git(fx.origin, "cat-file", "-t", "v0.4.90"), "tag");
  rmSync(fx.dir, { recursive: true, force: true });
});

test("run: CI fails on the PR → exit 2, no tag, PR commented and closed", () => {
  const fx = fixture();
  // Main's CI is green (so check passes) but the PR's CI fails: the stub
  // answers per call, so flip it after the check by making every CI read
  // "failure" except the first one.
  const ghFlip = join(fx.bin, "gh");
  writeFileSync(ghFlip, GH_STUB.replace(
    '*"actions/runs?head_sha="*) echo "${STUB_CI:-success}" ;;',
    '*"actions/runs?head_sha="*) if grep -q head_sha "$STUB_LOG.seen" 2>/dev/null; then echo failure; else echo head_sha > "$STUB_LOG.seen"; echo success; fi ;;',
  ));
  const r = routine(fx, "run");
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /CI failed on the release PR/);
  assert.equal(originTags(fx), "v0.4.89");
  assert.equal(git(fx.ws, "tag", "--list", "v0.4.90"), "");
  assert.ok(r.calls.some((c) => /issues\/42\/comments/.test(c)), r.calls.join("\n"));
  assert.ok(r.calls.some((c) => /-X PATCH repos\/octo\/app\/pulls\/42 -f state=closed/.test(c)), r.calls.join("\n"));
  assert.ok(!r.calls.some((c) => /\/merge/.test(c)));
  rmSync(fx.dir, { recursive: true, force: true });
});

test("run: a PR CI that only lost its runner is re-run, then the release goes on", () => {
  const fx = fixture();
  // CI reads: main green (check), the PR's run failed with only cancelled jobs
  // (no macOS runner), then green after the re-run.
  const gh = join(fx.bin, "gh");
  writeFileSync(gh, GH_STUB.replace(
    '*"actions/runs?head_sha="*) echo "${STUB_CI:-success}" ;;',
    `*"actions/runs?head_sha="*'.conclusion == "failure"'*) echo 777 ;;
  *"actions/runs/777/jobs"*) echo 777 ;;
  *"actions/runs?head_sha="*) n=$(cat "$STUB_LOG.n" 2>/dev/null || echo 0); echo $((n + 1)) > "$STUB_LOG.n"; if [ "$n" = 1 ]; then echo failure; else echo success; fi ;;`,
  ));
  const r = routine(fx, "run");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /re-running them \(1\)/);
  assert.ok(r.calls.some((c) => /-X POST repos\/octo\/app\/actions\/runs\/777\/rerun-failed-jobs/.test(c)), r.calls.join("\n"));
  assert.match(originTags(fx), /v0\.4\.90/);
  rmSync(fx.dir, { recursive: true, force: true });
});

test("run: re-run after a merged-but-untagged release only tags", () => {
  const fx = fixture();
  // Simulate: the merge landed, the tag push never happened.
  const first = routine(fx, "run");
  assert.equal(first.code, 0, first.out);
  git(fx.origin, "tag", "-d", "v0.4.90");
  git(fx.ws, "tag", "-d", "v0.4.90");
  writeFileSync(fx.log, "");
  const r = routine(fx, "run");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /already merged/);
  assert.equal(git(fx.origin, "rev-parse", "v0.4.90^{commit}"), git(fx.origin, "rev-parse", "main"));
  assert.ok(!r.calls.some((c) => /-f title=/.test(c)), "no second PR");
  assert.ok(existsSync(fx.ws));
  rmSync(fx.dir, { recursive: true, force: true });
});

/** A stub line that pushes one more commit (with a changeset) to the bare origin's main, as a merge landing would. */
const MOVE_MAIN = (slug, title) => `( w="$(mktemp -d)"; git clone --quiet "$STUB_ORIGIN" "$w" && cd "$w" && mkdir -p whats-new/unreleased \\
  && printf -- '---\\ntitle: ${title}\\nkind: fix\\narea: app\\n---\\nIt landed while CI ran.\\n' > whats-new/unreleased/${slug}.md \\
  && git add -A && git commit --quiet -m "Merge pull request #8 from octo/${slug}" && git push --quiet origin HEAD:main ) >/dev/null 2>&1`;
const CI_LINE = '*"actions/runs?head_sha="*) echo "${STUB_CI:-success}" ;;';
/** CI reads: the first is main's (the check); on read number `at` (or every read from it, with `always`) main moves. */
const moveMainOnCi = (fx, { at = 1, always = false } = {}) => writeFileSync(join(fx.bin, "gh"), GH_STUB.replace(CI_LINE,
  `*"actions/runs?head_sha="*) n=$(cat "$STUB_LOG.n" 2>/dev/null || echo 0); echo $((n + 1)) > "$STUB_LOG.n"
    if [ "$n" ${always ? "-ge" : "-eq"} ${at} ]; then ${MOVE_MAIN("landed-meanwhile-$n", "Landed meanwhile $n")}; fi; echo success ;;`));

test("run: main moved while CI ran → the release is cut again from the new main, tested, merged and tagged", () => {
  const fx = fixture();
  moveMainOnCi(fx);
  const r = routine(fx, "run");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /main moved to [0-9a-f]{40} while CI ran on [0-9a-f]{40} — cutting v0\.4\.90 again from it \(1 of 1\)/);
  const head = git(fx.origin, "rev-parse", "main^2");
  const puts = r.calls.filter((c) => /-X PUT .*\/merge/.test(c));
  assert.equal(puts.length, 1, r.calls.join("\n"));
  assert.match(puts[0], new RegExp(`sha=${head} `), "the head CI ran on last is the one merged");
  assert.equal(git(fx.origin, "rev-parse", "main^{tree}"), git(fx.origin, "rev-parse", "main^2^{tree}"), "the tagged merge is exactly the tested tree");
  assert.equal(git(fx.origin, "rev-parse", "v0.4.90^{commit}"), git(fx.origin, "rev-parse", "main"));
  const notes = git(fx.origin, "show", "main:whats-new/0.4.90/notes.md");
  assert.match(notes, /A nicer thing/);
  assert.match(notes, /Landed meanwhile/, "what landed meanwhile is in the release and its notes");
  assert.ok(r.calls.some((c) => /-X PATCH repos\/octo\/app\/pulls\/42 -f body=/.test(c)), "the PR's description follows the new cut");
  rmSync(fx.dir, { recursive: true, force: true });
});

test("run: main keeps moving → stops after the allowed re-cuts: no merge, no tag, PR closed", () => {
  const fx = fixture();
  moveMainOnCi(fx, { always: true });
  const r = routine(fx, "run");
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /stopping so nothing untested is tagged/);
  assert.ok(!r.calls.some((c) => /\/merge/.test(c)), r.calls.join("\n"));
  assert.equal(originTags(fx), "v0.4.89");
  assert.ok(r.calls.some((c) => /-X PATCH repos\/octo\/app\/pulls\/42 -f state=closed/.test(c)));
  const calm = fixture();
  assert.equal(routine(calm, "run", { OCTOPUSH_RELEASE_RECUTS: "0" }).code, 0, "with no move, RECUTS=0 changes nothing");
  rmSync(fx.dir, { recursive: true, force: true });
  rmSync(calm.dir, { recursive: true, force: true });
});

test("run: main moved during the merge → that merge is not tagged; a later run tags it only once CI passed on it", () => {
  const fx = fixture();
  const gh = join(fx.bin, "gh");
  writeFileSync(gh, GH_STUB
    .replace(CI_LINE, `*"actions/runs?head_sha="*) s="$(echo "$args" | sed -nE 's/.*head_sha=([0-9a-f]+).*/\\1/p')"; if [ -f "$STUB_LOG.ci.$s" ]; then cat "$STUB_LOG.ci.$s"; else echo "\${STUB_CI:-success}"; fi ;;`)
    .replace('    work="$(mktemp -d)"', `    if [ ! -f "$STUB_LOG.raced" ]; then touch "$STUB_LOG.raced"; ${MOVE_MAIN("raced", "Raced the merge")}; fi
    work="$(mktemp -d)"`));
  const r = routine(fx, "run");
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /main moved during the merge: [0-9a-f]{40} is not the tree CI tested/);
  assert.equal(originTags(fx), "v0.4.89", "nothing untested is tagged");
  const merge = git(fx.origin, "rev-parse", "main");
  assert.notEqual(git(fx.origin, "rev-parse", `${merge}^{tree}`), git(fx.origin, "rev-parse", `${merge}^2^{tree}`));

  // Later: another PR lands on top (green), the merge itself has no green CI → resume refuses.
  const seed = join(fx.dir, "seed");
  git(seed, "pull", "--quiet", "origin", "main");
  writeFileSync(join(seed, "later.txt"), "later");
  git(seed, "add", "-A"); git(seed, "commit", "--quiet", "-m", "Merge pull request #11 from octo/later");
  git(seed, "push", "--quiet", "origin", "main");
  writeFileSync(`${fx.log}.ci.${merge}`, "failure");
  writeFileSync(fx.log, "");
  const refused = routine(fx, "run");
  assert.equal(refused.code, 2, refused.out);
  assert.match(refused.out, /v0\.4\.90 is merged \([0-9a-f]{40}\) but untested: CI is failure on the merge/);
  assert.equal(originTags(fx), "v0.4.89");

  writeFileSync(`${fx.log}.ci.${merge}`, "success");
  const tagged = routine(fx, "run");
  assert.equal(tagged.code, 0, tagged.out);
  assert.match(tagged.out, /already merged \([0-9a-f]{40}; CI green on the merge/);
  assert.equal(git(fx.origin, "rev-parse", "v0.4.90^{commit}"), merge);
  rmSync(fx.dir, { recursive: true, force: true });
});

test("run: a version that was tagged but never published (its build failed) is carried into the next notes", () => {
  const fx = fixture({ after: [] });
  const seed = join(fx.dir, "seed");
  const put = (rel, text) => { mkdirSync(dirname(join(seed, rel)), { recursive: true }); writeFileSync(join(seed, rel), text); };
  // v0.4.90: collected and tagged, but release.yml failed — no GitHub release.
  put("whats-new/0.4.90/failed-thing.md", "---\ntitle: Shipped by no one yet\nkind: feature\narea: app\n---\nThe v0.4.90 build never published this.\n");
  put("whats-new/0.4.90/notes.md", "## Octopush 0.4.90\n\n### Features\n\n- **Shipped by no one yet** — The v0.4.90 build never published this.\n");
  for (const f of ["package.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json"]) put(f, readFileSync(join(seed, f), "utf8").replace("0.4.89", "0.4.90"));
  git(seed, "add", "-A"); git(seed, "commit", "--quiet", "-m", "chore: release v0.4.90");
  git(seed, "tag", "-a", "v0.4.90", "-m", "v0.4.90");
  put("whats-new/unreleased/the-fix.md", "---\ntitle: The fix\nkind: fix\narea: app\n---\nWhat made the build pass again.\n");
  git(seed, "add", "-A"); git(seed, "commit", "--quiet", "-m", "Merge pull request #12 from octo/the-fix");
  git(seed, "push", "--quiet", "origin", "main", "--tags");
  const r = routine(fx, "run", { STUB_BRANCH: "release/v0.4.91", STUB_PUBLISHED: "v0.4.89" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /collecting changesets for 0\.4\.91 \(since v0\.4\.89; carrying 0\.4\.90, tagged but never published\)/);
  const notes = git(fx.origin, "show", "main:whats-new/0.4.91/notes.md");
  assert.match(notes, /This release also ships the changes of 0\.4\.90, whose build failed, so it was never published\./);
  assert.match(notes, /Shipped by no one yet/);
  assert.match(notes, /The fix/);
  assert.ok(existsSync(fx.ws));
  assert.equal(git(fx.origin, "rev-parse", "v0.4.91^{commit}"), git(fx.origin, "rev-parse", "main"));

  // Published after all (a starved build re-ran): nothing is carried.
  const fx2 = fixture();
  const plain = routine(fx2, "run", { STUB_PUBLISHED: "v0.4.89" });
  assert.match(plain.out, /collecting changesets for 0\.4\.90 \(since v0\.4\.89\)/);
  assert.doesNotMatch(git(fx2.origin, "show", "main:whats-new/0.4.90/notes.md"), /also ships/);
  rmSync(fx.dir, { recursive: true, force: true });
  rmSync(fx2.dir, { recursive: true, force: true });
});
