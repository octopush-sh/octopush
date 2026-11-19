import { describe, it, expect } from "vitest";
import { sessionDoing } from "./sessionDoing";

const session = {
  role: "shell" as const,
  busy: false,
  command: null as string | null,
  failed: false,
  starting: false,
  running: true,
};

describe("sessionDoing", () => {
  it("names the role at rest and the command while it runs", () => {
    expect(sessionDoing(session)).toEqual({ text: "shell at the prompt", tone: "quiet" });
    expect(sessionDoing({ ...session, role: "dev" })).toEqual({ text: "dev server", tone: "quiet" });
    expect(sessionDoing({ ...session, busy: true, command: "npm run dev", role: "dev" })).toEqual({
      text: "npm run dev",
      tone: "live",
    });
  });

  it("says running, never the role, when the command couldn't be resolved", () => {
    expect(sessionDoing({ ...session, busy: true })).toEqual({ text: "running", tone: "live" });
  });

  it("puts Claude Code waiting on the user before what it runs", () => {
    const busy = { ...session, busy: true, command: "claude", role: "agent" as const };
    expect(sessionDoing(busy, { wait: "permission" }).text).toBe("waiting on permission");
    expect(sessionDoing(busy, { wait: "input" }).text).toBe("waiting on your input");
  });

  it("lets a setup run speak for its session until it succeeds", () => {
    const run = { workspaceId: "ws", exitCode: null };
    expect(sessionDoing(session, { setup: { ...run, status: "running" } })).toEqual({
      text: "setup · running",
      tone: "live",
    });
    expect(sessionDoing(session, { setup: { ...run, status: "failed", exitCode: 2 } })).toEqual({
      text: "setup failed · exit 2",
      tone: "failed",
    });
    expect(sessionDoing(session, { setup: { ...run, status: "ok", exitCode: 0 } }).text).toBe("shell at the prompt");
  });

  it("says so when the shell is still starting, or never started", () => {
    expect(sessionDoing({ ...session, starting: true })).toEqual({ text: "starting", tone: "quiet" });
    expect(sessionDoing({ ...session, failed: true, running: false })).toEqual({ text: "didn't start", tone: "failed" });
  });
});
