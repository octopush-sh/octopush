import { describe, it, expect } from "vitest";
import { highlightLine } from "./diffHighlight";

describe("highlightLine", () => {
  it("classes a JS keyword as tok-kw", () => {
    const toks = highlightLine("const x = 1", "src/a.ts");
    const kw = toks.find(t => t.text === "const");
    expect(kw?.cls).toBe("tok-kw");
  });
  it("classes a number as tok-num", () => {
    const toks = highlightLine("const x = 42", "src/a.ts");
    expect(toks.find(t => t.text === "42")?.cls).toBe("tok-num");
  });
  it("plaintext returns one unclassed token", () => {
    const toks = highlightLine("just words here", "notes.txt");
    expect(toks).toEqual([{ text: "just words here", cls: "" }]);
  });
  it("reconstructs the original line exactly", () => {
    const line = "function f(a) { return a + 1 }";
    expect(highlightLine(line, "a.ts").map(t => t.text).join("")).toBe(line);
  });
});
