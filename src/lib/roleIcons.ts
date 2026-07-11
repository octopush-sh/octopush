// The single icon vocabulary for Direct (and, from Plan 4, the Talk tool
// cards): one lucide glyph per role archetype and per tool verb. Replaces the
// retired `§` prefix — an icon + `title` tooltip instead of a typographic mark.
// Spec: docs/superpowers/specs/2026-07-11-direct-beauty-redesign-design.md §4.3

import {
  BadgeCheck, CircleDashed, ClipboardList, Compass, Eye, FlaskConical,
  GitMerge, GitPullRequest, Globe, Hammer, PenLine, Pencil, Rocket, Search,
  Shield, SquareTerminal, Wrench, type LucideIcon,
} from "lucide-react";

const ROLE_ICON: Record<string, LucideIcon> = {
  plan: ClipboardList,
  plan_review: PenLine,
  architect: Compass,
  implement: Wrench,
  code_review: Search,
  test: FlaskConical,
  repro: FlaskConical,
  fix: Hammer,
  verify: BadgeCheck,
  critique: PenLine,
  refine: PenLine,
  security_review: Shield,
  pull_request: GitPullRequest,
  merge: GitMerge,
  release: Rocket,
};

/** Icon for a stage role. Custom roles fall back to a neutral dashed circle. */
export function iconForRole(role: string): LucideIcon {
  return ROLE_ICON[role] ?? CircleDashed;
}

/** Icon for a live-journal tool verb. Substring match on the lowercased name
 *  so "Read", "read_file", and "READ" all resolve the same way. */
export function iconForTool(tool: string): LucideIcon {
  const t = tool.toLowerCase();
  if (t.includes("read") || t.includes("view") || t.includes("cat")) return Eye;
  if (t.includes("edit") || t.includes("write") || t.includes("patch")) return Pencil;
  if (t.includes("bash") || t.includes("run") || t.includes("exec") || t.includes("command") || t.includes("terminal")) return SquareTerminal;
  if (t.includes("web") || t.includes("fetch") || t.includes("http")) return Globe;
  if (t.includes("grep") || t.includes("glob") || t.includes("search") || t.includes("find")) return Search;
  return CircleDashed;
}
