import { describe, it, expect } from "vitest";
import { CircleDashed, Eye, Pencil, Search, SquareTerminal, Wrench } from "lucide-react";
import { iconForRole, iconForTool } from "./roleIcons";

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
