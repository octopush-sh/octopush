#!/usr/bin/env node
// After a promotion to stable, bring octopush-web's version chain along:
// `src/data/release.ts` VERSION and one changelog entry per release since the
// landing's last version (the website's truth rule: VERSION must be the
// stable app). promote.yml's `web-version` job runs this in a checkout of
// octopush-web and opens the PR; the owner merges it (VISION §8).
//
//   node scripts/web-version.mjs <web-checkout> <new-version>   (reads releases with gh)
//
// No agent is involved: the entries are the release notes' user-facing
// sections (Features, Improvements, Fixes), reformatted to the changelog's
// style. Release notes come from reviewed whats-new changesets.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SEMVER = /^\d+\.\d+\.\d+$/;
const cmp = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/** The landing's current VERSION. */
export function currentVersion(releaseTs) {
  const m = releaseTs.match(/export const VERSION = '(\d+\.\d+\.\d+)';/);
  if (!m) throw new Error("release.ts has no `export const VERSION = 'X.Y.Z';` line");
  return m[1];
}

export function bumpReleaseTs(releaseTs, version) {
  if (!SEMVER.test(version)) throw new Error(`not a version: ${version}`);
  return releaseTs.replace(/export const VERSION = '\d+\.\d+\.\d+';/, `export const VERSION = '${version}';`);
}

/** Published versions after `from` up to and including `to`, oldest first. */
export function versionsBetween(tags, from, to) {
  return [...new Set(tags.map((t) => t.replace(/^v/, "")).filter((v) => SEMVER.test(v)))]
    .filter((v) => cmp(v, from) > 0 && cmp(v, to) <= 0)
    .sort(cmp);
}

// Release-note text made safe for the changelog page: no raw HTML (escaped
// outside code spans), no links (their text is kept), and no single-asterisk
// or underscore emphasis, which would render in italics (retired site-wide).
export function plain(s) {
  return String(s).split(/(`[^`]*`)/).map((part, i) => {
    if (i % 2) return part; // a code span renders its text literally
    return part
      .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, "$1$2")
      .replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
      .replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }).join("");
}

/**
 * One changelog entry from a release body: the bullets of its Features,
 * Improvements and Fixes sections ("- **Title** — text" becomes
 * "**Title.** text"). Null when the release has no user-facing change.
 */
export function changelogEntry(version, body) {
  const out = [];
  let keep = false;
  for (const line of String(body ?? "").split("\n")) {
    const h = line.match(/^###\s+(.+?)\s*$/);
    if (h) { keep = /^(features|improvements|fixes)$/i.test(h[1]); continue; }
    if (/^(##\s|---\s*$)/.test(line)) { keep = false; continue; }
    if (!keep) continue;
    const b = line.match(/^- \*\*(.+?)\*\*\s*[—–-]\s*(.+)$/);
    if (b) out.push(`**${plain(b[1].replace(/[.:]$/, ""))}.** ${plain(b[2].trim())}`);
  }
  return out.length ? `## v${version}\n\n${out.join("\n\n")}\n` : null;
}

/** The changelog with `entries` (newest first) above its newest `## v` entry. */
export function insertEntries(changelog, entries) {
  if (!entries.length) return changelog;
  const i = changelog.search(/^## v\d/m);
  const block = entries.join("\n");
  return i < 0 ? `${changelog.trimEnd()}\n\n${block}` : `${changelog.slice(0, i)}${block}\n${changelog.slice(i)}`;
}

/** Edit a web checkout for `version`. Returns what changed, or null when nothing to do. */
export function apply(webDir, version, releases) {
  const relPath = join(webDir, "src/data/release.ts");
  const logPath = join(webDir, "src/content/docs/docs/changelog.md");
  const rel = readFileSync(relPath, "utf8");
  const from = currentVersion(rel);
  if (cmp(version, from) <= 0) return null;
  const byVersion = new Map(releases.map((r) => [r.tag_name.replace(/^v/, ""), r.body]));
  const versions = versionsBetween([...byVersion.keys()], from, version);
  if (!versions.includes(version)) throw new Error(`no release v${version}`);
  // Betas folded into this stable each get their entry; the changelog needs
  // at least the new version's heading (consistency-check reads it).
  const entries = [...versions].reverse().map((v) => changelogEntry(v, byVersion.get(v)) ?? (v === version ? `## v${v}\n\nMaintenance and reliability fixes.\n` : null)).filter(Boolean);
  writeFileSync(relPath, bumpReleaseTs(rel, version));
  writeFileSync(logPath, insertEntries(readFileSync(logPath, "utf8"), entries));
  return { from, versions };
}

function main() {
  const [webDir, version] = process.argv.slice(2);
  if (!webDir || !SEMVER.test(version ?? "")) { console.error("usage: web-version.mjs <web-checkout> <X.Y.Z>"); return 64; }
  const repo = process.env.OCTOPUSH_APP_REPO || "octopush-sh/octopush";
  // Only the fields used: the full objects (assets included) outgrow any buffer.
  const out = execFileSync("gh", ["api", "--paginate", `repos/${repo}/releases?per_page=100`, "--jq", ".[] | select(.draft | not) | {tag_name, body}"],
    { encoding: "utf8", maxBuffer: 64 << 20 });
  const releases = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const r = apply(webDir, version, releases);
  if (!r) { console.log(`the landing is already at ${version} or newer`); return 0; }
  console.log(`landing ${r.from} → ${version}; changelog entries: ${r.versions.join(", ")}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
