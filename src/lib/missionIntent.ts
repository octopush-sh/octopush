import { Hammer, Wrench, Eye, FlaskConical, PenTool, Gauge, Cog } from "lucide-react";
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
};
