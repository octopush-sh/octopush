// What's new — pure model over the bundled changesets (docs/WHATS-NEW.md).
//
// Changesets are bundled at build time (`whatsNewBundle.ts`, Vite
// `import.meta.glob`) as `{ "/whats-new/<version>/<slug>.md": raw }`. This
// module turns those into tips: only `area: app` entries whose `highlight` is
// on (default true for feature/improvement, false for fix), grouped by version
// (the directory name), semver-sorted. No DOM, no IPC — unit-tested directly.
import { parse as parseYaml } from "yaml";

export type TourAction = "none" | "click" | "hover" | "type";

export interface TourStep {
  /** A named surface (src/lib/tour/surfaces.ts) to open before the step. */
  open?: string;
  /** A `data-tour` id. */
  target: string;
  caption: string;
  /** What the clip recorder does on this step. The interactive tour never acts. */
  action?: TourAction;
  /** Text typed by the recorder when `action: type`. */
  text?: string;
}

export type TipKind = "feature" | "improvement" | "fix";

export interface Tip {
  slug: string;
  /** `X.Y.Z`, or `unreleased` for a dev preview. */
  version: string;
  title: string;
  kind: TipKind;
  /** Markdown inline (bold, code, links). */
  body: string;
  steps: TourStep[];
  /** Asset URL of `<slug>.webm` next to the changeset, when committed. */
  clip?: string;
}

export interface VersionTips {
  version: string;
  tips: Tip[];
}

export const UNRELEASED = "unreleased";
const VERSION = /^\d+\.\d+\.\d+$/;
const KINDS: readonly TipKind[] = ["feature", "improvement", "fix"];
const ACTIONS: readonly TourAction[] = ["none", "click", "hover", "type"];

/** Split `---\nyaml\n---\nbody` into {meta, body}; null when malformed. */
export function parseChangeset(text: string): { meta: Record<string, unknown>; body: string } | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return null;
  let meta: unknown;
  try {
    meta = parseYaml(m[1]) ?? {};
  } catch {
    return null;
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  return { meta: meta as Record<string, unknown>, body: m[2].trim() };
}

/** Compare `X.Y.Z` versions (a leading `v` and any `-pre`/`+build` suffix are
 *  ignored). Unparseable parts count as 0. */
