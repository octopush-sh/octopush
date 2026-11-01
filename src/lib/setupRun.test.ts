import { describe, it, expect } from "vitest";
import { describeSetup, parseSetupExit } from "./setupRun";

describe("setupRun", () => {
  it("parses only a well-formed exit report", () => {
    expect(parseSetupExit("exit=0")).toBe(0);
    expect(parseSetupExit("exit=127")).toBe(127);
    expect(parseSetupExit("exit=")).toBeNull();
    expect(parseSetupExit("exit=-1")).toBeNull();
    expect(parseSetupExit("exit=1;rm")).toBeNull();
    expect(parseSetupExit("code=1")).toBeNull();
  });

  it("describes each state in one mono line", () => {
    expect(describeSetup({ workspaceId: "w", status: "running", exitCode: null })).toBe("setup · running");
    expect(describeSetup({ workspaceId: "w", status: "ok", exitCode: 0 })).toBe("setup · exit 0");
    expect(describeSetup({ workspaceId: "w", status: "failed", exitCode: 2 })).toBe("setup failed · exit 2");
  });
});
