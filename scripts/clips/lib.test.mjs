// Run with: node --test scripts/clips/lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ENCODE_LADDER,
  MAX_CLIP_BYTES,
  firstRung,
  fitDecision,
  maxKbpsFor,
  parseArgs,
  parseChangeset,
  selectChangesets,
  stepDwellMs,
} from "./lib.mjs";

const steps = [{ open: "settings/about", target: "settings-nav-about", caption: "Here." }];
const entry = (slug, meta, hasClip = false) => ({ slug, meta, hasClip });

test("selects app changesets with steps and no clip", () => {
  const { record, skipped } = selectChangesets([
    entry("a", { area: "app", steps }),
    entry("b", { area: "api", steps }),
    entry("c", { area: "app" }),
    entry("d", { area: "app", steps }, true),
    entry("e", null),
    entry("f", { area: "app", steps, scenario: "empty" }),
  ]);
  assert.deepEqual(record.map((r) => [r.slug, r.scenario]), [["a", "default"], ["f", "empty"]]);
  assert.deepEqual(Object.fromEntries(skipped.map((s) => [s.slug, s.reason])), {
    b: "area: api",
    c: "no steps",
    d: "clip exists (use --force)",
    e: "unparseable frontmatter",
  });
});

test("--force re-records existing clips; --slug narrows", () => {
  const all = [entry("a", { area: "app", steps }, true), entry("b", { area: "app", steps }, true)];
  assert.equal(selectChangesets(all, { force: true }).record.length, 2);
  const one = selectChangesets(all, { force: true, slug: "b" });
  assert.deepEqual(one.record.map((r) => r.slug), ["b"]);
  assert.deepEqual(selectChangesets(all, { slug: "zzz" }).skipped, [{ slug: "zzz", reason: "no such changeset" }]);
});

test("steps are normalised (default action none, text only when given)", () => {
  const [r] = selectChangesets([entry("a", { area: "app", steps: [{ target: "x", caption: "c" }, { target: "y", caption: "d", action: "type", text: "hi" }] })]).record;
  assert.deepEqual(r.steps, [
    { open: null, target: "x", caption: "c", action: "none", text: null },
    { open: null, target: "y", caption: "d", action: "type", text: "hi" },
  ]);
});

test("parseArgs", () => {
  assert.deepEqual(parseArgs(["v0.4.89", "--slug", "x", "--force", "--verbose"]), { dir: "0.4.89", slug: "x", force: true, verbose: true, keepRaw: false });
  assert.equal(parseArgs(["unreleased"]).dir, "unreleased");
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(["latest"]), /usage/);
  assert.throws(() => parseArgs(["unreleased", "--nope"]), /unexpected/);
});

test("parseChangeset reads frontmatter", () => {
  const { meta, body } = parseChangeset("---\ntitle: T\narea: app\n---\nBody.\n");
  assert.equal(meta.area, "app");
  assert.equal(body, "Body.");
});

test("fitDecision: accept when it fits, retry down the ladder, then give up", () => {
  assert.equal(fitDecision(MAX_CLIP_BYTES, 0), "accept");
  assert.equal(fitDecision(1000, 3), "accept");
  assert.equal(fitDecision(MAX_CLIP_BYTES + 1, 0), "retry");
  assert.equal(fitDecision(MAX_CLIP_BYTES + 1, ENCODE_LADDER.length - 2), "retry");
  assert.equal(fitDecision(MAX_CLIP_BYTES + 1, ENCODE_LADDER.length - 1), "give-up");
  assert.equal(fitDecision(0, 0), "give-up", "an empty encode is not retried");
});

test("ladder lowers fps and bitrate monotonically", () => {
  for (let i = 1; i < ENCODE_LADDER.length; i++) {
    assert.ok(ENCODE_LADDER[i].fps <= ENCODE_LADDER[i - 1].fps);
    assert.ok(ENCODE_LADDER[i].kbps < ENCODE_LADDER[i - 1].kbps);
  }
});

test("firstRung skips rungs that cannot fit the duration", () => {
  assert.equal(firstRung(10), 0); // 10 s at 800 kbps ≈ 1 MB
  assert.ok(maxKbpsFor(30) < 400);
  const i = firstRung(30);
  assert.ok(ENCODE_LADDER[i].kbps <= maxKbpsFor(30));
  assert.equal(firstRung(600), ENCODE_LADDER.length - 1, "very long clips still get the last rung");
  assert.equal(firstRung(0), 0);
});

test("stepDwellMs is clamped reading time", () => {
  assert.equal(stepDwellMs("Hi"), 1800);
  assert.equal(stepDwellMs(Array(100).fill("word").join(" ")), 4200);
  const mid = stepDwellMs("Turn on run-history sync here — it's off until you do.");
  assert.ok(mid > 1800 && mid < 4200);
});
