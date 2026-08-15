// The single icon vocabulary for Direct (and, from Plan 4, the Talk tool
// cards): one lucide glyph per role archetype and per tool verb. Replaces the
// retired `§` prefix — an icon + `title` tooltip instead of a typographic mark.
// Spec: docs/superpowers/specs/2026-07-11-direct-beauty-redesign-design.md §4.3

import {
  BadgeCheck, ChevronRight, CircleDashed, ClipboardList, Compass, Eye, FlaskConical,
  GitBranch, GitMerge, GitPullRequest, Globe, Hammer, Package, PenLine, Pencil,
  Rocket, Search, Shield, Sparkles, SquareTerminal, Terminal, Wrench, type LucideIcon,
} from "lucide-react";
import type { SessionRole } from "./sessionRole";

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
  // web before search: "web_search" is a web tool, not a search tool.
  if (t.includes("web") || t.includes("fetch") || t.includes("http")) return Globe;
  if (t.includes("grep") || t.includes("glob") || t.includes("search") || t.includes("find")) return Search;
  return CircleDashed;
}

// ── Run mode · terminal sessions ──────────────────────────────────
// One glyph per session role. A terminal icon on every session would say
// "this is a terminal" once per session — information the user already has —
// so the icon names what is *running* instead. `unknown` keeps the neutral
// terminal glyph: an honest "something is running that we can't place".
const SESSION_ROLE_ICON: Record<SessionRole, LucideIcon> = {
  shell: ChevronRight,
  dev: Globe,
  build: Hammer,
  test: FlaskConical,
  deps: Package,
  git: GitBranch,
  agent: Sparkles,
  edit: PenLine,
  unknown: Terminal,
};

/** Icon for a terminal session's role (see `lib/sessionRole.ts`). */
export function iconForSessionRole(role: SessionRole): LucideIcon {
  return SESSION_ROLE_ICON[role] ?? Terminal;
}
