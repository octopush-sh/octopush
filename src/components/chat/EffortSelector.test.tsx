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
    // What each preset sends, as its tooltip says it (Deep's `max` is turned
    // into each model's highest by the backend's adapters).
    expect(EFFORT_REASONING).toEqual({ swift: "low", standard: null, deep: "max" });
    const said = {
      swift: "low reasoning effort",
      standard: "the model's own default reasoning, with no effort or thinking setting sent",
      deep: "the most reasoning the model takes: effort max, or high where max isn't offered, or a 24K thinking budget",
    } as const;
    for (const o of OPTIONS) {
      expect(o.title).toContain(said[o.value]);
      expect(o.title).toContain(`up to ${cap[o.value]} output tokens`);
    }
  });
});
