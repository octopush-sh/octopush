import { beforeEach, describe, expect, it } from "vitest";
import { useSupersededModelStore } from "./supersededModelStore";

beforeEach(() => {
  localStorage.clear();
  useSupersededModelStore.setState({ kept: {} });
});

describe("supersededModelStore", () => {
  it("keeps a model per pipeline, once", () => {
    const { keep } = useSupersededModelStore.getState();
    keep("p1", "claude-fable-5-1");
    keep("p1", "claude-fable-5-1");
    expect(useSupersededModelStore.getState().kept).toEqual({ p1: ["claude-fable-5-1"] });
    expect(useSupersededModelStore.getState().isKept("p1", "claude-fable-5-1")).toBe(true);
    expect(useSupersededModelStore.getState().isKept("p2", "claude-fable-5-1")).toBe(false);
  });

  it("persists the choice across a rehydrate", async () => {
    useSupersededModelStore.getState().keep("p1", "claude-fable-5-1");
    const saved = localStorage.getItem("octo-superseded-models")!;
    expect(JSON.parse(saved).state).toEqual({ kept: { p1: ["claude-fable-5-1"] } });
    // A fresh launch: memory is empty, storage holds the earlier choice.
    useSupersededModelStore.setState({ kept: {} });
    localStorage.setItem("octo-superseded-models", saved);
    await useSupersededModelStore.persist.rehydrate();
    expect(useSupersededModelStore.getState().isKept("p1", "claude-fable-5-1")).toBe(true);
  });
});
