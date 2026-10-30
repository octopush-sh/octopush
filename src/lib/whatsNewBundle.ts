// The changesets bundled into the app (docs/WHATS-NEW.md §5).
//
// Released versions (`whats-new/X.Y.Z/`) are bundled eagerly. `unreleased/` is
// never shipped: its glob is lazy and sits behind `import.meta.env.DEV`, so a
// production build drops the branch — and with it the dynamic imports — at
// compile time. It only feeds the dev-only "Preview unreleased tips" action.
import { buildTips, UNRELEASED, type Tip, type VersionTips } from "./whatsNew";

const RELEASED_MD = import.meta.glob<string>(["/whats-new/*/*.md", "!/whats-new/unreleased/**"], {
  query: "?raw",
  import: "default",
  eager: true,
});
const RELEASED_CLIPS = import.meta.glob<string>(["/whats-new/*/*.webm", "!/whats-new/unreleased/**"], {
  query: "?url",
  import: "default",
  eager: true,
});

let cached: VersionTips[] | null = null;

/** Every released version's tips, ascending. */
export function releasedTips(): VersionTips[] {
  if (!cached) cached = buildTips(RELEASED_MD, RELEASED_CLIPS);
  return cached;
}

/** Dev builds only: the tips waiting in `whats-new/unreleased/`. Always empty
 *  in a shipped app. */
export async function unreleasedTips(): Promise<Tip[]> {
  if (!import.meta.env.DEV) return [];
  const md = import.meta.glob<string>("/whats-new/unreleased/*.md", { query: "?raw", import: "default" });
  const clips = import.meta.glob<string>("/whats-new/unreleased/*.webm", { query: "?url", import: "default" });
  const load = async (g: Record<string, () => Promise<string>>) =>
    Object.fromEntries(await Promise.all(Object.entries(g).map(async ([p, f]) => [p, await f()] as const)));
  const all = buildTips(await load(md), await load(clips));
  return all.find((v) => v.version === UNRELEASED)?.tips ?? [];
}
