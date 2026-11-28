#!/usr/bin/env node
// After a promotion to stable, bring octopush-web's version chain along:
// `src/data/release.ts` VERSION and one changelog entry per release since the
// landing's last version (the website's truth rule: VERSION must be the
// stable app). promote.yml's `web-version` job runs this in a checkout of
// octopush-web and opens the PR; the PM or the owner merges it (VISION §8).
//
//   node scripts/web-version.mjs <web-checkout> <new-version>   (reads releases with gh)
//   node scripts/web-version.mjs body <new-version> <pr-number> (the PR body; inputs in
//     GATE_LOG / GATE_RC / CREW_LOG / CREW_RC / CREW_CHANGED / CREW_SHA_BEFORE / CREW_SHA_AFTER / RUN_URL)
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
 * With `meta.date`, the heading is followed by the date line the web's
 * consistency gate requires on every entry.
 */
export function changelogEntry(version, body, meta = {}) {
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
  return out.length ? `${heading(version, meta)}${out.join("\n\n")}\n` : null;
}

/** The heading, plus the date line when the release date is known. */
function heading(version, { date, stable } = {}) {
  const line = date ? `<p class="changelog-date">${stable ? "Stable" : "Beta"} <time datetime="${date}">${date}</time></p>\n\n` : "";
  return `## v${version}\n\n${line}`;
}

// The changelog's dates are calendar days in the owner's time zone, as the
// entries since web#188 are (a release cut at 22:00 there is dated that day,
// not UTC's).
const CHANGELOG_TZ = "America/Bogota";

/** A release's `published_at` as the changelog's YYYY-MM-DD, or null. */
export function changelogDate(publishedAt) {
  const t = Date.parse(publishedAt ?? "");
  if (Number.isNaN(t)) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: CHANGELOG_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
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
  const byVersion = new Map(releases.map((r) => [r.tag_name.replace(/^v/, ""), r]));
  const versions = versionsBetween([...byVersion.keys()], from, version);
  if (!versions.includes(version)) throw new Error(`no release v${version}`);
  // Betas folded into this stable each get their entry; the changelog needs
  // at least the new version's heading (consistency-check reads it).
  // The version being promoted is stable; a beta folded into it is labelled
  // by its own release (a stable the landing skipped stays "Stable").
  const entries = [...versions].reverse().map((v) => {
    const r = byVersion.get(v);
    const meta = { date: changelogDate(r.published_at), stable: v === version || r.prerelease === false };
    return changelogEntry(v, r.body, meta) ?? (v === version ? `${heading(v, meta)}Maintenance and reliability fixes.\n` : null);
  }).filter(Boolean);
  writeFileSync(relPath, bumpReleaseTs(rel, version));
  writeFileSync(logPath, insertEntries(readFileSync(logPath, "utf8"), entries));
  return { from, versions };
}

// The PR body promote.yml writes after it regenerated the crew pricing and ran
// the website's consistency gate as octo-sandbox (#1178). Their output is the
// website's own code talking, so it is quoted in a fenced block only, capped.

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const logLines = (log) => String(log ?? "").replace(ANSI, "").split("\n").map((l) => l.trimEnd());
const fenced = (lines) => ["````text", ...lines.slice(0, 40).map((l) => l.slice(0, 400)), ...(lines.length > 40 ? [`… ${lines.length - 40} more lines in the run log`] : []), "````"];

/**
 * The gate's verdict from its log and exit code ("" or undefined: it never
 * ran): { state: passed | failed | missing, summary, failed, tail }. `failed`
 * holds its ✗ lines; `tail` is the end of the log when it failed without one
 * (npm ci or the script itself broke).
 */
export function gateResult(log, rc) {
  const lines = logLines(log);
  const summary = lines.map((l) => l.trim()).find((l) => /^\d+ passed · \d+ failed/.test(l)) ?? null;
  const failed = lines.map((l) => l.trim()).filter((l) => l.startsWith("✗"));
  if (rc === undefined || rc === null || String(rc) === "") return { state: "missing", summary: null, failed: [], tail: [] };
  if (String(rc) === "0") return { state: "passed", summary, failed: [], tail: [] };
  return { state: "failed", summary, failed, tail: failed.length ? [] : lines.filter((l) => l.trim()).slice(-25) };
}

/**
 * The release PR's body. `gate` is gateResult(); `crew` is { rc, log,
 * changed, shaBefore, shaAfter } from build-crew-pricing.mjs (rc "" when it
 * never ran).
 */
