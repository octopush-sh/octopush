import { describe, it, expect } from "vitest";
import { deriveRoleKey } from "./RoleEditor";

describe("deriveRoleKey", () => {
  it("snake-cases and lowercases a display name", () => {
    expect(deriveRoleKey("Perf Audit!")).toBe("perf_audit");
  });

  it("collapses multiple separators and trims", () => {
    expect(deriveRoleKey("  Ship   Release ")).toBe("ship_release");
  });

  it("handles already-lowercase alphanumeric", () => {
    expect(deriveRoleKey("plan")).toBe("plan");
  });

  it("collapses repeated underscores from special chars", () => {
    expect(deriveRoleKey("foo--bar")).toBe("foo_bar");
  });

  it("trims leading and trailing underscores", () => {
    expect(deriveRoleKey("!hello world!")).toBe("hello_world");
  });

  it("returns empty string for blank input", () => {
    expect(deriveRoleKey("   ")).toBe("");
  });
});
