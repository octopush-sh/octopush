import { describe, it, expect } from "vitest";
import { clearsWait, modeForFlag, nextShownWaiting, shouldClearAttention } from "./attentionFocus";
import type { AttentionFlag } from "../stores/attentionStore";

describe("clearsWait", () => {
  it("ends a session's wait when it is focused, typed into or its turn ends", () => {
    expect(clearsWait({ type: "focus" })).toBe(true);
    expect(clearsWait({ type: "input" })).toBe(true);
    expect(clearsWait({ type: "settled" })).toBe(true);
  });

  it("keeps it when the pane leaves the screen or rings again", () => {
    expect(clearsWait({ type: "hidden" })).toBe(false);
    expect(clearsWait({ type: "attention", reason: "permission", shown: false })).toBe(false);
  });
});

const terminalFlag = (terminalId: string | null): AttentionFlag => ({
  kind: "terminal",
  at: 0,
  terminalId,
});
const chatFlag: AttentionFlag = { kind: "chat", at: 0, terminalId: null };

describe("shouldClearAttention", () => {
  it("does nothing without a flag", () => {
    expect(shouldClearAttention(undefined, "run", "t1")).toBe(false);
  });

  it("keeps a flag until the user is on the matching mode", () => {
    expect(shouldClearAttention(chatFlag, "run", null)).toBe(false);
    expect(shouldClearAttention(chatFlag, "talk", null)).toBe(true);
    expect(shouldClearAttention(terminalFlag("t1"), "talk", "t1")).toBe(false);
  });

  it("requires the ringing SESSION, not merely Run mode", () => {
    // The whole reason the rule narrowed: entering Run to work in another
    // session used to erase the marker the ringing one raised.
    expect(shouldClearAttention(terminalFlag("t2"), "run", "t1")).toBe(false);
    expect(shouldClearAttention(terminalFlag("t2"), "run", "t2")).toBe(true);
  });

  it("clears on the mode alone when the ping named no session", () => {
    // A daemon too old to report which terminal rang behaves as it always did.
    expect(shouldClearAttention(terminalFlag(null), "run", "t1")).toBe(true);
  });

  it("maps each flag kind to the surface it is asking for", () => {
    expect(modeForFlag(chatFlag)).toBe("talk");
    expect(modeForFlag(terminalFlag("t1"))).toBe("run");
  });
});

describe("nextShownWaiting", () => {
  const attention = (reason: "idle" | "permission" | "input" | null, shown = true) =>
    ({ type: "attention", reason, shown }) as const;

  it("marks a pane on screen with Claude Code's own hook reason", () => {
    expect(nextShownWaiting(null, attention("permission"))).toBe("permission");
    expect(nextShownWaiting(null, attention("input"))).toBe("input");
    // The latest reason wins.
    expect(nextShownWaiting("permission", attention("input"))).toBe("input");
  });

  it("never marks a pane that is off screen: the rail flag points at it", () => {
    expect(nextShownWaiting(null, attention("permission", false))).toBeNull();
    expect(nextShownWaiting("input", attention("permission", false))).toBeNull();
  });

  it("leaves the mark alone for the idle guess and for an event with no reason", () => {
    // `idle` is the daemon's heuristic; a missing reason is an older daemon or CLI.
    expect(nextShownWaiting(null, attention("idle"))).toBeNull();
    expect(nextShownWaiting(null, attention(null))).toBeNull();
    expect(nextShownWaiting("permission", attention("idle"))).toBe("permission");
    expect(nextShownWaiting("permission", attention(null))).toBe("permission");
  });

  it("clears on input, focus, the end of the turn and leaving the screen", () => {
    for (const type of ["input", "focus", "settled", "hidden"] as const) {
      expect(nextShownWaiting("permission", { type })).toBeNull();
      expect(nextShownWaiting(null, { type })).toBeNull();
    }
  });
});
