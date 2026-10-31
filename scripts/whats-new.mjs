#!/usr/bin/env node
// What's new — validate and collect changesets. Contract: docs/WHATS-NEW.md.
//
//   node scripts/whats-new.mjs check
//       Validate every changeset (unreleased and released). Exit 1 on any error.
//   node scripts/whats-new.mjs collect <version> [--since <git-ref>]
//       Move whats-new/unreleased/* into whats-new/<version>/ and write
//       whats-new/<version>/notes.md. With --since, merged PRs between <git-ref>
//       and HEAD that brought no changeset are listed under "Maintenance".
//   node scripts/whats-new.mjs notes <version>
//       Print whats-new/<version>/notes.md (for release scripts).
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join, dirname, basename, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WN = join(ROOT, "whats-new");
const UNRELEASED = join(WN, "unreleased");
const SRC = join(ROOT, "src");
const SURFACES_FILE = join(SRC, "lib", "tour", "surfaces.ts");

const KINDS = ["feature", "improvement", "fix"];
const AREAS = ["app", "api", "web"];
const ACTIONS = ["none", "click", "hover", "type"];
const TOP_KEYS = new Set(["title", "kind", "area", "highlight", "scenario", "steps"]);
const STEP_KEYS = new Set(["open", "target", "caption", "action", "text"]);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const MAX_CLIP_BYTES = 1.5 * 1024 * 1024;

/** Split `---\nyaml\n---\nbody` into {meta, body}. */
export function parseChangeset(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) throw new Error("missing --- frontmatter --- block");
  const meta = parseYaml(m[1]) ?? {};
  if (typeof meta !== "object" || Array.isArray(meta)) throw new Error("frontmatter must be a mapping");
  return { meta, body: m[2].trim() };
}

