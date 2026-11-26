/**
 * The composer's Swift / Standard / Deep: each tooltip says the reasoning
 * effort and output cap the preset really sends, so the two can't drift.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../lib/ipc", () => ({ ipc: {} }));

import { OPTIONS } from "./EffortSelector";
import { EFFORT_MAX_TOKENS, EFFORT_REASONING } from "../../stores/chatStore";

describe("EffortSelector tooltips", () => {
  it("name the effort and the cap each preset sends", () => {
    expect(OPTIONS.map((o) => o.value)).toEqual(["swift", "standard", "deep"]);
    // The caps as the tooltips round them.
    expect(EFFORT_MAX_TOKENS).toEqual({ swift: 8192, standard: 32768, deep: 64000 });
    const cap = { swift: "8K", standard: "32K", deep: "64K" } as const;
    for (const o of OPTIONS) {
      expect(o.title).toContain(`${EFFORT_REASONING[o.value]} reasoning effort`);
      expect(o.title).toContain(`up to ${cap[o.value]} output tokens`);
      expect(o.title).toContain("A model without an effort setting gets only the cap.");
    }
  });
});
