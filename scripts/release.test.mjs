// Run with: node --test scripts/release.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NOTES_MAX,
  NOTES_SUFFIX,
  buildManifest,
  bumpVersionTexts,
  channelCreateArgs,
  compareVersions,
  nextPatch,
  parseChannel,
  releaseBody,
  shouldRefreshBetaManifest,
  trimNotes,
} from "./release-lib.mjs";

test("channel defaults to beta and accepts both spellings", () => {
  assert.equal(parseChannel(["--ci"]), "beta");
  assert.equal(parseChannel(["--ci", "--channel", "stable", "0.4.90"]), "stable");
  assert.equal(parseChannel(["--channel=beta"]), "beta");
  assert.throws(() => parseChannel(["--channel", "nightly"]), /beta \| stable/);
  assert.throws(() => parseChannel(["--channel"]), /beta \| stable/);
});

test("beta is a prerelease that never becomes GitHub latest; stable keeps today's flags", () => {
  assert.deepEqual(channelCreateArgs("beta"), ["--prerelease", "--latest=false"]);
  assert.deepEqual(channelCreateArgs("stable"), []);
  assert.throws(() => channelCreateArgs("x"));
});

test("versions compare numerically and bump the patch", () => {
  assert.equal(compareVersions("0.4.10", "0.4.9"), 1);
  assert.equal(compareVersions("v0.4.9", "0.4.9"), 0);
  assert.equal(compareVersions("0.4.9", "0.5.0"), -1);
  assert.equal(nextPatch("v0.4.89"), "0.4.90");
  assert.throws(() => nextPatch("0.4"));
});

test("the beta manifest only moves forward", () => {
  assert.equal(shouldRefreshBetaManifest(null, "0.4.90"), true);
  assert.equal(shouldRefreshBetaManifest("0.4.89", "0.4.90"), true);
  assert.equal(shouldRefreshBetaManifest("0.4.90", "0.4.90"), true);
  assert.equal(shouldRefreshBetaManifest("0.4.91", "0.4.90"), false);
});

test("short notes pass through; long notes are cut at a line boundary", () => {
  assert.equal(trimNotes("  ## Octopush 1.0.0\n\n- a\n"), "## Octopush 1.0.0\n\n- a");
  const line = "- " + "x".repeat(97) + "\n"; // 100 chars
  const long = line.repeat(60); // 6000 chars
  const t = trimNotes(long);
  assert.ok(t.length <= NOTES_MAX, `length ${t.length}`);
  assert.ok(t.endsWith(NOTES_SUFFIX));
  const kept = t.slice(0, -NOTES_SUFFIX.length);
  for (const l of kept.split("\n")) assert.equal(l.length, 99); // only whole lines
});

test("manifest carries trimmed notes, or the generic line without them", () => {
  const base = { version: "0.4.90", signature: "sig", url: "https://x/y.tar.gz", pubDate: "2026-10-30T00:00:00.000Z" };
  const m = buildManifest({ ...base, notes: "## Octopush 0.4.90\n\n- a\n" });
  assert.equal(m.notes, "## Octopush 0.4.90\n\n- a");
  assert.deepEqual(m.platforms["darwin-aarch64"], { signature: "sig", url: "https://x/y.tar.gz" });
  assert.deepEqual(m.platforms["darwin-x86_64"], m.platforms["darwin-aarch64"]);
  assert.equal(m.pub_date, base.pubDate);
  assert.equal(buildManifest({ ...base, notes: "" }).notes, "Octopush 0.4.90");
});

test("release body: notes on top, install text below; fallback unchanged", () => {
  const withNotes = releaseBody({ version: "0.4.90", notes: "## Octopush 0.4.90\n\n- a\n", notarized: true });
  assert.ok(withNotes.startsWith("## Octopush 0.4.90\n\n- a\n\n---\n\nUniversal binary"));
  assert.match(withNotes, /notarized by Apple/);
  assert.doesNotMatch(withNotes, /xattr/);
  const fallback = releaseBody({ version: "0.4.90", notes: "", notarized: false });
  assert.ok(fallback.startsWith("Octopush 0.4.90\n\nUniversal binary"));
  assert.match(fallback, /xattr -cr \/Applications\/Octopush.app/);
});

test("version bump touches only the version line of each file", () => {
  const files = {
    pkg: '{\n  "name": "octopush",\n  "version": "0.4.89",\n  "dependencies": {\n    "x": {\n      "version": "1.0.0"\n    }\n  }\n}\n',
    tauriConf: '{\n  "$schema": "s",\n  "productName": "Octopush",\n  "version": "0.4.89",\n  "plugins": {}\n}\n',
    cargoToml: '[package]\nname = "octopush"\nversion = "0.4.89"\n\n[dependencies]\nserde = { version = "1" }\n',
    cargoLock: '[[package]]\nname = "nom"\nversion = "7.1.3"\n\n[[package]]\nname = "octopush"\nversion = "0.4.89"\ndependencies = [\n "anyhow",\n]\n\n[[package]]\nname = "octopush-x"\nversion = "0.4.89"\n',
  };
  const out = bumpVersionTexts(files, "0.4.90");
  const changed = (a, b) => a.split("\n").filter((l, i) => l !== b.split("\n")[i]);
  for (const k of Object.keys(files)) assert.equal(changed(files[k], out[k]).length, 1, k);
  assert.match(out.pkg, /"version": "0.4.90"/);
  assert.match(out.pkg, /"version": "1.0.0"/);
  assert.match(out.cargoLock, /name = "octopush"\nversion = "0.4.90"/);
  assert.match(out.cargoLock, /name = "octopush-x"\nversion = "0.4.89"/);
  assert.match(out.cargoLock, /name = "nom"\nversion = "7.1.3"/);
  assert.throws(() => bumpVersionTexts({ ...files, cargoLock: "" }, "0.4.90"), /cargoLock/);
  assert.throws(() => bumpVersionTexts(files, "0.4"), /X\.Y\.Z/);
});