export function releasePrBody({ version, pr, gate, crew = {}, runUrl = "" }) {
  const v = `v${version}`;
  const run = runUrl ? ` ([run](${runUrl}))` : "";
  const local = (cmd) => `\`OCTOPUSH_APP_DIR=../octopush OCTOPUSH_STABLE_VERSION=${version} ${cmd}\` (with the app checked out at \`${v}\`)`;
  const out = [];
  if (gate.state === "failed") {
    out.push("> [!CAUTION]", `> **The consistency gate failed** with the app at \`${v}\`. Fix the failing checks below on this branch before merging.`, "");
  } else if (gate.state === "missing") {
    out.push("> [!WARNING]", `> **The consistency gate did not run**${run}. Run ${local("npm run consistency")} before merging.`, "");
  }
  const merge = gate.state === "passed" ? `Reply \`merge web#${pr}\` in the digest to publish it.` : `Once the gate passes, reply \`merge web#${pr}\` in the digest to publish it.`;
  out.push(`${v} was promoted to stable, so the landing's \`VERSION\` and the changelog follow it, and \`src/data/crew-pricing.json\` is regenerated from the app at that tag. The entries are written from the release notes by \`scripts/web-version.mjs\` in the app repo, run by promote.yml. ${merge}`, "");

  out.push("### Crew pricing", "");
  const crewRc = crew.rc === undefined || crew.rc === null ? "" : String(crew.rc);
  if (crewRc === "0") {
    out.push(crew.changed
      ? `\`node scripts/build-crew-pricing.mjs\` regenerated \`src/data/crew-pricing.json\` from the app at \`${v}\`; this PR carries the change.`
      : `\`node scripts/build-crew-pricing.mjs\` regenerated \`src/data/crew-pricing.json\` from the app at \`${v}\`: no change.`);
    const wrote = logLines(crew.log).find((l) => l.startsWith("wrote "));
    if (wrote) out.push("", ...fenced([wrote]));
    if (crew.shaBefore && crew.shaAfter && crew.shaBefore !== crew.shaAfter) {
      out.push("", "> [!IMPORTANT]", `> \`estimator.sourceSha256\` changed: the app's \`estimate_run_cost\` / \`estimate_run\` / \`range\` / \`pick_reference_model\` changed at \`${v}\`. Re-read them and update the mirror in \`src/lib/crewEstimate.ts\` (and its tests) on this branch before merging. The gate compares the JSON, not that mirror.`);
    }
  } else if (crewRc === "") {
    out.push(`**Not regenerated**: the step did not run${run}. Run ${local("node scripts/build-crew-pricing.mjs")} and commit the result here.`);
  } else {
    out.push(`**Could not be regenerated** from the app at \`${v}\` (exit ${crewRc}); the file is unchanged. If the app's pricing code changed shape, fix the reader in \`scripts/lib/crew-pricing.mjs\`.`, "", ...fenced(logLines(crew.log).filter((l) => l.trim())));
  }

  out.push("", "### Consistency gate", "");
  const how = `\`npm run consistency\` with \`OCTOPUSH_APP_DIR\` set to the app checked out at \`${v}\`, \`OCTOPUSH_STABLE_VERSION=${version}\` and \`OCTOPUSH_STRICT_RELEASE=1\`, run by promote.yml as an unprivileged user without a token${run}`;
  if (gate.state === "passed") {
    out.push(`**Passed**: ${how}.${gate.summary ? ` ${gate.summary}.` : ""}`);
  } else if (gate.state === "failed") {
    out.push(`**Failed**: ${how}.${gate.summary ? ` ${gate.summary}.` : ""}`, "", ...fenced(gate.failed.length ? gate.failed : gate.tail));
  } else {
    out.push(`**Did not run**${run}: the sandboxed step failed before the gate. Run ${local("npm run consistency")}.`);
  }
  return `${out.join("\n")}\n`;
}

function body(version, pr, env = process.env) {
  if (!SEMVER.test(version ?? "") || !/^\d+$/.test(pr ?? "")) { console.error("usage: web-version.mjs body <X.Y.Z> <pr-number>"); return 64; }
  const file = (p) => { try { return p ? readFileSync(p, "utf8") : ""; } catch { return ""; } };
  process.stdout.write(releasePrBody({
    version, pr,
    gate: gateResult(file(env.GATE_LOG), env.GATE_RC),
    crew: { rc: env.CREW_RC, log: file(env.CREW_LOG), changed: env.CREW_CHANGED === "1", shaBefore: env.CREW_SHA_BEFORE, shaAfter: env.CREW_SHA_AFTER },
    runUrl: env.RUN_URL,
  }));
  return 0;
}

function main() {
  if (process.argv[2] === "body") return body(process.argv[3], process.argv[4]);
  const [webDir, version] = process.argv.slice(2);
  if (!webDir || !SEMVER.test(version ?? "")) { console.error("usage: web-version.mjs <web-checkout> <X.Y.Z> | body <X.Y.Z> <pr-number>"); return 64; }
  const repo = process.env.OCTOPUSH_APP_REPO || "octopush-sh/octopush";
  // Only the fields used: the full objects (assets included) outgrow any buffer.
  const out = execFileSync("gh", ["api", "--paginate", `repos/${repo}/releases?per_page=100`, "--jq", ".[] | select(.draft | not) | {tag_name, body, published_at, prerelease}"],
    { encoding: "utf8", maxBuffer: 64 << 20 });
  const releases = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const r = apply(webDir, version, releases);
  if (!r) { console.log(`the landing is already at ${version} or newer`); return 0; }
  console.log(`landing ${r.from} → ${version}; changelog entries: ${r.versions.join(", ")}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
