// Shared stage display helpers for the Direct mode surfaces (builder, launcher,
// run view). Kept framework-free so any component can import them without
// pulling in a heavy component module.

import { useRolesStore } from "../stores/rolesStore";
import { contextTone, type ContextTone } from "../components/ContextMeter";
import { formatContextTokens } from "./cost";

/** Compact token count — the single format across every Direct surface:
 *  1240 → "1.2k", 980 → "980". */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Tighter still, for the 150px essence card: no decimal from 10k up
 *  (18 412 → "18k"), millions as "1.2M". Under 10k it reads as `fmtTokens`.
 *  Not `formatTokenCount` (lib/cost.ts): that one drops the decimal below 10k
 *  too, while the essence card keeps "3.1k" so it agrees with the focus pane. */
export function fmtTokensShort(n: number): string {
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(1)}M`;
  // From 9 950 up, since `fmtTokens` would round those to "10.0k".
  if (n >= 9_950) return `${Math.round(n / 1000)}k`;
  return fmtTokens(n);
}

/** `fmtTokens` that reads millions as millions, for the full figures behind a
 *  shed token pair: 1 240 000 → "1.24M" (never "1240.0k"), 18 412 → "18.4k". */
export function fmtTokensFull(n: number): string {
  // From 999 950 up, since `fmtTokens` would round those to "1000.0k".
  if (n >= 999_950) return `${(n / 1_000_000).toFixed(2)}M`;
  return fmtTokens(n);
}

/** Characters of meta that fit on the essence card's one line: 150px less
 *  padding and border is 120px, 20ch of 10px mono, minus the row's two 8px gaps. */
export const ESSENCE_META_CH = 17;

/** The essence card's ladder (S1, E2): position and cost are the floor; the
 *  token pair is the one rung, shed whole when the line would overflow. */
export function essenceShedsTokens(position: string, cost: string, tokens: string): boolean {
  return position.length + cost.length + tokens.length > ESSENCE_META_CH;
}

/** A Claude CLI stage's context meter reading (#895): `ctx 142k / 200k`,
 *  through the shared `formatContextTokens`, toned by Talk's thresholds
 *  (`contextTone`: amber from 80%, rouge from 95%). `null` — the meter is
 *  hidden — before the stage's first message, for a Codex/API stage, and
 *  when the model's window is unknown: never drawn against a guessed 200k. */
export interface StageContextReading {
  label: string;
  tone: ContextTone;
  /** Share of the window used, 0–100. */
  pct: number;
  /** The exact figures, for the tooltip and screen readers. */
  title: string;
}

export function stageContextReading(s: {
  contextTokens?: number | null;
  contextWindow?: number | null;
}): StageContextReading | null {
  const used = s.contextTokens;
  const limit = s.contextWindow;
  if (used == null || used <= 0 || limit == null || limit <= 0) return null;
  const { pct, tone } = contextTone(used, limit);
  return {
    label: `ctx ${formatContextTokens(used)} / ${formatContextTokens(limit)}`,
    tone,
    pct,
    title: `Context: ${used.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} tokens (${Math.round(pct)}%), the prompt of the stage's latest message`,
  };
}

/** The Tailwind text class for a context tone on a meta line: mute while
 *  calm (meta, not an accent), amber past 80%, rouge past 95%. */
export function contextToneClass(tone: ContextTone): string {
  return tone === "rouge" ? "text-octo-rouge" : tone === "warning" ? "text-octo-warning" : "text-octo-mute";
}

/** Characters of meta that fit on a SUBJECT card's meta line: 210px less
 *  padding and border is 180px, 30ch of 10px mono. */
export const SUBJECT_META_CH = 30;
/** The substrate pill (8px caps, tracked, padded) in 10px-mono characters. */
const SUBJECT_PILL_CH = 5;
/** One 8px gap between atoms, in 10px-mono characters. */
const META_GAP_CH = 8 / 6;
/** The model id is the subject meta line's elastic atom: it truncates, but
 *  keeps at least this many characters, so it never reads as a bare "…". */
const SUBJECT_MODEL_FLOOR_CH = 4;

/** The subject card's meta ladder (#895, same E2 shed as the essence line):
 *  position, the model's floor, the shrink-0 notes (ran on · effort ·
 *  escalation) and the substrate pill are the floor; the context reading is
 *  the one rung, shed whole when it would not fit beside them. `notes` are
 *  the texts of the notes the line shows. The focus pane always has it. */
export function subjectShedsContext(position: string, context: string, notes: string[]): boolean {
  const atoms = 4 + notes.length; // position · model · context · pill · notes
  const fixed = position.length + SUBJECT_MODEL_FLOOR_CH + context.length + SUBJECT_PILL_CH;
  const noteCh = notes.reduce((n, t) => n + t.length, 0);
  return fixed + noteCh + (atoms - 1) * META_GAP_CH > SUBJECT_META_CH;
}

/** The role's display label — read from the loaded roles store (falls back to
 *  the key itself when roles have not yet loaded or the key is unknown). */
export function labelForRole(role: string): string {
  return useRolesStore.getState().roles.find((r) => r.key === role)?.label ?? role;
}

/** A stage's display title: the author's custom name when set, else the
 *  archetype label — so every Direct surface shows the names chosen in the
 *  builder. */
export function stageTitle(s: { role: string; customName?: string | null }): string {
  const custom = s.customName?.trim();
  return custom && custom.length > 0 ? custom : labelForRole(s.role);
}
