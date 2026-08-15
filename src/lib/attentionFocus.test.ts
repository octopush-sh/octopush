import { describe, it, expect } from "vitest";
import { modeForFlag, shouldClearAttention } from "./attentionFocus";
import type { AttentionFlag } from "../stores/attentionStore";

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
