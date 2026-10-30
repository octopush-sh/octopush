// Pure helpers for scripts/release.mjs and scripts/routines/release-beta.sh.
// No side effects on import, so `node --test scripts/release.test.mjs` can
// exercise them. See docs/RELEASING.md (channels) and docs/WHATS-NEW.md §5–§6.
//
// CLI (used by the nightly beta routine to bump versions exactly like a manual
// release commit does — one line per file, formatting untouched):
//   node scripts/release-lib.mjs bump <version> [<repo-root>]
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CHANNELS = ["beta", "stable"];
export const BETA_TAG = "beta-channel";
export const BETA_TITLE = "Beta channel manifest";
export const NOTES_MAX = 4000;
export const NOTES_SUFFIX = "\n\n… full notes on GitHub";
const VERSION = /^\d+\.\d+\.\d+$/;

/** `--channel beta|stable` or `--channel=beta`; default beta. Throws on anything else. */
export function parseChannel(argv) {
  let value;
  let given = false;
  argv.forEach((a, i) => {
    if (a === "--channel") { given = true; value = argv[i + 1]; }
    else if (a.startsWith("--channel=")) { given = true; value = a.slice("--channel=".length); }
  });
  if (!given) return "beta";
  if (!CHANNELS.includes(value)) throw new Error(`--channel must be one of ${CHANNELS.join(" | ")} (got "${value ?? ""}")`);
  return value;
}

/** Extra `gh release create` flags for a channel. Beta must never become GitHub "latest". */
export function channelCreateArgs(channel) {
  if (channel === "beta") return ["--prerelease", "--latest=false"];
  if (channel === "stable") return [];
  throw new Error(`unknown channel "${channel}"`);
}

/**
 * What a publish run does when the release for its tag may already exist.
 * `existing` is the GitHub release (or null when there is none).
 *   "create"   — no release yet (or not CI): `gh release create`
 *   "reupload" — a beta re-run: upload with --clobber, then publish as prerelease
 *   "refuse"   — the tag is a published stable release: never overwrite it
 */
export function ciPublishDecision(ci, existing, channel) {
  if (!ci || !existing) return "create";
  if (!existing.draft && !existing.prerelease) return "refuse";
  return channel === "beta" ? "reupload" : "refuse";
}

/** -1 / 0 / 1 for X.Y.Z strings (a leading "v" is ignored). */
export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, "").split(/[.-]/).slice(0, 3).map(Number);
  const pb = String(b).replace(/^v/, "").split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  }
  return 0;
}

/** X.Y.Z → X.Y.(Z+1). */
export function nextPatch(version) {
  const v = String(version).replace(/^v/, "");
  if (!VERSION.test(v)) throw new Error(`not an X.Y.Z version: "${version}"`);
  const [x, y, z] = v.split(".").map(Number);
  return `${x}.${y}.${z + 1}`;
}

/**
 * The beta manifest only moves forward: refresh it unless it already
 * advertises a newer version (so beta users never see an older build than stable,
 * and re-running an old release can't roll beta back).
 */
export function shouldRefreshBetaManifest(currentVersion, version) {
  if (!currentVersion) return true;
  return compareVersions(version, currentVersion) >= 0;
}

/** Notes for latest.json: ≤ max chars, cut at a line boundary, with a pointer to the full notes. */
export function trimNotes(text, max = NOTES_MAX) {
  const s = String(text ?? "").trim();
  if (s.length <= max) return s;
  let cut = s.slice(0, max - NOTES_SUFFIX.length);
  const nl = cut.lastIndexOf("\n");
  if (nl > 0) cut = cut.slice(0, nl);
  return cut.trimEnd() + NOTES_SUFFIX;
}

/** The install / notarization block that closes every GitHub release body. */
export function installText(notarized) {
  return notarized
    ? `Universal binary — runs natively on both **Apple Silicon** and **Intel** Macs.
Signed with a Developer ID certificate and notarized by Apple.

## Install

1. Download the \`.dmg\` below.
2. Open it and drag **Octopush.app** to **Applications**.
3. Launch Octopush from Applications.

Future versions arrive in-app via the auto-updater.
`
    : `Universal binary — runs natively on both **Apple Silicon** and **Intel** Macs.

## Install (first time only)

1. Download the \`.dmg\` below.
2. Open it and drag **Octopush.app** to **Applications**.
3. Open Terminal and run:

   \`\`\`
   xattr -cr /Applications/Octopush.app
   \`\`\`

4. Launch Octopush from Applications.

The \`xattr\` step removes macOS Gatekeeper's quarantine flag. It's only
needed for the first manual install — after that, future versions
arrive in-app via the auto-updater.
`;
}

/** GitHub release body: the changeset notes (if any) on top, then the install text. */
export function releaseBody({ version, notes, notarized }) {
  const n = String(notes ?? "").trim();
  if (!n) return `Octopush ${version}\n\n${installText(notarized)}`;
  return `${n}\n\n---\n\n${installText(notarized)}`;
}

/** The Tauri updater manifest. Universal payload → both arch keys point at it. */
export function buildManifest({ version, notes, signature, url, pubDate }) {
  const entry = { signature, url };
  const trimmed = trimNotes(notes);
  return {
    version,
    notes: trimmed || `Octopush ${version}`,
    pub_date: pubDate,
    platforms: { "darwin-aarch64": entry, "darwin-x86_64": entry },
  };
}

/**
 * Bump the app version in the four files a release commit touches, changing only
 * the version line of each (package.json and tauri.conf.json top-level
 * "version", Cargo.toml [package] version, Cargo.lock's `octopush` entry).
 * Throws if any file has no version to bump.
 */
export function bumpVersionTexts(files, version) {
  if (!VERSION.test(version)) throw new Error(`not an X.Y.Z version: "${version}"`);
  const rules = {
    pkg: /^(  "version":\s*)"[^"]+"/m,
    tauriConf: /^(  "version":\s*)"[^"]+"/m,
    cargoToml: /^(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/m,
    cargoLock: /(\[\[package\]\]\nname = "octopush"\nversion = )"[^"]+"/,
  };
  const out = {};
  for (const [key, re] of Object.entries(rules)) {
    const text = files[key];
    if (typeof text !== "string" || !re.test(text)) throw new Error(`no version to bump in ${key}`);
    out[key] = text.replace(re, `$1"${version}"`);
  }
  return out;
}

export const VERSION_FILES = {
  pkg: "package.json",
  tauriConf: "src-tauri/tauri.conf.json",
  cargoToml: "src-tauri/Cargo.toml",
  cargoLock: "src-tauri/Cargo.lock",
};

/** Apply bumpVersionTexts to a checkout on disk. */
export function bumpVersionFiles(root, version) {
  const files = Object.fromEntries(Object.entries(VERSION_FILES).map(([k, p]) => [k, readFileSync(join(root, p), "utf8")]));
  const bumped = bumpVersionTexts(files, version);
  for (const [k, p] of Object.entries(VERSION_FILES)) writeFileSync(join(root, p), bumped[k]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, version, root] = process.argv.slice(2);
  if (cmd === "bump" && version) {
    try {
      bumpVersionFiles(resolve(root ?? join(fileURLToPath(new URL(".", import.meta.url)), "..")), version);
      console.log(`bumped to ${version}`);
    } catch (e) {
      console.error(`release-lib: ${e.message}`);
      process.exit(2);
    }
  } else {
    console.error("usage: release-lib.mjs bump <version> [<repo-root>]");
    process.exit(64);
  }
}
