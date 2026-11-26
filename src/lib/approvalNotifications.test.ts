import { describe, it, expect } from "vitest";
import { decideApprovalNotification } from "./approvalNotifications";

describe("decideApprovalNotification", () => {
  it("reaches you while Octopush is in the background", () => {
    expect(decideApprovalNotification({ command: "git push --force origin main" }, "auth-flow", false)).toEqual({
      title: "Talk needs a decision",
      body: "auth-flow — approve or deny git push --force origin main",
    });
  });

  it("stays quiet while the app has focus: the rail and Mission Control say it", () => {
    expect(decideApprovalNotification({ command: "rm -rf build" }, "auth-flow", true)).toBeNull();
  });

  it("names a secret card for what it is, never what was found", () => {
    const n = decideApprovalNotification({ command: "git commit -m x\nmore", secret: true }, null, false);
    expect(n).toEqual({ title: "Talk needs a decision", body: "a workspace — possible secret before git commit -m x" });
  });

  it("trims a long command", () => {
    const n = decideApprovalNotification({ command: `echo ${"x".repeat(200)}` }, "w", false)!;
    expect(n.body.length).toBeLessThan(110);
    expect(n.body.endsWith("…")).toBe(true);
  });
});
