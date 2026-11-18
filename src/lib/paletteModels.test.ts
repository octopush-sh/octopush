import { describe, it, expect } from "vitest";
import { MODEL_PREVIEW, firstRevealedModel, paletteModelValue, paletteModels } from "./paletteModels";
import type { ModelWithProvider } from "./types";

const m = (id: string): ModelWithProvider => ({
  provider: "p",
  model: {
    id, displayName: id, inputCostPerM: 1, outputCostPerM: 1, cacheReadCostPerM: 0,
    cacheCreationCostPerM: 0, maxContext: 200000, supportsVision: false, supportsTools: true,
  },
});
const all = ["a", "b", "c", "d", "e", "f"].map(m);

describe("paletteModels (#850)", () => {
  it("previews a few models with no query and counts the rest", () => {
    const r = paletteModels(all, "", false);
    expect(r.shown.map((x) => x.model.id)).toEqual(["a", "b", "c"]);
    expect(r.shown).toHaveLength(MODEL_PREVIEW);
    expect(r.hidden).toBe(3);
  });

  it("leads the preview with the active session's model", () => {
    expect(paletteModels(all, "", false, "e").shown.map((x) => x.model.id)).toEqual(["e", "a", "b"]);
  });

  it("offers every model while searching, or once expanded", () => {
    expect(paletteModels(all, "qw", false)).toEqual({ shown: all, hidden: 0 });
    expect(paletteModels(all, "", true)).toEqual({ shown: all, hidden: 0 });
    expect(paletteModels(all, "   ", false).hidden).toBe(3);
  });

  it("shows a short list whole", () => {
    expect(paletteModels(all.slice(0, 3), "", false)).toEqual({ shown: all.slice(0, 3), hidden: 0 });
  });
});

describe("firstRevealedModel (#897)", () => {
  it("is the first model of the full list the preview left out", () => {
    const preview = paletteModels(all, "", false, "b").shown; // b, a, c
    expect(firstRevealedModel(all, preview)).toBe(all[3]);
  });

  it("is undefined when nothing was hidden", () => {
    expect(firstRevealedModel(all, all)).toBeUndefined();
  });

  it("keys a row on its provider and id", () => {
    expect(paletteModelValue(all[0])).toBe("model:p/a");
  });
});
