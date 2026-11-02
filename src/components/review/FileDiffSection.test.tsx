import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
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
});
