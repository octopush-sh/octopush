// node --test scripts/homebrew-cask.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { renderCask, sha256FromDigest } from "./homebrew-cask.mjs";

const TEMPLATE_PATH = new URL("../packaging/homebrew-tap/Casks/octopush.rb", import.meta.url);
const TEMPLATE = readFileSync(TEMPLATE_PATH, "utf8");
const SHA = "f3e3ebc7bbf562dd8072e584bcff8ca644cb72578f21a1cfb6ea140aec5b0870";

test("the staged template renders with the version and sha256, and nothing else changes", () => {
  const out = renderCask(TEMPLATE, { version: "0.4.136", sha256: SHA });
  assert.match(out, /^  version "0\.4\.136"$/m);
  assert.match(out, new RegExp(`^  sha256 "${SHA}"$`, "m"));
  assert.doesNotMatch(out, /0\.0\.0|0{64}/);
  // The download URL follows the version; the stable Octopush.dmg permalink asset.
  assert.match(out, /url "https:\/\/github\.com\/octopush-sh\/octopush\/releases\/download\/v#\{version\}\/Octopush\.dmg"/);
  const changed = out.split("\n").filter((l, i) => l !== TEMPLATE.split("\n")[i]);
  assert.equal(changed.length, 2);
});

test("rendering is idempotent: a rendered cask renders again to the same text", () => {
  const once = renderCask(TEMPLATE, { version: "1.2.3", sha256: SHA });
  assert.equal(renderCask(once, { version: "1.2.3", sha256: SHA }), once);
});

test("bad inputs are refused", () => {
  assert.throws(() => renderCask(TEMPLATE, { version: "v1.2.3", sha256: SHA }), /X\.Y\.Z/);
  assert.throws(() => renderCask(TEMPLATE, { version: "1.2.3-beta.1", sha256: SHA }), /X\.Y\.Z/);
  assert.throws(() => renderCask(TEMPLATE, { version: "1.2.3", sha256: "sha256:" + SHA }), /64 lowercase hex/);
  assert.throws(() => renderCask(TEMPLATE, { version: "1.2.3", sha256: SHA.toUpperCase() }), /64 lowercase hex/);
  assert.throws(() => renderCask(TEMPLATE, { version: "1.2.3", sha256: '"; system "x' }), /64 lowercase hex/);
});

test("a template that drifted from the expected shape is refused, not half-rendered", () => {
  const twice = TEMPLATE.replace(/^  version .*$/m, (l) => `${l}\n${l}`);
  assert.throws(() => renderCask(twice, { version: "1.2.3", sha256: SHA }), /exactly one .*version.*found 2/);
  const none = TEMPLATE.replace(/^  sha256 .*$/m, "  sha256 :no_check");
  assert.throws(() => renderCask(none, { version: "1.2.3", sha256: SHA }), /exactly one .*sha256.*found 0/);
  assert.throws(() => renderCask(TEMPLATE.replace('cask "octopush" do', 'cask "other" do'), { version: "1.2.3", sha256: SHA }), /cask "octopush" do/);
});

test("the release asset digest gives the sha256", () => {
  assert.equal(sha256FromDigest(`sha256:${SHA}`), SHA);
  assert.equal(sha256FromDigest(null), null);
  assert.equal(sha256FromDigest(""), null);
  assert.equal(sha256FromDigest(`sha512:${SHA}`), null);
});

test("the CLI prints the rendered cask and fails on bad input", () => {
  const script = new URL("./homebrew-cask.mjs", import.meta.url).pathname;
  const out = execFileSync("node", [script, "render", TEMPLATE_PATH.pathname, "0.4.136", SHA], { encoding: "utf8" });
  assert.match(out, /^  version "0\.4\.136"$/m);
  assert.throws(() => execFileSync("node", [script, "render", TEMPLATE_PATH.pathname, "nope", SHA], { stdio: "pipe" }));
});
