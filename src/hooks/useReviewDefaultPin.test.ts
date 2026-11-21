import { beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useReviewDefaultPin, type ReviewAnswers } from "./useReviewDefaultPin";
import { useReviewSource } from "../stores/reviewSourceStore";

const committed = { base: "main", mergeBase: "abc1234", head: "def5678", commits: 2, diff: "diff --git a/x b/x\n" };
const fresh = (workspaceId: string, dirty: boolean, commitsAhead = 2): ReviewAnswers => ({
  workspaceId,
  dirty,
  commitsAhead,
});

interface Props {
  mode: string;
  ws: string | null;
  answers: ReviewAnswers | null;
}

function setup(initial: Props) {
  return renderHook(({ mode, ws, answers }: Props) => useReviewDefaultPin(mode, ws, answers), {
    initialProps: initial,
  });
}

const pins = () => useReviewSource.getState().pinnedByWs;

beforeEach(() => useReviewSource.setState({ committedByWs: {}, pickByWs: {}, pinnedByWs: {} }));

describe("useReviewDefaultPin (#903)", () => {
  it("pins the default from a fresh answer for the workspace on screen", () => {
    setup({ mode: "review", ws: "a", answers: fresh("a", false) });
    expect(pins()).toEqual({ a: "committed" });
  });

  it("A dirty to B clean: the render that still holds A's status pins nothing for B", () => {
    // B's committed answer is cached from an earlier visit.
    useReviewSource.getState().setCommitted("b", committed);
    const h = setup({ mode: "review", ws: "a", answers: fresh("a", true) });
    expect(pins()).toEqual({ a: "working" });
    // The switch render: A's answers are still in state for a render.
    h.rerender({ mode: "review", ws: "b", answers: fresh("a", true) });
    expect(pins().b).toBeUndefined();
    // App drops them, then B's own refresh lands.
    h.rerender({ mode: "review", ws: "b", answers: null });
    expect(pins().b).toBeUndefined();
    h.rerender({ mode: "review", ws: "b", answers: fresh("b", false) });
    expect(pins().b).toBe("committed");
  });

  it("A clean to B dirty: B pins the working tree, not A's committed default", () => {
    useReviewSource.getState().setCommitted("b", committed);
    const h = setup({ mode: "review", ws: "a", answers: fresh("a", false) });
    expect(pins()).toEqual({ a: "committed" });
    h.rerender({ mode: "review", ws: "b", answers: fresh("a", false) });
    expect(pins().b).toBeUndefined();
    h.rerender({ mode: "review", ws: "b", answers: fresh("b", true) });
    expect(pins().b).toBe("working");
  });

  it("entry from Talk with a cached committed answer waits for this visit's refresh", () => {
    useReviewSource.getState().setCommitted("a", committed);
    const h = setup({ mode: "talk", ws: "a", answers: null });
    // Entering Review: Talk's status is on screen and the committed answer is
    // cached, but nothing was fetched during this visit yet.
    h.rerender({ mode: "review", ws: "a", answers: null });
    expect(pins()).toEqual({});
    h.rerender({ mode: "review", ws: "a", answers: fresh("a", true) });
    expect(pins()).toEqual({ a: "working" });
  });

  it("keeps the pin when the tree changes later in the visit", () => {
    const h = setup({ mode: "review", ws: "a", answers: fresh("a", false) });
    h.rerender({ mode: "review", ws: "a", answers: fresh("a", true) });
    expect(pins()).toEqual({ a: "committed" });
  });

  it("an explicit pick wins, no commits means no pin, and leaving Review drops the pins", () => {
    useReviewSource.getState().pick("a", "working");
    const h = setup({ mode: "review", ws: "a", answers: fresh("a", false) });
    expect(pins()).toEqual({});
    h.rerender({ mode: "review", ws: "b", answers: fresh("b", false, 0) });
    expect(pins()).toEqual({});
    h.rerender({ mode: "review", ws: "c", answers: fresh("c", false) });
    expect(pins()).toEqual({ c: "committed" });
    h.rerender({ mode: "talk", ws: "c", answers: null });
    expect(pins()).toEqual({});
  });
});
