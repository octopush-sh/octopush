// Pure helpers for the clip recorder (scripts/clips/record.mjs). No I/O here
// beyond what callers pass in, so `node --test scripts/clips/lib.test.mjs`
// covers the decisions without a browser.
import { parse as parseYaml } from "yaml";

export const MAX_CLIP_BYTES = 1.5 * 1024 * 1024;
export const VERSION = /^\d+\.\d+\.\d+$/;

/** Split `---\nyaml\n---\nbody` into {meta, body} (same format as scripts/whats-new.mjs). */
export function parseChangeset(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) throw new Error("missing --- frontmatter --- block");
  const meta = parseYaml(m[1]) ?? {};
  if (typeof meta !== "object" || Array.isArray(meta)) throw new Error("frontmatter must be a mapping");
  return { meta, body: m[2].trim() };
}

/** Parse `<version|unreleased> [--slug s] [--force] [--verbose] [--keep-raw]`. */
export function parseArgs(argv) {
  const out = { dir: null, slug: null, force: false, verbose: false, keepRaw: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") out.force = true;
    else if (a === "--verbose" || a === "-v") out.verbose = true;
    else if (a === "--keep-raw") out.keepRaw = true;
    else if (a === "--slug") out.slug = argv[++i] ?? null;
    else if (a.startsWith("--slug=")) out.slug = a.slice(7);
    else if (!a.startsWith("-") && out.dir === null) out.dir = a.replace(/^v(?=\d)/, "");
    else throw new Error(`unexpected argument "${a}"`);
  }
  if (!out.dir || !(out.dir === "unreleased" || VERSION.test(out.dir))) {
    throw new Error("usage: npm run clips:record -- <version|unreleased> [--slug <s>] [--force] [--verbose]");
  }
  return out;
}

/**
 * Decide which changesets get a clip.
 * entries: [{ slug, meta, hasClip }] (meta = parsed frontmatter, or null if unparseable)
 * Returns { record: [{slug, scenario, steps}], skipped: [{slug, reason}] }.
 */
export function selectChangesets(entries, { slug = null, force = false } = {}) {
  const record = [];
  const skipped = [];
  for (const e of entries) {
    if (slug && e.slug !== slug) continue;
    const m = e.meta;
    if (!m) { skipped.push({ slug: e.slug, reason: "unparseable frontmatter" }); continue; }
    if (m.area !== "app") { skipped.push({ slug: e.slug, reason: `area: ${m.area ?? "missing"}` }); continue; }
    if (!Array.isArray(m.steps) || m.steps.length === 0) { skipped.push({ slug: e.slug, reason: "no steps" }); continue; }
    if (e.hasClip && !force) { skipped.push({ slug: e.slug, reason: "clip exists (use --force)" }); continue; }
    record.push({ slug: e.slug, scenario: m.scenario ?? "default", steps: m.steps.map(normalizeStep) });
  }
  if (slug && record.length === 0 && skipped.length === 0) skipped.push({ slug, reason: "no such changeset" });
  return { record, skipped };
}

export function normalizeStep(s) {
  return {
    open: typeof s.open === "string" ? s.open : null,
    target: String(s.target ?? ""),
    caption: String(s.caption ?? ""),
    action: s.action ?? "none",
    text: typeof s.text === "string" ? s.text : null,
  };
}

/** How long a step's caption stays up: reading time, clamped. */
export function stepDwellMs(caption) {
  const words = String(caption).trim().split(/\s+/).filter(Boolean).length;
  return Math.min(4200, Math.max(1800, 900 + words * 220));
}

/** Encode attempts, best first. ffmpeg VP9; each step trades fps then bitrate. */
export const ENCODE_LADDER = [
  { fps: 30, kbps: 800 },
  { fps: 24, kbps: 650 },
  { fps: 20, kbps: 500 },
  { fps: 15, kbps: 380 },
  { fps: 12, kbps: 280 },
  { fps: 10, kbps: 200 },
];

/**
 * Size-fitting loop decision after an encode attempt.
 * Returns "accept" (fits), "retry" (try ladder[attempt + 1]) or "give-up".
 */
export function fitDecision(sizeBytes, attempt, { limit = MAX_CLIP_BYTES, ladder = ENCODE_LADDER } = {}) {
  if (sizeBytes > 0 && sizeBytes <= limit) return "accept";
  if (sizeBytes <= 0) return "give-up"; // the encoder produced nothing: don't loop on it
  return attempt + 1 < ladder.length ? "retry" : "give-up";
}

/**
 * A bitrate that would land under the limit for this duration (with 8% headroom
 * for container overhead), used to skip ladder rungs that cannot fit.
 */
export function maxKbpsFor(durationSec, limit = MAX_CLIP_BYTES) {
  if (!(durationSec > 0)) return Infinity;
  return Math.floor(((limit * 8) / 1000 / durationSec) * 0.92);
}

/** First ladder index worth trying for a clip of this duration. */
export function firstRung(durationSec, { limit = MAX_CLIP_BYTES, ladder = ENCODE_LADDER } = {}) {
  const cap = maxKbpsFor(durationSec, limit);
  const i = ladder.findIndex((r) => r.kbps <= cap);
  return i === -1 ? ladder.length - 1 : i;
}
