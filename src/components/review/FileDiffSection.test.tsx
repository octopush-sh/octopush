import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { FileDiffSection, pathTail } from "./FileDiffSection";
import { parseFullDiff, type DiffFile } from "../../lib/diffParser";

const { readFileChecked } = vi.hoisted(() => ({ readFileChecked: vi.fn() }));
vi.mock("../../lib/ipc", () => ({ ipc: { readFileChecked } }));

const file: DiffFile = {
  filePath: "src/a.ts", changeType: "modified", fileHeader: "",
  hunks: [{ header: "@@ -1,1 +1,1 @@", lines: ["@@ -1,1 +1,1 @@","-a","+b"], rawText: "x", additions: 1, deletions: 1,
    rows: [{ kind: "del", text: "a", oldLine: 1, newLine: null }, { kind: "add", text: "b", oldLine: null, newLine: 1 }] }],
};

describe("FileDiffSection", () => {
  beforeEach(() => { readFileChecked.mockReset(); });
  it("shows the file header with type + path", () => {
    const { getByText } = render(<FileDiffSection file={file} focusedHunk={-1} viewed={false} collapsed={false}
      onAccept={()=>{}} onReject={()=>{}} onWhy={()=>{}} onToggleViewed={()=>{}} onToggleCollapsed={()=>{}} />);
    expect(getByText("MODIFIED")).toBeTruthy();
    expect(getByText("src/a.ts")).toBeTruthy();
  });
  it("sets MODIFIED in mute, like the hunk count — status is never brass (#398)", () => {
    const { getByText } = render(<FileDiffSection file={file} focusedHunk={-1} viewed={false} collapsed={false}
      onAccept={()=>{}} onReject={()=>{}} onWhy={()=>{}} onToggleViewed={()=>{}} onToggleCollapsed={()=>{}} />);
    expect(getByText("MODIFIED")).toHaveClass("font-mono", "text-octo-mute");
    expect(getByText("MODIFIED")).not.toHaveClass("text-octo-brass");
  });
  it("middle-truncates a long path with the file name pinned and the full path in its title", () => {
    const long = { ...file, filePath: "src-tauri/src/very/deep/module/sync.rs" };
    const { container, getByTitle } = render(<FileDiffSection file={long} focusedHunk={-1} viewed={false} collapsed={false}
      onAccept={()=>{}} onReject={()=>{}} onWhy={()=>{}} onToggleViewed={()=>{}} onToggleCollapsed={()=>{}} />);
    expect(getByTitle(long.filePath)).toHaveTextContent(long.filePath);
    expect(container.querySelector(".octo-midtrunc-tail")?.textContent).toContain("/sync.rs");
  });
  it("renders a short path as one nowrap line, not a bare string in the flex row", () => {
    const { getByText } = render(<FileDiffSection file={{ ...file, filePath: "src-tauri/a.rs" }} focusedHunk={-1} viewed={false} collapsed={false}
      onAccept={()=>{}} onReject={()=>{}} onWhy={()=>{}} onToggleViewed={()=>{}} onToggleCollapsed={()=>{}} />);
    expect(getByText("src-tauri/a.rs")).toHaveClass("octo-midtrunc-whole");
  });
  it("keeps the meta whole: hunk count is a demotion rung, mark viewed never wraps", () => {
    const { getByText, container } = render(<FileDiffSection file={file} focusedHunk={-1} viewed={false} collapsed={false}
      onAccept={()=>{}} onReject={()=>{}} onWhy={()=>{}} onToggleViewed={()=>{}} onToggleCollapsed={()=>{}} />);
    expect(container.querySelector(".octo-filehead")).toBeTruthy();
    expect(getByText("1 hunk")).toHaveClass("octo-demote", "octo-demote-hunks");
    expect(getByText("mark viewed")).toHaveClass("flex-none", "whitespace-nowrap");
  });
  it("pins at least the file name and its slash", () => {
    expect(pathTail("a/b.rs")).toBe(12);
    expect(pathTail("src/components/a-really-long-component-name.tsx")).toBe(33);
  });
  it("collapses content when collapsed", () => {
    const { container } = render(<FileDiffSection file={file} focusedHunk={-1} viewed collapsed
      onAccept={()=>{}} onReject={()=>{}} onWhy={()=>{}} onToggleViewed={()=>{}} onToggleCollapsed={()=>{}} />);
    // grid-rows 0fr collapse: the content wrapper has grid-template-rows 0fr — assert the collapse container exists with the collapsed style
    expect(container.querySelector('[data-collapsed="true"]')).toBeTruthy();
  });
  it("reads the file on disk so a hunk inside a Javadoc is coloured as comment", async () => {
    const java = ["class A {", "  /**", "   * Adds.", "   * @param x the x", "   */", "  int add(int x) { return x; }", "}", ""].join("\n");
    readFileChecked.mockResolvedValue({ kind: "text", content: java, size: java.length, mtime: 0 });
    const [jf] = parseFullDiff([
      "diff --git a/A.java b/A.java", "--- a/A.java", "+++ b/A.java",
      "@@ -4,2 +4,2 @@", "-   * @param x an x", "+   * @param x the x", "    */", "",
    ].join("\n"));
    const { container } = render(<FileDiffSection file={jf} workspacePath="/w" focusedHunk={-1} viewed={false} collapsed={false}
      onAccept={()=>{}} onReject={()=>{}} onWhy={()=>{}} onToggleViewed={()=>{}} onToggleCollapsed={()=>{}} />);
    expect(readFileChecked).toHaveBeenCalledWith("/w/A.java", expect.any(Number));
    await waitFor(() => {
      const rows = container.querySelectorAll('[data-diff-row]');
      for (const row of Array.from(rows).slice(0, 2)) {
        expect(row.querySelector(".tok-cmt")?.textContent).toContain("@param");
      }
    });
  });

  const javaDisk = ["class A {", "  /**", "   * Adds.", "   * @param x the x", "   */", "  int add(int x) { return x; }", "}", ""].join("\n");
  const javaFile = () => parseFullDiff([
    "diff --git a/A.java b/A.java", "--- a/A.java", "+++ b/A.java",
    "@@ -4,2 +4,2 @@", "-   * @param x an x", "+   * @param x the x", "    */", "",
  ].join("\n"))[0];
  const renderJava = (jf: DiffFile, opts: { workspacePath?: string; collapsed?: boolean } = { workspacePath: "/w" }) =>
    render(<FileDiffSection file={jf} workspacePath={opts.workspacePath} focusedHunk={-1} viewed={false} collapsed={opts.collapsed ?? false}
      onAccept={()=>{}} onReject={()=>{}} onWhy={()=>{}} onToggleViewed={()=>{}} onToggleCollapsed={()=>{}} />);
  const rowTexts = (c: HTMLElement) => Array.from(c.querySelectorAll("[data-diff-row] code")).map((n) => n.textContent);
  // Whole-file tokens: both changed rows sit inside the Javadoc. The hunk's
  // own context has no `/**`, so its fallback tokens are not comments.
  const javadocRows = (c: HTMLElement) =>
    Array.from(c.querySelectorAll("[data-diff-row]")).slice(0, 2)
      .every((r) => r.querySelector(".tok-cmt")?.textContent?.includes("@param") ?? false);
  const exactRows = ["   * @param x an x", "   * @param x the x", "   */"];

  it("falls back to hunk context when the read rejects, rows intact", async () => {
    readFileChecked.mockRejectedValue(new Error("gone"));
    const { container } = renderJava(javaFile());
    await act(async () => { await Promise.resolve(); });
    expect(readFileChecked).toHaveBeenCalledTimes(1);
    expect(rowTexts(container)).toEqual(exactRows);
    expect(javadocRows(container)).toBe(false);
  });
  it.each([
    [{ kind: "tooLarge", size: 2_000_000 }],
    [{ kind: "binary", size: 10, mtime: 0 }],
  ])("falls back to hunk context when the read resolves %o", async (result) => {
    readFileChecked.mockResolvedValue(result);
    const { container } = renderJava(javaFile());
    await act(async () => { await Promise.resolve(); });
    expect(readFileChecked).toHaveBeenCalledTimes(1);
    expect(rowTexts(container)).toEqual(exactRows);
    expect(javadocRows(container)).toBe(false);
  });
  it("shows hunk-context tokens while the read is pending, then whole-file tokens", async () => {
    let resolve!: (v: unknown) => void;
    readFileChecked.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { container } = renderJava(javaFile());
    expect(rowTexts(container)).toEqual(exactRows);
    expect(javadocRows(container)).toBe(false);
    await act(async () => { resolve({ kind: "text", content: javaDisk, size: javaDisk.length, mtime: 0 }); });
    await waitFor(() => expect(javadocRows(container)).toBe(true));
    expect(rowTexts(container)).toEqual(exactRows);
  });
  it("does not read the file while collapsed", () => {
    renderJava(javaFile(), { workspacePath: "/w", collapsed: true });
    expect(readFileChecked).not.toHaveBeenCalled();
  });
  it("does not read the file without a workspace path", () => {
    const { container } = renderJava(javaFile(), {});
    expect(readFileChecked).not.toHaveBeenCalled();
    expect(rowTexts(container)).toEqual(exactRows);
  });
  it("colours rows once a cold grammar lands, and on the first render once warm", async () => {
    // Go appears nowhere else in this file, so its grammar starts cold.
    const [gf] = parseFullDiff([
      "diff --git a/main.go b/main.go", "new file mode 100644", "--- /dev/null", "+++ b/main.go",
      "@@ -0,0 +1,1 @@", "+func main() {}", "",
    ].join("\n"));
    const goRender = () => render(<FileDiffSection file={gf} focusedHunk={-1} viewed={false} collapsed={false}
      onAccept={()=>{}} onReject={()=>{}} onWhy={()=>{}} onToggleViewed={()=>{}} onToggleCollapsed={()=>{}} />);
    const keyword = (c: HTMLElement) => c.querySelector("[data-diff-row] .tok-kw")?.textContent;

    const cold = goRender();
    expect(keyword(cold.container)).toBeUndefined();
    await waitFor(() => expect(keyword(cold.container)).toBe("func"));
    cold.unmount();

    const warm = goRender();
    expect(keyword(warm.container)).toBe("func");
  });
  it.each(["new", "deleted"] as const)("does not read the file for a %s file", (changeType) => {
    renderJava({ ...javaFile(), changeType });
    expect(readFileChecked).not.toHaveBeenCalled();
  });
});
