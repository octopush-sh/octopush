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
  assert.match(files, /Co-Authored-By: Claude Opus 5\.5/);
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
