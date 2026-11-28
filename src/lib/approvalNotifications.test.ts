import { describe, it, expect } from "vitest";
import { decideApprovalNotification } from "./approvalNotifications";

describe("decideApprovalNotification", () => {
  it("says what kind of thing waits and where, never the command", () => {
    expect(decideApprovalNotification({}, "auth-flow")).toEqual({
      title: "Talk needs a decision",
      body: "auth-flow — A command is waiting for your approval",
    });
  });

  it("names an MCP call or a file outside the workspace, never its arguments or path (#1147)", () => {
    expect(decideApprovalNotification({ kind: "mcp" }, "auth-flow").body).toBe(
      "auth-flow — An MCP tool call is waiting for your approval",
    );
    expect(decideApprovalNotification({ kind: "read" }, "auth-flow").body).toBe(
      "auth-flow — A file access outside the workspace is waiting for your approval",
    );
    expect(decideApprovalNotification({ kind: "write" }, null).body).toBe(
      "A workspace — A file access outside the workspace is waiting for your approval",
    );
    expect(decideApprovalNotification({ kind: "run" }, "auth-flow").body).toBe(
      "auth-flow — A command reaching outside the workspace is waiting for your approval",
    );
  });

  it("names an Ask first card as a change, never its diff or command (#1231)", () => {
    for (const kind of ["edit", "exec"] as const) {
      expect(decideApprovalNotification({ kind }, "auth-flow").body).toBe(
        "auth-flow — A change is waiting for your approval (Ask first)",
      );
    }
  });

  it("names a secret card for what it is, never what was found", () => {
    expect(decideApprovalNotification({ secret: true }, null)).toEqual({
      title: "Talk needs a decision",
      body: "A workspace — A commit or push is waiting for your approval (possible secret)",
    });
  });
});
