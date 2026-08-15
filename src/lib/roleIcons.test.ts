import { describe, it, expect } from "vitest";
import {
  ChevronRight, CircleDashed, Eye, FlaskConical, GitBranch, Globe, Hammer,
  Package, PenLine, Pencil, Search, Sparkles, SquareTerminal, Terminal, Wrench,
} from "lucide-react";
import { iconForRole, iconForSessionRole, iconForTool } from "./roleIcons";
import type { SessionRole } from "./sessionRole";

describe("iconForRole", () => {
  it("maps every built-in archetype to a real icon", () => {
    const builtIns = [
      "plan", "plan_review", "architect", "implement", "code_review", "test",
      "repro", "fix", "verify", "critique", "refine", "security_review",
      "pull_request", "merge", "release",
    ];
    for (const role of builtIns) expect(iconForRole(role)).not.toBe(CircleDashed);
  });

  it("implement uses the wrench", () => {
    expect(iconForRole("implement")).toBe(Wrench);
  });

  it("falls back to CircleDashed for custom roles", () => {
    expect(iconForRole("my_custom_role")).toBe(CircleDashed);
  });
});

describe("iconForTool", () => {
  it("matches the tool verb case-insensitively", () => {
    expect(iconForTool("Read")).toBe(Eye);
    expect(iconForTool("EDIT")).toBe(Pencil);
    expect(iconForTool("Bash")).toBe(SquareTerminal);
    expect(iconForTool("Grep")).toBe(Search);
    expect(iconForTool("WebFetch")).toBe(iconForTool("web_search"));
  });

  it("falls back for unknown tools", () => {
    expect(iconForTool("Wizardry")).toBe(CircleDashed);
  });
});

describe("iconForSessionRole", () => {
  // The whole point of the session icon is that it encodes what is running, so
  // a mapping that silently collapsed to one glyph would defeat the feature
  // while every other test kept passing.
  it("gives each role its own glyph", () => {
    const expected: Record<SessionRole, unknown> = {
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
    for (const [role, icon] of Object.entries(expected)) {
      expect(iconForSessionRole(role as SessionRole)).toBe(icon);
    }
    const distinct = new Set(Object.values(expected));
    expect(distinct.size).toBe(Object.keys(expected).length);
  });

  it("falls back to the neutral terminal glyph for anything unrecognised", () => {
    expect(iconForSessionRole("nonsense" as SessionRole)).toBe(Terminal);
  });
});
