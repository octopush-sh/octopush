import { describe, it, expect } from "vitest";
import { parseShellCommand } from "./shellCommand";

describe("parseShellCommand", () => {
  it("detects `$ <cmd>`", () => {
    expect(parseShellCommand("$ npm test")).toBe("npm test");
    expect(parseShellCommand("  $ git status  ")).toBe("git status");
  });

  it("detects `/run <cmd>`", () => {
    expect(parseShellCommand("/run npm run build")).toBe("npm run build");
  });

  it("requires a space after `$` so agent questions aren't intercepted", () => {
    expect(parseShellCommand("$PATH is empty, help")).toBeNull();
    expect(parseShellCommand("why is $HOME unset?")).toBeNull();
  });

  it("treats a leading `\\$` as an escaped literal, not a command", () => {
    expect(parseShellCommand("\\$ literal text to the agent")).toBeNull();
  });

  it("returns null for normal messages and bare triggers", () => {
    expect(parseShellCommand("explain this code")).toBeNull();
    expect(parseShellCommand("$")).toBeNull();
    expect(parseShellCommand("$   ")).toBeNull();
    expect(parseShellCommand("/run")).toBeNull();
  });

  it("preserves pipes, quotes and flags in the command", () => {
    expect(parseShellCommand('$ grep -n "foo" src/*.ts | head')).toBe(
      'grep -n "foo" src/*.ts | head',
    );
  });
});
