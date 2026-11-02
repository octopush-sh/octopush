// node --test scripts/web-version.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentVersion, bumpReleaseTs, versionsBetween, changelogEntry, insertEntries, apply, plain } from "./web-version.mjs";

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
    { tag_name: "v0.4.95", body: "### Fixes\n\n- **Fix two** — Two." },
    { tag_name: "v0.4.94", body: "### Maintenance\n\nonly" },
    { tag_name: "v0.4.93", body: BODY },
  ];
  assert.equal(apply(dir, "0.4.93", releases), null, "nothing to do at the same version");
  assert.deepEqual(apply(dir, "0.4.95", releases), { from: "0.4.93", versions: ["0.4.94", "0.4.95"] });
  assert.equal(readFileSync(join(dir, "src/data/release.ts"), "utf8"), "export const VERSION = '0.4.95';\n");
  const log = readFileSync(join(dir, "src/content/docs/docs/changelog.md"), "utf8");
  assert.ok(log.indexOf("## v0.4.95") < log.indexOf("## v0.4.93"));
  assert.ok(!log.includes("## v0.4.94"), "a maintenance-only beta in between gets no entry");
  assert.throws(() => apply(dir, "0.4.99", releases), /no release v0\.4\.99/);
});

test("release-note text: no italics, no links, no raw HTML; code spans and bold untouched", () => {
  assert.equal(plain("reads *failed* instead of *shell idle*"), "reads failed instead of shell idle");
  assert.equal(plain("an _old_ name, snake_case_name stays"), "an old name, snake_case_name stays");
  assert.equal(plain("see [the docs](javascript:alert(1)) and ![x](y.png)"), "see the docs and x");
  assert.equal(plain("`a<b` and <b>"), "`a<b` and &lt;b&gt;");
  assert.equal(plain("**Bold** stays, 2 * 3 * 4 too"), "**Bold** stays, 2 * 3 * 4 too");
});
