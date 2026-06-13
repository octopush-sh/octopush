import { FileText, Eye, Code2, FlaskConical, StickyNote } from "lucide-react";
import type { ArtifactKind } from "./graph";

/** One lucide glyph per artifact kind. Shared by the node and the palette so
 *  the icon for a kind is defined exactly once. */
export const ARTIFACT_ICON: Record<ArtifactKind, typeof FileText> = {
  plan: FileText,
  review: Eye,
  diff: Code2,
  tests: FlaskConical,
  note: StickyNote,
};
