#!/usr/bin/env node
// Render the Homebrew cask for a promoted version.
//
// packaging/homebrew-tap/Casks/octopush.rb is the one template; its `version`
// and `sha256` lines are placeholders. promote.yml's `homebrew-tap` job renders
// it with the promoted version and the sha256 of that release's Octopush.dmg,
// checks it (scripts/homebrew-cask-check.sh) and pushes it to
// octopush-sh/homebrew-tap. CI renders it with dummy values and runs the same
// checks, so the template can't rot between promotions.
//
//   node scripts/homebrew-cask.mjs render <template> <version> <sha256>   (cask on stdout)
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION_LINE = /^  version "[^"]*"$/;
const SHA_LINE = /^  sha256 "[0-9a-f]{64}"$/;

/** The sha256 hex from a GitHub release asset `digest` ("sha256:<hex>"), or null. */
export function sha256FromDigest(digest) {
  const m = typeof digest === "string" ? digest.match(/^sha256:([0-9a-f]{64})$/) : null;
  return m ? m[1] : null;
}

/** The template with its `version` and `sha256` lines set. Throws on a bad input or template. */
export function renderCask(template, { version, sha256 }) {
  if (!SEMVER.test(version ?? "")) throw new Error(`version must be X.Y.Z (got '${version}')`);
  if (!SHA256.test(sha256 ?? "")) throw new Error("sha256 must be 64 lowercase hex characters");
  if (!/^cask "octopush" do$/m.test(template)) throw new Error('template has no `cask "octopush" do` line');
  const lines = template.split("\n");
  const one = (re, what) => {
    const at = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
    if (at.length !== 1) throw new Error(`template must have exactly one ${what} line (found ${at.length})`);
    return at[0];
  };
  const v = one(VERSION_LINE, "`  version \"…\"`");
  const s = one(SHA_LINE, "`  sha256 \"…\"`");
  lines[v] = `  version "${version}"`;
  lines[s] = `  sha256 "${sha256}"`;
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, template, version, sha256] = process.argv.slice(2);
  if (cmd !== "render" || !template) {
    console.error("usage: node scripts/homebrew-cask.mjs render <template> <version> <sha256>");
    process.exit(2);
  }
  try {
    process.stdout.write(renderCask(readFileSync(template, "utf8"), { version, sha256 }));
  } catch (e) {
    console.error(`homebrew-cask: ${e.message}`);
    process.exit(1);
  }
}
