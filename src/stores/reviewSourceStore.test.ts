import { describe, it, expect, beforeEach } from "vitest";
import { useReviewSource } from "./reviewSourceStore";

const c = { base: "main", mergeBase: "abc1234", commits: 2, diff: "diff --git a/x b/x\n" };

beforeEach(() => useReviewSource.setState({ committedByWs: {}, pickByWs: {}, pinnedByWs: {} }));

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
  it("pins the first default shown and keeps it (#903)", () => {
    const st = useReviewSource.getState();
    st.pinDefault("a", "committed");
    st.pinDefault("a", "working");
    expect(useReviewSource.getState().pinnedByWs).toEqual({ a: "committed" });
  });
  it("drops every pin when Review leaves the screen, keeping picks", () => {
    const st = useReviewSource.getState();
    st.pick("a", "working");
    st.pinDefault("b", "committed");
    const before = useReviewSource.getState();
    useReviewSource.getState().clearPins();
    expect(useReviewSource.getState().pinnedByWs).toEqual({});
    expect(useReviewSource.getState().pickByWs).toEqual({ a: "working" });
    // Nothing to clear: no new state, no re-render.
    const cleared = useReviewSource.getState();
    useReviewSource.getState().clearPins();
    expect(useReviewSource.getState()).toBe(cleared);
    expect(before).not.toBe(cleared);
  });
});
