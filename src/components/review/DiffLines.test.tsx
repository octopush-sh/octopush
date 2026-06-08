import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { DiffLines } from "./DiffLines";
import type { DiffRow } from "../../lib/diffParser";

const rows: DiffRow[] = [
  { kind: "context", text: "function greet() {", oldLine: 1, newLine: 1 },
  { kind: "del", text: '  return "Hi"', oldLine: 2, newLine: null, segments: [{ kind: "equal", text: '  return ' }, { kind: "del", text: '"Hi"' }] },
  { kind: "add", text: "  return `Hello`", oldLine: null, newLine: 2, segments: [{ kind: "equal", text: "  return " }, { kind: "add", text: "`Hello`" }] },
];

describe("DiffLines inline", () => {
  it("renders a row per diff line with line numbers", () => {
    const { container } = render(<DiffLines rows={rows} filePath="src/a.ts" mode="inline" />);
    expect(container.querySelectorAll("[data-diff-row]").length).toBe(3);
    expect(container.textContent).toContain("function greet()");
  });
  it("applies add/del backgrounds", () => {
    const { container } = render(<DiffLines rows={rows} filePath="src/a.ts" mode="inline" />);
    expect(container.querySelector('[data-kind="add"]')).toBeTruthy();
    expect(container.querySelector('[data-kind="del"]')).toBeTruthy();
  });
  it("renders word-diff segments with wd-add/wd-del classes", () => {
    const { container } = render(<DiffLines rows={rows} filePath="src/a.ts" mode="inline" />);
    expect(container.querySelector(".wd-del")).toBeTruthy();
    expect(container.querySelector(".wd-add")).toBeTruthy();
  });
});

describe("DiffLines side-by-side", () => {
  it("side-by-side renders two columns", () => {
    const { container } = render(<DiffLines rows={rows} filePath="src/a.ts" mode="sbs" />);
    expect(container.querySelectorAll("[data-sbs-col]").length).toBe(2);
  });
  it("side-by-side pads unbalanced replace blocks", () => {
    const unbal: DiffRow[] = [
      { kind: "del", text: "x", oldLine: 1, newLine: null },
      { kind: "add", text: "y", oldLine: null, newLine: 1 },
      { kind: "add", text: "z", oldLine: null, newLine: 2 },
    ];
    const { container } = render(<DiffLines rows={unbal} filePath="a.ts" mode="sbs" />);
    const cols = container.querySelectorAll("[data-sbs-col]");
    expect(cols[0].querySelectorAll("[data-diff-row]").length).toBe(cols[1].querySelectorAll("[data-diff-row]").length);
  });
});