export function compareSemver(a: string, b: string): number {
  const parts = (v: string) =>
    v.replace(/^v/, "").split(/[-+]/)[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Version-directory ordering: semver ascending, `unreleased` last. */
function compareVersionDir(a: string, b: string): number {
  if (a === b) return 0;
  if (a === UNRELEASED) return 1;
  if (b === UNRELEASED) return -1;
  return compareSemver(a, b);
}

function toSteps(raw: unknown): TourStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((s): TourStep[] => {
    if (!s || typeof s !== "object") return [];
    const st = s as Record<string, unknown>;
    if (typeof st.target !== "string" || typeof st.caption !== "string") return [];
    const action = ACTIONS.includes(st.action as TourAction) ? (st.action as TourAction) : "none";
    return [{
      ...(typeof st.open === "string" ? { open: st.open } : {}),
      target: st.target,
      caption: st.caption,
      action,
      ...(typeof st.text === "string" ? { text: st.text } : {}),
    }];
  });
}

/** `/whats-new/<version>/<slug>.<ext>` → {version, slug}. */
function splitPath(path: string): { version: string; slug: string } | null {
  const m = /(?:^|\/)whats-new\/([^/]+)\/([^/]+)\.(?:md|webm)$/.exec(path);
  return m ? { version: m[1], slug: m[2] } : null;
}

/** One changeset → a tip, or null when it isn't one (not app, highlight off,
 *  malformed, notes/README). */
export function toTip(path: string, raw: string, clipUrl?: string): Tip | null {
  const where = splitPath(path);
  if (!where) return null;
  const { version, slug } = where;
  if (slug === "notes" || slug.startsWith("README")) return null;
  if (version !== UNRELEASED && !VERSION.test(version)) return null;
  const parsed = parseChangeset(raw);
  if (!parsed) return null;
  const { meta, body } = parsed;
  if (meta.area !== "app") return null;
  if (!KINDS.includes(meta.kind as TipKind)) return null;
  const kind = meta.kind as TipKind;
  const highlight = typeof meta.highlight === "boolean" ? meta.highlight : kind !== "fix";
  if (!highlight) return null;
  if (typeof meta.title !== "string" || !meta.title.trim() || !body) return null;
  return {
    slug,
    version,
    title: meta.title.trim(),
    kind,
    body,
    steps: toSteps(meta.steps),
    ...(clipUrl ? { clip: clipUrl } : {}),
  };
}

/** Build the version-grouped tips from bundled raw changesets and clip URLs
 *  (both keyed by path). Versions ascend; within a version features come
 *  first, then improvements, then fixes, then by slug. */
export function buildTips(raws: Record<string, string>, clips: Record<string, string> = {}): VersionTips[] {
  const clipBySlug = new Map<string, string>();
  for (const [p, url] of Object.entries(clips)) {
    const w = splitPath(p);
    if (w) clipBySlug.set(`${w.version}/${w.slug}`, url);
  }
  const byVersion = new Map<string, Tip[]>();
  for (const [p, raw] of Object.entries(raws)) {
    const w = splitPath(p);
    const tip = toTip(p, raw, w ? clipBySlug.get(`${w.version}/${w.slug}`) : undefined);
    if (!tip) continue;
    const list = byVersion.get(tip.version) ?? [];
    list.push(tip);
    byVersion.set(tip.version, list);
  }
  return [...byVersion.entries()]
    .sort(([a], [b]) => compareVersionDir(a, b))
    .map(([version, tips]) => ({
      version,
      tips: tips.sort((x, y) => KINDS.indexOf(x.kind) - KINDS.indexOf(y.kind) || x.slug.localeCompare(y.slug)),
    }));
}

/** Released tips of every version in (from, to] — `from` exclusive (null = no
 *  lower bound), `to` inclusive — in version order. */
export function tipsInRange(all: VersionTips[], from: string | null, to: string): Tip[] {
  return all
    .filter((v) => v.version !== UNRELEASED)
    .filter((v) => (from === null || compareSemver(v.version, from) > 0) && compareSemver(v.version, to) <= 0)
    .flatMap((v) => v.tips);
}

/** Released tips of exactly one version. */
export function tipsForVersion(all: VersionTips[], version: string): Tip[] {
  return all.filter((v) => v.version !== UNRELEASED && compareSemver(v.version, version) === 0).flatMap((v) => v.tips);
}

export interface LaunchDecision {
  /** Tips to show now (empty ⇒ don't open). */
  tips: Tip[];
  /** Version to persist as `lastSeenVersion` — now when nothing opens, or
   *  once the modal actually shows when it does; null ⇒ leave it alone. */
  markSeen: string | null;
}

/** What to do at launch, given the persisted last-seen version and the
 *  installed one. Fresh install ⇒ remember silently. Upgrade ⇒ the tips of
 *  every version in (lastSeen, current]. Same version or a downgrade ⇒ nothing.
 *  `existingInstall` tells a real fresh install from someone upgrading to the
 *  first version that records `lastSeenVersion`: they get this version's tips. */
export function decideLaunch(
  lastSeen: string | null,
  current: string,
  all: VersionTips[],
  existingInstall = false,
): LaunchDecision {
  if (!lastSeen) return { tips: existingInstall ? tipsForVersion(all, current) : [], markSeen: current };
  if (compareSemver(current, lastSeen) <= 0) return { tips: [], markSeen: null };
  return { tips: tipsInRange(all, lastSeen, current), markSeen: current };
}

/** Label for the versions a set of tips spans: `v0.4.90`, or `v0.4.88 – v0.4.90`. */
export function versionLabel(tips: Tip[]): string {
  const versions = [...new Set(tips.map((t) => t.version))];
  const fmt = (v: string) => (v === UNRELEASED ? "Unreleased" : `v${v}`);
  if (versions.length === 0) return "";
  if (versions.length === 1) return fmt(versions[0]);
  return `${fmt(versions[0])} – ${fmt(versions[versions.length - 1])}`;
}
