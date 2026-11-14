import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./ipc", () => ({ ipc: { suggestModel: vi.fn() } }));
import { ipc } from "./ipc";
import {
  HELPER_MODEL_FALLBACK,
  _resetHelperModelsForTests,
  helperModelNow,
  resolveHelperModel,
} from "./helperModels";

const suggest = vi.mocked(ipc.suggestModel);
const suggestion = (modelId: string) => ({ modelId, provider: "anthropic", reason: "", estimatedCostTier: "low" as const });

beforeEach(() => {
  suggest.mockReset();
  _resetHelperModelsForTests();
});

describe("helper models", () => {
  it("resolve each tier through the builtin tag lookup and remember it", async () => {
    suggest.mockImplementation(async (t) => suggestion(t === "quick_fix" ? "claude-haiku-9" : "claude-sonnet-9"));
    expect(await resolveHelperModel("fast")).toBe("claude-haiku-9");
    expect(await resolveHelperModel("review")).toBe("claude-sonnet-9");
    expect(suggest.mock.calls.map((c) => c[0])).toEqual(["quick_fix", "code_review"]);
    expect(helperModelNow("fast")).toBe("claude-haiku-9");
    await resolveHelperModel("fast");
    expect(suggest).toHaveBeenCalledTimes(2); // asked once per tier
  });

  it("share one lookup while it is in flight", async () => {
    suggest.mockResolvedValue(suggestion("claude-sonnet-9"));
    const [a, b] = await Promise.all([resolveHelperModel("review"), resolveHelperModel("review")]);
    expect([a, b]).toEqual(["claude-sonnet-9", "claude-sonnet-9"]);
    expect(suggest).toHaveBeenCalledTimes(1);
  });

  it("fall back when the backend can't answer, and ask again later", async () => {
    suggest.mockRejectedValueOnce(new Error("ipc down"));
    expect(await resolveHelperModel("review")).toBe(HELPER_MODEL_FALLBACK.review);
    expect(helperModelNow("review")).toBe(HELPER_MODEL_FALLBACK.review);
    suggest.mockResolvedValueOnce(suggestion("claude-sonnet-9"));
    expect(await resolveHelperModel("review")).toBe("claude-sonnet-9");
  });

  it("never fall back to a legacy model", () => {
    const legacy = ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];
    for (const id of Object.values(HELPER_MODEL_FALLBACK)) expect(legacy).not.toContain(id);
    expect(HELPER_MODEL_FALLBACK).toEqual({ fast: "claude-haiku-5-5", review: "claude-sonnet-5-5" });
  });
});
