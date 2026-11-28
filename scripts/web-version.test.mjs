// node --test scripts/web-version.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { currentVersion, bumpReleaseTs, versionsBetween, changelogEntry, changelogDate, insertEntries, apply, plain, gateResult, releasePrBody } from "./web-version.mjs";

const BODY = `## Octopush 0.4.93

### Features

- **Accept a crew's recommended answers** — Its card lists the questions. <img src=x onerror=alert(1)> {x}

### Fixes

- **A terminal that fails to start says why** — The canvas says so.

### Maintenance

jobs: area:app wins (#370)

---

Universal binary.`;

test("an entry keeps Features/Improvements/Fixes bullets, in the changelog's style, with no HTML or MDX", () => {
  const e = changelogEntry("0.4.93", BODY);
  assert.match(e, /^## v0\.4\.93\n\n\*\*Accept a crew's recommended answers\.\*\* Its card lists the questions\./);
  assert.match(e, /\*\*A terminal that fails to start says why\.\*\* The canvas says so\./);
  assert.doesNotMatch(e, /area:app|Universal binary|<img/);
  assert.match(e, /&lt;img/);
  assert.equal(changelogEntry("0.4.94", "### Maintenance\n\nbumps"), null);
});

test("versions between the landing and the new stable, oldest first", () => {
  assert.deepEqual(versionsBetween(["v0.4.95", "v0.4.93", "v0.4.94", "v0.4.88", "nightly"], "0.4.93", "0.4.95"), ["0.4.94", "0.4.95"]);
  assert.deepEqual(versionsBetween(["v0.4.10", "v0.4.9"], "0.4.8", "0.4.10"), ["0.4.9", "0.4.10"], "numeric, not lexical");
});

test("release.ts bump and changelog insertion", () => {
  const ts = "// x\nexport const VERSION = '0.4.88';\nexport const PRICE_FREE = 0;\n";
  assert.equal(currentVersion(ts), "0.4.88");
  assert.match(bumpReleaseTs(ts, "0.4.93"), /VERSION = '0\.4\.93';\nexport const PRICE_FREE = 0;/);
  assert.throws(() => bumpReleaseTs(ts, "0.4"));
  const log = "---\ntitle: Changelog\n---\n\nIntro.\n\n## v0.4.88\n\nOld.\n";
  assert.equal(insertEntries(log, ["## v0.4.90\n\nB.\n", "## v0.4.89\n\nA.\n"]),
    "---\ntitle: Changelog\n---\n\nIntro.\n\n## v0.4.90\n\nB.\n\n## v0.4.89\n\nA.\n\n## v0.4.88\n\nOld.\n");
});

test("apply edits a web checkout: newest entry first, every release since the landing's version", () => {
  const dir = mkdtempSync(join(tmpdir(), "webv-"));
  mkdirSync(join(dir, "src/data"), { recursive: true });
  mkdirSync(join(dir, "src/content/docs/docs"), { recursive: true });
  writeFileSync(join(dir, "src/data/release.ts"), "export const VERSION = '0.4.93';\n");
  writeFileSync(join(dir, "src/content/docs/docs/changelog.md"), "---\ntitle: C\n---\n\n## v0.4.93\n\nOld.\n");
  const releases = [
    { tag_name: "v0.4.95", body: "### Fixes\n\n- **Fix two** — Two.", published_at: "2026-11-24T03:10:00Z", prerelease: true },
    { tag_name: "v0.4.94", body: "### Maintenance\n\nonly", published_at: "2026-11-22T12:00:00Z", prerelease: true },
    { tag_name: "v0.4.93", body: BODY, published_at: "2026-11-20T12:00:00Z", prerelease: false },
  ];
  assert.equal(apply(dir, "0.4.93", releases), null, "nothing to do at the same version");
  assert.deepEqual(apply(dir, "0.4.95", releases), { from: "0.4.93", versions: ["0.4.94", "0.4.95"] });
  assert.equal(readFileSync(join(dir, "src/data/release.ts"), "utf8"), "export const VERSION = '0.4.95';\n");
  const log = readFileSync(join(dir, "src/content/docs/docs/changelog.md"), "utf8");
  assert.ok(log.indexOf("## v0.4.95") < log.indexOf("## v0.4.93"));
  assert.ok(!log.includes("## v0.4.94"), "a maintenance-only beta in between gets no entry");
  assert.ok(log.includes('## v0.4.95\n\n<p class="changelog-date">Stable <time datetime="2026-11-23">2026-11-23</time></p>\n\n**Fix two.** Two.'),
    "the promoted version is Stable, dated in the owner's time zone");
  assert.throws(() => apply(dir, "0.4.99", releases), /no release v0\.4\.99/);
});

test("release-note text: no italics, no links, no raw HTML; code spans and bold untouched", () => {
  assert.equal(plain("reads *failed* instead of *shell idle*"), "reads failed instead of shell idle");
  assert.equal(plain("an _old_ name, snake_case_name stays"), "an old name, snake_case_name stays");
  assert.equal(plain("see [the docs](javascript:alert(1)) and ![x](y.png)"), "see the docs and x");
  assert.equal(plain("`a<b` and <b>"), "`a<b` and &lt;b&gt;");
  assert.equal(plain("**Bold** stays, 2 * 3 * 4 too"), "**Bold** stays, 2 * 3 * 4 too");
});

test("entries carry the date line the web's consistency gate requires", () => {
  assert.equal(changelogDate("2026-11-23T03:23:53Z"), "2026-11-22", "22:23 in Bogotá is still the 22nd");
  assert.equal(changelogDate("2026-11-24T19:09:28Z"), "2026-11-24");
  assert.equal(changelogDate(undefined), null);
  assert.equal(changelogDate("not a date"), null);
  const beta = changelogEntry("0.4.94", "### Fixes\n\n- **One** — x.", { date: "2026-11-22", stable: false });
  assert.match(beta, /^## v0\.4\.94\n\n<p class="changelog-date">Beta <time datetime="2026-11-22">2026-11-22<\/time><\/p>\n\n\*\*One\.\*\* x\.\n$/);
  assert.match(changelogEntry("0.4.94", "### Fixes\n\n- **One** — x."), /^## v0\.4\.94\n\n\*\*One/, "no date known, no date line");
});

test("a maintenance-only stable still gets a dated heading", () => {
  const dir = mkdtempSync(join(tmpdir(), "webv-"));
  mkdirSync(join(dir, "src/data"), { recursive: true });
  mkdirSync(join(dir, "src/content/docs/docs"), { recursive: true });
  writeFileSync(join(dir, "src/data/release.ts"), "export const VERSION = '0.4.93';\n");
  writeFileSync(join(dir, "src/content/docs/docs/changelog.md"), "---\ntitle: C\n---\n\n## v0.4.93\n\nOld.\n");
  apply(dir, "0.4.94", [{ tag_name: "v0.4.94", body: "### Maintenance\n\nonly", published_at: "2026-11-24T19:09:28Z", prerelease: true }]);
  const log = readFileSync(join(dir, "src/content/docs/docs/changelog.md"), "utf8");
  assert.ok(log.includes('## v0.4.94\n\n<p class="changelog-date">Stable <time datetime="2026-11-24">2026-11-24</time></p>\n\nMaintenance and reliability fixes.\n'));
});

test("a folded beta is labelled Beta and a stable the landing skipped stays Stable", () => {
  const dir = mkdtempSync(join(tmpdir(), "webv-"));
  mkdirSync(join(dir, "src/data"), { recursive: true });
  mkdirSync(join(dir, "src/content/docs/docs"), { recursive: true });
  writeFileSync(join(dir, "src/data/release.ts"), "export const VERSION = '0.4.93';\n");
  writeFileSync(join(dir, "src/content/docs/docs/changelog.md"), "---\ntitle: C\n---\n\n## v0.4.93\n\nOld.\n");
  apply(dir, "0.4.96", [
    { tag_name: "v0.4.96", body: "### Fixes\n\n- **Three** — c.", published_at: "2026-11-25T12:00:00Z", prerelease: true },
    { tag_name: "v0.4.95", body: "### Fixes\n\n- **Two** — b.", published_at: "2026-11-24T12:00:00Z", prerelease: false },
    { tag_name: "v0.4.94", body: "### Fixes\n\n- **One** — a.", published_at: "2026-11-23T12:00:00Z", prerelease: true },
  ]);
  const log = readFileSync(join(dir, "src/content/docs/docs/changelog.md"), "utf8");
  assert.ok(log.includes('## v0.4.96\n\n<p class="changelog-date">Stable <time datetime="2026-11-25">'), "the promoted version");
  assert.ok(log.includes('## v0.4.95\n\n<p class="changelog-date">Stable <time datetime="2026-11-24">'), "a stable the landing skipped");
  assert.ok(log.includes('## v0.4.94\n\n<p class="changelog-date">Beta <time datetime="2026-11-23">'), "a beta folded into the stable");
});

// What octopush-web's scripts/consistency-check.mjs prints (colours included).
const GATE_OK = "\n── Launch consistency gate ──\n\n\x1b[32m✓\x1b[0m landing VERSION = 0.4.153\n\x1b[33m▸\x1b[0m dist/ not built — skipping the copy gate (run npm run build first)\n\n41 passed · 0 failed · 1 skipped\n\n";
const GATE_BAD = "\x1b[32m✓\x1b[0m landing VERSION = 0.4.153\n\x1b[31m✗\x1b[0m src/data/crew-pricing.json drifts from the stable app v0.4.153: $.prices.x: committed 1 != stable 2.\n\x1b[31m✗\x1b[0m Homebrew cask is at 0.4.152, VERSION in src/data/release.ts is 0.4.153: the tap lags\n\n39 passed · 2 failed · 1 skipped\n\nNote: until the first GitHub release is published…\n";
const CREW_LOG = "wrote src/data/crew-pricing.json from octopush v0.4.153 (OCTOPUSH_STABLE_VERSION): 14 prices, 9 catalog models, 6 roles, 4 presets, reference claude-fable-5-2\n";

test("the gate's verdict: passed, failed with its ✗ lines, broken before its checks, or never run", () => {
  assert.deepEqual(gateResult(GATE_OK, "0"), { state: "passed", summary: "41 passed · 0 failed · 1 skipped", failed: [], tail: [] });
  const bad = gateResult(GATE_BAD, "1");
  assert.equal(bad.state, "failed");
  assert.equal(bad.summary, "39 passed · 2 failed · 1 skipped");
  assert.equal(bad.failed.length, 2);
  assert.match(bad.failed[0], /^✗ src\/data\/crew-pricing\.json drifts/);
  assert.doesNotMatch(bad.failed.join("\n"), /\x1b/, "no terminal colours in the PR");
  const npm = gateResult("npm error code ECONNRESET\nnpm error network aborted\n", "1");
  assert.equal(npm.state, "failed");
  assert.deepEqual(npm.tail, ["npm error code ECONNRESET", "npm error network aborted"], "no ✗ line: the end of the log instead");
  for (const rc of ["", undefined, null]) assert.equal(gateResult(GATE_BAD, rc).state, "missing");
  assert.equal(gateResult("", "124").state, "failed", "a timeout is a failure");
});

test("the release PR body: a passed gate and a regenerated crew pricing", () => {
  const body = releasePrBody({ version: "0.4.153", pr: "250", gate: gateResult(GATE_OK, "0"),
    crew: { rc: "0", log: CREW_LOG, changed: true, shaBefore: "a", shaAfter: "a" }, runUrl: "https://github.com/o/r/actions/runs/1" });
  assert.match(body, /^v0\.4\.153 was promoted to stable/, "no alert when the gate passed");
  assert.match(body, /Reply `merge web#250` in the digest to publish it\./);
  assert.match(body, /regenerated `src\/data\/crew-pricing\.json` from the app at `v0\.4\.153`; this PR carries the change\./);
  assert.match(body, /wrote src\/data\/crew-pricing\.json from octopush v0\.4\.153/);
  assert.doesNotMatch(body, /sourceSha256/, "the estimator source didn't change");
  assert.match(body, /### Consistency gate\n\n\*\*Passed\*\*: `npm run consistency` with `OCTOPUSH_APP_DIR` set to the app checked out at `v0\.4\.153`, `OCTOPUSH_STABLE_VERSION=0\.4\.153` and `OCTOPUSH_STRICT_RELEASE=1`.*\(\[run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\)\)\. 41 passed · 0 failed · 1 skipped\./);
  assert.match(releasePrBody({ version: "0.4.153", pr: "250", gate: gateResult(GATE_OK, "0"), crew: { rc: "0", log: CREW_LOG, changed: false } }), /: no change\./);
});

test("the release PR body: a failed gate is marked at the top and lists its failing checks", () => {
  const body = releasePrBody({ version: "0.4.153", pr: "250", gate: gateResult(GATE_BAD, "1"), crew: { rc: "0", log: CREW_LOG, changed: true, shaBefore: "a", shaAfter: "b" } });
  assert.match(body, /^> \[!CAUTION\]\n> \*\*The consistency gate failed\*\* with the app at `v0\.4\.153`\./);
  assert.match(body, /Once the gate passes, reply `merge web#250`/);
  assert.match(body, /\*\*Failed\*\*: .*39 passed · 2 failed · 1 skipped\.\n\n````text\n✗ src\/data\/crew-pricing\.json drifts[^\n]*\n✗ Homebrew cask is at 0\.4\.152[^\n]*\n````/);
  assert.match(body, /> \[!IMPORTANT\]\n> `estimator\.sourceSha256` changed: .*`src\/lib\/crewEstimate\.ts`/, "a changed estimator source asks for the TS mirror");
  const many = gateResult(Array.from({ length: 60 }, (_, i) => `✗ check ${i}`).join("\n"), "1");
  assert.match(releasePrBody({ version: "0.4.153", pr: "1", gate: many }), /✗ check 39\n… 20 more lines in the run log\n````/, "capped at 40 lines");
});

test("the release PR body: a crew pricing that could not be regenerated, and a gate that never ran", () => {
  const body = releasePrBody({ version: "0.4.153", pr: "250", gate: gateResult("", ""), crew: { rc: "1", log: "build-crew-pricing: builtin_prices not found\n" } });
  assert.match(body, /^> \[!WARNING\]\n> \*\*The consistency gate did not run\*\*\. Run `OCTOPUSH_APP_DIR=\.\.\/octopush OCTOPUSH_STABLE_VERSION=0\.4\.153 npm run consistency`/);
  assert.match(body, /\*\*Could not be regenerated\*\* from the app at `v0\.4\.153` \(exit 1\); the file is unchanged\..*\n\n````text\nbuild-crew-pricing: builtin_prices not found\n````/);
  assert.match(body, /### Consistency gate\n\n\*\*Did not run\*\*/);
  assert.match(releasePrBody({ version: "0.4.153", pr: "250", gate: gateResult("", ""), crew: { rc: "" } }), /\*\*Not regenerated\*\*: the step did not run\./);
});

test("web-version.mjs body reads its inputs from the environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "webv-"));
  writeFileSync(join(dir, "gate.log"), GATE_BAD);
  writeFileSync(join(dir, "crew.log"), CREW_LOG);
  const script = new URL("./web-version.mjs", import.meta.url).pathname;
  const env = { PATH: process.env.PATH, GATE_LOG: join(dir, "gate.log"), GATE_RC: "1", CREW_LOG: join(dir, "crew.log"), CREW_RC: "0", CREW_CHANGED: "1", CREW_SHA_BEFORE: "a", CREW_SHA_AFTER: "a", RUN_URL: "https://x/runs/9" };
  const r = spawnSync(process.execPath, [script, "body", "0.4.153", "250"], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^> \[!CAUTION\]/);
  assert.match(r.stdout, /this PR carries the change/);
  assert.match(r.stdout, /\(\[run\]\(https:\/\/x\/runs\/9\)\)/);
  assert.equal(spawnSync(process.execPath, [script, "body", "0.4", "250"], { encoding: "utf8", env }).status, 64);
  assert.equal(spawnSync(process.execPath, [script, "body", "0.4.153", "x"], { encoding: "utf8", env }).status, 64);
});