/** Every data-tour="id" in src/ (static string attributes, plus tourId("id") marks). */
function knownTargets() {
  const ids = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
      if (!/\.(tsx?|jsx?)$/.test(e.name) || /\.test\./.test(e.name)) continue;
      const text = readFileSync(p, "utf8");
      for (const m of text.matchAll(/data-tour=["'`{]+([a-z0-9-]+)["'`}]/g)) ids.add(m[1]);
      // Ids assigned through a variable are marked with tourId("id") (src/lib/tour/ids.ts).
      for (const m of text.matchAll(/\btourId\(\s*["'`]([a-z0-9-]+)["'`]\s*\)/g)) ids.add(m[1]);
    }
  };
  if (existsSync(SRC)) walk(SRC);
  return ids;
}

/** Surface names registered in src/lib/tour/surfaces.ts (keys like "settings/account"). */
function knownSurfaces() {
  if (!existsSync(SURFACES_FILE)) return new Set();
  const s = readFileSync(SURFACES_FILE, "utf8");
  return new Set([...s.matchAll(/["']([a-z0-9-]+(?:\/[a-z0-9-]+)*)["']\s*:/g)].map((m) => m[1]));
}

/** Validate one changeset; returns a list of error strings. */
export function validate(file, text, { targets, surfaces }) {
  const errs = [];
  const slug = basename(file, ".md");
  if (!SLUG.test(slug) || slug.length > 48) errs.push(`slug "${slug}" must be kebab-case, ≤ 48 chars`);
  let meta, body;
  try { ({ meta, body } = parseChangeset(text)); } catch (e) { return [`${e.message}`]; }
  for (const k of Object.keys(meta)) if (!TOP_KEYS.has(k)) errs.push(`unknown key "${k}"`);
  if (typeof meta.title !== "string" || !meta.title.trim()) errs.push("title is required");
  else if (meta.title.length > 60) errs.push(`title is ${meta.title.length} chars (max 60)`);
  if (!KINDS.includes(meta.kind)) errs.push(`kind must be one of ${KINDS.join(" | ")}`);
  if (!AREAS.includes(meta.area)) errs.push(`area must be one of ${AREAS.join(" | ")}`);
  if (meta.highlight !== undefined && typeof meta.highlight !== "boolean") errs.push("highlight must be true or false");
  if (meta.scenario !== undefined && (typeof meta.scenario !== "string" || !SLUG.test(meta.scenario))) errs.push("scenario must be a kebab-case name");
  if (!body) errs.push("body (the release note / tip text) is required");
  else if (body.length > 400) errs.push(`body is ${body.length} chars (max 400)`);
  if (meta.steps !== undefined) {
    if (!Array.isArray(meta.steps) || meta.steps.length === 0) errs.push("steps must be a non-empty list");
    else {
      if (meta.steps.length > 6) errs.push(`${meta.steps.length} steps (max 6)`);
      if (meta.area !== "app") errs.push("steps are only allowed for area: app");
      meta.steps.forEach((st, i) => {
        const at = `steps[${i}]`;
        if (!st || typeof st !== "object") { errs.push(`${at} must be a mapping`); return; }
        for (const k of Object.keys(st)) if (!STEP_KEYS.has(k)) errs.push(`${at}: unknown key "${k}"`);
        if (typeof st.target !== "string") errs.push(`${at}: target is required`);
        else if (!targets.has(st.target)) errs.push(`${at}: no element has data-tour="${st.target}" in src/`);
        if (typeof st.caption !== "string" || !st.caption.trim()) errs.push(`${at}: caption is required`);
        else if (st.caption.length > 140) errs.push(`${at}: caption is ${st.caption.length} chars (max 140)`);
        const action = st.action ?? "none";
        if (!ACTIONS.includes(action)) errs.push(`${at}: action must be one of ${ACTIONS.join(" | ")}`);
        if (action === "type" && typeof st.text !== "string") errs.push(`${at}: text is required for action: type`);
        if (st.open !== undefined && !surfaces.has(st.open)) errs.push(`${at}: open "${st.open}" is not a registered surface (src/lib/tour/surfaces.ts)`);
      });
    }
  }
  const clip = join(dirname(file), `${slug}.webm`);
  if (existsSync(clip) && statSync(clip).size > MAX_CLIP_BYTES) errs.push(`${slug}.webm is larger than 1.5 MB`);
  return errs;
}

function changesetFiles(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "notes.md" && !f.startsWith("README")).map((f) => join(dir, f)) : [];
}

function check() {
  const ctx = { targets: knownTargets(), surfaces: knownSurfaces() };
  const dirs = existsSync(WN) ? readdirSync(WN).filter((d) => d === "unreleased" || VERSION.test(d)).map((d) => join(WN, d)) : [];
  let n = 0, bad = 0;
  for (const dir of dirs) for (const f of changesetFiles(dir)) {
    n++;
    const errs = validate(f, readFileSync(f, "utf8"), ctx);
    if (errs.length) { bad++; for (const e of errs) console.error(`${relative(ROOT, f)}: ${e}`); }
  }
  if (bad) { console.error(`\n${bad} of ${n} changeset(s) invalid — see docs/WHATS-NEW.md`); process.exit(1); }
  console.log(`whats-new: ${n} changeset(s) valid ✓`);
}

/** Merged PR titles (from merge commits) between ref and HEAD: [{number, title}]. */
function mergedPrs(since) {
  const out = execFileSync("git", ["log", "--merges", "--format=%s%x1f%b%x1e", `${since}..HEAD`], { cwd: ROOT, encoding: "utf8" });
  return out.split("\x1e").map((r) => r.trim()).filter(Boolean).flatMap((r) => {
    const [subject, body] = r.split("\x1f");
    const m = /^Merge pull request #(\d+)/.exec(subject);
    return m ? [{ number: Number(m[1]), title: (body ?? "").trim().split("\n")[0] || subject }] : [];
  });
}

export function renderNotes(version, entries, maintenance) {
  const lines = [`## Octopush ${version}`, ""];
  const groups = [["feature", "Features"], ["improvement", "Improvements"], ["fix", "Fixes"]];
  for (const [kind, heading] of groups) {
    const items = entries.filter((e) => e.meta.kind === kind);
    if (!items.length) continue;
    lines.push(`### ${heading}`, "");
    for (const e of items) {
      const where = e.meta.area === "app" ? "" : ` _(${e.meta.area === "api" ? "service" : "website"})_`;
      lines.push(`- **${e.meta.title}**${where} — ${e.body.replace(/\s*\n\s*/g, " ")}`);
    }
    lines.push("");
  }
  if (maintenance.length) {
    lines.push("### Maintenance", "", maintenance.map((p) => `${p.title} (#${p.number})`).join(" · "), "");
  }
  if (!entries.length && !maintenance.length) lines.push("Maintenance release.", "");
  return lines.join("\n").trimEnd() + "\n";
}

function collect(version, since) {
  if (!VERSION.test(version)) { console.error(`version "${version}" must be X.Y.Z`); process.exit(2); }
  const dest = join(WN, version);
  if (existsSync(join(dest, "notes.md"))) { console.error(`whats-new/${version}/notes.md already exists`); process.exit(2); }
  mkdirSync(dest, { recursive: true });
  const moved = [];
  for (const f of changesetFiles(UNRELEASED)) {
    const slug = basename(f, ".md");
    renameSync(f, join(dest, `${slug}.md`));
    const clip = join(UNRELEASED, `${slug}.webm`);
    if (existsSync(clip)) renameSync(clip, join(dest, `${slug}.webm`));
    moved.push(slug);
  }
  const entries = changesetFiles(dest).sort().map((f) => ({ slug: basename(f, ".md"), ...parseChangeset(readFileSync(f, "utf8")) }));
  let maintenance = [];
  if (since) {
    // A PR "brought" a changeset if its merge added a file in whats-new/unreleased/.
    const withChangeset = new Set();
    const log = execFileSync("git", ["log", "--merges", "--format=%s", "--diff-merges=first-parent", "--name-only", `${since}..HEAD`, "--", "whats-new/unreleased/"], { cwd: ROOT, encoding: "utf8" });
    for (const m of log.matchAll(/Merge pull request #(\d+)/g)) withChangeset.add(Number(m[1]));
    maintenance = mergedPrs(since).filter((p) => !withChangeset.has(p.number) && !/^chore: release v/i.test(p.title));
  }
  writeFileSync(join(dest, "notes.md"), renderNotes(version, entries, maintenance));
  console.log(`whats-new: ${moved.length} changeset(s) → whats-new/${version}/ · notes.md written`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "check") check();
else if (cmd === "collect") {
  const i = args.indexOf("--since");
  collect(args[0], i >= 0 ? args[i + 1] : undefined);
} else if (cmd === "notes") {
  const p = join(WN, args[0] ?? "", "notes.md");
  if (!existsSync(p)) { console.error(`no notes for ${args[0]}`); process.exit(1); }
  process.stdout.write(readFileSync(p, "utf8"));
} else if (cmd !== undefined || process.argv[1]?.endsWith("whats-new.mjs")) {
  console.error("usage: whats-new.mjs check | collect <version> [--since <ref>] | notes <version>");
  process.exit(64);
}
