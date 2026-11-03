// node --test scripts/rerun-starved.test.mjs — scripts/routines/rerun-starved.sh
// against a stubbed `gh` that answers each REST call by URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function run({ starved = {}, attempts = {}, release = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "starved-"));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  // PR heads aaa and bbb, main ccc. `starved` maps a sha to its starved run id.
  const cases = Object.entries(starved).map(([sha, id]) =>
    `  *"head_sha=${sha}"*'.conclusion == "failure"'*) echo ${id} ;;\n  *"actions/runs/${id}/jobs"*) echo ${id} ;;\n  *"actions/runs/${id} "*|*"actions/runs/${id}") echo ${attempts[id] ?? 1} ;;`).join("\n");
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
echo "gh $*" >> "${log}"
args="$*"
case "$args" in
  *"rerun-failed-jobs"*) echo '{}' ;;
${release ? `  *"workflows/release.yml/runs"*) echo ${release} ;;\n  *"actions/runs/${release}/jobs"*) echo ${release} ;;\n  *"actions/runs/${release} "*|*"actions/runs/${release}") echo ${attempts[release] ?? 1} ;;` : ""}
${cases}
  *"pulls?state=open"*) printf 'aaa\\nbbb\\n' ;;
  *"commits/main"*) echo ccc ;;
  *) : ;;
esac
`);
  chmodSync(join(dir, "gh"), 0o755);
  const r = spawnSync("bash", [join(ROOT, "scripts/routines/rerun-starved.sh")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, OCTOPUSH_ROUTINES_KEEP_PATH: "1", OCTOPUSH_ROUTINE_REPO: "o/r" },
  });
  return { code: r.status, out: r.stdout + r.stderr, calls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

test("a starved run on a PR head or main is re-run; healthy ones are left alone", () => {
  const r = run({ starved: { bbb: 42, ccc: 43 } });
  assert.equal(r.code, 0, r.out);
  assert.ok(r.calls.some((c) => /-X POST repos\/o\/r\/actions\/runs\/42\/rerun-failed-jobs/.test(c)), r.calls.join("\n"));
  assert.ok(r.calls.some((c) => /actions\/runs\/43\/rerun-failed-jobs/.test(c)));
  assert.equal(r.calls.filter((c) => /rerun-failed-jobs/.test(c)).length, 2);
  assert.match(r.out, /2 starved run\(s\) re-run/);
});

test("a run already re-run to the attempt limit is left for a person", () => {
  const r = run({ starved: { aaa: 7 }, attempts: { 7: 3 } });
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.calls.some((c) => /rerun-failed-jobs/.test(c)));
  assert.match(r.out, /starved 3 times/);
});

test("nothing starved → nothing re-run", () => {
  const r = run();
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.calls.some((c) => /rerun-failed-jobs/.test(c)));
});

test("a release build that never got a runner is re-run", () => {
  const r = run({ release: 99 });
  assert.equal(r.code, 0, r.out);
  assert.ok(r.calls.some((c) => /-X POST repos\/o\/r\/actions\/runs\/99\/rerun-failed-jobs/.test(c)), r.calls.join("\n"));
  assert.match(r.out, /re-ran release run 99/);
});

test("a release build starved to the attempt limit is left alone", () => {
  const r = run({ release: 99, attempts: { 99: 3 } });
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.calls.some((c) => /rerun-failed-jobs/.test(c)));
  assert.match(r.out, /release run 99 starved 3 times/);
});
