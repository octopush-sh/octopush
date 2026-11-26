import { describe, it, expect } from "vitest";
import { decideApprovalNotification } from "./approvalNotifications";

describe("decideApprovalNotification", () => {
  it("says what kind of thing waits and where, never the command", () => {
    expect(decideApprovalNotification({}, "auth-flow")).toEqual({
      title: "Talk needs a decision",
      body: "auth-flow — A command is waiting for your approval",
    });
  });

  it("names a secret card for what it is, never what was found", () => {
    expect(decideApprovalNotification({ secret: true }, null)).toEqual({
      title: "Talk needs a decision",
      body: "A workspace — A commit or push is waiting for your approval (possible secret)",
    });
  });
});
