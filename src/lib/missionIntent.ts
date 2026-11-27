import { Hammer, Wrench, Eye, FlaskConical, PenTool, Gauge, Cog, ClipboardCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/** Mission-intent glyphs. `build`/`fix` ship in M1; the rest arrive with later
 *  movements but map now so a stray/legacy value never renders without an icon.
 *  Shared by the ContextHeader intent chip and the Rail row glyph. */
export const INTENT_ICON: Record<string, LucideIcon> = {
  build: Hammer,
  fix: Wrench,
  review: Eye,
  probe: FlaskConical,
  design: PenTool,
  perf: Gauge,
  ops: Cog,
  test: ClipboardCheck,
};

/** Intents whose missions deliver their work (push, pull request, publish).
 *  Mirrors `mission::delivers`. */
const DELIVERING = ["build", "fix", "design", "ops"];

/** A mission that ships nothing: its agents work locally, and Octopush refuses
 *  what would change something elsewhere. Mirrors `mission::ships_nothing`;
 *  a read-only mission is Plan only, which is stricter. */
export function shipsNothing(intent: string | null, gitIsolation: string | null): boolean {
  return intent !== null && !DELIVERING.includes(intent) && gitIsolation !== null && gitIsolation !== "readonly";
}

/** The ContextHeader ship-nothing glyph's title. */
export const SHIPS_NOTHING_TITLE =
  "Runs locally, ships nothing: pushes, pull requests and publishes an agent asks for are refused";
