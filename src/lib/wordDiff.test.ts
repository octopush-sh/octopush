import { describe, it, expect } from "vitest";
import { wordDiff } from "./wordDiff";

describe("wordDiff", () => {
  it("marks only the changed word", () => {
    const { old: o, new: n } = wordDiff(`return "Hi " + name`, "return `Hello, ${name}`");
    expect(o.filter(s => s.kind === "del").map(s => s.text).join("")).toContain('"Hi " +');
    expect(n.filter(s => s.kind === "add").map(s => s.text).join("")).toContain("`Hello,");
    expect(o.filter(s => s.kind === "equal").map(s => s.text).join("")).toContain("return ");
  });
  it("identical lines are all equal", () => {
    const { old: o, new: n } = wordDiff("const x = 1", "const x = 1");
    expect(o.every(s => s.kind === "equal")).toBe(true);
    expect(n.every(s => s.kind === "equal")).toBe(true);
  });
  it("pure insertion", () => {
    const { old: o, new: n } = wordDiff("a c", "a b c");
    expect(o.some(s => s.kind === "del")).toBe(false);
    expect(n.some(s => s.kind === "add" && s.text.includes("b"))).toBe(true);
  });
  it("falls back to whole-line on huge token counts", () => {
    const big = Array.from({ length: 500 }, (_, i) => `t${i}`).join(" ");
    const { old: o } = wordDiff(big, big + " x");
    expect(o).toEqual([{ kind: "equal", text: big }]);
  });
  it("round-trips: concatenated segments reconstruct original text", () => {
    const oldText = `return "Hi " + name`;
    const newText = "return `Hello, ${name}`";
    const { old: o, new: n } = wordDiff(oldText, newText);
    expect(o.map((s) => s.text).join("")).toBe(oldText);
    expect(n.map((s) => s.text).join("")).toBe(newText);
  });
});
