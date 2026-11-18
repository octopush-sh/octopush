import { describe, it, expect, beforeEach } from "vitest";
import { useReviewSource } from "./reviewSourceStore";

const c = { base: "main", mergeBase: "abc1234", commits: 2, diff: "diff --git a/x b/x\n" };

beforeEach(() => useReviewSource.setState({ committedByWs: {}, pickByWs: {} }));

describe("reviewSourceStore", () => {
  it("keeps the same object when a poll brings an equal answer", () => {
    useReviewSource.getState().setCommitted("ws", c);
    const first = useReviewSource.getState().committedByWs;
    useReviewSource.getState().setCommitted("ws", { ...c });
    expect(useReviewSource.getState().committedByWs).toBe(first);
    useReviewSource.getState().setCommitted("ws", { ...c, commits: 3 });
    expect(useReviewSource.getState().committedByWs.ws?.commits).toBe(3);
  });
  it("stores a pick per workspace", () => {
    useReviewSource.getState().pick("a", "committed");
    expect(useReviewSource.getState().pickByWs).toEqual({ a: "committed" });
  });
});
