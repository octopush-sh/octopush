import { describe, it, expect, beforeEach } from "vitest";
import { useReviewComments } from "./reviewCommentsStore";

const note = { filePath: "a.ts", fingerprint: "f1", startLine: 2, endLine: 2, quote: ["+x"], note: "Rename x." };

describe("reviewCommentsStore", () => {
  beforeEach(() => useReviewComments.setState({ byWs: {}, liveByWs: {} }));

  it("adds, removes and takes comments per workspace", () => {
    const s = useReviewComments.getState();
    s.add("w1", note);
    s.add("w1", { ...note, note: "Second." });
    s.add("w2", note);
    const [first] = useReviewComments.getState().byWs.w1;
    useReviewComments.getState().remove("w1", first.id);
    expect(useReviewComments.getState().take("w1").map((c) => c.note)).toEqual(["Second."]);
    expect(useReviewComments.getState().byWs.w1).toEqual([]);
    expect(useReviewComments.getState().byWs.w2).toHaveLength(1);
  });

  it("keeps the live hunk set when a refetch brings the same hunks", () => {
    const s = useReviewComments.getState();
    s.setLive("w1", new Set(["a.ts\nf1"]));
    const first = useReviewComments.getState().liveByWs.w1;
    s.setLive("w1", new Set(["a.ts\nf1"]));
    expect(useReviewComments.getState().liveByWs.w1).toBe(first);
  });
});
